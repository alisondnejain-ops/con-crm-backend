/* OS NÚMEROS DO FERNANDO (07/11/2026).

   1. Recebidos: o lead que nasce na FILA e é repassado conta UMA vez para
      quem recebeu (antes contava duas: o dono de hoje virava "dono de
      nascença"); lead da linha pessoal e carteira passada em lote não contam;
      Relatórios = Equipe = Painel.
   2. Marcos com a etapa pulada contando: Novo → Agendamento conta qualificado
      e agendado; depois Visita conta só a visita.
   3. Leads trabalhados e pessoas faladas: um por lead por dia.
   4. Pré-atendimento: lead que entra no funil de SDR e passa para o
      comercial conta como recebido, qualificado e repassado na linha da fila.
   5. Funil de conversão comercial: etapa pulada conta como passada.
   6. 1ª resposta do corretor: só o lead recebido numa etapa de entrada do
      comercial.

   Rodar: npm run teste:numeros-fernando */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-numeros-fernando.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4811";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4811";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa NF", "NF-1", Date.now());
const { criarPipeline, inserirEtapa, criarDoTemplate } = await import("../src/services/pipelines.js");
const { trocarResponsavel } = await import("../src/services/movimento.js");

const bx = criarPipeline(org, { name: "Braço externo", type: "commercial", is_default: true }).pipeline || null;
const bxId = bx ? bx.id : db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND name = 'Braço externo'").get(org).id;
const E = {};
["Novo", "Lead", "Atendimento frio", "Atendimento qualificado", "Agendamento", "Visita", "Proposta", "Venda", "Perdido"].forEach((n, i) => {
  E[n] = inserirEtapa(org, bxId, { name: n, status_type: n === "Venda" ? "ganho" : n === "Perdido" ? "perdido" : "aberto",
    counts_as_conversion: ["Novo", "Atendimento qualificado", "Agendamento", "Visita", "Proposta", "Venda"].includes(n),
    entrada_comercial: n === "Novo" }, i);
});
const sdr = criarDoTemplate(org, "sdr");
const sdrId = (sdr.pipeline || sdr).id || db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND type = 'sdr'").get(org).id;
const sdrNovo = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id = ? ORDER BY ordem LIMIT 1").get(sdrId).id;

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@nf.com", senha, role, Date.now());
  return id; };
const ali = user("Ali", "adm"), blanca = user("Blanca", "corretor"), ezequiel = user("Ezequiel", "corretor");

const agora = Date.now();
const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
const t = (minDoDia) => hoje0.getTime() + minDoDia * 60000;   // horário de hoje
let n = 0;
const lead = ({ dono = null, etapa, pipe, quando = t(60), source = null, extra = {} }) => {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,stage_id,pipeline_id,assigned_to,assigned_at,created_at,source,import_id,canal_id)
    VALUES (?,?,?,?,'WhatsApp','{}',?,?,?,?,?,?,?,?,?)`).run(id, org, "Cliente " + (++n), "5587990" + String(100000 + n),
    "x", etapa, pipe, dono, dono ? quando : null, quando, source, extra.import_id || null, extra.canal_id || null);
  return id; };
const mover = (leadId, de, para, quando, userId) => {
  db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,de_stage_id,para_stage_id,motivo,user_id,created_at,etapa_fonte)
    VALUES (?,?,?,?,?,?,?,'mao',?,?,'id')`).run("le_" + randomUUID(), org, leadId, "a", "b", de, para, userId, quando);
  db.prepare("UPDATE leads SET stage_id = ? WHERE id = ?").run(para, leadId);
};
const msg = (leadId, dir, quando, userId = null) => db.prepare(`INSERT INTO messages (id,lead_id,direction,body,from_user_id,from_name,created_at)
  VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), leadId, dir, "oi", userId, userId ? "Gente" : null, quando);

// A: nasce na fila (SDR) às 01:00, sai para o comercial e vai à Blanca às 02:00.
const A = lead({ etapa: sdrNovo, pipe: sdrId, quando: t(60), source: "meta" });
mover(A, sdrNovo, E["Novo"], t(120), ali);
trocarResponsavel(A, blanca, ali, "mao");
db.prepare("UPDATE lead_transfers SET created_at = ?, from_pipeline_id = ? WHERE lead_id = ?").run(t(120), sdrId, A);
db.prepare("UPDATE leads SET stage_id = ?, pipeline_id = ? WHERE id = ?").run(E["Novo"], bxId, A);
// Blanca responde às 02:10 → 1ª resposta 10 min; pula de Novo para Agendamento às 03:00.
msg(A, "out", t(130), blanca);
msg(A, "in", t(135));
msg(A, "out", t(140), blanca);
msg(A, "in", t(150));
mover(A, E["Novo"], E["Agendamento"], t(180), blanca);

// B: nasceu na linha pessoal da Blanca — não é lead recebido.
const canal = "cn_" + randomUUID();
db.prepare("INSERT INTO canais (id,org_id,tipo,user_id,nome,ativo,created_at) VALUES (?,?,'corretor',?,'Blanca',1,?)").run(canal, org, blanca, agora);
const B = lead({ dono: blanca, etapa: E["Lead"], pipe: bxId, quando: t(200) });
db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at,canal_id) VALUES (?,?,'in','oi',?,?)`).run("m_" + randomUUID(), B, t(200), canal);

