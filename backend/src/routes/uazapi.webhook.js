import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { normalizePhone } from "../services/stages.js";
import { proximoAtendente } from "../services/catraca.js";
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
//
// Aceitamos também um sufixo no caminho porque a Uazapi tem as opções
// "addUrlTypesMessages" e "addUrlEvents", que acrescentam o tipo da mensagem
// ou o nome do evento na URL (.../uazapi/text, .../uazapi/messages). Ligadas
// sem querer, elas fariam todo webhook cair em 404 silenciosamente.
r.post(["/uazapi", "/uazapi/:sufixo", "/uazapi/:sufixo/:sufixo2"], (req, res) => {
  res.sendStatus(200); // responde já: a Uazapi não deve esperar nosso processamento
  try {
    const p = req.body || {};
    const evento = p.EventType || p.event || p.type || "";
    // Só interessa mensagem NOVA. "messages_update" (entrega/leitura), presença,
    // conexão e afins também trazem "message" no nome — por isso o descarte explícito.
    const ehMensagemNova = !evento || (/message/i.test(evento) && !/(update|delete|revoke|status|ack|edit)/i.test(evento));
    if (!ehMensagemNova)
      // Guardamos só a FORMA do payload (nomes de campos), nunca o conteúdo das
      // conversas — é o bastante para descobrir se um evento traz mensagem dentro.
      return lembrar({ em: Date.now(), evento, resultado: "ignorado (não é mensagem nova)", campos: Object.keys(p), campos_internos: Object.keys(p.message || p.data || {}).slice(0, 25) });

    const { phone, texto, tipo, nome, ignorar } = extrair(p);
    if (ignorar) return lembrar({ em: Date.now(), evento, resultado: "ignorado: " + ignorar });
    if (!phone) return lembrar({ em: Date.now(), evento, resultado: "sem número — payload não reconhecido", amostra: Object.keys(p) });

    // Mensagem sem texto (só mídia): registramos um marcador para o corretor saber que chegou algo.
    const corpo = texto || (tipo ? `[${tipo}]` : "[mensagem sem texto]");

    // Diagnóstico para ligar a exibição de mídia: quando chega foto/vídeo/documento,
    // anotamos a FORMA do payload — nomes de campos e, dos que parecem link, só o
    // início da URL. Nunca o arquivo nem o conteúdo da conversa. É temporário:
    // serve para descobrir por qual caminho esta conta manda a mídia.
    if (!texto || /image|video|audio|document|sticker|ptt|media/i.test(tipo)) {
      const m = p.message || p.data?.message || p.data || p;
      const forma = {};
      for (const [k, v] of Object.entries(m)) {
        if (v == null) continue;
        if (typeof v === "string") forma[k] = /^https?:\/\//.test(v) ? "URL: " + v.slice(0, 60) + "…"
                                  : v.length > 120 ? `texto longo (${v.length} chars — pode ser base64)` : typeof v;
        else forma[k] = Array.isArray(v) ? "lista" : typeof v === "object" ? "objeto{" + Object.keys(v).slice(0, 12).join(",") + "}" : typeof v;
      }
      lembrar({ em: Date.now(), evento, resultado: "MÍDIA — forma do payload", tipo, campos: forma });
    }

    let lead = db.prepare("SELECT * FROM leads WHERE phone = ? ORDER BY created_at DESC LIMIT 1").get(phone);

    // Número desconhecido = lead novo entrando pelo WhatsApp. Vai direto para a
    // atendente da vez, exatamente como um lead vindo da Meta.
    if (!lead) {
      const org = db.prepare("SELECT id FROM orgs LIMIT 1").get();
      if (!org) return lembrar({ em: Date.now(), resultado: "sem organização configurada" });
      const id = "l_" + randomUUID();
      const dono = proximoAtendente(org.id);
      db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,qual_json,stage,assigned_to,created_at)
        VALUES (?,?,?,?,'WhatsApp','MORNO','{}','Lead',?,?)`)
        .run(id, org.id, nome || "Contato do WhatsApp", phone, dono, Date.now());
      lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
      console.log(`[uazapi] lead NOVO pelo WhatsApp: ${lead.name} (${phone}) — ${dono ? "para a atendente da vez" : "sem atendente cadastrado, foi para a fila"}`);
    }

    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
      VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "in", null, null, corpo, Date.now());

    // Cliente voltou a falar: atendimento finalizado reabre sozinho, senão a
    // mensagem cairia numa conversa escondida e ninguém responderia.
    if (lead.closed_at) {
      db.prepare("UPDATE leads SET closed_at = NULL WHERE id = ?").run(lead.id);
      console.log(`[uazapi] atendimento de ${lead.name} reaberto: o cliente respondeu`);
    }

    advanceStage(lead.id);
    lembrar({ em: Date.now(), evento, resultado: "ok", lead: lead.name, tipo });
    console.log(`[uazapi] mensagem recebida de ${lead.name}`);
  } catch (e) {
    lembrar({ em: Date.now(), resultado: "erro: " + e.message });
    console.error("[uazapi] webhook erro:", e.message);
  }
});

export default r;
