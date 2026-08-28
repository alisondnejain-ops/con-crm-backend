/* PAINEL DE GESTAO: filtros, metricas, funil e campanha (28/08/2026).

   O relatório que existia respondia a uma pergunta só — "como foi o mês da
   imobiliária inteira". A gestão faz outras: como foi a semana DA MARINA, o
   que a campanha de setembro trouxe, quantos leads estão abandonados agora.

   TRES REGRAS QUE VALEM MAIS QUE AS CONTAS

   1. NUMERO QUE NAO EXISTE VOLTA COMO ZERO OU null, NUNCA INVENTADO.
      Onde o dado não é coletado, a resposta é `null` e a tela escreve "não
      disponível". Zero e "não sei" são coisas diferentes: a primeira é um
      fato, a segunda é uma lacuna, e trocar uma pela outra faz o gestor tomar
      decisão sobre um número que ninguém mediu.

   2. CONVERSAO E AVANCO OPERACIONAL SAO DUAS LEITURAS, NAO UMA.
      O funil de conversão usa só as etapas marcadas `counts_as_conversion`; o
      avanço operacional mostra todas. Etapa administrativa — "Documentação",
      "Análise" — é trabalho necessário que não é degrau de venda, e contá-la
      como conversão faz o relatório dizer que a operação converteu quando ela
      só juntou papel.

   3. TODA CONTA RESPEITA OS MESMOS FILTROS.
      Foi o defeito corrigido em 13/08/2026 no score, e ele volta fácil: uma
      métrica que ignora o período escolhido devolve um número que não bate com
      o de cima, e ninguém consegue dizer qual dos dois está certo. */

import db from "../db.js";
import { semMaster } from "../auth.js";
import { etapasDoPipeline, listarPipelines, formatarEtapa } from "./pipelines.js";
import { slaDoLead } from "./etapas.js";

const DIA = 86400000;

/* ===== PERIODOS =====

   Os atalhos que a tela oferece, resolvidos no SERVIDOR. Ficavam no navegador
   antes, e isso dava um problema silencioso: o "mês atual" do aparelho do
   corretor em outro fuso não era o mesmo do relatório, e os dois números
   pareciam divergir sem motivo. */
export function resolverPeriodo({ periodo, de, ate } = {}) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const fim = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
  const t = hoje.getTime();

  switch (periodo) {
    case "hoje": return { de: t, ate: fim(t), rotulo: "hoje" };
    case "ontem": return { de: t - DIA, ate: fim(t - DIA), rotulo: "ontem" };
    case "semana": {
      // Semana começa no domingo, como no calendário brasileiro.
      const inicio = t - hoje.getDay() * DIA;
      return { de: inicio, ate: fim(t), rotulo: "esta semana" };
    }
    case "mes": {
      const i = new Date(hoje); i.setDate(1);
      return { de: i.getTime(), ate: fim(t), rotulo: "este mês" };
    }
    case "90dias": return { de: t - 90 * DIA, ate: fim(t), rotulo: "últimos 90 dias" };
    case "ano": {
      const i = new Date(hoje); i.setMonth(0, 1);
      return { de: i.getTime(), ate: fim(t), rotulo: "este ano" };
    }
    default: {
      const inicio = de ? new Date(`${de}T00:00:00`).getTime() : t - 30 * DIA;
      const termino = ate ? new Date(`${ate}T23:59:59.999`).getTime() : fim(t);
      return { de: isFinite(inicio) ? inicio : t - 30 * DIA,
               ate: isFinite(termino) ? termino : fim(t), rotulo: "período escolhido" };
    }
  }
}

/* ===== A PENEIRA =====

   Monta o WHERE a partir dos filtros. Um lugar só, usado por todas as contas —
   é o que garante a regra 3. */
function peneira(orgId, f = {}) {
  const where = ["l.org_id = ?"], args = [orgId];
  if (f.pipeline_id) { where.push("l.pipeline_id = ?"); args.push(f.pipeline_id); }
  if (f.stage_id) { where.push("l.stage_id = ?"); args.push(f.stage_id); }
  if (f.responsavel === "fila") where.push("l.assigned_to IS NULL");
  else if (f.responsavel) { where.push("l.assigned_to = ?"); args.push(f.responsavel); }
  if (f.origem) { where.push("l.origem = ?"); args.push(f.origem); }
  if (f.source) { where.push("l.source = ?"); args.push(f.source); }
  if (f.campanha) { where.push("l.campaign_name = ?"); args.push(f.campanha); }
  if (f.campaign_id) { where.push("l.campaign_id = ?"); args.push(f.campaign_id); }
  if (f.produto_id) { where.push("l.produto_id = ?"); args.push(f.produto_id); }
  return { sql: where.join(" AND "), args };
}

