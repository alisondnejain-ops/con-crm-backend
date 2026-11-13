/* O SIMULADOR (CETRO 13, 13/11/2026). Duas contas, as duas feitas AQUI — a
   tela mostra o mesmo cálculo enquanto a pessoa digita, mas o que fica gravado
   na simulação do lead é o que este arquivo devolve.

   IMÓVEL PRONTO: financiado = preço − entrada − subsídio;
   i = (1 + juros_aa/100)^(1/12) − 1. SAC: parcela inicial = financiado/n +
   financiado×i. Price: financiado×i/(1−(1+i)^−n) (i = 0 → financiado/n).
   Comprometimento = parcela inicial ÷ renda. Sem renda: "não informado", nunca 0%.

   LANÇAMENTO/LOTEAMENTO: sinal, entrada adicional, mensais, reforços, chaves e
   saldo a financiar, cada um com % e (quando parcelado) quantidade. Os %
   fecham em 100%. "Durante a obra" e "Após a obra" também fecham em 100% — e
   são comparados com o que os componentes dão (sinal, entrada, mensais e
   reforços são da obra; chaves e saldo, depois). A diferença é MOSTRADA, nunca
   escondida nem corrigida sozinha. O resíduo de arredondamento das parcelas
   aparece escrito.

   Não é aprovação de crédito: não inclui seguros, tarifas nem correção. */

const arred = (v) => Math.round(v * 100) / 100;
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(String(v).replace(/\./g, "").replace(",", ".")));
const n = (v) => (typeof v === "number" ? v : num(v));

export function simularPronto(e) {
  const preco = n(e.preco), entrada = n(e.entrada) ?? 0, subsidio = n(e.subsidio) ?? 0;
  const prazo = n(e.prazo_meses), juros = n(e.juros_aa) ?? 0, renda = n(e.renda);
  const sistema = e.sistema === "price" ? "price" : "sac";
  if (!(preco > 0)) return { erro: "Informe o preço do imóvel." };
  if ([entrada, subsidio, juros].some(v => !isFinite(v) || v < 0)) return { erro: "Entrada, subsídio e juros não podem ser negativos." };
  if (entrada + subsidio > preco) return { erro: "Entrada mais subsídio passam do preço do imóvel." };
  if (!Number.isInteger(prazo) || prazo < 1 || prazo > 480) return { erro: "Informe o prazo em meses (1 a 480)." };
  if (juros > 50) return { erro: "Juros anuais acima de 50% — confira o número." };
  if (renda != null && (!isFinite(renda) || renda < 0)) return { erro: "Renda inválida." };
  const financiado = preco - entrada - subsidio;
  const i = Math.pow(1 + juros / 100, 1 / 12) - 1;
  let parcela, ultima = null, amortizacao = null, jurosIni = financiado * i;
  if (sistema === "sac") {
    amortizacao = financiado / prazo; parcela = amortizacao + jurosIni;
    ultima = amortizacao + amortizacao * i;   // juros sobre o último saldo
  } else parcela = i === 0 ? financiado / prazo : financiado * i / (1 - Math.pow(1 + i, -prazo));
  return { tipo: "pronto", sistema, preco, entrada, subsidio, financiado: arred(financiado), prazo_meses: prazo, juros_aa: juros,
    juros_am: Math.round(i * 100 * 10000) / 10000, renda: renda ?? null, parcela_inicial: arred(parcela), parcela_final: ultima == null ? null : arred(ultima),
    amortizacao: amortizacao == null ? null : arred(amortizacao), juros_iniciais: arred(jurosIni),
    comprometimento: renda > 0 ? arred(parcela / renda * 100) : null };
}

export const COMPONENTES = [
  ["sinal", "Sinal", true, "obra"], ["entrada_adicional", "Entrada adicional", true, "obra"], ["mensais", "Mensais", true, "obra"],
  ["reforcos", "Reforços", true, "obra"], ["chaves", "Chaves", false, "apos"], ["financiar", "Saldo a financiar", false, "apos"],
];

export function simularLancamento(e) {
  const preco = n(e.preco);
  if (!(preco > 0)) return { erro: "Informe o preço da unidade." };
  // A fase de obra é conferida primeiro: "40/70" é um erro do parâmetro, não dos componentes.
  {
    const d0 = n(e.obra?.durante), a0 = n(e.obra?.apos);
    if (d0 != null && a0 != null && Math.abs(d0 + a0 - 100) > 0.01)
      return { erro: `Durante a obra (${d0}%) e Após a obra (${a0}%) somam ${arred(d0 + a0)}% — precisam somar 100% (ex.: 40/60).` };
  }
  const c = e.componentes || {};
  const itens = []; let soma = 0; const fase = { obra: 0, apos: 0 }; let residuo = 0;
  for (const [k, rot, temQtd, f] of COMPONENTES) {
    const pct = n(c[k]?.pct);
    if (pct == null || pct === 0) continue;
    if (!isFinite(pct) || pct < 0 || pct > 100) return { erro: `Percentual de ${rot.toLowerCase()} inválido.` };
    let qtd = null;
    if (temQtd) {
      qtd = n(c[k]?.qtd);
      if (!Number.isInteger(qtd) || qtd < 1 || qtd > 600) return { erro: `Informe a quantidade de parcelas de ${rot.toLowerCase()} (1 a 600).` };
    }
    const total = arred(preco * pct / 100);
    const parcela = qtd ? arred(total / qtd) : null;
    if (qtd) residuo += arred(total - parcela * qtd);
    soma += pct; fase[f] += pct;
    itens.push({ chave: k, rotulo: rot, pct, total, qtd, parcela, fase: f });
  }
  if (!itens.length) return { erro: "Informe ao menos um componente do fluxo." };
  if (Math.abs(soma - 100) > 0.01) return { erro: `Os componentes somam ${String(arred(soma)).replace(".", ",")}% — precisam fechar em 100% do preço.` };
  const durante = n(e.obra?.durante), apos = n(e.obra?.apos);
  let obra = null;
  if (durante != null || apos != null) {
    if (durante == null || apos == null || durante < 0 || apos < 0) return { erro: "Informe Durante a obra e Após a obra." };
    if (Math.abs(durante + apos - 100) > 0.01)
      return { erro: `Durante a obra (${durante}%) e Após a obra (${apos}%) somam ${arred(durante + apos)}% — precisam somar 100% (ex.: 40/60).` };
    obra = { durante, apos, componentes_durante: arred(fase.obra), componentes_apos: arred(fase.apos), diferenca: arred(fase.obra - durante) };
  }
  return { tipo: "lancamento", preco, moeda: e.moeda === "USD" ? "USD" : "BRL", itens, soma: arred(soma), obra,
    residuo_arredondamento: arred(residuo), saldo_financiar: itens.find(x => x.chave === "financiar")?.total ?? 0 };
}
