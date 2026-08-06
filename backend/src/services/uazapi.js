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
  return { ok: true, data };
}

// Assina a mensagem com o nome do corretor: todos usam o mesmo número,
// então o lead precisa saber com quem está falando.
const assinar = (text, signedBy) => (signedBy ? `*${signedBy}:*\n${text}` : text);

export function sendText({ toPhone, text, signedBy }) {
  return call("/send/text", { number: toPhone, text: assinar(text, signedBy) });
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
