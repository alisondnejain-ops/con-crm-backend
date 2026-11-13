/* ===== OS MARCOS DO ATENDIMENTO COMERCIAL, COM A ETAPA PULADA CONTANDO =====
   (07/11/2026, pedido do Fernando, decisão do Ali: "tenha essa sagacidade")

   Qualificado, agendado, visita, proposta e venda são MARCOS, e cada lead
   alcança cada marco UMA VEZ só — "uma vez qualificado, sempre qualificado".

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

   O NASCIMENTO NÃO CONTA. Lead importado direto em "Venda" ou criado numa
   etapa adiantada não foi qualificado por ninguém no dia em que entrou no
   CRM. Só as MUDANÇAS de etapa (lead_etapas) alcançam marcos.

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

/* Classificador da conta: id da etapa → marco, e um mapa por nome para as
   linhas antigas do histórico, que só guardam o nome. Nome que existe também
   num funil de SDR não serve sozinho (seria o "Lead qualificado" do SDR). */
export function classificador(orgId) {
  const interna = ehInterna(orgId);
  const etapas = db.prepare(`SELECT s.id, s.name, s.status_type, s.pipeline_id FROM pipeline_stages s WHERE s.org_id = ?`).all(orgId);
  const sdr = new Map();
  const doSdr = (pid) => { if (!sdr.has(pid)) sdr.set(pid, ehFunilDeSdr(orgId, pid)); return sdr.get(pid); };
  const porId = new Map(), porNome = new Map(), nomesSdr = new Set(), todos = new Set(etapas.map(e => e.name));
  for (const e of etapas) {
    if (doSdr(e.pipeline_id)) { nomesSdr.add(e.name); continue; }
    const m = marcoDoNome(e.name, { ganho: e.status_type === "ganho", interna });
    if (m < 0) continue;
    porId.set(e.id, m);
    if (!porNome.has(e.name) || porNome.get(e.name) === m) porNome.set(e.name, m); else porNome.set(e.name, -1);
  }
  for (const n of nomesSdr) porNome.delete(n);
  return {
    // Etapa com id: só ela decide (etapa de funil de SDR fica de fora).
    deLinha: (sid, nome) => {
      if (sid) return porId.has(sid) ? porId.get(sid) : -1;
      const m = porNome.get(nome);
      if (m !== undefined) return m;
      // Nome que não é de etapa nenhuma da conta (conta sem funil configurável,
      // histórico de etapa apagada): vale o nome.
      return !nome || todos.has(nome) ? -1 : marcoDoNome(nome, { interna });
    },
  };
}

/* Os marcos alcançados por cada lead da lista, com quando e por quem — o
   primeiro momento, com o salto preenchendo os de antes.
   Devolve Map(lead → [ {t, user_id, inferido} | undefined ] por marco). */
export function marcosDosLeads(orgId, ids, cls = null) {
  const c = cls || classificador(orgId);
  const res = new Map();
  if (!ids.length) return res;
  const linhas = emLotes(ids, (m, lote) => db.prepare(
    `SELECT lead_id, para_stage_id sid, para nome, user_id, created_at t FROM lead_etapas
     WHERE +org_id = ? AND lead_id IN (${m}) ORDER BY created_at, rowid`).all(orgId, ...lote));
  linhas.sort((a, b) => a.t - b.t);
  for (const r of linhas) {
    const k = c.deLinha(r.sid, r.nome);
    if (k < 0) continue;
    if (!res.has(r.lead_id)) res.set(r.lead_id, new Array(MARCOS.length));
    const alc = res.get(r.lead_id);
    for (let j = 0; j <= k; j++)
      if (!alc[j]) alc[j] = { t: r.t, user_id: r.user_id || null, inferido: j < k };
  }
  return res;
}

/* Os leads que alcançaram um marco no período — um por lead. Com `quem`, só
   os que ESTA pessoa fez avançar (o autor da mudança; o salto conta para
   quem saltou). `ids` é o universo de leads (já peneirado pelos filtros). */
export function alcancesNoPeriodo(orgId, ids, marco, de, ate, { quem = null, cls = null, mapa = null } = {}) {
  const k = MARCOS.indexOf(marco);
  const m = mapa || marcosDosLeads(orgId, ids, cls);
  const out = [];
  const qs = quem ? new Set(Array.isArray(quem) ? quem : [quem]) : null;
  for (const id of ids) {
    const a = (m.get(id) || [])[k];
    if (!a || a.t < de || a.t > ate) continue;
    if (qs && !qs.has(a.user_id)) continue;
    out.push({ lead: id, t: a.t, user_id: a.user_id, inferido: a.inferido });
  }
  return out;
}

/* Os leads da peneira que tiveram alguma mudança de etapa no intervalo — os
   únicos que podem ter alcançado um marco nele. Evita montar a linha do tempo
   da base inteira para responder sobre um dia. */
export function candidatosDoPeriodo(orgId, pSql, pArgs, de, ate) {
  return db.prepare(`SELECT DISTINCT le.lead_id id FROM lead_etapas le JOIN leads l ON l.id = le.lead_id
    WHERE le.org_id = ? AND ${pSql} AND le.created_at BETWEEN ? AND ?`).all(orgId, ...pArgs, de, ate).map(r => r.id);
}

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
