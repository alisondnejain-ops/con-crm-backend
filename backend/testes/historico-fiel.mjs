/* O RELATÓRIO TEM QUE FICAR FIEL AO QUE ACONTECEU — mesmo depois que o lead
   muda de mão de novo. (19/09/2026, pedido do Ali, na sequência do conserto
   de "recebidos"/"vendas" do dia anterior:

     "se eu transferir um lead de um corretor para o outro, ele não pode sair
      do relatório do antigo, porque ele teve um atendimento feito por aquele
      antigo... tem que ser mantido os relatórios de maneira fiel a tudo que
      foi feito. Inclusive, acrescentar a quantidade de leads que foram
      perdidos pelo corretor anterior... isso gera uma penalidade... Se
      atualiza no Kanban uma venda, ela não entra no relatório. Se é
      transferido cinco leads para o corretor, identifica que só foi
      transferido um."

   Este teste cobre as quatro coisas que ele pediu, uma de cada vez:

   1. "recebidos" de um período JÁ FECHADO não muda quando o lead é repassado
      de novo depois — hoje ele lê `lead_transfers` (o REGISTRO de cada troca
      de dono), não `leads.assigned_to` (o dono de AGORA).
   2. "leads perdidos para outro corretor" — penalidade nova, só conta
      repasse MANUAL (motivo "mao"), não a redistribuição automática de uma
      etapa nem a saída de alguém da equipe.
   3. Arrastar um card para uma etapa "ganho" (ex.: "Venda") sem valor de
      venda é RECUSADO — antes o Kanban dizia uma coisa e o relatório de
      dinheiro dizia outra.
   4. A atendente que repassou 5 leads aparece com 5 repassados, mesmo que
      algum deles tenha voltado para a fila depois (undercount que gerava
      "transferi 5, o sistema mostra 1").

   Rodar:  npm run teste:historico-fiel
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-historico-fiel.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4646";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { trocarResponsavel } = await import("../src/services/movimento.js");
const { garantirPipelinePadrao } = await import("../src/services/pipelines.js");
await import("../src/server.js");
const BASE = "http://localhost:4646";
await new Promise(r => setTimeout(r, 700));

const DIA = 86400000;
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "HF-1", Date.now());
// Esta org nasceu depois do bootstrap do servidor — precisa do próprio funil
// (é o que faz "Venda" resolver para a etapa `status_type='ganho'` de verdade,
// e não cair no caminho sem pipeline nenhum, que pula a checagem de campos).
garantirPipelinePadrao(org);
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const criarUser = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@hf.com", senha, role, Date.now()); return id; };
const gestor = criarUser("Fernanda", "adm");
const camila = criarUser("Camila", "sdr");
const marina = criarUser("Marina", "corretor");
const rafael = criarUser("Rafael", "corretor");

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const { token } = await r.json();
  assert.ok(token, "login falhou para " + email);
  return token;
};
const tokenGestor = await login("fernanda@hf.com");
const auth = { authorization: "Bearer " + tokenGestor };

const diaStr = (msAtras) => { const d = new Date(Date.now() - msAtras); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const hojeStr = diaStr(0);
const ontemStr = diaStr(DIA);

console.log("===== 1. HISTÓRICO FIEL: repasse de ONTEM continua no relatório de ONTEM =====");
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Atendimento',?,?)`)
  .run(leadId, org, "Cliente Histórico", "5587900000020", camila, Date.now() - 5 * DIA);

console.log("1a. Ontem, Camila repassa o lead para a Marina");
let lead = db.prepare("SELECT * FROM leads WHERE id=?").get(leadId);
const ontemTs = Date.now() - DIA;
// Simula o repasse acontecendo ONTEM: troca de responsável de verdade (grava
// a linha em lead_transfers) e depois recua o relógio da linha gravada, para
// não depender de esperar um dia real passar dentro do teste.
trocarResponsavel(lead, marina, gestor, "mao");
db.prepare("UPDATE lead_transfers SET created_at=? WHERE lead_id=? AND to_user_id=?").run(ontemTs, leadId, marina);
db.prepare("UPDATE leads SET assigned_at=? WHERE id=?").run(ontemTs, leadId);

let resp = await fetch(`${BASE}/reports?de=${ontemStr}&ate=${ontemStr}`, { headers: auth });
let d = await resp.json();
let marinaOntem = d.atendentes.find(a => a.id === marina);
console.log(`   recebidos de Marina ontem: ${marinaOntem.recebidos} (esperado: 1)`);
assert.equal(marinaOntem.recebidos, 1);

console.log("1b. Hoje, Marina repassa o MESMO lead para o Rafael");
lead = db.prepare("SELECT * FROM leads WHERE id=?").get(leadId);
trocarResponsavel(lead, rafael, gestor, "mao");

console.log("1c. O relatório de ONTEM continua mostrando Marina com 1 recebido — não muda para 0");
resp = await fetch(`${BASE}/reports?de=${ontemStr}&ate=${ontemStr}`, { headers: auth });
d = await resp.json();
marinaOntem = d.atendentes.find(a => a.id === marina);
console.log(`   recebidos de Marina ontem (depois do repasse de hoje): ${marinaOntem.recebidos} (esperado: 1 — fiel ao que aconteceu)`);
assert.equal(marinaOntem.recebidos, 1, "o relatório de um período já fechado não pode mudar quando o lead é repassado de novo depois");

console.log("1d. E o relatório de HOJE mostra Rafael com 1 recebido, e Marina com 1 PERDIDO");
resp = await fetch(`${BASE}/reports?de=${hojeStr}&ate=${hojeStr}`, { headers: auth });
d = await resp.json();
const rafaelHoje = d.atendentes.find(a => a.id === rafael);
const marinaHoje = d.atendentes.find(a => a.id === marina);
console.log(`   recebidos de Rafael hoje: ${rafaelHoje.recebidos} · leads_perdidos_para_outro de Marina hoje: ${marinaHoje.leads_perdidos_para_outro}`);
assert.equal(rafaelHoje.recebidos, 1);
assert.equal(marinaHoje.leads_perdidos_para_outro, 1, "Marina perdeu o lead para o Rafael por repasse manual — conta como penalidade");

console.log("\n===== 2. A PENALIDADE SÓ CONTA REPASSE MANUAL =====");
const leadAuto = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)`)
  .run(leadAuto, org, "Cliente Automático", "5587900000021", "Atendimento", marina, Date.now());
trocarResponsavel(db.prepare("SELECT * FROM leads WHERE id=?").get(leadAuto), rafael, null, "automatica");

resp = await fetch(`${BASE}/reports?de=${hojeStr}&ate=${hojeStr}`, { headers: auth });
d = await resp.json();
const marinaDepoisDoAutomatico = d.atendentes.find(a => a.id === marina);
console.log(`   leads_perdidos_para_outro de Marina, com 1 manual + 1 automático: ${marinaDepoisDoAutomatico.leads_perdidos_para_outro} (esperado: 1 — o automático não penaliza)`);
assert.equal(marinaDepoisDoAutomatico.leads_perdidos_para_outro, 1, "redistribuição automática de etapa não é desempenho da pessoa — não pode contar como penalidade");

console.log("\n===== 3. KANBAN → \"VENDA\" SEM VALOR É RECUSADO =====");
const tokenMarina = await login("marina@hf.com");
const authMarina = { authorization: "Bearer " + tokenMarina, "content-type": "application/json" };
const leadVenda = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)`)
  .run(leadVenda, org, "Cliente Proposta", "5587900000022", "Proposta", marina, Date.now());

resp = await fetch(`${BASE}/leads/${leadVenda}/stage`, { method: "PATCH", headers: authMarina, body: JSON.stringify({ stage: "Venda" }) });
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 422, "mover para uma etapa \"ganho\" sem valor de venda tem que ser recusado, do mesmo jeito que qualquer campo obrigatório faltando");
assert.ok(d.bloqueado && d.faltam && d.faltam.some(f => f.key === "sale_value"), "a lista do que falta aponta o valor da venda");
const aindaEmProposta = db.prepare("SELECT stage FROM leads WHERE id=?").get(leadVenda);
assert.equal(aindaEmProposta.stage, "Proposta", "o card não pode ter ido para a coluna Venda sem o valor");

console.log("3b. Registrando a venda de verdade, o lead vai para Venda e entra no relatório");
resp = await fetch(`${BASE}/leads/${leadVenda}/venda`, { method: "PATCH", headers: authMarina,
  body: JSON.stringify({ valor: "410000", data: hojeStr, imovel: "Casa 12" }) });
assert.equal(resp.status, 200);
resp = await fetch(`${BASE}/reports?de=${hojeStr}&ate=${hojeStr}`, { headers: auth });
d = await resp.json();
const marinaComVenda = d.atendentes.find(a => a.id === marina);
console.log(`   vendas de Marina hoje: ${marinaComVenda.vendas} (esperado: 1)`);
assert.equal(marinaComVenda.vendas, 1);

console.log("\n===== 4. \"TRANSFERI 5, O SISTEMA MOSTRA 1\" — REPASSE DA ATENDENTE COBRE OS 5 =====");
const leadsDaCamila = [];
for (let i = 0; i < 5; i++) {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at)
    VALUES (?,?,?,?,'Atendimento',?,?)`).run(id, org, "Lead da Camila " + i, "55879000003" + i, camila, Date.now());
  leadsDaCamila.push(id);
}
// Camila faz o primeiro contato nos 5.
for (const id of leadsDaCamila)
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at)
    VALUES (?,?,?,?,?,?)`).run("m_" + randomUUID(), id, "out", camila, "Oi! Vou te ajudar.", Date.now());
// Repassa os 5: 4 para corretores, e o 5º volta para a fila (sem dono) —
// exatamente o caso que a conta antiga perdia.
for (const id of leadsDaCamila.slice(0, 2)) trocarResponsavel(db.prepare("SELECT * FROM leads WHERE id=?").get(id), marina, camila, "mao");
for (const id of leadsDaCamila.slice(2, 4)) trocarResponsavel(db.prepare("SELECT * FROM leads WHERE id=?").get(id), rafael, camila, "mao");
const leadQueVoltouPraFila = leadsDaCamila[4];
trocarResponsavel(db.prepare("SELECT * FROM leads WHERE id=?").get(leadQueVoltouPraFila), marina, camila, "mao");
trocarResponsavel(db.prepare("SELECT * FROM leads WHERE id=?").get(leadQueVoltouPraFila), null, gestor, "mao"); // devolvido à fila

resp = await fetch(`${BASE}/reports?de=${hojeStr}&ate=${hojeStr}`, { headers: auth });
d = await resp.json();
const camilaHoje = d.atendimento.find(a => a.id === camila);
console.log(`   repassados pela Camila hoje: ${camilaHoje.repassados} (esperado: 5 — inclusive o que voltou para a fila)`);
assert.equal(camilaHoje.repassados, 5, "os 5 repasses aconteceram no período, mesmo um deles tendo voltado para a fila depois");

console.log("\nTudo certo ✅");
process.exit(0);
