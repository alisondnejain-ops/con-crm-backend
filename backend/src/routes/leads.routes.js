import { Router } from "express";
import db from "../db.js";
import { authRequired, roles, supervisiona } from "../auth.js";
import { STAGES } from "../services/stages.js";
import { numero as numeroBR } from "./produtos.routes.js";

const r = Router();
r.use(authRequired);

// Colunas calculadas usadas nas listagens: quantas mensagens do lead ainda não
// foram lidas e qual foi a última mensagem da conversa.
const SELECT_LEAD = `
  SELECT l.*,
    (SELECT COUNT(*) FROM messages m
      WHERE m.lead_id = l.id AND m.direction = 'in'
        AND m.created_at > COALESCE(l.last_read_at, 0)) AS unread,
    (SELECT m.body FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
    (SELECT m.direction FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
    (SELECT m.created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
    (SELECT u.name FROM users u WHERE u.id = l.assigned_to) AS assigned_name
  FROM leads l`;

const parse = (l) => l && ({ ...l, qual: JSON.parse(l.qual_json || "{}"), unread: l.unread || 0 });

// A ADM enxerga tudo; corretor e SDR só o que está com eles.
// Filtros (pensados para a supervisão da ADM):
//   ?atendente=<id|fila>  ?etapa=<etapa>  ?prioridade=QUENTE  ?q=<nome ou telefone>
r.get("/", (req, res) => {
  const { id, org_id } = req.user;
  const where = [], args = [];

  if (supervisiona(req.user)) {
    where.push("l.org_id = ?"); args.push(org_id);
    const { atendente, etapa, prioridade, q, de, ate } = req.query;
    if (atendente === "fila") where.push("l.assigned_to IS NULL");
    else if (atendente) { where.push("l.assigned_to = ?"); args.push(atendente); }
    if (etapa) { where.push("l.stage = ?"); args.push(etapa); }
    if (prioridade) { where.push("l.priority = ?"); args.push(prioridade); }
    if (q) { where.push("(l.name LIKE ? OR l.phone LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
    // Período de entrada do lead. O "até" cobre o dia inteiro, senão o filtro
    // exclui tudo que chegou depois da meia-noite da data escolhida.
    const inicio = de && new Date(`${de}T00:00:00`).getTime();
    const fim = ate && new Date(`${ate}T23:59:59.999`).getTime();
    if (inicio && isFinite(inicio)) { where.push("l.created_at >= ?"); args.push(inicio); }
    if (fim && isFinite(fim)) { where.push("l.created_at <= ?"); args.push(fim); }
  } else {
    where.push("l.assigned_to = ?"); args.push(id);
  }

  const rows = db.prepare(`${SELECT_LEAD} WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC`).all(...args);
  res.json(rows.map(parse));
});

// Fila da catraca (leads sem dono). SDR e ADM.
r.get("/queue", roles("sdr", "adm"), (req, res) => {
  const rows = db.prepare(`${SELECT_LEAD} WHERE l.org_id = ? AND l.assigned_to IS NULL ORDER BY l.created_at DESC`).all(req.user.org_id);
  res.json(rows.map(parse));
});

// Gestor e atendente abrem a conversa de qualquer um. O corretor fica nos leads dele.
// Antes desta checagem, qualquer usuário logado lia qualquer lead pelo id.
function podeVer(user, lead) {
  if (!lead) return false;
  if (supervisiona(user)) return lead.org_id === user.org_id;
  return lead.assigned_to === user.id;
}

r.get("/:id", (req, res) => {
  const lead = db.prepare(`${SELECT_LEAD} WHERE l.id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  const messages = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id);
  res.json({ ...parse(lead), messages });
});

// Marca a conversa como lida até agora. A ADM supervisionando NÃO marca:
// senão ela apagaria o aviso de "cliente aguardando" do corretor.
r.post("/:id/read", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Sem acesso a este lead" });
  if (supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.json({ ok: true, ignorado: "supervisão não marca como lida" });
  db.prepare("UPDATE leads SET last_read_at = ? WHERE id = ?").run(Date.now(), lead.id);
  res.json({ ok: true });
});

// Ajuste manual de etapa (o automático acontece no envio/recebimento de mensagem).
r.patch("/:id/stage", (req, res) => {
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ error: "Etapa inválida" });
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(stage, lead.id);
  res.json({ ok: true, stage });
});

// Registro da venda: valor do imóvel, data e qual unidade. Registrar a venda
// também move o lead para a etapa "Venda" — as duas coisas andam juntas.
r.patch("/:id/venda", (req, res) => {
  const { valor, data, imovel } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  // Valor vazio desfaz o registro (correção de engano).
  if (valor === null || valor === "") {
    db.prepare("UPDATE leads SET sale_value=NULL, sale_date=NULL, sale_property=NULL WHERE id=?").run(lead.id);
    return res.json({ ok: true, removido: true });
  }
  // Mesmo tratamento do catálogo: aceita 285000 e "285.000,50" sem virar 285.
  const v = numeroBR(valor);
  if (!v || v <= 0) return res.status(400).json({ error: "Informe um valor de venda válido." });

  const quando = data ? new Date(data).getTime() : Date.now();
  if (!isFinite(quando)) return res.status(400).json({ error: "Data da venda inválida." });

  db.prepare("UPDATE leads SET sale_value=?, sale_date=?, sale_property=?, stage='Venda' WHERE id=?")
    .run(v, quando, (imovel || "").trim() || null, lead.id);
  res.json({ ok: true, stage: "Venda" });
});

export default r;