// C: recebido pela Blanca já em Proposta (fora da entrada) — não entra na 1ª resposta.
const C = lead({ dono: ezequiel, etapa: E["Proposta"], pipe: bxId, quando: t(10) });
trocarResponsavel(C, blanca, ali, "mao");
db.prepare("UPDATE lead_transfers SET created_at = ? WHERE lead_id = ?").run(t(300), C);
msg(C, "out", t(400), blanca);

// D: carteira passada em lote do Ezequiel para a Blanca — não conta.
const D = lead({ dono: ezequiel, etapa: E["Lead"], pipe: bxId, quando: t(20) });
trocarResponsavel(D, blanca, ali, "lote");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@nf.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, JSON.stringify(d)); return d.token;
}
const get = async (tk, c) => { const r = await fetch(BASE + c, { headers: { authorization: "Bearer " + tk } });
  const d = await r.json(); assert.equal(r.status, 200, `${c}: ${JSON.stringify(d)}`); return d; };
const tAli = await entrar("Ali");

console.log("1. Recebidos da Blanca: A e C (não B da linha pessoal, não D do lote), igual em todas as telas");
const rel = await get(tAli, "/reports?periodo=hoje");
const lb = rel.atendentes.find(a => a.id === blanca);
const eq = (await get(tAli, "/painel/equipe?periodo=hoje")).equipe.find(p => p.id === blanca);
const pg = await get(tAli, `/painel/geral?periodo=hoje&responsavel=${blanca}`);
const op = await get(tAli, `/painel?periodo=hoje&responsavel=${blanca}`);
const v = { relatorios: lb.recebidos, equipe: eq.recebidos_no_periodo, painel: pg.kpis.leads.atual, operacao: op.atendimento.recebidos };
console.log("   " + JSON.stringify(v));
for (const [k, x] of Object.entries(v)) assert.equal(x, 2, k);

console.log("2. Marcos: Novo → Agendamento conta qualificado E agendado para a Blanca; visita ainda 0");
const passo = (id) => pg.funil_atividade.find(p => p.id === id).valor;
assert.equal(passo("qualificadas"), 1);
assert.equal(passo("visita_agendada"), 1);
assert.equal(passo("visita_realizada"), 0);
assert.equal(lb.qualificados, 1); assert.equal(lb.agendados, 1); assert.equal(lb.visitas, 0);
assert.equal(op.atendimento.qualificados, 1, "Visão geral filtrada pela Blanca: 1 qualificado");
// A linha discreta (11/11/2026): o qualificado foi deduzido do salto; o agendado, não.
const pulo = (id) => pg.funil_atividade.find(p => p.id === id).pulados;
assert.equal(pulo("qualificadas"), 1, "qualificado veio da etapa pulada");
assert.equal(pulo("visita_agendada"), 0, "agendado foi a etapa de chegada");
assert.deepEqual(lb.pulados, { qualificados: 1, agendados: 0, visitas: 0, propostas: 0 });
mover(A, E["Agendamento"], E["Visita"], t(240), blanca);
const pg2 = await get(tAli, `/painel/geral?periodo=hoje&responsavel=${blanca}`);
assert.equal(pg2.funil_atividade.find(p => p.id === "visita_realizada").valor, 1);
assert.equal(pg2.funil_atividade.find(p => p.id === "qualificadas").valor, 1, "qualificado continua 1 (uma vez por lead)");

console.log("3. Trabalhados e faladas: um por lead por dia");
// A teve 2 mensagens dela e 2 respostas hoje → 1 trabalhado, 1 falada. C teve 1 mensagem, sem resposta.
assert.equal(pg2.funil_atividade.find(p => p.id === "trabalhados").valor, 2);
assert.equal(pg2.funil_atividade.find(p => p.id === "faladas").valor, 1);

console.log("4. Pré-atendimento: A entrou no SDR, foi qualificado e repassado");
const s = await get(tAli, "/reports/sdr?periodo=hoje");
const fila = s.por_pessoa.find(p => p.ia);
assert.ok(fila, JSON.stringify(s.por_pessoa));
assert.equal(fila.recebidos, 1); assert.equal(fila.qualificados, 1); assert.equal(fila.repassados_ao_corretor, 1);
const meta = s.por_origem.find(o => /Meta|WhatsApp/.test(o.origem));
assert.equal(meta.qualificados, 1);

console.log("5. Funil de conversão comercial: etapa pulada conta como passada");
const fun = await get(tAli, `/painel/funil/${bxId}?periodo=hoje`);
const c = fun.conversao;
assert.equal(c.etapa_pulada_conta, true);
const linha = (nome) => c.linhas.find(l => l.name === nome);
// A (pulou de Novo) e C (nasceu em Proposta — nascer adiantado também é entrar).
assert.equal(linha("Atendimento qualificado").chegaram, 2);
assert.equal(linha("Agendamento").sem_passar_pela_anterior, 0);
for (const l of c.linhas) if (l.anterior && l.anterior.taxa != null) assert.ok(l.anterior.taxa <= 100, l.name);

console.log("6. 1ª resposta da Blanca: só o lead A (recebido em Novo) — 10 min");
assert.equal(lb.primeira_resposta_mediana_min, 10);
assert.equal(lb.atendidos, 2, "atendidos: escreveu para A e C");

console.log("\nOK — os números do Fernando batem.");
process.exit(0);
