/* OS PLANOS DO CORRETOR AUTÔNOMO.

   Só do autônomo. A imobiliária tem preço combinado caso a caso — equipe,
   volume de lead, o que foi negociado — e continua vindo de `orgs.valor_mensal`,
   gravado pelo ConHub. O autônomo é o oposto: é venda de prateleira, o preço é
   público e a conta se ativa sozinha. Misturar os dois numa tabela só faria a
   imobiliária ver três preços que não são os dela.

   A tabela mora AQUI, no servidor, e não numa tela de configuração. O preço é
   o que o cliente paga: campo editável em algum lugar é preço que muda por
   engano, e a rota de ativar já recusa valor vindo do cliente desde 27/08/2026
   justamente para isso. Mudar de preço é mexer neste arquivo e publicar — o que
   é raro, deliberado e fica no histórico do git.

   POR QUE CADA PLANO TEM UMA FORMA DIFERENTE DE COBRAR

   Mensal e semestral são ASSINATURA (`/subscriptions`): o Asaas cobra sozinho
   quando o ciclo vira, e o CRM só recebe o aviso de pago. É o que "renova
   sozinho" quer dizer.

   O anual é PARCELADO (`/payments` com 12 parcelas), e não assinatura, porque
   o que o Ali vendeu foi "R$ 197 por mês, 12x no cartão". Assinatura anual no
   Asaas cobra os R$ 2.364 de uma vez, uma vez por ano — que é outro produto.
   A diferença aparece na tela: o anual não se renova sozinho, ele termina e o
   corretor renova num clique. Vale a pena porque 12x no cartão é o que faz o
   plano caber no bolso de quem trabalha sozinho.

   QUANTOS MESES CADA PAGAMENTO COMPRA

   O vencimento anda por MÊS, e cada plano paga um número diferente deles por
   cobrança: o mensal um, o semestral seis de uma vez, o anual um por parcela.
   Em vez de guardar essa regra em três lugares, ela sai de uma divisão só —
   `meses = valor pago ÷ preço mensal do plano` — que acerta os três casos e
   também o anual pago à vista (2364 ÷ 197 = 12). Ver `mesesPagos`. */

export const PLANOS = [
  {
    id: "mensal",
    nome: "Mensal",
    mensal: 297,
    meses: 1,
    total: 297,
    forma: "assinatura",
    ciclo: "MONTHLY",
    resumo: "Renova sozinho todo mês. Cancele quando quiser.",
  },
  {
    id: "semestral",
    nome: "Semestral",
    mensal: 247,
    meses: 6,
    total: 247 * 6,
    forma: "assinatura",
    ciclo: "SEMIANNUALLY",
    resumo: "Uma cobrança a cada 6 meses. Renova sozinho.",
  },
  {
    id: "anual",
    nome: "Anual",
    mensal: 197,
    meses: 12,
    total: 197 * 12,
    forma: "parcelado",
    parcelas: 12,
    // A linha do valor já diz "12x de R$ 197 no cartão"; repetir aqui gastava
    // a única linha que tinha para explicar o que o plano faz.
    resumo: "Um ano de acesso. No fim dele você renova.",
  },
];

const MENSAL_CHEIO = PLANOS[0].mensal;

/* O que a tela mostra. A economia sai daqui e não do frontend: número que a
   tela calcula sozinha é número que passa a divergir do preço no dia em que
   um dos dois mudar. */
export const planosParaTela = () => PLANOS.map(p => ({
  ...p,
  economia_ano: Math.round((MENSAL_CHEIO - p.mensal) * 12),
  parcela: p.forma === "parcelado" ? p.mensal : null,
}));

export const planoPorId = (id) => PLANOS.find(p => p.id === id) || null;

/* Quantos meses de acesso um pagamento comprou.

   Sem plano (toda imobiliária, e os autônomos anteriores a esta tela) o valor
   pago não diz nada sobre meses, e a regra antiga continua valendo: um
   pagamento, um mês. Trocar isso por uma divisão adivinhada faria pagamento
   parcial ou cortesia de R$ 1 virar zero mês — o cliente pagaria e continuaria
   bloqueado. */
export function mesesPagos(planoId, valor) {
  const p = planoPorId(planoId);
  if (!p || !valor || !isFinite(valor)) return 1;
  const meses = Math.round(Number(valor) / p.mensal);
  // Nunca zero: pagamento a menor ainda é pagamento, e crédito nenhum
  // deixaria o cliente bloqueado logo depois de pagar.
  return Math.min(Math.max(meses, 1), p.meses);
}
