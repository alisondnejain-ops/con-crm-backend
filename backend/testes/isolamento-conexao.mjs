/* O WHATSAPP DE UMA IMOBILIÁRIA NÃO APARECE PARA OUTRA (29/09/2026).

   Relato do Ali no onboarding de Maragogi: "informações da Conecta apareciam
   como exemplo na conexão". O selo "WhatsApp conectado" de toda conta lia o
   `/integracoes` — público, e com o WhatsApp da imobiliária mais antiga (a
   Conecta): número, nome do perfil e, desconectado, o QR CODE, que qualquer
   pessoa podia ler e parear no próprio celular.

   1. sem login, o /integracoes não diz número, nome, QR nem código de pareamento;
   2. o log público de webhooks não traz o nome do lead;
   3. a conta nova lê a PRÓPRIA conexão (nenhuma), não a da mais antiga;
   4. a conta mais antiga lê a dela, com número mascarado e sem QR;
   5. o corretor também lê o selo, e não recebe QR nem endereço.

   Rodar:  npm run teste:isolamento-conexao
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const PORTA = 4741, PORTA_UAZAPI = 4744;
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-isolamento-conexao.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = String(PORTA);
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// A instância da mais antiga: desconectada, com QR e código de pareamento na resposta.
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ instance: { status: "connecting", owner: "5587999886848", profileName: "Conecta Imóveis",
    qrcode: "data:image/png;base64,QRSECRETO", paircode: "ABCD-1234" }, status: { connected: false, loggedIn: false } }));
}).listen(PORTA_UAZAPI);
const HOST = `http://127.0.0.1:${PORTA_UAZAPI}`;

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
await new Promise(r => setTimeout(r, 700));
const BASE = `http://127.0.0.1:${PORTA}`;
const { garantirCasa } = await import("../src/services/canais.js");
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

// A mais antiga (a do bootstrap) ganha o WhatsApp; a nova é criada depois, sem nada.
const antiga = db.prepare("SELECT id FROM orgs ORDER BY created_at, name LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token='tok-antiga' WHERE id=?").run(HOST, antiga);
garantirCasa(antiga);
const nova = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(nova, "Imobiliária Nova", "NOVA-1", Date.now() + 1000);
garantirCasa(nova);
const user = (org, email, role) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run("u_" + randomUUID(), org, email, email, senha, role, Date.now());
user(antiga, "gestor@antiga.com", "adm"); user(nova, "gestor@nova.com", "adm"); user(nova, "corretor@nova.com", "corretor");
const entrar = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const get = async (tk, caminho) => { const r = await fetch(BASE + caminho, { headers: tk ? { authorization: "Bearer " + tk } : {} });
  return { status: r.status, d: await r.json(), txt: "" }; };
const semVazar = (obj, onde) => {
  const t = JSON.stringify(obj);
  for (const proibido of ["QRSECRETO", "ABCD-1234", "Conecta Imóveis", "6848", "tok-antiga", "127.0.0.1:" + PORTA_UAZAPI])
    assert.ok(!t.includes(proibido), `${onde} vazou "${proibido}": ${t}`);
};

console.log("1. Sem login, o /integracoes não conta nada da conexão de ninguém");
let r = await get(null, "/integracoes");
assert.equal(r.status, 200);
semVazar(r.d.whatsapp, "/integracoes");
assert.equal(r.d.whatsapp.configurado, true, "o diagnóstico continua dizendo que existe conexão");

console.log("2. O log público de webhooks não traz o nome do lead");
await fetch(BASE + "/webhooks/uazapi", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ EventType: "messages", token: "tok-antiga", message: { chatid: "5587911112222@s.whatsapp.net",
    sender: "5587911112222@s.whatsapp.net", fromMe: false, text: "oi", messageid: "wa_iso_1", senderName: "Maria Cliente Sigilosa" } }) });
await new Promise(x => setTimeout(x, 300));
r = await get(null, "/integracoes/webhooks");
assert.ok(r.d.eventos.length > 0, "o evento chegou");
assert.ok(!JSON.stringify(r.d).includes("Maria Cliente Sigilosa"), "nome do cliente fora do log público");

console.log("3. A conta nova lê a PRÓPRIA conexão");
const tNova = await entrar("gestor@nova.com");
r = await get(tNova, "/config/conexao/estado");
assert.equal(r.status, 200);
assert.equal(r.d.whatsapp.configurado, false, "conta sem WhatsApp não herda o da mais antiga");
semVazar(r.d, "estado da conta nova");

console.log("4. A mais antiga lê a dela, mascarada e sem QR");
r = await get(await entrar("gestor@antiga.com"), "/config/conexao/estado");
assert.deepEqual([r.d.whatsapp.configurado, r.d.whatsapp.conectado], [true, false]);
assert.match(r.d.whatsapp.numero, /^5587\*+6848$/);
assert.ok(!("qrcode" in r.d.whatsapp) && !("paircode" in r.d.whatsapp));

console.log("5. O corretor também lê o selo, sem QR nem endereço");
r = await get(await entrar("corretor@nova.com"), "/config/conexao/estado");
assert.equal(r.status, 200);
for (const k of Object.keys(r.d.whatsapp))
  assert.ok(["conectado", "configurado", "numero", "ok"].includes(k), `campo a mais no selo: ${k}`);

console.log("\nTudo certo ✅");
process.exit(0);
