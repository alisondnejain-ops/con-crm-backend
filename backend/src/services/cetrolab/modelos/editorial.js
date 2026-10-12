/* MODELO "EDITORIAL" (12/10/2026) — o 1F do estudo de modelos: escuro, com a
   grade fina ao fundo, um imóvel em destaque como capa de revista, os bairros
   como "coleções" e o catálogo como um ÍNDICE numerado (01, 02, 03…), como num
   catálogo de galeria. Tudo sai do catálogo da imobiliária — nada inventado.
   A página do imóvel é a comum dos modelos futuristas (comum.js), no tema escuro. */
import { FRASE_PADRAO } from "../../site.js";
import { catalogo, filtrosDe, bairrosDoCatalogo } from "../fonte.js";
import { pecas, comPrevia, moldura, fotoOu, precoDe, linhaInfo, paginaImovel as imovelFuturo } from "./comum.js";

const { esc, abs, inicio, hrefImovel, wa, ICO, dadosDaImobiliaria } = pecas;

const CSS = `
body{background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:80px 80px}
.ed-h1{font-weight:300;font-size:clamp(42px,7.5vw,108px);line-height:.95;letter-spacing:-.035em;margin:20px 0 26px;max-width:1050px}
.capa{position:relative;display:block;height:clamp(320px,46vw,540px);border-radius:28px;overflow:hidden;border:1px solid var(--linha);background:var(--cartao);text-decoration:none;color:#fff;margin:6px 0 64px}
.capa img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.capa .sem-foto{color:var(--fraco)}
.capa .vidros{position:absolute;left:16px;right:16px;bottom:16px;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:flex-end}
.vidro{background:rgba(10,11,13,.66);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:14px 18px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.vidro .ref{font-family:'JetBrains Mono',monospace;font-size:11px;color:#B9BEC6}
.vidro .nome{font-size:clamp(20px,2.4vw,26px);font-weight:500;margin-top:4px}
.etiq{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.etiq span{background:rgba(10,11,13,.66);border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:9px 14px;font-family:'JetBrains Mono',monospace;font-size:12px}
.etiq .ir{background:var(--marca);border-color:var(--marca);font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:13px}
.secao-topo{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;border-top:1px solid var(--linha);padding-top:18px;margin-bottom:24px}
.secao-topo h2{font-weight:400;font-size:clamp(28px,3.4vw,36px);letter-spacing:-.02em;margin:0}
.secao-topo span{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--fraco)}
.colecoes{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:64px}
.colecao{text-decoration:none;border:1px solid var(--linha);border-radius:22px;padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--cartao)}
.colecao .foto{position:relative;height:200px;border-radius:14px;overflow:hidden;background:var(--linha)}
.colecao .foto img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.colecao .rod{display:flex;justify-content:space-between;align-items:baseline;padding:0 4px 4px;gap:10px}
.colecao .rod b{font-size:19px;font-weight:500}
.colecao .rod span{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--fraco)}
.indice a{text-decoration:none;display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:16px;align-items:center;padding:20px 0;border-bottom:1px solid var(--linha)}
.indice .n{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--fraco)}
.indice .t{display:flex;flex-direction:column;gap:5px;min-width:0}
.indice .t b{font-size:clamp(19px,2.2vw,24px);font-weight:400;letter-spacing:-.01em}
.indice .t span{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--fraco);text-transform:uppercase}
.indice .v{font-size:16px;font-weight:500;text-align:right}
.indice .v small{color:var(--fraco)}
.indice a:hover .t b{color:#fff}
@media (max-width:600px){.indice a{grid-template-columns:34px minmax(0,1fr)}.indice .v{grid-column:2;text-align:left}}
`;

