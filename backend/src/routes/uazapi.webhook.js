import { Router } from "express";
import { normalizePhone } from "../services/stages.js";
import { canalDoWhatsapp } from "../services/canais.js";
import { processarMensagemRecebida, lembrar } from "../services/mensageria.js";

const r = Router();

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
      return lembrar({ em: Date.now(), evento, provider: "uazapi", resultado: "ignorado (não é mensagem nova)", campos: Object.keys(p), campos_internos: Object.keys(p.message || p.data || {}).slice(0, 25) });

    const { phone, texto, tipo, content, messageid, nome, fromMe, citada, ignorar } = extrair(p);
    if (ignorar) return lembrar({ em: Date.now(), evento, provider: "uazapi", resultado: "ignorado: " + ignorar });
    if (!phone) return lembrar({ em: Date.now(), evento, provider: "uazapi", resultado: "sem número — payload não reconhecido", amostra: Object.keys(p) });

    /* DE QUAL imobiliária é esta mensagem?

       Com mais de uma imobiliária na plataforma, cada uma tem o seu WhatsApp, e
       este endereço é o mesmo para todas. Sem esta pergunta, a mensagem do
       cliente de uma casa entraria na conversa da outra — e um cliente que já
       existisse como lead na primeira sequestraria a conversa da segunda.

       O reconhecimento é pelo token da instância que a Uazapi manda junto (ou
       pelo número dono dela). Não dando para saber, a mensagem NÃO entra: lead
       na casa errada é pior do que lead perdido, e o diagnóstico mostra o que
       chegou para acertar a configuração. */
    const canal = canalDoWhatsapp({
      token: p.token || p.instance_token || p.instanceToken || p.apikey || p.instance?.token,
      numero: p.owner || p.instance?.owner || p.instanceOwner || p.me || "",
    });
    if (!canal) {
      /* A RECUSA PRECISA DIZER QUAL DAS DUAS COISAS FALTOU. (02/09/2026)

         Desde que o reconhecimento pelo número saiu do padrão (ver
         `canalDoWhatsapp`), existem dois motivos diferentes para cair aqui, e
         eles pedem remédios opostos: "a instância não está conectada" se
         resolve conectando; "o payload veio sem token" se resolve ligando o
         modo de emergência ou acertando a configuração da Uazapi. Uma frase só
         para os dois mandaria metade das pessoas consertar o que não está
         quebrado — que é exatamente o erro que este projeto já cometeu com o
         403 do R2. */
      const tinhaToken = !!(p.token || p.instance_token || p.instanceToken || p.apikey || p.instance?.token);
      return lembrar({ em: Date.now(), evento, provider: "uazapi",
        resultado: tinhaToken
          ? "RECUSADO: veio um token, mas ele não corresponde a nenhuma linha conectada"
          : "RECUSADO: a mensagem chegou SEM o token da instância",
        dica: tinhaToken
          ? "Confira o token em Configurações → Conexão (linha da imobiliária) ou em Minha conta → Meu WhatsApp (linha do corretor). Ele precisa ser o mesmo da instância na Uazapi."
          : "O reconhecimento pelo NÚMERO foi desligado por segurança: o número da imobiliária é público, e qualquer pessoa poderia mandar mensagem falsa para o CRM sabendo ele. Se a sua Uazapi realmente não manda o token, crie a variável UAZAPI_ACEITAR_POR_NUMERO=1 no painel da hospedagem para religar o caminho antigo — e avise o ConHub.",
        campos: Object.keys(p) });
    }

    // Em mensagem de mídia, `content` é um objeto com URL — em mensagem de
    // texto ele é nulo ou não tem esses campos, daí a checagem aqui e não
    // dentro de services/mensageria.js (que não sabe o formato da Uazapi).
    const temMidia = !!(content && (content.URL || content.url));

    await processarMensagemRecebida({ canal, evento, phone, texto, tipo, content, temMidia, fromMe, citada, messageid, nome });
  } catch (e) {
    lembrar({ em: Date.now(), resultado: "erro: " + e.message });
    console.error("[uazapi] webhook erro:", e.message);
  }
});

export default r;
