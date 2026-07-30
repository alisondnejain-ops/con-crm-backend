import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, supervisiona } from "../auth.js";
import { sendText, sendMedia, sendLocation } from "../services/uazapi.js";
import { salvar, limiteBytes } from "../services/storage.js";
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

/* Anexos que o CORRETOR manda: áudio gravado, fotos e vídeo.

   Limites combinados com o Ali (30/07/2026): até 10 fotos por envio, 1 vídeo,
   1 áudio. Não é capricho — cada arquivo vira uma requisição para a Uazapi e
   ocupa disco, e disparo em rajada num número não-oficial é o que mais chama
   atenção do WhatsApp.

   O arquivo é guardado primeiro porque a Uazapi envia a partir de uma URL
   pública: sem guardar, não há o que mandar. Como o arquivo fica salvo, ele
   também aparece no balão da conversa, igual ao que o cliente manda. */
const LIMITES = { image: 10, video: 1, audio: 1 };
const familia = (mime) => (/^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "");

r.post("/:id/anexo", async (req, res) => {
  const { arquivos } = req.body || {};
  if (!Array.isArray(arquivos) || !arquivos.length) return res.status(400).json({ error: "Nenhum arquivo recebido." });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });

  // Confere os limites antes de gravar qualquer coisa: melhor recusar tudo do
  // que mandar 10 fotos e falhar na 11ª, deixando o envio pela metade.
  const contagem = {};
  for (const a of arquivos) {
    const f = familia(a.mime || "");
    if (!f) return res.status(400).json({ error: `Tipo de arquivo não aceito: ${a.mime || "desconhecido"}` });
    contagem[f] = (contagem[f] || 0) + 1;
    if (contagem[f] > LIMITES[f])
      return res.status(400).json({ error: `Máximo de ${LIMITES[f]} ${f === "image" ? "fotos" : f === "video" ? "vídeo" : "áudio"} por envio.` });
  }

  const firstName = (req.user.name || "").split(" ")[0];
  const enviados = [];
  try {
    for (const [i, a] of arquivos.entries()) {
      const buffer = Buffer.from(String(a.base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
      if (!buffer.length) return res.status(400).json({ error: "Arquivo vazio." });
      if (buffer.length > limiteBytes(a.mime))
        return res.status(413).json({ error: `"${a.nome || "arquivo"}" passa do limite de ${Math.round(limiteBytes(a.mime) / 1048576)} MB.` });

      const { url } = await salvar({ buffer, mime: a.mime, prefixo: "conversas" });
      const f = familia(a.mime);
      // "ptt" é o áudio de voz do WhatsApp — aparece como mensagem de voz, e não
      // como arquivo de música anexado.
      const tipoUazapi = f === "audio" ? "ptt" : f;
      // A legenda vai só na primeira: repetida em 10 fotos, vira spam.
      const legenda = i === 0 && req.body.texto ? String(req.body.texto).trim() : "";
      await sendMedia({ toPhone: lead.phone, type: tipoUazapi, file: url, caption: legenda || undefined, signedBy: legenda ? firstName : undefined });
      enviados.push({ url, mime: a.mime, nome: a.nome || "", legenda });
    }
  } catch (e) {
    // Parte pode ter ido. Registramos o que saiu para a conversa não mentir.
    for (const m of enviados) gravarSaida(lead, req.user, firstName, m);
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message, enviados: enviados.length });
  }

  for (const m of enviados) gravarSaida(lead, req.user, firstName, m);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(Date.now(), lead.id);
  advanceStage(lead.id);
  res.json({ ok: true, enviados: enviados.length });
});

// Localização de onde o corretor está agora (GPS do celular). Vai como ponto no
// mapa, não como link — o cliente abre direto no aplicativo de mapas dele.
r.post("/:id/localizacao", async (req, res) => {
  const { latitude, longitude } = req.body || {};
  const lat = Number(latitude), lon = Number(longitude);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return res.status(400).json({ error: "Coordenadas inválidas." });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });

  const firstName = (req.user.name || "").split(" ")[0];
  try {
    await sendLocation({ toPhone: lead.phone, latitude: lat, longitude: lon, name: `${firstName} — Conecta Imóveis` });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName,
      `📍 Localização enviada (https://maps.google.com/?q=${lat},${lon})`, now);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);
  res.json({ ok: true });
});

function gravarSaida(lead, user, firstName, m) {
  const rotulo = /^image\//.test(m.mime) ? "Foto" : /^video\//.test(m.mime) ? "Vídeo" : /^audio\//.test(m.mime) ? "Áudio" : (m.nome || "Arquivo");
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", user.id, firstName,
      m.legenda || rotulo, m.url, m.mime, m.nome || null, Date.now());
}

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
