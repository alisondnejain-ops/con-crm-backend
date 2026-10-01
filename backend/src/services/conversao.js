/* FUNIL DE CONVERSÃO POR COORTE — a conta única do ConHub (01/10/2026).

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
      Quem chega a uma etapa sem ter passado pela anterior NÃO vira passagem
      inventada: entra no detalhe como "chegou sem passar pela anterior".

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
import { etapasDoPipeline, pipelinePorId } from "./pipelines.js";
import { peneira, resolverPeriodo } from "./painel.js";

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

  const conversao = ativas.filter(e => e.counts_as_conversion && e.status_type !== "perdido");
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

  const periodo = resolverPeriodo(filtros);
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
  if (periodo.de <= COBERTURA_ETAPAS)
    for (const r of db.prepare("SELECT id FROM leads WHERE org_id = ? AND created_at < ?").all(orgId, COBERTURA_ETAPAS))
      cand.add(r.id);
  if (!cand.size) return base;

  // Os outros filtros (origem, campanha, imóvel) pela mesma peneira do painel.
  const { origem, source, campanha, campaign_id, produto_id } = filtros;
  const p = peneira(orgId, { origem, source, campanha, campaign_id, produto_id });
  const leads = emLotes([...cand], (m, lote) => db.prepare(
    `SELECT l.id, l.name, l.created_at, l.stage, l.stage_id, l.assigned_to, l.sale_date, l.sale_value
     FROM leads l WHERE ${p.sql} AND l.id IN (${m})`).all(...p.args, ...lote));
  if (!leads.length) return base;
  const ids = leads.map(l => l.id);

  const eventos = new Map(), transfer = new Map();
  for (const e of emLotes(ids, (m, lote) => db.prepare(
    `SELECT lead_id, de_stage_id, para_stage_id, motivo, created_at FROM lead_etapas
     WHERE org_id = ? AND lead_id IN (${m}) ORDER BY created_at, rowid`).all(orgId, ...lote))) {
    if (!eventos.has(e.lead_id)) eventos.set(e.lead_id, []);
    eventos.get(e.lead_id).push(e);
  }
  for (const t of emLotes(ids, (m, lote) => db.prepare(
    `SELECT lead_id, from_user_id, to_user_id, created_at FROM lead_transfers
     WHERE org_id = ? AND lead_id IN (${m}) ORDER BY created_at, rowid`).all(orgId, ...lote))) {
    if (!transfer.has(t.lead_id)) transfer.set(t.lead_id, []);
    transfer.get(t.lead_id).push(t);
  }

  const filtroDono = filtros.responsavel || null;
  for (const l of leads) {
    const evs = eventos.get(l.id) || [];
    /* Onde o lead começou: a etapa de origem da primeira mudança, ou a etapa
       atual quando ele nunca mudou. Lead anterior à cobertura começou "em
       data desconhecida, até 13/08/2026" — `t: null`. */
    const nasceuEm = evs.length ? evs[0].de_stage_id : l.stage_id;
    const alcances = [];
    if (nasceuEm) alcances.push({ stage: nasceuEm, t: l.created_at >= COBERTURA_ETAPAS ? l.created_at : null, motivo: "entrada" });
    let lacunas = [];   // momentos de mudanças cuja etapa não se sabe
    for (const e of evs) {
      if (e.para_stage_id) alcances.push({ stage: e.para_stage_id, t: e.created_at, motivo: e.motivo });
      else lacunas.push(e.created_at);
    }
    if (evs.length && !nasceuEm) lacunas.unshift(l.created_at >= COBERTURA_ETAPAS ? l.created_at : -Infinity);

    const entrada = alcances.find(a => cfg.faixa.has(a.stage));
    if (!entrada) continue;

    /* Entrada sem data: não se sabe quando entrou (só que foi até 13/08).
       Uma mudança de etapa desconhecida ANTES da entrada pode ter sido a
       entrada de verdade: se todas as datas possíveis caem dentro do período,
       o lead é da coorte (só a data exata fica incerta, e a lacuna é avisada);
       se umas caem dentro e outras fora, não dá para dizer — "sem data". */
    const noPeriodo = (t) => t >= periodo.de && t <= corte;
    if (entrada.t === null) {
      if (periodo.de <= COBERTURA_ETAPAS) base.semData.push({ lead: l });
      continue;
    }
    const possiveis = [entrada.t, ...lacunas.filter(t => t <= entrada.t)];
    const dentro = possiveis.filter(noPeriodo).length;
    if (!dentro) continue;
    if (dentro < possiveis.length) { base.semData.push({ lead: l }); continue; }

    const dono = donoNaEntrada(l, transfer.get(l.id) || [], entrada.t);
    if (filtroDono) {
      if (!dono.conhecido) { base.donoDesconhecido.push({ lead: l, entrada: entrada.t }); continue; }
      const alvo = filtroDono === "fila" ? null : filtroDono;
      if ((dono.id || null) !== alvo) continue;
    }

    // As chegadas a cada marco entre a entrada e o corte.
    const chegadas = new Map();
    for (const a of alcances) {
      if (a.t === null || a.t < entrada.t || a.t > corte) continue;
      if (!chegadas.has(a.stage)) chegadas.set(a.stage, []);
      chegadas.get(a.stage).push(a);
    }
    // A entrada conta como chegada ao início do processo comercial.
    const marcoEntrada = cfg.marcos[0].id;
    if (!chegadas.has(marcoEntrada)) chegadas.set(marcoEntrada, [{ stage: marcoEntrada, t: entrada.t, motivo: entrada.motivo, pela_entrada: true }]);

    base.unidades.push({
      lead: l, entrada: entrada.t, entrada_motivo: entrada.motivo, dono, chegadas,
      lacunas: lacunas.filter(t => t <= corte).length,
    });
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

