/* DEFEITOS DA LISTA DO FERNANDO (28/10/2026).

   1. Temperatura na mão: o filtro existia e não havia rota para marcar.
   2. Mensagem editada no WhatsApp virava um SEGUNDO balão (e a de protocolo
      marcava a original como apagada).
   3. Triagem: o que o cliente escreveu antes do "É lead" se perdia — agora é
      trazido da Uazapi só DEPOIS da decisão, e o "É pessoal" não busca nada.

   Servidor de pé e uma Uazapi de mentira.  Rodar:  npm run teste:defeitos-fernando */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-defeitos-fernando.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

// Uazapi de mentira: guarda os pedidos e devolve um histórico para /message/find.
const PORTA_UAZ = 4812;
const pedidos = [];
let historico = [];
const uaz = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => (corpo += c));
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(corpo || "{}"); } catch {}
    pedidos.push({ caminho: req.url, ...j });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/message/find") return res.end(JSON.stringify({ messages: historico }));
    res.end(JSON.stringify({ messageid: "wa_out_" + pedidos.length }));
  });
});
await new Promise(r => uaz.listen(PORTA_UAZ, r));

const PORTA = 4811;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "DEF-2026", APP_URL: "",
    UAZAPI_AUTOCONFIGURAR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (codigo) => { servidor.kill("SIGTERM"); uaz.close(); process.exit(codigo); };
process.on("uncaughtException", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-1500)); fim(1); });
process.on("unhandledRejection", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-1500)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}

const { default: db } = await import("../src/db.js");
const { sign } = await import("../src/auth.js");
const C = await import("../src/services/canais.js");

const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token='token-da-casa' WHERE id=?").run(`http://127.0.0.1:${PORTA_UAZ}`, org);
const novo = (id, nome, papel) =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@d.com", papel, Date.now());
novo("u_ali", "Ali", "adm");
novo("u_marina", "Marina", "corretor");
novo("u_bruno", "Bruno", "corretor");
C.garantirCasa(org);
const criada = C.criarCanalDoCorretor(org, "u_marina");
C.salvarConexao(criada.canal.id, { host: `http://127.0.0.1:${PORTA_UAZ}`, token: "token-da-marina" });

const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(url(p), { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const webhook = (token, message) => fetch(url("/webhooks/uazapi"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, event: "messages", message }),
});
const esperar = (ms = 400) => new Promise(r => setTimeout(r, ms));

const LEAD = "l_def_1", FONE = "5587991230000";
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to)
  VALUES (?,?,?,?,'{}','Lead',?,?)`).run(LEAD, org, "Cliente", FONE, Date.now(), "u_marina");
const msg = (id, corpo, waId, autor = null, dir = "in") => db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,body,wa_id,created_at)
  VALUES (?,?,?,?,?,?,?)`).run(id, LEAD, dir, autor, corpo, waId, Date.now());

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

caso("Temperatura: o dono marca; outro corretor não; valor inválido é recusado; tocar de novo tira");
let r = await api("u_marina", "PATCH", `/leads/${LEAD}/temperatura`, { temperatura: "quente" });
assert.equal(r.status, 200, JSON.stringify(r.body));
let l = db.prepare("SELECT priority, priority_por FROM leads WHERE id=?").get(LEAD);
assert.equal(l.priority, "QUENTE"); assert.equal(l.priority_por, "mao");
r = await api("u_bruno", "PATCH", `/leads/${LEAD}/temperatura`, { temperatura: "FRIO" });
assert.equal(r.status, 403);
r = await api("u_marina", "PATCH", `/leads/${LEAD}/temperatura`, { temperatura: "fervendo" });
assert.equal(r.status, 400);
r = await api("u_ali", "PATCH", `/leads/${LEAD}/temperatura`, { temperatura: null });
assert.equal(r.status, 200);
assert.equal(db.prepare("SELECT priority FROM leads WHERE id=?").get(LEAD).priority, null);

caso("Edição do WhatsApp (formato uazapiGO, campo `edited`) troca o texto, não cria balão novo");
msg("m_d1", "oi, tudo bem?", "WAORIG1");
const antes = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id=?").get(LEAD).n;
await webhook("token-da-casa", { chatid: `${FONE}@s.whatsapp.net`, messageid: "WAEDIT1", messageType: "ExtendedTextMessage",
  edited: "WAORIG1", text: "oi, tudo bem? (editado)" });
await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id=?").get(LEAD).n, antes, "não pode nascer balão novo");
let m = db.prepare("SELECT * FROM messages WHERE id='m_d1'").get();
assert.equal(m.body, "oi, tudo bem? (editado)");
assert.equal(m.body_original, "oi, tudo bem?");
assert.ok(m.edited_at);

caso("Edição como protocolo (tipo 14) troca o texto e NÃO marca a original como apagada");
await webhook("token-da-casa", { chatid: `${FONE}@s.whatsapp.net`, messageid: "WAEDIT2", messageType: "ProtocolMessage",
  protocolMessage: { type: 14, key: { id: "WAORIG1" }, editedMessage: { conversation: "versão 3" } } });
await esperar();
m = db.prepare("SELECT * FROM messages WHERE id='m_d1'").get();
assert.equal(m.body, "versão 3");
assert.equal(m.apagada_em, null, "edição não é apagar");
assert.equal(m.body_original, "oi, tudo bem?", "a primeira versão continua guardada");

caso("Apagar (protocolo de revogação) continua marcando como apagada");
msg("m_d2", "vou apagar", "WAORIG2");
await webhook("token-da-casa", { chatid: `${FONE}@s.whatsapp.net`, messageid: "WAREV", messageType: "ProtocolMessage",
  protocolMessage: { type: 0, key: { id: "WAORIG2" } } });
