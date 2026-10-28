/* TAREFA MARCADA SEGURA O PRAZO DA ETAPA (28/10/2026, pedido do Fernando).

   O que este teste protege:
   1. Lead com tarefa em aberto para o FUTURO não aparece com prazo vencido:
      nem na lista (card do funil e caixa), nem na ficha, nem nos números do
      Painel, do Funil e da Equipe.
   2. Tarefa que JÁ venceu não segura nada — o lead continua vencido, e a
      tarefa vem marcada como atrasada (é o que o filtro "Tarefa vencida" lê).
   3. Marcou a tarefa como feita, o prazo volta a valer.
   4. Lead sem tarefa continua vencido, como sempre.

   Rodar:  npm run teste:tarefa-segura-prazo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-tarefa-segura.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4643";
process.env.PRAZO_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4643";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "TS-1", Date.now());
garantirPipelinePadrao(org);
const funil = pipelinePadrao(org).id;
const etapa = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id=? AND name='Atendimento'").get(funil).id;
db.prepare("UPDATE pipeline_stages SET sla_minutes = 60 WHERE id = ?").run(etapa);

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
let ordem = 0;
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@ts.com", senha, role, Date.now() + (ordem++));
  return id; };
user("Gestor", "adm");
const marina = user("Marina", "corretor");

const H = 3600000, agora = Date.now();
const lead = (nome) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,pipeline_id,stage_id,assigned_to,assigned_at,
    last_interaction_at,created_at) VALUES (?,?,?,?,'{}','Atendimento',?,?,?,?,?,?)`)
    .run(id, org, nome, "5587" + String(990000000 + ordem++), funil, etapa, marina, agora - 2 * H, agora - 2 * H, agora - 2 * H);
  return id; };
const tarefa = (leadId, quando) => { const id = "t_" + randomUUID();
  db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,titulo,quando,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, org, leadId, marina, "Ligar", quando, agora);
  return id; };

const semTarefa = lead("Sem tarefa");
const comFutura = lead("Com tarefa futura");
const tFutura = tarefa(comFutura, agora + 20 * H);
const comAtrasada = lead("Com tarefa atrasada");
tarefa(comAtrasada, agora - H);

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  return (await r.json()).token;
}
const get = async (t, caminho) => { const r = await fetch(BASE + caminho, { headers: { authorization: "Bearer " + t } });
  assert.equal(r.status, 200, caminho + " → " + r.status); return r.json(); };
const tGestor = await entrar("gestor@ts.com"), tMarina = await entrar("marina@ts.com");
const daLista = async (t, id) => (await get(t, "/leads")).find(l => l.id === id);

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + e.message); }
}

console.log("Tarefa marcada segura o prazo da etapa");
await caso("1. Sem tarefa: vencido na lista", async () => {
  const l = await daLista(tMarina, semTarefa);
  assert.equal(l.sla.status, "overdue");
});
await caso("2. Tarefa futura: 'ok' e segura, na lista e na ficha, com os minutos reais", async () => {
  const l = await daLista(tMarina, comFutura);
  assert.equal(l.sla.status, "ok"); assert.equal(l.sla.segura, true);
  assert.ok(l.sla.minutos >= 119, "os minutos continuam os reais");
  assert.equal(l.tarefas.futura, true); assert.equal(l.tarefas.atrasada, false);
  const f = await get(tMarina, "/leads/" + comFutura);
  const sla = f.sla || (f.lead && f.lead.sla);
  assert.equal(sla.status, "ok"); assert.equal(sla.segura, true);
});
await caso("3. Tarefa já vencida não segura: continua vencido, tarefa atrasada", async () => {
  const l = await daLista(tMarina, comAtrasada);
  assert.equal(l.sla.status, "overdue"); assert.ok(!l.sla.segura);
  assert.equal(l.tarefas.atrasada, true); assert.equal(l.tarefas.futura, false);
});
await caso("4. Painel, Funil e Equipe contam 2 vencidos (não 3)", async () => {
  const p = await get(tGestor, "/painel?periodo=mes");
  assert.equal(p.sla.vencidos, 2, "painel");
  const fu = await get(tGestor, "/painel/funil/" + funil);
  const op = fu.operacional.find(e => e.id === etapa);
  assert.equal(op.sla_vencidos, 2, "funil");
  const eq = await get(tGestor, "/painel/equipe?periodo=mes");
  const lista = eq.equipe || eq.pessoas || eq;
  const m = (Array.isArray(lista) ? lista : []).find(x => x.id === marina || x.user_id === marina);
  assert.ok(m, "Marina na equipe");
  const venc = m.sla_vencidos ?? m.vencidos;
  assert.equal(venc, 2, "equipe");
});
await caso("5. Tarefa feita: o prazo volta a valer", async () => {
  const r = await fetch(BASE + "/tarefas/" + tFutura, { method: "PATCH",
    headers: { authorization: "Bearer " + tMarina, "content-type": "application/json" }, body: JSON.stringify({ feito: true }) });
  assert.equal(r.status, 200);
  const l = await daLista(tMarina, comFutura);
  assert.equal(l.sla.status, "overdue"); assert.ok(!l.sla.segura);
});

console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
