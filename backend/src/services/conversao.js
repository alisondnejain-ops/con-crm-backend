/* FUNIL DE CONVERSÃO POR COORTE — a conta única do CETRO (01/10/2026).

   Pedido do Ali: os números do funil, do painel e do relatório precisavam
   bater com o que aconteceu, e não com uma mistura de "leads criados no
   período", "onde estão hoje" e "por onde passaram, pelo nome da etapa". Este
   arquivo é o ÚNICO lugar em que a conversão é calculada. A Operação, o
   relatório individual e o relatório para reunião leem daqui; nenhuma tela
   refaz a conta.

   A UNIDADE É O LEAD. Não existe módulo de oportunidades: um lead conta uma
   vez na coorte, por mais que saia e volte ao funil.

   AS REGRAS

   1. A BASE É QUEM ENTROU NO PROCESSO COMERCIAL NO PERÍODO — não quem foi
      criado nele. "Entrar" é a PRIMEIRA vez que o lead chega a uma etapa da
      faixa comercial do funil: do "início do processo comercial" (a etapa
      marcada, ou na falta dela a primeira que conta como conversão) até o
      último marco de conversão, sem as etapas de perda. O que vem antes
      (Inbox, triagem) não entra na base — e a base NÃO é "total menos Inbox":
      é quem de fato chegou lá. Entrar direto numa etapa mais adiantada
      (importação, lead pulado para Visita) também é entrar.

   2. A ENTRADA NÃO SE DESFAZ. Perder o lead, devolvê-lo ao Inbox ou movê-lo
      para outro funil não o tira da coorte em que ele entrou, e voltar à faixa
      não o conta de novo.

   3. CORTE. A coorte é acompanhada até o fim do período (ou até agora, se o
      período ainda não acabou). O que aconteceu depois do corte não entra:
      senão o relatório de setembro mudaria em outubro.

   4. AS DUAS TAXAS.
      - Desde a entrada = quantos chegaram à etapa ÷ base.
      - Da etapa anterior = dos que chegaram ao marco anterior, quantos
        chegaram a este DEPOIS ÷ quantos chegaram ao anterior.
      Sem denominador a taxa é `null` ("sem base"); denominador com ninguém
      avançando é 0. As taxas saem sem arredondar — quem arredonda é a tela.
      No funil COMERCIAL a etapa pulada conta como passada (07/11/2026): quem
      chega a um marco alcança também os de antes. No funil de SDR, quem
      chega sem passar pela anterior aparece no detalhe como tal.

   5. ETAPA PELO ID. O histórico guarda o id das etapas desde 01/10/2026. As
      linhas antigas só ganham id quando o nome não deixa dúvida (ver
      `identificarEtapasDoHistorico`); o resto fica fora da conta e é
      contado, nunca chutado.

   6. DONO NA ENTRADA. A coorte é de quem estava com o lead quando ele entrou
      no processo comercial. Repasse depois não reescreve isso; a carteira de
      hoje continua sendo do dono de hoje (é a outra leitura, "onde estão
      agora"). Lead na fila na entrada vai para "Sem responsável".

   7. O QUE NÃO SE SABE APARECE COMO "NÃO SE SABE". O histórico de etapas
      começou em 13/08/2026 e o de donos em 01/09/2026. Período que começa
      antes disso, ou lead cuja entrada não tem data, aparece contado à parte
      e com aviso — nunca como zero. */

import db, { emLotes } from "../db.js";
import { etapasDoPipeline, pipelinePorId, ehFunilDeSdr } from "./pipelines.js";
import { peneira, resolverPeriodo, recebidosDaPessoa, listaDeDonos } from "./painel.js";
import { marcoDoNome, MARCOS } from "./marcos.js";
import { ehInterna } from "./interno.js";

/* Desde quando o histórico é completo. Um dia depois de cada recurso entrar,
   de propósito: o que entrou no meio do dia da publicação pode ter mudado
   antes de o registro existir. */
export const COBERTURA_ETAPAS = new Date(2026, 7, 14).getTime();   // 14/08/2026
export const COBERTURA_DONOS = new Date(2026, 8, 2).getTime();     // 02/09/2026

/* A mudança de dono que acontece NA MESMA OPERAÇÃO da entrada vale como dono
   na entrada: a automação de "Lead qualificado" primeiro move o lead para o
   comercial e, milissegundos depois, entrega ao corretor. Sem a janela, toda
   a coorte desse caminho seria atribuída à atendente. */
const MESMA_OPERACAO_MS = 2000;

// Mudança feita por regra, sem uma pessoa decidir naquele momento.
export const MOTIVOS_AUTOMATICOS = new Set(["palavra", "reanalise", "automatica"]);

/* ===== LINHAS ANTIGAS DO HISTÓRICO =====

   Antes de 01/10/2026 o histórico guardava só o nome. O id é recuperado só
   quando a evidência é segura: entre as etapas da conta que JÁ EXISTIAM na
   data da mudança (as do primeiro funil, para o que é anterior a ele), há
   exatamente UMA com aquele nome. Nome repetido, etapa renomeada depois ou
   nome que não existe mais: a linha fica 'desconhecida' e é contada à parte.
   Idempotente — só olha linhas ainda não conferidas — e não apaga nada. */
export function identificarEtapasDoHistorico(orgId) {
  const pendentes = db.prepare(
    "SELECT id, de, para, created_at, de_stage_id, para_stage_id FROM lead_etapas WHERE org_id = ? AND etapa_fonte IS NULL"
  ).all(orgId);
  if (!pendentes.length) return { conferidas: 0, identificadas: 0 };

  const primeiro = db.prepare("SELECT created_at FROM pipelines WHERE org_id = ? ORDER BY created_at LIMIT 1").get(orgId);
  const etapas = db.prepare("SELECT id, name, created_at FROM pipeline_stages WHERE org_id = ?").all(orgId);
  const porNome = new Map();
  for (const e of etapas) {
    if (!porNome.has(e.name)) porNome.set(e.name, []);
    porNome.get(e.name).push(e);
  }
  const resolver = (nome, quando) => {
    if (!nome || !primeiro) return null;
    const ate = Math.max(quando, primeiro.created_at);
    const existiam = (porNome.get(nome) || []).filter(e => e.created_at <= ate);
    return existiam.length === 1 ? existiam[0].id : null;
  };

  let identificadas = 0;
  const gravar = db.prepare(
    "UPDATE lead_etapas SET de_stage_id = ?, para_stage_id = ?, etapa_fonte = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of pendentes) {
      const para = r.para_stage_id || resolver(r.para, r.created_at);
      const de = r.de_stage_id || resolver(r.de, r.created_at);
      if (para) identificadas++;
      gravar.run(de, para, para ? "nome" : "desconhecida", r.id);
    }
  })();
  return { conferidas: pendentes.length, identificadas };
}

