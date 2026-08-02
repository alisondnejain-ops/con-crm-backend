import { Router } from "express";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";
import { situacao, registrarPagamento, marcarAtraso, AVISO_ANTES } from "../services/assinatura.js";
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
      const proximo = registrarPagamento(alvo.id, { link: null });
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

// Situação da assinatura. Todo mundo consulta: é o que desenha a tarja de
// aviso e a tela de bloqueio, e o corretor precisa saber por que parou.
r.get("/assinatura", authRequired, (req, res) => {
  const s = situacao(req.user.org_id);
  res.json({ ...s, aviso_antes: AVISO_ANTES, asaas: asaasConfigurado(), ambiente: ambienteAsaas() });
});

// Configuração do plano — só o gestor.
r.patch("/assinatura", authRequired, roles("adm"), (req, res) => {
  const { plano, valor_mensal, vence_em, dias_carencia } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const data = vence_em ? new Date(vence_em).getTime() : org.vence_em;
  if (vence_em && !isFinite(data)) return res.status(400).json({ error: "Data de vencimento inválida." });
  db.prepare(`UPDATE orgs SET plano = ?, valor_mensal = ?, vence_em = ?, dias_carencia = ? WHERE id = ?`).run(
    (plano || org.plano || "").trim() || null,
    valor_mensal != null ? Number(valor_mensal) : org.valor_mensal,
    data || null,
    dias_carencia != null ? Math.max(0, Number(dias_carencia)) : org.dias_carencia,
    org.id);
  res.json(situacao(org.id));
});

/* Baixa manual. Continua existindo mesmo com o Asaas ligado: pagamento por
   fora, cortesia, acerto combinado — e, principalmente, para você destravar o
   cliente na hora se o webhook falhar. Depender só do automático é ficar refém
   dele num dia ruim. */
r.post("/assinatura/pagar", authRequired, roles("adm"), (req, res) => {
  const proximo = registrarPagamento(req.user.org_id);
  res.json({ ok: true, proximo_vencimento: proximo, ...situacao(req.user.org_id) });
});

// Cria cliente e assinatura no Asaas a partir dos dados da imobiliária.
r.post("/assinatura/asaas", authRequired, roles("adm"), async (req, res) => {
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
    db.prepare(`UPDATE orgs SET asaas_customer_id = ?, asaas_subscription_id = ?, valor_mensal = ?, vence_em = ?
                WHERE id = ?`).run(clienteId, assinatura.id, Number(valor), new Date(venc + "T12:00:00").getTime(), org.id);
    res.json({ ok: true, assinatura: assinatura.id, ...situacao(org.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

export default r;
