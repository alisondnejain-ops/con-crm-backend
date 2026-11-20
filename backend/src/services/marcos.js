/* ===== OS MARCOS DO ATENDIMENTO COMERCIAL, COM A ETAPA PULADA CONTANDO =====
   (07/11/2026, pedido do Fernando, decisão do Ali: "tenha essa sagacidade")

   Qualificado, agendado, visita, proposta e venda são MARCOS, e cada lead
   alcança cada marco UMA VEZ por período (a primeira chegada em cada funil
   comercial; entre funis, conta uma vez).

   A ETAPA PULADA CONTA COMO PASSADA. O corretor que recebe o lead em "Novo"
   e o joga direto para "Agendamento" qualificou o lead — é óbvio que ele é
   qualificado, senão não estaria agendado. Então chegar a um marco conta
   também todos os marcos de antes que o lead ainda não tinha alcançado, com a
   data e o autor do salto. Isso não conta a mesma pessoa duas vezes: quem já
   tinha sido qualificado ontem e foi agendado hoje conta UM agendado hoje, e
   o qualificado continua sendo o de ontem.

   O QUE É CADA MARCO vem do NOME da etapa, nos funis que NÃO são de SDR
   (o "Lead qualificado" do SDR é qualificação do SDR, que tem conta própria):
   - venda: etapa de ganho, ou "venda"/"vendido" no nome;
   - proposta: "proposta" ou "negociação";
   - agendado: "agend" (vem antes de "visita": "Agendamento de visita" é
     agendamento);
   - visita: "visita" (no ambiente interno, a etapa de demonstração feita);
   - qualificado: "qualific" ("Atendimento qualificado").
   "Atendimento frio", "Repique", "Compra futura", "Pasta" não são marcos e
   não implicam nada.

   O NASCIMENTO CONTA (20/11/2026, unificação): o lead que nasce direto numa
   etapa-marco (catraca direto ao corretor, roleta, cadastro na mão) chegou
   a ela — é a regra do funil de conversão, e agora a única.

   Limite conhecido: o Fernando também disse "a não ser que o cliente entre de
   novo como lead numa nova campanha". O lead é um só no CRM (o mesmo número
   volta para o mesmo lead), e não há como separar a segunda campanha sem um
   módulo de oportunidades — fica como está: uma vez por lead. */
import db, { emLotes } from "../db.js";
import { ehFunilDeSdr } from "./pipelines.js";
import { ehInterna } from "./interno.js";

export const MARCOS = ["qualificado", "agendado", "visita", "proposta", "venda"];
const sem = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* O marco de um nome de etapa (ou -1). `ganho` vem da etapa, quando se sabe. */
export function marcoDoNome(nome, { ganho = false, interna = false } = {}) {
  const n = sem(nome);
  if (ganho || /\bvend(a|ido)\b/.test(n)) return MARCOS.indexOf("venda");
  if (/propost|negocia/.test(n)) return MARCOS.indexOf("proposta");
  if (/agend/.test(n)) return MARCOS.indexOf("agendado");
  if (/visita/.test(n) || (interna && /demonstra.*(feita|realizada)/.test(n))) return MARCOS.indexOf("visita");
  if (/qualific/.test(n)) return MARCOS.indexOf("qualificado");
  return -1;
}

/* A CONTA dos marcos no período (quem chegou, quando, para quem) mora em
   services/conversao.js → `marcosDoPeriodo` desde 20/11/2026: é a mesma do
   funil de conversão, e os cartões, o Painel, o Score e a Visão geral leem
   de lá. Aqui fica só o que dá NOME ao marco de uma etapa (`marcoDoNome`) e
   as consultas de etapa no instante. A conta antiga deste arquivo (etapa pelo
   nome, uma vez na vida do lead, sem o nascimento) saiu: duas contas para o
   mesmo número eram o que fazia o cartão e o funil discordarem. */

/* ===== EM QUE ETAPA O LEAD ESTAVA NUM INSTANTE =====
   Pelo histórico: a última mudança até o instante (mais 2 segundos — a troca
   de dono e a de funil acontecem na mesma operação, e o repasse grava o dono
   antes de mover o lead para o comercial), ou a etapa de nascimento. */
export function etapaNoInstante(orgId, ids) {
  const hist = new Map(), nasc = new Map();
  if (!ids.length) return () => null;
  for (const r of emLotes(ids, (m, lote) => db.prepare(
    `SELECT lead_id, de_stage_id, para_stage_id, created_at t FROM lead_etapas
     WHERE +org_id = ? AND lead_id IN (${m}) ORDER BY created_at, rowid`).all(orgId, ...lote))) {
    if (!hist.has(r.lead_id)) hist.set(r.lead_id, []);
    hist.get(r.lead_id).push(r);
  }
  for (const l of emLotes(ids, (m, lote) => db.prepare(`SELECT id, stage_id FROM leads WHERE id IN (${m})`).all(...lote)))
    nasc.set(l.id, l.stage_id);
  return (lead, t) => {
    const h = hist.get(lead) || [];
    if (!h.length) return nasc.get(lead) || null;
    let atual = h[0].de_stage_id || null;
    for (const r of h) { if (r.t <= t + 2000) atual = r.para_stage_id || atual; else break; }
    return atual;
  };
}

/* AS ETAPAS DO COMERCIAL, PARA OS DOIS TEMPOS DO CORRETOR (07/11/2026,
   pedido do Fernando):
   - "de entrada": as do funil comercial (não de SDR) que vêm ANTES do
     primeiro marco — "Novo", "Lead", "Atendimento". É só o lead recebido numa
     delas que conta no tempo da 1ª resposta do corretor; o que estava no Inbox
     ou no funil de SDR conta para o SDR.
   - "comerciais": todas as etapas dos funis que não são de SDR, menos as que
     têm "inbox" no nome — é onde o tempo de atendimento do corretor conta. */
export function etapasDoComercial(orgId) {
  const interna = ehInterna(orgId);
  const etapas = db.prepare(`SELECT id, name, status_type, pipeline_id, ordem FROM pipeline_stages WHERE org_id = ? ORDER BY pipeline_id, ordem, rowid`).all(orgId);
  const porFunil = new Map();
  for (const e of etapas) { if (!porFunil.has(e.pipeline_id)) porFunil.set(e.pipeline_id, []); porFunil.get(e.pipeline_id).push(e); }
  const entrada = new Set(), comerciais = new Set();
  for (const [pid, lista] of porFunil) {
    if (ehFunilDeSdr(orgId, pid)) continue;
    let antesDoMarco = true;
    for (const e of lista) {
      const n = sem(e.name);
      if (/inbox/.test(n)) continue;
      comerciais.add(e.id);
      if (marcoDoNome(e.name, { ganho: e.status_type === "ganho", interna }) >= 0) antesDoMarco = false;
      if (antesDoMarco && e.status_type !== "perdido" && !/frio|repique|futura|perd/.test(n)) entrada.add(e.id);
    }
  }
  return { entrada, comerciais };
}