await esperar();
assert.ok(db.prepare("SELECT apagada_em FROM messages WHERE id='m_d2'").get().apagada_em);

caso("Eco da edição de uma mensagem que SAIU PELO CRM não reescreve o texto (já foi trocado pela rota)");
msg("m_d3", "Bom dia!", "WAORIG3", "u_marina", "out");
await webhook("token-da-casa", { chatid: `${FONE}@s.whatsapp.net`, messageid: "WAEDIT3", fromMe: true, messageType: "EditedMessage",
  edited: "WAORIG3", text: "*Marina:* Bom dia!!" });
await esperar();
assert.equal(db.prepare("SELECT body FROM messages WHERE id='m_d3'").get().body, "Bom dia!");
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE wa_id='WAEDIT3'").get().n, 0);

caso("Triagem: o texto não é gravado antes; no \"É lead\" o que ele escreveu é trazido da Uazapi");
const NOVO = "5587991239999";
await webhook("token-da-marina", { chatid: `${NOVO}@s.whatsapp.net`, messageid: "WAT1", text: "Olá, vim do Instagram", senderName: "Joana" });
await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE body LIKE '%vim do Instagram%'").get().n, 0, "antes da decisão, nada gravado");
const cn = db.prepare("SELECT * FROM contatos_novos WHERE phone=?").get(NOVO);
assert.ok(cn);
const seg = (ms) => Math.floor(ms / 1000);
historico = [
  { messageid: "WAVELHA", fromMe: false, text: "conversa antiga de meses atrás", messageTimestamp: seg(Date.now() - 90 * 86400000) },
  { messageid: "WAT1", fromMe: false, text: "Olá, vim do Instagram", messageTimestamp: seg(cn.primeira_em) },
  { messageid: "WAT2", fromMe: true, text: "Oi Joana, tudo bem?", messageTimestamp: seg(cn.primeira_em) + 30 },
  { messageid: "WAT3", fromMe: false, messageType: "ImageMessage", messageTimestamp: seg(cn.primeira_em) + 60 },
];
pedidos.length = 0;
r = await api("u_marina", "POST", `/triagem/novos/${cn.id}`, { decisao: "lead" });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.recuperadas, 3);
const conversa = db.prepare("SELECT direction, body FROM messages WHERE lead_id=? ORDER BY created_at").all(r.body.lead_id);
assert.deepEqual(conversa.map(c => c.body), ["Olá, vim do Instagram", "Oi Joana, tudo bem?", "Foto"]);
assert.equal(conversa[1].direction, "out");
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE body LIKE '%conversa antiga%'").get().n, 0,
  "só o que chegou desde a triagem — nada do histórico anterior");
const find = pedidos.find(p => p.caminho === "/message/find");
assert.equal(find.chatid, `${NOVO}@s.whatsapp.net`);

caso("A mesma mensagem chegando de novo pelo webhook não duplica a recuperada");
await webhook("token-da-marina", { chatid: `${NOVO}@s.whatsapp.net`, messageid: "WAT1", text: "Olá, vim do Instagram", senderName: "Joana" });
await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE body = 'Olá, vim do Instagram'").get().n, 1);

caso("\"É pessoal\" não busca nada na Uazapi");
const PESSOAL = "5587991238888";
await webhook("token-da-marina", { chatid: `${PESSOAL}@s.whatsapp.net`, messageid: "WAP1", text: "traz pão", senderName: "Mãe" });
await esperar();
const cp = db.prepare("SELECT * FROM contatos_novos WHERE phone=?").get(PESSOAL);
pedidos.length = 0;
r = await api("u_marina", "POST", `/triagem/novos/${cp.id}`, { decisao: "pessoal" });
assert.equal(r.status, 200);
assert.equal(pedidos.filter(p => p.caminho === "/message/find").length, 0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE body LIKE '%traz pão%'").get().n, 0);

caso("A Uazapi falhando no histórico não impede o \"É lead\"");
const OUTRO = "5587991237777";
await webhook("token-da-marina", { chatid: `${OUTRO}@s.whatsapp.net`, messageid: "WAO1", text: "oi", senderName: "Pedro" });
await esperar();
const co = db.prepare("SELECT * FROM contatos_novos WHERE phone=?").get(OUTRO);
historico = "quebrado";
r = await api("u_marina", "POST", `/triagem/novos/${co.id}`, { decisao: "lead" });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.ok(r.body.lead_id);
assert.equal(r.body.recuperadas, 0);

caso("Gestor que atendeu no período entra no relatório e no ranking; o que só gerencia, não");
novo("u_gerente", "Gerente", "adm");
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at)
  VALUES ('l_def_ali',?,'Lead do Ali','5587991236666','{}','Lead',?,'u_ali',?)`).run(org, Date.now(), Date.now());
r = await api("u_ali", "GET", "/reports?periodo=mes");
assert.equal(r.status, 200, JSON.stringify(r.body));
const nomes = (r.body.atendentes || []).map(x => x.nome || x.name);
assert.ok(nomes.includes("Ali"), "o gestor que recebeu lead aparece: " + nomes);
assert.ok(!nomes.includes("Gerente"), "o gestor sem atendimento não aparece");
assert.ok(nomes.includes("Marina"));
r = await api("u_ali", "GET", "/reports/score?periodo=mes");
assert.equal(r.status, 200);
const noScore = JSON.stringify(r.body);
assert.ok(noScore.includes("u_ali"), "o gestor entra no ranking");
assert.ok(!noScore.includes("u_gerente"));

console.log("\nTudo certo ✅");
fim(0);
