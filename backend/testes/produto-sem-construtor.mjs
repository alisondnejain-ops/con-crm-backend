/* A CONSTRUTORA/CONSTRUTOR NÃO SAI PARA O CLIENTE. (21/09/2026, pedido do
   Ali: "não envie automaticamente a construtora ou o construtor que foi
   cadastrado, que seja apenas uma informação interna da imobiliária, pra
   que o lead ou cliente não tenha acesso a essa informação e fale
   diretamente com o construtor".)

   `produtos.construtor` sempre foi dado de CAPTAÇÃO — quem a imobiliária
   negociou o empreendimento — útil para o corretor e o gestor
   identificarem o imóvel internamente. `textoDoProduto` (messages.routes.js)
   incluía o nome no texto que vai pro WhatsApp do cliente, do mesmo jeito
   que mostrava metragem ou bairro — dando ao lead um caminho para pular a
   imobiliária e negociar direto com a construtora.

   `textoDoProduto` é a ÚNICA função que monta esse texto, para todo envio
   de produto de toda imobiliária (não há cópia por conta nem
   configuração por org) — corrigir aqui vale para TODA conta existente e
   futura, sem tocar em nenhum lead, mensagem ou produto já cadastrado.

   O que este teste prova:
   1. O texto que sai pro cliente NÃO tem o nome da construtora, mesmo o
      produto tendo o campo preenchido.
   2. O resto da apresentação (título, local, cômodos, metragem, valor)
      continua saindo normalmente — a trava é só do campo, não do envio.
   3. O campo continua existindo no banco e voltando pela API (é
      informação interna, não foi apagado — só parou de sair pro cliente).

   Rodar:  npm run teste:produto-sem-construtor
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-produto-sem-construtor.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

/* A Uazapi vira um espião: guarda o texto que teria saído para o cliente. */
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
  .run(org, "Conecta", "PC-1", Date.now(), "https://uazapi.exemplo", "tok-123");
const corretor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`).run(corretor, org, "Marina", "marina@pc1.com", Date.now());
const leadId = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(leadId, org, "Joana", "5587900002222", "Atendimento", corretor, Date.now());

const prod = "p_" + randomUUID();
db.prepare(`INSERT INTO produtos (id,org_id,titulo,tipo,status,construtor,bairro,cidade,quartos,banheiros,metragem,valor,created_by,created_at)
  VALUES (?,?,?,'casa','ativo',?,?,?,?,?,?,?,?,?)`)
  .run(prod, org, "Residencial Orla", "Construtora Horizonte Ltda", "Orla", "Petrolina", 3, 2, 120, 350000, corretor, Date.now());

const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: msgRoutes } = await import("../src/routes/messages.routes.js");
const { default: produtosRoutes } = await import("../src/routes/produtos.routes.js");
const token = jwt.sign({ id: corretor, role: "corretor", org_id: org, name: "Marina" }, "teste", { expiresIn: "1h" });
const app = express(); app.use(express.json());
app.use("/leads", msgRoutes);
app.use("/produtos", produtosRoutes);
const srv = app.listen(0); const porta = srv.address().port;

const textoEnviado = () => (enviadas.find(e => e.corpo.text)?.corpo.text) || "";

console.log("1. Enviando o produto para o lead...");
enviadas.length = 0;
const r = await fetch(`http://127.0.0.1:${porta}/leads/${leadId}/produto`, { method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ produto_id: prod, fotos: false }) }).then(async x => ({ status: x.status, corpo: await x.json() }));
assert.equal(r.status, 200);
const texto = textoEnviado();
console.log("   texto enviado:\n   " + texto.split("\n").join("\n   "));

console.log("2. A construtora NÃO aparece no texto que o cliente recebe");
assert.ok(!texto.includes("Horizonte"), "o nome da construtora vazou para o cliente");
assert.ok(!/construtor/i.test(texto), "nem a palavra 'construtor(a)' deveria aparecer");

console.log("3. O resto da apresentação continua saindo normalmente");
assert.ok(texto.includes("Residencial Orla"), "título");
assert.ok(texto.includes("Orla"), "bairro");
assert.ok(texto.includes("Petrolina"), "cidade");
assert.ok(texto.includes("3 quarto"), "quartos");
assert.ok(texto.includes("120"), "metragem");
assert.ok(/350\.000|350000/.test(texto.replace(/\D/g, "").includes("350000") ? "350000" : texto), "valor");

console.log("4. O campo continua existindo — é interno, não foi apagado");
const rProd = await fetch(`http://127.0.0.1:${porta}/produtos/${prod}`, { headers: { authorization: "Bearer " + token } })
  .then(async x => ({ status: x.status, corpo: await x.json() }));
assert.equal(rProd.status, 200);
assert.equal(rProd.corpo.construtor, "Construtora Horizonte Ltda", "a tela interna de captação continua mostrando o campo");

srv.close();
console.log("\nTudo certo ✅");
