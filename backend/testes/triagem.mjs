/* TRIAGEM DE NÚMEROS NOVOS (03/10/2026).

   O pedido: o WhatsApp pessoal do corretor não pode espelhar a vida pessoal
   dele no CRM. Número que ainda não é lead vai para "Novos contatos" — só nome
   e número, NUNCA o texto — e alguém decide: é lead, ou é pessoal.

   O que este teste mais confere é o que NÃO pode acontecer, porque é aí que
   falha em silêncio: a conversa pessoal ficar gravada, a gestão enxergar os
   contatos do WhatsApp pessoal de alguém, e o número da casa (onde quem
   escreve é cliente) passar a segurar lead sem ninguém ter pedido.

   Servidor de pé, conferência por HTTP — as regras moram na rota do webhook.
   Rodar:  npm run teste:triagem */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-triagem.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4795;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (codigo) => { servidor.kill("SIGTERM"); process.exit(codigo); };
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
db.prepare("UPDATE orgs SET uazapi_host='https://casa.uazapi.com', uazapi_token='token-da-casa' WHERE id=?").run(org);
const novo = (id, nome, papel) =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@c.com", papel, Date.now());
novo("u_ali", "Ali", "adm");
novo("u_vanessa", "Vanessa", "sdr");
novo("u_marina", "Marina", "corretor");
novo("u_bruno", "Bruno", "corretor");
C.garantirCasa(org);
const criada = C.criarCanalDoCorretor(org, "u_marina");
C.salvarConexao(criada.canal.id, { host: "https://marina.uazapi.com", token: "token-da-marina" });
const daMarina = C.canalDoUsuario(org, "u_marina");

const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(url(p), { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const mandar = (token, phone, texto, nome = "Contato") => fetch(url("/webhooks/uazapi"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, event: "messages",
    message: { chatid: `${phone}@s.whatsapp.net`, text: texto, senderName: nome,
      messageid: "wa_" + Math.random().toString(36).slice(2) } }),
});
const esperar = () => new Promise(r => setTimeout(r, 400));
const leads = (phone) => db.prepare("SELECT * FROM leads WHERE phone = ?").all(phone);
const comTexto = (t) => db.prepare("SELECT COUNT(*) n FROM messages WHERE body LIKE ?").get(`%${t}%`).n;

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

caso("Número novo no WhatsApp PESSOAL da Marina não vira lead, e nada da conversa fica gravado");
await mandar("token-da-marina", "5587999990001", "mãe aqui, traz pão [t1]", "Mãe"); await esperar();
assert.equal(leads("5587999990001").length, 0, "não pode nascer lead");
assert.equal(comTexto("[t1]"), 0, "o texto da conversa pessoal não pode ficar no banco");
let cn = db.prepare("SELECT * FROM contatos_novos WHERE phone = ?").get("5587999990001");
assert.ok(cn, "vai para Novos contatos");
assert.equal(cn.nome, "Mãe");
assert.equal(cn.linha, daMarina.id);

caso("A segunda mensagem só conta — continua sem lead e sem texto");
await mandar("token-da-marina", "5587999990001", "e leite também [t2]", "Mãe"); await esperar();
cn = db.prepare("SELECT * FROM contatos_novos WHERE phone = ?").get("5587999990001");
assert.equal(cn.quantas, 2);
assert.equal(leads("5587999990001").length, 0);
assert.equal(comTexto("[t2]"), 0);

caso("Só a DONA do WhatsApp vê esses contatos — nem a gestão, nem o colega");
let r = await api("u_marina", "GET", "/triagem");
assert.equal(r.status, 200);
assert.ok(r.body.novos.some(x => x.phone === "5587999990001"), "a Marina vê");
assert.equal(r.body.novos[0].linha_nome, "Seu WhatsApp");
for (const quem of ["u_ali", "u_vanessa", "u_bruno"]) {
  r = await api(quem, "GET", "/triagem");
  assert.ok(!r.body.novos.some(x => x.phone === "5587999990001"), `${quem} não pode ver os contatos do WhatsApp pessoal da Marina`);
}
r = await api("u_ali", "POST", `/triagem/novos/${cn.id}`, { decisao: "lead" });
assert.equal(r.status, 403, "o gestor não decide pelo WhatsApp pessoal dela");

caso("\"É pessoal\": o número é ignorado dali em diante, sem nem passar pela triagem");
r = await api("u_marina", "POST", `/triagem/novos/${cn.id}`, { decisao: "pessoal" });
assert.equal(r.status, 200);
assert.ok(!db.prepare("SELECT 1 FROM contatos_novos WHERE id = ?").get(cn.id));
await mandar("token-da-marina", "5587999990001", "chegou?", "Mãe"); await esperar();
assert.equal(leads("5587999990001").length, 0);
assert.ok(!db.prepare("SELECT 1 FROM contatos_novos WHERE phone = ?").get("5587999990001"), "não volta para a triagem");

caso("O nono dígito não fura a marcação: o mesmo número sem o 9 também é ignorado");
await mandar("token-da-marina", "558799990001", "sem o nove", "Mãe"); await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM contatos_novos WHERE phone LIKE '%99990001'").get().n, 0);
assert.equal(leads("558799990001").length, 0);

caso("\"Voltar a receber\" desfaz — o número volta a passar pela triagem");
r = await api("u_bruno", "POST", "/triagem/pessoais/voltar", { linha: daMarina.id, phone: "5587999990001" });
assert.equal(r.status, 403, "o colega não mexe na lista dela");
r = await api("u_marina", "POST", "/triagem/pessoais/voltar", { linha: daMarina.id, phone: "5587999990001" });
assert.equal(r.status, 200);
await mandar("token-da-marina", "5587999990001", "oi de novo", "Mãe"); await esperar();
assert.ok(db.prepare("SELECT 1 FROM contatos_novos WHERE phone = ?").get("5587999990001"));

