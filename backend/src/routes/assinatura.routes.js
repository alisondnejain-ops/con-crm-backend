import { Router } from "express";
import db from "../db.js";
import { authRequired, roles, semMaster } from "../auth.js";
import { situacao, registrarPagamento, marcarAtraso, AVISO_ANTES,
  ehDono, donoDa, listarPagamentos, apagarPagamento, editarPagamento, recalcularVencimento } from "../services/assinatura.js";
import { asaasConfigurado, ambienteAsaas, criarCliente, criarAssinatura, interpretarEvento, TOKEN_WEBHOOK } from "../services/asaas.js";

const r = Router();

/* Webhook do Asaas. Fica FORA do login (quem chama é o Asaas, não uma pessoa)
   e fora do porteiro — se a conta está bloqueada, é justamente este aviso que
   vai desbloquear.

   A autenticação é o token que o Asaas manda no cabeçalho, configurado por
   você lá no painel. Sem conferir isso, qualquer um poderia chamar esta rota
   dizendo que a mensalidade foi paga. */
r.post("/webhooks/asaas", (req, res) => {
  if (TOKEN_WEBHOOK && req.get("asaas-access-token") !== TOKEN_WEBHOOK) {
    console.warn("[asaas] webhook recusado: token não confere");
    return res.sendStatus(401);
  }
  // Responde já: o Asaas reenvia o evento se demorarmos a confirmar.
  res.sendStatus(200);

  try {
    const { acao, link, assinatura } = interpretarEvento(req.body || {});
    if (acao === "ignorar") return;

    // Com uma imobiliária só, o evento é dela. Quando abrir para várias, a
    // busca passa a ser pelo asaas_subscription_id — por isso ele já é gravado.
    const org = assinatura
      ? db.prepare("SELECT * FROM orgs WHERE asaas_subscription_id = ?").get(assinatura)
      : null;
    const alvo = org || db.prepare("SELECT * FROM orgs LIMIT 1").get();
    if (!alvo) return;

    if (acao === "pago") {
      const proximo = registrarPagamento(alvo.id, { link: null, valor: req.body?.payment?.value,
        origem: "asaas", asaasId: req.body?.payment?.id || null });
      console.log(`[asaas] pagamento confirmado — próximo vencimento ${new Date(proximo).toLocaleDateString("pt-BR")}`);
    } else if (acao === "atrasado") {
      marcarAtraso(alvo.id, link);
      console.log("[asaas] cobrança em atraso registrada");
    } else if (acao === "cancelado") {
      db.prepare("UPDATE orgs SET assinatura_status = 'cancelado' WHERE id = ?").run(alvo.id);
      console.log("[asaas] assinatura cancelada");
    }
  } catch (e) {
    console.error("[asaas] erro ao processar webhook:", e.message);
  }
});

/* CUIDADO: este roteador é montado na raiz ("/"), então um `r.use(authRequired)`
   aqui passaria a exigir login em TODA requisição do sistema — inclusive na
   própria tela de login. Foi o que aconteceu na primeira versão: tudo virou 401.
   Por isso o login é exigido rota a rota, daqui para baixo. */

/* Trava do dono. Papel 'adm' abre o CRM inteiro, mas a mensalidade é de quem
   paga: outro gestor não vê valor, histórico nem dados de cobrança, e não
   mexe em nada disso. Por isso não basta roles("adm") aqui. */
const soDono = (req, res, next) => ehDono(req.user.org_id, req.user.id)
  ? next()
  : res.status(403).json({ error: "A mensalidade é visível apenas para o titular da conta." });

/* Data que veio de um <input type="date"> ("2026-08-10"). O meio-dia evita o
   clássico: interpretada como UTC, ela vira o dia ANTERIOR em Recife. */
const dataDoFormulario = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T12:00:00" : s).getTime();
};

// Situação da assinatura. Todo mundo consulta: é o que desenha a tarja de
// aviso e a tela de bloqueio, e o corretor precisa saber por que parou.
// Quem não é o dono recebe só o estado — sem valor, plano ou link.
r.get("/assinatura", authRequired, (req, res) => {
  const dono = ehDono(req.user.org_id, req.user.id);
  const s = situacao(req.user.org_id, { dono });
  res.json({ ...s, aviso_antes: AVISO_ANTES,
    asaas: dono ? asaasConfigurado() : undefined, ambiente: dono ? ambienteAsaas() : undefined });
});

