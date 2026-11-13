/* PAINEL GERAL — a tela de entrada, com os mesmos indicadores para toda
   conta (08/09/2026, pedido do Ali a partir do painel da Confidere Imóveis:
   "seria a mesma tela pra todas as contas... o corretor tem a mesma visão
   mas apenas com os seus indicadores, gestor ver a visão da operação toda
   assim como a da atendente").

   UMA TELA, TRÊS ESCOPOS. A rota (`painel.routes.js`) decide o escopo antes
   de chamar isto — sobrescreve `filtros.responsavel` com o próprio id de quem
   não supervisiona, do mesmo jeito que `/painel/funil/:pipelineId` já faz.
   Aqui dentro não existe "papel": existe só o filtro que chegou, e os mesmos
   sete números respondem para qualquer um.

   FUNIL DE ATIVIDADE x FUNIL DE ETAPAS — SÃO DUAS COISAS DIFERENTES.
   `funil()` em painel.js mede POR ONDE OS LEADS PASSARAM (conjuntos, sem
   contar duas vezes). Este aqui mede VOLUME DE AÇÃO no período — quantas
   ligações, quantos contatos — e por isso "Ligações" pode ser MAIOR que
   "Leads": um corretor liga várias vezes para o mesmo lead, liga para leads
   de meses atrás, etc. Comparar os dois funis como se fossem o mesmo número
   seria o erro que este projeto já corrigiu antes (a taxa sequencial de
   300%): aqui a régua é "quanta atividade aconteceu", não "quantos leads
   avançaram sem repetição".

   LIGAÇÕES E ETAPAS SÃO CONTADAS POR QUEM FEZ, NÃO POR QUEM É DONO DO LEAD
   HOJE — mesma régua que `atividades()` já usa em painel.js (`ligacoes WHERE
   user_id=?`). "Os meus indicadores" do corretor são as ações que ELE
   praticou; um lead repassado depois de uma ligação continua contando a
   ligação para quem ligou. LEADS é a exceção: lead não tem "quem praticou",
   tem dono — por isso usa `peneira()` (que filtra por `assigned_to`) como
   todo o resto do painel.

   VENDAS/VGV/VGC USAM A MESMA CONTA DO RESTO DO SISTEMA (dono do lead +
   `sale_date`, não `lead_etapas`) — é a conta que `painel()` já usa para o
   card de vendas. Duas contas diferentes para a palavra "vendas" na mesma
   tela era exatamente o tipo de redundância que a auditoria de 08/09/2026
   mandou reduzir. */

import { etapasDeContagem } from "./interno.js";
import db from "../db.js";
import { randomUUID } from "crypto";
import { semMaster } from "../auth.js";
import { resolverPeriodo, pct, peneira, recebidosDaPessoa, pessoasDoFiltro, marcasSql, listaDeDonos } from "./painel.js";
import { eventosDeAtribuicao } from "./movimento.js";
import { semDisparo } from "./marca-disparo.js";
import { ASSINATURA_ROBO } from "./robo.js";
import { listarPipelines, etapasDoPipeline } from "./pipelines.js";
import { alcancesNoPeriodo, candidatosDoPeriodo, classificador, marcosDosLeads } from "./marcos.js";

const DIA = 86400000;

/* ===== CONTADORES DE ATIVIDADE =====

   Cada um recebe `filtros` (o mesmo objeto de sempre) e um intervalo
   [de, ate]. `filtros.responsavel` vira a trava de QUEM PRATICOU, exceto em
   `contarLeads` (quem RECEBEU, pelo histórico) e `somaVendas` (dono do lead,
   pela `peneira()`). "fila" é
   sentinela só de dono — não faz sentido como "quem ligou", então nunca entra
   na trava de atividade. */
// As pessoas do filtro (uma ou várias, CETRO 04.1); "fila" nunca entra aqui.
const condPessoa = (filtros) => pessoasDoFiltro(filtros);

