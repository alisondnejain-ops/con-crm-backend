// Integração com a uazapiGO v2 (WhatsApp não-oficial) — número ÚNICO da Conecta.
//
// Confirmado na API da Conecta (https://conectaimoveis.uazapi.com):
//   - autenticação: header `token` com o token DA INSTÂNCIA (não o Admin Token)
//   - texto:        POST /send/text      { number, text }
//   - mídia:        POST /send/media     { number, type, file, text? }
//   - localização:  POST /send/location  { number, latitude, longitude, ... }
// Sem token válido a API responde 401 {"message":"Invalid token."}.

const HOST = (process.env.UAZAPI_HOST || "").replace(/\/$/, "");
const TOKEN = process.env.UAZAPI_TOKEN || "";

export const uazapiConfigured = () => !!(HOST && TOKEN);

async function call(path, payload) {
  if (!uazapiConfigured()) {
    console.warn(`[uazapi] HOST/TOKEN não configurados — ${path} não foi enviado de verdade.`);
    return { ok: false, simulated: true };
  }
  let res;
  try {
    res = await fetch(`${HOST}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: TOKEN },
      // track_source identifica no painel da Uazapi o que saiu pelo CRM.
      body: JSON.stringify({ track_source: "con-crm", ...payload }),
    });
  } catch (e) {
    throw new Error(`Não consegui falar com o WhatsApp (rede): ${e.message}`);
  }
  /* Lê como TEXTO antes de tentar o JSON.
     Com `res.json()` direto, uma resposta que não fosse JSON — página de erro
     em HTML, texto solto — virava objeto vazio e o motivo real da falha
     evaporava. Foi o que aconteceu no 500 do /send/media em 06/08/2026: a
     tela dizia "Uazapi respondeu 500" e ninguém, nem o servidor, sabia o que
     ela tinha dito de verdade. */
  const bruto = await res.text().catch(() => "");
  let data = {};
  try { data = bruto ? JSON.parse(bruto) : {}; } catch { data = {}; }

  if (!res.ok) {
    console.error(`[uazapi] ${path} respondeu ${res.status}:`, bruto.slice(0, 800) || "(corpo vazio)");
    if (res.status === 401) throw new Error("Token da Uazapi inválido ou ausente — confira UAZAPI_TOKEN.");
    // A Uazapi devolve mensagem em português quando o próprio WhatsApp recusa.
    const explicacao = data.message_ptbr || data.message || data.error;
    if (explicacao) throw new Error(explicacao);
    // Sem mensagem no corpo, vai o que veio — nem que seja "(sem resposta)".
    // Um trecho do corpo cru diz mais do que o número do erro sozinho.
    const trecho = bruto.replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`Uazapi respondeu ${res.status} em ${path}${trecho ? `: ${trecho}` : " sem dizer o motivo (resposta vazia)"}`);
  }
  // O id que o WhatsApp deu à mensagem. É com ele que o webhook de volta é
  // reconhecido como eco do próprio CRM — sem isso, toda mensagem enviada
  // apareceria duas vezes na conversa.
  return { ok: true, data, bruto, messageid: idDaMensagem(data) };
}

/* Registro da última tentativa de citação, para o diagnóstico.

   A citação falha CALADA: a Uazapi responde 200 e simplesmente ignora o campo
   que ela não conhece. Sem guardar o que foi enviado e o que voltou, não há
   como descobrir qual é o nome certo do campo nem qual formato de id ela
   espera — e foi exatamente aí que a primeira tentativa parou.

   Guarda só dado técnico: nomes de campo, o id da mensagem e a resposta da
   API. Nada do conteúdo da conversa. */
let ultimaCitacao = null;
export const citacaoDiagnostico = () => ultimaCitacao;

/* Onde vem o id na resposta muda conforme a versão e o tipo de mensagem, e
   nenhum dos caminhos é garantido — por isso a lista, e por isso o resto do
   sistema trata o id como opcional. */
function idDaMensagem(d) {
  const m = (d && (d.message || d.data)) || d || {};
  return d?.messageid || d?.id || m.messageid || m.id || m.key?.id || d?.key?.id || null;
}

// Assina a mensagem com o nome do corretor: todos usam o mesmo número,
// então o lead precisa saber com quem está falando.
const assinar = (text, signedBy) => (signedBy ? `*${signedBy}:*\n${text}` : text);

/* Texto, com citação opcional.

   `replyTo` é o id da mensagem citada NO WHATSAPP. Quando ele vai junto, o
   cliente vê a citação de verdade no aplicativo dele, igual ao Responder do
   WhatsApp.

   Se a conta não aceitar o campo, não travamos o envio: a mensagem sai com o
   trecho citado escrito em cima. Fica mais feio, mas o cliente continua
   sabendo do que se está falando — e o corretor não perde a mensagem por
   causa de um recurso que a API não tem. */
export async function sendText({ toPhone, text, signedBy, replyTo, quotedText }) {
  const assinado = assinar(text, signedBy);
  if (!replyTo) return call("/send/text", { number: toPhone, text: assinado });

  /* Vários nomes para o mesmo campo, na mesma requisição.

     Cada provedor batiza a citação de um jeito, e esta conta aceitou o envio
     com `replyid` sem reclamar — mas sem citar nada, o que prova que ela
     ignora campo que não conhece em vez de recusar. Como ignora, mandar os
     apelidos conhecidos juntos não quebra nada: o que ela entender, ela usa.

     Não é elegante, e o certo é ler a documentação da conta. É o melhor que
     dá para fazer sem ela, e o diagnóstico abaixo mostra o que voltou. */
  const apelidos = {
    replyid: replyTo,
    quotedMessageId: replyTo,
    quotedMsgId: replyTo,
    replyMessageId: replyTo,
    reply_to: replyTo,
  };

  try {
    const r = await call("/send/text", { number: toPhone, text: assinado, ...apelidos });
    ultimaCitacao = {
      quando: new Date().toISOString(),
      id_citado: replyTo,
      campos_enviados: Object.keys(apelidos),
      status: "aceito (200)",
      resposta: String(r.bruto || "").slice(0, 500),
      atencao: "Se a citação não apareceu no WhatsApp, a Uazapi aceitou e ignorou os campos — o nome certo está na documentação da conta.",
    };
    return r;
  } catch (e) {
    console.warn(`[uazapi] citação recusada (${e.message}); reenviando com o trecho escrito.`);
    ultimaCitacao = {
      quando: new Date().toISOString(),
      id_citado: replyTo,
      campos_enviados: Object.keys(apelidos),
      status: "recusado",
      resposta: e.message.slice(0, 500),
      atencao: "A mensagem foi reenviada com o trecho citado escrito no texto.",
    };
    const trecho = String(quotedText || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const citacao = trecho ? `> ${trecho}\n\n` : "";
    return call("/send/text", { number: toPhone, text: citacao + assinado });
  }
}

// type: image | video | audio | ptt | document. `file` aceita URL pública ou base64.
/* Manda mídia. `file` é uma URL pública OU o arquivo em base64.

   A URL é o caminho normal e o mais barato: a Uazapi baixa o arquivo sozinha.
   Só que isso põe o envio na dependência de a URL estar alcançável DE FORA —
   e ela deixa de estar por motivos que nada têm a ver com o WhatsApp: domínio
   fora do ar, APP_URL apontando para o endereço errado, bucket do R2 sem
   acesso público. Foi o que aconteceu em 06/08/2026: texto saindo normal e
   toda foto e vídeo falhando com "Falha ao enviar pelo WhatsApp".

   Por isso o `bytes`: se a URL falhar, o arquivo vai embutido na requisição.
   Fica mais pesado, mas não depende de ninguém conseguir abrir um endereço.
   `bytes` pode ser o Buffer ou uma função que devolve o Buffer — assim o
   arquivo só é lido do disco/R2 se a primeira tentativa falhar. */
export async function sendMedia({ toPhone, type, file, caption, signedBy, docName, bytes, mime }) {
  const corpo = (arquivo) => ({
    number: toPhone, type, file: arquivo,
    ...(caption ? { text: assinar(caption, signedBy) } : {}),
    ...(docName ? { docName } : {}),
  });

  try {
    return await call("/send/media", corpo(file));
  } catch (e) {
    if (!bytes) throw e;
    let buffer;
    try { buffer = typeof bytes === "function" ? await bytes() : bytes; }
    catch (lendo) { throw new Error(`${e.message} (e não consegui reler o arquivo: ${lendo.message})`); }
    if (!buffer || !buffer.length) throw e;

    console.warn(`[uazapi] a URL falhou (${e.message}); reenviando o arquivo embutido.`);
    try {
      return await call("/send/media", corpo(`data:${mime || "application/octet-stream"};base64,${buffer.toString("base64")}`));
    } catch (e2) {
      throw new Error(`${e.message} — e o envio direto do arquivo também falhou: ${e2.message}`);
    }
  }
}

export function sendLocation({ toPhone, latitude, longitude, name, address }) {
  return call("/send/location", { number: toPhone, latitude, longitude, name, address });
}

// Estado da instância — usado pelo diagnóstico, para conferir a conexão sem expor o token.
// Reporta HOST e TOKEN separadamente: "não configurado" sozinho não diz qual faltou.
export async function instanceStatus() {
  if (!uazapiConfigured()) {
    return {
      configurado: false,
      UAZAPI_HOST: HOST ? `definido (${HOST})` : "FALTANDO",
      UAZAPI_TOKEN: TOKEN ? `definido (${TOKEN.length} caracteres)` : "FALTANDO",
      dica: !HOST && !TOKEN
        ? "Nenhuma das duas chegou. No Railway, salvar as variáveis não basta — é preciso clicar em Deploy para aplicar."
        : "Falta a que está marcada como FALTANDO. Confira também se o nome está escrito exatamente assim, em maiúsculas.",
    };
  }
  try {
    const res = await fetch(`${HOST}/instance/status`, { headers: { token: TOKEN } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configurado: true, ok: false, erro: data.message || `HTTP ${res.status}` };
    const inst = data.instance || data;
    return {
      configurado: true, ok: true,
      status: inst.status || data.status || "desconhecido",
      numero: mascarar(inst.owner || inst.number || ""),
      nome: inst.profileName || inst.name || "",
    };
  } catch (e) {
    return { configurado: true, ok: false, erro: e.message };
  }
}

// Mostra só o suficiente para conferir que é o número certo: 5587****6848
const mascarar = (n) => {
  const d = String(n).replace(/\D/g, "");
  return d.length < 8 ? d : d.slice(0, 4) + "*".repeat(d.length - 8) + d.slice(-4);
};
