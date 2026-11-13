/* SCORE COM OS 19 INDICADORES E PONTUAÇÃO LIVRE (CETRO 17.2/17.3, 13/11/2026).
   Rodar:  npm run teste:score-pontos */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-score-pontos.db");
process.env.JWT_SECRET = "teste"; process.env.PORT = "4665";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4665";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imob SP", "SP-1", Date.now());
const novo = (nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, email, senha, role, Date.now()); return id; };
novo("Gestora", "g@sp.com", "adm"); const ana = novo("Ana", "a@sp.com", "corretor"); const bia = novo("Bia", "b@sp.com", "corretor");
const login = async (e) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "123456" }) })).json()).token;
const cli = (t) => (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const G = cli(await login("g@sp.com")), A = cli(await login("a@sp.com"));
const agora = Date.now();
const lead = (dono) => { const id = "l_" + randomUUID(); db.prepare("INSERT INTO leads (id,org_id,name,phone,assigned_to,stage,created_at,assigned_at) VALUES (?,?,?,?,?,?,?,?)").run(id, org, "C", "5587" + Math.floor(Math.random() * 1e9), dono, "Lead", agora - 3600e3, agora - 3600e3); return id; };
const L1 = lead(ana), L2 = lead(ana); lead(bia);
for (const L of [L1, L2]) db.prepare("INSERT INTO messages (id,lead_id,direction,body,from_user_id,created_at) VALUES (?,?,?,?,?,?)").run("m_" + randomUUID(), L, "out", "oi", ana, agora - 1800e3);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)").run("m_" + randomUUID(), L1, "in", "oi!", agora - 1700e3);
db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,criado_por,titulo,quando,feito_em,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("t_" + randomUUID(), org, L1, ana, ana, "Ligar", agora - 600e3, null, agora - 900e3);
db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,criado_por,titulo,quando,feito_em,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("t_" + randomUUID(), org, L2, ana, ana, "Visita", agora + 86400e3, agora - 100e3, agora - 900e3);
let falhas = 0;
const caso = async (n, f) => { try { await f(); console.log("  ✓ " + n); } catch (e) { falhas++; console.log("  ✗ " + n + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } };
let r;
await caso("1. A tabela traz os 19 indicadores, na ordem do capítulo 17", async () => {
  r = await G("/reports/score?periodo=este_mes");
  assert.equal(r.body.indicadores.length, 19); assert.equal(r.body.indicadores[0].chave, "score"); assert.equal(r.body.indicadores[18].chave, "perdidos");
  const a = r.body.equipe.find(m => m.id === ana);
  assert.equal(a.mensagens, 2); assert.equal(a.trabalhados, 2); assert.equal(a.faladas, 1); assert.equal(a.na_mao, 2);
  assert.equal(a.tarefas_criadas, 2); assert.equal(a.tarefas_feitas, 1); assert.equal(a.atrasados, 1);
  assert.equal(a.pontos, null, "sem pesos, sem pontos");
});
await caso("2. Só o gestor configura; Score, conversão e tempos não recebem peso", async () => {
  r = await A("/reports/score/pontos", { method: "PUT", body: { pesos: { mensagens: 1 } } }); assert.equal(r.status, 403);
  r = await G("/reports/score/pontos", { method: "PUT", body: { pesos: { score: 1 } } }); assert.equal(r.status, 400);
  r = await G("/reports/score/pontos", { method: "PUT", body: { pesos: { resposta_min: 1 } } }); assert.equal(r.status, 400);
});
await caso("3. Pontos = soma de valor × peso, com negativos e tarefas; a origem vem junto", async () => {
  r = await G("/reports/score/pontos", { method: "PUT", body: { pesos: { mensagens: 1, tarefas_feitas: 2, atrasados: -1, faladas: "0" } } }); assert.equal(r.status, 200);
  r = await G("/reports/score?periodo=este_mes");
  const a = r.body.equipe.find(m => m.id === ana);
  assert.equal(a.pontos.total, 2 * 1 + 1 * 2 + 1 * -1);
  assert.deepEqual(a.pontos.partes.map(p => p.indicador).sort(), ["atrasados", "mensagens", "tarefas_feitas"]);
});
await caso("4. Participantes: quem fica de fora não pontua", async () => {
  r = await G("/reports/score/pontos", { method: "PUT", body: { pesos: { mensagens: 1 }, participantes: [bia] } });
  r = await G("/reports/score?periodo=este_mes");
  assert.equal(r.body.equipe.find(m => m.id === ana).pontos, null); assert.ok(r.body.equipe.find(m => m.id === bia).pontos);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nOK — score com os 19 indicadores e pontuação.");
process.exit(falhas ? 1 : 0);
