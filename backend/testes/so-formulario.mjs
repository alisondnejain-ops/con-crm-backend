/* SÓ LEADS DO FORMULÁRIO (11/11/2026, services/so-formulario.js).

   0. Desligado (padrão): número novo vira lead, como sempre.
   1. Só o master liga; o gestor da conta não.
   2. Ligado: número novo escreve e NADA entra (sem lead, sem mensagem,
      sem "Novos contatos").
   3. Lead espontâneo que já existia deixa de receber mensagem.
   4. Lead do formulário do site entra e a conversa dele passa.
   5. Quem escreveu antes e depois preencheu o formulário volta a passar.
   6. Outra conta (sem a chave) continua criando lead.
   7. Prévia e retirar: só os espontâneos saem, com cópia em leads_retirados;
      venda registrada fica; sem RETIRAR é recusado.

   Rodar:  npm run teste:so-formulario */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-so-formulario.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4851;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "RR-SOF", APP_URL: "",
    MARKETING_AGENDADOR: "0", UAZAPI_AUTOCONFIGURAR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (c) => { servidor.kill("SIGTERM"); process.exit(c); };
process.on("uncaughtException", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-1500)); fim(1); });
process.on("unhandledRejection", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-1500)); fim(1); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(url("/health"))).ok) break; } catch (e) {} await new Promise(x => setTimeout(x, 250)); }

const { default: db } = await import("../src/db.js");
const { sign } = await import("../src/auth.js");
const C = await import("../src/services/canais.js");

