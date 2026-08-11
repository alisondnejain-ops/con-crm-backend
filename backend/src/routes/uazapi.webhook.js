import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { normalizePhone } from "../services/stages.js";
import { proximoAtendente } from "../services/catraca.js";
import { guardarMidiaRecebida } from "../services/midia.js";
import { avisar } from "../services/push.js";
import { advanceStage } from "./messages.routes.js";
import { orgDoWhatsapp } from "../services/uazapi.js";

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
  /* Mensagem que SAIU do número da Conecta.

     Antes era descartada aqui, para a mensagem enviada pelo próprio CRM não
     aparecer duas vezes. Só que junto ia embora o que o corretor digita direto
     no celular ou no WhatsApp Web — e o histórico do CRM ficava pela metade,
     que foi a reclamação da equipe.

     Agora ela segue adiante e quem separa é o `messageid`: se for uma que o
     CRM mandou, já está gravada e é descartada lá na frente. */
  const fromMe = !!(m.fromMe ?? m.key?.fromMe);

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
    fromMe,
    /* Quando o CLIENTE responde uma mensagem específica, o WhatsApp manda o id
       da citada junto. O campo muda de nome conforme a versão, então tentamos
       os conhecidos — não achando, a mensagem entra sem citação, como antes. */
    citada: m.quotedMessageId || m.quoted?.messageid || m.quoted?.id
      || m.contextInfo?.stanzaId || m.context?.id || m.replyid || "",
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

    const { phone, texto, tipo, content, messageid, nome, fromMe, citada, ignorar } = extrair(p);
    if (ignorar) return lembrar({ em: Date.now(), evento, resultado: "ignorado: " + ignorar });
    if (!phone) return lembrar({ em: Date.now(), evento, resultado: "sem número — payload não reconhecido", amostra: Object.keys(p) });

    /* DE QUAL imobiliária é esta mensagem?

       Com mais de uma imobiliária na plataforma, cada uma tem o seu WhatsApp, e
       este endereço é o mesmo para todas. Sem esta pergunta, a mensagem do
       cliente de uma casa entraria na conversa da outra — e um cliente que já
       existisse como lead na primeira sequestraria a conversa da segunda.

       O reconhecimento é pelo token da instância que a Uazapi manda junto (ou
       pelo número dono dela). Não dando para saber, a mensagem NÃO entra: lead
       na casa errada é pior do que lead perdido, e o diagnóstico mostra o que
       chegou para acertar a configuração. */
    const orgId = orgDoWhatsapp({
      token: p.token || p.instance_token || p.instanceToken || p.apikey || p.instance?.token,
      numero: p.owner || p.instance?.owner || p.instanceOwner || p.me || "",
    });
    if (!orgId) return lembrar({ em: Date.now(), evento,
      resultado: "ignorado: não identifiquei de qual imobiliária é este WhatsApp",
      dica: "Conecte a instância em Configurações → Conexão da imobiliária dona deste número.",
      campos: Object.keys(p) });

    /* Mensagem que o CRM mandou volta como webhook. Ela já está na conversa —
       gravar de novo seria a mesma mensagem duas vezes. O `wa_id` é o que
       diferencia isso do corretor digitando no celular. */
    if (fromMe && messageid && db.prepare(`SELECT 1 FROM messages m JOIN leads l ON l.id = m.lead_id
      WHERE m.wa_id = ? AND l.org_id = ?`).get(messageid, orgId))
      return lembrar({ em: Date.now(), evento, resultado: "ignorado: eco da mensagem enviada pelo próprio CRM" });

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

    let lead = db.prepare("SELECT * FROM leads WHERE phone = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1").get(phone, orgId);
    const ehNovo = !lead;

    /* Saiu do celular para um número que ainda não é lead: não cria lead.
       O número da Conecta também fala com colega, fornecedor e parente — e
       cada uma dessas conversas viraria um lead na fila da atendente. Quando
       for cliente de verdade, ele responde, e aí o lead nasce pelo caminho
       normal, na regra da catraca. */
    if (!lead && fromMe)
      return lembrar({ em: Date.now(), evento, resultado: "ignorado: enviada para um número que ainda não é lead" });

    // Número desconhecido = lead novo entrando pelo WhatsApp. Vai direto para a
    // atendente da vez, exatamente como um lead vindo da Meta.
    if (!lead) {
      const id = "l_" + randomUUID();
      const dono = proximoAtendente(orgId);
      db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,qual_json,stage,assigned_to,created_at)
        VALUES (?,?,?,?,'WhatsApp','MORNO','{}','Lead',?,?)`)
        .run(id, orgId, nome || "Contato do WhatsApp", phone, dono, Date.now());
      lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
      console.log(`[uazapi] lead NOVO pelo WhatsApp: ${lead.name} (${phone}) — ${dono ? "para a atendente da vez" : "sem atendente cadastrado, foi para a fila"}`);
    }

    /* `from_name` fica vazio numa mensagem enviada pelo celular: o número é
       único e o WhatsApp não diz qual corretor digitou. A tela mostra
       "enviada pelo WhatsApp" — melhor um autor honesto em branco do que
       assinar com o nome errado. */
    // A citada chega pelo id do WhatsApp; aqui vira o id local, que é o que a
    // tela usa para desenhar o trecho citado.
    const citadaLocal = citada
      ? (db.prepare("SELECT id FROM messages WHERE wa_id = ? AND lead_id = ?").get(citada, lead.id) || {}).id || null
      : null;

    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,wa_id,reply_to,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, fromMe ? "out" : "in", null, null, corpo,
        midia?.url || null, midia?.mime || null, midia?.nome || null, messageid || null, citadaLocal, Date.now());

    // Respondeu pelo celular? Continua sendo a primeira resposta — sem isto o
    // relatório contaria como "nunca atendido" quem atendeu fora do CRM.
    if (fromMe && !lead.first_resp_at)
      db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(Date.now(), lead.id);

    // Cliente voltou a falar: atendimento finalizado reabre sozinho, senão a
    // mensagem cairia numa conversa escondida e ninguém responderia.
    if (lead.closed_at) {
      db.prepare("UPDATE leads SET closed_at = NULL WHERE id = ?").run(lead.id);
      console.log(`[uazapi] atendimento de ${lead.name} reaberto: o cliente respondeu`);
    }

    advanceStage(lead.id);

    // Aviso no celular de quem está com o lead. Lead que acabou de entrar e
    // cliente que respondeu são situações diferentes — e a pressa também.
    if (lead.assigned_to && !fromMe) {
      const resumo = corpo.length > 90 ? corpo.slice(0, 90) + "…" : corpo;
      avisar(lead.assigned_to, ehNovo
        ? { titulo: "Novo lead no WhatsApp", corpo: `${lead.name} acabou de chamar. Responda agora — os primeiros minutos decidem.`, leadId: lead.id }
        : { titulo: `${lead.name} respondeu`, corpo: resumo, leadId: lead.id });
    }

    lembrar({ em: Date.now(), evento, resultado: fromMe ? "ok (enviada pelo celular)" : "ok", lead: lead.name, tipo });
    console.log(`[uazapi] mensagem ${fromMe ? "enviada pelo celular para" : "recebida de"} ${lead.name}`);
  } catch (e) {
    lembrar({ em: Date.now(), resultado: "erro: " + e.message });
    console.error("[uazapi] webhook erro:", e.message);
  }
});

export default r;
