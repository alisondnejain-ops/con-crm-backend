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
    /* Sem o id da assinatura, só dá para adivinhar quando existe UMA
       imobiliária. Com várias, creditar o pagamento na primeira da lista
       liberaria a conta errada e deixaria quem pagou bloqueado. */
    const total = db.prepare("SELECT COUNT(*) n FROM orgs").get().n;
    const alvo = org || (total === 1 ? db.prepare("SELECT * FROM orgs LIMIT 1").get() : null);
    if (!alvo) {
      console.warn("[asaas] evento sem assinatura reconhecida e mais de uma imobiliária — ignorado.");
      return;
    }

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
  /* `valor_mensal` vem separado do `valor` da situação, e é de propósito.

     A situação só carrega valor quando existe cobrança em curso — conta sem
     vencimento nenhum devolve `{status:"ativo"}` e mais nada. Só que é
     exatamente essa a conta que precisa ATIVAR a assinatura, e a tela tem que
     mostrar o preço combinado antes de existir a primeira fatura. Sem este
     campo, o cliente com plano definido via "o valor ainda não foi definido". */
  const preco = dono
    ? db.prepare("SELECT valor_mensal FROM orgs WHERE id = ?").get(req.user.org_id)?.valor_mensal
    : undefined;
  res.json({ ...s, aviso_antes: AVISO_ANTES, valor_mensal: preco ?? undefined,
    asaas: dono ? asaasConfigurado() : undefined, ambiente: dono ? ambienteAsaas() : undefined });
});

// Histórico de pagamentos — a lista que dá para conferir, corrigir e apagar.
r.get("/assinatura/pagamentos", authRequired, soDono, (req, res) => {
  res.json({ pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

/* Configuração do plano.

   PREÇO, VENCIMENTO E CARÊNCIA SÃO DE QUEM VENDE, não de quem paga.

   A rota é `soDono`, e o dono da conta é o próprio cliente — então até aqui ele
   podia baixar a própria mensalidade para R$ 1 e ativar a cobrança com esse
   valor. O buraco não estava na tela de ativar: estava aqui, um passo antes.

   Agora quem não é master só consegue mexer no NOME do plano, que é rótulo. O
   que vira dinheiro fica com o ConHub. */
r.patch("/assinatura", authRequired, soDono, (req, res) => {
  const { plano, valor_mensal, vence_em, dias_carencia } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const souMaster = !!db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id)?.master;
  if (!souMaster && (valor_mensal != null && valor_mensal !== "" || vence_em || dias_carencia != null))
    return res.status(403).json({
      error: "Valor, vencimento e carência são definidos pelo ConHub. Fale com a gente para mudar o seu plano." });
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
/* ATIVAR A COBRANÇA AUTOMÁTICA — e quem preenche o quê.

   O cliente ativa a PRÓPRIA assinatura, dentro do CRM dele. Antes esta rota
   exigia nome, e-mail e telefone digitados na mão, e o ConHub acabava
   preenchendo dados do cliente por ele — que é justamente o que não escala:
   cada conta nova vira uma digitação sua.

   Agora o que o CRM já sabe, ele usa: nome, e-mail e telefone saem da conta do
   titular. Sobra UM campo para o cliente, o CPF ou CNPJ, que é o único dado
   que o sistema não tem e que o Asaas exige para emitir cobrança.

   E O VALOR NÃO VEM MAIS DO FORMULÁRIO DO CLIENTE.

   Vinha, e era um furo: quem ativasse a própria assinatura escolheria quanto
   paga. O preço é combinado fora do CRM e gravado por quem vende — o master,
   pelo painel ou na criação da conta. O cliente vê o valor e confirma; não o
   digita. Master continua podendo mandar o valor no corpo, porque é ele quem
   está configurando a conta. */
r.post("/assinatura/asaas", authRequired, soDono, async (req, res) => {
  if (!asaasConfigurado()) return res.status(503).json({ error: "Asaas não configurado no servidor (ASAAS_API_KEY)." });
  const { cpfCnpj, vencimento } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const eu = db.prepare("SELECT name,email,phone FROM users WHERE id = ?").get(req.user.id);
  const dono = org.dono_user_id
    ? db.prepare("SELECT name,email,phone FROM users WHERE id = ?").get(org.dono_user_id) : null;
  // O titular da conta é quem responde pela cobrança; o master só a configura.
  const responsavel = dono || eu;

  const nome = String(req.body?.nome || responsavel.name || "").trim();
  const email = String(req.body?.email || responsavel.email || "").trim();
  const telefone = String(req.body?.telefone || responsavel.phone || "").trim();
  if (!cpfCnpj) return res.status(400).json({ error: "Informe o CPF ou CNPJ de quem vai receber a cobrança." });
  if (!nome || !email) return res.status(400).json({ error: "A conta está sem nome ou e-mail. Ajuste em Minha conta e tente de novo." });

  /* O valor é o que está gravado na conta. Só o master pode defini-lo aqui —
     para o cliente, mandar `valor` no corpo não muda nada. */
  const souMaster = !!db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id)?.master;
  const valor = souMaster && Number(req.body?.valor) ? Number(req.body.valor) : Number(org.valor_mensal);
  if (!valor)
    return res.status(400).json({
      error: "O valor da mensalidade ainda não foi definido para esta conta. Fale com o ConHub para combinar o plano." });

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
