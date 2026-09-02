import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "crypto";
import db from "../db.js";
import { sign, authRequired, roles, supervisiona, PAPEIS, papelDoFormulario, semMaster, ehDonoAutonomo } from "../auth.js";
import { normalizePhone } from "../services/stages.js";
import { sendMail, mailConfigured, inviteEmail, senhaEmail } from "../services/mail.js";
import { salvar, apagar, tipoPermitido, ehVideo } from "../services/storage.js";
import { aplicarCorte } from "../services/expediente.js";
import { codigoLivre } from "../services/codigo.js";
import { marcaDaOrg } from "../services/marca.js";

const r = Router();
const INVITE_DAYS = 7;
// O teste grátis do corretor autônomo. Ver orgs.routes.js -> /autonomos.
const TRIAL_DIAS = 14;

// URL pública deste backend — usada para montar o link "definir senha" do e-mail.
const appUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
/* Endereço do SITE, que é o que vai para o corretor no link de definir senha.
   Separado do APP_URL de propósito: aquele é o do servidor e continua sendo
   usado para servir os arquivos das conversas (/arquivos). Trocar um pelo outro
   quebraria as fotos. Sem SITE_URL definido, cai no comportamento antigo. */
const siteUrl = (req) => (process.env.SITE_URL || process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const newToken = () => randomBytes(24).toString("hex");
const norm = (e) => String(e || "").trim().toLowerCase();

// A imobiliária de alguém, no formato que as telas usam.
/* A marca vem JUNTO com a imobiliária, não numa requisição depois.
   Buscá-la separado faria a barra nascer verde e trocar de cor um instante
   depois, em todo login — o piscar diria à equipe que a marca dela é um
   enfeite que o sistema aplica com atraso. */
function orgDoUsuario(user) {
  const o = db.prepare("SELECT id,name,adm_code,logo_url,cor_barra,tipo FROM orgs WHERE id = ?").get(user.org_id);
  /* `tipo` vem junto porque decide o MENU: a conta de corretor autônomo não
     mostra catraca — fila de distribuição com uma pessoa não é fila. */
  return o ? { id: o.id, nome: o.name, codigo: o.adm_code, tipo: o.tipo || "imobiliaria", ...marcaDaOrg(o) } : null;
}
// O link que o gestor manda para os corretores dele.
function linkDaEquipe(req, user) {
  const o = orgDoUsuario(user);
  return o ? `${siteUrl(req)}/cadastro?c=${o.codigo}` : null;
}

/* ── Cadastro do DONO da imobiliária (link público) ──────────────────────────

   Duas portas diferentes, de propósito:

   - O corretor entra por `/cadastro?c=CODIGO`. Ele não escolhe imobiliária:
     o código do link já diz de qual casa ele é.
   - O dono entra por aqui. Ele ainda não tem casa — ele CRIA a casa, e é no
     fim deste cadastro que nasce o código exclusivo dela, que ele vai mandar
     para a equipe.

   Antes existia só a primeira porta, e a tela de entrada sugeria o código da
   Conecta para qualquer visitante: quem quisesse abrir a própria imobiliária
   acabava virando corretor da Conecta.

   O dono NÃO passa por aprovação — não há quem aprove numa imobiliária que
   acabou de nascer. Ele é marcado como fundador no convite, e é o que dá a
   ele o acesso direto lá no set-password. */
r.post("/criar-imobiliaria", async (req, res) => {
  const { imobiliaria, name, email, phone } = req.body || {};
  const nomeOrg = String(imobiliaria || "").trim();
  const cleanName = String(name || "").trim();

  if (!nomeOrg || !cleanName || !email || !phone)
    return res.status(400).json({ error: "Preencha o nome da imobiliária, seu nome, e-mail e telefone." });
  if (nomeOrg.length < 2) return res.status(400).json({ error: "Informe o nome da imobiliária." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(email)))
    return res.status(400).json({ error: "E-mail inválido." });

  const mail = norm(email);
  const existente = db.prepare("SELECT * FROM users WHERE email = ?").get(mail);
  /* Quem já tem conta ativa não abre imobiliária por aqui — entraria em duas
     casas com o mesmo e-mail, e o login não saberia qual abrir. */
  if (existente && existente.status === "ativo")
    return res.status(409).json({ error: "Esse e-mail já tem conta ativa. Entre no CRM com ele — ou use outro e-mail para a imobiliária nova." });

  /* Cadastro repetido (fechou a aba, errou o e-mail, tentou de novo) reaproveita
     a imobiliária que ficou pela metade em vez de criar outra. Sem isto, cada
     tentativa deixaria uma imobiliária fantasma na plataforma. */
  const orgPendente = existente
    ? db.prepare("SELECT * FROM orgs WHERE dono_user_id = ?").get(existente.id)
    : null;

  const token = newToken();
  const expires = Date.now() + INVITE_DAYS * 86400000;
  let org = orgPendente;

  const gravar = db.transaction(() => {
    if (org) {
      db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run(nomeOrg, org.id);
      db.prepare(`UPDATE users SET name=?, phone=?, role='adm', invite_token=?, invite_expires=?,
        invite_tipo='fundador' WHERE id=?`).run(cleanName, normalizePhone(phone), token, expires, existente.id);
      org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id);
      return;
    }
    const orgId = "org_" + randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at)
                VALUES (?,?,?,'',0,0,?)`).run(orgId, nomeOrg, codigoLivre(nomeOrg), Date.now());

    const userId = existente ? existente.id : "u_" + randomUUID();
    if (existente) {
      db.prepare(`UPDATE users SET org_id=?, name=?, phone=?, role='adm', status='pendente',
        invite_token=?, invite_expires=?, invite_tipo='fundador' WHERE id=?`)
        .run(orgId, cleanName, normalizePhone(phone), token, expires, userId);
    } else {
      db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,phone,status,invite_token,invite_expires,invite_tipo)
        VALUES (?,?,?,?,'','adm',0,?,?,'pendente',?,?,'fundador')`)
        .run(userId, orgId, cleanName, mail, Date.now(), normalizePhone(phone), token, expires);
    }
    // Dono da conta: é quem responde pela mensalidade e quem vê a cobrança.
    db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(userId, orgId);
    org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
  });
  gravar();

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  const { subject, html } = inviteEmail({ name: cleanName, link, orgName: org.name });
  const out = await sendMail({ to: mail, subject, html });
  if (!out.sent) console.log(`[imobiliária nova] ${org.name} (${org.adm_code}) — link de senha para ${mail}: ${link}`);

  res.json({
    ok: true,
    emailSent: out.sent,
    imobiliaria: org.name,
    codigo: org.adm_code,
    link_equipe: `${siteUrl(req)}/cadastro?c=${org.adm_code}`,
    // Sem provedor de e-mail, o link volta na tela — é o modo manual de sempre.
    link: mailConfigured() ? undefined : link,
  });
});