caso("\"É lead\": nasce do dono da linha, e a conversa passa a ser espelhada dali em diante");
await mandar("token-da-marina", "5587999990002", "vi a casa do Centro, ainda tem? [t7a]", "Carla"); await esperar();
cn = db.prepare("SELECT * FROM contatos_novos WHERE phone = ?").get("5587999990002");
r = await api("u_marina", "POST", `/triagem/novos/${cn.id}`, { decisao: "lead" });
assert.equal(r.status, 200);
let l = leads("5587999990002");
assert.equal(l.length, 1);
assert.equal(l[0].assigned_to, "u_marina", "lead do WhatsApp pessoal é de quem é o WhatsApp");
assert.equal(l[0].canal_id, daMarina.id);
assert.equal(l[0].name, "Carla");
assert.equal(comTexto("[t7a]"), 0, "o que chegou antes da decisão não fica (está escrito na tela)");
await mandar("token-da-marina", "5587999990002", "posso visitar sábado? [t7b]", "Carla"); await esperar();
assert.equal(comTexto("[t7b]"), 1, "depois do É lead, a conversa entra");

caso("No número da CASA a triagem nasce desligada: quem escreve vira lead pela catraca, como sempre");
await mandar("token-da-casa", "5587999990003", "quero informação [t8]", "Diego"); await esperar();
l = leads("5587999990003");
assert.equal(l.length, 1);
assert.equal(l[0].assigned_to, "u_vanessa");
assert.equal(comTexto("[t8]"), 1);

caso("Ligar a triagem na casa é do GESTOR; a atendente decide, mas não liga");
r = await api("u_vanessa", "POST", "/triagem/linhas", { linha: "", ligada: true });
assert.equal(r.status, 403);
r = await api("u_marina", "POST", "/triagem/linhas", { linha: "", ligada: true });
assert.equal(r.status, 403);
r = await api("u_ali", "POST", "/triagem/linhas", { linha: "", ligada: true });
assert.equal(r.status, 200);
await mandar("token-da-casa", "5587999990004", "oi, sou o fornecedor", "Fornecedor"); await esperar();
assert.equal(leads("5587999990004").length, 0);
cn = db.prepare("SELECT * FROM contatos_novos WHERE phone = ?").get("5587999990004");
assert.equal(cn.linha, "", "a casa é a linha vazia");
r = await api("u_marina", "GET", "/triagem");
assert.ok(!r.body.novos.some(x => x.phone === "5587999990004"), "corretor não vê a triagem da casa");
r = await api("u_vanessa", "GET", "/triagem");
assert.ok(r.body.novos.some(x => x.phone === "5587999990004"), "a atendente vê");
r = await api("u_vanessa", "POST", `/triagem/novos/${cn.id}`, { decisao: "pessoal" });
assert.equal(r.status, 200);

caso("Quem JÁ é lead continua entrando com a triagem ligada");
await mandar("token-da-casa", "5587999990003", "e o valor? [t10]", "Diego"); await esperar();
assert.equal(comTexto("[t10]"), 1);

caso("\"Isto é conversa pessoal\" num lead: corretor não marca no número da casa, e sem a confirmação escrita não vai");
const diego = leads("5587999990003")[0];
db.prepare("UPDATE leads SET assigned_to='u_bruno' WHERE id=?").run(diego.id);
r = await api("u_bruno", "POST", `/triagem/leads/${diego.id}/pessoal`, { confirmar: "PESSOAL" });
assert.equal(r.status, 403);
r = await api("u_vanessa", "POST", `/triagem/leads/${diego.id}/pessoal`, {});
assert.equal(r.status, 400);

caso("Confirmado: o lead e a conversa saem do CRM, e o número passa a ser ignorado");
r = await api("u_vanessa", "POST", `/triagem/leads/${diego.id}/pessoal`, { confirmar: "PESSOAL" });
assert.equal(r.status, 200);
assert.equal(r.body.mensagens, 2);
assert.equal(leads("5587999990003").length, 0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(diego.id).n, 0);
await mandar("token-da-casa", "5587999990003", "oi?", "Diego"); await esperar();
assert.equal(leads("5587999990003").length, 0);
assert.ok(!db.prepare("SELECT 1 FROM contatos_novos WHERE phone = ?").get("5587999990003"));

caso("No WhatsApp pessoal, a dona marca o próprio lead como pessoal; venda registrada não deixa");
const carla = leads("5587999990002")[0];
db.prepare("UPDATE leads SET sale_value = 100000, sale_date = ? WHERE id = ?").run(Date.now(), carla.id);
r = await api("u_marina", "POST", `/triagem/leads/${carla.id}/pessoal`, { confirmar: "PESSOAL" });
assert.equal(r.status, 409);
db.prepare("UPDATE leads SET sale_value = NULL, sale_date = NULL WHERE id = ?").run(carla.id);
r = await api("u_marina", "POST", `/triagem/leads/${carla.id}/pessoal`, { confirmar: "PESSOAL" });
assert.equal(r.status, 200);
assert.equal(leads("5587999990002").length, 0);

caso("A dona pode desligar a triagem no WhatsApp dela — aí volta a ser como antes");
r = await api("u_marina", "POST", "/triagem/linhas", { linha: daMarina.id, ligada: false });
assert.equal(r.status, 200);
await mandar("token-da-marina", "5587999990005", "oi Marina", "Eva"); await esperar();
assert.equal(leads("5587999990005").length, 1);

console.log(`\nTodos os ${n} casos passaram.`);
fim(0);
