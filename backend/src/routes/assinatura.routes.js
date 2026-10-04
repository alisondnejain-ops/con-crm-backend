import { Router } from "express";
import db from "../db.js";
import { authRequired, roles, semMaster } from "../auth.js";
import { segredoConfere } from "../seguranca.js";
import { limites as limitesDeCanais } from "../services/canais.js";
import { situacao, registrarPagamento, marcarAtraso, AVISO_ANTES,
  ehDono, donoDa, listarPagamentos, apagarPagamento, editarPagamento, recalcularVencimento, somaMeses, TRIAL_DIAS } from "../services/assinatura.js";
import { asaasConfigurado, ambienteAsaas, criarCliente, criarAssinatura, criarParcelado,
  linkDaPrimeiraFatura, cancelarAssinatura, interpretarEvento, cartaoRegistrado, TOKEN_WEBHOOK } from "../services/asaas.js";
import { planosParaTela, planoPorId, planoDaFamilia, planosDe, mesesPagos } from "../services/planos.js";
import { RECURSOS, ehRecurso, recursosDaOrg, situacaoDoRecurso, registrarContratacao, avulsoDaAssinatura,
  avulsoPago, avulsoCancelado } from "../services/recursos.js";
import { cobrancasDaAssinatura } from "../services/asaas.js";
import * as pagarme from "../services/pagarme.js";
import { provedorDe } from "../services/cobranca.js";

const r = Router();

/* Webhook do Asaas. Fica FORA do login (quem chama é o Asaas, não uma pessoa)
   e fora do porteiro — se a conta está bloqueada, é justamente este aviso que
   vai desbloquear.

   A autenticação é o token que o Asaas manda no cabeçalho, configurado por
   você lá no painel. Sem conferir isso, qualquer um poderia chamar esta rota
   dizendo que a mensalidade foi paga. */
/* ===== A TRAVA ERA "SE HOUVER TOKEN" — E AGORA É "SÓ COM TOKEN" (02/09/2026)

   Estava escrito `if (TOKEN_WEBHOOK && ...)`. Leia devagar: quando a variável
   `ASAAS_WEBHOOK_TOKEN` NÃO estava configurada, a condição inteira era falsa e
   a conferência era PULADA. Ou seja, a proteção existia exatamente enquanto
   alguém tivesse se lembrado de ligá-la, e sumia em silêncio quando não.

   O que isso permitia: qualquer pessoa da internet mandar um POST dizendo
   "pagamento recebido" e ganhar mês de mensalidade — na própria conta ou na
   de qualquer cliente. Um CRM pago, liberado por uma requisição sem senha.

   Trava que falha ABERTA é o pior tipo, porque nada quebra: o sistema continua
   funcionando, ninguém procura o problema, e a única evidência é a receita que
   não entra. Agora ela falha FECHADA — sem token configurado, o webhook recusa
   e explica o que fazer. O custo de errar para o lado seguro é o pagamento
   demorar a aparecer no CRM, que o "Verificar de novo" da tela já resolve.

   E a comparação é `segredoConfere`, que compara o texto inteiro sempre: `!==`
   para no primeiro caractere diferente, e o tempo que ele leva conta quantos
   caracteres iniciais estavam certos — para quem pode tentar à vontade e
   medir, isso é uma pista de verdade. */
