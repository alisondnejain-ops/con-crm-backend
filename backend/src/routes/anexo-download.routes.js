import { Router } from "express";
import db from "../db.js";
import { podeVerLead, verificarTokenAnexo } from "../auth.js";
import { bytesParaBaixar } from "../services/storage.js";

/* BAIXAR UM ANEXO NO CELULAR, DE VERDADE. (21/09/2026, relatado pelo Ali: o
   botão de baixar "não está funcionando corretamente no celular deles".)

   A rota de 14/09 (`GET /leads/:id/anexo/:messageId/baixar`, em
   messages.routes.js) buscava o arquivo com `fetch` + `Authorization` e
   simulava um clique num link `<a download>` apontando para um blob local.
   Funciona em computador — mas o Safari do iPhone IGNORA o atributo
   `download` em URLs de blob para a maioria dos tipos de arquivo: o link só
   ABRE o arquivo, não salva. É a mesma cara do "abre numa aba" que já tinha
   sido corrigida para desktop, reaparecendo no aparelho que o corretor mais
   usa em campo.

   A única forma confiável em celular é uma navegação DE VERDADE para uma
   URL com `Content-Disposition: attachment` — é aí que o sistema
   operacional usa o mecanismo NATIVO de salvar arquivo. Só que navegação
   não leva o cabeçalho `Authorization`, e por isso esta rota vive FORA do
   prefixo `/leads`: `server.js` protege `/leads` inteiro com `cobrando`
   (que já exige o cabeçalho antes de qualquer rota rodar — a mesma trava
   que o CLAUDE.md documenta ter derrubado o webhook em 13/08/2026, só que
   desta vez funcionando como deveria). Uma rota sem cabeçalho não pode
   morar ali dentro; por isso um arquivo próprio, um prefixo próprio.

   O crachá aqui é outro: um token de 2 minutos, bom só para ESTE
   leadId+messageId (`emitirTokenAnexo`/`verificarTokenAnexo`, auth.js) — o
   app pede um pelo caminho normal (`GET /leads/:id/anexo/:messageId/
   token-baixar`, com o crachá de sempre) e só então navega para cá. Nunca
   o crachá de 30 dias dentro de uma URL, que ficaria no histórico do
   navegador do celular. */
const r = Router();

r.get("/:leadId/:messageId", async (req, res) => {
  const via = req.query.t && verificarTokenAnexo(String(req.query.t), req.params.leadId, req.params.messageId);
  if (!via) return res.status(401).json({ error: "Link expirado — volte ao CRM e clique em Baixar de novo." });

  const u = db.prepare("SELECT id, org_id, role, master FROM users WHERE id = ? AND status = 'ativo'").get(via.id);
  if (!u) return res.status(401).json({ error: "Não autenticado" });
  const user = { id: u.id, org_id: u.org_id, role: u.role, master: !!u.master };

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.leadId);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVerLead(user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND lead_id = ?")
    .get(req.params.messageId, lead.id);
  if (!msg || !msg.media_url) return res.status(404).json({ error: "Arquivo não encontrado." });

  const nome = (msg.media_name || "arquivo").replace(/[\r\n"]/g, "");
  try {
    // `bytesParaBaixar` tenta a chave (disco/R2) e cai para a URL pública se
    // a leitura pela API falhar (21/09/2026) — ver o comentário na função.
    const buffer = await bytesParaBaixar(msg.media_url);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", msg.media_mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (e) {
    console.error("[anexo-baixar] falhou para lead", lead.id, "mensagem", msg.id, "—", e.message);
    res.status(502).json({ error: "Não consegui buscar o arquivo para baixar." });
  }
});

export default r;
