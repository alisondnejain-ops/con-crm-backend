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

import db from "../db.js";
import { randomUUID } from "crypto";
import { semMaster } from "../auth.js";
import { resolverPeriodo, pct, peneira } from "./painel.js";

const DIA = 86400000;

/* ===== CONTADORES DE ATIVIDADE =====

   Cada um recebe `filtros` (o mesmo objeto de sempre) e um intervalo
   [de, ate]. `filtros.responsavel` vira a trava de QUEM PRATICOU, exceto em
   `contarLeads`/`somaVendas`, que usam `peneira()` (dono do lead). "fila" é
   sentinela só de dono — não faz sentido como "quem ligou", então nunca entra
   na trava de atividade. */
function condPessoa(filtros) {
  const r = filtros && filtros.responsavel;
  return r && r !== "fila" ? r : null;
}

function contarLigacoes(orgId, filtros, de, ate, apenasContato = false) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const where = [p.sql, "lg.created_at BETWEEN ? AND ?"];
  const args = [...p.args, de, ate];
  if (apenasContato) where.push("lg.resultado = 'falou'");
  const quem = condPessoa(filtros);
  if (quem) { where.push("lg.user_id = ?"); args.push(quem); }
  return db.prepare(`SELECT COUNT(*) n FROM ligacoes lg JOIN leads l ON l.id = lg.lead_id
    WHERE ${where.join(" AND ")}`).get(...args).n;
}

// paraEtapa é o texto gravado em lead_etapas.para — para Agendamento/Visita/
// Proposta isso é o NOME da etapa (mesma régua de `funil()`, que também casa
// por nome); para Venda é sempre literal, porque a rota de registrar venda
// grava "Venda" fixo, não o nome configurável de etapa alguma.
function contarEtapa(orgId, paraEtapa, filtros, de, ate) {
  const { responsavel, ...resto } = filtros || {};
  const p = peneira(orgId, resto);
  const where = [p.sql, "le.para = ?", "le.created_at BETWEEN ? AND ?"];
  const args = [...p.args, paraEtapa, de, ate];
  const quem = condPessoa(filtros);
  if (quem) { where.push("le.user_id = ?"); args.push(quem); }
  return db.prepare(`SELECT COUNT(*) n FROM lead_etapas le JOIN leads l ON l.id = le.lead_id
    WHERE ${where.join(" AND ")}`).get(...args).n;
}