/* ===== A CONFIGURAÇÃO DO FUNIL =====

   Quais etapas são marcos, onde o processo comercial começa e a fase de cada
   etapa. Erros de configuração não derrubam o funil: viram avisos escritos. */
export function configDoFunil(orgId, pipelineId) {
  const todas = etapasDoPipeline(orgId, pipelineId, { incluirInativas: true });
  const pos = new Map(todas.map((e, i) => [e.id, i]));
  const ativas = todas.filter(e => e.is_active);
  const avisos = [];

  for (const e of ativas)
    if (e.counts_as_conversion && e.status_type === "perdido")
      avisos.push(`"${e.name}" é etapa de perda e não entra no funil de conversão, mesmo marcada como conversão.`);
  const marcadaInativa = todas.find(e => e.entrada_comercial && !e.is_active);
  if (marcadaInativa)
    avisos.push(`A etapa marcada como início do processo comercial ("${marcadaInativa.name}") está desativada.`);

  let conversao = ativas.filter(e => e.counts_as_conversion && e.status_type !== "perdido");
  /* FUNIL SEM DEGRAU MARCADO (20/11/2026, unificação dos números): os
     cartões do Painel e do relatório leem ESTE funil. Sem nenhuma etapa
     marcada como conversão, vale o nome da etapa (qualificado, agendamento,
     visita, proposta, venda — services/marcos.js), com aviso — senão o
     funil diria "sem marcos" e os cartões ficariam em zero sem explicação. */
  if (!conversao.length) {
    conversao = ativas.filter(e => e.status_type !== "perdido" && marcoDoNome(e.name, { ganho: e.status_type === "ganho", interna: ehInterna(orgId) }) >= 0);
    if (conversao.length)
      avisos.push(`Nenhuma etapa deste funil está marcada como conversão: a conta usa as etapas pelo nome (${conversao.map(e => e.name).join(", ")}). Marque os degraus em Configurações → Funis e etapas.`);
  }
  let entrada = ativas.find(e => e.entrada_comercial && e.status_type !== "perdido") || null;
  const configurada = !!entrada;
  if (!entrada && conversao.length) {
    entrada = conversao[0];
    avisos.push(`O início do processo comercial não está marcado neste funil: a conta começa em "${entrada.name}", a primeira etapa que conta como conversão.`);
  }
  if (!entrada)
    return { entrada: null, configurada: false, marcos: [], faixa: new Set(), fase: () => "fora", avisos, sem_marcos: true };

  for (const e of conversao)
    if (pos.get(e.id) < pos.get(entrada.id))
      avisos.push(`"${e.name}" conta como conversão mas vem antes do início do processo comercial ("${entrada.name}") — fica fora do funil.`);

  const marcos = [entrada, ...conversao.filter(e => pos.get(e.id) > pos.get(entrada.id))];
  if (marcos.length === 1)
    avisos.push("Nenhuma etapa depois do início do processo comercial conta como conversão. Marque os degraus em Configurações → Funis e etapas.");

  const ini = pos.get(entrada.id), fim = pos.get(marcos[marcos.length - 1].id);
  /* A faixa comercial inclui as etapas de apoio entre os marcos (Pasta,
     Documentação) e as desativadas — quem passou por elas antes de a etapa
     sair continua tendo entrado. */
  const faixa = new Set(todas.filter(e => pos.get(e.id) >= ini && pos.get(e.id) <= fim && e.status_type !== "perdido").map(e => e.id));
  const fase = (etapaId) => {
    const e = todas.find(x => x.id === etapaId);
    if (!e) return "fora";
    if (e.status_type === "perdido") return "perdido";
    if (faixa.has(e.id)) return "comercial";
    return pos.get(e.id) < ini ? "antes" : "depois";
  };
  return { entrada, configurada, marcos, faixa, fase, avisos, sem_marcos: false };
}

/* ===== O CÁLCULO =====

   Monta, para cada lead que pode ter entrado no período, a linha do tempo das
   etapas a que chegou — e dela tira a entrada, os marcos e o dono. */