/* Cada contador tem duas formas: `momentos*` devolve os INSTANTES em que a
   coisa aconteceu, e o contador é só o tamanho da lista. Assim o gráfico de 14
   dias faz UMA consulta por indicador para a janela inteira e separa os dias
   aqui, em vez de 7 consultas por dia (eram ~100 a cada abertura do Painel, a
   tela de entrada de todo mundo — 25/09/2026). A conta continua uma só. */
function momentosDeLigacao(orgId, filtros, de, ate, apenasContato = false) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const where = [p.sql, "lg.created_at BETWEEN ? AND ?"];
  const args = [...p.args, de, ate];
  if (apenasContato) where.push("lg.resultado = 'falou'");
  const quem = condPessoa(filtros);
  if (quem) { where.push(`lg.user_id IN (${marcasSql(quem.length)})`); args.push(...quem); }
  return db.prepare(`SELECT lg.created_at t FROM ligacoes lg JOIN leads l ON l.id = lg.lead_id
    WHERE ${where.join(" AND ")}`).all(...args).map(r => r.t);
}
const contarLigacoes = (...a) => momentosDeLigacao(...a).length;

/* ===== OS DEGRAUS DE "QUANTAS PESSOAS" (28/10/2026, pedido do Fernando) =====

   Três degraus do funil de atividades contam LEADS DISTINTOS, não ações:
   "Leads trabalhados", "Pessoas faladas" e "Qualificadas". Cada função devolve
   pares {lead, t} — o lead e o instante da ação —, e quem conta tira os
   repetidos: no período inteiro, o lead conta uma vez; no gráfico de 14 dias,
   uma vez por dia.

   MENSAGEM DE GENTE = enviada, e não por disparo, automação nem pelo
   Autoatendimento. Com uma pessoa no filtro, só as que ELA escreveu
   (`from_user_id`) — a digitada no celular não tem autor e conta só para a casa. */
function msgsDeGente(orgId, filtros, de, ate) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const where = [p.sql, "m.direction = 'out'", "m.created_at BETWEEN ? AND ?", semDisparo("m."),
    `NOT (m.from_user_id IS NULL AND COALESCE(m.from_name, '') = '${ASSINATURA_ROBO}')`];
  const args = [...p.args, de, ate];
  const quem = condPessoa(filtros);
  if (quem) { where.push(`m.from_user_id IN (${marcasSql(quem.length)})`); args.push(...quem); }
  return db.prepare(`SELECT m.lead_id lead, m.created_at t FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE ${where.join(" AND ")}`).all(...args);
}
function ligacoesComLead(orgId, filtros, de, ate, apenasContato = false) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const where = [p.sql, "lg.created_at BETWEEN ? AND ?"];
  const args = [...p.args, de, ate];
  if (apenasContato) where.push("lg.resultado = 'falou'");
  const quem = condPessoa(filtros);
  if (quem) { where.push(`lg.user_id IN (${marcasSql(quem.length)})`); args.push(...quem); }
  return db.prepare(`SELECT lg.lead_id lead, lg.created_at t FROM ligacoes lg JOIN leads l ON l.id = lg.lead_id
    WHERE ${where.join(" AND ")}`).all(...args);
}
/* "UM POR LEAD POR DIA" (07/11/2026, pedido do Fernando). O lead trabalhado
   e a pessoa falada contam UMA VEZ POR DIA: falei com o João três vezes hoje
   é um lead trabalhado hoje; amanhã, se eu falar de novo, conta outro. A
   chave é lead + dia (no fuso do servidor), e o total do período é a soma dos
   dias — o mesmo número que o gráfico de 14 dias empilha. */
const diaDe = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const porLeadDia = (pares) => {
  const vistos = new Map();
  for (const x of pares) { const k = x.lead + "|" + diaDe(x.t); if (!vistos.has(k)) vistos.set(k, x); }
  return [...vistos.values()];
};

/* LEADS TRABALHADOS: quem a pessoa abordou — mandou mensagem ou ligou (o
   clique no Ligar do CRM). Mudar a etapa sem falar com o cliente não é
   abordar. Ligação feita fora do CRM, direto no celular, o sistema não vê. */