function contarLeads(orgId, filtros, de, ate) {
  const p = peneira(orgId, filtros);
  return db.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${p.sql} AND l.created_at BETWEEN ? AND ?`)
    .get(...p.args, de, ate).n;
}

function somaVendas(orgId, filtros, de, ate) {
  const p = peneira(orgId, filtros);
  const vendas = db.prepare(`SELECT sale_value, sale_commission_pct FROM leads l
    WHERE ${p.sql} AND l.sale_value IS NOT NULL AND l.sale_date BETWEEN ? AND ?`).all(...p.args, de, ate);
  const vgv = vendas.reduce((s, v) => s + (v.sale_value || 0), 0);
  // VGC só soma vendas COM comissão preenchida — a régua de sempre: número
  // que ninguém mediu não vira zero, e aqui vira "de fora da conta", com a
  // cobertura escrita ao lado para não parecer que a conta está certa.
  const comComissao = vendas.filter(v => v.sale_commission_pct != null);
  const vgc = comComissao.reduce((s, v) => s + (v.sale_value * v.sale_commission_pct) / 100, 0);
  return { quantidade: vendas.length, vgv, vgc, vgc_com_comissao: comComissao.length };
}

/* ===== SÉRIE DIÁRIA (para a barra empilhada "Análise de funil") =====

   Sempre os últimos 14 dias terminando no fim do período escolhido (ou hoje,
   o que vier primeiro) — é uma janela de tendência de granularidade fixa, não
   o período inteiro do filtro. Trocar o período muda ONDE a janela termina,
   não quantos dias ela mostra. */
function serieDiaria(orgId, filtros, dias, periodo) {
  const fimBase = Math.min(periodo.ate, Date.now());
  const linhas = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fimDia = new Date(fimBase - i * DIA); fimDia.setHours(23, 59, 59, 999);
    const inicioDia = new Date(fimDia); inicioDia.setHours(0, 0, 0, 0);
    const de = inicioDia.getTime(), ate = fimDia.getTime();
    linhas.push({
      rotulo: `${String(inicioDia.getDate()).padStart(2, "0")}/${String(inicioDia.getMonth() + 1).padStart(2, "0")}`,
      leads: contarLeads(orgId, filtros, de, ate),
      ligacoes: contarLigacoes(orgId, filtros, de, ate),
      contato: contarLigacoes(orgId, filtros, de, ate, true),
      visita_agendada: contarEtapa(orgId, "Agendamento", filtros, de, ate),
      visita_realizada: contarEtapa(orgId, "Visita", filtros, de, ate),
      proposta: contarEtapa(orgId, "Proposta", filtros, de, ate),
      venda: somaVendas(orgId, filtros, de, ate).quantidade,
    });
  }
  return linhas;
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

  const leadsAtual = contarLeads(orgId, filtros, periodo.de, periodo.ate);
  const leadsAnterior = contarLeads(orgId, filtros, anterior.de, anterior.ate);

  const vAtual = somaVendas(orgId, filtros, periodo.de, periodo.ate);
  const vAnterior = somaVendas(orgId, filtros, anterior.de, anterior.ate);

  const visitasAtual = contarEtapa(orgId, "Visita", filtros, periodo.de, periodo.ate);
  const visitasAnterior = contarEtapa(orgId, "Visita", filtros, anterior.de, anterior.ate);

  const ticketAtual = vAtual.quantidade ? Math.round(vAtual.vgv / vAtual.quantidade) : null;
  const ticketAnterior = vAnterior.quantidade ? Math.round(vAnterior.vgv / vAnterior.quantidade) : null;

  const kpis = {
    vgv: comparativo(vAtual.vgv, vAnterior.vgv),
    ticket_medio: comparativo(ticketAtual, ticketAnterior),
    vgc: { ...comparativo(vAtual.vgc, vAnterior.vgc),
      cobertura: { com_comissao: vAtual.vgc_com_comissao, total: vAtual.quantidade } },
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
  const contatos = contarLigacoes(orgId, filtros, periodo.de, periodo.ate, true);
  const agendadas = contarEtapa(orgId, "Agendamento", filtros, periodo.de, periodo.ate);
  const propostas = contarEtapa(orgId, "Proposta", filtros, periodo.de, periodo.ate);

  const passos = [
    { id: "leads", nome: "Leads", valor: leadsAtual },
    { id: "ligacoes", nome: "Ligações", valor: ligacoes },
    { id: "contato", nome: "Contato", valor: contatos },
    { id: "visita_agendada", nome: "Visita Agendada", valor: agendadas },
    { id: "visita_realizada", nome: "Visitas Realizadas", valor: visitasAtual },
    { id: "proposta", nome: "Proposta", valor: propostas },
    { id: "venda", nome: "Vendas", valor: vAtual.quantidade },
  ];
  /* Duas colunas de porcentagem, como no painel de referência: SEQUENCIAL
     (sobre o degrau anterior — mostra onde trava) e SOBRE OS LEADS (sobre o
     primeiro degrau — mostra o funil inteiro de uma vez). O primeiro degrau
     não tem nenhuma das duas: não existe "degrau anterior" a Leads. */
  const funilAtividade = passos.map((p, i) => ({
    ...p,
    taxa_sequencial: i === 0 ? null : pct(p.valor, passos[i - 1].valor),
    taxa_sobre_leads: i === 0 ? null : pct(p.valor, passos[0].valor),
  }));

  return {
    periodo, filtros,
    kpis,
    funil_atividade: funilAtividade,
    serie: serieDiaria(orgId, filtros, 14, periodo),
  };
}

/* ===== METAS =====

   `user_id=''` é a sentinela "meta da operação inteira" (o gestor e a
   atendente veem esta). Um id real é a meta PESSOAL daquele corretor. As duas
   moram na mesma tabela porque são a mesma pergunta feita em duas escalas —
   e porque "atual e anterior mexem na mesma tabela" evita a armadilha de
   `pipeline_entrada` (regra escrita duas vezes que diverge). */
const ALVO_ORG = "";
const CAMPOS_META = ["ligacoes", "contatos", "visitas_agendadas", "visitas_realizadas", "propostas", "vgv"];
const NOMES_META = { ligacoes: "Ligações", contatos: "Contatos", visitas_agendadas: "Visitas Agendadas",
  visitas_realizadas: "Visitas Realizadas", propostas: "Propostas", vgv: "VGV" };

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
    db.prepare(`UPDATE metas SET ligacoes=?, contatos=?, visitas_agendadas=?, visitas_realizadas=?,
      propostas=?, vgv=?, updated_at=? WHERE id=?`).run(
      valores.ligacoes, valores.contatos, valores.visitas_agendadas, valores.visitas_realizadas,
      valores.propostas, valores.vgv, agora, existente.id);
    return { ok: true, id: existente.id };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO metas (id, org_id, user_id, mes, ligacoes, contatos, visitas_agendadas,
    visitas_realizadas, propostas, vgv, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, orgId, alvo, mes, valores.ligacoes, valores.contatos, valores.visitas_agendadas,
    valores.visitas_realizadas, valores.propostas, valores.vgv, agora, agora);
  return { ok: true, id };
}

/* Realizado do mês inteiro (não do período do filtro) — meta é cadência
   mensal por natureza, e misturar "meta de setembro" com "realizado dos
   últimos 7 dias" faria o progresso pular pra trás toda vez que o filtro de
   cima mudasse, sem a meta em si ter mudado. */
function realizadoDoMes(orgId, userId, mes) {
  const { de, ate } = limitesDoMes(mes);
  const filtros = userId ? { responsavel: userId } : {};
  return {
    ligacoes: contarLigacoes(orgId, filtros, de, ate),
    contatos: contarLigacoes(orgId, filtros, de, ate, true),
    visitas_agendadas: contarEtapa(orgId, "Agendamento", filtros, de, ate),
    visitas_realizadas: contarEtapa(orgId, "Visita", filtros, de, ate),
    propostas: contarEtapa(orgId, "Proposta", filtros, de, ate),
    vgv: somaVendas(orgId, filtros, de, ate).vgv,
  };
}

export function metasComRealizado(orgId, userId, mes) {
  mes = mes || mesAtual();
  const meta = obterMeta(orgId, userId, mes);
  const realizado = realizadoDoMes(orgId, userId, mes);
  return {
    mes,
    itens: CAMPOS_META.map(campo => {
      const alvo = meta ? meta[campo] : null;
      return {
        campo, nome: NOMES_META[campo],
        meta: alvo, realizado: realizado[campo],
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
