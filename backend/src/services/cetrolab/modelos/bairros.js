/* MODELO "BAIRROS" (12/10/2026) — o 2F que o Ali escolheu: futurista e
   minimalista, e a vitrine começa pelo BAIRRO, não pela lista.

   Mesmas regras de todo site do ConHub (services/site.js): montado no
   servidor (a prévia do link no WhatsApp precisa do HTML pronto), só a lista
   branca do imóvel, contato sempre pelo WhatsApp da imobiliária, Pixel e Tag
   Manager pelas mesmas peças. O que muda é a cara e a ordem da conversa.

   A cor de destaque é a da MARCA da imobiliária (Configurações → Identidade):
   ela já passou pela régua de contraste com o branco, então funciona sobre o
   painel escuro e no botão. */
import { FRASE_PADRAO } from "../../site.js";
import { catalogo, filtrosDe, bairrosDoCatalogo } from "../fonte.js";
import { pecas, comPrevia, moldura, cartao, paginaImovel as imovelFuturo } from "./comum.js";

const { esc, abs, inicio, moeda, wa, ICO, dadosDaImobiliaria } = pecas;

export function paginaPortal(ctx, query) {
  const { org, cfg, base } = ctx;
  const f = filtrosDe(query);
  const bairros = bairrosDoCatalogo(org.id);
  const sel = f.bairro ? bairros.find(b => b.bairro === f.bairro) || null : null;
  if (f.bairro && !sel) f.bairro = "";
  const c = catalogo(org.id, f);
  const portal = inicio(ctx);
  const link = (mudar) => {
    const q = { ...f, ...mudar };
    const s = new URLSearchParams();
    for (const k of ["finalidade", "bairro"]) if (q[k]) s.set(k, q[k]);
    if (q.p > 1) s.set("p", q.p);
    if (ctx.previa) s.set("previa", ctx.previa);
    const t = s.toString();
    return portal + (t ? "?" + t : "");
  };
  const chip = (v, t) => `<a href="${esc(link({ finalidade: v, p: 1 }))}" class="${f.finalidade === v ? "on" : ""}">${t}</a>`;
  const totalBairros = bairros.length;

  const ficha = sel
    ? `<div class="mono" style="font-size:11px;color:#6B7280">BAIRRO · ${esc(sel.cidade || "")}</div>
       <h2>${esc(sel.bairro)}</h2>
       <p>${sel.total} ${sel.total === 1 ? "imóvel disponível" : "imóveis disponíveis"} neste bairro.</p>
       <div class="par"><div><span>COMPRA DESDE</span><b>${sel.venda_desde ? moeda(sel.venda_desde) : "—"}</b></div>
         <div><span>ALUGUEL DESDE</span><b>${sel.aluguel_desde ? moeda(sel.aluguel_desde) : "—"}</b></div></div>
       <a class="btn btn-escuro" href="#lista" style="margin-top:auto">Ver ${sel.total} ${sel.total === 1 ? "imóvel" : "imóveis"}</a>`
    : `<div class="mono" style="font-size:11px;color:#6B7280">TODOS OS BAIRROS</div>
       <h2>${c.disponiveis} ${c.disponiveis === 1 ? "imóvel" : "imóveis"}</h2>
       <p>${totalBairros ? `Em ${totalBairros} ${totalBairros === 1 ? "bairro" : "bairros"}. Toque num bairro para ver o que tem lá e quanto custa morar.` : "Fale com a gente e encontramos o imóvel certo para você."}</p>
       <a class="btn btn-escuro" href="#lista" style="margin-top:auto">Ver todos</a>`;

  const nomeLista = sel ? `Em ${sel.bairro}` : f.finalidade === "aluguel" ? "Para alugar" : f.finalidade === "venda" ? "À venda" : "Disponíveis agora";
  const corpo = `
<section class="heroi"><div class="wrap">
  <div class="kicker mono">${c.disponiveis} IMÓVEIS · ${totalBairros} ${totalBairros === 1 ? "BAIRRO" : "BAIRROS"}</div>
  <h1>${esc(cfg.frase || FRASE_PADRAO)}</h1>
  <nav class="chips" aria-label="Tipo de negócio">${chip("", "Todos")}${chip("venda", "Comprar")}${chip("aluguel", "Alugar")}</nav>
</div></section>
<main class="wrap">
  ${totalBairros ? `<section class="painel" id="bairros" aria-label="Explorar por bairro">
    <div class="nuvem"><span class="rot mono">EXPLORE POR BAIRRO</span>
      <nav class="bairros">${sel ? `<a href="${esc(link({ bairro: "", p: 1 }))}">Todos</a>` : ""}${bairros.map(b =>
        `<a href="${esc(link({ bairro: b.bairro, p: 1 }))}#bairros" class="${sel && sel.bairro === b.bairro ? "on" : ""}">${esc(b.bairro)}<b>${b.total}</b></a>`).join("")}</nav></div>
    <div class="ficha-bairro">${ficha}</div>
  </section>` : ""}
  <section id="lista">
    <div class="lista-topo"><h2>${esc(nomeLista)}</h2><span class="mono" style="font-size:12px;color:#6B7280">${c.total} ${c.total === 1 ? "RESULTADO" : "RESULTADOS"}</span></div>
    ${c.itens.length ? `<div class="grade">${c.itens.map(i => cartao(ctx, i)).join("")}</div>`
      : `<div class="vazio"><h3 style="margin-top:0">Nada por aqui agora</h3><p>Muitas vezes o imóvel certo ainda não foi anunciado.</p>
         <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e não encontrei o que procuro. Pode me ajudar?`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div>`}
    ${c.paginas > 1 ? `<nav class="paginas">${f.p > 1 ? `<a class="btn btn-escuro" href="${esc(link({ p: f.p - 1 }))}#lista">Anterior</a>` : ""}<span class="btn" style="background:#fff">${f.p} de ${c.paginas}</span>${f.p < c.paginas ? `<a class="btn btn-escuro" href="${esc(link({ p: f.p + 1 }))}#lista">Próxima</a>` : ""}</nav>` : ""}
  </section>
</main>`;
  const capa = c.itens.find(i => i.fotos[0]);
  return moldura(ctx, { tema: "claro",
    titulo: cfg.seo_titulo || `${org.name} — Imóveis por bairro`,
    descricao: cfg.seo_descricao || `${c.disponiveis} imóveis à venda e para alugar${totalBairros ? ` em ${totalBairros} bairros` : ""}. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + portal, corpo,
    imagem: ctx.marca.logo ? abs(base, ctx.marca.logo) : capa ? abs(base, capa.fotos[0]) : null,
    indexar: !f.finalidade && !f.bairro && f.p === 1,
    dados: dadosDaImobiliaria(ctx),
  });
}

export const paginaImovel = (ctx, i) => imovelFuturo(ctx, i, "claro");