function trabalhados(orgId, filtros, de, ate) {
  return porLeadDia([...msgsDeGente(orgId, filtros, de, ate), ...ligacoesComLead(orgId, filtros, de, ate)]);
}

/* PESSOAS FALADAS: quem ATENDEU a ligação ou RESPONDEU a mensagem. Na
   mensagem, é o cliente escrevendo depois de uma mensagem da equipe (com uma
   pessoa no filtro, depois de uma mensagem DELA) — o "oi" de quem chega
   sozinho não é resposta a ninguém. Uma por lead por dia. */
function faladas(orgId, filtros, de, ate) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const quem = condPessoa(filtros);
  const anterior = `(SELECT o.from_user_id FROM messages o WHERE o.lead_id = m.lead_id AND o.direction = 'out'
      AND o.created_at < m.created_at AND ${semDisparo("o.")}
      AND NOT (o.from_user_id IS NULL AND COALESCE(o.from_name, '') = '${ASSINATURA_ROBO}')
      ORDER BY o.created_at DESC LIMIT 1)`;
  const temAnterior = `EXISTS (SELECT 1 FROM messages o WHERE o.lead_id = m.lead_id AND o.direction = 'out'
      AND o.created_at < m.created_at AND ${semDisparo("o.")}
      AND NOT (o.from_user_id IS NULL AND COALESCE(o.from_name, '') = '${ASSINATURA_ROBO}'))`;
  const responderam = db.prepare(`SELECT m.lead_id lead, m.created_at t FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE ${p.sql} AND m.direction = 'in' AND m.created_at BETWEEN ? AND ? AND ${quem ? `${anterior} IN (${marcasSql(quem.length)})` : temAnterior}`)
    .all(...p.args, de, ate, ...(quem || []));
  return porLeadDia([...ligacoesComLead(orgId, filtros, de, ate, true), ...responderam]);
}

/* QUALIFICADOS, AGENDADOS, VISITAS E PROPOSTAS: os MARCOS (services/marcos.js),
   uma vez por lead, com a etapa pulada contando como passada. Qualificado é
   quem chegou ao "Atendimento qualificado" (ou pulou direto para mais adiante)
   num funil que não é de SDR — não a etiqueta do SDR, não a resposta à IA. */
function alcances(orgId, filtros, de, ate, marco, ctx = {}) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const ids = candidatosDoPeriodo(orgId, p.sql, p.args, de, ate);
  const cls = ctx.cls || classificador(orgId);
  const chave = ids.join(",") ;
  if (!ctx.mapas) ctx.mapas = new Map();
  if (!ctx.mapas.has(chave)) ctx.mapas.set(chave, marcosDosLeads(orgId, ids, cls));
  return alcancesNoPeriodo(orgId, ids, marco, de, ate, { quem: condPessoa(filtros), mapa: ctx.mapas.get(chave) });
}

/* A etapa que diz que o lead está qualificado, PARA O SDR: a "Lead
   qualificado" do funil de SDR e toda etapa com "qualific" no nome. É a régua
   dos Indicadores do SDR — o Painel usa os marcos acima. */
export function etapasDeQualificacao(orgId) {
  const ids = new Set(), nomes = new Set();
  for (const pl of listarPipelines(orgId)) {
    for (const e of etapasDoPipeline(orgId, pl.id))
      if (/qualific/i.test(semAcentoTexto(e.name))) { ids.add(e.id); nomes.add(e.name); }
  }
  return { ids, nomes };
}
const semAcentoTexto = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const distintos = (pares) => new Set(pares.map(x => x.lead)).size;
/* Quantos destes leads foram contados porque PULARAM a etapa (o marco foi
   deduzido do salto, não visto). Vai escrito ao lado do número, numa linha
   discreta (decisão do Ali, 11/11/2026): sem isso, "10 agendados" com 3
   deduzidos parece 10 agendamentos que alguém fez. */
const inferidos = (pares) => new Set(pares.filter(x => x.inferido).map(x => x.lead)).size;

