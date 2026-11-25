/* OS 19 INDICADORES DA EQUIPE E A PONTUAÇÃO LIVRE (CETRO 17.2/17.3, 13/11/2026).

   O Score (a nota de 0 a 100, services/score.js) continua igual. Aqui entra o
   que faltava para a tabela mostrar os 19 indicadores e para o gestor montar
   uma PONTUAÇÃO própria:

   - leads trabalhados, pessoas faladas e mensagens vêm das MESMAS funções do
     funil de atividades do Painel (painel-geral.js) — o número de uma pessoa
     aqui é o mesmo que o Painel mostra com ela no filtro;
   - "na mão" (desde 18/11/2026) é dos recebidos no período, quantos
     continuam com ela em aberto — segue o filtro, como o resto;
   - "atrasados" são os leads dela com tarefa vencida ou prazo da etapa
     vencido, a mesma conta dos Próximos passos;
   - tarefas criadas (por ela) e feitas (as dela, concluídas) no período.

   PONTUAÇÃO: só indicadores de CONTAGEM recebem peso (soma de valor × peso).
   Score, conversão (%), 1ª resposta e fluidez (minutos) ficam de fora: somar
   minutos como se fossem ações não significa nada, e o Score não pontua a si
   mesmo. Coluna de consulta escolhida na tela não cria peso nenhum. */
import db, { emLotes } from "../db.js";
import { eventosDeAtribuicao, recebidosEm } from "./movimento.js";
import { trabalhados, faladas, msgsDeGente } from "./painel-geral.js";
import { proximosPassos } from "./proximos-passos.js";

export const INDICADORES = [
  ["score", "Score", "nota 0–100", false], ["conversao", "Conversão", "%", false], ["recebidos", "Recebidos", "leads", true],
  ["resposta_min", "1ª resposta", "minutos (mediana)", false], ["atendimento_min", "Fluidez no atendimento", "minutos (mediana da espera a cada pergunta)", false],
  ["ligacoes", "Ligações", "ligações", true], ["trabalhados", "Leads trabalhados", "lead por dia", true], ["mensagens", "Mensagens", "mensagens", true],
  ["faladas", "Pessoas faladas", "lead por dia", true], ["qualificados", "Qualificados", "leads", true], ["visitas_agendadas", "Agendamentos", "leads", true],
  ["visitas_realizadas", "Visitas", "leads", true], ["propostas", "Propostas", "leads", true], ["vendas", "Vendas", "vendas", true],
  ["na_mao", "Na mão", "recebidos no período que continuam com a pessoa, em aberto", true], ["tarefas_criadas", "Tarefas criadas", "tarefas", true], ["tarefas_feitas", "Tarefas feitas", "tarefas", true],
  ["atrasados", "Leads atrasados", "leads agora", true], ["perdidos", "Perdidos", "leads", true],
  ["perdidos_consequencia", "Perdidos por consequência", "recebidos no período sem nenhuma mensagem da pessoa (recebidos − atendidos)", true],
];
const PONTUAVEIS = new Set(INDICADORES.filter(i => i[3]).map(i => i[0]));

/* "Na mão" segue o período (18/11/2026, regra do Ali): dos leads que a pessoa
   RECEBEU no período (o mesmo "recebidos" da linha), quantos continuam com
   ela, sem venda e fora de etapa de perda. Trocar o filtro muda o número. */
function naMaoDoPeriodo(orgId, eventos, id, de, ate) {
  const ids = recebidosEm(eventos, id, de, ate).map(e => e.lead_id);
  return emLotes(ids, (marcas, lote) => db.prepare(`SELECT l.id FROM leads l
      LEFT JOIN pipeline_stages s ON s.id = l.stage_id
      WHERE l.org_id=? AND l.assigned_to=? AND l.sale_date IS NULL AND l.anonimizado_em IS NULL
        AND COALESCE(s.status_type,'') <> 'perdido' AND COALESCE(l.stage,'') <> 'Perdido'
        AND l.id IN (${marcas})`).all(orgId, id, ...lote)).length;
}

export function extrasDaEquipe(orgId, ids, de, ate) {
  const out = {};
  const eventos = eventosDeAtribuicao(orgId);
  for (const id of ids) {
    const f = { responsavel: id };
    out[id] = {
      trabalhados: trabalhados(orgId, f, de, ate).length,
      faladas: faladas(orgId, f, de, ate).length,
      mensagens: msgsDeGente(orgId, f, de, ate).length,
      na_mao: naMaoDoPeriodo(orgId, eventos, id, de, ate),
      tarefas_criadas: db.prepare("SELECT COUNT(*) n FROM tarefas WHERE org_id=? AND criado_por=? AND created_at BETWEEN ? AND ?").get(orgId, id, de, ate).n,
      tarefas_feitas: db.prepare("SELECT COUNT(*) n FROM tarefas WHERE org_id=? AND user_id=? AND feito_em BETWEEN ? AND ?").get(orgId, id, de, ate).n,
      atrasados: proximosPassos(orgId, f, 0).total,
    };
  }
  return out;
}

export function configDePontos(orgId) {
  const r = db.prepare("SELECT * FROM score_pontos WHERE org_id=?").get(orgId);
  let pesos = {}, participantes = null;
  try { pesos = JSON.parse(r?.pesos_json || "{}"); } catch {}
  try { participantes = r?.participantes_json ? JSON.parse(r.participantes_json) : null; } catch {}
  return { pesos, participantes, ligada: Object.values(pesos).some(v => v !== 0) };
}

export function salvarPontos(orgId, userId, { pesos, participantes }) {
  const limpos = {};
  for (const [k, v] of Object.entries(pesos || {})) {
    if (!PONTUAVEIS.has(k)) return { erro: k === "score" ? "O Score é calculado — não pontua a si mesmo." : `“${k}” não é um indicador de contagem — taxas e tempos não recebem peso.` };
    if (v === "" || v === null || v === undefined) continue;
    const n = Number(String(v).replace(",", "."));
    if (!isFinite(n) || Math.abs(n) > 1000) return { erro: "Peso é um número entre −1000 e 1000." };
    if (n !== 0) limpos[k] = n;
  }
  let parts = null;
  if (Array.isArray(participantes)) {
    const validos = new Set(db.prepare("SELECT id FROM users WHERE org_id=?").all(orgId).map(u => u.id));
    parts = participantes.filter(id => validos.has(id));
  }
  db.prepare(`INSERT INTO score_pontos (org_id,pesos_json,participantes_json,updated_at,updated_by) VALUES (?,?,?,?,?)
    ON CONFLICT(org_id) DO UPDATE SET pesos_json=excluded.pesos_json, participantes_json=excluded.participantes_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(orgId, JSON.stringify(limpos), parts ? JSON.stringify(parts) : null, Date.now(), userId);
  return { ok: true, ...configDePontos(orgId) };
}

/* Pontos de uma linha: soma de valor × peso, com a origem de cada parte. */
export function pontosDe(linha, pesos) {
  const partes = [];
  let total = 0;
  for (const [k, peso] of Object.entries(pesos || {})) {
    if (!PONTUAVEIS.has(k)) continue;
    const valor = Number(linha[k] || 0);
    const pts = Math.round(valor * peso * 100) / 100;
    total += pts;
    partes.push({ indicador: k, valor, peso, pontos: pts });
  }
  return { total: Math.round(total * 100) / 100, partes };
}
