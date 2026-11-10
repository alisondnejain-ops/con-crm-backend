/* A PÁGINA E O PAGAMENTO DA PROPOSTA PERSONALIZADA (10/11/2026).

   Aberto sem login, como `/publico/assinar` — e pelos mesmos motivos é um
   arquivo só dele, com as travas na frente. A regra que importa está no
   serviço: preço, parcelas e meses vêm da proposta gravada pelo master, nunca
   do corpo da requisição. Ver services/propostas.js. */
import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import db from "../db.js";
import * as pagarme from "../services/pagarme.js";
import { codigoLivre } from "../services/codigo.js";
import { telefoneDeCadastro } from "../services/telefone.js";
import { sign, cadastroPodeReaproveitar, EMAIL_EM_USO } from "../auth.js";
import { ipDe } from "../seguranca.js";
import {
  propostaPorCodigo, paraPagina, estadoDe, parcelaDe, travarParaPagar, destravar,
  marcarProcessando, confirmarProposta, lerProposta, cancelarRecorrentes,
} from "../services/propostas.js";

const r = Router();
const siteUrl = (req) =>
  (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/* Freio por IP: dez tentativas de pagamento por hora. Generoso para quem
   erra o CVV duas vezes; curto para quem testa cartões roubados num link. */
const JANELA = 60 * 60 * 1000, TETO = 10;
const tentativas = new Map();
function passou(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter(t => agora - t < JANELA);
  if (lista.length >= TETO) { tentativas.set(ip, lista); return false; }
  lista.push(agora); tentativas.set(ip, lista);
  if (tentativas.size > 5000) for (const [k, ts] of tentativas) if (!ts.some(t => agora - t < JANELA)) tentativas.delete(k);
  return true;
}

/* Cobrar de verdade só com a chave de produção. Com `sk_test_` o cartão do
   cliente seria recusado (ou, pior, "aprovado" num ambiente que não move
   dinheiro) e a conta destravaria sem ninguém ter pago. */
const podeCobrar = () => pagarme.pagarmeConfigurado()
  && (pagarme.ambientePagarme() === "produção" || process.env.PROPOSTA_ACEITA_TESTE === "1");

const reais = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const ESTADOS = {
  paga: { status: 409, error: "Esta proposta já foi paga. Obrigado! Entre no ConHub com o seu e-mail e senha.", ja_paga: true },
  processando: { status: 409, error: "O pagamento desta proposta está em análise no Pagar.me. Assim que for aprovado, a conta é liberada — não precisa pagar de novo.", processando: true },
  vencida: { status: 410, error: "Este link de pagamento venceu. Fale com o ConHub para receber um novo.", vencida: true },
  cancelada: { status: 410, error: "Esta proposta foi cancelada. Fale com o ConHub.", cancelada: true },
  estornada: { status: 410, error: "Esta proposta foi estornada. Fale com o ConHub.", cancelada: true },
  pagando: { status: 409, error: "Já há um pagamento desta proposta em andamento. Aguarde alguns segundos e recarregue a página.", pagando: true },
};

r.get("/publico/proposta/:codigo", (req, res) => {
  const p = propostaPorCodigo(req.params.codigo);
  if (!p) return res.status(404).json({ error: "Proposta não encontrada. Confira o link que você recebeu." });
  res.set("Cache-Control", "no-store");
  res.json({
    ...paraPagina(p),
    checkout: podeCobrar() ? { chave_publica: pagarme.CHAVE_PUBLICA(), ambiente: pagarme.ambientePagarme() } : null,
  });
});

r.post("/publico/proposta/:codigo/pagar", async (req, res) => {
  const p = propostaPorCodigo(req.params.codigo);
  if (!p) return res.status(404).json({ error: "Proposta não encontrada. Confira o link que você recebeu." });
  const estado = estadoDe(p);
  if (estado !== "aberta") { const e = ESTADOS[estado] || ESTADOS.cancelada; return res.status(e.status).json(e); }
  if (!passou(ipDe(req)))
    return res.status(429).json({ error: "Muitas tentativas seguidas deste computador. Espere uma hora ou fale com o ConHub." });
  if (!podeCobrar())
    return res.status(503).json({ error: "O pagamento por cartão não está disponível agora. Fale com o ConHub." });

  const token = String(req.body?.token || "");
  const doc = String(req.body?.cpfCnpj || "").replace(/\D/g, "");
  if (!/^token_[A-Za-z0-9]+$/.test(token)) return res.status(400).json({ error: "Os dados do cartão não chegaram. Digite de novo." });
  if (doc.length !== 11 && doc.length !== 14) return res.status(400).json({ error: "Informe o CPF (11 dígitos) ou CNPJ (14 dígitos) do titular do cartão." });

  /* ===== QUEM PAGA =====
     Conta existente: os dados são os do dono da conta (a página não pede
     cadastro). Conta nova: nome, e-mail, WhatsApp e senha do responsável —
     a mesma conferência do cadastro do site. */
  let orgExistente = null, novo = null;
  if (p.org_id) {
    orgExistente = db.prepare("SELECT * FROM orgs WHERE id = ?").get(p.org_id);
    if (!orgExistente) return res.status(410).json({ error: "A conta desta proposta não existe mais. Fale com o ConHub." });
  } else {
    const nome = String(req.body?.nome || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const tel = telefoneDeCadastro(req.body?.telefone, req.body?.pais);
    const senha = String(req.body?.senha || "");
    const marca = String(req.body?.marca || "").replace(/\s+/g, " ").trim().slice(0, 80) || p.cliente;
    if (nome.length < 2) return res.status(400).json({ error: "Escreva o nome do responsável pela conta." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Confira o e-mail: parece que falta alguma coisa." });
    if (tel.erro) return res.status(400).json({ error: tel.erro });
    if (senha.length < 6) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });
    const ja = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (ja && ja.status === "ativo")
      return res.status(409).json({ error: "Esse e-mail já tem conta no ConHub. Use outro e-mail para a conta nova, ou fale com o ConHub para ligar esta proposta à conta que já existe.", ja_tem_conta: true });
    if (!cadastroPodeReaproveitar(ja)) return res.status(409).json({ error: EMAIL_EM_USO, ja_tem_conta: true });
    novo = { nome, email, telefone: tel.phone || "", senha, marca, ja };
  }

  if (!travarParaPagar(p)) {
    const e = ESTADOS[estadoDe(lerProposta(p.id))] || ESTADOS.pagando;
    return res.status(e.status).json(e);
  }

  const orgId = orgExistente ? orgExistente.id : "org_" + randomUUID().slice(0, 8);
  const pagador = orgExistente
    ? (db.prepare("SELECT name nome, email, phone telefone FROM users WHERE id = ?").get(orgExistente.dono_user_id)
      || db.prepare("SELECT name nome, email, phone telefone FROM users WHERE org_id = ? AND role = 'adm' AND status = 'ativo' ORDER BY created_at LIMIT 1").get(orgExistente.id)
      || { nome: p.contato_nome || p.cliente, email: p.contato_email || null, telefone: "" })
    : { nome: novo.nome, email: novo.email, telefone: novo.telefone };

  /* ===== O CARTÃO E A COBRANÇA, ANTES DE QUALQUER CONTA ===== */
  let cliente, cartao, pedido, cobranca;
  try {
    cliente = orgExistente && orgExistente.pagarme_customer_id
      ? { id: orgExistente.pagarme_customer_id }
      : await pagarme.criarCliente({ nome: pagador.nome, email: pagador.email, telefone: pagador.telefone, documento: doc, orgId });
    cartao = await pagarme.salvarCartao(cliente.id, token);
    const descricao = `ConHub — ${p.titulo} · ${p.cliente} (${p.parcelas}x de ${reais(parcelaDe(p.total, p.parcelas))})`.slice(0, 250);
    pedido = await pagarme.criarPedido({ clienteId: cliente.id, cartaoId: cartao.id, valor: p.total, parcelas: p.parcelas,
      descricao, codigo: "proposta", metadata: { proposta_id: p.id, org_id: orgId } });
    cobranca = (pedido.charges || [])[0] || null;
  } catch (e) {
    destravar(p, e.message);
    console.warn(`[proposta] pagamento recusado (${p.cliente}): ${e.message}`);
    return res.status(402).json({ error: "O cartão não foi aceito: " + String(e.message || "").replace(/^Pagar\.me: /, "") });
  }
  const statusCob = cobranca ? cobranca.status : pedido.status;
  if (pedido.status === "failed" || statusCob === "failed" || statusCob === "canceled") {
    const t = cobranca && cobranca.last_transaction;
    const motivo = (t && (t.acquirer_message || t.gateway_response?.errors?.[0]?.message)) || "o banco recusou a cobrança";
    destravar(p, motivo);
    return res.status(402).json({ error: `O cartão recusou a cobrança (${motivo}). Confira o limite — o valor total de ${reais(p.total)} fica reservado no limite, mesmo parcelado — ou use outro cartão.` });
  }
  const paga = cobranca && pagarme.PAGA.has(cobranca.status);
  const agora = Date.now();

  /* ===== A CONTA ===== */
  let userId = null;
  try {
    if (orgExistente) {
      db.prepare(`UPDATE orgs SET cobranca = 'pagarme', pagarme_customer_id = COALESCE(pagarme_customer_id, ?),
          pagarme_card_id = ?, pagarme_card_json = ? WHERE id = ?`)
        .run(cliente.id, cartao.id, JSON.stringify(pagarme.resumoDoCartao(cartao)), orgExistente.id);
    } else {
      userId = novo.ja ? novo.ja.id : "u_" + randomUUID();
      const hash = bcrypt.hashSync(novo.senha, 10);
      db.transaction(() => {
        /* Em análise, a conta nasce com 3 dias para usar enquanto o Pagar.me
           decide. Aprovado, os meses contam do dia do pagamento; recusado, ela
           trava no fim dos 3 dias (o cliente paga de novo no mesmo link). */
        db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at,tipo,
            cobranca,pagarme_customer_id,pagarme_card_id,pagarme_card_json,vence_em)
          VALUES (?,?,?,'',0,0,?,'imobiliaria','pagarme',?,?,?,?)`)
          .run(orgId, novo.marca, codigoLivre(novo.marca), agora, cliente.id, cartao.id,
            JSON.stringify(pagarme.resumoDoCartao(cartao)), paga ? null : agora + 3 * 86400000);
        if (novo.ja) {
          db.prepare(`UPDATE users SET org_id=?, name=?, phone=?, role='adm', available=0, status='ativo', pass_hash=?,
            invite_token=NULL, invite_hash=NULL, invite_expires=NULL, invite_tipo=NULL WHERE id=?`)
            .run(orgId, novo.nome, novo.telefone, hash, userId);
        } else {
          db.prepare(`INSERT INTO users (id,org_id,name,email,phone,pass_hash,role,available,created_at,status)
            VALUES (?,?,?,?,?,?,'adm',0,?,'ativo')`).run(userId, orgId, novo.nome, novo.email, novo.telefone, hash, agora);
        }
        db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(userId, orgId);
      })();
    }
  } catch (e) {
    /* O dinheiro já saiu e a conta não nasceu. Não devolve "erro de cartão":
       a proposta fica marcada com o pedido, e o master resolve pelo hub. */
    marcarProcessando(p, { pedidoId: pedido.id, cobrancaId: cobranca && cobranca.id, orgId: null, pagador });
    db.prepare("UPDATE propostas SET ultimo_erro = ? WHERE id = ?").run("Pagamento feito, mas a conta não foi criada: " + e.message, p.id);
    console.error(`[proposta] PAGO SEM CONTA (${p.cliente}, pedido ${pedido.id}): ${e.message}`);
    return res.status(500).json({ error: "O pagamento foi recebido, mas a conta não pôde ser criada agora. Não pague de novo: o ConHub já foi avisado e vai liberar a sua conta.", pago_sem_conta: true });
  }

  if (paga) {
    db.prepare("UPDATE propostas SET pedido_id = ? WHERE id = ?").run(pedido.id, p.id);
    confirmarProposta(p, { orgId, cobrancaId: cobranca.id, valor: Number(cobranca.paid_amount || cobranca.amount || 0) / 100 || null, pagador });
    if (orgExistente) await cancelarRecorrentes(orgExistente);
  } else {
    marcarProcessando(p, { pedidoId: pedido.id, cobrancaId: cobranca && cobranca.id, orgId: orgExistente ? null : orgId, pagador });
  }
  console.log(`[proposta] ${paga ? "PAGA" : "em análise"}: ${p.cliente} — ${reais(p.total)} em ${p.parcelas}x (${orgExistente ? "conta existente" : "conta nova"})`);

  const user = userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(userId) : null;
  res.status(201).json({
    ok: true, pago: !!paga, processando: !paga, conta_nova: !orgExistente,
    token: user ? sign(user) : null, entrar: `${siteUrl(req)}/app`,
  });
});

export default r;
