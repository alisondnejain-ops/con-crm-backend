/* TEMPO PARA PEGAR O LEAD, POR CATRACA (30/10/2026, áudio do Fernando).

   O que este teste protege:
   1. Só o gestor configura; fora da régua é recusado; a lista devolve o tempo.
   2. Ligar o tempo NÃO tira os leads entregues antes (senão a equipe inteira
      perderia a carteira de uma vez).
   3. Lead entregue depois, sem mensagem nem ligação do dono no tempo: vai
      para o próximo disponível da MESMA catraca, sem mudar de etapa.
   4. Quem falou com o cliente (mensagem ou ligação) fica com o lead.
   5. Lead com quem não é membro da catraca fica (foi escolha de alguém).
   6. No máximo N voltas por lead.
   7. Ninguém mais disponível: fica.

   Rodar:  npm run teste:catraca-tempo */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-catraca-tempo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4651";
process.env.PRAZO_AGENDADOR = "0";
process.env.CATRACA_TEMPO_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { agirSemResposta } = await import("../src/services/catraca-tempo.js");
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4651";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "CT-1", Date.now());
db.prepare("UPDATE orgs SET expediente_fim = '' WHERE id = ?").run(org);
garantirPipelinePadrao(org);
const funil = pipelinePadrao(org).id;
const etapa = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id=? AND name='Atendimento'").get(funil).id;

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
let ordem = 0;
const user = (nome, role, available = 1) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,?,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@ct.com", senha, role, available, Date.now() + (ordem++));
  return id; };
user("Gestor", "adm");
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"), bruno = user("Bruno", "corretor");
const fora = user("Fora", "corretor");

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  return (await r.json()).token;
}
const req = (t, metodo, caminho, body) => fetch(BASE + caminho, { method: metodo,
  headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const tGestor = await entrar("gestor@ct.com"), tMarina = await entrar("marina@ct.com");

let r = await req(tGestor, "POST", "/distribution/catracas", { nome: "Aluguel", entrega: "corretor", membros: [marina, rafael, bruno] });
const catId = (await r.json()).id;
assert.ok(catId);

const M = 60000, agora = Date.now();
const lead = (nome, dono, assignedAt) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,pipeline_id,stage_id,assigned_to,assigned_at,
    last_interaction_at,created_at,catraca_id) VALUES (?,?,?,?,'{}','Atendimento',?,?,?,?,?,?,?)`)
    .run(id, org, nome, "5587" + String(990000000 + ordem++), funil, etapa, dono, assignedAt, assignedAt, assignedAt, catId);
  return id; };
const donoDe = (id) => db.prepare("SELECT assigned_to, stage_id, catraca_voltas FROM leads WHERE id=?").get(id);

const antigo = lead("Antigo", marina, agora - 3 * 86400000);

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); }
}

console.log("Tempo para pegar o lead, por catraca");
await caso("1. Só o gestor configura, dentro da régua", async () => {
  r = await req(tMarina, "PATCH", "/distribution/catracas/" + catId, { tempo_resposta_min: 10 });
  assert.equal(r.status, 403);
  r = await req(tGestor, "PATCH", "/distribution/catracas/" + catId, { tempo_resposta_min: 5000 });
  assert.equal(r.status, 400);
  r = await req(tGestor, "PATCH", "/distribution/catracas/" + catId, { max_voltas: 0 });
  assert.equal(r.status, 400);
  r = await req(tGestor, "PATCH", "/distribution/catracas/" + catId, { tempo_resposta_min: 10, max_voltas: 2 });
  assert.equal(r.status, 200, await r.text());
  const lista = await (await req(tGestor, "GET", "/distribution/catracas")).json();
  const c = lista.catracas.find(x => x.id === catId);
  assert.equal(c.tempo_resposta_min, 10); assert.equal(c.max_voltas, 2);
});

// Entregues DEPOIS de ligar o tempo, 20 minutos atrás.
const t0 = Date.now() + 1000;
const semFalar = lead("Sem falar", marina, t0);
const falou = lead("Falou", marina, t0);
const ligou = lead("Ligou", marina, t0);
const comFora = lead("Com quem não é da catraca", fora, t0);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,from_user_id,created_at) VALUES (?,?,?,?,?,?)")
  .run("m_" + randomUUID(), falou, "out", "Oi!", marina, t0 + M);
db.prepare("INSERT INTO ligacoes (id,lead_id,user_id,created_at) VALUES (?,?,?,?)").run("g_" + randomUUID(), ligou, marina, t0 + M);

await caso("2. Ligar o tempo não tira o lead entregue antes", async () => {
  await agirSemResposta(org, t0 + 20 * M);
  assert.equal(donoDe(antigo).assigned_to, marina);
});
await caso("3. Sem falar no tempo: vai para o próximo da catraca, sem mudar de etapa", async () => {
  assert.equal(donoDe(semFalar).assigned_to, rafael);
  assert.equal(donoDe(semFalar).stage_id, etapa);
  assert.equal(donoDe(semFalar).catraca_voltas, 1);
  const tr = db.prepare("SELECT trigger_reason FROM lead_transfers WHERE lead_id=? ORDER BY created_at DESC").get(semFalar);
  assert.equal(tr.trigger_reason, "sem_resposta");
});
await caso("4. Quem mandou mensagem ou ligou fica com o lead", async () => {
  assert.equal(donoDe(falou).assigned_to, marina);
  assert.equal(donoDe(ligou).assigned_to, marina);
});
await caso("5. Lead com quem não é membro da catraca fica", async () => {
  assert.equal(donoDe(comFora).assigned_to, fora);
});
await caso("6. Antes do tempo, nada; depois, mais uma volta; no teto, fica", async () => {
  const chegou = db.prepare("SELECT assigned_at FROM leads WHERE id=?").get(semFalar).assigned_at;
  await agirSemResposta(org, chegou + 5 * M);
  assert.equal(donoDe(semFalar).assigned_to, rafael, "ainda no tempo do Rafael");
  await agirSemResposta(org, chegou + 11 * M);
  assert.notEqual(donoDe(semFalar).assigned_to, rafael);
  assert.equal(donoDe(semFalar).catraca_voltas, 2);
  const dono = donoDe(semFalar).assigned_to;
  const chegou2 = db.prepare("SELECT assigned_at FROM leads WHERE id=?").get(semFalar).assigned_at;
  await agirSemResposta(org, chegou2 + 60 * M);
  assert.equal(donoDe(semFalar).assigned_to, dono, "duas voltas: fica");
});
await caso("7. Ninguém mais disponível: fica", async () => {
  const sozinho = lead("Sozinho", marina, Date.now() + 2000);
  db.prepare("UPDATE users SET available = 0 WHERE id IN (?,?)").run(rafael, bruno);
  await agirSemResposta(org, Date.now() + 60 * M);
  assert.equal(donoDe(sozinho).assigned_to, marina);
});

console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