// Leads que ENTRARAM no período (coorte). É a base de "recebidos" e da conversão.
function coorte(orgId, { de, ate }, f) {
  const p = peneira(orgId, f);
  return db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ?`)
    .all(...p.args, de, ate);
}

/* ===== METRICAS DE ATENDIMENTO ===== */

/* Primeira resposta DE QUEM ESTA COM O LEAD, e não a primeira de qualquer um.

   Regra de 14/08/2026: `leads.first_resp_at` guarda a primeira resposta de
   QUALQUER pessoa, e quem fala primeiro é a atendente — o corretor aparecia
   com o tempo dela. Aqui a conta é a mesma da tela: da atribuição do lead até
   a primeira mensagem escrita pelo responsável. */
function temposDeResposta(leads) {
  const tempos = [];
  let responderam = 0;
  for (const l of leads) {
    if (!l.assigned_to) continue;
    const base = l.assigned_at || l.created_at;
    const primeira = db.prepare(`SELECT MIN(created_at) q FROM messages
      WHERE lead_id = ? AND direction = 'out' AND from_user_id = ? AND created_at >= ?`)
      .get(l.id, l.assigned_to, base)?.q;
    if (!primeira) continue;
    responderam++;
    tempos.push(Math.max(0, Math.round((primeira - base) / 60000)));
  }
  tempos.sort((a, b) => a - b);
  return {
    mediana: tempos.length ? tempos[Math.floor(tempos.length / 2)] : null,
    media: tempos.length ? Math.round(tempos.reduce((s, t) => s + t, 0) / tempos.length) : null,
    responderam,
  };
}

// Quantos leads o CLIENTE respondeu depois de a imobiliária falar.
function respostaDoCliente(leads) {
  let responderam = 0;
  for (const l of leads) {
    const houve = db.prepare(`SELECT 1 FROM messages m WHERE m.lead_id = ? AND m.direction = 'in'
      AND m.created_at > (SELECT MIN(created_at) FROM messages WHERE lead_id = ? AND direction = 'out')
      LIMIT 1`).get(l.id, l.id);
    if (houve) responderam++;
  }
  return responderam;
}

export const pct = (parte, total) => (total ? Math.round((parte / total) * 1000) / 10 : 0);

/* ===== O PAINEL ===== */
export function painel(orgId, filtros = {}) {
  const periodo = resolverPeriodo(filtros);
  const recebidos = coorte(orgId, periodo, filtros);
  const p = peneira(orgId, filtros);

  // Foto do agora: onde os leads estão neste instante, sem recorte de período.
  const agoraLeads = db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql}`).all(...p.args);
  const etapas = new Map(db.prepare("SELECT * FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .map(e => [e.id, formatarEtapa(e)]));

  const agora = Date.now();
  let vencidos = 0, emAviso = 0, semInteracao = 0, semSla = 0;
  for (const l of agoraLeads) {
    const s = l.stage_id ? slaDoLead(etapas.get(l.stage_id), l, agora) : null;
    if (!s) { semSla++; } else if (s.status === "overdue") vencidos++;
    else if (s.status === "warning") emAviso++;
    // "Sem interação" não depende de SLA configurado: é ausência, não atraso.
    if (!l.last_interaction_at) semInteracao++;
  }

  const tempos = temposDeResposta(recebidos);
  const comDono = recebidos.filter(l => l.assigned_to).length;

  /* VENDA CONTA PELA DATA DA VENDA, não pela entrada do lead. Foi o furo
     corrigido em 10/08/2026: venda fechada hoje de um lead de junho não
     aparecia em "esta semana". */
  const vendas = db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql}
    AND l.sale_value IS NOT NULL AND l.sale_date BETWEEN ? AND ?`).all(...p.args, periodo.de, periodo.ate);

  return {
    periodo: { ...periodo, de_iso: new Date(periodo.de).toISOString().slice(0, 10),
               ate_iso: new Date(periodo.ate).toISOString().slice(0, 10) },
    filtros,
    atendimento: {
      recebidos: recebidos.length,
      com_responsavel: comDono,
      na_fila: recebidos.filter(l => !l.assigned_to).length,
      // `null` e não zero: sem ninguém respondido, não há tempo para medir.
      primeira_resposta_mediana_min: tempos.mediana,
      primeira_resposta_media_min: tempos.media,
      taxa_primeira_resposta: pct(tempos.responderam, comDono),
      taxa_resposta_cliente: pct(respostaDoCliente(recebidos), recebidos.length),
    },
    sla: {
      vencidos, em_aviso: emAviso, sem_interacao: semInteracao,
      /* Quantos leads estão FORA de qualquer medição. Sem este número, "3
         vencidos" parece ótimo numa base em que 300 não têm SLA configurado. */
      sem_sla_configurado: semSla,
      total_em_aberto: agoraLeads.length,
    },
    vendas: {
      quantidade: vendas.length,
      vgv: vendas.reduce((s, v) => s + (v.sale_value || 0), 0),
      ticket_medio: vendas.length
        ? Math.round(vendas.reduce((s, v) => s + (v.sale_value || 0), 0) / vendas.length) : null,
    },
    atividades: atividades(orgId, periodo, filtros),
  };
}

/* ===== ATIVIDADE POR PESSOA =====

   O CRM como ferramenta de gestão humana: quem está trabalhando, quanto, e com
   quantos leads parados na mão. */
export function atividades(orgId, periodo, filtros = {}) {
  const pessoas = db.prepare(`SELECT u.id, u.name, u.role FROM users u
    WHERE u.org_id = ? AND u.status = 'ativo'${semMaster("u")} ORDER BY u.name`).all(orgId);
  const etapas = new Map(db.prepare("SELECT * FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .map(e => [e.id, formatarEtapa(e)]));
  const agora = Date.now();

  return pessoas.map(u => {
    const p = peneira(orgId, { ...filtros, responsavel: u.id });
    const meus = db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql}`).all(...p.args);
    let vencidos = 0, semResposta = 0;
    for (const l of meus) {
      const s = l.stage_id ? slaDoLead(etapas.get(l.stage_id), l, agora) : null;
      if (s && s.status === "overdue") vencidos++;
      /* "Esperando resposta" é a última mensagem ser do cliente — mesma
         definição do alerta.js. Duas definições para a mesma frase fariam dois
         números diferentes na mesma tela. */
      const ultima = db.prepare("SELECT direction FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1").get(l.id);
      if (ultima && ultima.direction === "in") semResposta++;
    }
    const msgs = db.prepare(`SELECT COUNT(*) n FROM messages
      WHERE from_user_id = ? AND created_at BETWEEN ? AND ?`).get(u.id, periodo.de, periodo.ate).n;
    const ligacoes = db.prepare(`SELECT COUNT(*) n FROM ligacoes
      WHERE user_id = ? AND created_at BETWEEN ? AND ?`).get(u.id, periodo.de, periodo.ate).n;
    const tarefas = db.prepare(`SELECT COUNT(*) n FROM tarefas
      WHERE user_id = ? AND feito_em IS NOT NULL AND feito_em BETWEEN ? AND ?`).get(u.id, periodo.de, periodo.ate).n;
    const recebidosNoPeriodo = db.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${p.sql}
      AND COALESCE(l.assigned_at, l.created_at) BETWEEN ? AND ?`).get(...p.args, periodo.de, periodo.ate).n;

    return {
      id: u.id, nome: u.name, papel: u.role,
      leads_na_mao: meus.length,
      recebidos_no_periodo: recebidosNoPeriodo,
      sla_vencidos: vencidos,
      aguardando_resposta: semResposta,
      mensagens: msgs, ligacoes, tarefas_concluidas: tarefas,
    };
  });
}

/* ===== FUNIL DE CONVERSAO x AVANCO OPERACIONAL =====

   Duas leituras do mesmo pipeline, de propósito separadas.

   A) CONVERSAO — só as etapas marcadas como degrau comercial. Duas taxas:
      sobre a entrada (quantos dos que chegaram alcançaram esta etapa) e
      sequencial (quantos passaram da etapa anterior para esta). A segunda é a
      que mostra ONDE a operação trava.

   B) OPERACIONAL — todas as etapas, com quantos estão em cada uma agora, há
      quanto tempo em média, e quantos estouraram o SLA. Não é conversão: é
      onde o trabalho está parado. */
export function funil(orgId, pipelineId, filtros = {}) {
  const periodo = resolverPeriodo(filtros);
  const etapas = etapasDoPipeline(orgId, pipelineId);
  if (!etapas.length) return { erro: "Este funil não tem etapas ativas." };

  const p = peneira(orgId, { ...filtros, pipeline_id: pipelineId });
  const doPeriodo = db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ?`)
    .all(...p.args, periodo.de, periodo.ate);
  const emAberto = db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql}`).all(...p.args);

  /* QUEM alcançou cada etapa — o CONJUNTO de leads, não a contagem.

     A contagem sozinha produzia um número impossível: "conversão sequencial de
     300%". Ela saía de dividir a contagem de uma etapa pela da anterior, e as
     duas eram medidas de forma independente — nada garantia que quem chegou na
     segunda tivesse passado pela primeira. Numa base real isso é comum: lead
     importado já em "Proposta", lead que a equipe pula direto para "Visita".

     Taxa acima de 100% não é um arredondamento feio: é um número que ninguém
     reconhece, e um só deles faz o gestor parar de confiar na tela inteira.

     Com os conjuntos, a taxa sequencial passa a ser o que a frase promete —
     "dos que chegaram na etapa anterior, quantos também chegaram nesta" — e
     não pode passar de 100% porque é uma interseção.

     Vem do HISTÓRICO e não de onde o lead está agora: quem passou por Visita e
     hoje está em Venda continua tendo alcançado a Visita. */
  const ids = doPeriodo.map(l => l.id);
  const quemAlcancou = new Map();
  if (ids.length) {
    const marcadores = "?,".repeat(ids.length).slice(0, -1);
    for (const e of etapas) {
      const doHistorico = db.prepare(
        `SELECT DISTINCT lead_id FROM lead_etapas WHERE para = ? AND lead_id IN (${marcadores})`)
        .all(e.name, ...ids).map(r => r.lead_id);
      // Mais quem está na etapa AGORA: a base anterior a 13/08/2026 não tem
      // histórico, e sem isto ela apareceria como se nunca tivesse chegado.
      const agoraAqui = doPeriodo.filter(l => l.stage === e.name).map(l => l.id);
      quemAlcancou.set(e.id, new Set([...doHistorico, ...agoraAqui]));
    }
  } else {
    for (const e of etapas) quemAlcancou.set(e.id, new Set());
  }

  const agora = Date.now();
  const operacional = etapas.map(e => {
    const aqui = emAberto.filter(l => l.stage_id === e.id);
    const tempos = aqui.map(l => agora - (l.stage_entered_at || l.created_at)).sort((a, b) => a - b);
    let vencidos = 0;
    for (const l of aqui) { const s = slaDoLead(e, l, agora); if (s && s.status === "overdue") vencidos++; }
    return {
      id: e.id, name: e.name, color: e.color, status_type: e.status_type,
      counts_as_conversion: e.counts_as_conversion,
      leads_agora: aqui.length,
      // Mediana e não média: um lead esquecido há dois anos distorce a média
      // e faz a etapa inteira parecer parada.
      tempo_mediano_dias: tempos.length
        ? Math.round((tempos[Math.floor(tempos.length / 2)] / DIA) * 10) / 10 : null,
      sla_minutes: e.sla_minutes, sla_vencidos: vencidos,
    };
  });

  const degraus = etapas.filter(e => e.counts_as_conversion);
  let anteriores = new Set(ids);   // o degrau zero é a entrada
  const conversao = degraus.map(e => {
    const aqui = quemAlcancou.get(e.id) || new Set();
    // A interseção: destes, quantos vieram do degrau anterior.
    let vindos = 0;
    for (const id of aqui) if (anteriores.has(id)) vindos++;
    const linha = {
      id: e.id, name: e.name, color: e.color,
      alcancaram: aqui.size,
      taxa_sobre_entrada: pct(aqui.size, doPeriodo.length),
      /* Sequencial: dos que chegaram no degrau anterior, quantos também
         chegaram neste. É o que mostra ONDE trava — e não pode passar de 100%. */
      taxa_sequencial: pct(vindos, anteriores.size),
      /* Quem apareceu aqui sem ter passado pelo degrau anterior. Não é erro:
         é lead importado direto, ou etapa pulada pela equipe. Dito por escrito
         porque a diferença entre `alcancaram` e a taxa sequencial ficaria
         inexplicável sem ele. */
      entraram_por_fora: aqui.size - vindos,
    };
    anteriores = aqui;
    return linha;
  });

  return {
    pipeline_id: pipelineId,
    periodo: { ...periodo },
    entraram: doPeriodo.length,
    /* Dito por escrito: sem etapa marcada como conversão, o funil comercial
       não existe — e a tela precisa explicar isso em vez de mostrar um gráfico
       vazio que parece defeito. */
    conversao: degraus.length ? conversao : null,
    sem_degraus: !degraus.length,
    operacional,
  };
}

/* ===== CAMPANHA E ORIGEM =====

   O que liga marketing a resultado. Só existe para os leads que entraram
   DEPOIS de 28/08/2026 — antes disso a atribuição não era gravada, e a tela
   diz isso em vez de mostrar uma coluna "(sem campanha)" gigante como se
   fosse tráfego direto. */
export function campanhas(orgId, filtros = {}) {
  const periodo = resolverPeriodo(filtros);
  const p = peneira(orgId, filtros);
  const leads = db.prepare(`SELECT l.* FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ?`)
    .all(...p.args, periodo.de, periodo.ate);

  const grupos = new Map();
  for (const l of leads) {
    const chave = l.campaign_name || l.origem || "(sem origem registrada)";
    if (!grupos.has(chave)) grupos.set(chave, {
      campanha: chave, campaign_id: l.campaign_id || null, platform: l.platform || null,
      leads: [], anuncios: new Set(),
    });
    const g = grupos.get(chave);
    g.leads.push(l);
    if (l.ad_name) g.anuncios.add(l.ad_name);
  }

  const etapas = new Map(db.prepare("SELECT * FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .map(e => [e.id, formatarEtapa(e)]));

  const linhas = [...grupos.values()].map(g => {
    const tempos = temposDeResposta(g.leads);
    const qualificados = g.leads.filter(l => {
      const e = l.stage_id ? etapas.get(l.stage_id) : null;
      return e && e.counts_as_conversion;
    }).length;
    const vendidos = g.leads.filter(l => l.sale_value != null);
    return {
      campanha: g.campanha, campaign_id: g.campaign_id, platform: g.platform,
      anuncios: g.anuncios.size,
      leads: g.leads.length,
      qualificados, taxa_qualificacao: pct(qualificados, g.leads.length),
      primeira_resposta_mediana_min: tempos.mediana,
      taxa_resposta_cliente: pct(respostaDoCliente(g.leads), g.leads.length),
      vendas: vendidos.length,
      vgv: vendidos.reduce((s, v) => s + (v.sale_value || 0), 0),
    };
  }).sort((a, b) => b.leads - a.leads);

  const comAtribuicao = leads.filter(l => l.campaign_name).length;
  return {
    periodo,
    campanhas: linhas,
    /* Honestidade sobre a cobertura: dizer que 4 de 300 leads têm campanha é o
       que impede alguém de ler este painel como se fosse a operação inteira. */
    cobertura: {
      com_campanha: comAtribuicao, total: leads.length,
      pct: pct(comAtribuicao, leads.length),
      aviso: comAtribuicao < leads.length
        ? "Os leads anteriores a 28/08/2026 não têm campanha gravada — a atribuição passou a ser capturada nessa data."
        : null,
    },
  };
}

/* As opções que a tela oferece nos filtros, tiradas do que a base REALMENTE
   tem. Lista fixa mostraria campanha que nunca existiu e esconderia a que
   existe. */
export function opcoesDeFiltro(orgId) {
  const lista = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM leads WHERE org_id = ? AND ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`)
    .all(orgId).map(r => r.v);
  return {
    pipelines: listarPipelines(orgId).map(p => ({
      ...p, stages: etapasDoPipeline(orgId, p.id).map(e => ({ id: e.id, name: e.name })),
    })),
    pessoas: db.prepare(`SELECT u.id, u.name, u.role FROM users u
      WHERE u.org_id = ? AND u.status = 'ativo'${semMaster("u")} ORDER BY u.name`).all(orgId),
    origens: lista("origem"),
    campanhas: lista("campaign_name"),
    plataformas: lista("platform"),
    periodos: [
      { id: "hoje", rotulo: "Hoje" }, { id: "ontem", rotulo: "Ontem" },
      { id: "semana", rotulo: "Esta semana" }, { id: "mes", rotulo: "Este mês" },
      { id: "90dias", rotulo: "Últimos 90 dias" }, { id: "ano", rotulo: "Este ano" },
      { id: "custom", rotulo: "Escolher datas" },
    ],
  };
}
