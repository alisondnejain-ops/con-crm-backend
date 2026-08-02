import { Router } from "express";
import db from "../db.js";
import { authRequired, supervisiona } from "../auth.js";
import { STAGES } from "../services/stages.js";
import { ranking, recomendar, recomendacoes } from "../services/score.js";

const r = Router();
r.use(authRequired);

// Produtividade por atendente num período.
//   ?de=2026-07-01&ate=2026-07-31   (sem parâmetros: últimos 30 dias)
// A ADM vê a equipe inteira; corretor e SDR veem só a própria linha.
r.get("/", (req, res) => {
  const ate = req.query.ate ? fimDoDia(req.query.ate) : Date.now();
  const de = req.query.de ? inicioDoDia(req.query.de) : ate - 30 * 86400000;
  if (!isFinite(de) || !isFinite(ate)) return res.status(400).json({ error: "Período inválido." });

  // Quem supervisiona vê a equipe toda; o corretor vê só a própria linha.
  const equipe = supervisiona(req.user)
    ? db.prepare("SELECT id,name,role FROM users WHERE org_id=? AND role IN ('corretor','sdr') AND status='ativo' ORDER BY name").all(req.user.org_id)
    : db.prepare("SELECT id,name,role FROM users WHERE id=?").all(req.user.id);

  const leads = db.prepare("SELECT * FROM leads WHERE org_id=? AND created_at BETWEEN ? AND ?")
    .all(req.user.org_id, de, ate);

  const linhas = equipe.map(u => {
    const meus = leads.filter(l => l.assigned_to === u.id);
    const atendidos = meus.filter(l => l.first_resp_at != null);
    const temposResposta = atendidos.map(l => (l.first_resp_at - l.created_at) / 60000);
    const vendas = meus.filter(l => l.stage === "Venda");
    const porEtapa = STAGES.reduce((o, s) => (o[s] = meus.filter(l => l.stage === s).length, o), {});

    return {
      id: u.id, nome: u.name, papel: u.role,
      recebidos: meus.length,
      atendidos: atendidos.length,
      taxa_atendimento: pct(atendidos.length, meus.length),
      // Mediana em vez de média: um único lead esquecido no fim de semana
      // distorce a média e faz o corretor parecer pior do que é.
      primeira_resposta_mediana_min: mediana(temposResposta),
      agendamentos: porEtapa["Agendamento"] + porEtapa["Visita"],
      vendas: vendas.length,
      conversao: pct(vendas.length, meus.length),
      valor_vendido: vendas.reduce((s, l) => s + (l.sale_value || 0), 0),
      por_etapa: porEtapa,
    };
  });

  // O total é da imobiliária inteira — quantos leads entraram, quanto foi
  // vendido. Isso é informação de gestão: o corretor via o faturamento da casa
  // dentro da própria tela de produtividade. Só supervisão recebe.
  const total = supervisiona(req.user) ? {
    leads: leads.length,
    na_fila: leads.filter(l => !l.assigned_to).length,
    vendas: leads.filter(l => l.stage === "Venda").length,
    valor_vendido: leads.reduce((s, l) => s + (l.sale_value || 0), 0),
  } : null;

  res.json({ periodo: { de, ate }, total, atendentes: linhas });
});

const inicioDoDia = (s) => new Date(`${s}T00:00:00`).getTime();
const fimDoDia = (s) => new Date(`${s}T23:59:59.999`).getTime();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function mediana(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

// Score de performance da equipe. Só gestão: é material de decisão sobre
// pessoas, não painel de auto-avaliação do corretor.
r.get("/score", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });
  const dias = Math.min(365, Math.max(7, Number(req.query.dias) || 90));
  res.json({ dias, equipe: ranking(req.user.org_id, dias) });
});

// Para quem mandar este lead. Vale só enquanto ele não está com um corretor —
// depois de direcionado, recomendar de novo seria convidar ao troca-troca.
r.get("/recomendacao/:leadId", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });
  const lead = db.prepare("SELECT * FROM leads WHERE id=? AND org_id=?").get(req.params.leadId, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  const dono = lead.assigned_to
    ? db.prepare("SELECT role FROM users WHERE id=?").get(lead.assigned_to) : null;
  if (dono && dono.role === "corretor") return res.json({ situacao: "ja_direcionado" });
  res.json(recomendar(req.user.org_id, lead));
});

// Painel de recomendações: o que merece decisão do gestor agora.
r.get("/recomendacoes", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });
  res.json(recomendacoes(req.user.org_id, Number(req.query.limite) || 8));
});

export default r;