/* LEADS: para a casa, os que ENTRARAM no período. Para UMA pessoa, os que
   CHEGARAM NA MÃO DELA — a mesma conta de Relatórios e da Operação
   (`recebidosDaPessoa`). Antes era "criado no período e com ela hoje", e o
   lead repassado hoje, criado no mês passado, sumia do Painel do corretor
   enquanto aparecia na Produção dele. */
function momentosDeLeads(orgId, filtros, de, ate, eventos = null) {
  const quem = condPessoa(filtros);
  if (quem) {
    const ts = recebidosDaPessoa(orgId, quem, filtros, de, ate, eventos).map(e => e.quando);
    /* Pessoas E a fila marcadas juntas (CETRO 04.1): soma os que nasceram na
       fila no período — a mesma união da `coorte` da Operação. */
    if (listaDeDonos(filtros.responsavel).includes("fila")) {
      const { responsavel: _r, ...resto } = filtros;
      const p = peneira(orgId, resto);
      for (const r of db.prepare(`SELECT l.created_at t FROM leads l WHERE ${p.sql} AND l.assigned_to IS NULL AND l.created_at BETWEEN ? AND ?`)
        .all(...p.args, de, ate)) ts.push(r.t);
    }
    return ts;
  }
  const p = peneira(orgId, filtros);
  return db.prepare(`SELECT l.created_at t FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ?`)
    .all(...p.args, de, ate).map(r => r.t);
}
const contarLeads = (...a) => momentosDeLeads(...a).length;

function vendasDoPeriodo(orgId, filtros, de, ate) {
  const p = peneira(orgId, filtros);
  return db.prepare(`SELECT sale_value, sale_commission_pct, sale_date, sale_moeda FROM leads l
    WHERE ${p.sql} AND l.sale_value IS NOT NULL AND l.sale_date BETWEEN ? AND ?`).all(...p.args, de, ate);
}

function somaVendas(orgId, filtros, de, ate) {
  const vendas = vendasDoPeriodo(orgId, filtros, de, ate);
  const vgv = vendas.reduce((s, v) => s + (v.sale_moeda === "USD" ? 0 : (v.sale_value || 0)), 0);
  // VGC só soma vendas COM comissão preenchida — a régua de sempre: número
  // que ninguém mediu não vira zero, e aqui vira "de fora da conta", com a
  // cobertura escrita ao lado para não parecer que a conta está certa.
  const comComissao = vendas.filter(v => v.sale_commission_pct != null && v.sale_moeda !== "USD");
  const vgc = comComissao.reduce((s, v) => s + (v.sale_value * v.sale_commission_pct) / 100, 0);
  // Venda em dólar conta como venda, mas nunca entra somada ao VGV em real (moeda não se converte).
  const emDolar = vendas.filter(v => v.sale_moeda === "USD");
  return { quantidade: vendas.length, vgv, vgc, vgc_com_comissao: comComissao.length,
    em_dolar: emDolar.length ? { quantidade: emDolar.length, vgv: emDolar.reduce((s, v) => s + (v.sale_value || 0), 0) } : null };
}

/* ===== SÉRIE DIÁRIA (para a barra empilhada "Análise de funil") =====

   Sempre os últimos 14 dias terminando no fim do período escolhido (ou hoje,
   o que vier primeiro) — é uma janela de tendência de granularidade fixa, não
   o período inteiro do filtro. Trocar o período muda ONDE a janela termina,
   não quantos dias ela mostra. */
