/* PRAZO DA ETAPA VENCIDO, COM CONSEQUÊNCIA (28/10/2026).

   O que este teste protege:
   1. Sem escolha do gestor, nada muda de mão (o padrão é só marcar).
   2. Só o gestor configura; valor fora da régua é recusado; autônomo não tem.
   3. "Próximo corretor": o lead vencido vai para o próximo DISPONÍVEL que não
      é o dono — e não muda de etapa nem de funil.
   4. Recém-repassado não chega vencido: o relógio conta também da chegada.
   5. No máximo N repasses seguidos sem conversa; a conversa zera a contagem.
   6. Ficam de fora: tarefa marcada para o futuro, lead da atendente,
      finalizado, prazo ainda correndo.
   7. "Atendente": volta para a atendente ativa; sem nenhuma ativa, fica.

   Rodar:  npm run teste:prazo-vencido
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-prazo-vencido.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4641";
process.env.PRAZO_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { agirNosVencidos } = await import("../src/services/prazo-vencido.js");
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4641";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "PV-1", Date.now());
// Sem o corte das 18h: o teste roda a qualquer hora e a disponibilidade não pode cair no meio.
db.prepare("UPDATE orgs SET expediente_fim = '' WHERE id = ?").run(org);
garantirPipelinePadrao(org);
const funil = pipelinePadrao(org).id;
const etapa = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id=? AND name='Atendimento'").get(funil).id;
db.prepare("UPDATE pipeline_stages SET sla_minutes = 60 WHERE id = ?").run(etapa);

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
let ordem = 0;
const user = (nome, role, available = 1, o = org) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,?,?,'ativo')`).run(id, o, nome, nome.toLowerCase() + "@pv.com", senha, role, available, Date.now() + (ordem++));
  return id; };
const gestor = user("Gestor", "adm"), vanessa = user("Vanessa", "sdr", 1);
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"), bruno = user("Bruno", "corretor", 0);

const H = 3600000, agora = Date.now();
const lead = (nome, dono, interacao, extra = {}) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,pipeline_id,stage_id,assigned_to,assigned_at,
    last_interaction_at,created_at,closed_at) VALUES (?,?,?,?,'{}','Atendimento',?,?,?,?,?,?,?)`)
    .run(id, org, nome, "5587" + String(990000000 + ordem++), funil, etapa, dono, interacao, interacao, interacao, extra.closed_at || null);
  return id; };
const donoDe = (id) => db.prepare("SELECT assigned_to, stage_id, pipeline_id, prazo_repasses FROM leads WHERE id=?").get(id);

const vencido = lead("Vencido", marina, agora - 2 * H);
const correndo = lead("Correndo", marina, agora - 10 * 60000);
const comTarefa = lead("Com tarefa", marina, agora - 2 * H);
db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,titulo,quando,created_at) VALUES (?,?,?,?,?,?,?)")
  .run("t1", org, comTarefa, marina, "Ligar amanhã", agora + 20 * H, agora);
const daAtendente = lead("Da atendente", vanessa, agora - 2 * H);
const finalizado = lead("Finalizado", marina, agora - 2 * H, { closed_at: agora - H });

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  return (await r.json()).token;
}
const req = (t, metodo, caminho, body) => fetch(BASE + caminho, { method: metodo,
  headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const tGestor = await entrar("gestor@pv.com"), tMarina = await entrar("marina@pv.com");

console.log("1. Sem escolha do gestor, nada muda de mão");
let r = await req(tGestor, "GET", "/distribution/prazo"); let d = await r.json();
console.log(`   ${JSON.stringify(d)}`);
assert.equal(d.acao, "marcar"); assert.equal(d.max_repasses, 2); assert.equal(d.etapas_com_prazo, 1);
assert.deepEqual(await agirNosVencidos(org, agora), []);
assert.equal(donoDe(vencido).assigned_to, marina);

console.log("2. Só o gestor configura, e dentro da régua");
r = await req(tMarina, "PATCH", "/distribution/prazo", { acao: "proximo_corretor" });
assert.equal(r.status, 403, "corretor não configura");
r = await req(tGestor, "PATCH", "/distribution/prazo", { acao: "sortear" });
assert.equal(r.status, 400);
r = await req(tGestor, "PATCH", "/distribution/prazo", { acao: "proximo_corretor", max_repasses: 0 });
assert.equal(r.status, 400);
r = await req(tGestor, "PATCH", "/distribution/prazo", { acao: "proximo_corretor", max_repasses: 2 });
assert.equal(r.status, 200);

console.log("3. Vencido vai para o próximo disponível que não é o dono, sem mudar de etapa");
let feitos = await agirNosVencidos(org, agora);
console.log(`   ${feitos.length} repasse(s)`);
assert.equal(feitos.length, 1, "só o vencido de corretor, sem tarefa futura e não finalizado");
assert.equal(donoDe(vencido).assigned_to, rafael, "Bruno está indisponível; Marina é a dona");
assert.equal(donoDe(vencido).stage_id, etapa); assert.equal(donoDe(vencido).pipeline_id, funil);
const tr = db.prepare("SELECT trigger_reason, from_user_id, to_user_id FROM lead_transfers WHERE lead_id=?").get(vencido);
assert.equal(tr.trigger_reason, "prazo_vencido");
assert.equal(donoDe(correndo).assigned_to, marina);
assert.equal(donoDe(comTarefa).assigned_to, marina, "tarefa futura segura o lead");
assert.equal(donoDe(daAtendente).assigned_to, vanessa, "lead da atendente fica");
assert.equal(donoDe(finalizado).assigned_to, marina, "finalizado fica");

console.log("4. Recém-repassado não chega vencido");
feitos = await agirNosVencidos(org, agora + 60000);
assert.equal(feitos.length, 0);

console.log("5. No máximo 2 repasses seguidos sem conversa");
feitos = await agirNosVencidos(org, agora + 2 * H);
assert.equal(donoDe(vencido).assigned_to, marina, "volta à Marina, a próxima disponível");
assert.equal(donoDe(vencido).prazo_repasses, 2);
feitos = await agirNosVencidos(org, agora + 4 * H);
assert.equal(donoDe(vencido).assigned_to, marina, "chegou ao teto: fica");

console.log("5b. A conversa voltou a acontecer: a contagem zera");
db.prepare("UPDATE leads SET last_interaction_at = ? WHERE id = ?").run(agora + 4 * H + 1000, vencido);
feitos = await agirNosVencidos(org, agora + 6 * H);
assert.equal(donoDe(vencido).assigned_to, rafael);
assert.equal(donoDe(vencido).prazo_repasses, 1);

console.log("6. 'Atendente': volta para a atendente ativa — e sem nenhuma ativa, fica");
await req(tGestor, "PATCH", "/distribution/prazo", { acao: "atendente" });
const paraAtendente = lead("Para atendente", marina, agora - 2 * H);
db.prepare("UPDATE users SET available = 0 WHERE id = ?").run(vanessa);
await agirNosVencidos(org, agora);
assert.equal(donoDe(paraAtendente).assigned_to, marina, "nenhuma atendente ativa");
db.prepare("UPDATE users SET available = 1 WHERE id = ?").run(vanessa);
await agirNosVencidos(org, agora);
assert.equal(donoDe(paraAtendente).assigned_to, vanessa);
assert.equal(donoDe(paraAtendente).stage_id, etapa, "não muda de etapa");

console.log("7. Conta de autônomo não tem para onde mandar");
const orgA = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo) VALUES (?,?,?,?,'autonomo')").run(orgA, "Solo", "PV-2", Date.now());
const dono = user("Solo", "corretor", 1, orgA);
db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(dono, orgA);
const tSolo = await entrar("solo@pv.com");
r = await req(tSolo, "PATCH", "/distribution/prazo", { acao: "proximo_corretor" });
console.log(`   ${r.status}`);
assert.equal(r.status, 400);

console.log("\nTudo certo ✅");
process.exit(0);
