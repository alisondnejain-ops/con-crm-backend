/* O site da imobiliária — ver services/site.js para as regras.

   Dois roteadores, e a diferença entre eles é a porta:
     - `paginas` (público, sem login) — o que o visitante abre.
     - `gestao`  (logado, gestor)     — a tela "Site" dentro do CRM. */
import { Router } from "express";
import { roles } from "../auth.js";
import db from "../db.js";
import { railwayPronto, removerDominio } from "../services/railway.js";
import {
  configDoSite, salvarSite, registrosDoSite, siteDoSlug, siteDoDominio, orgDoDominio, imovelDoSite, slugify, marcaDoSite, verificarDominio,
  paginaPortal, paginaImovel, paginaAviso, paginaInexistente, paginaPausada, sitemap, robots, FRASE_PADRAO,
} from "../services/site.js";

const baseDe = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/* ===== PÁGINAS (público) ===== */
export const paginas = Router();

function contexto(req, res) {
  const s = siteDoSlug(req.params.slug);
  return pronto(s, res, { base: baseDe(req), raiz: s ? `/imoveis/${s.cfg.slug}` : "" });
}
function pronto(s, res, extra) {
  if (!s) { res.status(404).type("html").set("Cache-Control", "no-store").send(paginaInexistente()); return null; }
  if (s.pausado) { res.status(503).type("html").set("Cache-Control", "no-store").send(paginaPausada(s)); return null; }
  return { ...s, ...extra };
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
// ANTES de "/:slug/:id": senão "sitemap.xml" seria lido como o id de um imóvel.
paginas.get("/:slug/sitemap.xml", (req, res) => {
  const ctx = contexto(req, res); if (!ctx) return;
  res.type("application/xml").set("Cache-Control", "no-cache").send(sitemap(ctx));
});

paginas.get(["/:slug/:id", "/:slug/:id/:titulo"], (req, res) => paginaDoImovel(contexto(req, res), req, res));

function paginaDoImovel(ctx, req, res) {
  if (!ctx) return;
  const r = imovelDoSite(ctx.org.id, req.params.id);
  if (!r.existe) return servir(res, paginaAviso(ctx, { titulo: "Imóvel não encontrado", texto: "Este endereço não corresponde a nenhum imóvel. Veja os que estão disponíveis ou fale com a gente." }), 404);
  if (!r.disponivel) {
    const fechado = r.status === "vendido" ? "Este imóvel já foi vendido." : r.status === "alugado" ? "Este imóvel já foi alugado." : "Este imóvel não está mais disponível.";
    return servir(res, paginaAviso(ctx, { titulo: r.titulo, texto: `${fechado} Temos outras opções parecidas — dá uma olhada ou chama a gente no WhatsApp.` }), 410);
  }
  // Título trocado depois de o link circular: leva para o endereço atual, em
  // vez de manter no ar um endereço que diz uma coisa e mostra outra.
  const certo = slugify(r.imovel.titulo) || "imovel";
  if (req.params.titulo !== certo) return res.redirect(301, `${ctx.raiz}/${r.imovel.id}/${certo}`);
  servir(res, paginaImovel(ctx, r.imovel));
}

/* ===== O SITE NO DOMÍNIO DA IMOBILIÁRIA (04/10/2026) =====

   Pedido que chega com o endereço (Host) de um domínio cadastrado num site
   vira o site, na raiz: /, /<id>/<titulo>, /sitemap.xml, /robots.txt e a
   marca de conferência. Os arquivos (/arquivos/…) seguem para o servidor de
   sempre — são as fotos. Qualquer outra coisa nesse endereço (o CRM, a API)
   responde "não encontrado": o domínio da imobiliária é o site dela, e não
   uma segunda porta para o sistema.

   Pedido de qualquer outro endereço passa direto (`next()`), sem custo: a
   pergunta "este endereço é de algum site?" é respondida por uma tabela em
   memória. Por isso esta é a única peça montada no servidor sem caminho — ela
   não barra nada do endereço do ConHub; só responde pelos domínios dos sites. */
export const dominioProprio = Router();
dominioProprio.use((req, res, next) => {
  const achado = orgDoDominio(req.get("host"));
  if (!achado) return next();
  if (req.path.startsWith("/arquivos/")) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
  const base = `https://${String(req.get("host")).toLowerCase().replace(/:\d+$/, "")}`;
  if (req.path === "/.well-known/conhub-site")
    return res.set("Cache-Control", "no-store").json({ site: marcaDoSite(achado.org_id) });
  const ctx = pronto(siteDoDominio(req.get("host")), res, { base, raiz: "" });
  if (!ctx) return;
  if (req.path === "/") return servir(res, paginaPortal(ctx, req.query));
  if (req.path === "/sitemap.xml") return res.type("application/xml").set("Cache-Control", "no-cache").send(sitemap(ctx));
  if (req.path === "/robots.txt") return res.type("text/plain").set("Cache-Control", "no-cache").send(robots(ctx));
  const m = req.path.match(/^\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (m && !/\./.test(m[1])) { req.params = { id: m[1], titulo: m[2] }; return paginaDoImovel(ctx, req, res); }
  return servir(res, paginaAviso(ctx, { titulo: "Página não encontrada", texto: "Este endereço não existe. Veja os imóveis disponíveis ou fale com a gente." }), 404);
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
    org_nome: (db.prepare("SELECT name FROM orgs WHERE id = ?").get(req.user.org_id) || {}).name || "",
    gtm_id: c.gtm_id || "", seo_titulo: c.seo_titulo || "", seo_descricao: c.seo_descricao || "",
    dominio: c.dominio || "", dominio_destino: c.dominio_destino || "", dominio_estado: c.dominio_estado || null,
    dominio_detalhe: c.dominio_detalhe || "", dominio_conferido_em: c.dominio_conferido_em || null,
    url_dominio: c.dominio ? `https://${c.dominio}` : null,
    // Os registros que a imobiliária cria no DNS (CNAME de rota + TXT de
    // verificação), lidos do Railway. Vazio sem o cadastro automático.
    dominio_registros: registrosDoSite(c),
    dominio_automatico: railwayPronto().ok,
  };
}

gestao.get("/", (req, res) => res.json(resposta(req)));

gestao.patch("/", async (req, res) => {
  const r = salvarSite(req.user.org_id, req.body || {});
  if (r.erro) return res.status(400).json({ error: r.erro });
  // Domínio trocado: sai o cadastro antigo no Railway e entra o novo — a tela
  // já volta com os registros de DNS para a imobiliária criar.
  if (r.remover) await removerDominio(r.remover);
  if (r.mudouDominio && r.cfg.dominio) {
    try { await verificarDominio(req.user.org_id); } catch (e) { console.warn("[site] conferência:", e.message); }
  }
  res.json(resposta(req));
});

// "Conferir agora": em que passo o domínio próprio está.
gestao.post("/dominio/verificar", async (req, res) => {
  try { await verificarDominio(req.user.org_id); res.json(resposta(req)); }
  catch (e) { console.error("[site] conferência do domínio:", e.message); res.status(500).json({ error: "Não consegui conferir o domínio agora." }); }
});