function calcular(orgId, pipelineId, filtros = {}, agora = Date.now()) {
  const pipeline = pipelinePorId(orgId, pipelineId);
  if (!pipeline) return { erro: "Funil não encontrado." };
  identificarEtapasDoHistorico(orgId);

  const periodo = filtros._periodo || resolverPeriodo(filtros);
  const corte = Math.min(periodo.ate, agora);
  const cfg = configDoFunil(orgId, pipelineId);
  const base = { pipeline, periodo, corte, cfg, unidades: [], semData: [], donoDesconhecido: [] };
  if (cfg.sem_marcos || periodo.de > corte) return base;

  /* Candidatos: só quem tem uma chegada à faixa DENTRO do período (evento
     ou nascimento). A entrada é a primeira chegada; quem não chegou no
     período não pode ter entrado nele. Quando o período começa antes da
     cobertura do histórico, os leads antigos entram também — para serem
     contados como "entrada sem data", não para serem descartados. */
  const faixa = [...cfg.faixa];
  const marcas = faixa.map(() => "?").join(",");
  const cand = new Set();
  for (const r of db.prepare(`SELECT DISTINCT lead_id FROM lead_etapas
      WHERE org_id = ? AND para_stage_id IN (${marcas}) AND created_at BETWEEN ? AND ?`)
    .all(orgId, ...faixa, periodo.de, corte)) cand.add(r.lead_id);
  for (const r of db.prepare("SELECT id FROM leads WHERE org_id = ? AND created_at BETWEEN ? AND ?")
    .all(orgId, periodo.de, corte)) cand.add(r.id);
  // Venda registrada no período, de lead deste funil.
  for (const r of db.prepare("SELECT id FROM leads WHERE org_id = ? AND pipeline_id = ? AND sale_value IS NOT NULL AND sale_date BETWEEN ? AND ?")
    .all(orgId, pipelineId, periodo.de, corte)) cand.add(r.id);
  if (periodo.de <= COBERTURA_ETAPAS)
    for (const r of db.prepare("SELECT id FROM leads WHERE org_id = ? AND created_at < ?").all(orgId, COBERTURA_ETAPAS))
      cand.add(r.id);
  if (!cand.size) return base;

  // Os outros filtros (origem, campanha, imóvel) pela mesma peneira do painel.
  const { origem, source, campanha, campaign_id, produto_id } = filtros;
  const p = peneira(orgId, { origem, source, campanha, campaign_id, produto_id });
  const leads = emLotes([...cand], (m, lote) => db.prepare(
    `SELECT l.id, l.name, l.created_at, l.stage, l.stage_id, l.pipeline_id, l.assigned_to, l.sale_date, l.sale_value
     FROM leads l WHERE ${p.sql} AND l.id IN (${m})`).all(...p.args, ...lote));
  if (!leads.length) return base;
  const ids = leads.map(l => l.id);

  const eventos = new Map(), transfer = new Map();
  for (const e of emLotes(ids, (m, lote) => db.prepare(
    `SELECT lead_id, de_stage_id, para_stage_id, motivo, created_at FROM lead_etapas
     WHERE +org_id = ? AND lead_id IN (${m}) ORDER BY created_at, rowid`).all(orgId, ...lote))) {
    if (!eventos.has(e.lead_id)) eventos.set(e.lead_id, []);
    eventos.get(e.lead_id).push(e);
  }
  for (const t of emLotes(ids, (m, lote) => db.prepare(
    `SELECT lead_id, from_user_id, to_user_id, created_at FROM lead_transfers
     WHERE +org_id = ? AND lead_id IN (${m}) ORDER BY created_at, rowid`).all(orgId, ...lote))) {
    if (!transfer.has(t.lead_id)) transfer.set(t.lead_id, []);
    transfer.get(t.lead_id).push(t);
  }

  // Uma pessoa, várias (CETRO 04.1) ou a fila — união dentro da dimensão.
  const donosFiltro = listaDeDonos(filtros.responsavel);
  const filtroDono = donosFiltro.length ? new Set(donosFiltro.map(x => x === "fila" ? null : x)) : null;
  const inferir = !ehFunilDeSdr(orgId, pipelineId);
  const noPeriodo = (t) => t !== null && t >= periodo.de && t <= corte;
  const ehVenda = (m) => m.status_type === "ganho" || /\bvend(a|ido)\b/i.test(String(m.name || ""));
  const marcoEntrada = cfg.marcos[0].id;
  const ordem = new Map(cfg.marcos.map((m, i) => [m.id, i]));
  const desconhecidos = new Set();

  for (const l of leads) {
    const evs = eventos.get(l.id) || [];
    const trs = transfer.get(l.id) || [];
    /* Onde o lead começou: a etapa de origem da primeira mudança, ou a etapa
       atual quando ele nunca mudou. Lead anterior à cobertura começou "em
       data desconhecida, até 13/08/2026" — `t: null`. */
    const nasceuEm = evs.length ? evs[0].de_stage_id : l.stage_id;
    const alcances = [];
    if (nasceuEm) alcances.push({ stage: nasceuEm, t: l.created_at >= COBERTURA_ETAPAS ? l.created_at : null, motivo: "entrada" });
    let lacunas = 0;
    for (const e of evs) {
      if (e.para_stage_id) alcances.push({ stage: e.para_stage_id, t: e.created_at, motivo: e.motivo });
      else if (noPeriodo(e.created_at)) lacunas++;
    }

    // Todas as chegadas a cada marco, da vida inteira do lead, até o corte.
    const chegadas = new Map();
    const entrada = alcances.find(a => cfg.faixa.has(a.stage));
    if (entrada) {
      for (const a of alcances) {
        if (a.t === null || a.t > corte || !ordem.has(a.stage)) continue;
        if (!chegadas.has(a.stage)) chegadas.set(a.stage, []);
        chegadas.get(a.stage).push(a);
      }
      // A primeira entrada na faixa conta como chegada ao primeiro marco.
      if (entrada.t !== null && entrada.t <= corte) {
        const l0 = chegadas.get(marcoEntrada) || [];
        if (!l0.some(a => a.t <= entrada.t)) chegadas.set(marcoEntrada, [{ stage: marcoEntrada, t: entrada.t, motivo: entrada.motivo, pela_entrada: true }, ...l0]);
      }
      if (entrada.t === null && periodo.de <= COBERTURA_ETAPAS) base.semData.push({ lead: l });
    }

    /* O cliente que já comprou e voltou (18/11/2026): pôr de novo em "Vendido"
       quem tem a venda registrada FORA do período não é venda deste período —
       e não empurra proposta, visita e agendamento por tabela. */
    if (l.sale_date) for (const m of cfg.marcos)
      if (m.id !== marcoEntrada && ehVenda(m) && !noPeriodo(l.sale_date)) chegadas.delete(m.id);

    /* A ETAPA PULADA CONTA COMO PASSADA (07/11/2026) — no funil comercial. O
       lead que saiu de "Novo" direto para "Agendamento" foi qualificado:
       chegar a um marco conta também os de antes que ele ainda não tinha
       alcançado, na hora do salto. No funil de SDR as tentativas são
       independentes. */
    /* VENDA PELA DATA DE REGISTRO (18/11/2026, regra do Ali): a etapa de venda
       conta toda venda registrada no período, de lead deste funil, na data da
       venda. Vem ANTES da etapa pulada, para a venda puxar a proposta e o
       resto mesmo quando a data lançada é anterior à mudança de etapa, ou
       quando o card nunca foi arrastado para "Vendido". */
    const temVenda = !!(l.sale_date && noPeriodo(l.sale_date) && (chegadas.size || l.pipeline_id === pipelineId));
    if (temVenda) for (const m of cfg.marcos)
      if (m.id !== marcoEntrada && ehVenda(m)) chegadas.set(m.id, [{ stage: m.id, t: l.sale_date, motivo: "venda", venda: true }]);
    if (inferir) {
      let menor = Infinity, origem = null;
      for (let i = cfg.marcos.length - 1; i >= 0; i--) {
        const id = cfg.marcos[i].id;
        const lista = chegadas.get(id) || [];
        const real = lista.length ? lista.reduce((a, b) => (b.t < a.t ? b : a)) : null;
        if (real && real.t < menor) { menor = real.t; origem = real; }
        if (origem && (!real || real.t > menor)) {
          if (!chegadas.has(id)) chegadas.set(id, []);
          chegadas.get(id).push({ stage: id, t: menor, motivo: origem.motivo, inferida: true });
        }
      }
    }

    // Sem venda registrada no período, a etapa de venda não conta (o arrasto
    // sem registro já serviu, acima, para contar as etapas puladas).
    for (const m of cfg.marcos)
      if (m.id !== marcoEntrada && ehVenda(m) && !temVenda) chegadas.delete(m.id);

    /* CADA ETAPA PELA DATA EM QUE O LEAD CHEGOU NELA (18/11/2026, regra do Ali:
       "somente a etapa Lead conta a data em que o cliente entrou; todas as
       outras contam a data de entrada na etapa; a venda, a data de registro").
       Conta a PRIMEIRA chegada do lead à etapa, quando ela cai no período —
       quem entrou há três meses e foi qualificado nesta semana conta como
       qualificado nesta semana. */
    const contadas = new Map();
    const nunca = new Set();
    for (let i = 0; i < cfg.marcos.length; i++) {
      const m = cfg.marcos[i];
      const lista = chegadas.get(m.id) || [];
      if (!lista.length) continue;
      const pri = lista.reduce((a, b) => (b.t < a.t ? b : a));
      if (!noPeriodo(pri.t)) continue;
      let dono;
      if (pri.venda) dono = { conhecido: true, id: l.assigned_to || null };
      else dono = donoNaEntrada(l, trs, pri.t);
      if (filtroDono) {
        if (!dono.conhecido) { desconhecidos.add(l.id); continue; }
        if (!filtroDono.has(dono.id || null)) continue;
      }
      contadas.set(m.id, { ...pri, todas: lista.filter(a => a.t === pri.t || noPeriodo(a.t)), dono });
      if (i > 0) {
        const ant = chegadas.get(cfg.marcos[i - 1].id) || [];
        if (!ant.some(a => a.t <= pri.t)) nunca.add(m.id);
      }
    }
    /* O FUNIL DO PERÍODO NÃO TEM BURACO (18/11/2026, print do Ali: "cliente
       que passou por proposta não aparece na etapa proposta"). No funil
       comercial, o lead que chegou a uma etapa no período aparece também nas
       etapas de antes dela no MESMO período (menos o primeiro degrau, que é
       quem entrou): quem vendeu agora passou pela proposta deste funil, mesmo
       que a proposta tenha sido feita antes. Assim cada etapa nunca tem menos
       gente que a de baixo, e ninguém "chega sem passar pela anterior". */
    if (inferir) {
      let k = -1;
      for (let i = cfg.marcos.length - 1; i > 0; i--) if (contadas.has(cfg.marcos[i].id)) { k = i; break; }
      for (let j = k - 1; j >= 1; j--) {
        const id = cfg.marcos[j].id;
        if (contadas.has(id)) continue;
        const acima = contadas.get(cfg.marcos[j + 1].id);
        contadas.set(id, { stage: id, t: acima.t, motivo: acima.motivo, inferida: true, no_caminho: true, todas: [acima], dono: acima.dono });
        nunca.delete(id);
      }
      for (let j = 1; j <= k; j++) nunca.delete(cfg.marcos[j].id);
    }
    if (!contadas.size) continue;
    const c0 = contadas.get(marcoEntrada);
    base.unidades.push({
      lead: l, entrada: c0 ? c0.t : null, entrada_motivo: c0 ? c0.motivo : null,
      dono: c0 ? c0.dono : (contadas.values().next().value.dono),
      chegadas: contadas, nunca, lacunas,
    });
  }
  for (const id of desconhecidos) {
    const l = leads.find(x => x.id === id);
    if (l && !base.unidades.some(u => u.lead.id === id)) base.donoDesconhecido.push({ lead: l, entrada: null });
  }
  return base;
}

