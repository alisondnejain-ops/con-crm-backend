/* MODELO "BAIRROS" (12/10/2026) — o 2F que o Ali escolheu: futurista e
   minimalista, e a vitrine começa pelo BAIRRO, não pela lista.

   Mesmas regras de todo site do ConHub (services/site.js): montado no
   servidor (a prévia do link no WhatsApp precisa do HTML pronto), só a lista
   branca do imóvel, contato sempre pelo WhatsApp da imobiliária, Pixel e Tag
   Manager pelas mesmas peças. O que muda é a cara e a ordem da conversa.

   A cor de destaque é a da MARCA da imobiliária (Configurações → Identidade):
   ela já passou pela régua de contraste com o branco, então funciona sobre o
   painel escuro e no botão. */
import { pecas, FRASE_PADRAO } from "../../site.js";
import { catalogo, filtrosDe, bairrosDoCatalogo } from "../fonte.js";

const { esc, abs, inicio, hrefImovel, jsonLd, gtmHead, gtmBody, pixel, moeda, numero, telefoneLegivel, wa,
  caracteristicas, ICO, dadosDaImobiliaria, dadosDoImovel, resumoDoImovel, pixelDoImovel } = pecas;

const comPrevia = (ctx, href) => (ctx.previa ? href + (href.includes("?") ? "&" : "?") + "previa=" + encodeURIComponent(ctx.previa) : href);

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#F3F4F6;color:#0D0F12;font-family:'Space Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
img{display:block;max-width:100%}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px}
.topo{padding:20px 0}
.topo .wrap{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.marca{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:600;letter-spacing:4px;text-transform:uppercase;font-size:14px}
.marca img{height:38px;width:auto}
.pilula{display:inline-flex;align-items:center;gap:8px;text-decoration:none;border:1px solid #0D0F12;border-radius:999px;padding:11px 18px;font-size:12px;letter-spacing:1px;font-family:'JetBrains Mono',monospace;min-height:44px}
.pilula svg,.btn svg{width:18px;height:18px}
.heroi{padding:36px 0 26px}
.kicker{font-size:12px;color:#6B7280;letter-spacing:1px}
.heroi h1{font-weight:300;font-size:clamp(38px,6.5vw,92px);line-height:.96;letter-spacing:-.03em;margin:16px 0 26px;max-width:980px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips a{text-decoration:none;font-size:15px;min-height:46px;display:inline-flex;align-items:center;padding:0 20px;border-radius:999px;border:1px solid #D1D5DB}
.chips a.on{background:#0D0F12;border-color:#0D0F12;color:#fff}
.painel{position:relative;border-radius:32px;background-color:#0D0F12;background-image:radial-gradient(rgba(255,255,255,.12) 1px,transparent 1px);background-size:22px 22px;padding:28px;display:flex;flex-wrap:wrap;gap:20px;margin:12px 0 48px}
.nuvem{flex:999 1 480px;min-width:0;display:flex;flex-direction:column;gap:18px;min-height:220px}
.nuvem .rot{color:#9CA3AF;font-size:11px}
.bairros{display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start}
.bairros a{text-decoration:none;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:0 16px;min-height:44px;display:inline-flex;align-items:center;gap:10px;font-size:15px;background:rgba(255,255,255,.03)}
.bairros a b{font-family:'JetBrains Mono',monospace;font-weight:400;font-size:12px;color:#9CA3AF}
.bairros a.on{background:var(--marca);border-color:var(--marca)}
.bairros a.on b{color:#fff}
.ficha-bairro{flex:1 1 320px;min-width:0;background:rgba(255,255,255,.96);border-radius:24px;padding:24px;display:flex;flex-direction:column;gap:14px}
.ficha-bairro h2{font-size:clamp(32px,4vw,44px);font-weight:400;letter-spacing:-.03em;margin:0;line-height:1}
.ficha-bairro p{margin:0;color:#4B5563;font-size:15px;line-height:1.55}
.par{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:#E5E7EB;border-radius:14px;overflow:hidden}
.par div{background:#fff;padding:14px}
.par span{display:block;font-family:'JetBrains Mono',monospace;font-size:10px;color:#6B7280;letter-spacing:.5px}
.par b{font-size:19px;font-weight:500}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;border-radius:999px;padding:0 24px;min-height:50px;font-weight:600;font-size:15px;border:0;cursor:pointer}
.btn-escuro{background:#0D0F12;color:#fff}
.btn-marca{background:var(--marca);color:#fff}
.lista-topo{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.lista-topo h2{font-weight:400;font-size:clamp(28px,3.4vw,36px);letter-spacing:-.02em;margin:0}
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px}
.card{text-decoration:none;background:#fff;border-radius:26px;padding:12px;display:flex;flex-direction:column;gap:12px;transition:transform .2s}
.card:hover{transform:translateY(-3px)}
.card .foto{position:relative;aspect-ratio:4/3;border-radius:18px;overflow:hidden;background:#E5E7EB}
.card .foto img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.card .foto .selo{position:absolute;left:10px;top:10px;background:rgba(13,15,18,.72);color:#fff;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.5px;padding:6px 10px;border-radius:999px}
.card .txt{padding:0 6px 8px;display:flex;flex-direction:column;gap:6px}
.card h3{font-size:19px;font-weight:500;margin:0;line-height:1.25}
.card .info{font-family:'JetBrains Mono',monospace;font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.3px}
.card .preco{font-size:18px;font-weight:600;color:var(--marca)}
.card .preco small,.preco small{font-size:.65em;font-weight:500;color:#6B7280}
.sem-foto{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9CA3AF}
.sem-foto svg{width:36px;height:36px;stroke:currentColor;fill:none;stroke-width:1.5}
.paginas{display:flex;gap:8px;justify-content:center;margin:28px 0 0}
.vazio{background:#fff;border-radius:26px;padding:36px;text-align:center}
.rodape{padding:48px 0 56px}
.fim{background:#0D0F12;color:#fff;border-radius:32px;padding:36px;display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between;align-items:center}
.fim .frase{font-size:clamp(24px,3vw,32px);font-weight:300;letter-spacing:-.02em;max-width:560px}
.fina{font-size:12px;color:#6B7280;margin-top:18px;display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:space-between}
.previa{position:sticky;top:0;z-index:9;background:#0D0F12;color:#fff;text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px;padding:8px 12px}
/* Página do imóvel */
.volta{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:12px;color:#4B5563;min-height:44px}
.volta svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}
.trilho{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;border-radius:28px}
.trilho::-webkit-scrollbar{display:none}
.trilho img{flex:0 0 auto;width:min(860px,88%);height:clamp(260px,52vw,560px);object-fit:cover;border-radius:28px;scroll-snap-align:start;background:#E5E7EB}
.trilho .so{width:100%}
.setas{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.setas button{width:46px;height:46px;border-radius:50%;border:1px solid #D1D5DB;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}
.setas svg{width:18px;height:18px;stroke:#0D0F12;fill:none;stroke-width:2}
.corpo{display:flex;flex-wrap:wrap;gap:20px;margin:26px 0 56px;align-items:flex-start}
.corpo article{flex:999 1 520px;min-width:0}
.corpo h1{font-weight:300;font-size:clamp(32px,4.6vw,58px);letter-spacing:-.03em;line-height:1;margin:10px 0 14px}
.onde{font-family:'JetBrains Mono',monospace;font-size:12px;color:#4B5563;text-transform:uppercase}
.specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:#E5E7EB;border-radius:18px;overflow:hidden;margin:24px 0}
.specs div{background:#fff;padding:16px}
.specs span{display:block;font-family:'JetBrains Mono',monospace;font-size:10px;color:#6B7280;letter-spacing:.5px;text-transform:uppercase}
.specs b{font-size:22px;font-weight:400}
.texto{white-space:pre-line;line-height:1.7;color:#374151;font-size:16px}
.secao h2{font-family:'JetBrains Mono',monospace;font-weight:400;font-size:12px;color:#6B7280;letter-spacing:1px;margin:30px 0 10px}
video{width:100%;border-radius:22px;background:#000}
.lateral{flex:1 1 300px;min-width:0;background:#0D0F12;color:#fff;border-radius:28px;padding:26px;display:flex;flex-direction:column;gap:14px;position:sticky;top:20px}
.lateral .rot{font-family:'JetBrains Mono',monospace;font-size:11px;color:#9CA3AF}
.lateral .preco{font-size:34px;font-weight:300;letter-spacing:-.02em}
.lateral .preco small{color:#9CA3AF}
.custos{font-family:'JetBrains Mono',monospace;font-size:12px;color:#D1D5DB;display:flex;flex-direction:column;gap:6px}
.cod{font-family:'JetBrains Mono',monospace;font-size:11px;color:#9CA3AF}
.barra-cel{display:none}
@media (max-width:760px){
  .painel{padding:18px;border-radius:24px}
  .lateral{position:static}
  .barra-cel{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:8;gap:10px;align-items:center;background:#0D0F12;color:#fff;padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
  .barra-cel .preco{font-size:18px;font-weight:500;flex:1;min-width:0}
  body.tem-barra{padding-bottom:84px}
}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

function moldura(ctx, { titulo, descricao, url, imagem, corpo, pixelExtra = "", indexar = true, classeBody = "", dados = null }) {
  const { org, marca, cfg, base } = ctx;
  const logo = marca.logo ? abs(base, marca.logo) : null;
  const msgGeral = `Olá! Vim pelo site da ${org.name} e gostaria de ajuda para encontrar um imóvel.`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
${gtmHead(cfg)}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
${indexar && !ctx.previa ? "" : '<meta name="robots" content="noindex">'}
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(org.name)}">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao)}">
<meta property="og:url" content="${esc(url)}">${imagem ? `<meta property="og:image" content="${esc(imagem)}"><meta name="twitter:card" content="summary_large_image">` : ""}
<meta name="theme-color" content="#0D0F12">
${logo ? `<link rel="icon" href="${esc(logo)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>:root{--marca:${esc(marca.cor)}}${CSS}</style>
${pixel(cfg, pixelExtra)}${jsonLd(dados)}
</head><body class="${classeBody}">${gtmBody(cfg)}
${ctx.previa ? `<div class="previa">PRÉVIA DO MODELO — o site no ar continua com o modelo escolhido</div>` : ""}
<header class="topo"><div class="wrap">
  <a class="marca" href="${esc(comPrevia(ctx, inicio(ctx)))}" aria-label="${esc(org.name)} — início">${logo ? `<img src="${esc(logo)}" alt="${esc(org.name)}">` : `<span>${esc(org.name)}</span>`}</a>
  <a class="pilula" data-contato href="${esc(wa(cfg.whatsapp, msgGeral))}" target="_blank" rel="noopener">${ICO.wpp}FALAR COM CORRETOR</a>
</div></header>
${corpo}
<footer class="rodape"><div class="wrap">
  <div class="fim"><div class="frase">Não achou o que procura? Conta pra gente como você quer viver.</div>
    <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, msgGeral))}" target="_blank" rel="noopener">${ICO.wpp}Conversar no WhatsApp</a></div>
  <div class="fina"><span>${esc(org.name)} · WhatsApp ${esc(telefoneLegivel(cfg.whatsapp))}</span>
    <span>${cfg.pixel_id || cfg.gtm_id ? "Este site usa cookies para medir anúncios e visitas. · " : ""}© ${new Date().getFullYear()} ${esc(org.name)} · Site por Cetrolab</span></div>
</div></footer>
<script>document.querySelectorAll('[data-contato]').forEach(function(a){a.addEventListener('click',function(){try{if(window.fbq)fbq('track','Lead',{content_name:a.getAttribute('data-nome')||'Site'})}catch(e){}})});</script>
</body></html>`;
}

const fotoOu = (u, alt, lazy) => u ? `<img src="${esc(u)}" alt="${esc(alt)}"${lazy ? ' loading="lazy"' : ""}>` : `<div class="sem-foto">${ICO.casa}</div>`;
const precoDe = (i) => (i.valor ? moeda(i.valor) + (i.finalidade === "aluguel" ? "<small>/mês</small>" : "") : "Consulte");
const linhaInfo = (i) => [
  i.quartos ? `${i.quartos} ${i.quartos > 1 ? "qts" : "qt"}` : "",
  i.area_util ? `${numero(i.area_util)} m²` : i.terreno ? `${numero(i.terreno)} m²` : "",
  i.vagas ? `${i.vagas} ${i.vagas > 1 ? "vagas" : "vaga"}` : "",
  i.local.curta,
].filter(Boolean).join(" · ");

function cartao(ctx, i) {
  return `<a class="card" href="${esc(comPrevia(ctx, hrefImovel(ctx, i)))}">
  <div class="foto">${fotoOu(i.fotos[0], i.titulo, true)}<span class="selo">${i.finalidade === "aluguel" ? "ALUGUEL" : "VENDA"}</span></div>
  <div class="txt"><h3>${esc(i.titulo)}</h3><span class="info">${esc(linhaInfo(i))}</span><span class="preco">${precoDe(i)}</span></div></a>`;
}

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
  return moldura(ctx, {
    titulo: cfg.seo_titulo || `${org.name} — Imóveis por bairro`,
    descricao: cfg.seo_descricao || `${c.disponiveis} imóveis à venda e para alugar${totalBairros ? ` em ${totalBairros} bairros` : ""}. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + portal, corpo,
    imagem: ctx.marca.logo ? abs(base, ctx.marca.logo) : capa ? abs(base, capa.fotos[0]) : null,
    indexar: !f.finalidade && !f.bairro && f.p === 1,
    dados: dadosDaImobiliaria(ctx),
  });
}

export function paginaImovel(ctx, i) {
  const { org, cfg, base } = ctx;
  const url = base + hrefImovel(ctx, i);
  const linkWa = wa(cfg.whatsapp, `Olá! Tenho interesse no imóvel "${i.titulo}" (cód. ${i.codigo}) que vi no site: ${url}`);
  const specs = caracteristicas(i, false).map(([, v, r]) => `<div><span>${esc(r || "área")}</span><b>${esc(v)}</b></div>`).join("");
  const custos = [i.condominio ? `CONDOMÍNIO · ${moeda(i.condominio)}/MÊS` : "", i.iptu ? `IPTU · ${moeda(i.iptu)}/ANO` : ""].filter(Boolean);
  const fotos = i.fotos;
  const galeria = fotos.length
    ? `<div class="trilho" id="trilho">${fotos.map((u, n) => `<img class="${fotos.length === 1 ? "so" : ""}" src="${esc(u)}" alt="${esc(i.titulo)} — foto ${n + 1}"${n ? ' loading="lazy"' : ""}>`).join("")}</div>
       ${fotos.length > 1 ? `<div class="setas"><button type="button" data-d="-1" aria-label="Foto anterior">${ICO.voltar}</button><button type="button" data-d="1" aria-label="Próxima foto">${ICO.seta}</button></div>` : ""}`
    : "";
  const corpo = `
<main class="wrap">
  <a class="volta" href="${esc(comPrevia(ctx, inicio(ctx)))}">${ICO.voltar}TODOS OS IMÓVEIS</a>
  ${galeria}
  <div class="corpo">
    <article>
      <span class="onde">${i.finalidade === "aluguel" ? "ALUGUEL" : "VENDA"}${i.local.linha ? " · " + esc(i.local.linha) : ""}</span>
      <h1>${esc(i.titulo)}</h1>
      ${specs ? `<div class="specs">${specs}</div>` : ""}
      ${i.descricao ? `<div class="secao"><h2>SOBRE O IMÓVEL</h2><p class="texto">${esc(i.descricao)}</p></div>` : ""}
      ${i.video ? `<div class="secao"><h2>VÍDEO</h2><video src="${esc(i.video)}" controls preload="metadata" playsinline></video></div>` : ""}
    </article>
    <aside class="lateral">
      <span class="rot">${i.finalidade === "aluguel" ? "ALUGUEL" : "VALOR"}</span>
      <div class="preco">${precoDe(i)}</div>
      ${custos.length ? `<div class="custos">${custos.map(t => `<span>${t}</span>`).join("")}</div>` : ""}
      <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(linkWa)}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a>
      <span class="cod">CÓD. ${esc(i.codigo)}</span>
    </aside>
  </div>
</main>
<div class="barra-cel"><div class="preco">${precoDe(i)}</div>
  <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(linkWa)}" target="_blank" rel="noopener">${ICO.wpp}WhatsApp</a></div>
<script>(function(){var t=document.getElementById('trilho');if(!t)return;document.querySelectorAll('.setas button').forEach(function(b){b.onclick=function(){var img=t.querySelector('img');t.scrollBy({left:(+b.dataset.d)*((img?img.clientWidth:t.clientWidth)+12),behavior:'smooth'})}})})();</script>`;
  return moldura(ctx, {
    titulo: `${i.titulo} — ${org.name}`, descricao: resumoDoImovel(i), url, corpo,
    classeBody: "tem-barra", pixelExtra: pixelDoImovel(i), dados: dadosDoImovel(ctx, i, url),
    imagem: fotos[0] ? abs(base, fotos[0]) : (ctx.marca.logo ? abs(base, ctx.marca.logo) : null),
  });
}
