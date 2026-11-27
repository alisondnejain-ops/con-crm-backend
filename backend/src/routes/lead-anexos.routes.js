/* Anexos da ficha do lead (27/11/2026, protótipo CETRO): RG, comprovante de
   renda, contrato assinado, planta enviada pelo cliente. Ficam na ficha, para
   a equipe; NÃO vão para a conversa nem para o cliente.

   Só foto e documento (a lista fechada de `DOCUMENTOS`): executável e HTML
   não entram. Até 15 MB por arquivo. Baixar passa pelo servidor com o login
   (`bytesParaBaixar`), como o anexo da conversa. Ver e anexar: quem pode abrir
   a conversa. Apagar: quem anexou, ou quem supervisiona. */
import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, podeVerLead, supervisiona } from "../auth.js";
import { salvar, apagar, bytesParaBaixar, ehDocumento, chaveDaUrl } from "../services/storage.js";

const r = Router();
r.use(authRequired);

const LIMITE = 15 * 1048576;
const MAXIMO_POR_LEAD = 50;
const pode = (mime) => /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(mime) || ehDocumento(mime);

export const listar = (leadId) => db.prepare(`
  SELECT a.id, a.nome, a.mime, a.tamanho, a.created_at, a.user_id, u.name AS de_quem
  FROM lead_anexos a LEFT JOIN users u ON u.id = a.user_id
  WHERE a.lead_id = ? ORDER BY a.created_at DESC`).all(leadId);

function acesso(req, res) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead || !podeVerLead(req.user, lead)) { res.status(403).json({ error: "Este lead não está com você" }); return null; }
  return lead;
}

r.get("/:id/anexos", (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  res.json({ anexos: listar(lead.id) });
});

r.post("/:id/anexos", async (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  const { nome, mime, base64 } = req.body || {};
  if (!pode(String(mime || ""))) return res.status(400).json({ error: "Dá para anexar foto, PDF, Word, Excel, PowerPoint, texto e ZIP." });
  const buffer = Buffer.from(String(base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buffer.length) return res.status(400).json({ error: "Arquivo vazio." });
  if (buffer.length > LIMITE) return res.status(413).json({ error: "O arquivo passa do limite de 15 MB." });
  const n = db.prepare("SELECT COUNT(*) n FROM lead_anexos WHERE lead_id = ?").get(lead.id).n;
  if (n >= MAXIMO_POR_LEAD) return res.status(400).json({ error: `Este lead já tem ${MAXIMO_POR_LEAD} anexos.` });
  try {
    const { url } = await salvar({ buffer, mime, prefixo: "fichas" });
    const nomeLimpo = String(nome || "arquivo").replace(/[\r\n"\\/]/g, "").slice(0, 120) || "arquivo";
    db.prepare(`INSERT INTO lead_anexos (id,org_id,lead_id,nome,mime,tamanho,url,user_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("ax_" + randomUUID(), lead.org_id, lead.id, nomeLimpo, mime, buffer.length, url, req.user.id, Date.now());
    res.json({ ok: true, anexos: listar(lead.id) });
  } catch (e) {
    console.error("[anexos da ficha] não consegui guardar:", e.message);
    res.status(502).json({ error: "Não consegui guardar o arquivo. Tente de novo." });
  }
});

r.get("/:id/anexos/:aid/baixar", async (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  const a = db.prepare("SELECT * FROM lead_anexos WHERE id = ? AND lead_id = ?").get(req.params.aid, lead.id);
  if (!a) return res.status(404).json({ error: "Arquivo não encontrado." });
  try {
    const buffer = await bytesParaBaixar(a.url);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", a.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${a.nome.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (e) {
    console.error("[anexos da ficha] baixar falhou:", e.message);
    res.status(502).json({ error: "Não consegui buscar o arquivo." });
  }
});

r.delete("/:id/anexos/:aid", async (req, res) => {
  const lead = acesso(req, res); if (!lead) return;
  const a = db.prepare("SELECT * FROM lead_anexos WHERE id = ? AND lead_id = ?").get(req.params.aid, lead.id);
  if (!a) return res.status(404).json({ error: "Arquivo não encontrado." });
  if (a.user_id !== req.user.id && !supervisiona(req.user))
    return res.status(403).json({ error: "Só quem anexou ou a gestão apaga este arquivo." });
  db.prepare("DELETE FROM lead_anexos WHERE id = ?").run(a.id);
  const chave = chaveDaUrl(a.url); if (chave) apagar(chave).catch(() => {});
  res.json({ ok: true, anexos: listar(lead.id) });
});

export default r;
