import jwt from "jsonwebtoken";
import db from "./db.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

/* `orgId` existe para o gestor master trocar de imobiliária sem trocar de
   conta: o token passa a valer para a imobiliária escolhida, e todas as rotas
   continuam lendo req.user.org_id como sempre — nenhuma precisou mudar.

   Só o master usa isso. Para qualquer outra pessoa o org_id é o da conta dela,
   e quem emite o token é o login, não o usuário. */
export function sign(user, { orgId } = {}) {
  return jwt.sign({ id: user.id, role: user.role, org_id: orgId || user.org_id,
    name: user.name, master: !!user.master }, SECRET, { expiresIn: "30d" });
}

export function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado" });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

/* O CORRETOR AUTÔNOMO É AS DUAS COISAS. (02/09/2026)

   Na casa de uma pessoa só, ele é o corretor E o gestor: atende os leads e
   também configura o WhatsApp, monta o funil e paga a conta. Até hoje ele era
   criado como `adm`, e isso o deixava de fora de tudo que procura corretor —
   a catraca, o rodízio, o score, o relatório de produtividade. Ele pagava por
   um CRM cujo relatório principal nunca teria o nome dele.

   Agora ele nasce `corretor`, que é o papel que faz o sistema enxergá-lo
   trabalhando, e ganha o acesso de gestor POR SER O DONO — aqui, num lugar só.

   Por que aqui e não em cada rota: são dezenas de `roles("adm")` espalhadas, e
   liberar uma a uma deixaria a esquecida barrando o próprio dono da conta em
   silêncio. É a mesma razão de `semMaster` existir.

   E é SÓ O DONO. O atendente que ele contratar continua sendo atendente: a
   conta é de uma pessoa, mas a permissão de gestor é de UMA pessoa, não de
   quem estiver dentro dela. */
export function ehDonoAutonomo(user) {
  if (!user || !user.org_id || !user.id) return false;
  const org = db.prepare("SELECT tipo, dono_user_id FROM orgs WHERE id = ?").get(user.org_id);
  return !!org && org.tipo === "autonomo" && org.dono_user_id === user.id;
}

// Restringe a rota a determinados papéis. Ex: roles("adm","sdr")
export function roles(...allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.user.role)) return next();
    /* A conferência vai ao BANCO e não ao crachá: o token dura 30 dias, e quem
       deixasse de ser dono continuaria com o acesso por um mês. Mesma decisão
       do `porteiro` com o master. */
    if (allowed.includes("adm") && ehDonoAutonomo(req.user)) return next();
    return res.status(403).json({ error: "Sem permissão" });
  };
}

/* Gestor MASTER: quem mantém a plataforma, não quem trabalha na imobiliária.

   Ele tem o acesso de um gestor, mas some de tudo que a equipe enxerga —
   lista de pessoas, catraca, relatórios, ranking, campo de captador. Para a
   Conecta ele simplesmente não existe.

   `semMaster` é o pedaço de SQL que faz isso. Fica aqui, num lugar só, porque
   a regra tem que valer em toda consulta que lista gente: esquecer de um único
   SELECT é o master reaparecendo na tela do corretor.

   Uso: `... WHERE u.org_id = ? ${semMaster("u")}` */
export const semMaster = (alias = "u") => ` AND COALESCE(${alias}.master, 0) = 0`;

/* Trava das rotas da plataforma (hub de contas, criar imobiliária).

   Confere no BANCO, não só no token. O token é assinado por nós e é confiável,
   mas dura 30 dias: se um master for despromovido hoje, o crachá antigo
   continuaria abrindo a plataforma inteira até o mês que vem. */
export function soMaster(req, res, next) {
  const u = db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id);
  if (!u || !u.master) return res.status(403).json({ error: "Área restrita ao ConHub." });
  next();
}

// Quem enxerga e comanda a operação inteira: gestor (adm) e atendente (sdr).
// O atendente tem o mesmo alcance do gestor — por isso o cadastro dele precisa
// de aprovação, diferente do corretor, que entra direto pelo link.
/* Quem enxerga a casa inteira, e não só o que está no próprio nome.

   O DONO DA CONTA AUTÔNOMA entra aqui (02/09/2026) mesmo sendo `corretor`.
   Sem isso, o lead que estivesse com o atendente dele ficaria invisível para
   ele — o titular da conta sem acesso ao atendimento que ele paga para
   existir. A casa é dele; a supervisão da casa também.

   A conferência vai ao banco, e é um `SELECT` por id: barato o bastante para
   valer em toda checagem, e é o preço de a regra morar num lugar só. */
export const supervisiona = (user) =>
  user.role === "adm" || user.role === "sdr" || ehDonoAutonomo(user);

/* Quem pode mexer NESTE lead.

   A conta é multi-imobiliária: cada uma é uma organização, e a supervisão de
   uma NÃO pode alcançar o lead da outra. Por isso a comparação de org_id vive
   aqui, num lugar só — antes cada rota escrevia a sua checagem, e as rotas de
   mensagem tinham esquecido a parte da organização: a gestão de uma
   imobiliária conseguia escrever na conversa de outra se soubesse o id do
   lead. O corretor sempre esteve preso ao que é dele. */
export const podeVerLead = (user, lead) => {
  if (!lead) return false;
  if (supervisiona(user)) return lead.org_id === user.org_id;
  return lead.assigned_to === user.id;
};

// Nomes que aparecem para o usuário. Internamente os papéis continuam
// adm/sdr/corretor para não quebrar o banco e as rotas existentes.
// Todo cadastro passa pela gestão — inclusive corretor. Quem entra vê conversa
// de cliente, então ninguém é liberado sozinho.
export const PAPEIS = {
  corretor: { rotulo: "Corretor(a)", precisaAprovacao: true },
  sdr:      { rotulo: "Atendente",   precisaAprovacao: true },
  adm:      { rotulo: "Gestor(a)",   precisaAprovacao: true },
};
export const papelDoFormulario = (v) => ({ corretor: "corretor", atendente: "sdr", gestor: "adm" }[String(v || "").toLowerCase()]);
