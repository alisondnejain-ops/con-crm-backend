import { Router } from "express";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";
import { avisar } from "../services/push.js";

const r = Router();
r.use(authRequired);

// Quem atende (corretores + SDR) com o status de disponibilidade de hoje.
r.get("/attendants", roles("sdr", "adm"), (req, res) => {
  const rows = db.prepare(
    "SELECT id,name,role,available FROM users WHERE org_id = ? AND role IN ('corretor','sdr') ORDER BY name"
  ).all(req.user.org_id);
  res.json(rows.map(u => ({ ...u, available: !!u.available })));
});

// Catraca dos ATENDENTES — só o gestor. É a fila de quem recebe os leads que
// entram, com quantos cada uma já pegou e quem é a próxima da vez. Com uma
// atendente só, a lista tem uma linha; a tela existe para quando entrar a segunda.
r.get("/atendentes", roles("adm"), (req, res) => {
  const fila = db.prepare(
    "SELECT id,name,available,status FROM users WHERE org_id = ? AND role = 'sdr' AND status = 'ativo' ORDER BY created_at, name"
  ).all(req.user.org_id);
  const org = db.prepare("SELECT atendente_ptr FROM orgs WHERE id = ?").get(req.user.org_id);
  const ptr = (org && org.atendente_ptr) || 0;
  const emAberto = db.prepare(
    "SELECT COUNT(*) n FROM leads WHERE assigned_to = ? AND closed_at IS NULL AND stage NOT IN ('Venda','Perdido')"
  );
  res.json({
    proximo: fila.length ? fila[ptr % fila.length].id : null,
    atendentes: fila.map((u, i) => ({
      ...u,
      available: !!u.available,
      proximo_da_vez: fila.length ? i === ptr % fila.length : false,
      em_aberto: emAberto.get(u.id).n,
    })),
  });
});

// Prontidão do dia. O próprio usuário pode se prontificar; SDR/ADM podem ajustar de qualquer um.
r.post("/availability", (req, res) => {
  const { user_id, available } = req.body || {};
  const target = user_id || req.user.id;
  if (target !== req.user.id && !["sdr", "adm"].includes(req.user.role))
    return res.status(403).json({ error: "Só a SDR/ADM altera a disponibilidade de outros" });
  db.prepare("UPDATE users SET available = ? WHERE id = ? AND org_id = ?").run(available ? 1 : 0, target, req.user.org_id);
  res.json({ ok: true });
});

// Catraca manual: transfere um lead da fila para um atendente específico (disponível).
r.post("/transfer", roles("sdr", "adm"), (req, res) => {
  const { lead_id, user_id } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(user_id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Atendente não encontrado" });
  if (!u.available) return res.status(409).json({ error: "Atendente indisponível — não entra na catraca" });
  const info = db.prepare("UPDATE leads SET assigned_to = ? WHERE id = ? AND org_id = ?").run(user_id, lead_id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  avisarNovoLead(user_id, lead_id);
  res.json({ ok: true, assigned_to: user_id });
});

// Catraca automática (rodízio): entrega ao próximo atendente disponível.
r.post("/next", roles("sdr", "adm"), (req, res) => {
  const { lead_id } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const avl = db.prepare(
    "SELECT id FROM users WHERE org_id = ? AND role IN ('corretor','sdr') AND available = 1 ORDER BY name"
  ).all(req.user.org_id);
  if (!avl.length) return res.status(409).json({ error: "Ninguém disponível na catraca" });
  const ptr = org.distribution_ptr % avl.length;
  const chosen = avl[ptr].id;
  const info = db.prepare("UPDATE leads SET assigned_to = ? WHERE id = ? AND org_id = ?").run(chosen, lead_id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  db.prepare("UPDATE orgs SET distribution_ptr = ? WHERE id = ?").run(org.distribution_ptr + 1, org.id);
  avisarNovoLead(chosen, lead_id);
  res.json({ ok: true, assigned_to: chosen });
});

// Repasse da SDR: ela faz o 1º atendimento e passa o lead para o CORRETOR da vez
// (rodízio entre corretores disponíveis) ou para um corretor específico. O lead deixa de ser dela.
r.post("/handoff", roles("sdr", "adm"), (req, res) => {
  const { lead_id, user_id } = req.body || {};
  let chosen = user_id;
  if (chosen) {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role = 'corretor'").get(chosen, req.user.org_id);
    if (!u) return res.status(404).json({ error: "Corretor não encontrado" });
    if (!u.available) return res.status(409).json({ error: "Corretor indisponível" });
  } else {
    const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
    const corr = db.prepare("SELECT id FROM users WHERE org_id = ? AND role = 'corretor' AND available = 1 ORDER BY name").all(req.user.org_id);
    if (!corr.length) return res.status(409).json({ error: "Nenhum corretor disponível" });
    chosen = corr[org.distribution_ptr % corr.length].id;
    db.prepare("UPDATE orgs SET distribution_ptr = ? WHERE id = ?").run(org.distribution_ptr + 1, org.id);
  }
  const info = db.prepare("UPDATE leads SET assigned_to = ? WHERE id = ? AND org_id = ?").run(chosen, lead_id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  avisarNovoLead(chosen, lead_id);
  res.json({ ok: true, assigned_to: chosen });
});

// A ADM assume a negociação: o lead passa a ser dela e sai da lista do corretor.
// Sem checagem de disponibilidade — a ADM não entra no rodízio da catraca, ela
// intervém quando quer (atendimento travado, cliente importante, corretor ausente).
r.post("/assumir", roles("adm", "sdr"), (req, res) => {
  const { lead_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(lead_id, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (lead.assigned_to === req.user.id) return res.json({ ok: true, ja_era_seu: true });

  const anterior = lead.assigned_to
    ? db.prepare("SELECT name FROM users WHERE id = ?").get(lead.assigned_to)
    : null;
  db.prepare("UPDATE leads SET assigned_to = ? WHERE id = ?").run(req.user.id, lead.id);
  res.json({ ok: true, tirado_de: anterior ? anterior.name : "fila" });
});

// Devolve o lead: para um corretor específico, ou de volta à fila da catraca
// (sem user_id). Contrapartida do "assumir" — a ADM não fica com o lead preso.
r.post("/devolver", roles("adm", "sdr"), (req, res) => {
  const { lead_id, user_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(lead_id, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

  if (!user_id) {
    db.prepare("UPDATE leads SET assigned_to = NULL WHERE id = ?").run(lead.id);
    return res.json({ ok: true, destino: "fila" });
  }
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role IN ('corretor','sdr')").get(user_id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Atendente não encontrado" });
  db.prepare("UPDATE leads SET assigned_to = ? WHERE id = ?").run(u.id, lead.id);
  res.json({ ok: true, destino: u.name });
});

// Aviso de lead novo na mão do corretor. Fora do fluxo da resposta de
// propósito: se o push demorar ou falhar, a transferência já aconteceu.
function avisarNovoLead(userId, leadId) {
  const lead = db.prepare("SELECT name FROM leads WHERE id = ?").get(leadId);
  avisar(userId, {
    titulo: "Novo lead com você",
    corpo: `${lead?.name || "Um lead"} acabou de entrar na sua lista. Fale agora — os primeiros minutos decidem.`,
    leadId,
  });
}

export default r;
