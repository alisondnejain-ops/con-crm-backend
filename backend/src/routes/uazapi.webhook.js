import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { normalizePhone } from "../services/stages.js";
import { proximoAtendente } from "../services/catraca.js";
import { guardarMidiaRecebida } from "../services/midia.js";
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
  // Em mensagem de mídia, `content` é um objeto com URL, mimetype e o nome do
  // arquivo. Em mensagem de texto ele é uma string — daí a checagem de tipo.
  const content = m.content && typeof m.content === "object" ? m.content : null;
  return {
    phone: normalizePhone(chat.split("@")[0]),
    texto: String(texto).trim(),
    tipo,
    content,
    messageid: m.messageid || m.id || m.key?.id || "",
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
r.post(["/uazapi", "/uazapi/:sufixo", "/uazapi/:sufixo/:sufixo2"], async (req, res) => {
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

    const { phone, texto, tipo, content, messageid, nome, ignorar } = extrair(p);
    if (ignorar) return lembrar({ em: Date.now(), evento, resultado: "ignorado: " + ignorar });
    if (!phone) return lembrar({ em: Date.now(), evento, resultado: "sem número — payload não reconhecido", amostra: Object.keys(p) });

    // Foto, áudio ou documento: baixa e guarda o arquivo antes de gravar a
    // mensagem, para a conversa já nascer com a mídia. Se não der, `midia` volta
    // nulo e a mensagem entra como antes — o marcador de texto, sem travar nada.
    const temMidia = !!(content && (content.URL || content.url));
    const midia = temMidia ? await guardarMidiaRecebida({ content, messageid, tipo }) : null;

    // Legenda da foto, ou o nome do documento. Sem nenhum dos dois, um rótulo
    // curto em português: é ele que aparece na prévia da lista de conversas
    // ("Foto" lê melhor que "[ImageMessage]"). O balão esconde esse rótulo, já
    // que a imagem está logo ali — mas a lista precisa de alguma palavra.
    const rotulo = midia
      ? (/^image\//.test(midia.mime) ? "Foto"
        : /^video\//.test(midia.mime) ? "Vídeo"
        : /^audio\//.test(midia.mime) ? "Áudio"
        : midia.nome || "Documento")
      : "";
    const corpo = texto || rotulo || (tipo ? `[${tipo}]` : "[mensagem sem texto]");

    if (temMidia) lembrar({ em: Date.now(), evento, tipo, resultado: midia ? "mídia guardada" : "MÍDIA NÃO BAIXOU — ver log do servidor" });

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

    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "in", null, null, corpo,
        midia?.url || null, midia?.mime || null, midia?.nome || null, Date.now());

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
