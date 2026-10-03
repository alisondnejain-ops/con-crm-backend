/* O CRM LIGA O RECEBIMENTO SOZINHO (29/09/2026).

   Relato do Ali depois do onboarding de uma imobiliária de Maragogi: nenhum
   número — nem o da casa, nem os dos corretores — recebia as mensagens no CRM.
   O webhook da instância na Uazapi era um passo manual, e na linha do corretor
   nem era pedido. Agora o servidor confere e configura (services/webhook-uazapi.js).

   Uma Uazapi de mentira, com uma lista de webhooks por token:
   1. conectar o número da casa liga o recebimento;
   2. o número do corretor também;
   3. webhook que já aponta para o CRM não é tocado (as contas que funcionam hoje);
   4. webhook de OUTRO sistema do cliente não é apagado — o do CRM entra ao lado;
   5. webhook do CRM desligado é religado, sem criar um segundo;
   6. a conferência geral conserta a linha que já existia sem webhook;
   7. Uazapi sem a rota de webhook: a conexão continua, com o aviso escrito;
   8. sem endereço público (ou localhost), nada é configurado;
   9. o botão "Conferir recebimento" é da supervisão, não do corretor;
   10. a mensagem que chega pela linha do corretor aparece para o gestor.

   Rodar:  npm run teste:webhook-automatico
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const PORTA = 4731, PORTA_UAZAPI = 4732;
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-webhook-automatico.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = String(PORTA);
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";   // o teste chama a conferência geral na mão
process.env.APP_URL = `http://127.0.0.1:${PORTA}`;
process.env.CONHUB_WEBHOOK_PERMITE_LOCAL = "1";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const NOSSO = `http://127.0.0.1:${PORTA}/webhooks/uazapi`;
const webhooks = {
  "tok-casa": [], "tok-marina": [], "tok-antiga": [],
  "tok-velho": [{ id: "v1", enabled: true, url: "https://crm-antigo.up.railway.app/webhooks/uazapi", events: ["messages"] }],
  "tok-n8n": [{ id: "n1", enabled: true, url: "https://n8n.cliente.com/hook", events: ["messages"] }],
  "tok-desligado": [{ id: "w1", enabled: false, url: NOSSO, events: ["messages"] }],
};
const posts = [];
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    const tk = req.headers.token;
    const json = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/instance/status")
      return json(200, { instance: { status: "connected", owner: "5582999990000" }, status: { connected: true, loggedIn: true } });
    if (req.url === "/webhook") {
      if (tk === "tok-404") return json(404, { message: "not found" });
      const lista = webhooks[tk] || (webhooks[tk] = []);
      if (req.method === "GET") return json(200, lista);
      const b = JSON.parse(corpo || "{}");
      posts.push({ tk, ...b });
      const item = { id: b.id || "novo" + posts.length, enabled: b.enabled, url: b.url, events: b.events, excludeMessages: b.excludeMessages };
      if (b.action === "add") lista.push(item);
      else if (b.action === "update") { const i = lista.findIndex(w => w.id === b.id); lista[i] = item; }
      else { lista.length = 0; lista.push(item); }
      return json(200, lista);
    }
    json(404, { message: "not found" });
  });
});
await new Promise((r) => mock.listen(PORTA_UAZAPI, r));
const HOST = `http://127.0.0.1:${PORTA_UAZAPI}`;

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
await new Promise(r => setTimeout(r, 700));
const BASE = `http://127.0.0.1:${PORTA}`;
const { garantirWebhook, garantirWebhooksEmTodas } = await import("../src/services/webhook-uazapi.js");
const { garantirCasa } = await import("../src/services/canais.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Maragogi", "MG-1", Date.now());
garantirCasa(org);
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role, extra = 0) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,canal_liberado)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@mg.com", senha, role, Date.now(), extra);
  return id; };
const gestor = user("Gestor", "adm"), marina = user("Marina", "corretor", 1);
const entrar = async (nome) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: nome.toLowerCase() + "@mg.com", password: "123456" }) })).json()).token;
const tG = await entrar("Gestor"), tM = await entrar("Marina");
const post = async (tk, caminho, corpo) => {
  const r = await fetch(BASE + caminho, { method: "POST", headers: { authorization: "Bearer " + tk, "content-type": "application/json" }, body: JSON.stringify(corpo || {}) });
  return { status: r.status, d: await r.json() };
};
const nosso = (tk) => webhooks[tk].filter(w => /\/webhooks\/uazapi$/.test(w.url));

console.log("1. Conectar o número da imobiliária liga o recebimento");
let r = await post(tG, "/config/conexao/credenciais", { host: HOST, token: "tok-casa" });
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.equal(r.d.recebimento.estado, "ok"); assert.equal(r.d.recebimento.acao, "configurado");
assert.equal(r.d.aviso, null);
assert.deepEqual(webhooks["tok-casa"].map(w => [w.url, w.enabled, w.events.join()]), [[NOSSO, true, "messages"]]);
assert.ok(posts.at(-1).excludeMessages.includes("isGroupYes"), "grupos ficam de fora");
assert.ok(!posts.at(-1).excludeMessages.includes("wasSentByApi"), "o eco continua vindo, como sempre veio");
assert.equal(db.prepare("SELECT webhook_estado FROM canais WHERE org_id=? AND tipo='imobiliaria'").get(org).webhook_estado, "ok");

console.log("2. O número do corretor também");
r = await post(tM, "/canais/meu/credenciais", { host: HOST, token: "tok-marina" });
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.equal(r.d.recebimento.estado, "ok");
assert.equal(nosso("tok-marina").length, 1);
assert.equal(r.d.meu.recebimento.estado, "ok", "a tela recebe o estado junto da linha");

console.log("3. Webhook que já aponta para o CRM não é tocado");
let antes = posts.length;
db.prepare("UPDATE orgs SET uazapi_token='tok-velho' WHERE id=?").run(org);
let g = await garantirWebhook(org, null);
assert.deepEqual([g.estado, g.acao], ["ok", "ja_estava"]);
assert.equal(posts.length, antes, "nenhum POST");
assert.equal(webhooks["tok-velho"][0].url, "https://crm-antigo.up.railway.app/webhooks/uazapi");

console.log("4. Webhook de outro sistema do cliente fica; o do CRM entra ao lado");
db.prepare("UPDATE orgs SET uazapi_token='tok-n8n' WHERE id=?").run(org);
g = await garantirWebhook(org, null);
assert.equal(g.estado, "ok"); assert.equal(posts.at(-1).action, "add");
assert.deepEqual(webhooks["tok-n8n"].map(w => w.url), ["https://n8n.cliente.com/hook", NOSSO]);

console.log("5. Webhook do CRM desligado é religado, sem criar um segundo");
db.prepare("UPDATE orgs SET uazapi_token='tok-desligado' WHERE id=?").run(org);
g = await garantirWebhook(org, null);
assert.equal(g.estado, "ok"); assert.deepEqual([posts.at(-1).action, posts.at(-1).id], ["update", "w1"]);
assert.equal(webhooks["tok-desligado"].length, 1); assert.equal(webhooks["tok-desligado"][0].enabled, true);

console.log("6. A conferência geral conserta a linha que já existia sem webhook");
db.prepare("UPDATE orgs SET uazapi_token='tok-casa', uazapi_host=? WHERE id=?").run(HOST, org);
const antigo = user("Rafael", "corretor", 1);
db.prepare(`INSERT INTO canais (id,org_id,tipo,user_id,nome,host,token,ativo,created_at) VALUES (?,?,'corretor',?,?,?,?,1,?)`)
  .run("cn_" + randomUUID(), org, antigo, "Rafael", HOST, "tok-antiga", Date.now());
process.env.UAZAPI_AUTOCONFIGURAR = "1";
await garantirWebhooksEmTodas();
process.env.UAZAPI_AUTOCONFIGURAR = "0";
assert.equal(nosso("tok-antiga").length, 1, "linha antiga consertada sem ninguém mexer");
assert.equal(db.prepare("SELECT webhook_estado FROM canais WHERE token='tok-antiga'").get().webhook_estado, "ok");

console.log("7. Uazapi sem a rota de webhook: conecta mesmo assim, com o aviso escrito");
r = await post(tG, "/config/conexao/credenciais", { host: HOST, token: "tok-404" });
assert.equal(r.status, 200);
assert.equal(r.d.recebimento.estado, "erro");
assert.match(r.d.aviso, /recebimento das mensagens não foi ligado/);
assert.equal(db.prepare("SELECT webhook_estado FROM canais WHERE org_id=? AND tipo='imobiliaria'").get(org).webhook_estado, "erro");
r = await post(tG, "/config/conexao/credenciais", { host: HOST, token: "tok-casa" });
assert.equal(r.d.recebimento.estado, "ok");

console.log("8. Sem endereço público (ou localhost), nada é configurado");
antes = posts.length;
const guardado = process.env.APP_URL;
delete process.env.APP_URL;
assert.equal((await garantirWebhook(org, null)).estado, "sem_endereco");
process.env.APP_URL = guardado; delete process.env.CONHUB_WEBHOOK_PERMITE_LOCAL;
webhooks["tok-casa"].length = 0;
assert.equal((await garantirWebhook(org, null)).estado, "sem_endereco", "localhost nunca vira webhook de cliente real");
process.env.CONHUB_WEBHOOK_PERMITE_LOCAL = "1";
assert.equal(posts.length, antes);

console.log("9. \"Conferir recebimento\" é da supervisão");
r = await post(tM, "/config/conexao/recebimento");
assert.equal(r.status, 403);
r = await post(tG, "/config/conexao/recebimento");
assert.equal(r.status, 200);
assert.deepEqual(r.d.linhas.map(l => [l.tipo, l.estado]).sort(),
  [["corretor", "ok"], ["corretor", "ok"], ["imobiliaria", "ok"]]);
assert.equal(nosso("tok-casa").length, 1, "a casa, zerada no caso 8, foi religada pelo botão");

console.log("10. A mensagem que chega pelo número do corretor aparece para o gestor");
/* A triagem de números novos (03/10/2026) nasce LIGADA na linha pessoal.
   Este teste confere a ROTA do lead que nasce ali — então ela fica desligada
   aqui; a triagem tem teste próprio (npm run teste:triagem). */
db.prepare("UPDATE canais SET triagem = 0 WHERE tipo = 'corretor'").run();
const w = await fetch(BASE + "/webhooks/uazapi", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ EventType: "messages", token: "tok-marina", owner: "5582999990000",
    message: { chatid: "5582988887777@s.whatsapp.net", sender: "5582988887777@s.whatsapp.net", fromMe: false,
      text: "Oi, vi o anúncio da casa na praia", messageid: "wa_in_1", senderName: "Cliente Praia", messageType: "Conversation" } }) });
assert.equal(w.status, 200);
await new Promise(r => setTimeout(r, 400));
const lead = db.prepare("SELECT * FROM leads WHERE org_id=? AND phone LIKE '%88887777'").get(org);
assert.ok(lead, "o lead nasceu");
assert.equal(lead.assigned_to, marina, "é da Marina, dona do número");
const lista = await (await fetch(BASE + "/leads", { headers: { authorization: "Bearer " + tG } })).json();
assert.ok(lista.some(l => l.id === lead.id), "e o gestor vê a conversa");

console.log("\nTudo certo ✅");
process.exit(0);
