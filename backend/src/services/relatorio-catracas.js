/* O RELATÓRIO DAS CATRACAS (12/10/2026, pedido do Ali: "um relatório individual
   de uma catraca que foi desativada, pra que todas elas fiquem organizadas e
   com os números completos dela, até pra comparação em relação ao
   autoatendimento").

   Uma linha por catraca — a principal, as ativas e as DESATIVADAS — com os
   mesmos números, para comparar lado a lado. Desativar uma catraca não apaga o
   vínculo dos leads (`leads.catraca_id` fica), e é ele que este relatório lê.

   AS REGRAS DA CONTA:
   - A base é COORTE: os leads que ENTRARAM no período (`created_at`). Venda,
     perda e resposta são desses leads, aconteçam quando acontecerem. É a
     pergunta "como foi a campanha de setembro", não "o que se vendeu em
     setembro" — essa é a do Painel, e a tela escreve a diferença.
   - A catraca do lead é a de HOJE. O CRM não guarda o histórico de troca de
     catraca: um lead que foi mudado de catraca na ficha conta na nova. A tela
     diz isso, para ninguém tomar o número por um registro do passado.
   - Autoatendimento = a IA mandou pelo menos uma mensagem no lead
     (`robo_msgs > 0`). A comparação é conversão dos leads que a IA atendeu
     contra a dos que ela não atendeu, dentro da mesma catraca — juntar
     catracas diferentes misturaria produto com atendimento.
   - Sem base não vira zero: conversão sem lead é nula ("—"). */
import db from "../db.js";
import { resolverPeriodo } from "./painel.js";

const mediana = (xs) => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b), m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const taxa = (a, b) => (b ? (a / b) * 100 : null);

/* O período: os atalhos de sempre, mais "tudo" (desde a primeira entrada) —
   o caso de uma catraca desativada, que quase sempre se quer ver inteira. */
export function periodoDoRelatorio(q = {}) {
  if (q.periodo === "tudo") return { de: 0, ate: Date.now(), rotulo: "desde o início" };
  return resolverPeriodo(q);
}

function leadsDoPeriodo(orgId, de, ate, filtro = "", args = []) {
  return db.prepare(
    `SELECT l.id, l.catraca_id, l.assigned_to, l.created_at, l.first_resp_at, l.closed_at, l.sale_date, l.sale_value,
            COALESCE(l.robo_msgs,0) AS robo_msgs, l.stage, l.stage_id, l.origem, l.source,
            s.status_type, s.name AS etapa_nome
       FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
      WHERE l.org_id = ? AND l.created_at BETWEEN ? AND ?${filtro}`).all(orgId, de, ate, ...args);
}

const perdido = (l) => l.status_type === "perdido" || (!l.status_type && l.stage === "Perdido");
const vendido = (l) => !!l.sale_date;

function numeros(leads) {
  const ia = leads.filter(l => l.robo_msgs > 0), semIa = leads.filter(l => !(l.robo_msgs > 0));
  const vendas = leads.filter(vendido);
  const respostas = leads.filter(l => l.first_resp_at && l.first_resp_at >= l.created_at)
    .map(l => (l.first_resp_at - l.created_at) / 60000);
  const bloco = (xs) => { const v = xs.filter(vendido).length; return { leads: xs.length, vendas: v, conversao: taxa(v, xs.length) }; };
  return {
    leads: leads.length,
    em_aberto: leads.filter(l => !l.closed_at && !vendido(l) && !perdido(l)).length,
    finalizados: leads.filter(l => !!l.closed_at).length,
    perdidos: leads.filter(perdido).length,
    vendas: vendas.length,
    vgv: vendas.reduce((s, l) => s + (Number(l.sale_value) || 0), 0),
    conversao: taxa(vendas.length, leads.length),
    respondidos: respostas.length,
    sem_resposta: leads.filter(l => !l.first_resp_at).length,
    primeira_resposta_mediana_min: mediana(respostas),
    ia: bloco(ia),
    sem_ia: bloco(semIa),
  };
}

function catracasDaConta(orgId) {
  return db.prepare("SELECT id, nome, entrega, ativa, created_at FROM catracas WHERE org_id = ? ORDER BY ativa DESC, created_at").all(orgId);
}

/* A tabela de comparação: a principal, cada catraca, e o total da conta. */
export function relatorioDasCatracas(orgId, q = {}) {
  const p = periodoDoRelatorio(q);
  const leads = leadsDoPeriodo(orgId, p.de, p.ate);
  const cats = catracasDaConta(orgId);
  const conhecidas = new Set(cats.map(c => c.id));
  const principal = leads.filter(l => !l.catraca_id || !conhecidas.has(l.catraca_id));
  return {
    periodo: { de: p.de, ate: p.ate, rotulo: p.rotulo },
    linhas: [
      { id: "principal", nome: "Catraca principal", ativa: true, principal: true, ...numeros(principal) },
      ...cats.map(c => ({ id: c.id, nome: c.nome, ativa: !!c.ativa, entrega: c.entrega, criada_em: c.created_at,
        ...numeros(leads.filter(l => l.catraca_id === c.id)) })),
    ],
    total: numeros(leads),
  };
}

/* Uma catraca por dentro: os números, por corretor (o dono de hoje), por
   origem e por etapa. */
export function relatorioDaCatraca(orgId, catracaId, q = {}) {
  const p = periodoDoRelatorio(q);
  let c = null, leads;
  if (catracaId === "principal") {
    const ids = catracasDaConta(orgId).map(x => x.id);
    leads = leadsDoPeriodo(orgId, p.de, p.ate).filter(l => !l.catraca_id || !ids.includes(l.catraca_id));
  } else {
    c = db.prepare("SELECT id, nome, entrega, ativa, created_at FROM catracas WHERE id = ? AND org_id = ?").get(String(catracaId), orgId);
    if (!c) return null;
    leads = leadsDoPeriodo(orgId, p.de, p.ate, " AND l.catraca_id = ?", [c.id]);
  }
  const nomes = new Map(db.prepare("SELECT id, name FROM users WHERE org_id = ?").all(orgId).map(u => [u.id, u.name]));
  const agrupar = (chave) => {
    const m = new Map();
    for (const l of leads) { const k = chave(l); if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
    return [...m.entries()].map(([k, xs]) => ({ chave: k, leads: xs.length, vendas: xs.filter(vendido).length,
      conversao: taxa(xs.filter(vendido).length, xs.length), ia: xs.filter(l => l.robo_msgs > 0).length }))
      .sort((a, b) => b.leads - a.leads);
  };
  return {
    periodo: { de: p.de, ate: p.ate, rotulo: p.rotulo },
    catraca: c ? { id: c.id, nome: c.nome, entrega: c.entrega, ativa: !!c.ativa, criada_em: c.created_at }
               : { id: "principal", nome: "Catraca principal", ativa: true, principal: true },
    ...numeros(leads),
    por_corretor: agrupar(l => l.assigned_to || "").map(x => ({ ...x, nome: x.chave ? (nomes.get(x.chave) || "Ex-integrante") : "Na fila, sem dono" })),
    por_origem: agrupar(l => l.origem || (l.source === "meta" ? "Meta Ads" : l.source === "portal" ? "Portal" : "WhatsApp")).map(x => ({ ...x, nome: x.chave })),
    por_etapa: agrupar(l => l.etapa_nome || l.stage || "Sem etapa").map(x => ({ ...x, nome: x.chave })),
  };
}
