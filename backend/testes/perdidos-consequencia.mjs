/* PERDIDOS POR CONSEQUÊNCIA E A ORDEM DOS CARTÕES (25/11/2026).
   Perdidos por consequência = Recebidos − Atendidos, a mesma régua no
   relatório da pessoa, no Score e na Visão geral; "Perdidos" (etapa de perda)
   continua igual. A ordem dos cartões é uma por imobiliária e só o gestor grava.
   Rodar:  npm run teste:perdidos-consequencia */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-perdidos-consequencia.db");
process.env.JWT_SECRET = "teste"; process.env.PORT = "4667";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4667";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imob PC", "PC-1", Date.now());
const novo = (nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, email, senha, role, Date.now()); return id; };
novo("Gestora", "g@pc.com", "adm"); const ana = novo("Ana", "a@pc.com", "corretor"); const bia = novo("Bia", "b@pc.com", "corretor");
const login = async (e) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "123456" }) })).json()).token;
const cli = (t) => (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const G = cli(await login("g@pc.com")), A = cli(await login("a@pc.com"));
const agora = Date.now();
const lead = (dono) => { const id = "l_" + randomUUID(); db.prepare("INSERT INTO leads (id,org_id,name,phone,assigned_to,stage,created_at,assigned_at) VALUES (?,?,?,?,?,?,?,?)").run(id, org, "C", "5587" + Math.floor(Math.random() * 1e9), dono, "Lead", agora - 5 * 3600e3, agora - 5 * 3600e3); return id; };
const msg = (L, dir, autor, t, nome = null) => db.prepare("INSERT INTO messages (id,lead_id,direction,body,from_user_id,from_name,created_at) VALUES (?,?,?,?,?,?,?)").run("m_" + randomUUID(), L, dir, "oi", autor, nome, t);
// Ana recebe 4: L1 ela escreve; L2 ninguém; L3 ninguém e vai para a Bia na mão;
// L4 só a automação escreve (não é atendimento).
const L1 = lead(ana), L2 = lead(ana), L3 = lead(ana), L4 = lead(ana);
msg(L1, "out", ana, agora - 4 * 3600e3);
msg(L4, "out", null, agora - 4 * 3600e3, "Automação · Boas-vindas");
db.prepare("UPDATE leads SET assigned_to=?, assigned_at=? WHERE id=?").run(bia, agora - 3 * 3600e3, L3);
db.prepare("INSERT INTO lead_transfers (id,org_id,lead_id,from_user_id,to_user_id,trigger_reason,created_at) VALUES (?,?,?,?,?,?,?)").run("t_" + randomUUID(), org, L3, ana, bia, "mao", agora - 3 * 3600e3);

let falhas = 0;
const caso = async (n, f) => { try { await f(); console.log("  ✓ " + n); } catch (e) { falhas++; console.log("  ✗ " + n + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } };
let r;
await caso("1. Relatório da pessoa: perdidos por consequência = recebidos − atendidos, e quantos já saíram", async () => {
  r = await G("/reports");
  const a = r.body.atendentes.find(x => x.id === ana);
  // Recebidos = os que ESTÃO com ela (regra do Kanban, 25/11/2026): L3 foi para a Bia.
  // Perdidos por consequência continua olhando quem passou por ela: L2, L3 e L4.
  // Relatório individual: Recebidos = TODAS as oportunidades (3 com ela + L3, que passou e saiu).
  assert.equal(a.recebidos, 4); assert.equal(a.atendidos, 1);
  assert.equal(a.perdidos_consequencia, 3); assert.equal(a.perdidos_consequencia_saiu, 1);
  assert.equal(a.perdidos, 0, "Perdidos (etapa de perda) continua separado");
});
await caso("2. Score traz a mesma conta e a coluna nova", async () => {
  r = await G("/reports/score?periodo=90dias");
  assert.ok(r.body.indicadores.some(i => i.chave === "perdidos_consequencia" && i.pontuavel));
  const a = r.body.equipe.find(x => x.id === ana);
  assert.equal(a.perdidos_consequencia, 3);
});
await caso("3. Visão geral: com a pessoa no filtro, o mesmo número; para a casa, mensagem de qualquer um da equipe", async () => {
  r = await G(`/painel?periodo=90dias&responsavel=${ana}`);
  assert.equal(r.body.atendimento.atendidos, 1); assert.equal(r.body.atendimento.recebidos, 3);
  msg(L3, "out", bia, agora - 2 * 3600e3); // a Bia atendeu o L3: para a casa ele foi atendido
  r = await G("/painel?periodo=90dias");
  assert.equal(r.body.atendimento.recebidos, 4);
  assert.equal(r.body.atendimento.atendidos, 2); assert.equal(r.body.atendimento.perdidos_consequencia, 2);
});
await caso("4. Ordem dos cartões: padrão, só o gestor grava, vale para todos, volta ao padrão", async () => {
  r = await A("/reports/cartoes"); assert.equal(r.status, 200);
  assert.equal(r.body.pessoa.ordem[2], "perdidos_consequencia"); assert.equal(r.body.pessoa.personalizado, false);
  r = await A("/reports/cartoes", { method: "PUT", body: { pessoa: ["vendas"] } }); assert.equal(r.status, 403);
  r = await G("/reports/cartoes", { method: "PUT", body: { pessoa: ["atendidos", "recebidos", "xyz", "atendidos"] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.pessoa.ordem, ["atendidos", "recebidos"]);
  r = await A("/reports/cartoes"); assert.deepEqual(r.body.pessoa.ordem, ["atendidos", "recebidos"]);
  r = await G("/reports/cartoes", { method: "PUT", body: { visao: ["qualificados", "recebidos"] } });
  assert.deepEqual(r.body.pessoa.ordem, ["atendidos", "recebidos"], "gravar a visão não apaga a da pessoa");
  r = await G("/reports/cartoes", { method: "PUT", body: { pessoa: [] } }); assert.equal(r.status, 400);
  r = await G("/reports/cartoes", { method: "PUT", body: { pessoa: null } });
  assert.equal(r.body.pessoa.personalizado, false); assert.deepEqual(r.body.visao.ordem, ["qualificados", "recebidos"]);
});
await caso("5. Ligação conta só quando ela FALOU com o cliente", async () => {
  const lig = (L, res) => db.prepare("INSERT INTO ligacoes (id,lead_id,user_id,created_at,resultado) VALUES (?,?,?,?,?)").run("g_" + randomUUID(), L, ana, agora - 3600e3, res);
  lig(L4, "nao_atendeu");
  r = await G("/reports"); let a = r.body.atendentes.find(x => x.id === ana);
  assert.equal(a.atendidos, 1, "não atendeu não é atendimento"); assert.equal(a.perdidos_consequencia, 3);
  lig(L2, "falou");
  r = await G("/reports"); a = r.body.atendentes.find(x => x.id === ana);
  assert.equal(a.atendidos, 2); assert.equal(a.perdidos_consequencia, 2);
  r = await G("/reports/score?periodo=90dias"); assert.equal(r.body.equipe.find(x => x.id === ana).perdidos_consequencia, 2);
  r = await G(`/painel?periodo=90dias&responsavel=${ana}`); assert.equal(r.body.atendimento.atendidos, 2);
  r = await G("/painel?periodo=90dias"); assert.equal(r.body.atendimento.atendidos, 3);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nOK — perdidos por consequência e ordem dos cartões.");
process.exit(falhas ? 1 : 0);
