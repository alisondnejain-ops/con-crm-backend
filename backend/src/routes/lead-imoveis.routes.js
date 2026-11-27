/* Vários imóveis por lead, e propostas (27/11/2026, protótipo CETRO).

   O "imóvel de interesse" (`leads.produto_id`) é UM só. No atendimento real o
   cliente chega por um anúncio, recebe duas alternativas, visita uma e faz
   proposta noutra. Esta lista guarda cada imóvel com o VÍNCULO dele ao lead
   (origem, interesse principal, alternativa apresentada, visitado, proposta).

   A PROPOSTA é o registro do que o cliente ofereceu: imóvel, valor, data,
   detalhes e situação (em análise, aceita, recusada). Não move etapa nem conta
   em relatório nenhum — "Propostas" dos relatórios continua sendo a etapa do
   funil. Venda continua sendo só a registrada (Registrar venda).

   Quem vê e mexe: quem pode abrir a conversa do lead (`podeVerLead`). */
import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, podeVerLead } from "../auth.js";

// As tabelas nascem em db.js (lead_imoveis, lead_propostas).

export const VINCULOS = ["origem", "interesse", "alternativa", "visitado", "proposta"];
export const STATUS_PROPOSTA = ["analise", "aceita", "recusada"];

const r = Router();
r.use(authRequired);

const doLead = (id) => db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
const texto = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max) || null;

export function listar(leadId) {
  const imoveis = db.prepare(`
    SELECT li.id, li.produto_id, li.vinculo, li.unidade, li.obs, li.created_at, u.name AS de_quem,
      p.titulo, p.referencia AS codigo, p.valor, p.finalidade, p.moeda, p.status AS produto_status
    FROM lead_imoveis li JOIN produtos p ON p.id = li.produto_id AND p.org_id = li.org_id
    LEFT JOIN users u ON u.id = li.user_id
    WHERE li.lead_id = ? ORDER BY li.created_at`).all(leadId);
  const propostas = db.prepare(`
    SELECT pr.id, pr.produto_id, pr.valor, pr.quando, pr.status, pr.detalhes, pr.created_at, u.name AS de_quem,
      p.titulo, p.moeda
    FROM lead_propostas pr LEFT JOIN produtos p ON p.id = pr.produto_id AND p.org_id = pr.org_id
    LEFT JOIN users u ON u.id = pr.user_id
    WHERE pr.lead_id = ? ORDER BY pr.quando DESC, pr.created_at DESC`).all(leadId);
  return { imoveis, propostas };
}

function acesso(req, res) {
  const lead = doLead(req.params.id);
  if (!lead || !podeVerLead(req.user, lead)) { res.status(403).json({ error: "Este lead não está com você" }); return null; }
  return lead;
}
function produtoDaConta(id, orgId) {
  return id ? db.prepare("SELECT id FROM produtos WHERE id = ? AND org_id = ?").get(id, orgId) : null;
}

r.get("/:id/imoveis-vinculados", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  res.json(listar(lead.id));
});

// Vincular (ou mudar o vínculo de) um imóvel. O mesmo imóvel aparece uma vez.
r.post("/:id/imoveis-vinculados", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  const p = produtoDaConta(req.body?.produto_id, lead.org_id);
  if (!p) return res.status(400).json({ error: "Escolha um imóvel do catálogo." });
  const vinculo = VINCULOS.includes(req.body?.vinculo) ? req.body.vinculo : "interesse";
  db.prepare(`INSERT INTO lead_imoveis (id,org_id,lead_id,produto_id,vinculo,unidade,obs,user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(lead_id, produto_id) DO UPDATE SET vinculo = excluded.vinculo, unidade = excluded.unidade, obs = excluded.obs`)
    .run("li_" + randomUUID(), lead.org_id, lead.id, p.id, vinculo, texto(req.body?.unidade, 60), texto(req.body?.obs, 300), req.user.id, Date.now());
  res.json({ ok: true, ...listar(lead.id) });
});

r.delete("/:id/imoveis-vinculados/:vid", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  db.prepare("DELETE FROM lead_imoveis WHERE id = ? AND lead_id = ?").run(req.params.vid, lead.id);
  res.json({ ok: true, ...listar(lead.id) });
});

function valorBR(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").replace(/[^\d,.-]/g, "");
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/\.(?=\d{3}(\D|$))/g, ""));
  return isFinite(n) ? n : NaN;
}

r.post("/:id/propostas", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  const valor = valorBR(req.body?.valor);
  if (!(valor > 0) || valor > 1e10) return res.status(400).json({ error: "Informe o valor da proposta." });
  const quando = req.body?.quando ? new Date(req.body.quando).getTime() : Date.now();
  if (!isFinite(quando)) return res.status(400).json({ error: "Data inválida." });
  let produto = null;
  if (req.body?.produto_id) {
    const p = produtoDaConta(req.body.produto_id, lead.org_id);
    if (!p) return res.status(400).json({ error: "Imóvel não encontrado nesta conta." });
    produto = p.id;
  }
  db.prepare(`INSERT INTO lead_propostas (id,org_id,lead_id,produto_id,valor,quando,status,detalhes,user_id,created_at)
    VALUES (?,?,?,?,?,?,'analise',?,?,?)`)
    .run("pr_" + randomUUID(), lead.org_id, lead.id, produto, valor, quando, texto(req.body?.detalhes, 500), req.user.id, Date.now());
  // A proposta marca o imóvel como "proposta" na lista do lead.
  if (produto) db.prepare(`INSERT INTO lead_imoveis (id,org_id,lead_id,produto_id,vinculo,user_id,created_at)
    VALUES (?,?,?,?,'proposta',?,?) ON CONFLICT(lead_id, produto_id) DO UPDATE SET vinculo = 'proposta'`)
    .run("li_" + randomUUID(), lead.org_id, lead.id, produto, req.user.id, Date.now());
  res.json({ ok: true, ...listar(lead.id) });
});

r.patch("/:id/propostas/:pid", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  if (!STATUS_PROPOSTA.includes(req.body?.status)) return res.status(400).json({ error: "Situação inválida." });
  const x = db.prepare("UPDATE lead_propostas SET status = ?, atualizado_em = ? WHERE id = ? AND lead_id = ?")
    .run(req.body.status, Date.now(), req.params.pid, lead.id);
  if (!x.changes) return res.status(404).json({ error: "Proposta não encontrada." });
  res.json({ ok: true, ...listar(lead.id) });
});

r.delete("/:id/propostas/:pid", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  db.prepare("DELETE FROM lead_propostas WHERE id = ? AND lead_id = ?").run(req.params.pid, lead.id);
  res.json({ ok: true, ...listar(lead.id) });
});

export default r;
