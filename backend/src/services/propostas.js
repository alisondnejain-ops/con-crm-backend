/* ===== PROPOSTA PERSONALIZADA: O CHECKOUT DE UM CLIENTE SÓ =====
   (10/11/2026, pedido do Ali: "vendemos um plano anual para uma imobiliária
   que vai precisar de 42 acessos por R$ 14.400 — cria um link com o preço
   parcelado em evidência, exatamente como a página de vendas do ConHub")

   A página de vendas (`/comecar`) só conhece os planos da tabela. A venda
   negociada — preço, prazo e quantidade de acessos combinados com UM cliente —
   não tinha porta: o caminho era um link avulso no painel do Pagar.me, que o
   sistema não enxerga (a conta não destravava sozinha, e alguém precisava
   lembrar de dar os 12 meses na mão).

   A proposta é essa porta. O master cria no hub (nome do cliente, valor,
   parcelas, meses, acessos, o que está incluído, validade) e manda o link
   `/proposta/<código>`. O cliente vê a página com a cara do ConHub, montada
   para ele, e paga ali mesmo.

   ===== AS TRAVAS =====

   1. O VALOR VEM DA PROPOSTA, NUNCA DO NAVEGADOR. O corpo do pagamento traz o
      cartão (já como token) e os dados de quem paga — preço, parcelas e meses
      são lidos da linha gravada pelo master.

   2. O CARTÃO É COBRADO ANTES DE A CONTA EXISTIR. Recusado, nenhuma conta
      nasce e o e-mail não fica preso; a pessoa corrige e tenta de novo no
      mesmo link.

   3. UMA PROPOSTA, UM PAGAMENTO. Paga, ela fecha; o mesmo link mostra "já foi
      paga" e não cobra de novo. Duas abas clicando juntas: a segunda bate na
      trava `aberta → pagando` do banco e é recusada.

   4. O CÓDIGO DO LINK É LONGO E ALEATÓRIO (24 caracteres). Quem não tem o
      link não acha a proposta, e a página não mostra nada da conta além do
      nome que o próprio master escreveu.

   5. VALIDADE. Passada a data, o link diz que venceu e não cobra.

   ===== O QUE O PAGAMENTO FAZ =====

   Um pedido no Pagar.me, no valor cheio, parcelado no cartão do cliente
   (`criarPedido`, o mesmo do anual da tabela). Pago: os meses da proposta
   entram no histórico (`registrarPagamento`, com o id da cobrança — webhook
   repetido não dá dois períodos), o vencimento anda, as ferramentas marcadas
   são liberadas e a conta passa a ser cobrada pelo Pagar.me, sem plano da
   tabela e com o valor por mês da proposta como "mensalidade combinada" (só
   um rótulo — nada é cobrado todo mês). Se a conta já tinha assinatura
   recorrente (Pagar.me ou Asaas), ela é cancelada depois de o pagamento
   entrar: senão o cliente pagaria o anual e continuaria sendo cobrado.

   Pedido que fica em análise (antifraude) não destrava a conta na hora: a
   proposta fica "processando" e o aviso do Pagar.me (`/webhooks/pagarme`)
   credita quando a cobrança é paga.

   NÃO CONFERIDO CONTRA O PAGAR.ME DE VERDADE (a mesma ressalva de
   services/pagarme.js): o pedido é o mesmo do anual da tabela. */
import { randomUUID, randomBytes } from "crypto";
export const PROVEDORES_DA_PROPOSTA = ["pagarme", "asaas"];
import db from "../db.js";
import { registrarPagamento, apagarPagamento } from "./assinatura.js";
import { definirPeloMaster, ehRecurso } from "./recursos.js";
import * as pagarme from "./pagarme.js";
import * as asaas from "./asaas.js";
import { codigoLivre } from "./codigo.js";
const cancelarAsaas = asaas.cancelarAssinatura;

export const RECURSOS_DA_PROPOSTA = ["autoatendimento", "marketing", "cetrolab"];
const DIA = 86400000;

export class ErroProposta extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const texto = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const centavos = (v) => Math.round(Number(v) * 100);