/* Quem estava com o lead quando ele entrou. Antes de 01/09/2026 as trocas de
   dono não eram todas registradas — dono anterior a isso é "desconhecido". */
function donoNaEntrada(l, trs, t) {
  if (t < COBERTURA_DONOS && l.created_at < COBERTURA_DONOS) return { conhecido: false, id: null };
  let dono = trs.length ? trs[0].from_user_id : l.assigned_to;
  for (const tr of trs) {
    if (tr.created_at <= t + MESMA_OPERACAO_MS) dono = tr.to_user_id;
    else break;
  }
  return { conhecido: true, id: dono || null };
}

// Para cada unidade: chegou ao marco NO PERÍODO? quando?
const primeira = (u, etapaId) => { const c = u.chegadas.get(etapaId); return c ? c.t : null; };
const veioDaAnterior = (u, atual) => primeira(u, atual) !== null && !u.nunca.has(atual);
const taxa = (parte, total) => (total ? (parte / total) * 100 : null);

/* ===== O TOPO: OS RECEBIDOS, E COMO ELES FECHAM COM O PRIMEIRO DEGRAU =====
   (28/10/2026; refeito em 25/11/2026, pedido do Ali: "as contas não estão
   batendo" — Visão geral 1.325 recebidos, funil 1.281)

   Os recebidos do funil são EXATAMENTE os do cartão "Leads recebidos" da
   Visão geral, com os mesmos filtros — inclusive o FUNIL (antes este topo
   ignorava o funil escolhido e contava a conta inteira). A conta é a mesma
   `coorte`: lead criado no período que está neste funil (para pessoas, o que
   chegou na mão delas no período).

   O primeiro degrau é outra pergunta (quem ENTROU no comercial no período), e
   por isso os dois números diferem. A diferença agora vem aberta, e fecha:
     recebidos − ainda não entraram + recebidos antes que entraram agora
       = primeiro degrau. */
