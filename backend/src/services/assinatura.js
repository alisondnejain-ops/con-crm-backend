import db from "../db.js";
import { randomUUID } from "crypto";

/* Assinatura mensal e bloqueio por atraso.

   O estado é CALCULADO a partir da data de vencimento, não guardado como um
   "bloqueado: sim". Guardar o bloqueio exigiria alguém rodando todo dia para
   virar a chave — e no dia em que esse alguém falhasse, ou o cliente ficaria
   preso depois de pagar, ou usaria de graça por meses. Calculando, a resposta
   está sempre certa mesmo que nada rode.

   Regras combinadas com o Ali:
   - sem vence_em, não há cobrança: usa livre. Sistema que se tranca por falta
     de configuração é armadilha, não trava de segurança
   - aviso a partir de 3 dias antes do vencimento
   - vencido, ainda funciona durante a carência (5 dias por padrão): boleto
     compensa em dois dias úteis e Pix cai no fim de semana
   - passada a carência, bloqueia a TELA — nunca a entrada de leads */

const DIA = 86400000;
export const AVISO_ANTES = 3;

// Meia-noite do dia, para a conta ser em dias inteiros e não em horas.
const meiaNoite = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* Dono da conta — quem enxerga a mensalidade.

   O CRM pode ter mais de um gestor (papel 'adm'), e faz sentido: quem cuida da
   equipe não é necessariamente quem paga o sistema. Valor, histórico de
   pagamentos e dados de cobrança são do dono, e só dele.

   Sem dono definido (banco anterior a esta coluna), assume o gestor mais
   antigo. Deixar sem dono faria a tela sumir para todo mundo. */
export function donoDa(orgId) {
  const org = db.prepare("SELECT dono_user_id FROM orgs WHERE id = ?").get(orgId);
  if (org && org.dono_user_id) return org.dono_user_id;
  const primeiro = db.prepare(
    "SELECT id FROM users WHERE org_id = ? AND role = 'adm' ORDER BY created_at LIMIT 1").get(orgId);
  return primeiro ? primeiro.id : null;
}
export function ehDono(orgId, userId) {
  if (!userId) return false;
  /* O master é quem cobra a mensalidade de todas as imobiliárias, então é
     titular em qualquer uma — inclusive nas que ele nem pertence. Sem isto,
     trocar de imobiliária no hub deixava a tela de cobrança fora do alcance
     de quem emite a cobrança. */
  const u = db.prepare("SELECT master FROM users WHERE id = ?").get(userId);
  if (u && u.master) return true;
  return donoDa(orgId) === userId;
}

const somaMeses = (ms, n) => { const d = new Date(ms); d.setMonth(d.getMonth() + n); return d.getTime(); };

/* Recalcula o vencimento a partir da base e da quantidade de pagamentos.
   Cada pagamento vale um mês. É por isso que apagar um pagamento traz a data
   de volta sem nenhuma conta extra — e mexer em qualquer ordem dá no mesmo. */
export function recalcularVencimento(orgId) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (!org) return null;
  const base = org.vence_base || org.vence_em;
  if (!base) return null;
  const { n } = db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(orgId);
  const ultimo = db.prepare("SELECT MAX(pago_em) m FROM pagamentos WHERE org_id = ?").get(orgId).m;
  const vence = somaMeses(base, n);
  db.prepare("UPDATE orgs SET vence_em = ?, vence_base = ?, ultimo_pagamento_em = ? WHERE id = ?")
    .run(vence, base, ultimo || null, orgId);
  return vence;
}

export const listarPagamentos = (orgId) =>
  db.prepare("SELECT * FROM pagamentos WHERE org_id = ? ORDER BY pago_em DESC").all(orgId);

export function situacao(orgId, { dono = true } = {}) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (!org) return { status: "ativo", cobranca: false, dono };

  /* Para quem não é o dono, sai só o que a tela de bloqueio precisa: em que
     estado está e desde quando. Valor, plano e link de pagamento não são
     assunto do outro gestor nem do corretor. */
  const conforme = (s) => dono ? { ...s, dono } : {
    status: s.status, cobranca: s.cobranca, dono, motivo: s.motivo, teste: s.teste,
    dias: s.dias, atraso: s.atraso, restam: s.restam, carencia: s.carencia,
  };

  if (org.assinatura_status === "cancelado")
    return conforme({ status: "bloqueado", cobranca: true, motivo: "Assinatura cancelada.", plano: org.plano, valor: org.valor_mensal, link: org.link_pagamento });

  /* O TESTE GRÁTIS, que é um estado só do corretor autônomo.

     Ele reaproveita a máquina de vencimento em vez de inventar outra: o fim do
     teste É o primeiro vencimento. A diferença está no que a tela diz — "faltam
     9 dias de teste" não é a mesma frase que "sua mensalidade vence em 9 dias",
     e quem está experimentando precisa da primeira.

     Assim que entra o primeiro pagamento o teste acaba de ser assunto: a conta
     passa a ser uma assinatura comum, com a mesma régua de todas as outras. */
  if (org.trial_ate) {
    const pagos = db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(orgId).n;
    if (!pagos) {
      const faltam = Math.ceil((meiaNoite(org.trial_ate) - meiaNoite(Date.now())) / DIA);
      if (faltam >= 0)
        return conforme({ status: "teste", cobranca: true, teste: true, dias: faltam,
          vence_em: org.trial_ate, plano: org.plano, valor: org.valor_mensal, link: org.link_pagamento });
      return conforme({ status: "bloqueado", cobranca: true, teste: true, atraso: -faltam,
        vence_em: org.trial_ate, plano: org.plano, valor: org.valor_mensal, link: org.link_pagamento,
        motivo: "O teste de 14 dias terminou." });
    }
  }

  if (!org.vence_em) return conforme({ status: "ativo", cobranca: false });

  const dias = Math.round((meiaNoite(org.vence_em) - meiaNoite(Date.now())) / DIA);
  const carencia = org.dias_carencia == null ? 5 : org.dias_carencia;
  const base = {
    cobranca: true, plano: org.plano, valor: org.valor_mensal,
    vence_em: org.vence_em, dias, carencia, link: org.link_pagamento,
    ultimo_pagamento_em: org.ultimo_pagamento_em,
  };

  if (dias >= 0) return conforme({ ...base, status: dias <= AVISO_ANTES ? "vence_em_breve" : "ativo" });
  const atraso = -dias;
  if (atraso <= carencia)
    return conforme({ ...base, status: "atrasado", atraso, restam: carencia - atraso });
  return conforme({ ...base, status: "bloqueado", atraso, motivo: `Mensalidade em atraso há ${atraso} dias.` });
}