// ── Cadastro do corretor (link público) ───────────────────────────────────────
// Cria a conta como PENDENTE e dispara o e-mail com o link para definir a senha.
// Se o mesmo e-mail já tem convite pendente, apenas reenvia um token novo.
r.post("/register", async (req, res) => {
  const { name, email, phone, adm_code, funcao } = req.body || {};
  if (!name || !email || !phone || !adm_code)
    return res.status(400).json({ error: "Preencha nome, e-mail, telefone e o código da imobiliária." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(email)))
    return res.status(400).json({ error: "E-mail inválido." });

  // Sem função informada, assume corretor — é o caso da grande maioria.
  const role = papelDoFormulario(funcao || "corretor");
  if (!role) return res.status(400).json({ error: "Escolha se você é corretor, atendente ou gestor." });

  const org = db.prepare("SELECT * FROM orgs WHERE adm_code = ?").get(String(adm_code).trim().toUpperCase());
  if (!org) return res.status(403).json({ error: "Código da imobiliária inválido. Peça o link de cadastro à gestão da sua imobiliária." });

  /* O TAMANHO DA CASA DO AUTÔNOMO.

     A conta dele é uma org como qualquer outra, e por isso o link de cadastro
     funcionaria igual — montando uma equipe inteira numa conta vendida como
     individual. Duas travas, e as duas ficam AQUI, na porta:

     - corretor não entra: o corretor é ele. Uma segunda pessoa atendendo já é
       imobiliária, e imobiliária é outro plano;
     - atendente, no máximo um. Pode ser gente ou a IA do fora-do-expediente
       fazendo a qualificação — a IA não ocupa a vaga porque não é conta.

     Recusar com a razão escrita, e não com "não pode": quem está cadastrando é
     alguém que o corretor convidou, e precisa entender por que foi barrado. */
  if ((org.tipo || "imobiliaria") === "autonomo") {
    if (role !== "sdr")
      return res.status(403).json({
        error: "Esta é uma conta de corretor autônomo: ela aceita apenas um atendente, e nenhum corretor além do titular." });
    const jaTem = db.prepare(
      `SELECT COUNT(*) n FROM users u WHERE u.org_id = ? AND u.role = 'sdr'
        AND u.status IN ('ativo','pendente','aguardando_aprovacao') AND u.email <> ?${semMaster("u")}`)
      .get(org.id, norm(email)).n;
    if (jaTem >= 1)
      return res.status(409).json({
        error: "Esta conta já tem o atendente dela. O plano de corretor autônomo vai até um." });
  }

  const mail = norm(email);
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(mail);
  if (existing && existing.status === "ativo")
    return res.status(409).json({ error: "Esse e-mail já tem conta ativa. Use 'Entrar' no CRM." });

  const token = newToken();
  const expires = Date.now() + INVITE_DAYS * 86400000;
  const cleanName = String(name).trim();

  if (existing) {
    db.prepare("UPDATE users SET name=?, phone=?, role=?, invite_token=?, invite_expires=?, invite_tipo='convite' WHERE id=?")
      .run(cleanName, normalizePhone(phone), role, token, expires, existing.id);
  } else {
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,phone,status,invite_token,invite_expires,invite_tipo)
      VALUES (?,?,?,?,'',?,0,?,?,'pendente',?,?,'convite')`)
      .run("u_" + randomUUID(), org.id, cleanName, mail, role, Date.now(), normalizePhone(phone), token, expires);
  }

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  const { subject, html } = inviteEmail({ name: cleanName, link, orgName: org.name });
  const out = await sendMail({ to: mail, subject, html });

  if (!out.sent) console.log(`[convite] link para ${mail} (${PAPEIS[role].rotulo}): ${link}`);
  // Sem provedor de e-mail configurado, devolvemos o link para a ADM repassar na mão.
  res.json({
    ok: true, emailSent: out.sent,
    precisaAprovacao: PAPEIS[role].precisaAprovacao,
    funcao: PAPEIS[role].rotulo,
    link: mailConfigured() ? undefined : link,
  });
});

// Valida o token do e-mail e devolve de quem é o convite (para a página mostrar o nome).
r.get("/invite/:token", (req, res) => {
  const u = db.prepare("SELECT name,email,role,invite_expires,invite_tipo,status FROM users WHERE invite_token = ?").get(req.params.token);
  if (!u) return res.status(404).json({ error: "Link inválido. Peça um novo cadastro." });
  const redefinicao = u.invite_tipo === "redefinicao";
  // Redefinição vale JUSTAMENTE para conta ativa — é quem esqueceu a senha.
  if (!redefinicao && u.status === "ativo")
    return res.status(409).json({ error: "Esse convite já foi usado. Faça login no CRM." });
  if (!u.invite_expires || u.invite_expires < Date.now())
    return res.status(410).json({ error: redefinicao
      ? "Este link de nova senha expirou. Peça outro à gestão."
      : "Link expirado. Faça o cadastro de novo para receber um link novo." });
  /* O fundador não passa por aprovação, e a página precisa saber disso para
     não prometer uma espera que não existe. */
  const fundador = u.invite_tipo === "fundador";
  res.json({ name: u.name, email: u.email, funcao: PAPEIS[u.role].rotulo, redefinicao, fundador,
    precisaAprovacao: redefinicao || fundador ? false : PAPEIS[u.role].precisaAprovacao });
});

// Define a senha e ativa a conta. Devolve o token de sessão já logado.
r.post("/set-password", (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });

  const u = db.prepare("SELECT * FROM users WHERE invite_token = ?").get(token);
  if (!u) return res.status(404).json({ error: "Link inválido." });
  const redefinicao = u.invite_tipo === "redefinicao";
  if (!redefinicao && u.status === "ativo") return res.status(409).json({ error: "Esse convite já foi usado." });
  if (!u.invite_expires || u.invite_expires < Date.now())
    return res.status(410).json({ error: redefinicao
      ? "Este link de nova senha expirou. Peça outro à gestão." : "Link expirado. Faça o cadastro de novo." });

  /* Trocar a senha NÃO mexe no status nem no papel. Quem já era ativo entra
     direto; quem estava aguardando aprovação continua aguardando — senão a
     redefinição viraria um atalho para pular o aval da gestão. */
  if (redefinicao) {
    db.prepare("UPDATE users SET pass_hash=?, invite_token=NULL, invite_expires=NULL, invite_tipo=NULL WHERE id=?")
      .run(bcrypt.hashSync(String(password), 10), u.id);
    const atual = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id);
    if (atual.status !== "ativo")
      return res.json({ aguardandoAprovacao: true, funcao: PAPEIS[atual.role].rotulo, user: publicUser(atual) });
    return res.json({ token: sign(atual), user: publicUser(atual), redefinicao: true });
  }

  /* Corretor entra direto. Atendente e gestor ficam aguardando o aval do gestor,
     porque esses papéis enxergam a operação inteira.

     O fundador é a exceção óbvia: ele é o gestor da imobiliária que ele mesmo
     acabou de criar, e não existe ninguém do outro lado para aprovar. Mandá-lo
     para a fila de aprovação seria trancar a porta com a chave dentro. */
  const fundador = u.invite_tipo === "fundador";
  /* O SÓCIO DA PLATAFORMA também entra direto, e por um motivo parecido: a
     aprovação dele JÁ ACONTECEU, no momento em que outro sócio o convidou pelo
     hub. Sem esta linha ele cairia em `aguardando_aprovacao` dentro de uma
     imobiliária qualquer — e ficaria preso lá para sempre, porque `semMaster`
     mantém o master fora da lista de equipe, que é onde o gestor aprova. Um
     convite que não dá para aceitar nem para recusar. */
  const socio = !!u.master;
  const novoStatus = fundador || socio || !PAPEIS[u.role].precisaAprovacao ? "ativo" : "aguardando_aprovacao";
  db.prepare("UPDATE users SET pass_hash=?, status=?, invite_token=NULL, invite_expires=NULL WHERE id=?")
    .run(bcrypt.hashSync(String(password), 10), novoStatus, u.id);

  /* O TESTE GRÁTIS DO AUTÔNOMO COMEÇA AQUI, e não na criação da conta.

     Pedido do Ali: o relógio só corre depois que a conta está efetivada. Criar
     a conta na segunda e mandar o link na quinta não pode custar três dias de
     teste a quem ainda não tinha entrado.

     Só o FUNDADOR dispara: quem entra depois é o atendente dele, e o teste da
     casa não recomeça porque chegou mais alguém. */
  if (fundador) {
    const casa = db.prepare("SELECT id, tipo, trial_ate FROM orgs WHERE id = ?").get(u.org_id);
    if (casa && casa.tipo === "autonomo" && !casa.trial_ate) {
      const ate = Date.now() + TRIAL_DIAS * 86400000;
      db.prepare("UPDATE orgs SET trial_ate = ? WHERE id = ?").run(ate, casa.id);
      console.log(`[autonomo] teste de ${TRIAL_DIAS} dias começou para ${u.name}`);
    }
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id);
  if (novoStatus === "aguardando_aprovacao")
    return res.json({ aguardandoAprovacao: true, funcao: PAPEIS[u.role].rotulo, user: publicUser(user) });
  /* Para o fundador, a resposta carrega o código da imobiliária e o link da
     equipe: é o momento em que ele precisa disso na mão, e é o que ele veio
     buscar aqui. */
  res.json({ token: sign(user), user: publicUser(user), org: orgDoUsuario(user),
    fundador, link_equipe: fundador ? linkDaEquipe(req, user) : undefined });
});

r.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(norm(email));
  if (!user) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  // Convite ainda não confirmado: sem senha definida, a mensagem precisa apontar o caminho certo.
  if (user.status === "pendente" || !user.pass_hash)
    return res.status(403).json({ error: "Sua conta ainda não foi confirmada. Abra o link que enviamos no seu e-mail e crie sua senha." });
  if (!bcrypt.compareSync(password || "", user.pass_hash))
    return res.status(401).json({ error: "E-mail ou senha incorretos." });
  // Só entra quem está ativo. Qualquer outro estado tem sua própria explicação.
  if (user.status !== "ativo") {
    const motivos = {
      aguardando_aprovacao: `Seu cadastro como ${PAPEIS[user.role].rotulo} está aguardando a aprovação da gestão. Você será avisado assim que for liberado.`,
      recusado: "Seu acesso não foi liberado. Fale com a gestão da sua imobiliária.",
      removido: "Seu acesso foi encerrado. Fale com a gestão da sua imobiliária.",
    };
    return res.status(403).json({ error: motivos[user.status] || "Sua conta não está ativa. Fale com a gestão da sua imobiliária." });
  }
  res.json({ token: sign(user), user: publicUser(user), org: orgDoUsuario(user) });
});

r.get("/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "Não encontrado" });
  /* A imobiliária vem do TOKEN, não do cadastro da pessoa. Para quase todo
     mundo dá no mesmo; para o master é a diferença entre "a casa dele" e "a
     casa em que ele está trabalhando agora", escolhida no hub de contas. */
  const org = db.prepare("SELECT id,name,adm_code,logo_url,cor_barra,tipo FROM orgs WHERE id = ?").get(req.user.org_id);
  res.json({ user: publicUser(user),
    org: org ? { id: org.id, nome: org.name, codigo: org.adm_code, tipo: org.tipo || "imobiliaria", ...marcaDaOrg(org) } : null });
});

// ── Minha conta ───────────────────────────────────────────────────────────────
// Cada pessoa cuida dos próprios dados. Nada aqui depende de papel: corretor,
// atendente e gestor têm exatamente as mesmas opções.

r.patch("/me", authRequired, (req, res) => {
  const { name, email, phone } = req.body || {};
  const eu = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!eu) return res.status(404).json({ error: "Conta não encontrada" });

  const nome = String(name ?? eu.name).trim();
  if (nome.length < 2) return res.status(400).json({ error: "Informe seu nome completo." });

  const mail = norm(email ?? eu.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: "E-mail inválido." });
  if (mail !== eu.email && db.prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?").get(mail, eu.id))
    return res.status(409).json({ error: "Já existe outra conta com esse e-mail." });

  const fone = phone === undefined ? eu.phone : normalizePhone(phone);

  db.prepare("UPDATE users SET name=?, email=?, phone=? WHERE id=?").run(nome, mail, fone, eu.id);
  const atualizado = db.prepare("SELECT * FROM users WHERE id = ?").get(eu.id);
  // O nome viaja dentro do token e é ele que assina as mensagens no WhatsApp —
  // então trocar o nome exige um token novo, senão as mensagens sairiam com o antigo.
  res.json({ token: sign(atualizado), user: publicUser(atualizado) });
});

/* Recolher ou abrir a barra lateral. `POST /auth/me/barra`

   Rota própria em vez de entrar no PATCH /me: aquele valida nome, e-mail e
   telefone e devolve um TOKEN NOVO, porque o nome viaja dentro dele e assina
   as mensagens no WhatsApp. Recolher uma barra não pode passar por nada
   disso — seria um clique de layout capaz de derrubar a sessão de quem
   estivesse com o cadastro pela metade. */
r.post("/me/barra", authRequired, (req, res) => {
  const recolhida = req.body?.recolhida ? 1 : 0;
  db.prepare("UPDATE users SET barra_recolhida=? WHERE id=?").run(recolhida, req.user.id);
  res.json({ barra_recolhida: !!recolhida });
});

r.post("/me/senha", authRequired, (req, res) => {
  const { atual, nova } = req.body || {};
  const eu = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!eu) return res.status(404).json({ error: "Conta não encontrada" });
  if (!bcrypt.compareSync(String(atual || ""), eu.pass_hash))
    return res.status(403).json({ error: "A senha atual não confere." });
  if (!nova || String(nova).length < 6)
    return res.status(400).json({ error: "A nova senha precisa ter pelo menos 6 caracteres." });
  if (bcrypt.compareSync(String(nova), eu.pass_hash))
    return res.status(400).json({ error: "A nova senha é igual à atual." });

  db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(bcrypt.hashSync(String(nova), 10), eu.id);
  res.json({ ok: true });
});

r.post("/me/foto", authRequired, async (req, res) => {
  const { mime, base64 } = req.body || {};
  if (!mime || !base64) return res.status(400).json({ error: "Escolha uma imagem." });
  if (ehVideo(mime) || !tipoPermitido(mime))
    return res.status(400).json({ error: "Use uma imagem JPG, PNG ou WEBP." });

  const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  if (buffer.length > 4 * 1024 * 1024)
    return res.status(413).json({ error: "Imagem muito grande. O limite é 4 MB." });

  const eu = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  try {
    const { url, chave } = await salvar({ buffer, mime, prefixo: `perfil/${eu.id}` });
    if (eu.avatar_key) apagar(eu.avatar_key); // não acumula foto antiga
    db.prepare("UPDATE users SET avatar_url=?, avatar_key=? WHERE id=?").run(url, chave, eu.id);
    res.json({ ok: true, avatar_url: url });
  } catch (e) {
    console.error("[perfil] falha ao salvar foto:", e.message);
    res.status(500).json({ error: "Não consegui guardar a foto. Tente de novo." });
  }
});

r.delete("/me/foto", authRequired, (req, res) => {
  const eu = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (eu.avatar_key) apagar(eu.avatar_key);
  db.prepare("UPDATE users SET avatar_url=NULL, avatar_key=NULL WHERE id=?").run(eu.id);
  res.json({ ok: true });
});

// Quem já se cadastrou. Gestor e atendente acompanham as confirmações e aprovações.
// Traz também quantos leads a pessoa tem em aberto — é o que a gestão precisa saber
// antes de remover alguém: esses leads têm que ir para algum lugar.
r.get("/users", authRequired, roles("adm", "sdr"), (req, res) => {
  // A tela mostra quem está disponível — precisa refletir o corte das 18:00
  // mesmo que ninguém tenha aberto a catraca desde ontem.
  try { aplicarCorte(req.user.org_id); } catch (e) {}
  const rows = db.prepare(`
    SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.available,u.created_at,u.avatar_url,
      (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
        AND l.stage NOT IN ('Venda','Perdido')) AS leads_abertos
    FROM users u WHERE u.org_id = ?${semMaster("u")} ORDER BY u.created_at DESC`).all(req.user.org_id);
  res.json(rows.map(u => ({ ...u, available: !!u.available, funcao: PAPEIS[u.role].rotulo })));
});

// Só o gestor mexe em outro gestor — senão um atendente poderia desligar a
// própria chefia ou se promover aprovando um gestor cúmplice.
function podeMexer(autor, alvo) {
  if (alvo.role === "adm" && autor.role !== "adm") return "Só um gestor pode alterar outro gestor.";
  if (alvo.id === autor.id) return "Você não pode alterar a própria conta por aqui.";
  return null;
}

// Aprovação de atendente/gestor. Só quem já supervisiona pode liberar outro
// supervisor — o corretor nunca passa por aqui, ele entra direto pelo link.
// Aprovar serve também para reativar quem foi recusado ou removido.
r.post("/users/:id/aprovar", authRequired, roles("adm", "sdr"), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  const impedimento = podeMexer(req.user, u);
  if (impedimento) return res.status(403).json({ error: impedimento });
  if (u.status === "ativo") return res.status(409).json({ error: "Esse cadastro já está ativo." });
  if (u.status === "pendente") return res.status(409).json({ error: "Essa pessoa ainda não confirmou o e-mail e criou a senha." });
  db.prepare("UPDATE users SET status = 'ativo' WHERE id = ?").run(u.id);
  res.json({ ok: true, nome: u.name, funcao: PAPEIS[u.role].rotulo });
});

/* Link de nova senha, gerado pela gestão.

   Existe porque o e-mail ainda não está ligado e alguém sempre esquece a
   senha. O gestor gera o link e manda no WhatsApp; a pessoa abre a MESMA
   página de sempre e escolhe a senha nova.

   Só o gestor: com este link se entra na conta de outra pessoa, então não é
   coisa para a atendente nem para o corretor emitirem.

   Vale 24 horas, e não 7 dias como o convite. Convite fica parado esperando
   alguém se cadastrar; este aqui é para usar agora, e link de acesso que
   sobra numa conversa de WhatsApp por uma semana é risco à toa.

   Gerar um link novo INVALIDA o anterior — é o mesmo campo. Isso é proposital:
   se o gestor gerou dois por engano, só o último funciona. */
const REDEFINICAO_HORAS = 24;

/* ===== "ESQUECI MINHA SENHA" ===== (02/09/2026, pedido do Ali)

   Até aqui a única forma de recuperar senha era pedir ao gestor, que gerava um
   link em Equipe → Nova senha e repassava no WhatsApp. Isso funcionava porque
   não havia e-mail configurado. Com o Resend ligado, manter o caminho manual
   seria continuar dependendo de alguém estar acordado — e a pessoa que mais
   precisa disso é justamente quem tenta entrar às 22h de um domingo.

   ===== A RESPOSTA É SEMPRE A MESMA =====

   Existindo ou não a conta, esta rota responde 200 com a mesma frase. É a
   trava principal, e ela não é decoração: qualquer diferença — mensagem,
   código HTTP, até o tempo de resposta — transforma a rota num CONSULTOR DE
   E-MAILS. Quem quisesse saber quais dos seus clientes usam o ConHub bastaria
   ir testando endereços aqui até a resposta mudar.

   Pelo mesmo motivo, conta removida, recusada ou que nunca definiu senha
   também recebe a mesma resposta — e nenhum e-mail.

   ===== O FREIO É DUPLO =====

   Por IP (impede a varredura) e por E-MAIL (impede usar o ConHub para encher a
   caixa de alguém: sem ele, um laço manda mil e-mails para o mesmo endereço em
   nome da nossa marca, e quem paga a conta do domínio queimado somos nós).
   Em memória de propósito, igual ao freio de `/publico/comecar`: some no
   reinício, e o objetivo é impedir a enxurrada, não guardar cadastro de
   infrator. */
const JANELA_SENHA = 60 * 60 * 1000;
const TETO_IP = 10;      // uma pessoa tentando de verdade não chega perto
const TETO_EMAIL = 3;    // três links por hora para o mesmo endereço já é muito
const pedidosDeSenha = new Map();

function podePedirSenha(chave, teto) {
  const agora = Date.now();
  const lista = (pedidosDeSenha.get(chave) || []).filter(t => agora - t < JANELA_SENHA);
  if (lista.length >= teto) { pedidosDeSenha.set(chave, lista); return false; }
  lista.push(agora);
  pedidosDeSenha.set(chave, lista);
  if (pedidosDeSenha.size > 5000)
    for (const [k, ts] of pedidosDeSenha)
      if (!ts.some(t => agora - t < JANELA_SENHA)) pedidosDeSenha.delete(k);
  return true;
}

r.post("/esqueci-senha", async (req, res) => {
  const email = norm(req.body?.email);
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress || "sem-ip";

  /* A MESMA FRASE PARA TUDO — inclusive para o freio. Dizer "muitas
     tentativas para este e-mail" já contaria que o e-mail existe. */
  const resposta = { ok: true, mensagem:
    "Se existir uma conta com esse e-mail, o link para criar uma senha nova acabou de ser enviado. Confira a caixa de entrada e o spam." };

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: "Confira o e-mail: parece que falta alguma coisa." });

  if (!podePedirSenha("ip:" + ip, TETO_IP) || !podePedirSenha("em:" + email, TETO_EMAIL))
    return res.json(resposta);

  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  /* Sem senha definida a pessoa nunca ativou a conta: o caminho dela é o
     convite, não a redefinição. Responder igual mantém a rota calada sobre em
     que estado a conta está — e o convite original continua valendo. */
  if (!u || u.status !== "ativo" || !u.pass_hash) {
    console.log(`[senha] pedido de redefinição para ${email} — sem conta ativa, nada enviado`);
    return res.json(resposta);
  }

  const token = newToken();
  const expires = Date.now() + REDEFINICAO_HORAS * 3600000;
  db.prepare("UPDATE users SET invite_token=?, invite_expires=?, invite_tipo='redefinicao' WHERE id=?")
    .run(token, expires, u.id);

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  if (mailConfigured()) {
    try {
      const { subject, html } = senhaEmail({ name: u.name, link, horas: REDEFINICAO_HORAS });
      await sendMail({ to: u.email, subject, html });
    } catch (e) { console.error("[senha] não consegui enviar o e-mail:", e.message); }
  }
  /* O link vai para o LOG e nunca para a resposta. Devolvê-lo aqui entregaria
     a chave da conta a quem só digitou o endereço de e-mail de outra pessoa —
     é exatamente o contrário do que esta rota existe para fazer. Na rota do
     gestor ele volta porque lá quem pede já está logado e é o dono da casa. */
  console.log(`[senha] link de redefinição para ${u.email}: ${link}`);
  res.json(resposta);
});

r.post("/users/:id/redefinir-senha", authRequired, roles("adm"), async (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  if (u.id === req.user.id)
    return res.status(400).json({ error: "Para trocar a sua própria senha, use Minha conta." });
  if (u.status === "removido" || u.status === "recusado")
    return res.status(409).json({ error: "Essa pessoa não está mais na equipe. Aprove o cadastro antes." });

  const token = newToken();
  const expires = Date.now() + REDEFINICAO_HORAS * 3600000;
  db.prepare("UPDATE users SET invite_token=?, invite_expires=?, invite_tipo='redefinicao' WHERE id=?")
    .run(token, expires, u.id);

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  /* Manda por e-mail SE estiver configurado, e devolve o link de qualquer
     jeito. Quando o Resend entrar, isto passa a funcionar sozinho sem trocar
     uma linha; enquanto não entra, a gestão repassa na mão. */
  let enviado = false;
  if (mailConfigured()) {
    try {
      const { subject, html } = inviteEmail({ name: u.name, link, orgName: "sua imobiliária" });
      const out = await sendMail({ to: u.email, subject: subject.replace(/convite/i, "nova senha"), html });
      enviado = !!out.sent;
    } catch (e) { console.error("[senha] não consegui enviar o e-mail:", e.message); }
  }
  console.log(`[senha] link de nova senha para ${u.email}: ${link}`);
  res.json({ ok: true, nome: u.name, email: u.email, link, email_enviado: enviado, horas: REDEFINICAO_HORAS });
});

r.post("/users/:id/recusar", authRequired, roles("adm", "sdr"), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  const impedimento = podeMexer(req.user, u);
  if (impedimento) return res.status(403).json({ error: impedimento });
  db.prepare("UPDATE users SET status = 'recusado', available = 0 WHERE id = ?").run(u.id);
  res.json({ ok: true, nome: u.name });
});

// Troca a função de um cadastro (ex.: promover a corretora a atendente).
// Um atendente não pode criar nem alterar gestor — seria escalar o próprio poder.
r.post("/users/:id/funcao", authRequired, roles("adm", "sdr"), (req, res) => {
  const novo = papelDoFormulario(req.body && req.body.funcao);
  if (!novo) return res.status(400).json({ error: "Função inválida. Use corretor, atendente ou gestor." });
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  const impedimento = podeMexer(req.user, u);
  if (impedimento) return res.status(403).json({ error: impedimento });
  if (novo === "adm" && req.user.role !== "adm")
    return res.status(403).json({ error: "Só um gestor pode promover alguém a gestor." });
  if (u.role === novo) return res.json({ ok: true, funcao: PAPEIS[novo].rotulo, sem_mudanca: true });

  // Gestor não entra na catraca; ao virar gestor, sai da fila de distribuição.
  db.prepare("UPDATE users SET role = ?, available = CASE WHEN ? = 'adm' THEN 0 ELSE available END WHERE id = ?")
    .run(novo, novo, u.id);
  res.json({ ok: true, nome: u.name, funcao: PAPEIS[novo].rotulo });
});

// Apagar de vez. Só depois de removido — é uma porta de duas etapas de propósito.
// O histórico de conversa sobrevive: as mensagens guardam o nome de quem enviou
// (from_name), então quem lê a conversa antiga continua entendendo quem falou.
r.delete("/users/:id", authRequired, roles("adm"), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  if (u.id === req.user.id) return res.status(400).json({ error: "Você não pode apagar a própria conta." });
  /* CONVITE QUE NUNCA VIROU CONTA some direto.

     A regra "remova da equipe primeiro" existe para proteger o histórico: quem
     atendeu aparece nas conversas e nos relatórios, e apagar de uma vez
     quebraria isso. Só que ela vinha valendo também para quem NUNCA definiu
     senha nem entrou — e aí não há histórico nenhum para proteger.

     Na prática isso deixava a conta de teste presa na tela para sempre: a tela
     não oferece "Remover" para quem não está ativo, e o servidor não deixava
     apagar quem não tinha sido removido. Duas metades que não se encontravam. */
  const nuncaEntrou = u.status === "pendente" || u.status === "recusado";
  if (u.status !== "removido" && !nuncaEntrou)
    return res.status(409).json({ error: "Remova a pessoa da equipe primeiro. Apagar é o passo seguinte." });

  const apagar = db.transaction(() => {
    // Leads que ainda estivessem com ela voltam para a fila, nunca somem.
    db.prepare("UPDATE leads SET assigned_to = NULL WHERE assigned_to = ?").run(u.id);
    db.prepare("UPDATE messages SET from_user_id = NULL WHERE from_user_id = ?").run(u.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
  });
  apagar();
  res.json({ ok: true, nome: u.name });
});

// Remover da equipe. NÃO apaga o cadastro: desativa. Apagar de verdade quebraria
// o histórico — as conversas e os relatórios apontam para quem atendeu.
// Os leads em aberto precisam de destino, senão o cliente fica esperando sozinho.
r.post("/users/:id/remover", authRequired, roles("adm", "sdr"), (req, res) => {
  const { destino_leads } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  const impedimento = podeMexer(req.user, u);
  if (impedimento) return res.status(403).json({ error: impedimento });

  /* Nunca deixar a organização sem gestor ativo.

     Só vale para quem ESTÁ ativo: tirar da equipe um gestor que nunca
     confirmou o e-mail não muda a cobertura da imobiliária em nada, e a trava
     impedia justamente isso — inclusive quando o único gestor ativo era o
     master, que `semMaster` não conta. */
  if (u.role === "adm" && u.status === "ativo") {
    const gestores = db.prepare(`SELECT COUNT(*) n FROM users u WHERE u.org_id=? AND u.role='adm' AND u.status='ativo'${semMaster("u")}`).get(req.user.org_id).n;
    if (gestores <= 1) return res.status(409).json({ error: "Esse é o único gestor ativo. Promova ou aprove outro antes de remover." });
  }

  /* E O TITULAR DA CONTA NUNCA SAI. (02/09/2026)

     A trava acima conta GESTORES ativos, e ela deixou de cobrir o titular no
     dia em que o corretor autônomo passou a ser `corretor`: numa casa dessas
     não existe nenhum `adm`, então a contagem dá zero e a trava nem dispara.
     Removê-lo deixaria a conta sem dono — sem quem responda pela mensalidade,
     sem quem configure e sem caminho de volta pela tela.

     Vale para os dois tipos de conta: numa imobiliária o titular também é quem
     paga, e perdê-lo é o mesmo estrago com outro nome. */
  const casa = db.prepare("SELECT dono_user_id FROM orgs WHERE id = ?").get(req.user.org_id);
  if (casa && casa.dono_user_id && casa.dono_user_id === u.id)
    return res.status(409).json({
      error: "Essa pessoa é a titular da conta — é quem responde pela mensalidade. Para trocar o titular, fale com o ConHub." });

  let destino = null;
  if (destino_leads) {
    destino = db.prepare(`SELECT * FROM users u WHERE u.id=? AND u.org_id=? AND u.status='ativo' AND u.role IN ('corretor','sdr')${semMaster("u")}`).get(destino_leads, req.user.org_id);
    if (!destino) return res.status(404).json({ error: "Escolha um atendente ativo para receber os leads." });
  }

  const abertos = db.prepare("SELECT COUNT(*) n FROM leads WHERE assigned_to=? AND stage NOT IN ('Venda','Perdido')").get(u.id).n;
  // Leads fechados ficam com ele, para o histórico e os relatórios continuarem certos.
  db.prepare("UPDATE leads SET assigned_to=? WHERE assigned_to=? AND stage NOT IN ('Venda','Perdido')")
    .run(destino ? destino.id : null, u.id);
  db.prepare("UPDATE users SET status='removido', available=0 WHERE id=?").run(u.id);

  res.json({ ok: true, nome: u.name, leads_movidos: abertos, destino: destino ? destino.name : "fila da catraca" });
});

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
           funcao: PAPEIS[u.role].rotulo, org_id: u.org_id, status: u.status,
           available: !!u.available, avatar_url: u.avatar_url || null,
           // Preferência de tela: a barra lateral nasce recolhida ou aberta.
           barra_recolhida: !!u.barra_recolhida,
           /* PODE GERIR A PRÓPRIA CASA sem ser `adm`. (02/09/2026)

              É o corretor autônomo: o papel dele é `corretor`, porque é isso
              que faz a catraca entregar lead e o nome dele aparecer no score —
              mas ele é o dono e precisa configurar o WhatsApp, o funil e a
              assinatura, porque não existe mais ninguém na conta.

              Vem do SERVIDOR e não é deduzido na tela: quem decide permissão é
              quem a aplica, e uma segunda dedução no navegador seria uma
              segunda verdade sobre quem pode o quê. */
           gestor: u.role === "adm" || ehDonoAutonomo({ id: u.id, org_id: u.org_id }),
           // A própria pessoa sabe que é master; a equipe nunca a vê na lista.
           master: !!u.master };
}

export default r;