function recebidosDoFunil(orgId, pipelineId, filtros, periodo, corte) {
  const { responsavel, origem, source, campanha, campaign_id, produto_id } = filtros || {};
  const donos = listaDeDonos(responsavel);
  const pessoas = donos.filter(x => x !== "fila");
  const resto = { pipeline_id: pipelineId, origem, source, campanha, campaign_id, produto_id };
  if (!donos.length) {
    const p = peneira(orgId, resto);
    return db.prepare(`SELECT l.id FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ?`).all(...p.args, periodo.de, corte).map(r => r.id);
  }
  // Pessoas (uma ou várias) e/ou a fila — união (CETRO 04.1), como no cartão.
  const set = new Set();
  if (pessoas.length) for (const e of recebidosDaPessoa(orgId, pessoas, resto, periodo.de, corte)) set.add(e.lead_id);
  if (donos.includes("fila")) {
    const p = peneira(orgId, resto);
    for (const r of db.prepare(`SELECT l.id FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ? AND l.assigned_to IS NULL`)
      .all(...p.args, periodo.de, corte)) set.add(r.id);
  }
  return [...set];
}


/* QUEM DOS RECEBIDOS CHEGOU AO COMERCIAL (25/11/2026, print do Ali: "333
   recebidos · 99 chegaram a Lead · 234 não chegaram"). O primeiro degrau
   responde UMA pergunta: dos leads recebidos no período, quantos já chegaram
   à etapa Lead (ou depois dela) até o corte — não importa QUANDO nem com QUEM
   estavam ao chegar. Antes a conta exigia que a chegada fosse no período e
   com a pessoa do filtro, e o lead que a fila/IA pôs em Lead antes de passar
   à Blanca aparecia como "não chegou", estando na coluna Lead do Kanban. */
function entraramNoComercial(orgId, cfg, pipelineId, ids, corte) {
  const ok = new Set();
  if (!ids.length || cfg.sem_marcos) return ok;
  const etapas = db.prepare("SELECT id, ordem, status_type FROM pipeline_stages WHERE org_id = ? AND pipeline_id = ?").all(orgId, pipelineId);
  const posEntrada = etapas.find(e => e.id === cfg.entrada.id)?.ordem ?? 0;
  const vale = new Set(etapas.filter(e => e.status_type !== "perdido" && (e.ordem ?? 0) >= posEntrada).map(e => e.id));
  for (const id of cfg.faixa) vale.add(id);
  if (!vale.size) return ok;
  const lista = [...vale]; const marcas = lista.map(() => "?").join(",");
  for (const r of emLotes(ids, (m, lote) => db.prepare(
    `SELECT DISTINCT lead_id FROM lead_etapas WHERE +org_id = ? AND lead_id IN (${m}) AND para_stage_id IN (${marcas}) AND created_at <= ?`)
    .all(orgId, ...lote, ...lista, corte))) ok.add(r.lead_id);
  // Onde nasceu (a etapa de origem da primeira mudança, ou a atual se nunca mudou).
  for (const r of emLotes(ids, (m, lote) => db.prepare(
    `SELECT l.id, l.stage_id, l.sale_date, l.pipeline_id,
       (SELECT e.de_stage_id FROM lead_etapas e WHERE e.lead_id = l.id ORDER BY e.created_at, e.rowid LIMIT 1) nasceu
     FROM leads l WHERE l.org_id = ? AND l.id IN (${m})`).all(orgId, ...lote))) {
    const nasceu = r.nasceu || r.stage_id;
    if (nasceu && vale.has(nasceu)) ok.add(r.id);
    if (r.sale_date && r.sale_date <= corte && r.pipeline_id === pipelineId) ok.add(r.id);
  }
  return ok;
}

function topoDoFunil(cfg, ids, base0, periodo, corte) {
  // Antes de 14/08/2026 não há histórico de etapas: quem entrou sem data fica
  // fora do degrau, e a conta não fecharia — sem a linha, em vez de subcontar.
  if (cfg.sem_marcos || periodo.de < COBERTURA_ETAPAS || periodo.de > corte) return null;
  const entraram = base0.size;
  return {
    chegaram: ids.length,
    entraram,
    ainda_nao: ids.length - entraram,
    de_antes: 0,
    taxa: taxa(entraram, ids.length),
  };
}