function serieDiaria(orgId, filtros, dias, periodo, eventos = null) {
  const fimBase = Math.min(periodo.ate, Date.now());
  const janelas = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fimDia = new Date(fimBase - i * DIA); fimDia.setHours(23, 59, 59, 999);
    const inicioDia = new Date(fimDia); inicioDia.setHours(0, 0, 0, 0);
    janelas.push({ de: inicioDia.getTime(), ate: fimDia.getTime(),
      rotulo: `${String(inicioDia.getDate()).padStart(2, "0")}/${String(inicioDia.getMonth() + 1).padStart(2, "0")}` });
  }
  const de = janelas[0].de, ate = janelas[janelas.length - 1].ate;
  // Distribui cada instante no seu dia. As janelas são contíguas e ordenadas.
  const porDia = (momentos) => {
    const n = janelas.map(() => 0);
    for (const t of momentos) {
      const i = janelas.findIndex(j => t >= j.de && t <= j.ate);
      if (i >= 0) n[i]++;
    }
    return n;
  };
  // Leads distintos por dia: o mesmo lead trabalhado três vezes num dia conta uma.
  const porDiaDistintos = (pares) => {
    const n = janelas.map(() => new Set());
    for (const x of pares) {
      const i = janelas.findIndex(j => x.t >= j.de && x.t <= j.ate);
      if (i >= 0) n[i].add(x.lead);
    }
    return n.map(s => s.size);
  };
  const ctx = {};
  const trab = porDiaDistintos(trabalhados(orgId, filtros, de, ate));
  const ligacoes = porDia(momentosDeLigacao(orgId, filtros, de, ate));
  const fal = porDiaDistintos(faladas(orgId, filtros, de, ate));
  const qual = porDiaDistintos(alcances(orgId, filtros, de, ate, "qualificado", ctx));
  const agendada = porDiaDistintos(alcances(orgId, filtros, de, ate, "agendado", ctx));
  const realizada = porDiaDistintos(alcances(orgId, filtros, de, ate, "visita", ctx));
  const proposta = porDiaDistintos(alcances(orgId, filtros, de, ate, "proposta", ctx));
  const venda = porDia(vendasDoPeriodo(orgId, filtros, de, ate).map(v => v.sale_date));
  return janelas.map((j, i) => ({
    rotulo: j.rotulo,
    trabalhados: trab[i], ligacoes: ligacoes[i], faladas: fal[i], qualificadas: qual[i],
    visita_agendada: agendada[i], visita_realizada: realizada[i],
    proposta: proposta[i], venda: venda[i],
  }));
}

function variacao(atual, anterior) {
  const a = atual || 0, b = anterior || 0;
  // Sem base de comparação, a variação é `null` ("sem dado"), não "+100%" nem
  // "0%" — os dois inventariam uma leitura que o período anterior não dá.
  if (!b) return a ? null : 0;
  return Math.round(((a - b) / b) * 1000) / 10;
}
const comparativo = (atual, anterior) => ({ atual, anterior, variacao_pct: variacao(atual, anterior) });