/* Lê "14.400", "14400", "14.400,00", "R$ 1.200,50" ou um número. */
export function valorBR(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  let s = String(v ?? "").replace(/[^\d.,]/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  return Number(s);
}

/* A parcela, em centavos inteiros. 14.400 em 12x = 1.200,00 exatos; um valor
   que não divide (14.000 em 12x) mostra a parcela arredondada e a tela diz o
   total, que é o que o Pagar.me cobra. */
export const parcelaDe = (total, parcelas) => Math.round(centavos(total) / parcelas) / 100;

export function lerEntrada(corpo = {}) {
  const cliente = texto(corpo.cliente, 80);
  if (cliente.length < 2) throw new ErroProposta(400, "Escreva o nome do cliente (a imobiliária).");
  const total = valorBR(corpo.total);
  if (!Number.isFinite(total) || total < 1 || total > 1000000)
    throw new ErroProposta(400, "Valor total inválido. Escreva em reais, ex.: 14.400.");
  const parcelas = Math.round(Number(corpo.parcelas));
  if (!(parcelas >= 1 && parcelas <= 12)) throw new ErroProposta(400, "Parcelas: de 1 a 12.");
  const meses = Math.round(Number(corpo.meses));
  if (!(meses >= 1 && meses <= 36)) throw new ErroProposta(400, "Meses de acesso: de 1 a 36.");
  const acessos = corpo.acessos === "" || corpo.acessos == null ? null : Math.round(Number(corpo.acessos));
  if (acessos != null && !(acessos >= 1 && acessos <= 10000)) throw new ErroProposta(400, "Quantidade de acessos inválida.");
  const dias = Math.round(Number(corpo.validade_dias ?? 7));
  if (!(dias >= 1 && dias <= 60)) throw new ErroProposta(400, "Validade do link: de 1 a 60 dias.");
  const itens = (Array.isArray(corpo.itens) ? corpo.itens : String(corpo.itens || "").split("\n"))
    .map(x => texto(x, 140)).filter(Boolean).slice(0, 12);
  const recursos = [...new Set((Array.isArray(corpo.recursos) ? corpo.recursos : []).map(String))]
    .filter(r => RECURSOS_DA_PROPOSTA.includes(r) && ehRecurso(r));
  const provedor = corpo.provedor == null || corpo.provedor === "" ? "pagarme" : String(corpo.provedor);
  if (!PROVEDORES_DA_PROPOSTA.includes(provedor)) throw new ErroProposta(400, "Escolha por onde cobrar: Pagar.me ou Asaas.");
  let orgId = texto(corpo.org_id, 60) || null;
  if (orgId && !db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(orgId))
    throw new ErroProposta(400, "A conta escolhida não existe.");
  return {
    cliente, total, parcelas, meses, acessos, dias, itens, recursos, orgId, provedor,
    titulo: texto(corpo.titulo, 80) || `Plano ConHub · ${meses === 12 ? "anual" : meses + " meses"}`,
    contato_nome: texto(corpo.contato_nome, 80) || null,
    contato_email: texto(corpo.contato_email, 120).toLowerCase() || null,
    mensagem: texto(corpo.mensagem, 400) || null,
  };
}

export function criarProposta(corpo, porUserId) {
  const e = lerEntrada(corpo);
  if (e.contato_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.contato_email))
    throw new ErroProposta(400, "Confira o e-mail do responsável.");
  const id = "prop_" + randomUUID();
  const codigo = randomBytes(18).toString("base64url");   // 24 caracteres
  const agora = Date.now();
  db.prepare(`INSERT INTO propostas (id,codigo,org_id,cliente,titulo,contato_nome,contato_email,mensagem,total,parcelas,meses,
      acessos,itens_json,recursos_json,valida_ate,status,criado_por,created_at,provedor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'aberta',?,?,?)`)
    .run(id, codigo, e.orgId, e.cliente, e.titulo, e.contato_nome, e.contato_email, e.mensagem, e.total, e.parcelas, e.meses,
      e.acessos, JSON.stringify(e.itens), JSON.stringify(e.recursos), agora + e.dias * DIA, porUserId || null, agora, e.provedor);
  return lerProposta(id);
}

