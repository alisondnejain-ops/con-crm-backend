/* UM NÚMERO, UMA CONTA (20/11/2026, pedido do Ali com o print da Veronica:
   cartões 20/11/6 e funil 22/13/8 na mesma tela).

   Monta os casos que faziam as contas divergirem — lead que NASCE numa etapa
   adiantada, lead que já tinha agendado em OUTRO funil e agenda de novo neste,
   funil sem etapa marcada como conversão, etapa pulada, venda — e confere que
   cartão do relatório, Score, Painel (indicadores e funil de atividades),
   Visão geral e funil de conversão dizem o MESMO número, para a pessoa e
   para a imobiliária.

   Rodar:  npm run teste:numeros-unicos  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.TZ = "America/Recife";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-numeros-unicos.db");
process.env.JWT_SECRET = "teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const P = await import("../src/services/pipelines.js");
const C = await import("../src/services/conversao.js");
const PA = await import("../src/services/painel.js");
const PG = await import("../src/services/painel-geral.js");
const S = await import("../src/services/score.js");

const org = "org_nu";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "NU-1", Date.now());
const user = (nome, role) => { const id = "u_" + nome.toLowerCase();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@nu.com", role, Date.now());
  return id; };
const vero = user("Veronica", "corretor"), joao = user("Joao", "corretor");

const DIA = 86400000;
const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const ini = hoje.getTime() - 10 * DIA, fim = hoje.getTime() - DIA;
const PERIODO = { de: iso(ini), ate: iso(fim) };
const DE = ini, ATE = new Date(fim).setHours(23, 59, 59, 999);
const NO = (d, h = 10) => ini + d * DIA + h * 3600000;      // dentro do período
const ANTES = ini - 20 * DIA;                               // antes do período

function funil(nome, etapas) {
  const pl = P.criarPipeline(org, { name: nome });
  const e = {};
  for (const [n, conv, tipo, entrada] of etapas)
    e[n] = P.criarEtapa(org, pl.pipeline.id, { name: n, counts_as_conversion: !!conv, status_type: tipo || "aberto",
      entrada_comercial: !!entrada }).etapa.id;
  return { id: pl.pipeline.id, e };
}
const BRACO = funil("Braço Externo", [["Lead", 1, null, 1], ["Atendimento Qualificado", 1], ["Agendamento", 1],
  ["Visita", 1], ["Proposta", 1], ["Venda", 1, "ganho"], ["Perdido", 0, "perdido"]]);
const COMERCIAL = funil("Comercial", [["Novo", 1, null, 1], ["Qualificado", 1], ["Agendamento", 1], ["Visita", 1],
  ["Venda", 1, "ganho"]]);
const SEMFLAG = funil("Locação", [["Novo"], ["Qualificado"], ["Agendado"], ["Visita realizada"], ["Locado", 0, "ganho"]]);

let seq = 0;
function lead(F, etapa, criado, dono) {
  const id = "l_" + (++seq);
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,stage_id,pipeline_id,assigned_to,assigned_at,created_at,stage_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, org, "Lead " + seq, "558799" + String(seq).padStart(6, "0"), etapa,
    F.e[etapa], F.id, dono, criado, criado, criado);
  return id;
}
function mover(F, id, etapa, t, venda = false) {
  const l = db.prepare("SELECT stage, stage_id, pipeline_id FROM leads WHERE id = ?").get(id);
  db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,motivo,created_at,de_stage_id,para_stage_id,etapa_fonte)
    VALUES (?,?,?,?,?,'mao',?,?,?,'gravado')`).run("le_" + randomUUID(), org, id, l.stage, etapa, t, l.stage_id, F.e[etapa]);
  db.prepare("UPDATE leads SET stage = ?, stage_id = ?, pipeline_id = ?, stage_entered_at = ? WHERE id = ?").run(etapa, F.e[etapa], F.id, t, id);
  if (venda) db.prepare("UPDATE leads SET sale_value = 300000, sale_date = ? WHERE id = ?").run(t, id);
}

// 1. Nasce direto em "Atendimento Qualificado" (catraca/roleta/cadastro na mão).
lead(BRACO, "Atendimento Qualificado", NO(1), vero);
// 2. Agendou no Comercial antes do período; agenda de novo no Braço no período.
const l2 = lead(COMERCIAL, "Novo", ANTES, vero);
mover(COMERCIAL, l2, "Agendamento", ANTES + DIA);
mover(BRACO, l2, "Agendamento", NO(2));
// 3. Pula de Lead direto para Agendamento.
const l3 = lead(BRACO, "Lead", NO(1), vero); mover(BRACO, l3, "Agendamento", NO(3));
// 4. Qualificado antes do período, visita no período.
const l4 = lead(BRACO, "Lead", ANTES, vero); mover(BRACO, l4, "Atendimento Qualificado", ANTES + DIA);
mover(BRACO, l4, "Visita", NO(4));
// 5. Venda no período.
const l5 = lead(BRACO, "Lead", NO(1), vero); mover(BRACO, l5, "Proposta", NO(2)); mover(BRACO, l5, "Venda", NO(5), true);
// 6. João, num funil sem etapa marcada como conversão.
const l6 = lead(SEMFLAG, "Novo", NO(1), joao); mover(SEMFLAG, l6, "Agendado", NO(2));
// 7. João no Braço também, qualificado no período.
const l7 = lead(BRACO, "Lead", NO(1), joao); mover(BRACO, l7, "Atendimento Qualificado", NO(3));

const linha = (r, nome) => (r.linhas.find(l => l.name === nome) || { chegaram: 0 }).chegaram;
const atv = (f) => Object.fromEntries(PG.visaoGeral(org, { ...PERIODO, ...f }).funil_atividade.map(p => [p.id, p.valor]));

console.log("1. Veronica (só no Braço Externo): cartão = Score = Painel = funil");
const fv = C.funilDeConversao(org, BRACO.id, { ...PERIODO, responsavel: vero });
const mk = S.marcosDaPessoa(org, vero, DE, ATE);
const pv = atv({ responsavel: vero });
const kv = PG.visaoGeral(org, { ...PERIODO, responsavel: vero }).kpis;
const funilV = { q: linha(fv, "Atendimento Qualificado"), a: linha(fv, "Agendamento"), v: linha(fv, "Visita"), p: linha(fv, "Proposta") };
console.log(`   funil ${JSON.stringify(funilV)} · cartões ${mk.qualificados}/${mk.agendados}/${mk.visitas}/${mk.propostas}`);
assert.deepEqual([mk.qualificados, mk.agendados, mk.visitas, mk.propostas], [funilV.q, funilV.a, funilV.v, funilV.p], "cartões = funil");
assert.deepEqual([pv.qualificadas, pv.visita_agendada, pv.visita_realizada, pv.proposta], [funilV.q, funilV.a, funilV.v, funilV.p], "Painel = funil");
assert.equal(kv.qualificados.atual, funilV.q); assert.equal(kv.agendamentos.atual, funilV.a);
assert.equal(kv.visitas.atual, funilV.v); assert.equal(kv.propostas.atual, funilV.p);
assert.equal(PA.painel(org, { ...PERIODO, responsavel: vero }).atendimento.qualificados, funilV.q, "Visão geral = funil");
// O nascimento qualificado conta; o agendamento no Braço conta mesmo tendo agendado no Comercial antes.
assert.equal(funilV.q, 5, "nasceu qualificado, entrou no funil agendado, pulou, visitou, vendeu — sem buraco, todos qualificados no período");
assert.equal(funilV.a, 4, "inclusive quem já tinha agendado em outro funil");

console.log("2. João, num funil sem degrau marcado: conta pelo nome da etapa, e o funil mostra o mesmo");
const fl = C.funilDeConversao(org, SEMFLAG.id, { ...PERIODO, responsavel: joao });
assert.ok(fl.avisos.some(a => /pelo nome/.test(a)), "o funil avisa que está usando o nome das etapas");
const mkJ = S.marcosDaPessoa(org, joao, DE, ATE);
assert.equal(linha(fl, "Agendado"), 1);
assert.equal(mkJ.agendados, 1);
assert.equal(mkJ.qualificados, 2, "um no funil de locação (pulado) + um no Braço");

console.log("3. A imobiliária inteira: Painel = Visão geral = soma dos funis sem repetir o lead");
const casa = atv({});
const somaJV = (k) => S.marcosDaPessoa(org, vero, DE, ATE)[k] + S.marcosDaPessoa(org, joao, DE, ATE)[k];
assert.equal(casa.qualificadas, somaJV("qualificados"));
assert.equal(casa.visita_agendada, somaJV("agendados"));
assert.equal(casa.visita_realizada, somaJV("visitas"));
assert.equal(PA.painel(org, PERIODO).atendimento.qualificados, casa.qualificadas);
const kc = PG.visaoGeral(org, PERIODO).kpis;
assert.equal(kc.qualificados.atual, casa.qualificadas);
console.log(`   casa: ${casa.qualificadas} qualificados · ${casa.visita_agendada} agendados · ${casa.visita_realizada} visitas · ${casa.proposta} propostas · ${casa.venda} venda`);

console.log("4. Sem buraco: nenhum degrau tem menos que o de baixo");
for (const x of [pv, casa]) {
  assert.ok(x.qualificadas >= x.visita_agendada && x.visita_agendada >= x.visita_realizada
    && x.visita_realizada >= x.proposta && x.proposta >= x.venda, JSON.stringify(x));
}

console.log("\nTudo certo ✅ — um número, uma conta.");
process.exit(0);