/* ===== A RESPOSTA PARA AS TELAS ===== */
export function funilDeConversao(orgId, pipelineId, filtros = {}, agora = Date.now()) {
  const c = calcular(orgId, pipelineId, filtros, agora);
  if (c.erro) return c;
  const { cfg, unidades, periodo, corte } = c;
  /* O PRIMEIRO DEGRAU É DOS RECEBIDOS NO PERÍODO (25/11/2026, pedido do Ali:
     "entrou quantos leads no período no funil, e quantos avançaram para a
     etapa Lead?"). Regra de 18/11: só a primeira etapa conta pela data em que
     o cliente entrou. O lead recebido antes do período que chegou à etapa
     agora não conta mais aqui. Antes de 14/08/2026 (sem histórico) fica a
     regra antiga. */
  const recIds = periodo.de >= COBERTURA_ETAPAS ? new Set(recebidosDoFunil(orgId, pipelineId, filtros, periodo, corte)) : null;
  const base0 = recIds ? entraramNoComercial(orgId, cfg, pipelineId, [...recIds], corte)
    : new Set(unidades.filter(u => u.entrada !== null).map(u => u.lead.id));
  const daCoorte = (u) => base0.has(u.lead.id);
  const n = base0.size;

  /* CADA ETAPA PELO PERÍODO (18/11/2026): "chegaram" é quantos chegaram à
     etapa no período, venham de quando vierem. "Desde a entrada" divide pelo
     primeiro degrau do período e "da etapa anterior" pelo degrau de cima do
     período — são leituras de VOLUME do período, e podem passar de 100% (uma
     semana com muitos agendamentos de leads antigos). */
  const linhas = cfg.marcos.map((m, i) => {
    const chegaram = i === 0 ? [...base0] : unidades.filter(u => primeira(u, m.id) !== null);
    const linha = {
      id: m.id, name: m.name, color: m.color, status_type: m.status_type,
      papel: i === 0 ? "entrada" : "marco",
      chegaram: chegaram.length,
      desde_entrada: i === 0 ? (n ? 100 : null) : taxa(chegaram.length, n),
      anterior: null, sem_passar_pela_anterior: 0,
      por_regra_automatica: 0,
    };
    if (i > 0) {
      const ant = cfg.marcos[i - 1];
      const naAnterior = i === 1 ? [...base0] : unidades.filter(u => primeira(u, ant.id) !== null);
      const vieram = chegaram.filter(u => veioDaAnterior(u, m.id)).length;
      linha.anterior = { id: ant.id, name: ant.name, chegaram: naAnterior.length, vieram, taxa: taxa(chegaram.length, naAnterior.length) };
      linha.sem_passar_pela_anterior = chegaram.length - vieram;
      linha.por_regra_automatica = chegaram.filter(u =>
        (u.chegadas.get(m.id).todas || [u.chegadas.get(m.id)]).every(x => MOTIVOS_AUTOMATICOS.has(x.motivo))).length;
    }
    return linha;
  });

  /* Por pessoa: quem estava com o lead quando ele chegou ao primeiro degrau
     (base) e quando chegou ao último (a venda: o dono da venda, como no
     Painel). "Sem responsável" é a fila. */
  const nomes = new Map(db.prepare("SELECT id, name FROM users WHERE org_id = ?").all(orgId).map(u => [u.id, u.name]));
  const grupos = new Map();
  const ultimo = cfg.marcos[cfg.marcos.length - 1];
  const grupo = (dono) => {
    const chave = !dono || !dono.conhecido ? "desconhecido" : (dono.id || "sem");
    if (!grupos.has(chave)) grupos.set(chave, {
      id: chave === "desconhecido" || chave === "sem" ? null : chave,
      grupo: chave === "desconhecido" ? "desconhecido" : chave === "sem" ? "sem_responsavel" : "pessoa",
      nome: chave === "desconhecido" ? "Dono desconhecido"
        : chave === "sem" ? "Sem responsável" : (nomes.get(chave) || "Pessoa removida"),
      base: 0, chegaram_ao_ultimo: 0,
    });
    return grupos.get(chave);
  };
  const comUnidade = new Set();
  for (const u of unidades) {
    const c0 = u.chegadas.get(cfg.marcos[0].id);
    // Base por pessoa = com quem o lead ESTÁ (a regra do Kanban, 25/11/2026).
    if (daCoorte(u)) { comUnidade.add(u.lead.id); grupo({ conhecido: true, id: u.lead.assigned_to || null }).base++; }
    const cu = ultimo && cfg.marcos.length > 1 ? u.chegadas.get(ultimo.id) : null;
    if (cu) grupo(cu.dono).chegaram_ao_ultimo++;
  }
  const faltam = [...base0].filter(id => !comUnidade.has(id));
  for (const r of emLotes(faltam, (m, lote) => db.prepare(`SELECT assigned_to FROM leads WHERE org_id = ? AND id IN (${m})`).all(orgId, ...lote)))
    grupo({ conhecido: true, id: r.assigned_to || null }).base++;
  const porResponsavel = [...grupos.values()].sort((a, b) => b.base - a.base);

  const semDono = c.donoDesconhecido.length;
  const lacunas = unidades.filter(u => u.lacunas > 0).length;
  const avisos = [...cfg.avisos];
  if (periodo.de < COBERTURA_ETAPAS)
    avisos.push("O período começa antes de 14/08/2026, quando o histórico de etapas passou a ser gravado. Entradas anteriores aparecem como \"sem data\", fora da base.");
  if (c.semData.length)
    avisos.push(`${c.semData.length} lead(s) entraram antes de 14/08/2026, sem a data no histórico — não contam no primeiro degrau.`);
  if (c.donoDesconhecido.length)
    avisos.push(`${c.donoDesconhecido.length} lead(s) avançaram antes de 02/09/2026, quando as trocas de dono passaram a ser registradas — não dá para dizer de quem eram, e ficam fora deste filtro.`);
  if (lacunas)
    avisos.push(`${lacunas} lead(s) têm mudança de etapa sem a etapa identificada (histórico antigo): podem ter passado por etapas que a conta não enxerga.`);

  return {
    pipeline_id: pipelineId, pipeline: c.pipeline.name, unidade: "lead",
    periodo: { de: periodo.de, ate: periodo.ate, rotulo: periodo.rotulo }, corte,
    corte_no_fim_do_periodo: corte === periodo.ate,
    entrada: cfg.entrada ? { id: cfg.entrada.id, name: cfg.entrada.name, configurada: cfg.configurada } : null,
    sem_marcos: cfg.sem_marcos,
    // Funil comercial: a etapa pulada conta como passada (ver `calcular`).
    etapa_pulada_conta: !ehFunilDeSdr(orgId, pipelineId),
    base: n,
    topo: recIds ? topoDoFunil(cfg, [...recIds], base0, periodo, corte) : null,
    linhas,
    por_responsavel: porResponsavel,
    cobertura: {
      historico_desde: COBERTURA_ETAPAS, donos_desde: COBERTURA_DONOS,
      periodo_comeca_antes: periodo.de < COBERTURA_ETAPAS,
      entrada_sem_data: c.semData.length,
      dono_desconhecido: filtros.responsavel ? c.donoDesconhecido.length : semDono,
      com_lacunas: lacunas,
    },
    avisos,
  };
}