r.post("/webhooks/asaas", async (req, res) => {
  if (!TOKEN_WEBHOOK) {
    console.warn("[asaas] webhook RECUSADO: a variável ASAAS_WEBHOOK_TOKEN não está configurada no servidor. " +
      "Sem ela, qualquer pessoa poderia avisar 'pagamento recebido' e liberar uma conta. " +
      "Crie a variável no painel da hospedagem com o mesmo valor que está no painel do Asaas.");
    return res.sendStatus(503);
  }
  if (!segredoConfere(req.get("asaas-access-token"), TOKEN_WEBHOOK)) {
    console.warn("[asaas] webhook recusado: token não confere");
    return res.sendStatus(401);
  }
  // Responde já: o Asaas reenvia o evento se demorarmos a confirmar.
  res.sendStatus(200);

  try {
    const { acao, link, assinatura, pagamento } = interpretarEvento(req.body || {});

    /* FERRAMENTA AVULSA (29/09/2026). A assinatura da ferramenta é OUTRA,
       separada da mensalidade — e tem que ser separada aqui também, ANTES da
       busca pela org: sem isto, os R$ 97 do Autoatendimento avulso entrariam
       como mês pago de plano (numa instalação de uma conta só, o consolo de
       "imobiliária única" credita o pagamento nela). */
    const avulso = avulsoDaAssinatura(assinatura);
    if (avulso) {
      if (acao === "pago") {
        if (avulsoPago(avulso, pagamento)) console.log(`[asaas] ferramenta ${avulso.recurso} paga (${avulso.org_id})`);
      } else if (acao === "cancelado") {
        const estorno = ["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"].includes(req.body?.event);
        avulsoCancelado(avulso, { estorno });
        console.log(`[asaas] ferramenta ${avulso.recurso} ${estorno ? "estornada" : "cancelada"} (${avulso.org_id})`);
      }
      return;
    }

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
      if (acao !== "ignorar") console.warn("[asaas] evento sem assinatura reconhecida e mais de uma imobiliária — ignorado.");
      return;
    }

    /* CARTÃO OBRIGATÓRIO (22/09/2026): tenta confirmar em QUALQUER evento
       desta assinatura, não só "pago" — não dá para saber ao certo qual
       nome de evento a Asaas manda quando alguém anexa um cartão a uma
       fatura com vencimento futuro (sem cobrar nada ainda), então em vez de
       apostar num nome, a checagem roda sempre que a assinatura dá
       qualquer sinal de vida. Barato quando não há nada para confirmar —
       `tentarConfirmarCartao` sai na hora se o cartão já estava confirmado
       ou se a conta não é do tipo que exige. */
    await tentarConfirmarCartao(alvo);

    if (acao === "ignorar") return;

    if (acao === "pago") {
      /* Quantos meses esta cobrança comprou. No plano mensal é um; no
         semestral, seis de uma vez; no anual, um por parcela — e são doze
         parcelas. Creditar sempre um mês bloquearia quem acabou de pagar meio
         ano. Sem plano (toda imobiliária) continua sendo um. */
      const pago = req.body?.payment?.value;
      const proximo = registrarPagamento(alvo.id, { link: null, valor: pago,
        origem: "asaas", asaasId: req.body?.payment?.id || null,
        meses: mesesPagos(alvo.plano_id, pago) });
      console.log(`[asaas] pagamento confirmado — próximo vencimento ${new Date(proximo).toLocaleDateString("pt-BR")}`);
    } else if (acao === "atrasado") {
      marcarAtraso(alvo.id, link);
      console.log("[asaas] cobrança em atraso registrada");
    } else if (acao === "cancelado") {
      // Cancelada pelo próprio cliente (Minha conta): o acesso vai até o fim
      // do que foi pago, e quem decide isso é `cancelado_em`, não este aviso.
      if (alvo.cancelado_em) return;
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

/* TENTA CONFIRMAR O CARTÃO ANTES DE RESPONDER A SITUAÇÃO (22/09/2026).

   `situacao()` só lê o BANCO — é rápida e síncrona, e continua sendo, porque
   dezenas de chamadas (o porteiro de toda rota, o resumo do hub) dependem
   dela ser barata. A checagem de verdade contra o Asaas é ASSÍNCRONA e faz
   uma chamada de rede, então mora aqui na rota, não lá dentro.

   Só vale a pena tentar quando o banco ainda diz "aguardando cartão": para
   qualquer outro estado, chamar o Asaas a cada carregamento de tela seria
   gasto à toa. E nunca lança — se o Asaas estiver fora do ar ou a chamada
   falhar por qualquer motivo, a pessoa continua vendo "aguardando cartão" e
   tenta de novo pelo botão "Verificar de novo"; a tela não pode quebrar por
   causa de uma checagem que é só uma segunda chance além do webhook. */
async function tentarConfirmarCartao(org) {
  if (!org || !org.exige_cartao || org.cartao_confirmado_em || !org.asaas_subscription_id) return;
  try {
    if (await cartaoRegistrado(org.asaas_subscription_id)) {
      const agora = Date.now();
      db.prepare("UPDATE orgs SET cartao_confirmado_em = ?, trial_ate = ? WHERE id = ?")
        .run(agora, agora + TRIAL_DIAS * 86400000, org.id);
      console.log(`[asaas] cartão confirmado para "${org.name}" — teste de ${TRIAL_DIAS} dias começou agora`);
    }
  } catch (e) {
    console.warn(`[asaas] não consegui confirmar o cartão de "${org.name}": ${e.message}`);
  }
}

// Situação da assinatura. Todo mundo consulta: é o que desenha a tarja de
// aviso e a tela de bloqueio, e o corretor precisa saber por que parou.
// Quem não é o dono recebe só o estado — sem valor, plano ou link.
r.get("/assinatura", authRequired, async (req, res) => {
  const dono = ehDono(req.user.org_id, req.user.id);
  const orgAtual = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  if (orgAtual && orgAtual.exige_cartao && !orgAtual.cartao_confirmado_em)
    await tentarConfirmarCartao(orgAtual);
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
  /* AS LINHAS DE WHATSAPP ENTRAM NA CONTA, e aparecem separadas da
     mensalidade. Somadas num número só, o gestor que ligasse três números
     veria a mensalidade "subir" sem saber por quê — e é dele a decisão de
     ligar cada uma. Separado, a fatura se explica sozinha. */
  res.json({ ...s, aviso_antes: AVISO_ANTES, valor_mensal: preco ?? undefined,
    canais: limitesDeCanais(req.user.org_id),
    asaas: dono ? asaasConfigurado() : undefined, ambiente: dono ? ambienteAsaas() : undefined,
    /* A CONTA TEM CLIENTE NO ASAAS? (22/09/2026, "tudo está sendo feito pelo
       Asaas" — pedido do Ali para tirar o painel manual de quem já está lá.)

       `asaas_customer_id`, não `asaas_subscription_id`: o plano ANUAL é
       parcelado (`/payments`), não assinatura, e nunca grava uma
       `asaas_subscription_id` — só o cliente. Usar a assinatura deixaria
       quem escolheu o anual com o painel manual de volta, exatamente o
       cliente que menos precisa dele. `asaas_customer_id` é gravado nos três
       caminhos que criam cobrança de verdade (mensal, semestral e anual de
       prateleira, e a ativação por CPF da imobiliária negociada) — é o sinal
       que sobrevive aos três. */
    asaas_ligado: dono ? !!orgAtual.asaas_customer_id : undefined,
    /* QUAL PROVEDOR COBRA ESTA CONTA (04/10/2026). É o que decide se a tela
       abre a fatura do Asaas ou o formulário de cartão do ConHub. */
    provedor: dono ? provedorDe(orgAtual) : undefined,
    cancelamento: dono ? cancelamentoParaTela(orgAtual) : undefined,
    pagarme: dono && provedorDe(orgAtual) === "pagarme" ? dadosDoPagarme(orgAtual) : undefined });
});

/* O que a tela precisa para cobrar pelo Pagar.me: a chave PÚBLICA (só cria
   token de cartão), o cartão guardado (bandeira e final) e se ainda falta o
   CPF/CNPJ — que só é pedido na primeira vez. */
function dadosDoPagarme(org) {
  let cartao = null;
  try { cartao = org.pagarme_card_json ? JSON.parse(org.pagarme_card_json) : null; } catch {}
  return {
    configurado: pagarme.pagarmeConfigurado(), ambiente: pagarme.ambientePagarme(),
    chave_publica: pagarme.CHAVE_PUBLICA() || null,
    cartao: org.pagarme_card_id ? cartao : null,
    pede_cpf: !org.pagarme_customer_id,
    /* A mensalidade COMBINADA (preço negociado, sem plano da tabela): o valor
       e quando cairia a primeira cobrança, para a tela dizer antes do botão. */
    combinada: !org.plano_id && Number(org.valor_mensal) > 0 ? {
      valor: Number(org.valor_mensal),
      ligada: !!org.pagarme_subscription_id,
      primeira_cobranca: inicioDaCombinada(org),
    } : null,
  };
}

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
  const { plano, valor_mensal, vence_em, dias_carencia, limite_canais, canais_incluidos, valor_canal } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const souMaster = !!db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id)?.master;
  /* O TETO DE LINHAS E O PREÇO DE CADA UMA SÃO DO CONHUB, pelo mesmo motivo
     que o valor da mensalidade: esta rota é `soDono`, e num cliente o dono é o
     próprio cliente. Sem esta trava, o gestor gravaria `limite_canais = 99` e
     `valor_canal = 0` e ligaria noventa e nove números de graça — que é o
     furo do preço de 27/08/2026 aparecendo num campo novo. */
  const soDoConHub = valor_mensal != null && valor_mensal !== "" || vence_em || dias_carencia != null
    || limite_canais != null || canais_incluidos != null || valor_canal != null;
  if (!souMaster && soDoConHub)
    return res.status(403).json({
      error: "Valor, vencimento, carência e os números de WhatsApp do plano são definidos pelo ConHub. Fale com a gente para mudar o seu plano." });
  const data = vence_em ? dataDoFormulario(vence_em) : org.vence_em;
  if (vence_em && !isFinite(data)) return res.status(400).json({ error: "Data de vencimento inválida." });

  /* Mexer no vencimento aqui é dizer "a data em vigor é esta". Como o vencimento
     é calculado a partir da base mais um mês por pagamento, a base tem que
     recuar o mesmo tanto — senão o próximo recálculo desfaria a correção. */
  const { n } = db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(org.id);
  let base = org.vence_base;
  if (data) { const d = new Date(data); d.setMonth(d.getMonth() - n); base = d.getTime(); }

  db.prepare(`UPDATE orgs SET plano = ?, valor_mensal = ?, vence_em = ?, vence_base = ?, dias_carencia = ?,
      limite_canais = ?, canais_incluidos = ?, valor_canal = ? WHERE id = ?`).run(
    (plano || org.plano || "").trim() || null,
    valor_mensal != null && valor_mensal !== "" ? Number(valor_mensal) : org.valor_mensal,
    data || null, base || null,
    dias_carencia != null ? Math.max(0, Number(dias_carencia)) : org.dias_carencia,
    limite_canais != null && limite_canais !== "" ? Math.max(1, Number(limite_canais)) : org.limite_canais,
    canais_incluidos != null && canais_incluidos !== "" ? Math.max(0, Number(canais_incluidos)) : org.canais_incluidos,
    valor_canal != null && valor_canal !== "" ? Math.max(0, Number(valor_canal)) : org.valor_canal,
    org.id);
  res.json({ ...situacao(org.id), canais: limitesDeCanais(org.id) });
});

/* DAR BAIXA É DE QUEM RECEBE, NÃO DE QUEM PAGA.

   Estas quatro rotas mexem no vencimento, e todas eram `soDono`. Só que o dono
   da conta, num cliente, é o próprio cliente — então ele clicava em "Registrar
   pagamento" e ganhava um mês, quantas vezes quisesse. Bloqueado, o mesmo
   clique destravava a conta. Era o preço de 27/08/2026 outra vez, num botão
   diferente: a régua de "o que vira dinheiro é do ConHub" não tinha alcançado
   a baixa manual, o apagar, o corrigir e o reorganizar.

   `soDono` continua na frente por causa da privacidade — outro gestor da casa
   não vê o que se paga aqui —, e o master passa por ele desde sempre, porque
   `ehDono` responde sim para quem cobra de todo mundo. */
