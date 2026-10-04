/* AS FERRAMENTAS DE CADA CONTA (29/09/2026, pedido do Ali: "preciso pensar tudo
   que vamos liberar por plano… as vezes o cliente não quer um plano mais caro
   mas quer apenas aquela ferramenta").

   Uma ferramenta (o Autoatendimento com IA, o Marketing) está ligada numa
   conta por um de três caminhos, e a pergunta "esta conta tem?" responde sempre
   AQUI — nunca numa rota, nunca na tela. É a lição de sempre deste projeto:
   regra escrita duas vezes diverge, e a cópia esquecida não dá erro, só deixa
   o recurso ligado para quem não pagou (ou desligado para quem pagou).

     1. O MASTER decidiu (`org_recursos.master`): "liberado" ou "retirado". Vale
        mais que tudo, nos dois sentidos — é o socorro, a cortesia e o castigo.
        Nulo quer dizer "siga o plano".
     2. O CLIENTE CONTRATOU AVULSO (`avulso_*`), com cobrança própria no Asaas.
        Vale enquanto o que foi pago cobre a data de hoje, com 3 dias de folga
        para o cartão que recusa uma vez e passa na segunda tentativa.
     3. O PLANO inclui (`inclui` em services/planos.js).

   CONTA SEM PLANO DE PRATELEIRA (a Conecta, os preços combinados, as contas
   criadas à mão pelo hub) MANTÉM O AUTOATENDIMENTO — decisão do Ali: a regra
   por plano vale para quem está num plano, e ninguém perde o que já usava por
   causa de uma publicação. O Marketing vem no Essencial semestral e anual e
   no Plus (04/10/2026); fora deles, depende de liberação ou de contratação. */
import db from "../db.js";
import { planoPorId } from "./planos.js";

/* O catálogo. O preço avulso mora aqui, no servidor, pela mesma razão da
   tabela de planos: preço que muda por engano vira fatura errada. */
export const RECURSOS = {
  autoatendimento: {
    nome: "Autoatendimento com IA",
    resumo: "A IA atende o lead que chega e ninguém respondeu: acolhe, pergunta o essencial e passa para a equipe.",
    avulso: 97,
  },
  marketing: {
    nome: "Marketing",
    resumo: "Disparo em massa e fluxos de mensagens para listas e etiquetas do CRM.",
    avulso: 97,
  },
};
export const ehRecurso = (id) => Object.prototype.hasOwnProperty.call(RECURSOS, id);

// Folga depois do vencimento da ferramenta avulsa: o cartão recusado na
// primeira tentativa costuma passar na segunda, e cortar a IA no meio disso
// deixaria lead sem resposta por causa de um reprocessamento do Asaas.
const FOLGA = 3 * 86400000;

const linha = (orgId, recurso) =>
  db.prepare("SELECT * FROM org_recursos WHERE org_id = ? AND recurso = ?").get(orgId, recurso) || null;

function garantirLinha(orgId, recurso) {
  db.prepare("INSERT OR IGNORE INTO org_recursos (org_id, recurso) VALUES (?, ?)").run(orgId, recurso);
}

export const avulsoValendo = (l, agora = Date.now()) =>
  !!l && !!l.avulso_pago_ate && l.avulso_pago_ate + FOLGA > agora
  && (l.avulso_status === "ativo" || l.avulso_status === "cancelado");

/* O plano desta conta inclui a ferramenta? */
export function incluiNoPlano(org, recurso) {
  if (!org) return false;
  const plano = planoPorId(org.plano_id);
  if (plano) return (plano.inclui || []).includes(recurso);
  return recurso === "autoatendimento";
}

/* A resposta, com o PORQUÊ — a tela do hub e a do cliente precisam dizer de
   onde veio o "sim" ou o "não", senão o master retira a IA de um cliente que
   pagou por ela avulsa sem saber que estava tirando algo pago. */
