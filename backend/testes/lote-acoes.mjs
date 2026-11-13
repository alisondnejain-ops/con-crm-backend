/* AÇÕES EM LOTE NA BASE DE LEADS (CETRO 22.2, 13/11/2026).
   Rodar:  npm run teste:lote-acoes */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-lote-acoes.db");
process.env.JWT_SECRET = "teste"; process.env.PORT = "4667";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0"; process.env.AGENDADAS_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4667";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imob LA", "LA-1", Date.now());
const novo = (nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, email, senha, role, Date.now()); return id; };
novo("Gestora", "g@la.com", "adm"); const ana = novo("Ana", "a@la.com", "corretor"); const bia = novo("Bia", "b@la.com", "corretor");
const { garantirPipelinePadrao, criarPipeline } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);
const pCom = db.prepare("SELECT id FROM pipelines WHERE org_id=? LIMIT 1").get(org).id;
const etC = db.prepare("SELECT id,name FROM pipeline_stages WHERE pipeline_id=? ORDER BY ordem").all(pCom);
const pLoc = "p_" + randomUUID();
db.prepare("INSERT INTO pipelines (id,org_id,name,type,is_active,is_default,created_at) VALUES (?,?,?,?,1,0,?)").run(pLoc, org, "Locação", "custom", Date.now());
const etL = ["Lead", "Visita", "Contrato"].map((n, i) => { const id = "s_" + randomUUID();
  db.prepare("INSERT INTO pipeline_stages (id,org_id,pipeline_id,name,ordem,is_active,created_at) VALUES (?,?,?,?,?,1,?)").run(id, org, pLoc, n, i, Date.now()); return { id, name: n }; });
const login = async (e) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "123456" }) })).json()).token;
const cli = (t) => (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const G = cli(await login("g@la.com")), A = cli(await login("a@la.com"));
const lead = (dono, etapa, venda = null) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,assigned_to,pipeline_id,stage_id,stage,created_at,assigned_at,sale_date,sale_value) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, org, "C " + id.slice(-4), "5587" + Math.floor(Math.random() * 1e9), dono, pCom, etapa.id, etapa.name, Date.now(), Date.now(), venda, venda ? 1000 : null); return id; };
const L1 = lead(ana, etC[0]), L2 = lead(ana, etC[1]), L3 = lead(ana, etC[0], Date.now());
let falhas = 0;
const caso = async (n, f) => { try { await f(); console.log("  ✓ " + n); } catch (e) { falhas++; console.log("  ✗ " + n + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } };
const ids = [L1, L2, L3];
let r;
await caso("1. Só o gestor; e é preciso escolher algo para mudar", async () => {
  r = await A("/leads/lote/acao/previa", { method: "POST", body: { ids, responsavel: { acao: "pessoa", user_id: bia } } }); assert.equal(r.status, 403);
  r = await G("/leads/lote/acao/previa", { method: "POST", body: { ids } }); assert.equal(r.status, 400);
});
await caso("2. Transferir A→B preservando funil e etapa; venda registrada fica de fora; mensagem agendada do dono antigo cancelada", async () => {
  db.prepare("INSERT INTO mensagens_agendadas (id,org_id,lead_id,user_id,texto,quando,status,created_at) VALUES (?,?,?,?,?,?,?,?)").run("ag_" + randomUUID(), org, L1, ana, "oi", Date.now() + 9e6, "pendente", Date.now());
  r = await G("/leads/lote/acao/previa", { method: "POST", body: { ids, responsavel: { acao: "pessoa", user_id: bia } } });
  assert.equal(r.status, 200); assert.equal(r.body.mudam, 2); assert.equal(r.body.fora.length, 1); assert.match(r.body.consequencias.join(" "), /agendada/);
  const ass = r.body.assinatura;
  r = await G("/leads/lote/acao", { method: "POST", body: { ids, responsavel: { acao: "pessoa", user_id: bia }, assinatura: "x" } }); assert.equal(r.status, 409);
  r = await G("/leads/lote/acao", { method: "POST", body: { ids, responsavel: { acao: "pessoa", user_id: bia }, assinatura: ass } });
  assert.equal(r.status, 200); assert.equal(r.body.donos, 2);
  const l1 = db.prepare("SELECT assigned_to, stage_id, pipeline_id FROM leads WHERE id=?").get(L1);
  assert.equal(l1.assigned_to, bia); assert.equal(l1.stage_id, etC[0].id); assert.equal(l1.pipeline_id, pCom);
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id=?").get(L3).assigned_to, ana, "a vendida não muda");
  assert.equal(db.prepare("SELECT status FROM mensagens_agendadas WHERE lead_id=?").get(L1).status, "cancelada");
});
await caso("3. Mover etapa mantendo o corretor", async () => {
  const b = { ids: [L1], etapa: { acao: "etapa", stage_id: etC[2].id } };
  r = await G("/leads/lote/acao/previa", { method: "POST", body: b });
  r = await G("/leads/lote/acao", { method: "POST", body: { ...b, assinatura: r.body.assinatura } });
  const l = db.prepare("SELECT assigned_to, stage_id FROM leads WHERE id=?").get(L1); assert.equal(l.stage_id, etC[2].id); assert.equal(l.assigned_to, bia);
});
await caso("4. Mover para outro funil: etapa sem equivalente exige mapeamento; o mesmo nome casa sozinho", async () => {
  const b = { ids: [L1, L2], funil: { acao: "mover", pipeline_id: pLoc } };
  r = await G("/leads/lote/acao/previa", { method: "POST", body: b });
  assert.equal(r.body.pode_aplicar, false); assert.ok(r.body.faltam_mapear.length >= 1);
  r = await G("/leads/lote/acao", { method: "POST", body: { ...b, assinatura: r.body.assinatura } }); assert.equal(r.status, 400);
  const mapa = Object.fromEntries(r.body ? [] : []);
  const pv = (await G("/leads/lote/acao/previa", { method: "POST", body: b })).body;
  const m = Object.fromEntries(pv.faltam_mapear.map(f => [f.origem, etL[1].id]));
  const b2 = { ids: [L1, L2], funil: { acao: "mover", pipeline_id: pLoc, mapa: m } };
  r = await G("/leads/lote/acao/previa", { method: "POST", body: b2 }); assert.equal(r.body.pode_aplicar, true);
  r = await G("/leads/lote/acao", { method: "POST", body: { ...b2, assinatura: r.body.assinatura } }); assert.equal(r.status, 200);
  for (const id of [L1, L2]) assert.equal(db.prepare("SELECT pipeline_id FROM leads WHERE id=?").get(id).pipeline_id, pLoc);
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id=?").get(L2).assigned_to, bia, "o corretor fica");
});
await caso("5. Etapa de outro funil sem mover o funil é recusada com a frase", async () => {
  r = await G("/leads/lote/acao/previa", { method: "POST", body: { ids: [L1], etapa: { acao: "etapa", stage_id: etC[0].id } } });
  assert.equal(r.status, 400); assert.match(r.body.error, /outro funil/);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nOK — ações em lote.");
process.exit(falhas ? 1 : 0);
