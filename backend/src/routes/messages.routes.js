import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, supervisiona } from "../auth.js";
import { sendText, sendMedia } from "../services/uazapi.js";
import { inferStage } from "../services/stages.js";

const r = Router();
r.use(authRequired);

// Envia mensagem ao lead pelo número único da Conecta, ASSINADA com o nome de quem envia.
// Depois, roda o avanço automático de etapa com base na conversa.
r.post("/:id/messages", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensagem vazia" });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

  // O corretor só fala com o próprio lead; gestor e atendente falam em qualquer um.
  if (!supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });

  const firstName = (req.user.name || "").split(" ")[0];

  try {
    await sendText({ toPhone: lead.phone, text: text.trim(), signedBy: firstName });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName, text.trim(), now);

  // primeira resposta do atendente -> marca tempo de 1ª resposta
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);

  advanceStage(lead.id);
  res.json({ ok: true });
});

// Monta a apresentação do imóvel do jeito que o cliente quer ler: o essencial
// primeiro, sem jargão interno. Comissão e captador NUNCA entram aqui.
export function textoDoProduto(p) {
  const moeda = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const linhas = [`*${p.titulo}*`];
  const local = [p.bairro, p.cidade].filter(Boolean).join(" · ");
  if (local) linhas.push(`📍 ${local}`);
  if (p.tipo === "casa") {
    const comodos = [p.quartos && `${p.quartos} quarto(s)`, p.banheiros && `${p.banheiros} banheiro(s)`].filter(Boolean).join(" · ");
    if (comodos) linhas.push(`🛏 ${comodos}`);
  }
  if (p.metragem) linhas.push(`📐 ${p.metragem} m² de terreno`);
  if (p.tipo === "casa" && p.construtor) linhas.push(`🏗 ${p.construtor}`);
  if (p.morar_bem) linhas.push("🏡 Faz parte do programa Morar Bem Pernambuco");
  if (p.valor) linhas.push(`💰 ${moeda(p.valor)}`);
  if (p.observacoes) linhas.push("", p.observacoes);
  return linhas.join("\n");
}

// Envia o imóvel para o lead: texto + fotos + vídeo, conforme o corretor marcar.
// A localização é opcional DE PROPÓSITO — mandar endereço sem querer é o tipo de
// erro que não dá para desfazer no WhatsApp.
r.post("/:id/produto", async (req, res) => {
  const { produto_id, fotos = true, video = false, localizacao = false } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });

  const p = db.prepare("SELECT * FROM produtos WHERE id = ? AND org_id = ?").get(produto_id, req.user.org_id);
  if (!p) return res.status(404).json({ error: "Produto não encontrado" });

  const firstName = (req.user.name || "").split(" ")[0];
  const midias = db.prepare("SELECT tipo,url FROM produto_midias WHERE produto_id=? ORDER BY ordem").all(p.id);
  let texto = textoDoProduto(p);
  if (localizacao && p.maps_url) texto += `\n\n📍 Localização: ${p.maps_url}`;

  try {
    await sendText({ toPhone: lead.phone, text: texto, signedBy: firstName });
    if (fotos) for (const m of midias.filter(m => m.tipo === "foto"))
      await sendMedia({ toPhone: lead.phone, type: "image", file: m.url });
    if (video) for (const m of midias.filter(m => m.tipo === "video"))
      await sendMedia({ toPhone: lead.phone, type: "video", file: m.url });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  const registro = `[Imóvel enviado] ${p.titulo}` + (localizacao && p.maps_url ? " (com localização)" : "");
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName, registro, now);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);
  // Guarda como imóvel de interesse, se ainda não houver outro marcado.
  if (!lead.produto_id) db.prepare("UPDATE leads SET produto_id = ? WHERE id = ?").run(p.id, lead.id);

  advanceStage(lead.id);
  res.json({ ok: true, enviadas: (fotos ? midias.filter(m => m.tipo === "foto").length : 0) + (video ? midias.filter(m => m.tipo === "video").length : 0) });
});

// Imóvel de interesse do lead (opcional, marcado pelo corretor na ficha).
r.patch("/:id/interesse", (req, res) => {
  const { produto_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET produto_id = ? WHERE id = ?").run(produto_id || null, lead.id);
  res.json({ ok: true });
});

// Recalcula e aplica o avanço automático de etapa a partir do histórico.
export function advanceStage(leadId) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) return;
  const msgs = db.prepare("SELECT direction,body FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(leadId);
  const next = inferStage(lead.stage, msgs);
  if (next !== lead.stage) db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(next, leadId);
}

export default r;
