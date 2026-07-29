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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error("Token da Uazapi inválido ou ausente — confira UAZAPI_TOKEN.");
    // A Uazapi devolve mensagem em português quando o próprio WhatsApp recusa.
    throw new Error(data.message_ptbr || data.message || `Uazapi respondeu ${res.status}.`);
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
export function sendMedia({ toPhone, type, file, caption, signedBy, docName }) {
  return call("/send/media", {
    number: toPhone, type, file,
    ...(caption ? { text: assinar(caption, signedBy) } : {}),
    ...(docName ? { docName } : {}),
  });
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
