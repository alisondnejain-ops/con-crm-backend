/* PAGAR.ME (STONE) — O SEGUNDO PROVEDOR DE COBRANÇA (04/10/2026, pedido do Ali:
   "padronizar a estrutura de pagamento… checkout com a minha marca… one click
   pay para upgrade e contratação").

   POR QUE ELE: é o que cobre o cliente brasileiro inteiro num provedor só —
   cartão com tokenização (o cartão é digitado DENTRO do ConHub e vai direto
   do navegador para o Pagar.me, sem passar pelo nosso servidor), assinatura
   recorrente, parcelado em 12x e Pix/boleto. O cartão fica guardado no
   cliente do Pagar.me e serve para cobrar de novo sem a pessoa digitar nada:
   é o "um clique" das ferramentas e do upgrade.

   CONVIVE COM O ASAAS, conta por conta (`provedorDe` em
   routes/assinatura.routes.js). Quem já paga no Asaas continua lá até alguém
   trocar a conta de propósito — trocar de provedor no meio de uma assinatura
   é cobrança dupla ou mês sem cobrança, e nenhum dos dois pode acontecer
   porque uma versão subiu.

   A CHAVE SECRETA NUNCA SAI DO SERVIDOR. A pública (`PAGARME_PUBLIC_KEY`) é
   feita para o navegador: com ela só se cria token de cartão, nada mais.

   O QUE NÃO FOI CONFERIDO CONTRA O PAGAR.ME DE VERDADE: este ambiente não
   alcança api.pagar.me. Os caminhos e campos seguem a API core v5 documentada
   (customers, cards, subscriptions, orders, charges, invoices); os testes
   usam um Pagar.me de mentira com o mesmo formato. A primeira cobrança no
   ambiente de testes (chave `sk_test_`) é o teste de verdade — e os erros do
   Pagar.me chegam à tela escritos, nunca engolidos. */