/* ===== A CONFERÊNCIA =====

   Quem está por trás de cada número: clicar em "6 de 8" lista os 8 e marca
   os 6. Sai do MESMO cálculo — uma lista montada com outra consulta poderia
   não bater com o número ao lado, e a conferência existe para isso. */
export const CONJUNTOS = ["base", "recebidos", "ainda_nao", "de_antes", "chegaram", "anterior", "vieram", "sem_anterior", "automaticas", "sem_data", "dono_desconhecido"];

function itensDosIds(orgId, ids, unidades) {
  const porId = new Map(unidades.map(u => [u.lead.id, u]));
  const sem = ids.filter(id => !porId.has(id));
  const linhas = new Map(emLotes(sem, (m, lote) =>
    db.prepare(`SELECT id, name, created_at FROM leads WHERE org_id = ? AND id IN (${m})`).all(orgId, ...lote)).map(l => [l.id, l]));
  return ids.map(id => porId.get(id) || (linhas.get(id) && { lead: linhas.get(id), entrada: null, dono: null, recebido_em: linhas.get(id).created_at })).filter(Boolean);
}

export function conferenciaDoFunil(orgId, pipelineId, filtros = {}, { etapa, conjunto = "base", pagina = 1, porPagina = 50, quem = null, supervisor = false } = {}, agora = Date.now()) {
  if (!CONJUNTOS.includes(conjunto)) return { erro: "Conjunto desconhecido." };
  const c = calcular(orgId, pipelineId, filtros, agora);
  if (c.erro) return c;
  const { cfg, unidades } = c;

  let lista;
  if (conjunto === "sem_data") lista = c.semData.map(x => ({ lead: x.lead, entrada: null, dono: null }));
  else if (conjunto === "dono_desconhecido") lista = c.donoDesconhecido.map(x => ({ lead: x.lead, entrada: x.entrada, dono: { conhecido: false } }));
  else if (["base", "recebidos", "ainda_nao", "de_antes"].includes(conjunto) || (conjunto === "chegaram" && etapa === cfg.marcos[0]?.id)) {
    // O primeiro degrau: dos recebidos, quem chegou ao comercial (a mesma
    // conta de funilDeConversao → entraramNoComercial).
    const comCoorte = c.periodo.de >= COBERTURA_ETAPAS;
    const ids = comCoorte ? recebidosDoFunil(orgId, pipelineId, filtros, c.periodo, c.corte) : unidades.filter(u => u.entrada !== null).map(u => u.lead.id);
    const entrou = comCoorte ? entraramNoComercial(orgId, cfg, pipelineId, ids, c.corte) : new Set(ids);
    const escolhidos = conjunto === "de_antes" ? []
      : conjunto === "recebidos" ? ids
      : conjunto === "ainda_nao" ? ids.filter(id => !entrou.has(id))
      : ids.filter(id => entrou.has(id));
    lista = itensDosIds(orgId, escolhidos, unidades);
  }
  else {
    const i = cfg.marcos.findIndex(m => m.id === etapa);
    if (i < 0) return { erro: "Esta etapa não é um marco do funil." };
    const m = cfg.marcos[i], ant = cfg.marcos[i - 1];
    if (conjunto !== "chegaram" && !ant) return { erro: "O início do processo comercial não tem etapa anterior." };
    const chegou = (u) => primeira(u, m.id) !== null;
    const filtro = {
      chegaram: chegou,
      anterior: (u) => primeira(u, ant.id) !== null,
      vieram: (u) => veioDaAnterior(u, m.id),
      sem_anterior: (u) => chegou(u) && !veioDaAnterior(u, m.id),
      automaticas: (u) => chegou(u) && (u.chegadas.get(m.id).todas || []).every(x => MOTIVOS_AUTOMATICOS.has(x.motivo)),
    }[conjunto];
    lista = unidades.filter(filtro);
    // A etapa de cima do segundo degrau é o primeiro degrau (ver acima).
    if (i === 1 && conjunto === "anterior" && c.periodo.de >= COBERTURA_ETAPAS) {
      const ids = recebidosDoFunil(orgId, pipelineId, filtros, c.periodo, c.corte);
      const entrou = entraramNoComercial(orgId, cfg, pipelineId, ids, c.corte);
      lista = itensDosIds(orgId, ids.filter(id => entrou.has(id)), unidades);
    }
  }

  const quando = (x) => (etapa && x.chegadas && primeira(x, etapa)) || x.entrada || x.recebido_em || 0;
  lista = [...lista].sort((a, b) => quando(b) - quando(a));
  const por = Math.min(Math.max(Number(porPagina) || 50, 1), 200);
  const pg = Math.max(Number(pagina) || 1, 1);
  const fatia = lista.slice((pg - 1) * por, pg * por);

  const nomes = new Map(db.prepare("SELECT id, name FROM users WHERE org_id = ?").all(orgId).map(u => [u.id, u.name]));
  const etapas = new Map(db.prepare("SELECT id, name FROM pipeline_stages WHERE org_id = ?").all(orgId).map(e => [e.id, e.name]));
  const atuais = new Map(emLotes(fatia.map(x => x.lead.id), (m, lote) =>
    db.prepare(`SELECT id, stage, stage_id, assigned_to FROM leads WHERE org_id = ? AND id IN (${m})`).all(orgId, ...lote))
    .map(l => [l.id, l]));

  return {
    conjunto, etapa: etapa || null, total: lista.length, pagina: pg, por_pagina: por,
    itens: fatia.map(x => {
      const atual = atuais.get(x.lead.id) || {};
      const chegouEm = etapa && x.chegadas ? primeira(x, etapa) : null;
      const donoAli = (etapa && x.chegadas && x.chegadas.get(etapa) && x.chegadas.get(etapa).dono) || x.dono;
      return {
        id: x.lead.id, name: x.lead.name,
        entrou_em: x.entrada || null,
        chegou_em: chegouEm,
        dono_na_entrada: donoAli && donoAli.conhecido
          ? { id: donoAli.id, nome: donoAli.id ? (nomes.get(donoAli.id) || "Pessoa removida") : "Sem responsável" }
          : null,
        etapa_atual: (atual.stage_id && etapas.get(atual.stage_id)) || atual.stage || null,
        responsavel_atual: atual.assigned_to ? (nomes.get(atual.assigned_to) || null) : null,
        // O corretor vê os leads da coorte dele, mas só abre a conversa de
        // quem continua com ele — a regra de sempre para abrir um lead.
        pode_abrir: supervisor || (!!quem && atual.assigned_to === quem),
      };
    }),
  };
}

