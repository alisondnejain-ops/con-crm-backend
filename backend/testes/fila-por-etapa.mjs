/* A FILA PELA PRIMEIRA ETAPA (11/11/2026, services/fila-etapa.js).

   Pedido do Fernando para a VJ, com a decisão do Ali: vale só na conta em
   que o master liga; as outras continuam como estão.

   1. Desligada (o padrão): a fila da Catraca é "lead sem dono", e a etiqueta
      "qualificado" pré-qualifica — a régua de sempre.
   2. Só o master liga; o gestor da conta não.
   3. Ligada: a fila da Catraca é a primeira etapa do funil comercial, sem o
      lead que o corretor já pegou (mensagem ou ligação dele).
   4. Ligada: o SDR vira um resultado só, com os leads que entraram no funil
      de SDR, e a etiqueta não pré-qualifica. Os números somam o "Por
      origem" e cada um traz a lista de leads por trás dele.
   5. Desligar volta tudo como era.

   Rodar:  npm run teste:fila-por-etapa */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-fila-etapa.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4823";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const P = await import("../src/services/pipelines.js");
const { preAtendimento } = await import("../src/services/sdr-funil.js");
const BASE = "http://localhost:4823";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const casa = "org_ch"; const org = "org_fila1";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casa, "Casa do ConHub", "CH-F", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo',1)`).run("u_master", casa, "Ali", "ali@ch.com", senha, Date.now());
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(org, "Imobiliária Sol", "SOL-1", Date.now(), "");
P.garantirPipelinePadrao(org);
const com = P.pipelinePadrao(org);
const sdrP = P.criarDoTemplate(org, "sdr").pipeline;
const etapas = (pid) => db.prepare("SELECT id, name FROM pipeline_stages WHERE pipeline_id = ? AND is_active = 1 ORDER BY ordem").all(pid);
const sdr1 = etapas(sdrP.id)[0], com1 = etapas(com.id)[0], com2 = etapas(com.id)[1];
let ordem = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,available_desde,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@sol.com", senha, role, Date.now(), Date.now() + (++ordem));
  return id; };
pessoa("Gestora", "adm"); const marina = pessoa("Marina", "corretor");

const entrar = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("gestora@sol.com"), tMaster = await entrar("ali@ch.com");

const agora = Date.now(), MIN = 60000;
const lead = (nome, { stage, pipe, dono = null, source = "meta", criado = agora - 60 * MIN }) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,stage_id,pipeline_id,created_at,assigned_to,assigned_at,source)
    VALUES (?,?,?,?,'{}',?,?,?,?,?,?,?)`).run(id, org, nome, "55879988" + String(ordem++).padStart(5, "0"),
    stage.name, stage.id, pipe, criado, dono, dono ? criado : null, source);
  return id; };
const msg = (leadId, dir, quem, quando, nome = null) => db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
  VALUES (?,?,?,?,?,'oi',?)`).run("m_" + randomUUID(), leadId, dir, quem, nome, quando);

// A: chegou no SDR, ninguém falou — aguardando na fila do SDR.
const A = lead("Ana", { stage: sdr1, pipe: sdrP.id });
// B: chegou no SDR, a IA falou, o cliente respondeu; vai ao comercial e à Marina, que não falou ainda.
const B = lead("Bruno", { stage: sdr1, pipe: sdrP.id, source: "whatsapp" });
msg(B, "out", null, agora - 50 * MIN, "Atendimento automático"); msg(B, "in", null, agora - 45 * MIN);
// C: chegou no SDR e ganhou a etiqueta "qualificado" — só pré-qualifica na régua antiga.
const C = lead("Carla", { stage: sdr1, pipe: sdrP.id });
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES ('t_q',?, 'Qualificado SDR', '#0E8F6E', ?)").run(org, agora);
db.prepare("INSERT INTO lead_tags (lead_id,tag_id,org_id,marcada_em) VALUES (?, 't_q', ?, ?)").run(C, org, agora - 20 * MIN);
// D: no NOVO do comercial com a Marina, que já mandou mensagem — pegou.
const D = lead("Davi", { stage: com1, pipe: com.id, dono: marina });
msg(D, "out", marina, agora - 10 * MIN);
// E: sem dono, mas na segunda etapa do comercial — não é fila na régua nova.
const E = lead("Eva", { stage: com2, pipe: com.id });

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }
const ids = (r) => r.d.map(l => l.id).sort();