export const lerProposta = (id) => db.prepare("SELECT * FROM propostas WHERE id = ?").get(id) || null;
export const propostaPorCodigo = (codigo) =>
  /^[A-Za-z0-9_-]{16,64}$/.test(String(codigo || "")) ? (db.prepare("SELECT * FROM propostas WHERE codigo = ?").get(codigo) || null) : null;
export const propostaPorAsaas = (pagamentoId, parcelamentoId) =>
  (parcelamentoId && db.prepare("SELECT * FROM propostas WHERE asaas_parcelamento_id = ?").get(String(parcelamentoId)))
  || (pagamentoId && db.prepare("SELECT * FROM propostas WHERE asaas_pagamento_id = ?").get(String(pagamentoId)))
  || null;
export const propostaPorPedido = (pedidoId) =>
  pedidoId ? (db.prepare("SELECT * FROM propostas WHERE pedido_id = ?").get(String(pedidoId)) || null) : null;

/* "aberta" que passou da validade é "vencida" na leitura — não precisa de
   ninguém varrer a tabela. */
export function estadoDe(p) {
  if (!p) return null;
  if (p.status === "aberta" && p.valida_ate < Date.now()) return "vencida";
  return p.status;
}

const json = (s, padrao) => { try { return JSON.parse(s || ""); } catch { return padrao; } };

/* O que a página pública mostra. Lista branca: nada de quem criou, do pedido,
   do id da conta ou de qualquer coisa interna. */
export function paraPagina(p) {
  const org = p.org_id ? db.prepare("SELECT name FROM orgs WHERE id = ?").get(p.org_id) : null;
  return {
    cliente: p.cliente, titulo: p.titulo, mensagem: p.mensagem, contato_nome: p.contato_nome,
    contato_email: p.contato_email, total: p.total, parcelas: p.parcelas, parcela: parcelaDe(p.total, p.parcelas),
    meses: p.meses, acessos: p.acessos, itens: json(p.itens_json, []), recursos: json(p.recursos_json, []),
    valida_ate: p.valida_ate, estado: estadoDe(p), conta_existente: !!p.org_id, conta_nome: org ? org.name : null,
    provedor: p.provedor || "pagarme",
  };
}

/* Para o hub. */
export function paraHub(p, base) {
  const org = p.org_id ? db.prepare("SELECT name FROM orgs WHERE id = ?").get(p.org_id) : null;
  const criada = p.org_criada_id ? db.prepare("SELECT name FROM orgs WHERE id = ?").get(p.org_criada_id) : null;
  return {
    ...paraPagina(p), id: p.id, link: `${base}/proposta/${p.codigo}`, org_id: p.org_id, conta_nome: org ? org.name : null,
    org_criada_id: p.org_criada_id, org_criada_nome: criada ? criada.name : null, created_at: p.created_at,
    paga_em: p.paga_em, pagador: p.pagador_nome ? { nome: p.pagador_nome, email: p.pagador_email } : null,
    erro: p.ultimo_erro || null,
  };
}

export const listarPropostas = () => db.prepare("SELECT * FROM propostas ORDER BY created_at DESC LIMIT 100").all();

export function cancelarProposta(id) {
  const p = lerProposta(id);
  if (!p) throw new ErroProposta(404, "Proposta não encontrada.");
  if (!["aberta"].includes(p.status)) throw new ErroProposta(409, "Só a proposta ainda não paga pode ser cancelada.");
  db.prepare("UPDATE propostas SET status = 'cancelada', cancelada_em = ? WHERE id = ? AND status = 'aberta'").run(Date.now(), id);
  return lerProposta(id);
}

/* A TRAVA DO PAGAMENTO: só uma tentativa por vez. `aberta → pagando` no
   banco; quem chega depois recebe falso. */
export function travarParaPagar(p) {
  const r = db.prepare("UPDATE propostas SET status = 'pagando' WHERE id = ? AND status = 'aberta' AND valida_ate >= ?")
    .run(p.id, Date.now());
  return r.changes === 1;
}
export const destravar = (p, erro) =>
  db.prepare("UPDATE propostas SET status = 'aberta', ultimo_erro = ? WHERE id = ? AND status = 'pagando'").run(erro || null, p.id);

