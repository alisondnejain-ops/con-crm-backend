import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired } from "../auth.js";
import { sendText } from "../services/uazapi.js";
import { inferStage } from "../services/stages.js";

const r = Router();
r.use(authRequired);

// Envia mensagem ao lead pelo número único da Conecta, ASSINADA com o nome de quem envia.
// Depois, roda o avanço automático de etapa com base na conversa.
r.post("/leads/:id/messages", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensagem vazia" });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

  // Corretor/SDR só fala com o próprio lead; ADM pode em qualquer um.
  if (req.user.role !== "adm" && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });

  const firstName = (req.user.name || "").split(" ")[0];

  try {
    await sendText({ toPhone: lead.phone, text: text.trim(), signedBy: firstName });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName, text.trim(), now);

  // primeira resposta do atendente -> marca tempo de 1ª resposta
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);

  advanceStage(lead.id);
  res.json({ ok: true });
});

// Recalcula e aplica o avanço automático de etapa a partir do histórico.
export function advanceStage(leadId) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) return;
  const msgs = db.prepare("SELECT direction,body FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(leadId);
  const next = inferStage(lead.stage, msgs);
  if (next !== lead.stage) db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(next, leadId);
}

export default r;