/* ===== A TELA DE ENTRADA ===== */
export function visaoGeral(orgId, filtros = {}) {
  const periodo = resolverPeriodo(filtros);
  const duracao = periodo.ate - periodo.de;
  // Período anterior: mesma duração, imediatamente antes — comparação justa
  // mesmo quando o gestor escolhe um intervalo customizado.
  const anterior = { de: periodo.de - duracao - 1, ate: periodo.de - 1 };

  // O histórico de atribuição é lido uma vez e serve às três contas de leads.
  const eventos = condPessoa(filtros) ? eventosDeAtribuicao(orgId) : null;
  const leadsAtual = contarLeads(orgId, filtros, periodo.de, periodo.ate, eventos);
  const leadsAnterior = contarLeads(orgId, filtros, anterior.de, anterior.ate, eventos);

  const vAtual = somaVendas(orgId, filtros, periodo.de, periodo.ate);
  const vAnterior = somaVendas(orgId, filtros, anterior.de, anterior.ate);

  /* Imobiliária conta a visita ao imóvel; o ambiente interno do CETRO, a
     demonstração do sistema. Mesma conta, outro nome de etapa. */
  const nomes = etapasDeContagem(orgId);
  const ctx = {};
  const visitasAtual = distintos(alcances(orgId, filtros, periodo.de, periodo.ate, "visita", ctx));
  const visitasAnterior = distintos(alcances(orgId, filtros, anterior.de, anterior.ate, "visita", ctx));

  // Ticket em real: divide só pelas vendas em real (a em dólar não está no VGV).
  const emReal = (v) => v.quantidade - (v.em_dolar?.quantidade || 0);
  const ticketAtual = emReal(vAtual) ? Math.round(vAtual.vgv / emReal(vAtual)) : null;
  const ticketAnterior = emReal(vAnterior) ? Math.round(vAnterior.vgv / emReal(vAnterior)) : null;

  const kpis = {
    vgv: { ...comparativo(vAtual.vgv, vAnterior.vgv), em_dolar: vAtual.em_dolar },
    ticket_medio: comparativo(ticketAtual, ticketAnterior),
    vgc: { ...comparativo(vAtual.vgc, vAnterior.vgc),
      cobertura: { com_comissao: vAtual.vgc_com_comissao, total: emReal(vAtual) } },
    vendas: comparativo(vAtual.quantidade, vAnterior.quantidade),
    leads: comparativo(leadsAtual, leadsAnterior),
    // "Lead em venda": das duas populações (leads que ENTRARAM no período,
    // vendas que FECHARAM no período) — a mesma mistura que `painel()` já usa
    // para VGV/ticket, documentada lá: venda conta pela data da venda, não
    // pela entrada do lead.
    lead_em_venda_pct: comparativo(pct(vAtual.quantidade, leadsAtual), pct(vAnterior.quantidade, leadsAnterior)),
    // "Visitas" = visita ao imóvel (confirmação do Ali) — mesma contagem do
    // degrau "Visita Realizada" do funil de atividade logo abaixo.
    visitas: comparativo(visitasAtual, visitasAnterior),
  };

  const ligacoes = contarLigacoes(orgId, filtros, periodo.de, periodo.ate);
  const aQual = alcances(orgId, filtros, periodo.de, periodo.ate, "qualificado", ctx);
  const aAgend = alcances(orgId, filtros, periodo.de, periodo.ate, "agendado", ctx);
  const aVisita = alcances(orgId, filtros, periodo.de, periodo.ate, "visita", ctx);
  const aProp = alcances(orgId, filtros, periodo.de, periodo.ate, "proposta", ctx);
  const agendadas = distintos(aAgend);
  const propostas = distintos(aProp);

  /* O CATÁLOGO DO "ESCOLHER INDICADORES" (13/11/2026, especificação CETRO
     06.2): os mesmos números do funil de atividades logo abaixo, com o
     período anterior de mesma duração ao lado. Um número, uma conta. */
  const ant = (fn) => fn(anterior.de, anterior.ate);
  kpis.qualificados = comparativo(distintos(aQual), ant((de, ate) => distintos(alcances(orgId, filtros, de, ate, "qualificado", ctx))));
  kpis.agendamentos = comparativo(agendadas, ant((de, ate) => distintos(alcances(orgId, filtros, de, ate, "agendado", ctx))));
  kpis.ligacoes = comparativo(ligacoes, ant((de, ate) => contarLigacoes(orgId, filtros, de, ate)));
  kpis.faladas = comparativo(faladas(orgId, filtros, periodo.de, periodo.ate).length, ant((de, ate) => faladas(orgId, filtros, de, ate).length));
  kpis.propostas = comparativo(propostas, ant((de, ate) => distintos(alcances(orgId, filtros, de, ate, "proposta", ctx))));

  /* Os oito degraus do Fernando (28/10/2026, revistos em 07/11/2026).
     Trabalhados e faladas contam LEAD POR DIA; qualificados, agendados,
     visitas e propostas contam LEAD UMA VEZ (o marco, com a etapa pulada
     contando); ligações contam cliques; vendas, as vendas registradas. */
  const passos = [
    { id: "trabalhados", nome: "Leads trabalhados", valor: trabalhados(orgId, filtros, periodo.de, periodo.ate).length },
    { id: "ligacoes", nome: "Ligações", valor: ligacoes },
    { id: "faladas", nome: "Pessoas faladas", valor: faladas(orgId, filtros, periodo.de, periodo.ate).length },
    { id: "qualificadas", nome: "Qualificados", valor: distintos(aQual), pulados: inferidos(aQual) },
    { id: "visita_agendada", nome: nomes.agendada === "Agendamento" ? "Agendados" : "Demonstrações agendadas", valor: agendadas, pulados: inferidos(aAgend) },
    { id: "visita_realizada", nome: nomes.realizada === "Visita" ? "Visitas" : "Demonstrações feitas", valor: visitasAtual, pulados: inferidos(aVisita) },
    { id: "proposta", nome: "Propostas", valor: propostas, pulados: inferidos(aProp) },
    { id: "venda", nome: "Vendas", valor: vAtual.quantidade },
  ];
  /* Duas colunas de porcentagem: SEQUENCIAL (sobre o degrau anterior — mostra
     onde trava) e SOBRE OS TRABALHADOS (sobre o primeiro degrau). O primeiro
     degrau não tem nenhuma das duas. */
  const funilAtividade = passos.map((p, i) => ({
    ...p,
    taxa_sequencial: i === 0 ? null : pct(p.valor, passos[i - 1].valor),
    taxa_sobre_leads: i === 0 ? null : pct(p.valor, passos[0].valor),
  }));

  return {
    periodo, filtros,
    kpis,
    funil_atividade: funilAtividade,
    serie: serieDiaria(orgId, filtros, 14, periodo, eventos),
  };
}