const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host='https://rr.uazapi.com', uazapi_token='token-rr' WHERE id=?").run(org);
const agora = Date.now();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES ('org_outra','Outra','OUT-1',?,'https://out.uazapi.com','token-outra')").run(agora);
const pessoa = (id, o, nome, papel, master = 0) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,?,?,'x',?,1,?,'ativo',?)`).run(id, o, nome, nome.toLowerCase() + "@x.com", papel, agora, master);
pessoa("u_master", org, "Ali", "adm", 1);
pessoa("u_elder", org, "Elder", "adm");
pessoa("u_lara", org, "Lara", "corretor");
pessoa("u_out", "org_outra", "Outro", "adm");
C.garantirCasa(org); C.garantirCasa("org_outra");

const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo, extra = {}) => {
  const r = await fetch(url(p), { method: metodo, headers: { authorization: extra.auth || cracha(quem), "content-type": "application/json", ...(extra.h || {}) },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const mandar = (token, phone, texto) => fetch(url("/webhooks/uazapi"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, event: "messages", message: { chatid: `${phone}@s.whatsapp.net`, text: texto, senderName: "Contato",
    messageid: "wa_" + Math.random().toString(36).slice(2) } }),
});
const esperar = () => new Promise(r => setTimeout(r, 400));
const leadsDe = (o, phone) => db.prepare("SELECT * FROM leads WHERE org_id = ? AND phone = ?").all(o, phone);
const comTexto = (t) => db.prepare("SELECT COUNT(*) n FROM messages WHERE body LIKE ?").get(`%${t}%`).n;

let ok = 0; const caso = async (nome, fn) => { await fn(); ok++; console.log("✓", nome); };

await caso("0. Desligado: número novo vira lead, como sempre", async () => {
  await mandar("token-rr", "5587990000001", "oi antes da chave"); await esperar();
  assert.equal(leadsDe(org, "5587990000001").length, 1);
});

await caso("1. Só o master liga", async () => {
  assert.equal((await api("u_elder", "POST", `/orgs/${org}/so-formulario`, { ligado: true })).status, 403);
  const r = await api("u_master", "POST", `/orgs/${org}/so-formulario`, { ligado: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.org.so_formulario, true);
  assert.equal(r.body.previa.total, 1, "o lead do caso 0 é espontâneo");
});

await caso("2. Ligado: número novo não entra (nem lead, nem mensagem, nem triagem)", async () => {
  await mandar("token-rr", "5587990000002", "mensagem espontanea xyz"); await esperar();
  assert.equal(leadsDe(org, "5587990000002").length, 0);
  assert.equal(comTexto("mensagem espontanea xyz"), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contatos_novos WHERE phone = '5587990000002'").get().n, 0);
});

await caso("3. Lead espontâneo que já existia deixa de receber mensagem", async () => {
  await mandar("token-rr", "5587990000001", "voltei a escrever abc"); await esperar();
  assert.equal(comTexto("voltei a escrever abc"), 0);
});

let token;
await caso("4. Lead do formulário do site entra e a conversa passa", async () => {
  token = (await api("u_elder", "POST", "/config/formulario-site/token")).body.token;
  const r = await fetch(url("/publico/leads"), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ nome: "Carla", telefone: "+5587990000003", consentimento_lgpd: true }) });
  assert.equal(r.status, 201);
  assert.ok(leadsDe(org, "5587990000003")[0].formulario_em);
  await mandar("token-rr", "5587990000003", "sou do formulario def"); await esperar();
  assert.equal(comTexto("sou do formulario def"), 1);
});

await caso("5. Escreveu antes, preencheu depois: volta a passar", async () => {
  const r = await fetch(url("/publico/leads"), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ nome: "Antigo", telefone: "+5587990000001", consentimento_lgpd: true }) });
  assert.equal(r.status, 201);
  assert.equal(leadsDe(org, "5587990000001").length, 1, "o mesmo lead, sem duplicar");
  await mandar("token-rr", "5587990000001", "agora preenchi ghi"); await esperar();
  assert.equal(comTexto("agora preenchi ghi"), 1);
});

await caso("6. Outra conta continua criando lead", async () => {
  await mandar("token-outra", "5587990000009", "outra conta jkl"); await esperar();
  assert.equal(leadsDe("org_outra", "5587990000009").length, 1);
  assert.equal(comTexto("outra conta jkl"), 1);
});

await caso("7. Prévia e retirar: só os espontâneos, com cópia; venda fica", async () => {
  // Dois espontâneos (criados antes da chave, direto no banco) e um com venda.
  const ins = (id, phone, venda) => db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at,source,sale_value,sale_date)
    VALUES (?,?,?,?,'Lead',?,'whatsapp',?,?)`).run(id, org, "Esp " + id, phone, agora, venda ? 1000 : null, venda ? agora : null);
  ins("l_e1", "5587990000011"); ins("l_e2", "5587990000012"); ins("l_v", "5587990000013", true);
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES ('m_e1','l_e1','in','oi espontaneo',?)").run(agora);
  const p = await api("u_master", "GET", `/orgs/${org}/so-formulario/previa`);
  assert.equal(p.body.total, 2); assert.equal(p.body.com_venda_ficam, 1);
  assert.equal((await api("u_master", "POST", `/orgs/${org}/so-formulario/retirar`, {})).status, 400);
  assert.equal((await api("u_elder", "POST", `/orgs/${org}/so-formulario/retirar`, { confirmar: "RETIRAR" })).status, 403);
  const r = await api("u_master", "POST", `/orgs/${org}/so-formulario/retirar`, { confirmar: "RETIRAR" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.retirados, 2); assert.equal(r.body.previa.total, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE id IN ('l_e1','l_e2')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE id IN ('l_v','" + leadsDe(org, "5587990000003")[0].id + "')").get().n, 2);
  const copia = db.prepare("SELECT * FROM leads_retirados WHERE id = 'l_e1'").get();
  assert.ok(copia && JSON.parse(copia.mensagens_json).length === 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = 'l_e1'").get().n, 0);
  // A outra conta não foi tocada.
  assert.equal(leadsDe("org_outra", "5587990000009").length, 1);
});

console.log(`\n${ok} casos passaram.`);
fim(0);
