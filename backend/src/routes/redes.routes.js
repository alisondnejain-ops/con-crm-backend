/* REDES SOCIAIS — publicar, programar e acompanhar o Facebook e o Instagram
   da imobiliária, e a automação de comentários (20/10/2026).

   Só o gestor (inclusive o dono de conta autônoma, via `roles`), e só com o
   Marketing liberado (`exigirLiberado`, em todas as rotas de uma vez). A
   conexão da página é a de Configurações → Anúncios do Meta. */
import express, { Router } from "express";
import db from "../db.js";
import { roles } from "../auth.js";
import {
  ErroRedes, exigirLiberado, visaoGeral, atualizarPagina, listarPosts, criarPost, editarPost, cancelarPost, apagarPost, engajamento,
} from "../services/redes.js";
import { listarRegras, criarRegra, editarRegra, apagarRegra, comentariosDaRegra, linkDoWhatsapp } from "../services/redes-comentarios.js";
import { salvar, ehVideo, LIMITE_VIDEO_MB, limiteVideoBinario } from "../services/storage.js";
import { garantirH264 } from "../services/video.js";
import { publico, caminhoDoImovel } from "../services/site.js";

const r = Router();
r.use(roles("adm"));
r.use((req, res, next) => {
  try { exigirLiberado(req.user.org_id); next(); }
  catch (e) { res.status(e.status || 403).json({ error: e.message }); }
});

const trata = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof ErroRedes) return res.status(e.status).json({ error: e.message });
    console.error("[redes] erro:", e);
    res.status(500).json({ error: "Não consegui concluir. Tente de novo." });
  }
};

r.get("/", trata((req, res) => res.json({ ...visaoGeral(req.user.org_id), whatsapp: linkDoWhatsapp(req.user.org_id) })));
r.post("/paginas/:pageId/atualizar", trata(async (req, res) => res.json(await atualizarPagina(req.user.org_id, req.params.pageId))));

/* ===== Mídia do post ===== */

const LIMITE_FOTO_MB = 8;
/* Foto: vira JPEG (o Instagram só aceita JPEG), deitada pelo EXIF, sem os
   metadados (a localização do celular não vai para a internet) e com no máximo
   1440 px de largura — o tamanho que o Instagram usa. */
