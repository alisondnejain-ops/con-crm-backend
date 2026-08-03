import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, org_id: user.org_id, name: user.name, master: !!user.master },
    SECRET, { expiresIn: "30d" });
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

// Restringe a rota a determinados papéis. Ex: roles("adm","sdr")
export function roles(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: "Sem permissão" });
    next();
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

// Quem enxerga e comanda a operação inteira: gestor (adm) e atendente (sdr).
// O atendente tem o mesmo alcance do gestor — por isso o cadastro dele precisa
// de aprovação, diferente do corretor, que entra direto pelo link.
export const supervisiona = (user) => user.role === "adm" || user.role === "sdr";

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
