/* A PORTA DE ENTRADA DE QUEM VEM DO SITE. (02/09/2026)

   Até aqui a conta de corretor autônomo só nascia de um jeito: o Ali criando
   uma a uma no hub. Isso servia enquanto a venda era conversada — e deixa de
   servir no minuto em que existe um site com um botão "Testar 14 dias grátis",
   porque cada clique viraria uma mensagem para ele responder no dia seguinte.

   Esta rota é o outro lado desse botão: o corretor preenche três campos no
   site, a conta nasce em teste e ele recebe o link para criar a senha e entrar.
   Ninguém do ConHub precisa estar acordado.

   ===== POR QUE ELA MORA SOZINHA, NUM ARQUIVO SÓ DELA =====

   Porque é a ÚNICA rota de escrita da plataforma que qualquer pessoa da
   internet pode chamar sem estar logada e sem código de convite. O
   `/auth/register` é aberto, mas exige o `ADM_CODE` da imobiliária; o
   `/orgs/autonomos` exige master. Esta não exige nada — e uma rota assim
   precisa de um lugar onde as travas dela sejam a primeira coisa que se lê,
   não uma linha perdida no meio de um arquivo de duzentas.

   ===== AS TRAVAS =====

   1. FREIO POR IP. Sem ele, um laço de dez linhas cria dez mil imobiliárias
      numa madrugada, e a limpeza é manual. É em memória de propósito: some no
      reinício, e isso é aceitável — o objetivo é impedir a enxurrada, não
      construir um cadastro de infratores.

   2. E-MAIL QUE JÁ TEM CONTA ATIVA NÃO CRIA OUTRA. Devolve "faça login", que é
      o que a pessoa quer de verdade quando digita o próprio e-mail de novo.

   3. NADA DE VALOR VEM DO CORPO DA REQUISIÇÃO. O preço sai da tabela do
      servidor (`services/planos.js`) e o teste é o de sempre. É a mesma regra
      de 27/08/2026, e aqui ela pesa mais: do outro lado não tem nem cliente
      logado, tem a internet. */

import { Router } from "express";
import { randomUUID, randomBytes } from "crypto";
import db from "../db.js";
import { codigoLivre } from "../services/codigo.js";
import { normalizePhone } from "../services/stages.js";
import { sendMail, inviteEmail, mailConfigured } from "../services/mail.js";
import { PLANOS } from "../services/planos.js";

const r = Router();