console.log("Fila pela primeira etapa");
await caso("0. Prepara: Bruno sai do SDR para o comercial e vai à Marina", async () => {
  const r = await chamar(tG, `/leads/${B}/stage`, "PATCH", { stage_id: com1.id });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const t = await chamar(tG, "/distribution/transfer", "POST", { lead_id: B, user_id: marina });
  assert.equal(t.status, 200, JSON.stringify(t.d));
});

await caso("1. Desligada: a régua de sempre (fila = sem dono, etiqueta pré-qualifica)", async () => {
  const q = await chamar(tG, "/leads/queue");
  assert.deepEqual(ids(q), [A, C, E].sort());
  const s = await chamar(tG, "/reports/sdr?periodo=hoje");
  assert.equal(s.status, 200); assert.equal(s.d.consolidado, undefined);
  const pre = preAtendimento(org, agora - 86400000, Date.now());
  assert.ok(pre.qualificados.has(C), "a etiqueta conta na régua antiga");
});

await caso("2. Só o master liga", async () => {
  const g = await chamar(tG, `/orgs/${org}/fila-etapa`, "POST", { ligado: true });
  assert.equal(g.status, 403, JSON.stringify(g.d));
  const m = await chamar(tMaster, `/orgs/${org}/fila-etapa`, "POST", { ligado: true });
  assert.equal(m.status, 200, JSON.stringify(m.d));
  assert.equal(m.d.org.fila_por_etapa, true);
  const me = await chamar(tG, "/auth/me");
  assert.equal(me.d.org.fila_por_etapa, true, "a sessão da conta sabe que a régua está ligada");
});

await caso("3. Ligada: fila da Catraca = NOVO do comercial, sem quem a Marina já pegou", async () => {
  const q = await chamar(tG, "/leads/queue");
  assert.deepEqual(ids(q), [B], JSON.stringify(q.d.map(l => l.name)));
  msg(B, "out", marina, Date.now());
  assert.deepEqual(ids(await chamar(tG, "/leads/queue")), [], "mensagem dela = pegou");
});

await caso("4. Ligada: SDR consolidado, só quem passou pelo funil de SDR", async () => {
  const s = await chamar(tG, "/reports/sdr?periodo=hoje");
  assert.equal(s.status, 200, JSON.stringify(s.d));
  const c = s.d.consolidado;
  assert.ok(c, "vem o consolidado");
  assert.equal(c.chegaram, 3, "Ana, Bruno e Carla — Davi e Eva nunca estiveram no SDR");
  assert.equal(c.aguardando_agora, 2, "Ana e Carla seguem na primeira etapa do SDR");
  assert.equal(c.contatados, 1); assert.equal(c.responderam, 1);
  assert.equal(c.pre_qualificados, 1, "só Bruno: a etiqueta da Carla não conta");
  assert.equal(c.leads.pre_qualificados[0].id, B);
  assert.equal(c.repassados_ao_corretor, 1);
  assert.equal(c.taxa_pre_qualificacao, 33);
  assert.equal(c.por_origem.reduce((n, o) => n + o.chegaram, 0), c.chegaram, "o Por origem soma os cartões");
  assert.equal(c.por_origem.reduce((n, o) => n + o.pre_qualificados, 0), c.pre_qualificados);
  assert.deepEqual(c.leads.aguardando_agora.map(l => l.id).sort(), [A, C].sort());
  assert.equal(c.leads.chegaram.length, 3);
});

await caso("5. Desligar volta tudo como era", async () => {
  const m = await chamar(tMaster, `/orgs/${org}/fila-etapa`, "POST", { ligado: false });
  assert.equal(m.status, 200);
  assert.deepEqual(ids(await chamar(tG, "/leads/queue")), [A, C, E].sort());
  const s = await chamar(tG, "/reports/sdr?periodo=hoje");
  assert.equal(s.d.consolidado, undefined);
});

console.log(falhas ? `\n${falhas} falha(s)` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
