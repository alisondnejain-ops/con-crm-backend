/* QUAL PROVEDOR COBRA ESTA CONTA (04/10/2026) — Asaas ou Pagar.me.

   Uma pergunta, um lugar só: as rotas de plano, de ferramenta, o webhook, a
   exclusão de conta e a tela leem daqui. Duas cópias desta regra divergiriam
   no primeiro ajuste, e a cópia esquecida criaria cobrança no provedor errado
   — que é cobrança dupla ou mês sem cobrança.

   A ordem:
   1. O master escolheu (`orgs.cobranca`). Vale sempre. Escolher Pagar.me sem
      as chaves no servidor NÃO cai para o Asaas em silêncio: a conta fica no
      Pagar.me e as rotas respondem "não configurado" — criar cobrança no Asaas
      para uma conta que o master tirou de lá seria o pior desfecho.
   2. Quem TEM COBRANÇA DE VERDADE NO ASAAS fica no Asaas: uma assinatura que
      não foi cancelada, ou um pagamento que chegou pelo Asaas (o plano anual
      de lá é parcelado e não tem assinatura). É a VJ, hoje (pedido do Ali,
      04/10/2026: "a única que eu quero que não mexa até eu cancelar a
      assinatura dela no Asaas"). Mudar essas contas é decisão do master,
      conta por conta, no hub. Ter só o CADASTRO no Asaas (um CPF digitado
      num teste, sem cobrança nenhuma) não prende ninguém lá.
   3. O resto vai para o Pagar.me — mas só com chaves de PRODUÇÃO. Com as
      chaves de teste, o cartão de verdade do cliente seria recusado (o
      ambiente de teste só aceita cartão de teste), e a primeira tela de
      cobrança que ele visse daria erro. Com chave de teste, só a conta que o
      master pôs no Pagar.me à mão usa o checkout — é como se testa.
      `COBRANCA_PADRAO=asaas` desliga o padrão (todo mundo volta ao Asaas). */
import db from "../db.js";
import { pagarmeConfigurado, ambientePagarme } from "./pagarme.js";

export const PROVEDORES = ["asaas", "pagarme"];

export function temCobrancaNoAsaas(org) {
  if (!org) return false;
  if (org.asaas_subscription_id && org.assinatura_status !== "cancelado") return true;
  return !!db.prepare("SELECT 1 FROM pagamentos WHERE org_id = ? AND origem = 'asaas' LIMIT 1").get(org.id);
}

/* O Pagar.me é o padrão das contas sem cobrança no Asaas? */
export function pagarmePadrao() {
  const padrao = String(process.env.COBRANCA_PADRAO || "").trim().toLowerCase();
  if (padrao === "asaas") return false;
  return pagarmeConfigurado() && ambientePagarme() === "produção";
}

export function provedorDe(org) {
  if (!org) return "asaas";
  if (org.cobranca === "pagarme" || org.cobranca === "asaas") return org.cobranca;
  if (temCobrancaNoAsaas(org)) return "asaas";
  return pagarmePadrao() ? "pagarme" : "asaas";
}
