// Integração com a Uazapi (WhatsApp não-oficial) — número ÚNICO da Conecta.
// Ajuste os endpoints conforme a documentação da sua instância Uazapi.

const HOST = process.env.UAZAPI_HOST || "";
const TOKEN = process.env.UAZAPI_TOKEN || "";

// Envia uma mensagem de texto para o lead, ASSINADA com o nome do corretor.
// Todos usam o mesmo número; a assinatura garante que o lead saiba quem fala.
export async function sendText({ toPhone, text, signedBy }) {
  if (!HOST || !TOKEN) {
    console.warn("[uazapi] HOST/TOKEN não configurados — mensagem não enviada de verdade:", { toPhone, signedBy });
    return { ok: false, simulated: true };
  }
  const body = signedBy ? `*${signedBy}:*\n${text}` : text;

  // Endpoint típico da Uazapi. Confira o caminho exato na sua conta.
  const res = await fetch(`${HOST}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: TOKEN },
    body: JSON.stringify({ number: toPhone, text: body }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Uazapi falhou (${res.status}): ${msg}`);
  }
  return { ok: true, data: await res.json().catch(() => ({})) };
}