/* ===== METAS =====

   `user_id=''` é a sentinela "meta da operação inteira" (o gestor e a
   atendente veem esta). Um id real é a meta PESSOAL daquele corretor. As duas
   moram na mesma tabela porque são a mesma pergunta feita em duas escalas —
   e porque "atual e anterior mexem na mesma tabela" evita a armadilha de
   `pipeline_entrada` (regra escrita duas vezes que diverge). */
const ALVO_ORG = "";
/* A sequência das metas (13/11/2026, especificação CETRO 06.4): a ordem do
   trabalho, terminando em vendas em quantidade e vendas em VGV, separadas. */
const CAMPOS_META = ["trabalhados", "ligacoes", "contatos", "qualificados", "visitas_agendadas",
  "visitas_realizadas", "propostas", "vendas", "vgv"];
const NOMES_META = { trabalhados: "Leads trabalhados", ligacoes: "Ligações", contatos: "Pessoas faladas",
  qualificados: "Qualificados", visitas_agendadas: "Agendamentos", visitas_realizadas: "Visitas",
  propostas: "Propostas", vendas: "Vendas (quantidade)", vgv: "Vendas (VGV)" };

export function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function limitesDoMes(mes) {
  const [ano, m] = String(mes).split("-").map(Number);
  return {
    de: new Date(ano, m - 1, 1, 0, 0, 0, 0).getTime(),
    ate: new Date(ano, m, 0, 23, 59, 59, 999).getTime(),
  };
}

export function obterMeta(orgId, userId, mes) {
  return db.prepare("SELECT * FROM metas WHERE org_id = ? AND user_id = ? AND mes = ?")
    .get(orgId, userId || ALVO_ORG, mes) || null;
}

