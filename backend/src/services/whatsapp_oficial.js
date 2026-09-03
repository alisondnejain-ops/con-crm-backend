/* Integração com a API OFICIAL da Meta (WhatsApp Cloud API) — 03/09/2026.
   Ver `services/canais.js` para o que muda de modelo (host+token por
   instância na Uazapi × token do WABA compartilhado por várias linhas aqui).

   ESTE ARQUIVO FALA SÓ COM A META. Ele não decide qual linha usar (isso é
   `services/canais.js`) nem quem chama envio (isso é `services/uazapi.js`,
   que despacha para cá quando `canal.provider === 'meta'`) — ele só sabe
   transformar um pedido de envio em uma chamada HTTP para graph.facebook.com,
   e uma resposta da Meta num formato que o resto do sistema já entende.

   Diferenças que moldaram o código, na ordem em que elas doem:

   1. NÃO HÁ "host": o endereço é sempre graph.facebook.com. O que muda por
      linha é o `phone_number_id` — ele entra na URL, não no corpo.
   2. MÍDIA NÃO VAI POR URL PÚBLICA nem por base64 no corpo. É upload em duas
      etapas: manda os bytes (multipart) para `/{phone_number_id}/media`,
      recebe um `id`, e manda a MENSAGEM referenciando esse id. A Uazapi
      aceita link ou base64 direto; a Meta não.
   3. NÃO EXISTE EDITAR MENSAGEM. É limitação da própria plataforma — nenhuma
      versão da Graph API tem esse endpoint. `editMessage` aqui sempre
      recusa, e a regra de ouro do projeto ("o texto só muda no CRM depois que
      o WhatsApp confirmar a edição") continua de pé: recusar é o CORRETO,
      não uma falha desta integração.
   4. FORA DA JANELA DE 24H desde a última mensagem do cliente, só modelo
      aprovado (`type: "template"`) sai — texto livre é recusado pela própria
      Meta. Isto ainda não tem UI (fica para quando o cliente pedir o
      catálogo de modelos), mas o erro que a Meta devolve é repassado tal
      qual, em vez de um "falha ao enviar" genérico — é a única forma de o
      corretor entender por que a mensagem não saiu. */

import { createHmac, timingSafeEqual } from "crypto";

const VERSAO = process.env.META_GRAPH_VERSION || "v21.0";
const BASE = "https://graph.facebook.com";

// Teto do próprio WhatsApp para mídia — maior que os 25MB da Uazapi porque
// vídeo aceito pela Meta chega a 16MB e documento a 100MB; ficamos com uma
// margem única e simples em vez de replicar a tabela por tipo.
const LIMITE_MIDIA = 100 * 1024 * 1024;

export function configuradoOficial(canal) {
  return !!(canal && canal.provider === "meta" && canal.token && canal.phone_number_id);
}

/* Mesma regra da Uazapi, e pela mesma razão: `*Nome:*` existe porque o
   número é único para todo mundo da imobiliária; na linha pessoal do
   corretor seria a pessoa se anunciando na própria casa. Duplicar esta
   função de quatro linhas em vez de importar de uazapi.js evita o acoplamento
   inverso (uazapi.js é quem despacha PARA cá, nunca o contrário). */
function assinar(text, signedBy, canal) {
  if (!signedBy) return text;
  if (canal && canal.tipo === "corretor") return text;
  return `*${signedBy}:*\n${text}`;
}

async function chamar(canal, caminho, { method = "GET", json, form } = {}) {
  if (!canal || !canal.token) throw new Error("Esta linha não tem a API oficial da Meta conectada.");
  const headers = { Authorization: `Bearer ${canal.token}` };
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  else if (form) { body = form; } // FormData define o próprio Content-Type (com boundary)

  let res;
  try {
    res = await fetch(`${BASE}/${VERSAO}/${caminho}`, { method, headers, body });
  } catch (e) {
    throw new Error(`Não consegui falar com a Meta (rede): ${e.message}`);
  }
  const bruto = await res.text().catch(() => "");
  let data = {};
  try { data = bruto ? JSON.parse(bruto) : {}; } catch { data = {}; }

  if (!res.ok) {
    console.error(`[whatsapp-oficial] ${caminho} respondeu ${res.status}:`, bruto.slice(0, 800) || "(corpo vazio)");
    /* A Meta sempre erra em `error.message`, com `error.error_user_msg` quando
       existe uma explicação pensada para quem usa (ex.: fora da janela de
       24h, modelo não aprovado). Preferimos essa quando ela vier — é a que o
       corretor tem chance de entender. */
    const erro = data?.error || {};
    if (erro.code === 190) throw new Error("Token da Meta inválido ou vencido. Gere um novo em Configurações → Conexão.");
    const explicacao = erro.error_user_msg || erro.message;
    if (explicacao) throw new Error(explicacao);
    throw new Error(`A Meta respondeu ${res.status} em ${caminho}${bruto ? `: ${bruto.slice(0, 180)}` : ""}`);
  }
  return data;
}