/* ===== OS MARCOS DO PERÍODO, PARA TODAS AS TELAS (20/11/2026) =====
   Pedido do Ali: "tudo tem que estar unificado". Os cartões do relatório
   (qualificados, agendamentos, visitas, propostas), o Painel, o funil de
   atividades, o Score e a Visão geral contavam por uma conta própria
   (services/marcos.js: etapa pelo nome, uma vez na vida do lead, sem o
   nascimento), e o funil de conversão por outra. A Veronica tinha 20/11/6 nos
   cartões e 22/13/8 no funil logo abaixo.

   Agora existe UMA conta: a do funil de conversão (`calcular`), rodada em
   cada funil comercial da conta (os de SDR ficam de fora). Cada etapa-degrau
   do funil vira o marco do nome dela; o lead conta UMA vez por marco no
   período (a primeira chegada entre os funis), para quem estava com ele
   quando chegou. Por construção: com a pessoa num funil só, os cartões são
   os números do funil; com vários funis, os cartões são a soma sem repetir o
   lead. Quem vendeu no período passa por todos os marcos (sem buraco),
   inclusive o lead que não está em funil comercial nenhum.

   Devolve { qualificado, agendado, visita, proposta } → lista de
   { lead, t, user_id, conhecido, inferido }, sem filtro de pessoa (quem chama
   filtra). Guardado 30 s por conta+filtros+período, conferindo uma impressão
   do banco: Painel, Score e relatório pedem a mesma coisa várias vezes. */
const MEMO = new Map();
function impressao(orgId) {
  const a = db.prepare("SELECT COUNT(*) n, MAX(rowid) m FROM lead_etapas WHERE org_id = ?").get(orgId);
  const b = db.prepare("SELECT COUNT(*) n, MAX(versao) v, SUM(COALESCE(sale_date,0)) s FROM leads WHERE org_id = ?").get(orgId);
  const c = db.prepare("SELECT COUNT(*) n, MAX(rowid) m FROM lead_transfers WHERE org_id = ?").get(orgId);
  return [a.n, a.m, b.n, b.v, b.s, c.n, c.m].join(":");
}
export function marcosDoPeriodo(orgId, filtros = {}, de, ate, agora = Date.now()) {
  const { responsavel, periodo: _p, de: _d, ate: _a, ...resto } = filtros || {};
  const chave = JSON.stringify([orgId, resto, de, ate]);
  const imp = impressao(orgId);
  const m = MEMO.get(chave);
  if (m && m.imp === imp && agora - m.em < 30000) return m.res;

  const interna = ehInterna(orgId);
  const VENDA = MARCOS.indexOf("venda");
  const melhor = MARCOS.map(() => new Map());   // marco → lead → registro
  const pipes = (resto.pipeline_id ? [resto.pipeline_id]
    : db.prepare("SELECT id FROM pipelines WHERE org_id = ? ORDER BY created_at").all(orgId).map(r => r.id))
    .filter(pid => !ehFunilDeSdr(orgId, pid));
  for (const pid of pipes) {
    const c = calcular(orgId, pid, { ...resto, _periodo: { de, ate } }, agora);
    if (c.erro || !c.unidades) continue;
    const marcoDe = new Map(c.cfg.marcos.map(e => [e.id, marcoDoNome(e.name, { ganho: e.status_type === "ganho", interna })]));
    for (const u of c.unidades)
      for (const [sid, ch] of u.chegadas) {
        const k = marcoDe.get(sid);
        if (k === undefined || k < 0 || k === VENDA) continue;
        const atual = melhor[k].get(u.lead.id);
        if (atual && atual.t <= ch.t) continue;
        melhor[k].set(u.lead.id, { lead: u.lead.id, t: ch.t, user_id: ch.dono?.id ?? null,
          conhecido: !!ch.dono?.conhecido, inferido: !!(ch.inferida || ch.no_caminho) });
      }
  }
  // Sem buraco entre os marcos (e para a venda de lead fora dos funis).
  const p = peneira(orgId, resto);
  let acima = db.prepare(`SELECT l.id lead, l.sale_date t, l.assigned_to user_id FROM leads l
    WHERE ${p.sql} AND l.sale_value IS NOT NULL AND l.sale_date BETWEEN ? AND ?`).all(...p.args, de, Math.min(ate, agora))
    .map(v => ({ ...v, conhecido: true, inferido: false }));
  const res = {};
  for (const nome of ["proposta", "visita", "agendado", "qualificado"]) {
    const mapa = melhor[MARCOS.indexOf(nome)];
    for (const x of acima) if (!mapa.has(x.lead)) mapa.set(x.lead, { ...x, inferido: true });
    res[nome] = [...mapa.values()];
    acima = res[nome];
  }
  MEMO.set(chave, { imp, em: agora, res });
  if (MEMO.size > 300) MEMO.delete(MEMO.keys().next().value);
  return res;
}

/* Os de uma pessoa (ou várias, ou a fila). Dono desconhecido (antes de
   02/09/2026) não conta para pessoa nenhuma. */
export function marcosDeQuem(lista, quem) {
  if (!quem) return lista;
  const qs = new Set((Array.isArray(quem) ? quem : [quem]).map(x => x === "fila" ? null : x));
  return lista.filter(x => x.conhecido && qs.has(x.user_id ?? null));
}