export function marcarProcessando(p, { pedidoId, cobrancaId, orgId, pagador }) {
  db.prepare(`UPDATE propostas SET status = 'processando', pedido_id = ?, cobranca_id = ?, org_criada_id = COALESCE(org_criada_id, ?),
      pagador_nome = ?, pagador_email = ?, ultimo_erro = NULL WHERE id = ?`)
    .run(pedidoId || null, cobrancaId || null, orgId || null, pagador?.nome || null, pagador?.email || null, p.id);
}

/* PAGO: credita os meses, libera as ferramentas e marca a conta. Idempotente
   pelo id da cobrança (registrarPagamento ignora o repetido) e pelo status. */
export function confirmarProposta(p, { orgId, cobrancaId, valor = null, quando = Date.now(), pagador = null, porUserId = null }) {
  if (orgId && !p.org_id)
    db.prepare("UPDATE propostas SET org_criada_id = COALESCE(org_criada_id, ?) WHERE id = ?").run(orgId, p.id);
  const atual = lerProposta(p.id);
  if (!atual || atual.status === "paga") return false;
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (!org) return false;
  const jaPagos = db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(org.id).n;
  /* Os meses contam de HOJE — ou do fim do que já estava pago ou do teste, se
     for depois: quem paga adiantado não perde dias. Só na primeira baixa da
     conta; depois disso o histórico já tem a base certa. */
  /* Conta que a própria proposta criou começa no dia do pagamento (o prazo de
     espera que ela ganhou enquanto o pagamento era analisado não é período
     pago). */
  const contaNova = atual.org_criada_id === org.id;
  if (!jaPagos) {
    const base = contaNova ? quando : Math.max(quando, org.trial_ate || 0, org.vence_em && org.vence_em > quando ? org.vence_em : 0);
    db.prepare("UPDATE orgs SET vence_base = ?, vence_em = ? WHERE id = ?").run(base, base, org.id);
  }
  const porMes = Math.round((atual.total / atual.meses) * 100) / 100;
  const provedor = atual.provedor === "asaas" ? "asaas" : "pagarme";
  db.prepare(`UPDATE orgs SET cobranca = ?, plano_id = NULL, plano = ?, valor_mensal = ?, cancelado_em = NULL,
      assinatura_status = NULL WHERE id = ?`).run(provedor, `ConHub · ${atual.titulo}`, porMes, org.id);
  registrarPagamento(org.id, { quando, valor: valor != null ? Number(valor) : atual.total, origem: provedor,
    asaasId: cobrancaId || atual.id, meses: atual.meses, obs: `Proposta: ${atual.titulo}` });
  for (const r of json(atual.recursos_json, [])) {
    try { definirPeloMaster(org.id, r, "liberado", porUserId || atual.criado_por); }
    catch (e) { console.warn(`[proposta] não liberei ${r} em ${org.name}: ${e.message}`); }
  }
  db.prepare(`UPDATE propostas SET status = 'paga', paga_em = ?, cobranca_id = COALESCE(?, cobranca_id),
      org_criada_id = COALESCE(org_criada_id, ?), pagador_nome = COALESCE(?, pagador_nome),
      pagador_email = COALESCE(?, pagador_email), ultimo_erro = NULL WHERE id = ?`)
    .run(quando, cobrancaId || null, orgId, pagador?.nome || null, pagador?.email || null, atual.id);
  return true;
}

/* ESTORNO/CONTESTAÇÃO: os meses saem e o vencimento volta sozinho. */
export function estornarProposta(p) {
  const orgId = p.org_criada_id || p.org_id;
  if (!orgId || p.status === "estornada") return false;
  const pg = db.prepare("SELECT id FROM pagamentos WHERE org_id = ? AND asaas_payment_id = ?").get(orgId, p.cobranca_id || p.id);
  if (pg) apagarPagamento(orgId, pg.id);
  db.prepare("UPDATE propostas SET status = 'estornada' WHERE id = ?").run(p.id);
  return true;
}

/* Recusada depois (antifraude negou): a proposta volta a aceitar pagamento. */
export function recusarProposta(p, motivo) {
  if (p.status !== "processando") return false;
  db.prepare("UPDATE propostas SET status = 'aberta', ultimo_erro = ? WHERE id = ?").run(motivo || "O cartão recusou a cobrança.", p.id);
  return true;
}

