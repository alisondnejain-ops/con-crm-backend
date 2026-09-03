import { salvar } from "./storage.js";
import { baixarMidiaOficial } from "./whatsapp_oficial.js";

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

/* AS CREDENCIAIS VÊM DA LINHA QUE RECEBEU A MENSAGEM (31/08/2026).

   Aqui ficou um resto da época em que a Uazapi era do SERVIDOR: `UAZAPI_HOST`
   e `UAZAPI_TOKEN` das variáveis de ambiente. A migração de 2026 mudou o envio
   para as credenciais da imobiliária e esqueceu deste caminho — e o esquecido
   não dava erro nenhum na Conecta, porque as variáveis apontavam justamente
   para a instância dela. Numa segunda imobiliária, toda foto que o cliente
   mandasse falharia em silêncio e a conversa guardaria só o rótulo "Foto".

   Com linhas pessoais isso ficaria pior: a foto que o cliente manda para o
   número do corretor só é baixável com o token DAQUELA instância. */

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
async function viaUazapi(messageid, canal) {
  const host = String(canal?.host || "").replace(/\/$/, "");
  const token = String(canal?.token || "");
  if (!host || !token || !messageid) throw new Error("a linha que recebeu não tem conexão configurada");
  const res = await fetch(`${host}/message/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token },
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

/* NA LINHA OFICIAL DA META, o download é outra coisa (03/09/2026): não há
   URL nem base64 no payload — só um `media_id` que precisa de duas chamadas
   autenticadas com o token do WABA (ver `baixarMidiaOficial` em
   services/whatsapp_oficial.js). `content.mediaId` é o que o extrator do
   webhook oficial põe ali para dizer isso; nas linhas Uazapi esse campo
   nunca existe, e por isso a escolha de caminho é só olhar o provedor do
   canal — content por si só não diferencia os dois formatos. */

// Devolve { url, mime, nome } ou null. Nunca lança: mídia que não desce não
// pode derrubar o recebimento da mensagem — o texto e o lead importam mais.
export async function guardarMidiaRecebida({ content, messageid, tipo, canal = null }) {
  if (!content || typeof content !== "object") return null;
  const mimeDeclarado = content.mimetype || content.mimeType || "";
  const nome = content.fileName || content.title || "";
  const tentativas = [];

  const vias = canal?.provider === "meta"
    ? [["Meta (download autenticado)", () => baixarMidiaOficial(content.mediaId, canal)]]
    : [
        ["uazapi /message/download", () => viaUazapi(messageid, canal)],
        ["link direto do payload", () => baixarDe(content.URL || content.url, {})],
      ];

  for (const [via, fn] of vias) {
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
