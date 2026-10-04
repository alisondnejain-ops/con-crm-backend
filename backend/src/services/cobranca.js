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
   2. Quem já tem cliente no Asaas fica no Asaas (é quem já paga, ou já
      começou a pagar lá — a VJ, hoje). Mudar essas contas é decisão do master,
      conta por conta.
   3. O resto segue `COBRANCA_PADRAO` (padrão: asaas). Trocar essa variável
      para `pagarme` passa a valer para as contas novas, sem tocar em quem já
      tem cobrança. */
import { pagarmeConfigurado } from "./pagarme.js";

export const PROVEDORES = ["asaas", "pagarme"];

export function provedorDe(org) {
  if (!org) return "asaas";
  if (org.cobranca === "pagarme" || org.cobranca === "asaas") return org.cobranca;
  if (org.asaas_customer_id) return "asaas";
  const padrao = String(process.env.COBRANCA_PADRAO || "").trim().toLowerCase();
  return padrao === "pagarme" && pagarmeConfigurado() ? "pagarme" : "asaas";
}