export function situacaoDoRecurso(orgId, recurso, agora = Date.now()) {
  const org = db.prepare("SELECT id, plano_id, tipo FROM orgs WHERE id = ?").get(orgId);
  const l = linha(orgId, recurso);
  const doPlano = incluiNoPlano(org, recurso);
  const avulso = avulsoValendo(l, agora);
  let ativo, origem;
  if (l?.master === "retirado") { ativo = false; origem = "retirado"; }
  else if (l?.master === "liberado") { ativo = true; origem = "liberado"; }
  else if (avulso) { ativo = true; origem = "avulso"; }
  else if (doPlano) { ativo = true; origem = "plano"; }
  else { ativo = false; origem = "fora_do_plano"; }
  return {
    id: recurso, nome: RECURSOS[recurso].nome, resumo: RECURSOS[recurso].resumo,
    preco_avulso: RECURSOS[recurso].avulso,
    ativo, origem,
    no_plano: doPlano,
    master: l?.master || null,
    avulso: l?.avulso_status ? {
      status: l.avulso_status,
      pago_ate: l.avulso_pago_ate || null,
      valendo: avulso,
      link: l.avulso_status === "aguardando" ? (l.avulso_link || null) : null,
    } : null,
  };
}

export const temRecurso = (orgId, recurso, agora = Date.now()) =>
  !!orgId && ehRecurso(recurso) && situacaoDoRecurso(orgId, recurso, agora).ativo;

export const recursosDaOrg = (orgId) =>
  Object.keys(RECURSOS).map(id => situacaoDoRecurso(orgId, id));

/* Mapa curto para a sessão: é o que decide menu e telas no navegador. */
export const mapaDeRecursos = (orgId) =>
  Object.fromEntries(Object.keys(RECURSOS).map(id => [id, temRecurso(orgId, id)]));

/* ===== O MASTER ===== */
export function definirPeloMaster(orgId, recurso, estado, porUserId) {
  if (!ehRecurso(recurso)) throw new Error("Ferramenta desconhecida.");
  if (estado !== "liberado" && estado !== "retirado" && estado !== null)
    throw new Error("Estado inválido.");
  garantirLinha(orgId, recurso);
  db.prepare("UPDATE org_recursos SET master = ?, master_em = ?, master_por = ? WHERE org_id = ? AND recurso = ?")
    .run(estado, Date.now(), porUserId || null, orgId, recurso);
  return situacaoDoRecurso(orgId, recurso);
}

/* ===== O AVULSO ===== */
export function registrarContratacao(orgId, recurso, { assinaturaId, link }) {
  garantirLinha(orgId, recurso);
  db.prepare(`UPDATE org_recursos SET avulso_status = 'aguardando', avulso_sub_id = ?, avulso_link = ?,
      avulso_desde = ?, avulso_cancelado_em = NULL WHERE org_id = ? AND recurso = ?`)
    .run(assinaturaId, link || null, Date.now(), orgId, recurso);
}

// A ferramenta avulsa a que esta assinatura do Asaas pertence, ou null.
export const avulsoDaAssinatura = (assinaturaId) => assinaturaId
  ? db.prepare("SELECT * FROM org_recursos WHERE avulso_sub_id = ?").get(assinaturaId) || null
  : null;

/* Entrou dinheiro. O Asaas manda PAYMENT_CONFIRMED e PAYMENT_RECEIVED da MESMA
   cobrança — o id do pagamento é o que impede o segundo de dar mais um mês. */
export function avulsoPago(l, pagamentoId, agora = Date.now()) {
  if (pagamentoId && l.avulso_ultimo_pagamento === pagamentoId) return false;
  const base = Math.max(l.avulso_pago_ate || 0, agora);
  db.prepare(`UPDATE org_recursos SET avulso_status = 'ativo', avulso_pago_ate = ?, avulso_ultimo_pagamento = ?,
      avulso_link = NULL WHERE org_id = ? AND recurso = ?`)
    .run(base + 31 * 86400000, pagamentoId || null, l.org_id, l.recurso);
  return true;
}

/* Cancelada. Estorno e contestação tiram o acesso na hora (o dinheiro voltou);
   cancelamento comum deixa valer até o fim do que já foi pago. */
export function avulsoCancelado(l, { estorno = false } = {}) {
  // 'estornado' fica fora de `avulsoValendo`: sem folga nenhuma.
  db.prepare(`UPDATE org_recursos SET avulso_status = ?, avulso_cancelado_em = ?, avulso_link = NULL
      WHERE org_id = ? AND recurso = ?`)
    .run(estorno ? "estornado" : "cancelado", Date.now(), l.org_id, l.recurso);
}
