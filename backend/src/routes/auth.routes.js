import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "crypto";
import db from "../db.js";
import { sign, authRequired, roles, supervisiona, PAPEIS, papelDoFormulario } from "../auth.js";
import { normalizePhone } from "../services/stages.js";
import { sendMail, mailConfigured, inviteEmail } from "../services/mail.js";

const r = Router();
const INVITE_DAYS = 7;

// URL pública deste backend — usada para montar o link "definir senha" do e-mail.
const appUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const newToken = () => randomBytes(24).toString("hex");
const norm = (e) => String(e || "").trim().toLowerCase();

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
  if (!org) return res.status(403).json({ error: "Código da imobiliária inválido. Peça o código à ADM da Conecta." });

  const mail = norm(email);
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(mail);
  if (existing && existing.status === "ativo")
    return res.status(409).json({ error: "Esse e-mail já tem conta ativa. Use 'Entrar' no CRM." });

  const token = newToken();
  const expires = Date.now() + INVITE_DAYS * 86400000;
  const cleanName = String(name).trim();

  if (existing) {
    db.prepare("UPDATE users SET name=?, phone=?, role=?, invite_token=?, invite_expires=? WHERE id=?")
      .run(cleanName, normalizePhone(phone), role, token, expires, existing.id);
  } else {
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,phone,status,invite_token,invite_expires)
      VALUES (?,?,?,?,'',?,0,?,?,'pendente',?,?)`)
      .run("u_" + randomUUID(), org.id, cleanName, mail, role, Date.now(), normalizePhone(phone), token, expires);
  }

  const link = `${appUrl(req)}/definir-senha?token=${token}`;
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
  const u = db.prepare("SELECT name,email,role,invite_expires,status FROM users WHERE invite_token = ?").get(req.params.token);
  if (!u) return res.status(404).json({ error: "Link inválido. Peça um novo cadastro." });
  if (u.status === "ativo") return res.status(409).json({ error: "Esse convite já foi usado. Faça login no CRM." });
  if (!u.invite_expires || u.invite_expires < Date.now())
    return res.status(410).json({ error: "Link expirado. Faça o cadastro de novo para receber um link novo." });
  res.json({ name: u.name, email: u.email, funcao: PAPEIS[u.role].rotulo, precisaAprovacao: PAPEIS[u.role].precisaAprovacao });
});

// Define a senha e ativa a conta. Devolve o token de sessão já logado.
r.post("/set-password", (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });

  const u = db.prepare("SELECT * FROM users WHERE invite_token = ?").get(token);
  if (!u) return res.status(404).json({ error: "Link inválido." });
  if (u.status === "ativo") return res.status(409).json({ error: "Esse convite já foi usado." });
  if (!u.invite_expires || u.invite_expires < Date.now())
    return res.status(410).json({ error: "Link expirado. Faça o cadastro de novo." });

  // Corretor entra direto. Atendente e gestor ficam aguardando o aval do gestor,
  // porque esses papéis enxergam a operação inteira.
  const novoStatus = PAPEIS[u.role].precisaAprovacao ? "aguardando_aprovacao" : "ativo";
  db.prepare("UPDATE users SET pass_hash=?, status=?, invite_token=NULL, invite_expires=NULL WHERE id=?")
    .run(bcrypt.hashSync(String(password), 10), novoStatus, u.id);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id);
  if (novoStatus === "aguardando_aprovacao")
    return res.json({ aguardandoAprovacao: true, funcao: PAPEIS[u.role].rotulo, user: publicUser(user) });
  res.json({ token: sign(user), user: publicUser(user) });
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
  if (user.status === "aguardando_aprovacao")
    return res.status(403).json({ error: `Seu cadastro como ${PAPEIS[user.role].rotulo} está aguardando a aprovação da gestão. Você será avisado assim que for liberado.` });
  if (user.status === "recusado")
    return res.status(403).json({ error: "Seu acesso não foi liberado. Fale com a gestão da Conecta." });
  res.json({ token: sign(user), user: publicUser(user) });
});

r.get("/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "Não encontrado" });
  res.json({ user: publicUser(user) });
});

// Quem já se cadastrou. Gestor e atendente acompanham as confirmações e aprovações.
r.get("/users", authRequired, roles("adm", "sdr"), (req, res) => {
  const rows = db.prepare(
    "SELECT id,name,email,phone,role,status,available,created_at FROM users WHERE org_id = ? ORDER BY created_at DESC"
  ).all(req.user.org_id);
  res.json(rows.map(u => ({ ...u, available: !!u.available, funcao: PAPEIS[u.role].rotulo })));
});

// Aprovação de atendente/gestor. Só quem já supervisiona pode liberar outro
// supervisor — o corretor nunca passa por aqui, ele entra direto pelo link.
r.post("/users/:id/aprovar", authRequired, roles("adm", "sdr"), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  if (u.status !== "aguardando_aprovacao" && u.status !== "recusado")
    return res.status(409).json({ error: "Esse cadastro não está aguardando aprovação." });
  db.prepare("UPDATE users SET status = 'ativo' WHERE id = ?").run(u.id);
  res.json({ ok: true, nome: u.name, funcao: PAPEIS[u.role].rotulo });
});

r.post("/users/:id/recusar", authRequired, roles("adm", "sdr"), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  if (u.id === req.user.id) return res.status(400).json({ error: "Você não pode recusar a própria conta." });
  db.prepare("UPDATE users SET status = 'recusado' WHERE id = ?").run(u.id);
  res.json({ ok: true, nome: u.name });
});

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
           funcao: PAPEIS[u.role].rotulo, org_id: u.org_id, status: u.status, available: !!u.available };
}

export default r;
