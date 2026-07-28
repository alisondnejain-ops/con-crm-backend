import { Router } from "express";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";
import { STAGES } from "../services/stages.js";

const r = Router();
r.use(authRequired);

const parse = (l) => l && ({ ...l, qual: JSON.parse(l.qual_json || "{}"), first_resp_at: l.first_resp_at });

// Lista de leads conforme o papel:
// corretor/sdr -> os atribuídos a ele; adm -> todos da organização.
r.get("/", (req, res) => {
  const { role, id, org_id } = req.user;
  let rows;
  if (role === "adm") {
    rows = db.prepare("SELECT * FROM leads WHERE org_id = ? ORDER BY created_at DESC").all(org_id);
  } else {
    rows = db.prepare("SELECT * FROM leads WHERE assigned_to = ? ORDER BY created_at DESC").all(id);
  }
  res.json(rows.map(parse));
});

// Fila da catraca (leads sem dono). SDR e ADM.
r.get("/queue", roles("sdr", "adm"), (req, res) => {
  const rows = db.prepare("SELECT * FROM leads WHERE org_id = ? AND assigned_to IS NULL ORDER BY created_at DESC").all(req.user.org_id);
  res.json(rows.map(parse));
});

r.get("/:id", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  const msgs = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id);
  res.json({ ...parse(lead), messages: msgs });
});

// Ajuste manual de etapa (o automático acontece no envio/recebimento de mensagem).
r.patch("/:id/stage", (req, res) => {
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ error: "Etapa inválida" });
  const info = db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(stage, req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  res.json({ ok: true, stage });
});

export default r;
