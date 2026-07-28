import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { normalizePhone } from "../services/stages.js";
import { advanceStage } from "./messages.routes.js";

const r = Router();

// Mensagens que o LEAD envia chegam aqui (configure este endpoint como webhook na Uazapi).
// O formato varia por provedor — ajuste a extração de número/texto conforme o payload real.
r.post("/uazapi", (req, res) => {
  res.sendStatus(200);
  try {
    const p = req.body || {};
    // Tentativas comuns de onde vêm número e texto (ajuste ao seu payload):
    const rawNumber = p.phone || p.sender || p.from || p?.message?.from || p?.data?.phone || "";
    const text = p.text || p.body || p?.message?.text || p?.data?.text || "";
    if (p.fromMe || p.key?.fromMe) return; // ignora eco das próprias mensagens
    const phone = normalizePhone(rawNumber);
    if (!phone || !text) return;

    const lead = db.prepare("SELECT * FROM leads WHERE phone = ? ORDER BY created_at DESC LIMIT 1").get(phone);
    if (!lead) { console.log("[uazapi] mensagem de número sem lead:", phone); return; }

    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
      VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "in", null, null, text, Date.now());

    advanceStage(lead.id); // a resposta do lead também pode avançar a etapa
    console.log("[uazapi] resposta recebida do lead:", lead.name);
  } catch (e) {
    console.error("[uazapi] webhook erro:", e.message);
  }
});

export default r;
