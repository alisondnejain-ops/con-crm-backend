import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { normalizePhone } from "../services/stages.js";
import { advanceStage } from "./messages.routes.js";

const r = Router();

// Guarda os últimos webhooks recebidos, só em memória, para diagnóstico.
// Não persiste e some a cada reinício — é ferramenta de instalação, não de operação.
export const ultimosEventos = [];
const lembrar = (e) => { ultimosEventos.unshift(e); if (ultimosEventos.length > 15) ultimosEventos.pop(); };

// Extrai número e texto de um payload da Uazapi. O formato varia entre versões
// e tipos de mensagem, então tentamos os caminhos conhecidos em ordem.
function extrair(p) {
  const m = p.message || p.data?.message || p.data || p;
  const bruto = m.chatid || m.sender || m.from || p.phone || p.sender || "";
  const chat = String(bruto);

  // Grupos e canais não são atendimento de lead — ignorar.
  if (chat.includes("@g.us") || chat.includes("@newsletter") || chat.includes("@broadcast"))
    return { ignorar: "grupo/canal" };
  if (m.fromMe ?? m.key?.fromMe) return { ignorar: "eco da própria mensagem" };

  const texto = m.text || m.body || m.caption || m.content?.text || m.conversation || "";
  const tipo = m.messageType || m.type || "";
  return {
    phone: normalizePhone(chat.split("@")[0]),
    texto: String(texto).trim(),
    tipo,
    nome: m.senderName || m.pushName || m.wa_name || m.chatName || "",
  };
}

// Mensagens que o LEAD envia chegam aqui.
// Configure na Uazapi: Webhook da Instância -> https://SEU-BACKEND/webhooks/uazapi
r.post("/uazapi", (req, res) => {
  res.sendStatus(200); // responde já: a Uazapi não deve esperar nosso processamento
  try {
    const p = req.body || {};
    const evento = p.EventType || p.event || p.type || "";
    // Só interessa mensagem NOVA. "messages_update" (entrega/leitura), presença,
    // conexão e afins também trazem "message" no nome — por isso o descarte explícito.
    const ehMensagemNova = !evento || (/message/i.test(evento) && !/(update|delete|revoke|status|ack|edit)/i.test(evento));
    if (!ehMensagemNova) return lembrar({ em: Date.now(), evento, resultado: "ignorado (não é mensagem nova)" });

    const { phone, texto, tipo, nome, ignorar } = extrair(p);
    if (ignorar) return lembrar({ em: Date.now(), evento, resultado: "ignorado: " + ignorar });
    if (!phone) return lembrar({ em: Date.now(), evento, resultado: "sem número — payload não reconhecido", amostra: Object.keys(p) });

    // Mensagem sem texto (só mídia): registramos um marcador para o corretor saber que chegou algo.
    const corpo = texto || (tipo ? `[${tipo}]` : "[mensagem sem texto]");

    let lead = db.prepare("SELECT * FROM leads WHERE phone = ? ORDER BY created_at DESC LIMIT 1").get(phone);

    // Número desconhecido = lead novo entrando pelo WhatsApp. Cai na fila da catraca,
    // sem dono, exatamente como um lead vindo da Meta.
    if (!lead) {
      const org = db.prepare("SELECT id FROM orgs LIMIT 1").get();
      if (!org) return lembrar({ em: Date.now(), resultado: "sem organização configurada" });
      const id = "l_" + randomUUID();
      db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,qual_json,stage,assigned_to,created_at)
        VALUES (?,?,?,?,'WhatsApp','MORNO','{}','Lead',NULL,?)`)
        .run(id, org.id, nome || "Contato do WhatsApp", phone, Date.now());
      lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
      console.log(`[uazapi] lead NOVO pelo WhatsApp: ${lead.name} (${phone}) — entrou na fila da catraca`);
    }

    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
      VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "in", null, null, corpo, Date.now());

    advanceStage(lead.id);
    lembrar({ em: Date.now(), evento, resultado: "ok", lead: lead.name, tipo });
    console.log(`[uazapi] mensagem recebida de ${lead.name}`);
  } catch (e) {
    lembrar({ em: Date.now(), resultado: "erro: " + e.message });
    console.error("[uazapi] webhook erro:", e.message);
  }
});

export default r;
