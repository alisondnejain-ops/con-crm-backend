import { Router } from "express";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";

const r = Router();
r.use(authRequired);

// Quem atende (corretores + SDR) com o status de disponibilidade de hoje.
r.get("/attendants", roles("sdr", "adm"), (req, res) => {
  const rows = db.prepare(
    "SELECT id,name,role,available FROM users WHERE org_id = ? AND role IN ('corretor','sdr') ORDER BY name"
  ).all(req.user.org_id);
  res.json(rows.map(u => ({ ...u, available: !!u.available })));
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
  res.json({ ok: true, assigned_to: chosen });
});

export default r;
