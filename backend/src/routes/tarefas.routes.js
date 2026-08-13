/* Tarefas agendadas de um lead.

   "Ligar terça de manhã", "levar a pasta na Caixa", "confirmar a visita de
   sábado". Antes isso vivia na cabeça do corretor ou num papel na mesa: a
   gestão não tinha como saber o que estava combinado sem perguntar, e o
   corretor não tinha onde olhar de manhã.

   Deliberadamente pequeno. Não é agenda, não tem repetição, não tem lembrete
   por e-mail: é um compromisso com data e hora, preso ao lead, que dá para
   marcar como feito. O que interessa no card do funil é uma coisa só — tem
   tarefa marcada, e ela já venceu?

   A tarefa nasce de quem está com o lead, mas a supervisão também marca: é
   comum o gestor combinar algo na reunião e precisar deixar registrado para o
   corretor. */

import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, podeVerLead } from "../auth.js";

const r = Router();
r.use(authRequired);

const doLead = (id) => db.prepare("SELECT * FROM leads WHERE id = ?").get(id);

export const listar = (leadId) => db.prepare(`
  SELECT t.id, t.titulo, t.quando, t.feito_em, t.user_id, u.name AS de_quem
  FROM tarefas t LEFT JOIN users u ON u.id = t.user_id
  WHERE t.lead_id = ? ORDER BY t.feito_em IS NOT NULL, t.quando ASC`).all(leadId);

r.get("/leads/:id/tarefas", (req, res) => {
  const lead = doLead(req.params.id);
  if (!podeVerLead(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  res.json({ tarefas: listar(lead.id) });
});

r.post("/leads/:id/tarefas", (req, res) => {
  const lead = doLead(req.params.id);
  if (!podeVerLead(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const titulo = String(req.body?.titulo || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!titulo) return res.status(400).json({ error: "Escreva o que precisa ser feito." });

  /* Sem data a tarefa vira lista de desejos: some no meio das outras e ninguém
     sabe quando cobrar. A data é o que a torna cobrável. */
  const quando = new Date(req.body?.quando || "").getTime();
  if (!isFinite(quando)) return res.status(400).json({ error: "Informe o dia e a hora da tarefa." });

  /* A tarefa é de quem está com o lead, não de quem a escreveu. O gestor que
     combina algo na reunião está criando trabalho para o corretor — se ficasse
     no nome do gestor, não apareceria para quem tem que fazer. */
  const dono = lead.assigned_to || req.user.id;
  const id = "tf_" + randomUUID();
  db.prepare(`INSERT INTO tarefas (id,org_id,lead_id,user_id,criado_por,titulo,quando,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, lead.org_id, lead.id, dono, req.user.id, titulo, quando, Date.now());
  res.json({ ok: true, tarefas: listar(lead.id) });
});

// Marcar como feita, desmarcar, ou mudar o texto e a data.
r.patch("/tarefas/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM tarefas WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Tarefa não encontrada." });
  const lead = doLead(t.lead_id);
  if (!podeVerLead(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const campos = [], valores = [];
  if (req.body?.feito !== undefined) { campos.push("feito_em = ?"); valores.push(req.body.feito ? Date.now() : null); }
  if (req.body?.titulo !== undefined) {
    const titulo = String(req.body.titulo).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!titulo) return res.status(400).json({ error: "Escreva o que precisa ser feito." });
    campos.push("titulo = ?"); valores.push(titulo);
  }
  if (req.body?.quando !== undefined) {
    const quando = new Date(req.body.quando).getTime();
    if (!isFinite(quando)) return res.status(400).json({ error: "Data inválida." });
    campos.push("quando = ?"); valores.push(quando);
  }
  if (!campos.length) return res.status(400).json({ error: "Nada para mudar." });

  db.prepare(`UPDATE tarefas SET ${campos.join(", ")} WHERE id = ?`).run(...valores, t.id);
  res.json({ ok: true, tarefas: listar(t.lead_id) });
});

r.delete("/tarefas/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM tarefas WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Tarefa não encontrada." });
  const lead = doLead(t.lead_id);
  if (!podeVerLead(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("DELETE FROM tarefas WHERE id = ?").run(t.id);
  res.json({ ok: true, tarefas: listar(t.lead_id) });
});

/* O resumo que o FUNIL usa: por lead, quantas tarefas estão em aberto e qual é
   a próxima. Uma consulta para a imobiliária inteira — uma por card deixaria o
   funil lento assim que a base crescesse. */
export function tarefasAbertasPorLead(orgId) {
  const linhas = db.prepare(`
    SELECT lead_id, COUNT(*) AS abertas, MIN(quando) AS proxima
    FROM tarefas WHERE org_id = ? AND feito_em IS NULL
    GROUP BY lead_id`).all(orgId);
  const titulos = db.prepare(`
    SELECT lead_id, titulo, quando FROM tarefas
    WHERE org_id = ? AND feito_em IS NULL ORDER BY quando ASC`).all(orgId);
  const primeiro = new Map();
  for (const t of titulos) if (!primeiro.has(t.lead_id)) primeiro.set(t.lead_id, t.titulo);
  return new Map(linhas.map(l => [l.lead_id, {
    abertas: l.abertas, proxima: l.proxima, titulo: primeiro.get(l.lead_id) || null,
    // "Já passou da hora" é o que muda a cor do card. Calculado aqui para a
    // tela não precisar repetir a regra.
    atrasada: l.proxima < Date.now(),
  }]));
}

export default r;
