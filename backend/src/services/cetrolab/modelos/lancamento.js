/* MODELO "LANÇAMENTO" (12/10/2026) — o 3F do estudo de modelos: quase preto,
   a capa ocupa a tela inteira com a foto do imóvel em destaque, o nome grande
   e fino, e os números da imobiliária num cartão de vidro (quantos imóveis,
   em quantos bairros, a partir de quanto). Combina com campanha de anúncio:
   o lead cai numa página com cara de construtora. Os números saem do
   catálogo (`resumoDoCatalogo`); nada é inventado. */
import { FRASE_PADRAO } from "../../site.js";
import { catalogo, filtrosDe, resumoDoCatalogo } from "../fonte.js";
import { pecas, comPrevia, moldura, cartao, paginaImovel as imovelFuturo } from "./comum.js";

const { esc, abs, inicio, moeda, wa, ICO, dadosDaImobiliaria, imgFoto } = pecas;

const CSS = `
.capa-l{position:relative;min-height:min(86vh,760px);display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;background:var(--cartao);margin-bottom:24px}
.capa-l>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.capa-l::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,11,13,.35) 0%,rgba(10,11,13,.15) 35%,rgba(10,11,13,.92) 100%)}
.capa-l .wrap{position:relative;z-index:1;width:100%;box-sizing:border-box;padding-bottom:48px;display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between;align-items:flex-end}
.capa-l .tit{flex:1 1 520px;min-width:0;color:#fff}
.capa-l .tit .k{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:1px}
.capa-l .tit .k i{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--marca);margin-right:8px;font-style:normal}
.capa-l h1{font-weight:300;font-size:clamp(46px,8.5vw,128px);line-height:.92;letter-spacing:-.04em;margin:14px 0 0}
.numeros{flex:0 1 360px;min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;background:rgba(10,11,13,.6);border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:22px;color:#fff;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.numeros span{display:block;font-family:'JetBrains Mono',monospace;font-size:10px;color:#B9BEC6;letter-spacing:.5px}
.numeros b{font-size:21px;font-weight:400}
.cap{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--fraco);margin-top:40px}
.cap-h{font-weight:300;font-size:clamp(34px,5vw,56px);letter-spacing:-.03em;margin:10px 0 22px}
.card{border:1px solid var(--linha)}
`;

export function paginaPortal(ctx, query) {
  const { org, cfg, base } = ctx;
  const f = filtrosDe(query);
  const c = catalogo(org.id, f);
  const r = resumoDoCatalogo(org.id);
  const portal = inicio(ctx);
  const filtrando = f.finalidade || f.p > 1;
  const link = (mudar) => {
    const q = { ...f, ...mudar }; const s = new URLSearchParams();
    if (q.finalidade) s.set("finalidade", q.finalidade);
    if (q.p > 1) s.set("p", q.p);
    if (ctx.previa) s.set("previa", ctx.previa);
    const t = s.toString(); return portal + (t ? "?" + t : "");
  };
  // A foto da capa: a do imóvel mais recente que tem foto.
  const fotoCapa = (catalogo(org.id, filtrosDe({})).itens.find(i => i.fotos[0]) || { fotos: [] }).fotos[0] || null;
  const chip = (v, t) => `<a href="${esc(link({ finalidade: v, p: 1 }))}#imoveis" class="${f.finalidade === v ? "on" : ""}">${t}</a>`;
  const num = (rot, v) => `<div><span>${rot}</span><b>${v}</b></div>`;

  const corpo = `
<section class="capa-l">${fotoCapa ? imgFoto(fotoCapa, { sizes: "100vw", lazy: false }) : ""}
  <div class="wrap">
    <div class="tit"><div class="k"><i></i>${esc(org.name.toUpperCase())}</div><h1>${esc(cfg.frase || FRASE_PADRAO)}</h1></div>
    <div class="numeros">${num("IMÓVEIS", r.total)}${num("BAIRROS", r.bairros || "—")}${num("VENDA DESDE", r.venda_desde ? moeda(r.venda_desde) : "—")}${num("ALUGUEL DESDE", r.aluguel_desde ? moeda(r.aluguel_desde) + "<small style=\"font-size:.6em;color:#B9BEC6\">/mês</small>" : "—")}</div>
  </div>
</section>
<main class="wrap" id="imoveis">
  <div class="cap">01 — IMÓVEIS</div>
  <h2 class="cap-h">Escolha o seu.</h2>
  <nav class="chips" aria-label="Tipo de negócio" style="margin-bottom:22px">${chip("", "Todos")}${chip("venda", "Comprar")}${chip("aluguel", "Alugar")}</nav>
  ${c.itens.length ? `<div class="grade">${c.itens.map(i => cartao(ctx, i)).join("")}</div>`
    : `<div class="vazio"><h3 style="margin-top:0">Nada por aqui agora</h3><p>Muitas vezes o imóvel certo ainda não foi anunciado.</p>
       <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e não encontrei o que procuro. Pode me ajudar?`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div>`}
  ${c.paginas > 1 ? `<nav class="paginas">${f.p > 1 ? `<a class="btn btn-escuro" href="${esc(link({ p: f.p - 1 }))}#imoveis">Anterior</a>` : ""}<span class="btn" style="border:1px solid var(--borda)">${f.p} de ${c.paginas}</span>${f.p < c.paginas ? `<a class="btn btn-escuro" href="${esc(link({ p: f.p + 1 }))}#imoveis">Próxima</a>` : ""}</nav>` : ""}
  <div class="cap">02 — VISITA</div>
</main>`;
  return moldura(ctx, {
    tema: "escuro", css: CSS, corpo, classeBody: "lancamento",
    titulo: cfg.seo_titulo || `${org.name} — Imóveis`,
    descricao: cfg.seo_descricao || `${r.total} imóveis à venda e para alugar. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + portal,
    imagem: fotoCapa ? abs(base, fotoCapa) : ctx.marca.logo ? abs(base, ctx.marca.logo) : null,
    indexar: !filtrando, dados: dadosDaImobiliaria(ctx),
    fim: "Quer conhecer pessoalmente? A gente agenda a visita pelo WhatsApp.",
  });
}

export const paginaImovel = (ctx, i) => imovelFuturo(ctx, i, "escuro");
