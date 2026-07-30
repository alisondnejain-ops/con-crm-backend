import { salvar } from "./storage.js";

/* Mídia que o CLIENTE manda pelo WhatsApp (foto, áudio, documento).

   Antes o arquivo era jogado fora e a conversa guardava só "[ImageMessage]".
   Agora baixamos, guardamos junto com as fotos dos imóveis (services/storage)
   e a conversa mostra a imagem, toca o áudio e oferece o documento.

   O payload da Uazapi (confirmado na conta da Conecta em 30/07/2026) traz:
     content: { URL, mimetype, fileLength, mediaKey, fileEncSHA256, directPath, ... }
   e, em documento, também content.fileName / content.title.

   O laço da URL: o link que vem em content.URL costuma apontar para o servidor
   do próprio WhatsApp, onde o arquivo está CRIPTOGRAFADO — baixar direto rende
   bytes embaralhados. Por isso tentamos, nesta ordem:
     1) /message/download da Uazapi, que devolve o arquivo já aberto;
     2) content.URL direto, que serve quando o provedor já entrega decifrado.
   Cada tentativa diz o que aconteceu, para o diagnóstico não virar adivinhação. */

const HOST = (process.env.UAZAPI_HOST || "").replace(/\/$/, "");
const TOKEN = process.env.UAZAPI_TOKEN || "";

// Teto por arquivo. Documento de cliente costuma ser pequeno; vídeo é o que
// enche o disco da hospedagem, e é o motivo do R2 existir na lista de próximos passos.
const LIMITE = 25 * 1024 * 1024;

const ehMidia = (b) => b && b.byteLength > 0;

async function baixarDe(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tamanho = Number(res.headers.get("content-length") || 0);
  if (tamanho > LIMITE) throw new Error(`arquivo grande demais (${Math.round(tamanho / 1048576)} MB)`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > LIMITE) throw new Error("arquivo grande demais");
  return { buffer, mime: res.headers.get("content-type") || "" };
}

// A Uazapi devolve ora um link temporário, ora o arquivo em base64 — os dois
// caminhos aparecem conforme a versão, então tratamos ambos.
async function viaUazapi(messageid) {
  if (!HOST || !TOKEN || !messageid) throw new Error("Uazapi não configurada");
  const res = await fetch(`${HOST}/message/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: TOKEN },
    body: JSON.stringify({ id: messageid }),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.message || `HTTP ${res.status}`);

  const link = dados.fileURL || dados.url || dados.URL || dados.mediaUrl;
  if (link) return baixarDe(link, {});

  const b64 = dados.base64 || dados.file || dados.data;
  if (b64) {
    const limpo = String(b64).replace(/^data:[^;]+;base64,/, "");
    return { buffer: Buffer.from(limpo, "base64"), mime: dados.mimetype || "" };
  }
  throw new Error("resposta sem arquivo nem link");
}

/* Devolve { url, mime, nome } ou null. Nunca lança: mídia que não desce não
   pode derrubar o recebimento da mensagem — o texto e o lead importam mais. */
export async function guardarMidiaRecebida({ content, messageid, tipo }) {
  if (!content || typeof content !== "object") return null;
  const mimeDeclarado = content.mimetype || content.mimeType || "";
  const nome = content.fileName || content.title || "";
  const tentativas = [];

  for (const [via, fn] of [
    ["uazapi /message/download", () => viaUazapi(messageid)],
    ["link direto do payload", () => baixarDe(content.URL || content.url, {})],
  ]) {
    try {
      const r = await fn();
      if (!ehMidia(r.buffer)) throw new Error("veio vazio");
      // O mimetype declarado pelo WhatsApp manda: é ele que sabe que aquilo é um
      // PDF. O cabeçalho do download serve só de reserva — provedor que responde
      // "image/png" para tudo faria um comprovante virar foto na tela.
      const mime = (mimeDeclarado || r.mime || "").split(";")[0].trim();
      const { url } = await salvar({ buffer: r.buffer, mime, prefixo: "conversas" });
      console.log(`[midia] ${tipo} guardada via ${via} (${Math.round(r.buffer.byteLength / 1024)} kB)`);
      return { url, mime, nome };
    } catch (e) {
      tentativas.push(`${via}: ${e.message}`);
    }
  }
  console.warn(`[midia] ${tipo} não pôde ser guardada — ${tentativas.join(" | ")}`);
  return null;
}
