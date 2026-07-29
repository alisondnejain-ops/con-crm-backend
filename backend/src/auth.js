import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, org_id: user.org_id, name: user.name }, SECRET, { expiresIn: "30d" });
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

// Quem enxerga e comanda a operação inteira: gestor (adm) e atendente (sdr).
// O atendente tem o mesmo alcance do gestor — por isso o cadastro dele precisa
// de aprovação, diferente do corretor, que entra direto pelo link.
export const supervisiona = (user) => user.role === "adm" || user.role === "sdr";

// Nomes que aparecem para o usuário. Internamente os papéis continuam
// adm/sdr/corretor para não quebrar o banco e as rotas existentes.
export const PAPEIS = {
  corretor: { rotulo: "Corretor(a)", precisaAprovacao: false },
  sdr:      { rotulo: "Atendente",   precisaAprovacao: true },
  adm:      { rotulo: "Gestor(a)",   precisaAprovacao: true },
};
export const papelDoFormulario = (v) => ({ corretor: "corretor", atendente: "sdr", gestor: "adm" }[String(v || "").toLowerCase()]);