const soCobranca = (req, res, next) => {
  const eu = db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id);
  if (eu && eu.master) return next();
  res.status(403).json({
    error: "Só o ConHub registra e corrige pagamento. O seu acesso é liberado sozinho assim que a cobrança é confirmada." });
};

/* Baixa manual. Continua existindo mesmo com o Asaas ligado: pagamento por
   fora, cortesia, acerto combinado — e, principalmente, para você destravar o
   cliente na hora se o webhook falhar. Depender só do automático é ficar refém
   dele num dia ruim.

   Aceita data e valor: dá para lançar pagamento retroativo e acertar meses que
   ficaram para trás, sem precisar mexer no vencimento na mão. */
r.post("/assinatura/pagar", authRequired, soDono, soCobranca, (req, res) => {
  const { pago_em, valor, obs } = req.body || {};
  const quando = pago_em ? dataDoFormulario(pago_em) : Date.now();
  if (pago_em && !isFinite(quando)) return res.status(400).json({ error: "Data do pagamento inválida." });
  const proximo = registrarPagamento(req.user.org_id, { quando, valor, obs: obs || null });
  res.json({ ok: true, proximo_vencimento: proximo, pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

// Apaga um pagamento lançado por engano — o vencimento volta um mês sozinho.
r.delete("/assinatura/pagamentos/:id", authRequired, soDono, soCobranca, (req, res) => {
  const r1 = apagarPagamento(req.user.org_id, req.params.id);
  if (!r1.ok) return res.status(404).json(r1);
  res.json({ ok: true, pagamentos: listarPagamentos(req.user.org_id), ...situacao(req.user.org_id) });
});

// Corrige data ou valor de um pagamento já lançado.
r.patch("/assinatura/pagamentos/:id", authRequired, soDono, soCobranca, (req, res) => {
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
r.post("/assinatura/reorganizar", authRequired, soDono, soCobranca, (req, res) => {
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
  /* Conta que o master passou para o Pagar.me não ganha cobrança nova no
     Asaas por este caminho — seria cobrança nos dois provedores. */
  if (provedorDe(orgCompleta(req.user.org_id)) === "pagarme")
    return res.status(409).json({ error: "A cobrança desta conta é pelo Pagar.me. Escolha o plano em Gerenciar assinatura ou fale com o ConHub." });
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
    db.prepare(`UPDATE orgs SET asaas_customer_id = ?, asaas_subscription_id = ?, valor_mensal = ?, vence_em = ?, vence_base = ?,
                cancelado_em = NULL WHERE id = ?`).run(clienteId, assinatura.id, Number(valor), dataDoFormulario(venc), dataDoFormulario(venc), org.id);
    res.json({ ok: true, assinatura: assinatura.id, ...situacao(org.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ===== GERENCIAR ASSINATURA — os planos de prateleira =====

   Aqui o preço é público e o cliente se contrata sozinho: escolhe o ciclo,
   digita o CPF/CNPJ e é mandado para a tela do Asaas para pagar. Nada disso
   passa pelo ConHub, que é o ponto — cada conta nova deixa de ser uma
   digitação do Ali.

   ATÉ 02/09/2026 ISTO ERA SÓ DO AUTÔNOMO, e o comentário aqui dizia que a
   imobiliária não entrava porque o preço dela era negociado caso a caso. Isso
   deixou de ser verdade no dia em que o site publicou Essencial e Plus com
   preço na vitrine e um botão de teste ao lado: a partir daí eles são
   prateleira igual, e recusar a contratação aqui deixaria o cliente que
   escolheu Essencial no site sem nenhum caminho para pagar por ele.

   Quem continua de fora é a conta cujo preço foi COMBINADO (a `Rede`, e
   qualquer imobiliária com `valor_mensal` negociado fora da tabela): para ela
   `planosDe` não devolve o plano dela, e mostrar três preços que não são o dela
   seria oferecer um plano que não existe naquele contrato. */
const comPrateleira = (req, res, next) => {
  const org = db.prepare("SELECT tipo FROM orgs WHERE id = ?").get(req.user.org_id);
  if (org && planosDe(org.tipo).length) { req.tipoDaConta = org.tipo; return next(); }
  res.status(404).json({ error: "O seu plano é combinado com o ConHub. Fale com a gente para alterá-lo." });
};

r.get("/assinatura/planos", authRequired, soDono, comPrateleira, (req, res) => {
  const org = db.prepare("SELECT plano_id, plano_escolhido FROM orgs WHERE id = ?").get(req.user.org_id);
  res.json({
    planos: planosParaTela(req.tipoDaConta),
    atual: org.plano_id || null,
    /* O que a pessoa marcou no popup do site, para a tela já vir com ele
       escolhido. Perguntar de novo o que ela respondeu no primeiro clique é
       pequeno, mas é exatamente onde uma contratação se perde: no fim do teste,
       na tela que decide se ela paga ou some. */
    escolhido: org.plano_escolhido || null,
    asaas: asaasConfigurado(), ambiente: ambienteAsaas(),
    provedor: provedorDe(orgCompleta(req.user.org_id)),
    pagarme: provedorDe(orgCompleta(req.user.org_id)) === "pagarme" ? dadosDoPagarme(orgCompleta(req.user.org_id)) : undefined,
  });
});

const orgCompleta = (id) => db.prepare("SELECT * FROM orgs WHERE id = ?").get(id);

/* QUEM PAGA, NO ASAAS — um lugar só para o plano e para a ferramenta avulsa.
   Nome, e-mail e telefone o CRM já tem (são os do titular); o CPF/CNPJ é o
   único dado que falta, e só é pedido na primeira cobrança da conta. */
function titularDaConta(org, userId) {
  const eu = db.prepare("SELECT name,email,phone FROM users WHERE id = ?").get(userId);
  const dono = org.dono_user_id
    ? db.prepare("SELECT name,email,phone FROM users WHERE id = ?").get(org.dono_user_id) : null;
  const r = dono || eu || {};
  return { nome: String(r.name || "").trim(), email: String(r.email || "").trim(), telefone: String(r.phone || "").trim() };
}
/* Devolve a frase da recusa, ou null. Só conta dígito: o cliente digita com
   ponto e traço, e "111.444.777-35" tem 14 caracteres — do tamanho de um
   CNPJ, o que passaria por uma conferência feita no texto cru. */
function conferirDadosDoCliente(org, userId, cpfCnpj) {
  const doc = String(cpfCnpj || "").replace(/\D/g, "");
  if (!org.asaas_customer_id && doc.length !== 11 && doc.length !== 14)
    return "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).";
  const t = titularDaConta(org, userId);
  if (!t.nome || !t.email) return "A sua conta está sem nome ou e-mail. Ajuste em Minha conta e tente de novo.";
  return null;
}
async function clienteDoAsaas(org, userId, cpfCnpj) {
  if (org.asaas_customer_id) return org.asaas_customer_id;
  const t = titularDaConta(org, userId);
  const cliente = await criarCliente({ ...t, cpfCnpj: String(cpfCnpj || "").replace(/\D/g, "") });
  db.prepare("UPDATE orgs SET asaas_customer_id = ? WHERE id = ?").run(cliente.id, org.id);
  return cliente.id;
}

/* Contrata o plano escolhido e devolve o endereço da tela de pagamento.

   O QUE ESTA ROTA NÃO FAZ: receber dados de cartão. O corretor é levado para a
   fatura hospedada pelo Asaas, e é lá que ele digita o cartão. Uma tela nossa
   pedindo número de cartão colocaria o CRM dentro do escopo de PCI-DSS e faria
   o Railway trafegar dado de cartão — muito custo para nenhum ganho, já que a
   tela do Asaas faz a mesma coisa e é a que a bandeira já auditou.

   O VALOR CONTINUA NÃO VINDO DO CLIENTE. Ele manda o `plano_id`; o preço sai
   da tabela do servidor. É a mesma trava de 27/08/2026, que existe porque a
   rota é `soDono` e num cliente o dono é ele mesmo. */
r.post("/assinatura/plano", authRequired, soDono, comPrateleira, async (req, res) => {
  if (provedorDe(orgCompleta(req.user.org_id)) === "pagarme") return contratarPlanoPagarme(req, res);
  if (!asaasConfigurado()) return res.status(503).json({ error: "Asaas não configurado no servidor (ASAAS_API_KEY)." });
  const { plano_id, cpfCnpj } = req.body || {};
  /* O plano tem que existir E ser da família desta conta. As duas perguntas
     juntas: sem a segunda, um autônomo mandaria `essencial-anual` no corpo da
     requisição e o servidor abriria uma cobrança de imobiliária para ele — ou,
     pior, o contrário, que é mais barato e ninguém reclama de pagar menos. */
  const plano = planoDaFamilia(plano_id, req.tipoDaConta);
  if (!plano) return res.status(400).json({ error: "Escolha um dos planos disponíveis." });

  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const recusa = conferirDadosDoCliente(org, req.user.id, cpfCnpj);
  if (recusa) return res.status(400).json({ error: recusa });

  /* O PRIMEIRO VENCIMENTO CAI NO FIM DO TESTE, quando ele ainda está correndo.
     Contratar no terceiro dia de teste não pode custar os onze que sobram —
     seria cobrar por um período já vendido como grátis. Sem teste em curso, a
     primeira cobrança vence em três dias: prazo de Pix e de boleto. */
  const emTeste = org.trial_ate && org.trial_ate > Date.now()
    && !db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(org.id).n;
  const quando = emTeste ? org.trial_ate : Date.now() + 3 * 86400000;
  const venc = new Date(quando - new Date(quando).getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  try {
    const clienteId = await clienteDoAsaas(org, req.user.id, cpfCnpj);

    /* A DESCRIÇÃO É O QUE O CLIENTE LÊ NO CHECKOUT — e depois na fatura do
       cartão, meses depois, quando não lembrar mais o que contratou.

       "ConHub Mensal" não diz o que é nem por quanto tempo. A linha abaixo
       responde as três perguntas que a pessoa faz olhando a cobrança: o que é,
       quanto tempo compra e quanto custa por mês. É o texto mais barato de
       escrever e o que mais evita contestação de cartão. */
    const porMes = plano.mensal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const descricao = plano.meses > 1
      ? `ConHub — Plano ${plano.nome} (${plano.meses} meses · ${porMes}/mês)`
      : `ConHub — Plano ${plano.nome} (${porMes}/mês)`;
    let assinaturaId = null, link = null;

    if (plano.forma === "assinatura") {
      const a = await criarAssinatura({ clienteId, valor: plano.total, vencimento: venc, descricao, ciclo: plano.ciclo });
      assinaturaId = a.id;
      link = await linkDaPrimeiraFatura(a.id);
    } else {
      const p = await criarParcelado({ clienteId, parcelas: plano.parcelas,
        valorParcela: plano.mensal, vencimento: venc, descricao });
      link = p.invoiceUrl || p.bankSlipUrl || null;
    }

    /* A assinatura ANTERIOR é cancelada depois de a nova existir, e a falha
       aqui não derruba a troca: o plano novo já está contratado, e travar por
       causa da limpeza do velho deixaria o corretor sem plano nenhum. Fica no
       log para dar para conferir no painel do Asaas. */
    if (org.asaas_subscription_id && org.asaas_subscription_id !== assinaturaId) {
      try { await cancelarAssinatura(org.asaas_subscription_id); }
      catch (e) { console.warn(`[asaas] plano trocado, mas a assinatura antiga ${org.asaas_subscription_id} não foi cancelada: ${e.message}`); }
    }

    /* `vence_base` também é gravado: o vencimento em vigor é a base mais os
       meses pagos, então sem ela o primeiro pagamento não teria de onde
       contar. */
    const data = dataDoFormulario(venc);
    db.prepare(`UPDATE orgs SET plano_id = ?, plano = ?, valor_mensal = ?, asaas_subscription_id = ?,
                vence_em = ?, vence_base = ?, link_pagamento = ?, assinatura_status = NULL, cancelado_em = NULL WHERE id = ?`)
      .run(plano.id, `ConHub ${plano.nome}`, plano.mensal, assinaturaId, data, data, link, org.id);

    /* Sem `url` a tela não tem para onde mandar o corretor, e ele ficaria com
       um plano contratado e nenhum jeito de pagar. Isso é falha, não detalhe:
       responder ok aqui seria dizer que deu certo o que não deu. */
    if (!link) return res.status(502).json({
      error: "O plano foi criado no Asaas, mas a tela de pagamento não veio. Abra a fatura pelo e-mail que o Asaas enviou, ou fale com o ConHub." });

    res.json({ ok: true, url: link, plano: plano.id, ...situacao(org.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ===== AS FERRAMENTAS DA CONTA (29/09/2026) =====

   O que vem no plano, o que foi contratado avulso e o que o ConHub liberou
   ou retirou — ver services/recursos.js. A tela do dono lista as ferramentas
   e oferece contratar avulso o que o plano não traz. */
const PAGO = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"];

/* Segunda chance além do webhook: a ferramenta contratada e ainda não
   confirmada é conferida no Asaas quando a tela abre. Nunca lança. */
async function conferirAvulsosPendentes(orgId) {
  for (const l of db.prepare(`SELECT * FROM org_recursos WHERE org_id = ? AND avulso_status = 'aguardando'
      AND avulso_sub_id IS NOT NULL AND COALESCE(avulso_provedor, 'asaas') = 'asaas'`).all(orgId)) {
    try {
      const pago = ((await cobrancasDaAssinatura(l.avulso_sub_id))?.data || []).find(c => PAGO.includes(c.status));
      if (pago) avulsoPago(l, pago.id);
    } catch (e) { console.warn(`[asaas] não consegui conferir a ferramenta ${l.recurso}: ${e.message}`); }
  }
}

r.get("/assinatura/recursos", authRequired, soDono, async (req, res) => {
  if (asaasConfigurado()) await conferirAvulsosPendentes(req.user.org_id);
  if (pagarme.pagarmeConfigurado()) await conferirAvulsosPagarme(req.user.org_id);
  const org = orgCompleta(req.user.org_id);
  const provedor = provedorDe(org);
  res.json({ recursos: recursosDaOrg(req.user.org_id), plano: planoPorId(org.plano_id)?.nome || null,
    pede_cpf: provedor === "pagarme" ? !org.pagarme_customer_id : !org.asaas_customer_id,
    asaas: asaasConfigurado(), provedor,
    pagarme: provedor === "pagarme" ? dadosDoPagarme(org) : undefined });
});

/* Contrata a ferramenta avulsa: assinatura MENSAL própria no Asaas, no
   cartão, com a primeira cobrança hoje. O preço sai de RECURSOS — o cliente
   manda só qual ferramenta. */
r.post("/assinatura/recursos/:recurso", authRequired, soDono, async (req, res) => {
  const recurso = req.params.recurso;
  if (!ehRecurso(recurso)) return res.status(404).json({ error: "Ferramenta desconhecida." });
  const pelaPagarme = provedorDe(orgCompleta(req.user.org_id)) === "pagarme";
  if (!pelaPagarme && !asaasConfigurado()) return res.status(503).json({ error: "Asaas não configurado no servidor (ASAAS_API_KEY)." });
  const antes = situacaoDoRecurso(req.user.org_id, recurso);
  if (antes.master === "retirado")
    return res.status(403).json({ error: "Esta ferramenta foi desligada pelo ConHub nesta conta. Fale com a gente." });
  if (antes.ativo)
    return res.status(409).json({ error: antes.origem === "plano" ? "Esta ferramenta já vem no seu plano." : "Esta ferramenta já está ligada na sua conta." });

  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  if (provedorDe(org) === "pagarme") return contratarFerramentaPagarme(req, res, org, recurso);
  const recusa = conferirDadosDoCliente(org, req.user.id, req.body?.cpfCnpj);
  if (recusa) return res.status(400).json({ error: recusa });

  const hoje = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const preco = RECURSOS[recurso].avulso;
  const porMes = preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  try {
    const clienteId = await clienteDoAsaas(org, req.user.id, req.body?.cpfCnpj);
    // Uma contratação por vez: a tentativa anterior que nunca foi paga é
    // cancelada, senão duas faturas da mesma ferramenta ficariam abertas.
    const velha = db.prepare("SELECT avulso_sub_id, avulso_status FROM org_recursos WHERE org_id = ? AND recurso = ?").get(org.id, recurso);
    if (velha?.avulso_sub_id && velha.avulso_status === "aguardando") {
      try { await cancelarAssinatura(velha.avulso_sub_id); }
      catch (e) { console.warn(`[asaas] tentativa anterior da ferramenta ${recurso} não foi cancelada: ${e.message}`); }
    }
    const a = await criarAssinatura({ clienteId, valor: preco, vencimento: hoje, ciclo: "MONTHLY",
      descricao: `ConHub — ${RECURSOS[recurso].nome} (ferramenta avulsa · ${porMes}/mês)` });
    const link = await linkDaPrimeiraFatura(a.id);
    registrarContratacao(org.id, recurso, { assinaturaId: a.id, link });
    console.log(`[asaas] ${req.user.name} contratou ${RECURSOS[recurso].nome} avulso (${org.name})`);
    if (!link) return res.status(502).json({
      error: "A ferramenta foi criada no Asaas, mas a tela de pagamento não veio. Abra a fatura pelo e-mail que o Asaas enviou." });
    res.json({ ok: true, url: link, recurso: situacaoDoRecurso(org.id, recurso) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* Cancela a ferramenta avulsa. O que já foi pago continua valendo até o fim
   do mês pago — cancelar não é estorno. Se o Asaas não confirmar o
   cancelamento, NADA muda aqui: marcar como cancelada uma cobrança que
   continua correndo seria o CRM dizendo uma coisa e o cartão, outra. */
r.delete("/assinatura/recursos/:recurso", authRequired, soDono, async (req, res) => {
  const recurso = req.params.recurso;
  if (!ehRecurso(recurso)) return res.status(404).json({ error: "Ferramenta desconhecida." });
  const l = db.prepare("SELECT * FROM org_recursos WHERE org_id = ? AND recurso = ?").get(req.user.org_id, recurso);
  if (!l?.avulso_sub_id || !["aguardando", "ativo"].includes(l.avulso_status))
    return res.status(404).json({ error: "Esta ferramenta não está contratada avulsa." });
  if (l.avulso_provedor === "pagarme") {
    try { await pagarme.cancelarAssinatura(l.avulso_sub_id); }
    catch (e) { return res.status(502).json({ error: "O Pagar.me não confirmou o cancelamento: " + e.message }); }
  } else {
    try { await cancelarAssinatura(l.avulso_sub_id); }
    catch (e) { return res.status(502).json({ error: "O Asaas não confirmou o cancelamento: " + e.message }); }
  }
  avulsoCancelado(l);
  console.log(`[asaas] ${req.user.name} cancelou ${RECURSOS[recurso].nome} avulso`);
  res.json({ ok: true, recurso: situacaoDoRecurso(req.user.org_id, recurso) });
});

/* ===== COBRANÇA PELO PAGAR.ME (04/10/2026) — ver services/pagarme.js =====

   O que muda em relação ao Asaas é o lugar do cartão: no Asaas a pessoa ia
   para a fatura hospedada e digitava o cartão lá; aqui ela digita DENTRO do
   ConHub, num formulário que manda o número direto do navegador para o
   Pagar.me (com a chave pública) e devolve só um token. É esse token que
   chega a estas rotas — o número do cartão nunca passa pelo nosso servidor.

   Com o cartão guardado no cliente do Pagar.me, plano e ferramenta passam a
   ser UM clique: a cobrança sai no cartão que já está lá. */
const dataISO = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const brl = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function exigePagarme(res) {
  if (pagarme.pagarmeConfigurado()) return false;
  res.status(503).json({ error: "O Pagar.me não está configurado no servidor (PAGARME_SECRET_KEY e PAGARME_PUBLIC_KEY)." });
  return true;
}

async function clienteDoPagarme(org, userId, cpfCnpj) {
  if (org.pagarme_customer_id) return org.pagarme_customer_id;
  const t = titularDaConta(org, userId);
  const c = await pagarme.criarCliente({ nome: t.nome, email: t.email, telefone: t.telefone, documento: cpfCnpj, orgId: org.id });
  db.prepare("UPDATE orgs SET pagarme_customer_id = ? WHERE id = ?").run(c.id, org.id);
  return c.id;
}

/* GUARDA (OU TROCA) O CARTÃO. Não cobra nada: é o passo que dá o "um clique"
   ao resto. Nas contas do site, que exigem cartão para começar o teste, é
   também o que COMEÇA o teste — o mesmo `cartao_confirmado_em` que, no
   Asaas, só chegava depois da fatura. Aqui o cartão é confirmado na hora,
   porque é o próprio Pagar.me que o aceita (ou recusa) ao guardar. */
r.post("/assinatura/cartao", authRequired, soDono, async (req, res) => {
  const org = orgCompleta(req.user.org_id);
  if (provedorDe(org) !== "pagarme") return res.status(409).json({ error: "A cobrança desta conta é pelo Asaas." });
  if (exigePagarme(res)) return;
  const token = String(req.body?.token || "");
  if (!/^token_[A-Za-z0-9]+$/.test(token)) return res.status(400).json({ error: "Os dados do cartão não chegaram. Digite de novo." });
  const doc = String(req.body?.cpfCnpj || "").replace(/\D/g, "");
  if (!org.pagarme_customer_id && doc.length !== 11 && doc.length !== 14)
    return res.status(400).json({ error: "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)." });
  const t = titularDaConta(org, req.user.id);
  if (!t.nome || !t.email) return res.status(400).json({ error: "A sua conta está sem nome ou e-mail. Ajuste em Minha conta e tente de novo." });

  try {
    const clienteId = await clienteDoPagarme(org, req.user.id, doc);
    const cartao = await pagarme.salvarCartao(clienteId, token);
    const resumo = pagarme.resumoDoCartao(cartao);
    const antigo = org.pagarme_card_id;

    /* As assinaturas que já existem passam para o cartão novo — a mensalidade
       e cada ferramenta avulsa. Se alguma não trocar, o cartão velho NÃO é
       apagado: apagar deixaria aquela assinatura sem cartão nenhum. */
    const assinaturas = [org.pagarme_subscription_id,
      ...db.prepare(`SELECT avulso_sub_id FROM org_recursos WHERE org_id = ? AND avulso_provedor = 'pagarme'
          AND avulso_status IN ('aguardando','ativo') AND avulso_sub_id IS NOT NULL`).all(org.id).map(x => x.avulso_sub_id)]
      .filter(Boolean);
    let todasTrocaram = true;
    for (const sub of assinaturas) {
      try { await pagarme.trocarCartaoDaAssinatura(sub, cartao.id); }
      catch (e) { todasTrocaram = false; console.warn(`[pagarme] a assinatura ${sub} não passou para o cartão novo: ${e.message}`); }
    }
    db.prepare("UPDATE orgs SET pagarme_card_id = ?, pagarme_card_json = ? WHERE id = ?")
      .run(cartao.id, JSON.stringify(resumo), org.id);
    if (antigo && antigo !== cartao.id && todasTrocaram) {
      try { await pagarme.apagarCartao(clienteId, antigo); } catch (e) { console.warn(`[pagarme] cartão antigo não apagado: ${e.message}`); }
    }

    if (org.exige_cartao && !org.cartao_confirmado_em) {
      const agora = Date.now();
      db.prepare("UPDATE orgs SET cartao_confirmado_em = ?, trial_ate = ? WHERE id = ?").run(agora, agora + TRIAL_DIAS * 86400000, org.id);
      console.log(`[pagarme] cartão confirmado para "${org.name}" — teste de ${TRIAL_DIAS} dias começou agora`);
    }
    res.json({ ok: true, cartao: resumo,
      aviso: todasTrocaram ? null : "O cartão novo foi guardado, mas uma das assinaturas continuou no cartão antigo. Fale com o ConHub.",
      ...situacao(org.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* A MENSALIDADE COMBINADA NO CARTÃO (04/10/2026, pedido do Ali: "a Conecta
   consiga fazer o cadastro do cartão deles para poder cobrar").

   É a conta com preço negociado (`orgs.valor_mensal`, sem plano da tabela) —
   a Conecta e quem o Ali configurou à mão. O valor é o gravado pelo ConHub,
   nunca o que vem no corpo (a mesma trava de 27/08/2026).

   A PRIMEIRA COBRANÇA CAI NO PRÓXIMO VENCIMENTO, nunca antes dele: quem já
   pagou até o dia 20 não é cobrado hoje por ligar o cartão. Sem vencimento
   futuro gravado (conta em atraso, ou que nunca teve vencimento), a cobrança
   sai hoje — e a tela escreve a data antes do botão, nos dois casos. O
   vencimento e o histórico de pagamentos não são tocados: a conta continua
   contando os meses de onde estava. */
function inicioDaCombinada(org) {
  return org.vence_em && org.vence_em > Date.now() + 86400000 ? org.vence_em : null;
}

r.post("/assinatura/combinada", authRequired, soDono, async (req, res) => {
  const org = orgCompleta(req.user.org_id);
  if (provedorDe(org) !== "pagarme") return res.status(409).json({ error: "A cobrança desta conta é pelo Asaas." });
  if (exigePagarme(res)) return;
  if (org.plano_id) return res.status(409).json({ error: "A sua conta está num plano da tabela. Para mudar, escolha em Gerenciar assinatura." });
  const valor = Number(org.valor_mensal);
  if (!valor) return res.status(400).json({ error: "O valor da sua mensalidade ainda não foi definido. Fale com o ConHub para combinar o plano." });
  if (!org.pagarme_card_id) return res.status(400).json({ error: "Cadastre o cartão de crédito antes de ligar a mensalidade." });
  if (org.pagarme_subscription_id && !org.cancelado_em) return res.status(409).json({ error: "A mensalidade já está ligada neste cartão." });

  const inicio = inicioDaCombinada(org);
  try {
    const a = await pagarme.criarAssinatura({ clienteId: org.pagarme_customer_id, cartaoId: org.pagarme_card_id,
      valor, meses: 1, codigo: "combinada", metadata: { org_id: org.id, plano: "combinada" },
      descricao: `ConHub — Mensalidade ${org.name} (${brl(valor)}/mês)`,
      inicio: inicio ? dataISO(inicio) : undefined });
    if (org.asaas_subscription_id) {
      try { await cancelarAssinatura(org.asaas_subscription_id); }
      catch (e) { console.warn(`[pagarme] a assinatura do Asaas ${org.asaas_subscription_id} não foi cancelada: ${e.message}`); }
    }
    const agora = Date.now();
    db.prepare(`UPDATE orgs SET pagarme_subscription_id = ?, pagarme_order_id = NULL, asaas_subscription_id = NULL,
        vence_em = COALESCE(vence_em, ?), vence_base = COALESCE(vence_base, vence_em, ?), link_pagamento = NULL, cancelado_em = NULL WHERE id = ?`)
      .run(a.id, agora, agora, org.id);
    const paga = inicio ? null : await cobrancaPagaDaAssinatura(a.id);
    if (paga) creditarPlano(org.id, paga);
    console.log(`[pagarme] ${req.user.name} ligou a mensalidade combinada no cartão (${org.name})${paga ? " — paga" : ""}`);
    res.json({ ok: true, pago: !!paga, cobra_em: inicio || null, ...situacao(org.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* CANCELAR A ASSINATURA, PELO PRÓPRIO CLIENTE (04/10/2026, pedido do Ali:
   "uma opção discreta, mas disponível para o cliente poder cancelar").

   Cancela a COBRANÇA no provedor e marca `cancelado_em`; o acesso continua
   até o fim do que já foi pago (o vencimento, ou o fim do teste — cancelar
   durante o teste não cobra nada). Falhou no provedor, nada é marcado: dizer
   "cancelado" com a assinatura ainda cobrando seria o pior desfecho.

   O anual do Pagar.me é um pedido só, já pago em 12x no cartão: não renova e
   não há cobrança futura a cancelar — a resposta diz até quando vale. As
   ferramentas avulsas têm a própria assinatura e se cancelam na lista delas. */
function oQueCancelar(org) {
  const prov = provedorDe(org);
  if (org.cancelado_em) return { pode: false, motivo: "ja_cancelada" };
  if (prov === "pagarme" && org.pagarme_subscription_id) return { pode: true, prov, sub: org.pagarme_subscription_id };
  if (prov === "asaas" && org.asaas_subscription_id && org.assinatura_status !== "cancelado") return { pode: true, prov, sub: org.asaas_subscription_id };
  if (org.pagarme_order_id || planoPorId(org.plano_id)?.forma === "parcelado") return { pode: false, motivo: "anual" };
  return { pode: false, motivo: "sem_assinatura" };
}

function cancelamentoParaTela(org) {
  const c = oQueCancelar(org);
  return { pode: c.pode, motivo: c.motivo || null, cancelada_em: org.cancelado_em || null };
}

r.post("/assinatura/cancelar", authRequired, soDono, async (req, res) => {
  const org = orgCompleta(req.user.org_id);
  const c = oQueCancelar(org);
  if (!c.pode) {
    const frase = c.motivo === "ja_cancelada" ? "A assinatura já está cancelada."
      : c.motivo === "anual" ? "O plano anual já foi pago em 12x no cartão e não renova sozinho — não há cobrança futura para cancelar."
      : "Não há assinatura ativa para cancelar.";
    return res.status(409).json({ error: frase });
  }
  try {
    if (c.prov === "pagarme") await pagarme.cancelarAssinatura(c.sub);
    else await cancelarAssinatura(c.sub);
  } catch (e) {
    return res.status(502).json({ error: "Não consegui cancelar no provedor de pagamento: " + e.message + " Tente de novo ou fale com o ConHub." });
  }
  db.prepare("UPDATE orgs SET cancelado_em = ? WHERE id = ?").run(Date.now(), org.id);
  console.log(`[assinatura] ${req.user.name} cancelou a assinatura de "${org.name}" (${c.prov})`);
  res.json({ ok: true, ...situacao(org.id) });
});

/* Um pagamento confirmado do PLANO: grava no histórico com o id da cobrança
   (é o que impede o webhook repetido de dar dois meses) e anda o vencimento. */
function creditarPlano(orgId, cobranca) {
  const org = orgCompleta(orgId);
  const valor = Number(cobranca.amount || cobranca.paid_amount || 0) / 100;
  return registrarPagamento(orgId, { valor, origem: "pagarme", asaasId: cobranca.id,
    meses: mesesPagos(org.plano_id, valor) });
}

/* A primeira cobrança já saiu? O Pagar.me cobra a assinatura sem `start_at` e
   o pedido na hora — conferir logo depois evita a tela dizer "aguardando" por
   causa de um webhook que ainda não chegou. Nunca lança: o webhook continua
   sendo o caminho principal. */
async function cobrancaPagaDaAssinatura(subId) {
  try {
    const lista = (await pagarme.faturasDaAssinatura(subId))?.data || [];
    const paga = lista.find(f => pagarme.PAGA.has(f.status) && f.charge && f.charge.id);
    return paga ? { ...paga.charge, amount: paga.charge.amount ?? paga.amount } : null;
  } catch (e) { console.warn(`[pagarme] não consegui conferir a assinatura ${subId}: ${e.message}`); return null; }
}

async function contratarPlanoPagarme(req, res) {
  if (exigePagarme(res)) return;
  const plano = planoDaFamilia(req.body?.plano_id, req.tipoDaConta);
  if (!plano) return res.status(400).json({ error: "Escolha um dos planos disponíveis." });
  const r = await assinarPlanoNoPagarme(req.user.org_id, plano, req.user.name);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.body);
}

/* ASSINAR UM PLANO NO CARTÃO GUARDADO — o miolo, sem req/res, porque são dois
   caminhos: a tela de Minha conta e o cadastro do site (`/publico/assinar`),
   que cadastra o cartão e assina o plano antes de a pessoa entrar. Duas cópias
   desta conta (início, prazo pago, cancelamento do plano anterior) iam
   divergir no primeiro ajuste. Devolve `{status, error}` ou `{body}`. */
export async function assinarPlanoNoPagarme(orgId, plano, quem = "") {
  const org = orgCompleta(orgId);
  if (!org.pagarme_card_id) return { status: 400, error: "Cadastre o cartão de crédito antes de escolher o plano." };
  /* O MESMO PLANO DE NOVO NÃO É CONTRATADO DE NOVO. Com o cartão guardado,
     "assinar" é um clique — e um segundo clique no plano que já está valendo
     cancelaria a assinatura e criaria outra, cobrando hoje de novo. O anual
     pode ser renovado quando falta menos de um mês para acabar. */
  if (org.plano_id === plano.id && !org.cancelado_em) {
    const renovacaoDoAnual = plano.forma === "parcelado" && (!org.vence_em || org.vence_em < Date.now() + 30 * 86400000);
    const valendo = plano.forma === "assinatura" ? !!org.pagarme_subscription_id : !!org.pagarme_order_id;
    if (valendo && !renovacaoDoAnual) return { status: 409, error: "Este já é o seu plano." };
  }

  /* Em teste, a primeira cobrança do mensal e do semestral cai no FIM do
     teste (`start_at`), como no Asaas. O anual é um pedido só, cobrado hoje —
     e os doze meses contam a partir do fim do teste, para quem paga adiantado
     não perder os dias grátis. */
  const emTeste = org.trial_ate && org.trial_ate > Date.now()
    && !db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(org.id).n;
  /* QUEM JÁ PAGOU ATÉ UMA DATA NÃO PAGA DUAS VEZES O MESMO PERÍODO (04/10/2026).
     Trocar de plano no meio do mês pago começa o plano novo no vencimento,
     não hoje: a primeira cobrança da assinatura cai lá, e o anual (cobrado
     hoje) conta os 12 meses a partir de lá. */
  const pagoAte = !emTeste && org.vence_em && org.vence_em > Date.now() + 86400000 ? org.vence_em : null;
  const inicio = emTeste ? org.trial_ate : (pagoAte || Date.now());
  const comecaDepois = emTeste || !!pagoAte;
  const porMes = brl(plano.mensal);
  const descricao = plano.meses > 1
    ? `ConHub — Plano ${plano.nome} (${plano.meses} meses · ${porMes}/mês)`
    : `ConHub — Plano ${plano.nome} (${porMes}/mês)`;
  const meta = { org_id: org.id, plano_id: plano.id };

  try {
    let assinaturaId = null, pedidoId = null, paga = null;
    if (plano.forma === "assinatura") {
      const a = await pagarme.criarAssinatura({ clienteId: org.pagarme_customer_id, cartaoId: org.pagarme_card_id,
        valor: plano.total, meses: plano.meses, descricao, codigo: plano.id, metadata: meta,
        inicio: comecaDepois ? dataISO(inicio) : undefined });
      assinaturaId = a.id;
    } else {
      const p = await pagarme.criarPedido({ clienteId: org.pagarme_customer_id, cartaoId: org.pagarme_card_id,
        valor: plano.total, parcelas: plano.parcelas, descricao, codigo: plano.id, metadata: meta });
      pedidoId = p.id;
      const cobranca = (p.charges || [])[0];
      if (p.status === "failed" || (cobranca && cobranca.status === "failed"))
        return { status: 402, error: "O cartão recusou a cobrança do plano anual. Confira o limite ou use outro cartão." };
      if (cobranca && pagarme.PAGA.has(cobranca.status)) paga = cobranca;
    }

    // As assinaturas ANTERIORES saem depois de a nova existir — no Pagar.me e,
    // se a conta veio do Asaas, lá também. A falha não derruba a troca.
    if (org.pagarme_subscription_id && org.pagarme_subscription_id !== assinaturaId) {
      try { await pagarme.cancelarAssinatura(org.pagarme_subscription_id); }
      catch (e) { console.warn(`[pagarme] plano trocado, mas a assinatura antiga ${org.pagarme_subscription_id} não foi cancelada: ${e.message}`); }
    }
    if (org.asaas_subscription_id) {
      try { await cancelarAssinatura(org.asaas_subscription_id); console.log(`[pagarme] assinatura do Asaas ${org.asaas_subscription_id} cancelada — a conta passou para o Pagar.me`); }
      catch (e) { console.warn(`[pagarme] a assinatura do Asaas ${org.asaas_subscription_id} não foi cancelada: ${e.message}`); }
    }

    /* O vencimento é a base mais os meses já pagos (recalcularVencimento), então
       a base recua o que já foi pago — senão os meses antigos seriam somados
       por cima do início do plano novo e virariam acesso grátis. */
    const { n: jaPagos } = db.prepare("SELECT COALESCE(SUM(COALESCE(meses,1)),0) n FROM pagamentos WHERE org_id = ?").get(org.id);
    db.prepare(`UPDATE orgs SET plano_id = ?, plano = ?, valor_mensal = ?, pagarme_subscription_id = ?, pagarme_order_id = ?,
        asaas_subscription_id = NULL, vence_em = ?, vence_base = ?, link_pagamento = NULL, assinatura_status = NULL, cancelado_em = NULL WHERE id = ?`)
      .run(plano.id, `ConHub ${plano.nome}`, plano.mensal, assinaturaId, pedidoId, inicio, somaMeses(inicio, -jaPagos), org.id);

    if (!paga && assinaturaId && !comecaDepois) paga = await cobrancaPagaDaAssinatura(assinaturaId);
    if (paga) creditarPlano(org.id, paga);
    console.log(`[pagarme] ${quem} contratou o plano ${plano.nome} (${org.name})${paga ? " — pago" : ""}`);
    return { body: { ok: true, plano: plano.id, pago: !!paga, cobra_em: comecaDepois && assinaturaId ? inicio : null, ...situacao(org.id) } };
  } catch (e) {
    return { status: 502, error: e.message };
  }
}

/* A FERRAMENTA EM UM CLIQUE: assinatura mensal própria no cartão guardado,
   cobrada hoje. A tela já mostra "no cartão final 4242" no botão — é a
   confirmação que a pessoa precisa antes de clicar. */
async function contratarFerramentaPagarme(req, res, org, recurso) {
  if (exigePagarme(res)) return;
  if (!org.pagarme_card_id) return res.status(400).json({ error: "Cadastre o cartão de crédito antes de contratar." });
  const preco = RECURSOS[recurso].avulso;
  try {
    const velha = db.prepare("SELECT avulso_sub_id, avulso_status, avulso_provedor FROM org_recursos WHERE org_id = ? AND recurso = ?").get(org.id, recurso);
    if (velha?.avulso_sub_id && velha.avulso_status === "aguardando") {
      try {
        if (velha.avulso_provedor === "pagarme") await pagarme.cancelarAssinatura(velha.avulso_sub_id);
        else await cancelarAssinatura(velha.avulso_sub_id);
      } catch (e) { console.warn(`[pagarme] tentativa anterior da ferramenta ${recurso} não foi cancelada: ${e.message}`); }
    }
    const a = await pagarme.criarAssinatura({ clienteId: org.pagarme_customer_id, cartaoId: org.pagarme_card_id,
      valor: preco, meses: 1, codigo: recurso, metadata: { org_id: org.id, recurso },
      descricao: `ConHub — ${RECURSOS[recurso].nome} (ferramenta avulsa · ${brl(preco)}/mês)` });
    registrarContratacao(org.id, recurso, { assinaturaId: a.id, link: null });
    db.prepare("UPDATE org_recursos SET avulso_provedor = 'pagarme' WHERE org_id = ? AND recurso = ?").run(org.id, recurso);
    const paga = await cobrancaPagaDaAssinatura(a.id);
    if (paga) avulsoPago(db.prepare("SELECT * FROM org_recursos WHERE org_id = ? AND recurso = ?").get(org.id, recurso), paga.id);
    console.log(`[pagarme] ${req.user.name} contratou ${RECURSOS[recurso].nome} avulso (${org.name})${paga ? " — pago" : ""}`);
    res.json({ ok: true, pago: !!paga, recurso: situacaoDoRecurso(org.id, recurso) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

async function conferirAvulsosPagarme(orgId) {
  for (const l of db.prepare(`SELECT * FROM org_recursos WHERE org_id = ? AND avulso_status = 'aguardando'
      AND avulso_provedor = 'pagarme' AND avulso_sub_id IS NOT NULL`).all(orgId)) {
    const paga = await cobrancaPagaDaAssinatura(l.avulso_sub_id);
    if (paga) avulsoPago(l, paga.id);
  }
}

/* ===== WEBHOOK DO PAGAR.ME =====

   NÃO CONFIA NO QUE CHEGA. O aviso diz "a cobrança X mudou"; a rota busca a
   cobrança X no Pagar.me com a chave SECRETA e decide pelo que a API
   responder. Quem inventar um aviso consegue, no máximo, fazer o servidor
   conferir uma cobrança que não existe ou que não está paga — e uma cobrança
   paga de verdade, repetida, não credita duas vezes (id no histórico).
   Por isso não depende de segredo configurado; se `PAGARME_WEBHOOK_USUARIO`
   e `PAGARME_WEBHOOK_SENHA` existirem (autenticação básica cadastrada no
   painel), eles são exigidos também. */
r.post("/webhooks/pagarme", async (req, res) => {
  const usuario = process.env.PAGARME_WEBHOOK_USUARIO, senha = process.env.PAGARME_WEBHOOK_SENHA;
  if (usuario && senha) {
    const [tipo, valor] = String(req.get("authorization") || "").split(" ");
    const [u, p] = tipo === "Basic" && valor ? Buffer.from(valor, "base64").toString().split(":") : [];
    if (!segredoConfere(u, usuario) || !segredoConfere(p, senha)) {
      console.warn("[pagarme] webhook recusado: usuário/senha não conferem");
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  try { await processarAvisoPagarme(req.body || {}); }
  catch (e) { console.error("[pagarme] erro ao processar webhook:", e.message); }
});

export async function processarAvisoPagarme(corpo) {
  if (!pagarme.pagarmeConfigurado()) return;
  const tipo = String(corpo.type || "");
  const id = corpo.data && corpo.data.id;
  if (!id) return;

  if (tipo === "subscription.canceled") {
    const sub = await pagarme.lerAssinatura(id);
    if (sub.status !== "canceled") return;
    const avulso = avulsoDaAssinatura(sub.id);
    if (avulso && avulso.avulso_provedor === "pagarme") {
      if (["aguardando", "ativo"].includes(avulso.avulso_status)) avulsoCancelado(avulso);
      return;
    }
    const org = db.prepare("SELECT * FROM orgs WHERE pagarme_subscription_id = ?").get(sub.id);
    if (org && !org.cancelado_em) {
      db.prepare("UPDATE orgs SET assinatura_status = 'cancelado' WHERE id = ?").run(org.id);
      console.log(`[pagarme] assinatura cancelada (${org.name})`);
    }
    return;
  }
  if (!tipo.startsWith("charge.")) return;

  const c = await pagarme.lerCobranca(id);
  const clienteId = pagarme.clienteDaCobranca(c);
  const org = clienteId ? db.prepare("SELECT * FROM orgs WHERE pagarme_customer_id = ?").get(clienteId) : null;
  if (!org) { console.warn(`[pagarme] cobrança ${c.id} de um cliente que não é de nenhuma conta — ignorada`); return; }

  const subId = pagarme.assinaturaDaCobranca(c);
  const pedidoId = pagarme.pedidoDaCobranca(c);
  const avulso = subId ? avulsoDaAssinatura(subId) : null;
  const daFerramenta = avulso && avulso.org_id === org.id && avulso.avulso_provedor === "pagarme";
  const doPlano = (subId && subId === org.pagarme_subscription_id) || (pedidoId && pedidoId === org.pagarme_order_id);
  if (!daFerramenta && !doPlano) { console.warn(`[pagarme] cobrança ${c.id} não é do plano nem de ferramenta de "${org.name}" — ignorada`); return; }

  if (pagarme.PAGA.has(c.status)) {
    if (daFerramenta) { if (avulsoPago(avulso, c.id)) console.log(`[pagarme] ferramenta ${avulso.recurso} paga (${org.name})`); }
    else { const prox = creditarPlano(org.id, c); console.log(`[pagarme] pagamento confirmado (${org.name}) — próximo vencimento ${new Date(prox).toLocaleDateString("pt-BR")}`); }
  } else if (pagarme.ESTORNADA.has(c.status)) {
    if (daFerramenta) avulsoCancelado(avulso, { estorno: true });
    else db.prepare("UPDATE orgs SET assinatura_status = 'cancelado' WHERE id = ?").run(org.id);
    console.log(`[pagarme] cobrança ${c.status === "chargedback" ? "contestada" : "estornada"} (${org.name})`);
  } else if (c.status === "failed") {
    if (!daFerramenta) marcarAtraso(org.id, null);
    console.log(`[pagarme] cartão recusou a cobrança (${org.name})`);
  }
}

/* Cancela tudo que a conta tem no Pagar.me — usado ao apagar a conta.
   Devolve a lista do que não deu para cancelar, para o aviso na tela. */
export async function cancelarTudoNoPagarme(org) {
  const falhas = [];
  if (!pagarme.pagarmeConfigurado()) return falhas;
  const subs = [org.pagarme_subscription_id,
    ...db.prepare(`SELECT avulso_sub_id FROM org_recursos WHERE org_id = ? AND avulso_provedor = 'pagarme'
        AND avulso_status IN ('aguardando','ativo') AND avulso_sub_id IS NOT NULL`).all(org.id).map(x => x.avulso_sub_id)].filter(Boolean);
  for (const s of subs) {
    try { await pagarme.cancelarAssinatura(s); } catch (e) { falhas.push(s); console.warn(`[pagarme] não consegui cancelar ${s}: ${e.message}`); }
  }
  return falhas;
}


export default r;