export function paginaPortal(ctx, query) {
  const { org, cfg, base } = ctx;
  const f = filtrosDe(query);
  const c = catalogo(org.id, f);
  const portal = inicio(ctx);
  const filtrando = f.finalidade || f.bairro || f.p > 1;
  const link = (mudar) => {
    const q = { ...f, ...mudar }; const s = new URLSearchParams();
    for (const k of ["finalidade", "bairro"]) if (q[k]) s.set(k, q[k]);
    if (q.p > 1) s.set("p", q.p);
    if (ctx.previa) s.set("previa", ctx.previa);
    const t = s.toString(); return portal + (t ? "?" + t : "");
  };
  // Capa: o imóvel mais recente com foto — só na página inicial sem filtro.
  const capa = !filtrando ? (c.itens.find(i => i.fotos[0]) || c.itens[0]) : null;
  const lista = capa ? c.itens.filter(i => i.id !== capa.id) : c.itens;
  // Coleções: os bairros com mais imóveis, cada um com a foto de um imóvel de lá.
  const colecoes = !filtrando ? bairrosDoCatalogo(org.id).slice(0, 3).map(b => ({
    ...b, foto: (catalogo(org.id, { ...filtrosDe({}), bairro: b.bairro }).itens.find(i => i.fotos[0]) || { fotos: [] }).fotos[0] || null,
  })) : [];
  const chip = (v, t) => `<a href="${esc(link({ finalidade: v, bairro: "", p: 1 }))}" class="${f.finalidade === v && !f.bairro ? "on" : ""}">${t}</a>`;
  const n0 = (f.p - 1) * 24;

  const corpo = `
<section class="heroi"><div class="wrap">
  <div class="kicker mono">${c.disponiveis} ${c.disponiveis === 1 ? "IMÓVEL DISPONÍVEL" : "IMÓVEIS DISPONÍVEIS"} · ${esc(org.name.toUpperCase())}</div>
  <h1 class="ed-h1">${esc(cfg.frase || FRASE_PADRAO)}</h1>
  <nav class="chips" aria-label="Tipo de negócio">${chip("", "Todos")}${chip("venda", "Comprar")}${chip("aluguel", "Alugar")}${f.bairro ? `<a class="on" href="${esc(link({ bairro: "", p: 1 }))}">${esc(f.bairro)} ✕</a>` : ""}</nav>
</div></section>
<main class="wrap">
  ${capa ? `<a class="capa" href="${esc(comPrevia(ctx, hrefImovel(ctx, capa)))}">${fotoOu(capa.fotos[0], capa.titulo, false)}
    <div class="vidros"><div class="vidro"><div class="ref">EM DESTAQUE · CÓD. ${esc(capa.codigo)}</div><div class="nome">${esc(capa.titulo)}</div></div>
      <div class="etiq">${linhaInfo(capa) ? `<span>${esc(linhaInfo(capa).split(" · ").slice(0, 2).join(" · "))}</span>` : ""}<span>${precoDe(capa)}</span><span class="ir">Ver imóvel →</span></div></div></a>` : ""}
  ${colecoes.length >= 2 ? `<section><div class="secao-topo"><h2>Coleções</h2><span>POR BAIRRO</span></div>
    <div class="colecoes">${colecoes.map(b => `<a class="colecao" href="${esc(link({ bairro: b.bairro, finalidade: "", p: 1 }))}#indice">
      <div class="foto">${fotoOu(b.foto, b.bairro, true)}</div><div class="rod"><b>${esc(b.bairro)}</b><span>${String(b.total).padStart(2, "0")}</span></div></a>`).join("")}</div></section>` : ""}
  <section id="indice"><div class="secao-topo"><h2>${f.bairro ? esc(f.bairro) : "Índice"}</h2><span>${c.total} ${c.total === 1 ? "IMÓVEL" : "IMÓVEIS"}</span></div>
    ${lista.length ? `<div class="indice">${lista.map((i, k) => `<a href="${esc(comPrevia(ctx, hrefImovel(ctx, i)))}">
      <span class="n">${String(n0 + k + (capa ? 2 : 1)).padStart(2, "0")}</span>
      <span class="t"><b>${esc(i.titulo)}</b><span>${esc(linhaInfo(i))}</span></span>
      <span class="v">${precoDe(i)}</span></a>`).join("")}</div>`
      : capa ? "" : `<div class="vazio"><h3 style="margin-top:0">Nada por aqui agora</h3><p>Muitas vezes o imóvel certo ainda não foi anunciado.</p>
        <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e não encontrei o que procuro. Pode me ajudar?`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div>`}
    ${c.paginas > 1 ? `<nav class="paginas">${f.p > 1 ? `<a class="btn btn-escuro" href="${esc(link({ p: f.p - 1 }))}#indice">Anterior</a>` : ""}<span class="btn" style="border:1px solid var(--borda)">${f.p} de ${c.paginas}</span>${f.p < c.paginas ? `<a class="btn btn-escuro" href="${esc(link({ p: f.p + 1 }))}#indice">Próxima</a>` : ""}</nav>` : ""}
  </section>
</main>`;
  return moldura(ctx, {
    tema: "escuro", css: CSS, corpo,
    titulo: cfg.seo_titulo || `${org.name} — Imóveis`,
    descricao: cfg.seo_descricao || `${c.disponiveis} imóveis à venda e para alugar. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + portal,
    imagem: ctx.marca.logo ? abs(base, ctx.marca.logo) : capa && capa.fotos[0] ? abs(base, capa.fotos[0]) : null,
    indexar: !filtrando, dados: dadosDaImobiliaria(ctx),
    fim: "Conte como você vive. A gente encontra.",
  });
}

export const paginaImovel = (ctx, i) => imovelFuturo(ctx, i, "escuro");