const siteUrl = (req) =>
  (process.env.SITE_URL || process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/* O FREIO. Cinco contas por IP a cada hora.

   O número é generoso de propósito: uma imobiliária inteira testando do mesmo
   escritório passa, e o robô que quer criar mil não. Quando o teto é atingido a
   resposta é 429 com uma frase de gente — quem esbarrar nisso por acidente
   precisa entender que não é erro do site dele. */
const JANELA = 60 * 60 * 1000;
const TETO_POR_IP = 5;
const tentativas = new Map();

function passouNoFreio(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter(t => agora - t < JANELA);
  if (lista.length >= TETO_POR_IP) { tentativas.set(ip, lista); return false; }
  lista.push(agora);
  tentativas.set(ip, lista);
  /* Limpeza preguiçosa: sem ela o Map cresceria para sempre num servidor que
     fica meses de pé. Roda junto com o pedido, que é raro o bastante. */
  if (tentativas.size > 5000)
    for (const [chave, ts] of tentativas)
      if (!ts.some(t => agora - t < JANELA)) tentativas.delete(chave);
  return true;
}

/* Quantos dias o teste dura. O mesmo número do resto do sistema — e ele mora
   aqui repetido de propósito NÃO: é importado de onde já era. */
const TRIAL_DIAS = 14;

/* Os planos, para o site montar a tela de preços a partir do servidor.

   Aberto sem login porque é informação pública — é o preço que está na
   vitrine. E vindo daqui, o dia em que o preço mudar o site muda junto: uma
   tabela copiada no Lovable seria uma segunda verdade sobre dinheiro,
   divergindo no primeiro reajuste e sendo descoberta pelo cliente. */
r.get("/publico/planos", (_req, res) => {
  res.json({
    trial_dias: TRIAL_DIAS,
    planos: PLANOS.map(p => ({
      id: p.id, nome: p.nome, mensal: p.mensal, meses: p.meses,
      total: p.total, forma: p.forma, resumo: p.resumo,
    })),
  });
});

/* COMEÇAR O TESTE. É o botão do site.

   Não cobra nada e não pede cartão: cria a conta, começa o teste e devolve o
   link para a pessoa criar a senha. O pagamento acontece depois, dentro do
   CRM, quando ela escolher o plano — que é onde o Asaas já está ligado e onde
   nenhum dado de cartão passa por nós. */
r.post("/publico/comecar", async (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress || "sem-ip";
  if (!passouNoFreio(ip))
    return res.status(429).json({
      error: "Muitos cadastros seguidos deste computador. Espere uma hora ou fale com a gente pelo WhatsApp." });

  const nome = String(req.body?.nome || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const telefone = normalizePhone(String(req.body?.telefone || "").trim());
  const marca = String(req.body?.marca || "").trim().slice(0, 80) || nome;

  if (nome.length < 2) return res.status(400).json({ error: "Escreva o seu nome." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: "Confira o e-mail: parece que falta alguma coisa." });
  if (!/^55\d{10,11}$/.test(telefone))
    return res.status(400).json({ error: "Informe um WhatsApp válido, com DDD." });

  /* E-mail que JÁ TEM CONTA ATIVA não cria outra — devolve o caminho de
     entrar. Criar a segunda conta seria a pior resposta possível: a pessoa
     ficaria com duas, cada uma com metade dos leads, e descobriria isso
     semanas depois. */
  const jaExiste = db.prepare("SELECT id,name,status FROM users WHERE email = ?").get(email);
  if (jaExiste && jaExiste.status === "ativo")
    return res.status(409).json({
      error: "Esse e-mail já tem conta no ConHub. Entre com a sua senha — ou peça uma nova na tela de entrada.",
      ja_tem_conta: true, entrar: `${siteUrl(req)}/app`,
    });

  const token = randomBytes(24).toString("hex");
  const expira = Date.now() + 7 * 86400000;
  const orgId = "org_" + randomUUID().slice(0, 8);
  const userId = jaExiste ? jaExiste.id : "u_" + randomUUID();
  const agora = Date.now();

  const criar = db.transaction(() => {
    db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at,tipo)
      VALUES (?,?,?,'',0,0,?,'autonomo')`).run(orgId, marca, codigoLivre(marca), agora);
    /* Conta que existe mas nunca foi ativada (pendente, recusada) é
       reaproveitada: quem tentou uma vez e não terminou não pode ficar preso
       para sempre sem conseguir se cadastrar de novo. */
    if (jaExiste) {
      db.prepare(`UPDATE users SET org_id=?, name=?, phone=?, role='adm', status='pendente',
        invite_token=?, invite_expires=?, invite_tipo='fundador' WHERE id=?`)
        .run(orgId, nome, telefone, token, expira, userId);
    } else {
      db.prepare(`INSERT INTO users (id,org_id,name,email,phone,pass_hash,role,available,created_at,status,invite_token,invite_expires,invite_tipo)
        VALUES (?,?,?,?,?,'','adm',0,?,'pendente',?,?,'fundador')`)
        .run(userId, orgId, nome, email, telefone, agora, token, expira);
    }
    db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(userId, orgId);
  });
  criar();

  /* O TESTE COMEÇA QUANDO ELE DEFINE A SENHA, não agora.

     A regra é de 27/08/2026 e vale mais ainda aqui: alguém que preenche o
     formulário às 23h e só abre o e-mail na segunda não pode chegar com três
     dias a menos. Quem inicia a contagem é o `set-password`. */

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  let enviado = false;
  if (mailConfigured()) {
    try {
      const { subject, html } = inviteEmail({ name: nome, link, orgName: marca });
      enviado = !!(await sendMail({ to: email, subject, html })).sent;
    } catch (e) { console.error("[publico] e-mail não saiu:", e.message); }
  }
  console.log(`[publico] conta de teste criada pelo site: ${nome} <${email}> — link: ${link}`);

  /* O LINK VOLTA NA RESPOSTA, e não só no e-mail.

     É a mesma decisão do cadastro de corretor: sem provedor de e-mail
     contratado, ou com o e-mail caindo em spam, o fluxo continua funcionando —
     o site manda a pessoa direto para a tela de criar a senha. Um cadastro que
     depende de um e-mail chegar é um cadastro que falha em silêncio para uma
     parte das pessoas, e essa parte nunca reclama: ela desiste. */
  res.status(201).json({ ok: true, nome, email, link, email_enviado: enviado, dias: TRIAL_DIAS });
});

export default r;