export async function sendText({ canal, toPhone, text, signedBy, replyTo }) {
  const assinado = assinar(text, signedBy, canal);
  const payload = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "text",
    text: { body: assinado, preview_url: false },
  };
  // `context.message_id` é o equivalente da citação — precisa do id que a
  // PRÓPRIA META deu à mensagem original (o `wa_id`), não de um id local.
  if (replyTo) payload.context = { message_id: replyTo };
  const data = await chamar(canal, `${canal.phone_number_id}/messages`, { method: "POST", json: payload });
  return { ok: true, data, messageid: data?.messages?.[0]?.id || null };
}

/* Upload em duas etapas — é a diferença mais cara desta integração em
   relação à Uazapi, e a razão de este arquivo precisar de `FormData`/`Blob`
   (built-in do Node, sem dependência nova, seguindo a regra do projeto de
   não somar mais uma coisa que pode quebrar o `npm install`). */
async function subirMidia(canal, buffer, mime, nomeArquivo) {
  if (!buffer || !buffer.length) throw new Error("arquivo vazio");
  if (buffer.length > LIMITE_MIDIA) throw new Error(`arquivo grande demais (${Math.round(buffer.length / 1048576)} MB)`);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mime || "application/octet-stream" }), nomeArquivo || "arquivo");
  const data = await chamar(canal, `${canal.phone_number_id}/media`, { method: "POST", form });
  if (!data.id) throw new Error("a Meta não devolveu o id do arquivo enviado");
  return data.id;
}

/* `type` aqui é o mesmo vocabulário que a Uazapi já usa no resto do sistema
   (image | video | audio | ptt | document) — traduzido para o que a Meta
   espera (ptt e audio são a mesma coisa para ela: "audio"). */
const TIPO_META = { image: "image", video: "video", audio: "audio", ptt: "audio", document: "document" };

export async function sendMedia({ canal, toPhone, type, caption, signedBy, docName, bytes, mime }) {
  const tipo = TIPO_META[type] || "document";
  let buffer;
  try { buffer = typeof bytes === "function" ? await bytes() : bytes; }
  catch (e) { throw new Error(`não consegui ler o arquivo para enviar: ${e.message}`); }
  if (!buffer || !buffer.length) throw new Error("arquivo vazio ou indisponível para envio");

  const mediaId = await subirMidia(canal, buffer, mime, docName);

  const legenda = caption ? assinar(caption, signedBy, canal) : undefined;
  const campoMidia = { id: mediaId };
  // A Meta só aceita `caption` em image/video/document — em áudio ela recusa
  // o campo (mensagem de voz não tem legenda no WhatsApp de verdade).
  if (legenda && tipo !== "audio") campoMidia.caption = legenda;
  if (tipo === "document" && docName) campoMidia.filename = docName;

  const payload = { messaging_product: "whatsapp", to: toPhone, type: tipo, [tipo]: campoMidia };
  const data = await chamar(canal, `${canal.phone_number_id}/messages`, { method: "POST", json: payload });
  return { ok: true, data, messageid: data?.messages?.[0]?.id || null };
}

export async function sendLocation({ canal, toPhone, latitude, longitude, name, address }) {
  const payload = {
    messaging_product: "whatsapp", to: toPhone, type: "location",
    location: { latitude, longitude, name, address },
  };
  const data = await chamar(canal, `${canal.phone_number_id}/messages`, { method: "POST", json: payload });
  return { ok: true, data, messageid: data?.messages?.[0]?.id || null };
}

// A Graph API não tem endpoint de edição — em nenhuma versão. Recusar aqui é
// o comportamento CORRETO: quem chama (routes/messages.routes.js) só toca o
// banco depois de uma confirmação de sucesso, e sem ela o texto do CRM
// continua sendo o que o cliente recebeu de verdade.
export async function editMessage() {
  throw new Error("A API oficial da Meta não permite editar mensagem já enviada — é uma limitação da própria plataforma, não do ConHub.");
}