// Histórico de pagamentos — a lista que dá para conferir, corrigir e apagar.
r.get("/assinatura/pagamentos", authRequired, soDono, (req, res) => {
  res.json({ pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

// Configuração do plano.
r.patch("/assinatura", authRequired, soDono, (req, res) => {
  const { plano, valor_mensal, vence_em, dias_carencia } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const data = vence_em ? dataDoFormulario(vence_em) : org.vence_em;
  if (vence_em && !isFinite(data)) return res.status(400).json({ error: "Data de vencimento inválida." });

  /* Mexer no vencimento aqui é dizer "a data em vigor é esta". Como o vencimento
     é calculado a partir da base mais um mês por pagamento, a base tem que
     recuar o mesmo tanto — senão o próximo recálculo desfaria a correção. */
  const { n } = db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(org.id);
  let base = org.vence_base;
  if (data) { const d = new Date(data); d.setMonth(d.getMonth() - n); base = d.getTime(); }

  db.prepare(`UPDATE orgs SET plano = ?, valor_mensal = ?, vence_em = ?, vence_base = ?, dias_carencia = ? WHERE id = ?`).run(
    (plano || org.plano || "").trim() || null,
    valor_mensal != null && valor_mensal !== "" ? Number(valor_mensal) : org.valor_mensal,
    data || null, base || null,
    dias_carencia != null ? Math.max(0, Number(dias_carencia)) : org.dias_carencia,
    org.id);
  res.json(situacao(org.id));
});

/* Baixa manual. Continua existindo mesmo com o Asaas ligado: pagamento por
   fora, cortesia, acerto combinado — e, principalmente, para você destravar o
   cliente na hora se o webhook falhar. Depender só do automático é ficar refém
   dele num dia ruim.

   Aceita data e valor: dá para lançar pagamento retroativo e acertar meses que
   ficaram para trás, sem precisar mexer no vencimento na mão. */
r.post("/assinatura/pagar", authRequired, soDono, (req, res) => {
  const { pago_em, valor, obs } = req.body || {};
  const quando = pago_em ? dataDoFormulario(pago_em) : Date.now();
  if (pago_em && !isFinite(quando)) return res.status(400).json({ error: "Data do pagamento inválida." });
  const proximo = registrarPagamento(req.user.org_id, { quando, valor, obs: obs || null });
  res.json({ ok: true, proximo_vencimento: proximo, pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

// Apaga um pagamento lançado por engano — o vencimento volta um mês sozinho.
r.delete("/assinatura/pagamentos/:id", authRequired, soDono, (req, res) => {
  const r1 = apagarPagamento(req.user.org_id, req.params.id);
  if (!r1.ok) return res.status(404).json(r1);
  res.json({ ok: true, pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

// Corrige data ou valor de um pagamento já lançado.
r.patch("/assinatura/pagamentos/:id", authRequired, soDono, (req, res) => {
  const { pago_em, valor, obs } = req.body || {};
  const quando = pago_em ? dataDoFormulario(pago_em) : undefined;
  if (pago_em && !isFinite(quando)) return res.status(400).json({ error: "Data do pagamento inválida." });
  const r1 = editarPagamento(req.user.org_id, req.params.id, { pago_em: quando, valor, obs });
  if (!r1.ok) return res.status(404).json(r1);
  res.json({ ok: true, pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

/* Recalcula o vencimento a partir da base e dos pagamentos. É o "reorganizar":
   se a data ficou torta por lançamento antigo ou webhook repetido, isto põe
   tudo de volta na régua sem precisar apagar nada. */
r.post("/assinatura/reorganizar", authRequired, soDono, (req, res) => {
  recalcularVencimento(req.user.org_id);
  res.json({ ok: true, pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

// Passa a titularidade para outro gestor. Só o dono atual pode fazer isso.
r.post("/assinatura/dono", authRequired, soDono, (req, res) => {
  const { user_id } = req.body || {};
  const alvo = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role = 'adm'").get(user_id, req.user.org_id);
  if (!alvo) return res.status(400).json({ error: "Escolha um gestor ativo da equipe." });
  db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(alvo.id, req.user.org_id);
  res.json({ ok: true, dono_user_id: alvo.id, dono_nome: alvo.name });
});

// Quem são os gestores, para a troca de titularidade.
r.get("/assinatura/gestores", authRequired, soDono, (req, res) => {
  res.json({
    dono_user_id: donoDa(req.user.org_id),
    gestores: db.prepare(`SELECT u.id,u.name,u.email FROM users u WHERE u.org_id = ? AND u.role = 'adm' AND u.status = 'ativo'${semMaster("u")} ORDER BY u.name`).all(req.user.org_id),
  });
});

// Cria cliente e assinatura no Asaas a partir dos dados da imobiliária.
r.post("/assinatura/asaas", authRequired, soDono, async (req, res) => {
  if (!asaasConfigurado()) return res.status(503).json({ error: "Asaas não configurado no servidor (ASAAS_API_KEY)." });
  const { nome, cpfCnpj, email, telefone, valor, vencimento } = req.body || {};
  if (!nome || !cpfCnpj || !email) return res.status(400).json({ error: "Informe nome, CPF/CNPJ e e-mail do responsável." });
  if (!Number(valor)) return res.status(400).json({ error: "Informe o valor da mensalidade." });

  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  try {
    let clienteId = org.asaas_customer_id;
    if (!clienteId) {
      const cliente = await criarCliente({ nome, cpfCnpj: String(cpfCnpj).replace(/\D/g, ""), email, telefone });
      clienteId = cliente.id;
    }
    const venc = vencimento || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const assinatura = await criarAssinatura({
      clienteId, valor: Number(valor), vencimento: venc,
      descricao: `ConHub — ${org.name}`,
    });
    db.prepare(`UPDATE orgs SET asaas_customer_id = ?, asaas_subscription_id = ?, valor_mensal = ?, vence_em = ?, vence_base = ?
                WHERE id = ?`).run(clienteId, assinatura.id, Number(valor), dataDoFormulario(venc), dataDoFormulario(venc), org.id);
    res.json({ ok: true, assinatura: assinatura.id, ...situacao(org.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

export default r;