export function salvarMeta(orgId, userId, mes, dados = {}) {
  if (!/^\d{4}-\d{2}$/.test(mes || "")) return { erro: "Escolha o mês da meta." };
  const alvo = userId || ALVO_ORG;
  const existente = obterMeta(orgId, alvo, mes);
  const valores = {};
  for (const campo of CAMPOS_META) {
    const v = dados[campo];
    if (v === undefined) { valores[campo] = existente ? existente[campo] : null; continue; }
    if (v === null || v === "") { valores[campo] = null; continue; }
    const n = Number(String(v).replace(",", "."));
    if (!isFinite(n) || n < 0) return { erro: `Valor inválido para "${NOMES_META[campo] || campo}".` };
    valores[campo] = n;
  }
  const agora = Date.now();
  if (existente) {
    db.prepare(`UPDATE metas SET ${CAMPOS_META.map(c => c + "=?").join(", ")}, updated_at=? WHERE id=?`)
      .run(...CAMPOS_META.map(c => valores[c]), agora, existente.id);
    return { ok: true, id: existente.id };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO metas (id, org_id, user_id, mes, ${CAMPOS_META.join(", ")}, created_at, updated_at)
    VALUES (?,?,?,?,${CAMPOS_META.map(() => "?").join(",")},?,?)`)
    .run(id, orgId, alvo, mes, ...CAMPOS_META.map(c => valores[c]), agora, agora);
  return { ok: true, id };
}

/* Realizado do mês inteiro (não do período do filtro) — meta é cadência
   mensal por natureza, e misturar "meta de setembro" com "realizado dos
   últimos 7 dias" faria o progresso pular pra trás toda vez que o filtro de
   cima mudasse, sem a meta em si ter mudado. */
function realizadoDoMes(orgId, userId, mes) {
  const { de, ate } = limitesDoMes(mes);
  const filtros = userId ? { responsavel: userId } : {};
  /* As metas leem os MESMOS degraus do funil de atividades (07/11/2026):
     "Contatos" são as pessoas faladas (lead por dia) e as visitas e
     propostas são os marcos. Meta com outra conta mostraria uma barra que
     não bate com o número logo abaixo dela. */
  const ctx = {};
  const vendas = somaVendas(orgId, filtros, de, ate);
  return {
    trabalhados: trabalhados(orgId, filtros, de, ate).length,
    ligacoes: contarLigacoes(orgId, filtros, de, ate),
    contatos: faladas(orgId, filtros, de, ate).length,
    qualificados: distintos(alcances(orgId, filtros, de, ate, "qualificado", ctx)),
    visitas_agendadas: distintos(alcances(orgId, filtros, de, ate, "agendado", ctx)),
    visitas_realizadas: distintos(alcances(orgId, filtros, de, ate, "visita", ctx)),
    propostas: distintos(alcances(orgId, filtros, de, ate, "proposta", ctx)),
    vendas: vendas.quantidade,
    vgv: vendas.vgv,
  };
}

export function metasComRealizado(orgId, userId, mes) {
  mes = mes || mesAtual();
  /* Várias pessoas no filtro (CETRO 04.1): a meta é a SOMA das metas
     pessoais de cada uma — campo que ninguém do grupo definiu continua "não
     definido" — e o realizado é o do grupo (união). */
  let meta;
  if (Array.isArray(userId)) {
    const ms = userId.map(u => obterMeta(orgId, u, mes)).filter(Boolean);
    meta = ms.length ? Object.fromEntries(CAMPOS_META.map(c => {
      const vs = ms.map(m => m[c]).filter(v => v != null);
      return [c, vs.length ? vs.reduce((a, b) => a + b, 0) : null];
    })) : null;
  } else meta = obterMeta(orgId, userId, mes);
  const realizado = realizadoDoMes(orgId, userId, mes);
  const interna = etapasDeContagem(orgId).realizada !== "Visita";
  const nomeDe = (campo) => interna
    ? ({ visitas_agendadas: "Demonstrações agendadas", visitas_realizadas: "Demonstrações feitas", vgv: "Vendas (valor)" }[campo] || NOMES_META[campo])
    : NOMES_META[campo];
  return {
    mes,
    itens: CAMPOS_META.map(campo => {
      const alvo = meta ? meta[campo] : null;
      return {
        campo, nome: nomeDe(campo),
        meta: alvo, realizado: realizado[campo],
        falta: alvo != null ? Math.max(alvo - realizado[campo], 0) : null,
        // Meta não definida é NULL, nunca 0% — a régua de sempre neste
        // painel: zero é um fato medido, não a ausência de meta.
        pct: (alvo != null && alvo > 0) ? Math.round((realizado[campo] / alvo) * 1000) / 10 : null,
      };
    }),
  };
}

// Tela de configuração do gestor: a meta da casa e a de cada corretor, lado a
// lado, para não precisar abrir uma pessoa de cada vez para montar o mês.
export function metasConfig(orgId, mes) {
  mes = mes || mesAtual();
  const corretores = db.prepare(`SELECT u.id, u.name FROM users u
    WHERE u.org_id = ? AND u.status = 'ativo' AND u.role = 'corretor'${semMaster("u")} ORDER BY u.name`)
    .all(orgId);
  return {
    mes,
    operacao: metasComRealizado(orgId, null, mes),
    corretores: corretores.map(c => ({ id: c.id, nome: c.name, ...metasComRealizado(orgId, c.id, mes) })),
  };
}