// O que a tela de diagnóstico mostra: o número verificado e o nome de
// exibição. Não existe "status de pareamento" como na Uazapi — a linha ou
// tem token+phone_number_id válidos, ou a Meta recusa com 401/403.
export async function instanceStatus(canal) {
  if (!configuradoOficial(canal)) {
    return {
      configurado: false,
      endereco: canal?.phone_number_id ? `definido (${canal.phone_number_id})` : "FALTANDO (Phone Number ID)",
      token: canal?.token ? `definido (${canal.token.length} caracteres)` : "FALTANDO (token de acesso)",
      dica: "Conecte a API oficial da Meta em Configurações → Conexão, com o Phone Number ID e o token permanente do seu aplicativo.",
    };
  }
  try {
    const data = await chamar(canal, `${canal.phone_number_id}?fields=verified_name,display_phone_number,quality_rating`);
    return {
      configurado: true, ok: true,
      status: data.quality_rating || "desconhecido",
      numero: mascarar(data.display_phone_number || ""),
      nome: data.verified_name || "",
    };
  } catch (e) {
    return { configurado: true, ok: false, erro: e.message };
  }
}

const mascarar = (n) => {
  const d = String(n).replace(/\D/g, "");
  return d.length < 8 ? d : d.slice(0, 4) + "*".repeat(d.length - 8) + d.slice(-4);
};

/* Baixar mídia que o CLIENTE mandou — duas chamadas, as duas com o Bearer:
   1) GET /{media_id} devolve uma URL temporária (minutos de validade);
   2) GET nessa URL, ainda com o token, devolve os bytes de verdade.
   É o equivalente do `viaUazapi` em services/midia.js, e entra na mesma
   lista de tentativas de `guardarMidiaRecebida`. */
export async function baixarMidiaOficial(mediaId, canal) {
  if (!canal?.token || !mediaId) throw new Error("linha oficial sem token, ou mensagem sem id de mídia");
  const meta = await chamar(canal, mediaId);
  if (!meta.url) throw new Error("a Meta não devolveu o endereço do arquivo");
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${canal.token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o arquivo da Meta`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > LIMITE_MIDIA) throw new Error("arquivo grande demais");
  return { buffer, mime: meta.mime_type || res.headers.get("content-type") || "" };
}

/* A Meta desconecta um número REMOVENDO-o do WABA — ação destrutiva e
   irreversível pela API (a linha teria que ser recadastrada do zero, com
   novo código de verificação). Não automatizamos isso: "desconectar" aqui
   é o servidor parar de usar a credencial, o que a rota de configuração já
   faz apagando o token localmente — sem chamar a Meta. */
export async function desconectarInstanciaOficial() {
  return { aviso: "A linha continua registrada na Meta. Para remover o número de verdade, use o Gerenciador de negócios (business.facebook.com) → WhatsApp → Configurações do número." };
}

/* Confere a assinatura do webhook (`X-Hub-Signature-256: sha256=...`) contra
   o APP SECRET desta imobiliária. Sem isto qualquer um que soubesse a URL do
   webhook (que não é segredo — a Meta exige que ela seja pública) poderia
   fabricar um evento e escrever na conversa de um cliente, ou pior, num
   endpoint que ligasse o robô, fazer a IA mandar mensagem para quem quisesse.

   `raw` precisa ser a STRING que foi de fato assinada. Este projeto já
   documentou a mesma aproximação em `meta.webhook.js` (Lead Ads): o
   `JSON.stringify(req.body)` reconstruído não é byte a byte idêntico ao que
   a Meta assinou, mas casa na prática (chaves na mesma ordem, sem espaço
   extra) — o registro fica aqui para não reinventar essa decisão depois. */
export function assinaturaValida(raw, header, appSecret) {
  if (!appSecret) return false;
  const recebida = String(header || "").replace(/^sha256=/, "");
  if (!recebida) return false;
  const esperada = createHmacHex(appSecret, raw);
  if (recebida.length !== esperada.length) return false;
  return timingSafeEqualHex(recebida, esperada);
}

function createHmacHex(secret, raw) { return createHmac("sha256", secret).update(raw, "utf8").digest("hex"); }
function timingSafeEqualHex(a, b) {
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
  catch { return false; }
}
