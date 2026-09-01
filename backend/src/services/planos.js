/* OS PLANOS DA PRATELEIRA — CORRETOR AUTÔNOMO E IMOBILIÁRIA.

   A tabela mora AQUI, no servidor, e não numa tela de configuração. O preço é
   o que o cliente paga: campo editável em algum lugar é preço que muda por
   engano, e a rota de ativar já recusa valor vindo do cliente desde 27/08/2026
   justamente por isso. Mudar de preço é mexer neste arquivo e publicar — o que
   é raro, deliberado e fica no histórico do git.

   ===== POR QUE A IMOBILIÁRIA ENTROU AQUI (02/09/2026) =====

   Até hoje este arquivo era só do autônomo, e o comentário dizia o porquê: o
   preço da imobiliária era negociado caso a caso e vinha de `orgs.valor_mensal`,
   gravado à mão pelo ConHub. Isso valia enquanto a venda era conversada.

   Deixou de valer no dia em que o site publicou Essencial e Plus com preço na
   vitrine e um botão "Testar 14 dias grátis" ao lado. A partir daí eles são
   venda de prateleira igual à do autônomo, e preço de prateleira precisa estar
   num lugar só — senão o site anuncia um valor e a cobrança faz outro, que é a
   forma mais cara possível de descobrir um erro: pelo extrato do cliente.

   `Rede` continua FORA desta tabela de propósito. Ela é "sob medida", o botão
   dela no site leva ao contato e não ao teste, e um preço de prateleira para
   ela seria uma oferta que não existe.

   ===== OS IDs SÃO PARA SEMPRE =====

   `mensal`, `semestral` e `anual` são os ids do autônomo desde o começo e estão
   gravados em `orgs.plano_id` de contas que já pagam. Eles NÃO podem ser
   renomeados para caber num esquema mais bonito: `mesesPagos` divide o valor
   pago pelo preço mensal do plano, e plano que não é encontrado vale 1 mês —
   o cliente que pagou seis meses seria bloqueado no mês seguinte, sem erro
   nenhum aparecer. Por isso os da imobiliária nasceram com nome composto
   (`essencial-anual`) em vez de reaproveitar `anual`.

   ===== POR QUE CADA CICLO TEM UMA FORMA DIFERENTE DE COBRAR =====

   Mensal e semestral são ASSINATURA (`/subscriptions`): o Asaas cobra sozinho
   quando o ciclo vira, e o CRM só recebe o aviso de pago. É o que "renova
   sozinho" quer dizer.

   O anual é PARCELADO (`/payments` com 12 parcelas), e não assinatura, porque
   o que foi vendido foi "R$ 147 por mês, 12x no cartão". Assinatura anual no
   Asaas cobra o ano inteiro de uma vez — que é outro produto. A diferença
   aparece na tela: o anual não se renova sozinho, ele termina e o cliente
   renova num clique.

   ===== QUANTOS MESES CADA PAGAMENTO COMPRA =====

   O vencimento anda por MÊS, e cada plano paga um número diferente deles por
   cobrança: o mensal um, o semestral seis de uma vez, o anual um por parcela.
   Em vez de guardar essa regra em três lugares, ela sai de uma divisão só —
   `meses = valor pago ÷ preço mensal do plano` — que acerta os três casos e
   também o anual pago à vista. Ver `mesesPagos`. */

/* Monta os três ciclos de uma família a partir do preço mensal de cada um.

   Existe para que acrescentar um plano seja escrever três números, e não
   copiar trinta linhas — foi copiando que o `total` de um plano ficou
   divergindo do `mensal` dele em outros sistemas. Aqui `total` é sempre
   calculado, nunca digitado. */
function ciclosDe({ familia, prefixo, nome, limite, mensal, semestral, anual }) {
  const id = (c) => (prefixo ? `${prefixo}-${c}` : c);
  return [
    {
      id: id("mensal"), familia, plano: nome, limite,
      nome: nome ? `${nome} mensal` : "Mensal",
      ciclo_nome: "Mensal",
      mensal, meses: 1, total: mensal,
      forma: "assinatura", ciclo: "MONTHLY",
      resumo: "Renova sozinho todo mês. Cancele quando quiser.",
    },
    {
      id: id("semestral"), familia, plano: nome, limite,
      nome: nome ? `${nome} semestral` : "Semestral",
      ciclo_nome: "Semestral",
      mensal: semestral, meses: 6, total: semestral * 6,
      forma: "assinatura", ciclo: "SEMIANNUALLY",
      resumo: "Uma cobrança a cada 6 meses. Renova sozinho.",
    },
    {
      id: id("anual"), familia, plano: nome, limite,
      nome: nome ? `${nome} anual` : "Anual",
      ciclo_nome: "Anual",
      mensal: anual, meses: 12, total: anual * 12,
      forma: "parcelado", parcelas: 12,
      // A linha do valor já diz "12x de R$ X no cartão"; repetir aqui gastava
      // a única linha que tinha para explicar o que o plano faz.
      resumo: "Um ano de acesso. No fim dele você renova.",
    },
  ];
}

