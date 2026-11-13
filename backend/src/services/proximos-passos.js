/* PRÓXIMOS PASSOS DO PAINEL (13/11/2026, especificação CETRO 06.3).

   Duas classes, nesta ordem: (1) leads com TAREFA vencida — a tarefa em aberto
   cujo horário já passou; (2) leads com o PRAZO DA ETAPA vencido (o SLA da
   etapa, `slaDoLead`, que já respeita a tarefa futura que segura o lead).
   Dentro de cada classe, o mais atrasado primeiro. Um lead aparece UMA vez:
   quem tem as duas pendências fica na primeira classe, com a segunda escrita
   ao lado ("também prazo da etapa vencido"), em vez de duas linhas.

   É leitura dos dados reais, com o mesmo filtro de pessoa do resto do Painel
   (quem não supervisiona vê só os próprios leads — a rota força isso). */
import db from "../db.js";
import { peneira } from "./painel.js";
import { slaDoLead, leadsComTarefaFutura } from "./etapas.js";
import { formatarEtapa } from "./pipelines.js";

export function proximosPassos(orgId, filtros = {}, limite = 30, agora = Date.now()) {
  const p = peneira(orgId, filtros);
  // Venda registrada e lead anonimizado não têm próximo passo. Conversa
  // finalizada continua: finalizar encerra o atendimento, não a tarefa.
  const onde = `${p.sql} AND l.sale_date IS NULL AND l.anonimizado_em IS NULL`;

  const etapas = new Map(db.prepare("SELECT * FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .map(e => [e.id, formatarEtapa(e)]));
  const fechada = (l) => { const e = l.stage_id && etapas.get(l.stage_id); return e && (e.status_type === "ganho" || e.status_type === "perdido"); };
  const nomes = new Map(db.prepare("SELECT id, name FROM users WHERE org_id = ?").all(orgId).map(u => [u.id, u.name]));

  const tarefas = db.prepare(`SELECT t.lead_id, t.titulo, t.quando, l.name, l.phone, l.stage, l.stage_id, l.assigned_to
    FROM tarefas t JOIN leads l ON l.id = t.lead_id
    WHERE ${onde} AND t.org_id = ? AND t.feito_em IS NULL AND t.quando < ?
    ORDER BY t.quando ASC`).all(...p.args, orgId, agora);
  const porLead = new Map();
  for (const t of tarefas) {
    if (fechada(t)) continue;
    const ja = porLead.get(t.lead_id);
    if (ja) { ja.quantas++; continue; }
    porLead.set(t.lead_id, { lead_id: t.lead_id, nome: t.name, telefone: t.phone, etapa: t.stage,
      responsavel: t.assigned_to ? (nomes.get(t.assigned_to) || null) : null,
      tipo: "tarefa", descricao: t.titulo, desde: t.quando, atraso_min: Math.floor((agora - t.quando) / 60000), quantas: 1 });
  }

  const comTarefa = leadsComTarefaFutura(orgId, agora);
  const leads = db.prepare(`SELECT l.id, l.name, l.phone, l.stage, l.stage_id, l.assigned_to,
      l.last_interaction_at, l.stage_entered_at, l.created_at FROM leads l WHERE ${onde} AND l.stage_id IS NOT NULL`)
    .all(...p.args);
  const prazos = [];
  for (const l of leads) {
    if (fechada(l)) continue;
    const e = etapas.get(l.stage_id);
    const s = slaDoLead(e, l, agora, comTarefa.has(l.id));
    if (!s || s.status !== "overdue") continue;
    const atraso = s.minutos - s.limite;
    const ja = porLead.get(l.id);
    if (ja) { ja.tambem_prazo = true; continue; }
    prazos.push({ lead_id: l.id, nome: l.name, telefone: l.phone, etapa: l.stage,
      responsavel: l.assigned_to ? (nomes.get(l.assigned_to) || null) : null,
      tipo: "prazo", descricao: `Prazo da etapa ${e.name} venceu`, desde: s.desde + s.limite * 60000, atraso_min: atraso });
  }

  const primeira = [...porLead.values()].sort((a, b) => b.atraso_min - a.atraso_min);
  prazos.sort((a, b) => b.atraso_min - a.atraso_min);
  const todos = [...primeira, ...prazos];
  return { total: todos.length, tarefas_vencidas: primeira.length, prazos_vencidos: prazos.length, itens: todos.slice(0, limite) };
}