// Para cada unidade: chegou ao marco? quando, pela primeira vez?
const primeira = (u, etapaId) => {
  const c = u.chegadas.get(etapaId);
  return c && c.length ? Math.min(...c.map(x => x.t)) : null;
};
const veioDaAnterior = (u, atual, anterior) => {
  const t0 = primeira(u, anterior);
  if (t0 === null) return false;
  return (u.chegadas.get(atual) || []).some(x => x.t >= t0);
};
const taxa = (parte, total) => (total ? (parte / total) * 100 : null);

/* ===== A RESPOSTA PARA AS TELAS ===== */
export function funilDeConversao(orgId, pipelineId, filtros = {}, agora = Date.now()) {
  const c = calcular(orgId, pipelineId, filtros, agora);
  if (c.erro) return c;
  const { cfg, unidades, periodo, corte } = c;
  const n = unidades.length;

  const linhas = cfg.marcos.map((m, i) => {
    const chegaram = unidades.filter(u => primeira(u, m.id) !== null);
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
      const naAnterior = unidades.filter(u => primeira(u, ant.id) !== null);
      const vieram = naAnterior.filter(u => veioDaAnterior(u, m.id, ant.id)).length;
      linha.anterior = { id: ant.id, name: ant.name, chegaram: naAnterior.length, vieram, taxa: taxa(vieram, naAnterior.length) };
      linha.sem_passar_pela_anterior = chegaram.filter(u => !veioDaAnterior(u, m.id, ant.id)).length;
      // Chegou só por regra (palavra-chave, reanálise, automação) — nenhuma
      // pessoa confirmou a passagem por esta etapa.
      linha.por_regra_automatica = chegaram.filter(u =>
        (u.chegadas.get(m.id) || []).every(x => MOTIVOS_AUTOMATICOS.has(x.motivo))).length;
    }
    if (m.status_type === "ganho")
      linha.com_venda_registrada = chegaram.filter(u => u.lead.sale_date && u.lead.sale_date <= corte).length;
    return linha;
  });

  // Por dono na entrada. "Sem responsável" é a fila; desconhecido fica à parte.
  const nomes = new Map(db.prepare("SELECT id, name FROM users WHERE org_id = ?").all(orgId).map(u => [u.id, u.name]));
  const grupos = new Map();
  const ultimo = cfg.marcos[cfg.marcos.length - 1];
  for (const u of unidades) {
    const chave = !u.dono.conhecido ? "desconhecido" : (u.dono.id || "sem");
    if (!grupos.has(chave)) grupos.set(chave, {
      id: chave === "desconhecido" || chave === "sem" ? null : chave,
      grupo: chave === "desconhecido" ? "desconhecido" : chave === "sem" ? "sem_responsavel" : "pessoa",
      nome: chave === "desconhecido" ? "Dono na entrada desconhecido"
        : chave === "sem" ? "Sem responsável" : (nomes.get(chave) || "Pessoa removida"),
      base: 0, chegaram_ao_ultimo: 0,
    });
    const g = grupos.get(chave);
    g.base++;
    if (ultimo && primeira(u, ultimo.id) !== null) g.chegaram_ao_ultimo++;
  }
  const porResponsavel = [...grupos.values()].sort((a, b) => b.base - a.base);

  const semDono = unidades.filter(u => !u.dono.conhecido).length;
  const lacunas = unidades.filter(u => u.lacunas > 0).length;
  const avisos = [...cfg.avisos];
  if (periodo.de < COBERTURA_ETAPAS)
    avisos.push("O período começa antes de 14/08/2026, quando o histórico de etapas passou a ser gravado. Entradas anteriores aparecem como \"sem data\", fora da base.");
  if (c.semData.length)
    avisos.push(`${c.semData.length} lead(s) podem ter entrado no período, mas a data da entrada não está no histórico — ficam fora da base.`);
  if (c.donoDesconhecido.length)
    avisos.push(`${c.donoDesconhecido.length} lead(s) entraram antes de 02/09/2026, quando as trocas de dono passaram a ser registradas — não dá para dizer de quem eram na entrada, e ficam fora deste filtro.`);
  if (lacunas)
    avisos.push(`${lacunas} lead(s) da base têm mudança de etapa sem a etapa identificada (histórico antigo): podem ter passado por etapas que a conta não enxerga.`);

  return {
    pipeline_id: pipelineId, pipeline: c.pipeline.name, unidade: "lead",
    periodo: { de: periodo.de, ate: periodo.ate, rotulo: periodo.rotulo }, corte,
    corte_no_fim_do_periodo: corte === periodo.ate,
    entrada: cfg.entrada ? { id: cfg.entrada.id, name: cfg.entrada.name, configurada: cfg.configurada } : null,
    sem_marcos: cfg.sem_marcos,
    base: n,
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
export const CONJUNTOS = ["base", "chegaram", "anterior", "vieram", "sem_anterior", "automaticas", "sem_data", "dono_desconhecido"];

export function conferenciaDoFunil(orgId, pipelineId, filtros = {}, { etapa, conjunto = "base", pagina = 1, porPagina = 50, quem = null, supervisor = false } = {}, agora = Date.now()) {
  if (!CONJUNTOS.includes(conjunto)) return { erro: "Conjunto desconhecido." };
  const c = calcular(orgId, pipelineId, filtros, agora);
  if (c.erro) return c;
  const { cfg, unidades } = c;

  let lista;
  if (conjunto === "sem_data") lista = c.semData.map(x => ({ lead: x.lead, entrada: null, dono: null }));
  else if (conjunto === "dono_desconhecido") lista = c.donoDesconhecido.map(x => ({ lead: x.lead, entrada: x.entrada, dono: { conhecido: false } }));
  else if (conjunto === "base") lista = unidades;
  else {
    const i = cfg.marcos.findIndex(m => m.id === etapa);
    if (i < 0) return { erro: "Esta etapa não é um marco do funil." };
    const m = cfg.marcos[i], ant = cfg.marcos[i - 1];
    if (conjunto !== "chegaram" && !ant) return { erro: "O início do processo comercial não tem etapa anterior." };
    const chegou = (u) => primeira(u, m.id) !== null;
    const filtro = {
      chegaram: chegou,
      anterior: (u) => primeira(u, ant.id) !== null,
      vieram: (u) => primeira(u, ant.id) !== null && veioDaAnterior(u, m.id, ant.id),
      sem_anterior: (u) => chegou(u) && !veioDaAnterior(u, m.id, ant.id),
      automaticas: (u) => chegou(u) && (u.chegadas.get(m.id) || []).every(x => MOTIVOS_AUTOMATICOS.has(x.motivo)),
    }[conjunto];
    lista = unidades.filter(filtro);
  }

  lista = [...lista].sort((a, b) => (b.entrada || 0) - (a.entrada || 0));
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
      return {
        id: x.lead.id, name: x.lead.name,
        entrou_em: x.entrada || null,
        chegou_em: chegouEm,
        dono_na_entrada: x.dono && x.dono.conhecido
          ? { id: x.dono.id, nome: x.dono.id ? (nomes.get(x.dono.id) || "Pessoa removida") : "Sem responsável" }
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