/* CORRETOR AUTÔNOMO. Sem prefixo no id: são os ids históricos, já gravados em
   contas que pagam. Ver "OS IDs SÃO PARA SEMPRE", acima. */
export const PLANOS = ciclosDe({
  familia: "autonomo",
  prefixo: "",
  nome: "",
  limite: "1 pessoa",
  mensal: 197,
  semestral: 167,
  anual: 147,
});

/* IMOBILIÁRIA. Os mesmos valores publicados no site. */
export const PLANOS_IMOBILIARIA = [
  ...ciclosDe({
    familia: "imobiliaria", prefixo: "essencial", nome: "Essencial",
    limite: "até 10 corretores",
    mensal: 497, semestral: 427, anual: 377,
  }),
  ...ciclosDe({
    familia: "imobiliaria", prefixo: "plus", nome: "Plus",
    limite: "até 25 corretores",
    mensal: 797, semestral: 677, anual: 597,
  }),
];

const TODOS = [...PLANOS, ...PLANOS_IMOBILIARIA];

/* O preço mensal cheio de cada família, para calcular a economia. Sai daqui e
   não do frontend: número que a tela calcula sozinha é número que passa a
   divergir do preço no dia em que um dos dois mudar. */
const CHEIO = {
  autonomo: PLANOS[0].mensal,
  // Na imobiliária a comparação honesta é dentro do MESMO plano: quem olha o
  // Plus anual quer saber quanto economiza em relação ao Plus mensal, não em
  // relação ao Essencial. Por isso a conta usa o mensal do próprio plano.
  imobiliaria: null,
};

const cheioDe = (p) =>
  p.familia === "autonomo"
    ? CHEIO.autonomo
    : (PLANOS_IMOBILIARIA.find(x => x.plano === p.plano && x.meses === 1)?.mensal ?? p.mensal);

/* Os planos de uma família, prontos para a tela.

   `tipo` é o `orgs.tipo`: "autonomo" ou "imobiliaria". Qualquer outra coisa
   devolve lista vazia em vez de cair no autônomo por descuido — mostrar a
   prateleira errada é oferecer preço que não é o daquele cliente. */
export function planosDe(tipo) {
  if (tipo === "autonomo") return PLANOS;
  if (tipo === "imobiliaria") return PLANOS_IMOBILIARIA;
  return [];
}

export const planosParaTela = (tipo = "autonomo") =>
  planosDe(tipo).map(p => ({
    ...p,
    economia_ano: Math.round((cheioDe(p) - p.mensal) * 12),
    parcela: p.forma === "parcelado" ? p.mensal : null,
  }));

export const planoPorId = (id) => TODOS.find(p => p.id === id) || null;

/* O plano existe E é da família certa?

   As duas perguntas juntas de propósito: um `plano_id` chega de fora (do site,
   do corpo da requisição), e sem a segunda pergunta um autônomo poderia mandar
   `essencial-anual` e pagar o preço da imobiliária — ou o contrário, que é
   pior, porque é mais barato e ninguém reclama de ser cobrado a menos. */
export function planoDaFamilia(id, tipo) {
  const p = planoPorId(id);
  if (!p) return null;
  if (p.familia !== tipo) return null;
  return p;
}

/* Quantos meses de acesso um pagamento comprou.

   Sem plano (as contas anteriores a esta tela) o valor pago não diz nada sobre
   meses, e a regra antiga continua valendo: um pagamento, um mês. Trocar isso
   por uma divisão adivinhada faria pagamento parcial ou cortesia de R$ 1 virar
   zero mês — o cliente pagaria e continuaria bloqueado. */
export function mesesPagos(planoId, valor) {
  const p = planoPorId(planoId);
  if (!p || !valor || !isFinite(valor)) return 1;
  const meses = Math.round(Number(valor) / p.mensal);
  // Nunca zero: pagamento a menor ainda é pagamento, e crédito nenhum
  // deixaria o cliente bloqueado logo depois de pagar.
  return Math.min(Math.max(meses, 1), p.meses);
}
