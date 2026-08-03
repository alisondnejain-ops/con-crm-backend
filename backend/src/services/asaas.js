/* Integração com o Asaas (cobrança recorrente).

   Escolhido por cobrir Pix, boleto e cartão numa assinatura só, com webhook
   simples — é o encaixe usual de SaaS pequeno no Brasil.

   Sem ASAAS_API_KEY nada aqui é chamado, e a assinatura funciona no modo
   manual: o gestor marca "pago" na tela e o vencimento anda um mês. Mesmo
   padrão do e-mail, do push e da leitura de print — o sistema nunca depende de
   um serviço externo estar contratado para continuar de pé.

   ATENÇÃO ao ambiente: a chave de sandbox só funciona na URL de sandbox, e a
   de produção só na de produção. Trocar uma e esquecer a outra dá 401, que é o
   erro mais comum de quem está ligando isso pela primeira vez. */

/* Mesma limpeza do storage.js: aspas, espaço e os sinais < > que sobram quando
   a chave é colada no painel da hospedagem. Uma chave com `<` na frente dá 401,
   e o 401 do Asaas não distingue "chave errada" de "chave suja". */
const limpar = (v) => String(v ?? "").trim().replace(/^["'<]+|["'>]+$/g, "").trim();

const CHAVE = limpar(process.env.ASAAS_API_KEY);
// Só a primeira palavra: já veio "true    ← comece em teste" colado do passo a passo.
const SANDBOX = /^true\b/i.test(limpar(process.env.ASAAS_SANDBOX));
const BASE = (limpar(process.env.ASAAS_API_URL) || (SANDBOX ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3")).replace(/\/$/, "");
// Token que o Asaas devolve no cabeçalho de cada webhook. É o que impede
// qualquer um de chamar nossa rota dizendo "fulano pagou".
export const TOKEN_WEBHOOK = limpar(process.env.ASAAS_WEBHOOK_TOKEN);

/* Erro clássico: chave de produção ($aact_prod_) com ASAAS_SANDBOX=true, ou o
   contrário. Dá 401 sem explicação. Avisa no log do start, uma vez. */
export function ambienteConfere() {
  if (!CHAVE) return null;
  // Só os dois casos que dá para afirmar: o prefixo diz o ambiente. Chave em
  // formato antigo não traz essa marca — nesses casos não inventamos aviso.
  if (/aact_prod/i.test(CHAVE) && SANDBOX)
    return "A chave do Asaas é de PRODUÇÃO mas ASAAS_SANDBOX está true. Coloque ASAAS_SANDBOX=false.";
  if (/aact_hmlg/i.test(CHAVE) && !SANDBOX)
    return "A chave do Asaas é de TESTE (sandbox) mas ASAAS_SANDBOX está false. Coloque ASAAS_SANDBOX=true.";
  return null;
}

export const asaasConfigurado = () => !!CHAVE;
export const ambienteAsaas = () => (SANDBOX ? "sandbox (teste)" : "produção");

async function chamar(caminho, { metodo = "GET", corpo } = {}) {
  if (!CHAVE) throw new Error("Asaas não configurado (ASAAS_API_KEY).");
  let res;
  try {
    res = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers: { "Content-Type": "application/json", access_token: CHAVE },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch (e) {
    throw new Error("Não consegui falar com o Asaas: " + e.message);
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    // O Asaas devolve os problemas numa lista `errors`, com descrição em português.
    const msg = (dados.errors && dados.errors[0] && dados.errors[0].description)
      || dados.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("Chave do Asaas inválida — confira também se ela é do mesmo ambiente da URL (" + ambienteAsaas() + ").");
    throw new Error("Asaas: " + msg);
  }
  return dados;
}

export const criarCliente = ({ nome, cpfCnpj, email, telefone }) =>
  chamar("/customers", { metodo: "POST", corpo: { name: nome, cpfCnpj, email, mobilePhone: telefone } });

/* Assinatura mensal. `billingType: UNDEFINED` deixa o cliente escolher entre
   Pix, boleto e cartão na hora de pagar — menos atrito que fixar um só. */
export const criarAssinatura = ({ clienteId, valor, vencimento, descricao }) =>
  chamar("/subscriptions", { metodo: "POST", corpo: {
    customer: clienteId, billingType: "UNDEFINED", value: valor,
    nextDueDate: vencimento, cycle: "MONTHLY", description: descricao,
  }});

export const cobrancasDaAssinatura = (assinaturaId) =>
  chamar(`/subscriptions/${assinaturaId}/payments`);

/* Traduz o evento do Asaas para o que o nosso sistema entende.
   Só três coisas importam: entrou dinheiro, atrasou, ou acabou. O resto
   (cobrança criada, atualizada, visualizada) não muda o acesso de ninguém. */
export function interpretarEvento(corpo) {
  const evento = corpo && corpo.event;
  const cobranca = (corpo && (corpo.payment || corpo.subscription)) || {};
  const link = cobranca.invoiceUrl || cobranca.bankSlipUrl || null;
  /* O id da cobrança viaja junto porque o Asaas manda PAYMENT_CONFIRMED e
     PAYMENT_RECEIVED da MESMA fatura. Sem ele, os dois viravam dois pagamentos
     e o vencimento pulava dois meses de uma vez. */
  const base = {
    link, assinatura: cobranca.subscription || null,
    pagamento: cobranca.id || null,
    valor: cobranca.value != null ? Number(cobranca.value) : null,
  };

  if (["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED_IN_CASH"].includes(evento))
    return { ...base, acao: "pago", quando: Date.now() };

  if (["PAYMENT_OVERDUE"].includes(evento))
    return { ...base, acao: "atrasado" };

  if (["PAYMENT_DELETED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED", "SUBSCRIPTION_DELETED"].includes(evento))
    return { ...base, acao: "cancelado" };

  return { acao: "ignorar", evento };
}