const limpar = (v) => String(v ?? "").trim().replace(/^["'<]+|["'>]+$/g, "").trim();
const CHAVE = () => limpar(process.env.PAGARME_SECRET_KEY);
export const CHAVE_PUBLICA = () => limpar(process.env.PAGARME_PUBLIC_KEY);
const BASE = () => (limpar(process.env.PAGARME_API_URL) || "https://api.pagar.me/core/v5").replace(/\/$/, "");

export const pagarmeConfigurado = () => !!CHAVE() && !!CHAVE_PUBLICA();
export const ambientePagarme = () => (/^sk_test_/.test(CHAVE()) ? "teste" : "produção");

/* Chave secreta e pública do MESMO ambiente. Misturar (sk_test com pk de
   produção) faz o token do cartão nascer num ambiente e a cobrança procurar
   no outro — o erro do Pagar.me nessa hora é "token não encontrado", que não
   diz onde procurar. Avisa no start. */
export function ambientePagarmeConfere() {
  const s = CHAVE(), p = CHAVE_PUBLICA();
  if (!s && !p) return null;
  if (!s || !p) return "Falta uma das chaves do Pagar.me: PAGARME_SECRET_KEY e PAGARME_PUBLIC_KEY vão juntas.";
  if (!/^sk_/.test(s)) return "PAGARME_SECRET_KEY deveria começar com sk_ — confira se não foi colada a chave pública no lugar.";
  if (!/^pk_/.test(p)) return "PAGARME_PUBLIC_KEY deveria começar com pk_ — confira se não foi colada a chave secreta no lugar.";
  if (/^sk_test_/.test(s) !== /^pk_test_/.test(p))
    return "As chaves do Pagar.me são de ambientes diferentes (uma de teste e outra de produção). Use as duas do mesmo ambiente.";
  return null;
}

/* O Pagar.me devolve `{message, errors: {campo: ["frase"]}}`. A frase vai
   para a tela como veio — "card number is invalid" é feio, mas é a pista
   certa, e esconder some com ela. */
function mensagemDoErro(dados, status) {
  const lista = dados && dados.errors && typeof dados.errors === "object"
    ? Object.entries(dados.errors).flatMap(([c, v]) => (Array.isArray(v) ? v : [v]).map(m => `${c}: ${m}`)) : [];
  const base = (dados && dados.message) || `HTTP ${status}`;
  return lista.length ? `${base} (${lista.slice(0, 3).join("; ")})` : base;
}

async function chamar(caminho, { metodo = "GET", corpo } = {}) {
  if (!CHAVE()) throw new Error("Pagar.me não configurado (PAGARME_SECRET_KEY).");
  let res;
  try {
    res = await fetch(`${BASE()}${caminho}`, {
      method: metodo,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(CHAVE() + ":").toString("base64"),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error("Não consegui falar com o Pagar.me: " + (e.name === "TimeoutError" ? "não respondeu em 20s" : e.message));
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error("Chave do Pagar.me recusada — confira PAGARME_SECRET_KEY (teste e produção têm chaves diferentes).");
    throw new Error("Pagar.me: " + mensagemDoErro(dados, res.status));
  }
  return dados;
}

/* Reais → centavos, sem o erro de vírgula flutuante (19,7 × 100 = 1969,999…). */
export const centavos = (reais) => Math.round(Number(reais) * 100);

/* ===== CLIENTE E CARTÃO ===== */

/* Telefone no formato que o Pagar.me pede (país, DDD, número). Só o
   brasileiro com DDD vira telefone; o resto vai sem — o cliente nasce do
   mesmo jeito, e um telefone mal formado recusaria a criação inteira. */
function telefoneDoCliente(bruto) {
  let d = String(bruto || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return undefined;
  return { mobile_phone: { country_code: "55", area_code: d.slice(0, 2), number: d.slice(2) } };
}

export async function criarCliente({ nome, email, documento, telefone, orgId }) {
  const doc = String(documento || "").replace(/\D/g, "");
  const empresa = doc.length === 14;
  const fone = telefoneDoCliente(telefone);
  return chamar("/customers", { metodo: "POST", corpo: {
    name: nome, email, document: doc,
    document_type: empresa ? "CNPJ" : "CPF",
    type: empresa ? "company" : "individual",
    ...(fone ? { phones: fone } : {}),
    metadata: { org_id: orgId || "" },
  } });
}

/* O cartão entra pelo TOKEN que o navegador gerou com a chave pública. O
   número nunca chega aqui; o Pagar.me devolve só bandeira e final, que é o
   que a tela mostra ("Visa final 4242"). */
export const salvarCartao = (clienteId, token) =>
  chamar(`/customers/${clienteId}/cards`, { metodo: "POST", corpo: { token } });

export const apagarCartao = (clienteId, cartaoId) =>
  chamar(`/customers/${clienteId}/cards/${cartaoId}`, { metodo: "DELETE" });

export const resumoDoCartao = (c) => c ? {
  bandeira: c.brand || null,
  final: c.last_four_digits || (c.last_digits ? String(c.last_digits).slice(-4) : null),
  validade: c.exp_month && c.exp_year ? `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}` : null,
} : null;

/* ===== ASSINATURA (mensal, semestral e ferramenta avulsa) =====

   `inicio` (opcional, data AAAA-MM-DD): a primeira cobrança só acontece
   nessa data — é o fim do teste de 14 dias. Sem ela, cobra hoje. */
export function criarAssinatura({ clienteId, cartaoId, valor, meses = 1, descricao, codigo, inicio, metadata = {} }) {
  return chamar("/subscriptions", { metodo: "POST", corpo: {
    customer_id: clienteId,
    card_id: cartaoId,
    payment_method: "credit_card",
    interval: "month",
    interval_count: meses,
    // Pré-pago: cobra no começo de cada ciclo. Com `start_at`, o primeiro
    // ciclo (e a primeira cobrança) começa nessa data.
    billing_type: "prepaid",
    ...(inicio ? { start_at: inicio } : {}),
    installments: 1,
    currency: "BRL",
    statement_descriptor: "CONHUB",
    items: [{ description: descricao, quantity: 1, pricing_scheme: { scheme_type: "unit", price: centavos(valor) } }],
    metadata: { ...metadata, codigo: codigo || "" },
  } });
}

export const cancelarAssinatura = (assinaturaId) =>
  chamar(`/subscriptions/${assinaturaId}`, { metodo: "DELETE", corpo: { cancel_pending_invoices: true } });

export const lerAssinatura = (assinaturaId) => chamar(`/subscriptions/${assinaturaId}`);

/* Trocar o cartão de uma assinatura que já existe. Sem isto, trocar o cartão
   na tela mudaria só o "um clique" das próximas compras, e a mensalidade
   continuaria sendo cobrada no cartão velho — o vencido, quase sempre, que é
   o motivo de alguém trocar. */
export const trocarCartaoDaAssinatura = (assinaturaId, cartaoId) =>
  chamar(`/subscriptions/${assinaturaId}/card`, { metodo: "PATCH", corpo: { card_id: cartaoId } });

/* ===== PEDIDO À VISTA OU PARCELADO (o anual em 12x) =====

   Uma cobrança só, no valor CHEIO, parcelada no cartão do cliente — a
   imobiliária/ConHub recebe conforme o contrato de antecipação com a Stone,
   e o CRM credita os doze meses de uma vez quando o pedido é pago. */
export function criarPedido({ clienteId, cartaoId, valor, parcelas = 1, descricao, codigo, metadata = {} }) {
  return chamar("/orders", { metodo: "POST", corpo: {
    customer_id: clienteId,
    items: [{ amount: centavos(valor), description: descricao, quantity: 1, code: codigo || "conhub" }],
    payments: [{
      payment_method: "credit_card",
      credit_card: { installments: parcelas, card_id: cartaoId, statement_descriptor: "CONHUB", operation_type: "auth_and_capture" },
    }],
    metadata,
  } });
}

/* ===== LEITURA (é ela que o webhook usa para conferir) ===== */
export const lerCobranca = (id) => chamar(`/charges/${id}`);
export const lerFatura = (id) => chamar(`/invoices/${id}`);
export const lerPedido = (id) => chamar(`/orders/${id}`);
export const faturasDaAssinatura = (id) => chamar(`/invoices?subscription_id=${encodeURIComponent(id)}&size=10`);

/* A assinatura a que uma cobrança pertence. O Pagar.me não manda isso sempre
   no mesmo lugar (`invoice.subscription_id`, `invoice.subscription.id`,
   `subscription_id`), então procura nos três. */
export function assinaturaDaCobranca(c) {
  if (!c) return null;
  const inv = c.invoice || {};
  return inv.subscription_id || (inv.subscription && inv.subscription.id) || c.subscription_id
    || (c.metadata && c.metadata.subscription_id) || null;
}
export const pedidoDaCobranca = (c) => (c && (c.order_id || (c.order && c.order.id))) || null;
export const clienteDaCobranca = (c) => (c && (c.customer_id || (c.customer && c.customer.id))) || null;

/* Status que valem dinheiro entrando. `paid` é o de cobrança; o pedido usa
   o mesmo nome. */
export const PAGA = new Set(["paid"]);
export const ESTORNADA = new Set(["refunded", "chargedback"]);