export const bloqueada = (orgId) => situacao(orgId).status === "bloqueado";

/* Registra o pagamento: grava a linha no histórico e recalcula o vencimento.

   Usar a data do vencimento como base (e não "hoje") mantém o dia fixo: quem
   vence dia 10 continua vencendo dia 10, mesmo pagando com atraso.

   Pagamento do Asaas traz o id da cobrança. Ele evita a linha repetida quando
   o Asaas manda PAYMENT_CONFIRMED e PAYMENT_RECEIVED da mesma fatura — que
   antes empurrava o vencimento dois meses de uma vez. */
export function registrarPagamento(orgId, { quando = Date.now(), link = null, valor = null, origem = "manual", asaasId = null, obs = null } = {}) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (!org) return null;

  if (asaasId) {
    const jaTem = db.prepare("SELECT 1 FROM pagamentos WHERE org_id = ? AND asaas_payment_id = ?").get(orgId, asaasId);
    if (jaTem) return org.vence_em;
  }

  // Primeira baixa num plano que ainda não tinha base: a base é o vencimento
  // atual, ou hoje se nem isso foi configurado.
  if (!org.vence_base)
    db.prepare("UPDATE orgs SET vence_base = ? WHERE id = ?").run(org.vence_em || quando, orgId);

  db.prepare(`INSERT INTO pagamentos (id,org_id,valor,pago_em,origem,asaas_payment_id,obs,created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run("pg_" + randomUUID(), orgId,
    valor != null ? Number(valor) : (org.valor_mensal ?? null), quando, origem, asaasId, obs, Date.now());

  db.prepare("UPDATE orgs SET assinatura_status = 'pago', link_pagamento = ? WHERE id = ?").run(link, orgId);
  return recalcularVencimento(orgId);
}

/* Apaga um pagamento lançado por engano. O vencimento volta um mês sozinho —
   é o recálculo que cuida disso, não uma subtração feita aqui. */
export function apagarPagamento(orgId, pagamentoId) {
  const alvo = db.prepare("SELECT * FROM pagamentos WHERE id = ? AND org_id = ?").get(pagamentoId, orgId);
  if (!alvo) return { ok: false, error: "Pagamento não encontrado." };
  db.prepare("DELETE FROM pagamentos WHERE id = ?").run(pagamentoId);
  // Sem pagamento nenhum sobrando, o estado 'pago' deixa de fazer sentido.
  const { n } = db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(orgId);
  if (!n) db.prepare("UPDATE orgs SET assinatura_status = NULL WHERE id = ?").run(orgId);
  return { ok: true, vence_em: recalcularVencimento(orgId) };
}

// Corrige data ou valor de um pagamento já lançado.
export function editarPagamento(orgId, pagamentoId, { pago_em, valor, obs }) {
  const alvo = db.prepare("SELECT * FROM pagamentos WHERE id = ? AND org_id = ?").get(pagamentoId, orgId);
  if (!alvo) return { ok: false, error: "Pagamento não encontrado." };
  db.prepare("UPDATE pagamentos SET pago_em = ?, valor = ?, obs = ? WHERE id = ?").run(
    pago_em != null && isFinite(pago_em) ? Number(pago_em) : alvo.pago_em,
    valor != null && valor !== "" ? Number(valor) : alvo.valor,
    obs !== undefined ? obs : alvo.obs, pagamentoId);
  return { ok: true, vence_em: recalcularVencimento(orgId) };
}

export function marcarAtraso(orgId, link) {
  db.prepare("UPDATE orgs SET assinatura_status = 'atrasado', link_pagamento = COALESCE(?, link_pagamento) WHERE id = ?")
    .run(link || null, orgId);
}

/* Porteiro. Responde 402 (pagamento necessário) quando a conta está bloqueada.

   O que NUNCA passa por aqui, e é de propósito:
   - os webhooks da Meta e da Uazapi, que continuam gravando lead. Lead que
     chega com o sistema bloqueado e não é gravado está perdido para sempre, e
     a imobiliária pagaria a conta de um erro nosso
   - a exportação da base: bloquear o acesso de alguém aos próprios dados de
     clientes é problema jurídico, não só comercial
   - a própria rota da assinatura, senão a tela de bloqueio não carregaria */
export function porteiro(req, res, next) {
  if (!req.user || !req.user.org_id) return next();
  const s = situacao(req.user.org_id);
  if (s.status !== "bloqueado") return next();
  res.status(402).json({
    error: s.motivo || "Assinatura em atraso.",
    bloqueado: true,
    link: s.link || null,
  });
}