r.post("/midias", trata(async (req, res) => {
  const { base64, mime } = req.body || {};
  if (!base64 || !/^image\//.test(String(mime || ""))) throw new ErroRedes(400, "Envie uma foto (JPG, PNG ou WEBP).");
  const buffer = Buffer.from(String(base64).replace(/^data:[^,]+,/, ""), "base64");
  if (!buffer.length) throw new ErroRedes(400, "Arquivo vazio.");
  if (buffer.length > LIMITE_FOTO_MB * 1024 * 1024) throw new ErroRedes(413, `A foto passa de ${LIMITE_FOTO_MB} MB.`);
  const sharp = (await import("sharp")).default;
  let saida, info;
  try {
    ({ data: saida, info } = await sharp(buffer).rotate().resize({ width: 1440, withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
  } catch { throw new ErroRedes(422, "Não consegui abrir esta foto. Tente outra ou salve como JPG."); }
  const { url, chave } = await salvar({ buffer: saida, mime: "image/jpeg", prefixo: `redes/${req.user.org_id}` });
  res.json({ url, chave, tipo: "foto", largura: info.width, altura: info.height });
}));

// Vídeo: corpo cru (sem base64), como o vídeo da conversa. HEVC do iPhone vira H.264.
r.post("/midias/video", express.raw({ limit: `${LIMITE_VIDEO_MB + 5}mb`, type: () => true }), trata(async (req, res) => {
  const mime = String(req.query.mime || "video/mp4");
  if (!ehVideo(mime)) throw new ErroRedes(400, "Esta rota é só para vídeo.");
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) throw new ErroRedes(400, "Arquivo vazio.");
  if (buffer.length > limiteVideoBinario()) throw new ErroRedes(413, `O vídeo passa do limite de ${LIMITE_VIDEO_MB} MB.`);
  let final;
  try { final = await garantirH264(buffer); } catch (e) { throw new ErroRedes(422, e.message); }
  const { url, chave } = await salvar({ buffer: final.buffer, mime: final.mime, prefixo: `redes/${req.user.org_id}` });
  res.json({ url, chave, tipo: "video" });
}));

/* Usar um imóvel do catálogo: as fotos (já tratadas) e um texto sugerido,
   só com o que é público do imóvel — nunca construtora, comissão, captador ou
   observações internas (a mesma lista branca do site). */
r.get("/imoveis", trata((req, res) => {
  const lista = db.prepare(`SELECT id, titulo, cidade, bairro, finalidade FROM produtos WHERE org_id = ? AND status = 'ativo'
    ORDER BY created_at DESC LIMIT 300`).all(req.user.org_id);
  res.json({ imoveis: lista });
}));
r.get("/imoveis/:id", trata((req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!p) throw new ErroRedes(404, "Imóvel não encontrado.");
  const pub = publico(p);
  const fotos = db.prepare(`SELECT url, largura, altura FROM produto_midias WHERE produto_id = ? AND tipo = 'foto' ORDER BY ordem, created_at LIMIT 10`).all(p.id);
  const comodos = [pub.quartos && `${pub.quartos} quarto${pub.quartos > 1 ? "s" : ""}`, pub.suites && `${pub.suites} suíte${pub.suites > 1 ? "s" : ""}`,
    pub.vagas && `${pub.vagas} vaga${pub.vagas > 1 ? "s" : ""}`, pub.area_util && `${pub.area_util} m²`].filter(Boolean).join(" · ");
  const valor = pub.valor ? `${pub.finalidade === "aluguel" ? "Aluguel" : "Valor"}: R$ ${Number(pub.valor).toLocaleString("pt-BR")}${pub.finalidade === "aluguel" ? "/mês" : ""}` : "";
  let link = caminhoDoImovel(req.user.org_id, p);
  if (link && link.startsWith("/")) link = (process.env.APP_URL || "").replace(/\/$/, "") + link;
  const texto = [
    `🏡 ${pub.titulo}`,
    pub.local.curta ? `📍 ${pub.local.curta}` : "",
    comodos ? `🛏️ ${comodos}` : "",
    valor ? `💰 ${valor}` : "",
    pub.descricao ? "\n" + pub.descricao.slice(0, 600) : "",
    link ? `\nVeja todas as fotos: ${link}` : "",
  ].filter(Boolean).join("\n");
  res.json({ texto, midias: fotos.map(f => ({ url: f.url, tipo: "foto", largura: f.largura, altura: f.altura })) });
}));

/* ===== Posts ===== */

r.get("/posts", trata((req, res) => res.json({ posts: listarPosts(req.user.org_id, { status: req.query.status ? String(req.query.status) : undefined }) })));
r.post("/posts", trata((req, res) => res.status(201).json(criarPost(req.user.org_id, req.user.id, req.body || {}))));
r.put("/posts/:id", trata((req, res) => res.json(editarPost(req.user.org_id, req.params.id, req.body || {}))));
r.post("/posts/:id/cancelar", trata((req, res) => res.json(cancelarPost(req.user.org_id, req.params.id))));
r.delete("/posts/:id", trata((req, res) => res.json(apagarPost(req.user.org_id, req.params.id))));

/* ===== Engajamento ===== */

r.get("/engajamento/:pageId", trata(async (req, res) =>
  res.json(await engajamento(req.user.org_id, req.params.pageId, { atualizar: req.query.atualizar === "1" }))));

/* ===== Automação de comentários ===== */

r.get("/automacoes", trata((req, res) => res.json({ regras: listarRegras(req.user.org_id), whatsapp: linkDoWhatsapp(req.user.org_id) })));
r.post("/automacoes", trata((req, res) => res.status(201).json(criarRegra(req.user.org_id, req.user.id, req.body || {}))));
r.put("/automacoes/:id", trata((req, res) => res.json(editarRegra(req.user.org_id, req.params.id, req.body || {}))));
r.delete("/automacoes/:id", trata((req, res) => res.json(apagarRegra(req.user.org_id, req.params.id))));
r.get("/automacoes/:id/comentarios", trata((req, res) => res.json({ comentarios: comentariosDaRegra(req.user.org_id, req.params.id) })));

export default r;
