/* BOLETO, SÓ NAS CONTAS QUE O MASTER LIBERA (15/10/2026, pedido do Ali: "eu
   quero liberar a função boleto somente em contas específicas… o cliente entra
   em contato com o suporte e a gente libera a opção de boleto para ele").

   POR QUE É EXCEÇÃO E NÃO OPÇÃO DE TODOS: o cartão cobra sozinho todo mês; o
   boleto, não — cada período é um boleto novo que o cliente gera e paga, e
   quem esquece trava. Por isso a chave é do master, conta por conta.

   O QUE O BOLETO COMPRA: um período do plano da conta (o mensal compra 1 mês,
   o semestral 6, o anual 12, pagos de uma vez) ou, na conta de preço
   combinado, um mês da mensalidade combinada. O valor sai do servidor — o
   cliente escolhe o plano, nunca o preço.

   Este arquivo é o que não depende do provedor: achar o boleto pelo id da
   cobrança e dar baixa quando ele é pago. Gerar fica em
   routes/assinatura.routes.js, junto dos outros caminhos de cobrança. */
import db from "../db.js";
import { registrarPagamento, apagarPagamento } from "./assinatura.js";
import { planoPorId } from "./planos.js";

export const boletoLiberado = (org) => !!(org && org.boleto_liberado);

export function boletoPorCobranca(provedor, cobrancaId) {
  if (!cobrancaId) return null;
  return db.prepare("SELECT * FROM boletos WHERE provedor = ? AND cobranca_id = ?").get(provedor, String(cobrancaId)) || null;
}
export function boletoPorPedido(pedidoId) {
  if (!pedidoId) return null;
  return db.prepare("SELECT * FROM boletos WHERE provedor = 'pagarme' AND pedido_id = ?").get(String(pedidoId)) || null;
}

/* PAGO: credita os meses que ESTE boleto comprou (gravados na criação — não
   deduzidos do valor, que num boleto pago com juros viria diferente), troca o
   plano da conta quando o boleto era de outro plano, e desfaz o cancelamento:
   quem pagou o boleto escolheu continuar.

   O id da cobrança vai para o histórico de pagamentos (`asaasId`), que é o que
   impede o mesmo aviso, repetido, de dar dois períodos. */
export function confirmarBoleto(boleto, { valor = null, quando = Date.now() } = {}) {
  if (!boleto || boleto.status === "pago") return false;
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(boleto.org_id);
  if (!org) return false;
  const plano = boleto.plano_id ? planoPorId(boleto.plano_id) : null;
  if (plano && org.plano_id !== plano.id)
    db.prepare("UPDATE orgs SET plano_id = ?, plano = ?, valor_mensal = ? WHERE id = ?")
      .run(plano.id, `ConHub ${plano.nome}`, plano.mensal, org.id);
  db.prepare("UPDATE orgs SET cancelado_em = NULL WHERE id = ?").run(org.id);
  registrarPagamento(org.id, { quando, valor: valor != null ? Number(valor) : boleto.valor,
    origem: boleto.provedor, asaasId: boleto.cobranca_id || boleto.id, meses: boleto.meses, obs: "Boleto" });
  db.prepare("UPDATE boletos SET status = 'pago', pago_em = ? WHERE id = ?").run(quando, boleto.id);
  return true;
}

/* ESTORNADO (o provedor devolveu o dinheiro): o período comprado sai do
   histórico e o vencimento volta sozinho. Deixar o mês creditado seria dar o
   acesso de graça; travar a conta sem tirar o crédito seria contradizer o
   histórico que o cliente vê. */
export function estornarBoleto(boleto) {
  if (!boleto || boleto.status === "estornado") return false;
  const pg = db.prepare("SELECT id FROM pagamentos WHERE org_id = ? AND asaas_payment_id = ?")
    .get(boleto.org_id, boleto.cobranca_id || boleto.id);
  if (pg) apagarPagamento(boleto.org_id, pg.id);
  db.prepare("UPDATE boletos SET status = 'estornado' WHERE id = ?").run(boleto.id);
  return true;
}

export function cancelarBoletoLocal(boleto) {
  if (!boleto || boleto.status !== "aberto") return false;
  db.prepare("UPDATE boletos SET status = 'cancelado', cancelado_em = ? WHERE id = ?").run(Date.now(), boleto.id);
  return true;
}

/* O que a tela mostra de cada boleto. `vencido` é calculado: boleto vencido
   pode ainda ser pago (o banco cobra multa), e o aviso de pago continua dando
   baixa — só a tela diz que passou da data. */
export function boletosParaTela(orgId, limite = 6) {
  const hoje = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return db.prepare("SELECT * FROM boletos WHERE org_id = ? ORDER BY criado_em DESC LIMIT ?").all(orgId, limite)
    .map(b => ({ id: b.id, descricao: b.descricao, valor: b.valor, meses: b.meses, plano_id: b.plano_id,
      vencimento: b.vencimento, url: b.url, pdf: b.pdf, linha: b.linha, status: b.status,
      vencido: b.status === "aberto" && b.vencimento < hoje, criado_em: b.criado_em, pago_em: b.pago_em }));
}