/* A assinatura recorrente que a conta JÁ tinha (Pagar.me ou Asaas) sai
   DEPOIS de o pagamento da proposta entrar — senão o cliente pagaria o anual
   e continuaria sendo cobrado todo mês. A falha não desfaz o pagamento: vira
   aviso no log, e o master cancela no provedor. Nunca lança. */
export async function cancelarRecorrentes(org) {
  try {
    const atual = db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id) || org;
    if (atual.pagarme_subscription_id) {
      try { await pagarme.cancelarAssinatura(atual.pagarme_subscription_id); }
      catch (e) { console.warn(`[proposta] a assinatura antiga ${atual.pagarme_subscription_id} não foi cancelada: ${e.message}`); }
    }
    if (atual.asaas_subscription_id) {
      try { await cancelarAsaas(atual.asaas_subscription_id); }
      catch (e) { console.warn(`[proposta] a assinatura do Asaas ${atual.asaas_subscription_id} não foi cancelada: ${e.message}`); }
    }
    db.prepare("UPDATE orgs SET pagarme_subscription_id = NULL, pagarme_order_id = NULL, asaas_subscription_id = NULL WHERE id = ?").run(atual.id);
  } catch (e) { console.warn(`[proposta] cancelar as recorrentes: ${e.message}`); }
}

/* A CONTA NOVA DA PROPOSTA. Uma função só para os dois provedores: no
   Pagar.me ela nasce logo depois de o cartão passar; no Asaas, quando o aviso
   de pago chega (o cliente pagou na fatura do Asaas, fora daqui). O e-mail
   que ficou preso por outra pessoa no meio do caminho é recusado aqui —
   quem chama trata como "pago sem conta" e o master resolve no hub. */
