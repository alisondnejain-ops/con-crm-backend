import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { fetchLead } from "../services/meta.js";
import { normalizePhone, scorePriority } from "../services/stages.js";
import { proximoAtendente } from "../services/catraca.js";

const r = Router();

// 1) Verificação do webhook (a Meta chama com GET ao configurar).
r.get("/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// 2) Recebimento em tempo real. Cada novo lead cai na fila da catraca (assigned_to = NULL).
r.post("/meta", async (req, res) => {
  res.sendStatus(200); // responde rápido; processa depois
  try {
    const org = db.prepare("SELECT * FROM orgs LIMIT 1").get(); // 1 org (Conecta) neste MVP
    if (!org) return;
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value.leadgen_id;
        try {
          const info = await fetchLead(leadgenId);
          const phone = normalizePhone(info.phone);
          const dup = db.prepare("SELECT 1 FROM leads WHERE org_id = ? AND (meta_lead_id = ? OR phone = ?)").get(org.id, info.meta_lead_id, phone);
          if (dup) continue;
          const dono = proximoAtendente(org.id);
          db.prepare(`INSERT INTO leads (id,org_id,name,phone,email,origem,priority,qual_json,stage,assigned_to,created_at)
            VALUES (?,?,?,?,?,?,?,?, 'Lead', ?, ?)`).run(
            "l_" + randomUUID(), org.id, info.name, phone, info.email, "Meta Ads",
            scorePriority(info.qual), JSON.stringify(info.qual), dono, Date.now()
          );
          console.log("[meta] novo lead:", info.name, phone, dono ? "— para a atendente da vez" : "— sem atendente, foi para a fila");
        } catch (e) {
          console.error("[meta] erro ao buscar lead", leadgenId, e.message);
        }
      }
    }
  } catch (e) {
    console.error("[meta] webhook erro:", e.message);
  }
});

export default r;
