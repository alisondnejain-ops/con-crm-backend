import db from "../db.js";

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

export function situacao(orgId) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (!org) return { status: "ativo", cobranca: false };

  if (org.assinatura_status === "cancelado")
    return { status: "bloqueado", cobranca: true, motivo: "Assinatura cancelada.", plano: org.plano, valor: org.valor_mensal, link: org.link_pagamento };

  if (!org.vence_em) return { status: "ativo", cobranca: false };

  const dias = Math.round((meiaNoite(org.vence_em) - meiaNoite(Date.now())) / DIA);
  const carencia = org.dias_carencia == null ? 5 : org.dias_carencia;
  const base = {
    cobranca: true, plano: org.plano, valor: org.valor_mensal,
    vence_em: org.vence_em, dias, carencia, link: org.link_pagamento,
    ultimo_pagamento_em: org.ultimo_pagamento_em,
  };

  if (dias >= 0) return { ...base, status: dias <= AVISO_ANTES ? "vence_em_breve" : "ativo" };
  const atraso = -dias;
  if (atraso <= carencia)
    return { ...base, status: "atrasado", atraso, restam: carencia - atraso };
  return { ...base, status: "bloqueado", atraso, motivo: `Mensalidade em atraso há ${atraso} dias.` };
}

export const bloqueada = (orgId) => situacao(orgId).status === "bloqueado";

/* Registra o pagamento e empurra o vencimento para o mês seguinte.
   Usar a data do vencimento como base (e não "hoje") mantém o dia fixo: quem
   vence dia 10 continua vencendo dia 10, mesmo pagando com atraso. */
export function registrarPagamento(orgId, { quando = Date.now(), link = null } = {}) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (!org) return null;
  const base = org.vence_em && org.vence_em > 0 ? new Date(org.vence_em) : new Date(quando);
  const proximo = new Date(base);
  proximo.setMonth(proximo.getMonth() + 1);
  db.prepare(`UPDATE orgs SET vence_em = ?, assinatura_status = 'pago', ultimo_pagamento_em = ?, link_pagamento = ?
              WHERE id = ?`).run(proximo.getTime(), quando, link, orgId);
  return proximo.getTime();
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