export function nascerConta({ orgId, nome, email, telefone, marca, passHash, cobranca, colunas = {}, venceEm = null }) {
  const ja = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (ja && ja.status === "ativo") throw new Error(`o e-mail ${email} já tem conta ativa`);
  const agora = Date.now();
  const userId = ja ? ja.id : "u_" + randomUUID();
  const extras = Object.keys(colunas);
  db.transaction(() => {
    db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at,tipo,cobranca,vence_em
        ${extras.map(c => "," + c).join("")})
      VALUES (?,?,?,'',0,0,?,'imobiliaria',?,?${extras.map(() => ",?").join("")})`)
      .run(orgId, marca, codigoLivre(marca), agora, cobranca, venceEm, ...extras.map(c => colunas[c]));
    if (ja) {
      db.prepare(`UPDATE users SET org_id=?, name=?, phone=?, role='adm', available=0, status='ativo', pass_hash=?,
        invite_token=NULL, invite_hash=NULL, invite_expires=NULL, invite_tipo=NULL WHERE id=?`)
        .run(orgId, nome, telefone || "", passHash, userId);
    } else {
      db.prepare(`INSERT INTO users (id,org_id,name,email,phone,pass_hash,role,available,created_at,status)
        VALUES (?,?,?,?,?,?,'adm',0,?,'ativo')`).run(userId, orgId, nome, email, telefone || "", passHash, agora);
    }
    db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(userId, orgId);
  })();
  return userId;
}

/* ===== PELO ASAAS (10/11/2026, pedido do Ali: "a taxa dele é melhor") =====

   O cartão é digitado na FATURA HOSPEDADA do Asaas — a mesma regra do resto do
   ConHub com o Asaas: número de cartão nunca passa por aqui. A página da
   proposta continua sendo a nossa (o preço em destaque, o que está incluído);
   o botão cria o parcelamento e abre a fatura.

   Como o pagamento acontece fora, a conta nova NÃO nasce no clique: o cadastro
   do responsável fica guardado na proposta (a senha só como hash) e a conta
   nasce quando o Asaas avisa que foi pago — pelo webhook, ou pela conferência
   que a própria página faz enquanto a pessoa paga. Os dois caminhos passam por
   `confirmarAsaas`, que é idempotente pelo status. */
export function marcarAguardandoAsaas(p, { pagamentoId, parcelamentoId, fatura, cadastro, orgId, pagador }) {
  db.prepare(`UPDATE propostas SET status = 'aguardando', asaas_pagamento_id = ?, asaas_parcelamento_id = ?, asaas_fatura = ?,
      cadastro_json = ?, org_criada_id = COALESCE(org_criada_id, ?), pagador_nome = ?, pagador_email = ?, ultimo_erro = NULL WHERE id = ?`)
    .run(pagamentoId || null, parcelamentoId || null, fatura || null, cadastro ? JSON.stringify(cadastro) : null,
      orgId || null, pagador?.nome || null, pagador?.email || null, p.id);
}

/* Fatura apagada no Asaas antes de ser paga: a proposta volta a aceitar. */
export function faturaAsaasCaiu(p, motivo) {
  db.prepare(`UPDATE propostas SET status = 'aberta', asaas_pagamento_id = NULL, asaas_parcelamento_id = NULL, asaas_fatura = NULL,
      ultimo_erro = ? WHERE id = ? AND status = 'aguardando'`).run(motivo || "A fatura do Asaas foi cancelada.", p.id);
}

const PAGO_ASAAS = new Set(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"]);

export async function confirmarAsaas(p, { valor = null, quando = Date.now() } = {}) {
  const atual = lerProposta(p.id);
  if (!atual || atual.status !== "aguardando") return false;
  let orgId = atual.org_id;
  if (!orgId) {
    const c = json(atual.cadastro_json, null);
    orgId = atual.org_criada_id || ("org_" + randomUUID().slice(0, 8));
    if (!db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(orgId)) {
      try {
        if (!c) throw new Error("o cadastro do responsável não ficou guardado");
        nascerConta({ orgId, nome: c.nome, email: c.email, telefone: c.telefone, marca: c.marca || atual.cliente,
          passHash: c.pass_hash, cobranca: "asaas", colunas: { asaas_customer_id: c.cliente_asaas || null } });
      } catch (e) {
        db.prepare("UPDATE propostas SET status = 'processando', ultimo_erro = ? WHERE id = ?")
          .run("Pagamento feito no Asaas, mas a conta não foi criada: " + e.message, atual.id);
        console.error(`[proposta] PAGO SEM CONTA (${atual.cliente}, Asaas ${atual.asaas_parcelamento_id || atual.asaas_pagamento_id}): ${e.message}`);
        return false;
      }
    }
  } else {
    const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
    if (!org) return false;
    const c = json(atual.cadastro_json, {});
    if (c.cliente_asaas) db.prepare("UPDATE orgs SET asaas_customer_id = COALESCE(asaas_customer_id, ?) WHERE id = ?").run(c.cliente_asaas, orgId);
  }
  const ok = confirmarProposta(atual, { orgId, cobrancaId: atual.asaas_parcelamento_id || atual.asaas_pagamento_id,
    valor: valor != null ? valor : atual.total, quando });
  if (ok) {
    db.prepare("UPDATE propostas SET cadastro_json = NULL WHERE id = ?").run(atual.id);   // a senha não fica guardada à toa
    if (atual.org_id) await cancelarRecorrentesExceto(atual.org_id);
  }
  return ok;
}

/* Conta existente que paga a proposta pelo Asaas: a assinatura recorrente
   antiga sai, como no Pagar.me. */
async function cancelarRecorrentesExceto(orgId) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  if (org) await cancelarRecorrentes(org);
}

/* A segunda chance além do webhook: a página pergunta ao Asaas enquanto a
   pessoa paga na outra aba. Uma pergunta a cada 5s por proposta. */
const ultimaConferencia = new Map();
export async function conferirAsaas(p) {
  if (!p || p.status !== "aguardando" || !p.asaas_pagamento_id) return false;
  const agora = Date.now();
  if (agora - (ultimaConferencia.get(p.id) || 0) < 5000) return false;
  ultimaConferencia.set(p.id, agora);
  try {
    const pg = await asaas.lerPagamento(p.asaas_pagamento_id);
    if (pg && PAGO_ASAAS.has(pg.status)) return await confirmarAsaas(p);
    if (pg && pg.deleted) faturaAsaasCaiu(p);
  } catch (e) { console.warn(`[proposta] conferir no Asaas: ${e.message}`); }
  return false;
}
