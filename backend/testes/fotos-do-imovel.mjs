/* Enviar só algumas fotos do anúncio.

   O captador sobe dez fotos do empreendimento; o corretor quer mandar as três
   do apartamento que interessa àquele cliente. Mandar as dez é o jeito rápido
   de o cliente parar de olhar.

   O que este teste protege: sem a lista, continua indo o anúncio inteiro (o
   comportamento de sempre não pode mudar por causa de um recurso novo), e com
   a lista vão exatamente as escolhidas, na ORDEM DO ANÚNCIO — porque a
   primeira foto é a capa que o captador definiu e é ela que leva a legenda no
   WhatsApp.

   O envio para a Uazapi é trocado por um espião, então roda offline.

   Rodar:  npm run teste:fotos
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-fotos.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

/* A Uazapi vira um espião: guarda o que teria saído. */
const enviadas = [];
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("uazapi") || u.includes("/send/")) {
    let corpo = {};
    try { corpo = JSON.parse(opts?.body || "{}"); } catch {}
    enviadas.push({ url: u, corpo });
    return { ok: true, status: 200, json: async () => ({ messageid: "wa_" + enviadas.length }), text: async () => "{}" };
  }
  return real(url, opts);
};

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)")
  .run(org, "Conecta", "A-1", Date.now(), "https://uazapi.exemplo", "tok-123");
const corretor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`).run(corretor, org, "Marina", "marina@x.com", Date.now());
const leadId = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(leadId, org, "Joana", "5587900001111", "Atendimento", corretor, Date.now());

const prod = "p_" + randomUUID();
db.prepare(`INSERT INTO produtos (id,org_id,titulo,tipo,status,created_by,created_at)
  VALUES (?,?,?,'casa','ativo',?,?)`).run(prod, org, "Residencial Orla, 2 quartos", corretor, Date.now());
const fotoIds = [];
for (let i = 0; i < 5; i++) {
  const id = "pm_" + randomUUID(); fotoIds.push(id);
  db.prepare(`INSERT INTO produto_midias (id,produto_id,tipo,url,chave,ordem,created_at)
    VALUES (?,?,'foto',?,?,?,?)`).run(id, prod, `https://x/f${i}.jpg`, `k${i}`, i, Date.now());
}

const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: msgRoutes } = await import("../src/routes/messages.routes.js");
const token = jwt.sign({ id: corretor, role: "corretor", org_id: org, name: "Marina" }, "teste", { expiresIn: "1h" });
const app = express(); app.use(express.json()); app.use("/leads", msgRoutes);
const srv = app.listen(0); const porta = srv.address().port;
const enviar = (body) => { enviadas.length = 0;
  return fetch(`http://127.0.0.1:${porta}/leads/${leadId}/produto`, { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ produto_id: prod, ...body }) }).then(async x => ({ status: x.status, corpo: await x.json() })); };
const imagens = () => enviadas.filter(e => JSON.stringify(e.corpo).includes("f") && /f\d\.jpg/.test(JSON.stringify(e.corpo)))
  .map(e => (JSON.stringify(e.corpo).match(/f(\d)\.jpg/) || [])[1]);
const ultimoRegistro = () => db.prepare(
  "SELECT body FROM messages WHERE lead_id=? ORDER BY created_at DESC LIMIT 1").get(leadId).body;

console.log("1. Sem lista, vai o anúncio inteiro — o comportamento de sempre");
let r = await enviar({ fotos: true });
console.log("   fotos enviadas:", imagens().join(", "), "| resposta:", r.corpo.enviadas);
assert.equal(r.status, 200);
assert.equal(r.corpo.enviadas, 5);
assert.deepEqual(imagens(), ["0", "1", "2", "3", "4"]);
assert.ok(!/de 5 fotos/.test(ultimoRegistro()), "envio inteiro não precisa dizer a conta");

console.log("2. Com lista, vão só as escolhidas");
r = await enviar({ fotos: true, fotos_ids: [fotoIds[3], fotoIds[1]] });
console.log("   fotos enviadas:", imagens().join(", "), "| resposta:", r.corpo.enviadas);
assert.equal(r.corpo.enviadas, 2);

console.log("3. E na ORDEM DO ANÚNCIO, não na ordem em que foram clicadas");
assert.deepEqual(imagens(), ["1", "3"], "a capa e a sequência do captador mandam");

console.log("4. A conversa registra que não foram todas");
console.log("   ", ultimoRegistro());
assert.ok(/2 de 5 fotos/.test(ultimoRegistro()),
  "quem lê o histórico depois precisa saber se o cliente viu o anúncio inteiro");

console.log("5. Lista vazia manda só o texto, sem foto nenhuma");
r = await enviar({ fotos: true, fotos_ids: [] });
assert.equal(r.corpo.enviadas, 0);
assert.equal(imagens().length, 0);

console.log("6. Foto de OUTRO anúncio na lista é ignorada");
r = await enviar({ fotos: true, fotos_ids: [fotoIds[0], "pm_de_outro_imovel"] });
console.log("   fotos enviadas:", imagens().join(", "));
assert.equal(r.corpo.enviadas, 1, "só a que é deste produto");

console.log("7. Desmarcar as fotos continua funcionando");
r = await enviar({ fotos: false });
assert.equal(r.corpo.enviadas, 0);

srv.close();
console.log("\nTudo certo ✅");
