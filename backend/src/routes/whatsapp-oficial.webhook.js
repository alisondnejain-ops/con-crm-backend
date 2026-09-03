/* Webhook da API OFICIAL da Meta (WhatsApp Cloud API) — 03/09/2026.

   Formato completamente diferente do da Uazapi:
     entry[].changes[].value.{ metadata, contacts, messages, statuses }
   em vez do payload solto que cada versão da Uazapi manda do seu jeito.

   A DIFERENÇA QUE MOLDA ESTA ROTA: aqui cada imobiliária tem o PRÓPRIO
   aplicativo na Meta, com o próprio `app_secret` e `verify_token` — não um
   segredo do servidor, como em `meta.webhook.js` (o webhook de Lead Ads, que
   é UM app do ConHub para todo mundo). Então a ordem de trabalho é ao
   contrário do que pareceria natural: primeiro descobrir DE QUEM é a
   mensagem (pelo `phone_number_id`, que a Meta manda em toda mensagem), para
   só então saber QUAL app_secret usar na conferência da assinatura. Sem essa
   ordem não dá para conferir nada — não existe segredo único para testar. */
import { Router } from "express";
import db from "../db.js";
import { canalPorPhoneNumberId } from "../services/canais.js";
import { assinaturaValida } from "../services/whatsapp_oficial.js";
import { normalizePhone } from "../services/stages.js";
import { processarMensagemRecebida, lembrar } from "../services/mensageria.js";

const r = Router();

/* 1) Verificação do webhook — a Meta chama com GET, uma vez por app, quando
   o gestor cola a URL na tela de configuração do WhatsApp do aplicativo
   dele. A URL é a MESMA para toda imobiliária (é o nosso único endereço de
   webhook); o que muda é o `verify_token` de cada uma. Por isso a
   conferência aqui não escolhe uma linha antes — ela testa o token contra
   TODAS as linhas oficiais já conectadas, e aceita se alguma bater. */
r.get("/whatsapp-oficial", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = req.query["hub.challenge"];
  if (mode !== "subscribe" || !token) return res.sendStatus(403);
  const bate = db.prepare("SELECT 1 FROM canais WHERE provider = 'meta' AND verify_token = ? LIMIT 1").get(token);
  if (bate) return res.status(200).send(challenge);
  res.sendStatus(403);
});

/* Traduz o formato da Meta para o envelope comum que
   services/mensageria.js entende — ver o comentário lá para o que cada
   campo precisa valer. */
function extrairEnvelopes(value) {
  const mensagens = value?.messages || [];
  const contatos = value?.contacts || [];
  return mensagens.map((m) => {
    const contato = contatos.find((c) => c.wa_id === m.from) || contatos[0];
    const tipo = m.type || "";
    let texto = "", content = null;
    if (tipo === "text") {
      texto = m.text?.body || "";
    } else if (["image", "video", "audio", "document", "sticker"].includes(tipo)) {
      const bloco = m[tipo] || {};
      texto = bloco.caption || "";
      // `mediaId` (e não URL/base64) é o que identifica o arquivo na Meta —
      // ver services/midia.js, que já sabe baixar por este campo.
      content = { mediaId: bloco.id, mimetype: bloco.mime_type, fileName: bloco.filename || "" };
    } else if (tipo === "button") {
      texto = m.button?.text || "";
    } else if (tipo === "interactive") {
      texto = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
    } else if (tipo === "location") {
      texto = "[localização compartilhada]";
    }
    return {
      phone: normalizePhone(m.from || ""),
      texto: String(texto).trim(),
      tipo,
      content,
      temMidia: !!content,
      // A Cloud API NUNCA devolve pelo webhook uma mensagem que ela mesma
      // mandou — diferente da Uazapi, que espelha o WhatsApp inteiro. Por
      // isso `fromMe` é sempre falso aqui, e não uma leitura do payload.
      fromMe: false,
      citada: m.context?.id || "",
      messageid: m.id || "",
      nome: contato?.profile?.name || "",
    };
  });
}

// 2) Recebimento das mensagens.
r.post("/whatsapp-oficial", async (req, res) => {
  const body = req.body || {};
  // A assinatura é sobre os BYTES originais; o corpo já virou objeto pelo
  // express.json. Mesma aproximação documentada em meta.webhook.js: na
  // prática o JSON que a Meta manda é compacto e reconstrói igual, e se um
  // dia deixar de reconstruir, o sintoma é a recusa — visível no
  // diagnóstico, não silencioso.
  const raw = JSON.stringify(body);

  // DE QUEM é esta mensagem? Precisa vir antes da assinatura, porque é o
  // `phone_number_id` que diz qual app_secret conferir.
  let canal = null;
  busca: for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const pid = change.value?.metadata?.phone_number_id;
      if (pid) { canal = canalPorPhoneNumberId(pid); if (canal) break busca; }
    }
  }

  if (!canal) {
    // 200, e não 401/404: a Meta reenvia payload que respondeu erro, e um
    // Phone Number ID que nunca vai casar (linha desligada, ou nunca ligada
    // nesta instalação) só encheria o log de reentregas. O diagnóstico
    // registra o motivo de verdade.
    res.sendStatus(200);
    lembrar({ em: Date.now(), evento: "messages", provider: "meta",
      resultado: "RECUSADO: nenhuma linha conectada tem este Phone Number ID",
      campos: Object.keys(body) });
    return;
  }

  if (!assinaturaValida(raw, req.get("x-hub-signature-256"), canal.app_secret)) {
    console.warn("[whatsapp-oficial] webhook recusado: assinatura não confere (confira o App Secret da conexão)");
    lembrar({ em: Date.now(), evento: "messages", provider: "meta", resultado: "RECUSADO: assinatura não confere" });
    return res.sendStatus(401);
  }

  res.sendStatus(200); // responde rápido; processa depois — mesma regra da Uazapi: webhook lento é webhook que o provedor desiste de chamar.

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const pid = value.metadata?.phone_number_id;
        // Um payload pode trazer changes de mais de uma linha (múltiplos
        // números do mesmo WABA reportando no mesmo lote) — resolve de novo
        // por precaução, caindo no canal já identificado quando não achar.
        const canalDoEvento = pid ? (canalPorPhoneNumberId(pid) || canal) : canal;

        if (!value.messages?.length) {
          // Confirmação de entrega/leitura (`statuses`) não é mensagem nova —
          // mesma régua do "ignorado (não é mensagem nova)" da Uazapi.
          if (value.statuses?.length)
            lembrar({ em: Date.now(), evento: "messages", provider: "meta",
              resultado: `ignorado (status de entrega: ${value.statuses[0].status || "?"})` });
          continue;
        }

        for (const envelope of extrairEnvelopes(value)) {
          if (!envelope.phone) continue;
          await processarMensagemRecebida({ canal: canalDoEvento, evento: "messages", ...envelope });
        }
      }
    }
  } catch (e) {
    lembrar({ em: Date.now(), evento: "messages", provider: "meta", resultado: "erro: " + e.message });
    console.error("[whatsapp-oficial] webhook erro:", e.message);
  }
});

export default r;
