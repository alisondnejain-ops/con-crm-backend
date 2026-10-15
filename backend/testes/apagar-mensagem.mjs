/* APAGAR PARA TODOS E A CAMPANHA NA FICHA (15/10/2026, pedido do Ali: "todos
   tenham a opção de apagar a mensagem exatamente como é no WhatsApp" e
   "visível na ficha do lead de qual campanha ele veio").

   Servidor de pé e uma Uazapi de mentira. O que se prova:
   1. o corretor apaga a própria mensagem; a Uazapi recebe o pedido; o banco
      marca e NÃO apaga o texto;
   2. para o corretor o balão volta sem o texto; a supervisão vê o que era;
      a lista mostra "Mensagem apagada";
   3. não apaga: mensagem do cliente, a de outra pessoa (corretor), a já
      apagada, a mais velha que 2 dias e meio, a sem id do WhatsApp;
   4. se o WhatsApp recusar, nada muda no banco;
   5. o cliente apagando no WhatsApp marca a mensagem dele, e o aviso não
      vira balão;
   6. o resumo da IA não lê mensagem apagada;
   7. a ficha traz campanha, conjunto, anúncio e formulário.

   Rodar:  npm run teste:apagar-mensagem
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-apagar-mensagem.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4661";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.MARKETING_AGENDADOR = "0";
process.env.FOTOS_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== A UAZAPI DE MENTIRA =====
const chamadas = [];
let recusarApagar = false;
let n = 0;
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => (corpo += c));
  req.on("end", () => {
    const b = JSON.parse(corpo || "{}");
    chamadas.push({ caminho: req.url, b });
    const responder = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/message/delete") return recusarApagar ? responder(500, { error: "message too old" }) : responder(200, { ok: true });
    if (req.url.startsWith("/send/")) return responder(200, { messageid: "wa_out_" + (++n) });
    return responder(404, { error: "not found" });
  });
});
await new Promise(r => mock.listen(4662, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const bcrypt = (await import("bcryptjs")).default;
await import("../src/server.js");
const BASE = "http://localhost:4661";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)")
  .run(org, "Casa", "AP-1", Date.now() + 10, "http://127.0.0.1:4662", "tok-ap");
const senha = bcrypt.hashSync("123456", 8);
const pessoa = (email, role) => {
  const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, email.split("@")[0], email, senha, role, Date.now());
  return id;
};
pessoa("gestora@ap.com", "adm");
const marina = pessoa("marina@ap.com", "corretor");
const rafa = pessoa("rafa@ap.com", "corretor");
const login = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tG = await login("gestora@ap.com"), tM = await login("marina@ap.com"), tR = await login("rafa@ap.com");
const chamar = async (t, metodo, p, corpo) => {
  const r = await fetch(BASE + p, { method: metodo, headers: { "content-type": "application/json", authorization: "Bearer " + t },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};

const leadId = "l_" + randomUUID().slice(0, 8);
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at,source,campaign_name,adset_name,ad_name,form_name,platform)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(leadId, org, "Cliente", "5587991112222", "Lead", marina, Date.now() - 3600000,
  "meta", "Horizon - Outubro", "Petrolina 25-45", "Vídeo fachada", "Form Horizon", "ig");

let caso = 0;
const titulo = (t) => console.log(`\n${++caso}. ${t}`);

titulo("A corretora apaga a própria mensagem; a Uazapi recebe o pedido e o texto fica no banco");
let r = await chamar(tM, "POST", `/leads/${leadId}/messages`, { text: "Mandei o valor errado: R$ 300 mil" });
assert.equal(r.s, 200, JSON.stringify(r.b));
const enviada = db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT 1").get(leadId);
assert.ok(enviada.wa_id);
chamadas.length = 0;
r = await chamar(tM, "DELETE", `/leads/${leadId}/messages/${enviada.id}`);
assert.equal(r.s, 200, JSON.stringify(r.b));
const pedido = chamadas.find(c => c.caminho === "/message/delete");
assert.ok(pedido, "o pedido de apagar chegou à Uazapi");
assert.equal(pedido.b.id, enviada.wa_id);
let depois = db.prepare("SELECT * FROM messages WHERE id = ?").get(enviada.id);
assert.ok(depois.apagada_em); assert.equal(depois.apagada_por, marina);
assert.match(depois.body, /valor errado/, "o texto continua no registro");

titulo("Para a corretora o balão vem vazio; a supervisão vê o que era; a lista diz 'Mensagem apagada'");
r = await chamar(tM, "GET", `/leads/${leadId}`);
let m = r.b.messages.find(x => x.id === enviada.id);
assert.ok(m.apagada_em); assert.equal(m.body, "");
r = await chamar(tG, "GET", `/leads/${leadId}`);
m = r.b.messages.find(x => x.id === enviada.id);
assert.match(m.body, /valor errado/); assert.equal(m.apagada_por_nome, "marina");
r = await chamar(tM, "GET", `/leads`);
assert.equal(r.b.find(l => l.id === leadId).last_body, "Mensagem apagada");

titulo("Não apaga: a já apagada, a de outra pessoa, a do cliente, a velha demais e a sem id");
assert.equal((await chamar(tM, "DELETE", `/leads/${leadId}/messages/${enviada.id}`)).s, 409);
r = await chamar(tG, "POST", `/leads/${leadId}/messages`, { text: "Oi, aqui é a gestora" });
const daGestora = db.prepare("SELECT id FROM messages WHERE lead_id = ? AND from_user_id IS NOT NULL AND from_user_id <> ? ORDER BY created_at DESC LIMIT 1").get(leadId, marina).id;
assert.equal((await chamar(tM, "DELETE", `/leads/${leadId}/messages/${daGestora}`)).s, 403, "a corretora não apaga a da gestora");
const doCliente = "m_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at,wa_id) VALUES (?,?,?,?,?,?)").run(doCliente, leadId, "in", "Oi", Date.now(), "wa_in_1");
assert.equal((await chamar(tG, "DELETE", `/leads/${leadId}/messages/${doCliente}`)).s, 400);
const velha = "m_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at,wa_id,from_user_id) VALUES (?,?,?,?,?,?,?)").run(velha, leadId, "out", "antiga", Date.now() - 61 * 3600000, "wa_old", marina);
r = await chamar(tM, "DELETE", `/leads/${leadId}/messages/${velha}`);
assert.equal(r.s, 400); assert.match(r.b.error, /2 dias e meio/);
const semId = "m_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at,from_user_id) VALUES (?,?,?,?,?,?)").run(semId, leadId, "out", "sem id", Date.now(), marina);
assert.equal((await chamar(tM, "DELETE", `/leads/${leadId}/messages/${semId}`)).s, 400);
assert.equal((await chamar(tR, "DELETE", `/leads/${leadId}/messages/${daGestora}`)).s, 403, "outro corretor nem vê o lead");

titulo("O WhatsApp recusou: nada muda no banco");
recusarApagar = true;
r = await chamar(tG, "DELETE", `/leads/${leadId}/messages/${daGestora}`);
assert.equal(r.s, 502); assert.match(r.b.error, /continua como está/);
assert.equal(db.prepare("SELECT apagada_em FROM messages WHERE id = ?").get(daGestora).apagada_em, null);
recusarApagar = false;
assert.equal((await chamar(tG, "DELETE", `/leads/${leadId}/messages/${daGestora}`)).s, 200, "a supervisão apaga qualquer uma");

titulo("O cliente apaga no WhatsApp: a mensagem dele fica marcada, e o aviso não vira balão");
const antes = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(leadId).n;
const resp = await fetch(BASE + "/webhooks/uazapi", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-ap", event: "messages", message: { messageid: "wa_proto_1", fromMe: false,
    sender: "5587991112222@s.whatsapp.net", messageType: "ProtocolMessage", protocolMessage: { type: 0, key: { id: "wa_in_1" } } } }) });
assert.equal(resp.status, 200);
await new Promise(res => setTimeout(res, 300));
assert.ok(db.prepare("SELECT apagada_em FROM messages WHERE id = ?").get(doCliente).apagada_em);
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(leadId).n, antes, "nenhum balão novo");

titulo("O que a IA lê para resumir não inclui mensagem apagada");
const lidas = db.prepare("SELECT body FROM messages WHERE lead_id = ? AND apagada_em IS NULL ORDER BY created_at ASC").all(leadId).map(x => x.body);
assert.ok(!lidas.some(b => /valor errado/.test(b)));
const fonte = fs.readFileSync(new URL("../src/routes/leads.routes.js", import.meta.url), "utf8");
assert.ok(!/SELECT direction, body FROM messages WHERE lead_id = \? ORDER BY/.test(fonte), "toda leitura da conversa para a IA filtra as apagadas");

titulo("A ficha traz campanha, conjunto, anúncio e formulário");
r = await chamar(tM, "GET", `/leads/${leadId}`);
assert.equal(r.b.campaign_name, "Horizon - Outubro");
assert.equal(r.b.adset_name, "Petrolina 25-45");
assert.equal(r.b.ad_name, "Vídeo fachada");
assert.equal(r.b.form_name, "Form Horizon");
r = await chamar(tM, "GET", `/leads`);
assert.equal(r.b.find(l => l.id === leadId).adset_name, "Petrolina 25-45", "a lista leva o conjunto também");

console.log(`\nOK — ${caso} casos.`);
process.exit(0);
