/* O site da imobiliária — ver services/site.js para as regras.

   Dois roteadores, e a diferença entre eles é a porta:
     - `paginas` (público, sem login) — o que o visitante abre.
     - `gestao`  (logado, gestor)     — a tela "Site" dentro do CRM. */
import { Router } from "express";
import { roles } from "../auth.js";
import {
  configDoSite, salvarSite, siteDoSlug, imovelDoSite, slugify,
  paginaPortal, paginaImovel, paginaAviso, paginaInexistente, paginaPausada, FRASE_PADRAO,
} from "../services/site.js";

const baseDe = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/* ===== PÁGINAS (público) ===== */
export const paginas = Router();

function contexto(req, res) {
  const s = siteDoSlug(req.params.slug);
  if (!s) { res.status(404).type("html").set("Cache-Control", "no-store").send(paginaInexistente()); return null; }
  if (s.pausado) { res.status(503).type("html").set("Cache-Control", "no-store").send(paginaPausada(s)); return null; }
  return { ...s, base: baseDe(req) };
}

/* Sem cache: o navegador sempre pergunta ao servidor (24/09/2026). Era
   `max-age=60`, e o gestor trocava a frase, clicava em "Abrir o site" e via a
   página VELHA — a aba nova saía da memória do navegador sem perguntar nada,
   e parecia que o Salvar não tinha funcionado. `no-cache` não é "não guarde":
   o Express manda ETag, e página que não mudou volta como 304, sem corpo —
   o custo de sempre conferir é quase nenhum, e preço trocado ou imóvel vendido
   aparece na hora. */
const servir = (res, html, status = 200) =>
  res.status(status).type("html").set("Cache-Control", "no-cache").send(html);

paginas.get("/:slug", (req, res) => {
  const ctx = contexto(req, res); if (!ctx) return;
  servir(res, paginaPortal(ctx, req.query));
});

paginas.get(["/:slug/:id", "/:slug/:id/:titulo"], (req, res) => {
  const ctx = contexto(req, res); if (!ctx) return;
  const r = imovelDoSite(ctx.org.id, req.params.id);
  if (!r.existe) return servir(res, paginaAviso(ctx, { titulo: "Imóvel não encontrado", texto: "Este endereço não corresponde a nenhum imóvel. Veja os que estão disponíveis ou fale com a gente." }), 404);
  if (!r.disponivel) {
    const fechado = r.status === "vendido" ? "Este imóvel já foi vendido." : r.status === "alugado" ? "Este imóvel já foi alugado." : "Este imóvel não está mais disponível.";
    return servir(res, paginaAviso(ctx, { titulo: r.titulo, texto: `${fechado} Temos outras opções parecidas — dá uma olhada ou chama a gente no WhatsApp.` }), 410);
  }
  // Título trocado depois de o link circular: leva para o endereço atual, em
  // vez de manter no ar um endereço que diz uma coisa e mostra outra.
  const certo = slugify(r.imovel.titulo) || "imovel";
  if (req.params.titulo !== certo) return res.redirect(301, `/imoveis/${ctx.cfg.slug}/${r.imovel.id}/${certo}`);
  servir(res, paginaImovel(ctx, r.imovel));
});

/* ===== GESTÃO (logado) ===== */
export const gestao = Router();
gestao.use(roles("adm"));

function resposta(req) {
  const c = configDoSite(req.user.org_id);
  return {
    ligado: !!c.ligado, slug: c.slug, whatsapp: c.whatsapp || "", pixel_id: c.pixel_id || "",
    frase: c.frase || "", frase_padrao: FRASE_PADRAO,
    url: `${baseDe(req)}/imoveis/${c.slug}`,
  };
}

gestao.get("/", (req, res) => res.json(resposta(req)));

gestao.patch("/", (req, res) => {
  const r = salvarSite(req.user.org_id, req.body || {});
  if (r.erro) return res.status(400).json({ error: r.erro });
  res.json(resposta(req));
});
