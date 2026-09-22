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

/* Assinatura recorrente. `billingType: CREDIT_CARD` — era `UNDEFINED`, que
   deixava a pessoa escolher entre Pix, boleto e cartão na hora de pagar.

   Mudou em 22/09/2026, pedido do Ali: o teste de 14 dias passou a exigir
   cartão cadastrado (a assinatura nasce com o primeiro vencimento no fim do
   teste — `vencimento` já vem assim de quem chama — e é o cartão anexado
   agora, na fatura, que garante a cobrança automática lá na frente; Pix e
   boleto não ficam "guardados" para cobrar sozinhos depois). Fixar o tipo
   também troca a cara da fatura hospedada: só aparece o formulário de
   cartão, sem abas de Pix/boleto para escolher — a Asaas escolhe pela gente
   o único caminho que serve para o que esta cobrança precisa fazer depois.

   O ciclo é do PLANO (services/planos.js): MONTHLY no mensal, SEMIANNUALLY no
   semestral. Era fixo em MONTHLY, o que estava certo quando só existia um
   plano. */
export const criarAssinatura = ({ clienteId, valor, vencimento, descricao, ciclo = "MONTHLY" }) =>
  chamar("/subscriptions", { metodo: "POST", corpo: {
    customer: clienteId, billingType: "CREDIT_CARD", value: valor,
    nextDueDate: vencimento, cycle: ciclo, description: descricao,
  }});

/* Cobrança PARCELADA — é o plano anual, 12x de R$ 197 no cartão.

   Não é assinatura de propósito: assinatura anual no Asaas cobra o valor
   cheio de uma vez, uma vez por ano, e o que foi vendido ao corretor foi a
   parcela. Aqui o Asaas gera as 12 cobranças e manda um aviso de pago por
   parcela — cada uma comprando um mês de acesso, o que fecha os doze.

   `billingType: CREDIT_CARD` — o parcelado sempre foi "12x no cartão" na
   tela (nunca existiu parcelado por Pix ou boleto aqui), então fixar o tipo
   só deixa a fatura hospedada coerente com o que já era vendido. */
export const criarParcelado = ({ clienteId, parcelas, valorParcela, vencimento, descricao }) =>
  chamar("/payments", { metodo: "POST", corpo: {
    customer: clienteId, billingType: "CREDIT_CARD",
    installmentCount: parcelas, installmentValue: valorParcela,
    dueDate: vencimento, description: descricao,
  }});

export const cobrancasDaAssinatura = (assinaturaId) =>
  chamar(`/subscriptions/${assinaturaId}/payments`);

/* O CARTÃO FOI ANEXADO? (22/09/2026)

   A assinatura nasce SEM cartão nenhum — ele só existe depois que a pessoa
   abre a fatura hospedada pela Asaas e preenche os dados LÁ, fora do nosso
   servidor (é a mesma razão de `linkDaPrimeiraFatura` existir: número de
   cartão nunca trafega por aqui). Com o vencimento no futuro (fim do teste),
   a cobrança fica pendente até a data chegar — o que muda quando o cartão é
   anexado é a cobrança já trazer o objeto `creditCard` (bandeira, final do
   número), mesmo sem ter sido debitada ainda.

   Não achei como confirmar isto contra a documentação (o ambiente onde este
   código roda não alcança docs.asaas.com) — é a leitura mais direta da API,
   mas vale um teste de verdade no sandbox da Asaas antes de confiar cego
   nisso em produção: criar uma assinatura com vencimento futuro, abrir a
   fatura, preencher um cartão de teste, e conferir aqui o que
   `cobrancasDaAssinatura` devolve para aquela cobrança.

   Por isso NUNCA é o único caminho: o webhook tenta isto a cada evento da
   assinatura (routes/assinatura.routes.js), o dono pode clicar em "Verificar
   de novo" a qualquer momento (roda a mesma checagem), e o master sempre tem
   o "já paguei — liberar acesso" como saída manual se os dois falharem. */
export async function cartaoRegistrado(assinaturaId) {
  const d = await cobrancasDaAssinatura(assinaturaId);
  const primeira = ((d && d.data) || [])[0];
  if (!primeira) return false;
  return !!(primeira.creditCard || primeira.creditCardToken || primeira.creditCardNumber);
}

/* Cancela a assinatura anterior quando o corretor troca de plano.

   Sem isto, quem sai do mensal para o anual fica com as DUAS cobranças
   correndo no Asaas e descobre no extrato do mês seguinte. O cancelamento
   nunca derruba a troca: se ele falhar, o plano novo já foi contratado, e
   travar aqui deixaria o cliente sem plano nenhum por causa da limpeza do
   plano velho. Quem chama trata o erro e apenas registra. */
export const cancelarAssinatura = (assinaturaId) =>
  chamar(`/subscriptions/${assinaturaId}`, { metodo: "DELETE" });

/* O ENDEREÇO DA TELA DE PAGAMENTO — a fatura hospedada pelo Asaas.

   É para onde o corretor é mandado depois de escolher o plano, e é lá, no
   domínio do Asaas, que ele digita os dados do cartão. Fazer essa tela aqui
   dentro significaria número de cartão trafegando pelo nosso servidor e
   entrando no escopo de PCI-DSS — responsabilidade que este CRM não tem
   motivo nenhum para assumir para ganhar uma tela.

   A assinatura não devolve a fatura na resposta da criação: ela cria a
   primeira cobrança logo depois, e é essa cobrança que tem endereço. Por isso
   a segunda chamada. O parcelado já devolve a dele direto. */
export async function linkDaPrimeiraFatura(assinaturaId) {
  const d = await cobrancasDaAssinatura(assinaturaId);
  const lista = (d && d.data) || [];
  const primeira = lista[0] || {};
  return primeira.invoiceUrl || primeira.bankSlipUrl || null;
}

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

  /* `...base` entra aqui também (22/09/2026) — antes este caminho devolvia só
     `{acao,evento}`, sem o `assinatura`. Não fazia diferença enquanto
     "ignorar" só servia para não processar pagamento — mas agora o cartão
     obrigatório (`tentarConfirmarCartao`, assinatura.routes.js) precisa
     achar a org por QUALQUER evento da assinatura, inclusive os que este
     sistema sempre ignorou (SUBSCRIPTION_UPDATED e afins, que é onde
     provavelmente mora o sinal de "cartão anexado sem cobrar ainda"). Sem
     o id aqui, a busca cairia sempre no consolo de "imobiliária única" e
     erraria a conta certa em qualquer conta com mais de um cliente. */
  return { ...base, acao: "ignorar", evento };
}
