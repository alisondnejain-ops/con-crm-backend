/* MODELO "INSTITUCIONAL" (12/10/2026) — pedido do Ali a partir do site da
   Invix Imóveis: *"um site extremamente institucional e muito bem feito, para
   a gente usar como base para os próximos modelos"*, mas sem o que ele achou
   ruim lá: *"quadrado, robusto, difícil de usar, sem fluidez"*.

   A ESTRUTURA é a do site de referência, de cima para baixo: cabeçalho com
   menu, WhatsApp e redes; capa em carrossel com os imóveis (código, tipo,
   título, lugar e "Mais detalhes"); "São N imóveis disponíveis à sua espera!"
   com a busca logo abaixo e o "Buscar por código"; Imóveis em destaque;
   Lançamentos; Sobre nós; O que falam de nós; Nossa equipe com foto; e o
   "Anunciar imóvel".

   O QUE MUDOU para ficar fluido: cantos arredondados em vez de caixas retas;
   os carrosséis deslizam com o dedo (rolagem nativa com encaixe, não um
   componente que trava); as setas só aparecem no computador; a busca é um
   cartão só, que no celular vira uma coluna; e o menu do celular é uma gaveta
   que não tampa a tela.

   O que não está no catálogo vem do CONTEÚDO INSTITUCIONAL que a imobiliária
   cadastra no Cetrolab (services/cetrolab/conteudo.js). Sem conteúdo, a
   seção não aparece — nada de depoimento ou equipe de exemplo num site real.
   "Lançamentos" são os imóveis cadastrados como empreendimento. */
import { FRASE_PADRAO } from "../../site.js";
import { catalogo, filtrosDe, resumoDoCatalogo, bairrosDoCatalogo, conteudoPublico } from "../fonte.js";
import { pecas, comPrevia } from "./comum.js";

const { esc, abs, inicio, hrefImovel, jsonLd, gtmHead, gtmBody, pixel, moeda, numero, telefoneLegivel, wa,
  caracteristicas, ICO, dadosDaImobiliaria, dadosDoImovel, resumoDoImovel, pixelDoImovel, imgFoto } = pecas;

const SOCIAL = {
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M15 8h-1.5A1.5 1.5 0 0 0 12 9.5V21M9.5 13H15"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.5v5l4.5-2.5z"/></svg>',
};
const MENU = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const LUPA = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>';
const ASPAS = '<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke:none"><path fill="currentColor" d="M9.5 6C6.5 7 5 9.4 5 13v5h5.5v-5.5H8c0-2 .8-3.3 2.3-4ZM18.5 6c-3 1-4.5 3.4-4.5 7v5h5.5v-5.5H17c0-2 .8-3.3 2.3-4Z"/></svg>';

const CSS = `
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:90px}
body{margin:0;background:#F4F5F4;color:#15201C;font-family:'Plus Jakarta Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
img{display:block;max-width:100%}
svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px}
.previa{position:sticky;top:0;z-index:30;background:#111;color:#fff;text-align:center;font-size:12px;padding:8px 12px}
/* Cabeçalho */
.topo{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid #E6E9E7}
.previa+.topo{top:33px}
.topo .wrap{display:flex;align-items:center;gap:18px;min-height:76px}
.marca{display:flex;align-items:center;text-decoration:none;font-weight:800;font-size:18px;flex-shrink:0}
.marca img{height:46px;width:auto}
.nav{display:flex;gap:4px;margin:0 auto}
.nav a{text-decoration:none;font-size:15px;color:#3B4743;padding:10px 14px;border-radius:999px}
.nav a:hover{background:#EEF1EF;color:#15201C}
.acoes{display:flex;align-items:center;gap:10px;margin-left:auto}
.zap{display:inline-flex;align-items:center;gap:10px;text-decoration:none;background:#EEF1EF;border-radius:999px;padding:6px 6px 6px 16px;font-weight:600;font-size:15px;white-space:nowrap}
.zap .num svg{color:#1FA855}
.zap .mais{width:36px;height:36px;border-radius:50%;background:var(--marca);color:#fff;display:flex;align-items:center;justify-content:center}
.redes{display:flex;gap:4px}
.redes a,.icone{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#3B4743;text-decoration:none}
.redes a:hover,.icone:hover{background:#EEF1EF}
.menu-cel{display:none}
/* Capa */
.capa{position:relative;margin:14px auto 0;max-width:1400px;padding:0 14px}
.slides{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;border-radius:28px;background:#1d2622}
.slides::-webkit-scrollbar{display:none}
.slide{position:relative;flex:0 0 100%;scroll-snap-align:start;height:min(74vh,640px);min-height:420px;display:flex;align-items:flex-end;overflow:hidden}
.slide>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.slide::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,12,10,.35) 0%,rgba(8,12,10,.05) 35%,rgba(8,12,10,.78) 100%)}
.slide .txt{position:relative;z-index:1;color:#fff;padding:0 clamp(22px,6vw,90px) 150px;max-width:900px}
.etiq{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;opacity:.95}
.etiq span{display:inline-flex;align-items:center;gap:6px}
.etiq svg{width:15px;height:15px}
.slide h2{font-size:clamp(28px,4.4vw,52px);line-height:1.08;margin:12px 0 8px;font-weight:800;letter-spacing:-.02em}
.slide .onde{font-size:clamp(16px,1.8vw,20px);opacity:.92}
.slide .btn{margin-top:20px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;border-radius:14px;padding:0 22px;min-height:50px;font-weight:700;font-size:15px;border:0;cursor:pointer;font-family:inherit}
.btn-marca{background:var(--marca);color:#fff}
.btn-claro{background:#fff;color:#15201C}
.btn-linha{background:transparent;border:1.5px solid currentColor}
.navcapa{position:absolute;top:50%;transform:translateY(-110%);width:48px;height:48px;border-radius:50%;border:0;background:rgba(255,255,255,.92);color:#15201C;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2}
.navcapa.ant{left:34px}.navcapa.prox{right:34px}
.contador{position:absolute;top:18px;right:32px;z-index:2;background:rgba(8,12,10,.55);color:#fff;font-size:12px;font-weight:600;border-radius:999px;padding:7px 12px}
.pontos{position:absolute;left:0;right:0;bottom:118px;z-index:2;display:flex;justify-content:center;gap:8px}
.pontos button{width:8px;height:8px;border-radius:999px;border:0;background:rgba(255,255,255,.55);padding:0;cursor:pointer;transition:width .25s}
.pontos button.on{width:26px;background:#fff}
/* Busca */
.busca-area{position:relative;z-index:3;margin-top:-96px}
.chamada{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;color:#fff;margin:0 8px 14px}
.chamada h1{font-size:clamp(22px,2.8vw,34px);font-weight:800;margin:0;letter-spacing:-.01em;text-shadow:0 2px 14px rgba(0,0,0,.35)}
.porcod{position:relative}
.porcod summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;background:rgba(8,12,10,.55);border-radius:999px;padding:10px 16px;font-weight:600;font-size:14px}
.porcod summary::-webkit-details-marker{display:none}
.porcod form{position:absolute;right:0;top:calc(100% + 8px);background:#fff;border-radius:18px;padding:12px;display:flex;gap:8px;box-shadow:0 18px 40px rgba(0,0,0,.18);width:300px}
.porcod input{flex:1;min-width:0}
.busca{background:#fff;border-radius:24px;padding:22px;box-shadow:0 22px 50px rgba(20,32,28,.12);display:grid;grid-template-columns:auto repeat(4,minmax(0,1fr)) minmax(0,1fr) auto;gap:12px;align-items:end}
.campo{display:flex;flex-direction:column;gap:6px;min-width:0}
.campo label,.rot{font-size:12.5px;font-weight:600;color:#5A6762}
select,input{font-family:inherit;font-size:15px;color:#15201C;background:#F1F3F2;border:1.5px solid transparent;border-radius:14px;min-height:50px;padding:0 14px;width:100%;outline:none}
select:focus,input:focus{border-color:var(--marca);background:#fff}
.seg{display:flex;background:#F1F3F2;border-radius:14px;padding:4px;min-height:50px}
.seg label{display:flex}
.seg input{position:absolute;opacity:0;width:1px;height:1px}
.seg span{display:flex;align-items:center;padding:0 16px;border-radius:11px;font-weight:600;font-size:14px;color:#5A6762;cursor:pointer}
.seg input:checked+span{background:#fff;color:#15201C;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.seg input:focus-visible+span{outline:2px solid var(--marca)}
.busca .btn{min-height:50px}
/* Seções */
.secao{padding:64px 0 8px}
.secao-topo{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:22px;flex-wrap:wrap}
.secao-topo h2{display:flex;align-items:center;gap:12px;font-size:clamp(24px,2.6vw,32px);font-weight:800;margin:0;letter-spacing:-.015em}
.secao-topo h2 i{display:block;width:26px;height:16px;flex-shrink:0;background:linear-gradient(var(--marca),var(--marca)) 0 0/26px 3px no-repeat,linear-gradient(var(--marca),var(--marca)) 6px 6.5px/20px 3px no-repeat,linear-gradient(var(--marca),var(--marca)) 12px 13px/14px 3px no-repeat}
.vertodos{display:inline-flex;align-items:center;gap:6px;text-decoration:none;background:#fff;border-radius:999px;padding:10px 16px;font-weight:700;font-size:13.5px;box-shadow:0 2px 10px rgba(20,32,28,.06)}
.vertodos svg{width:16px;height:16px}
.carrossel{position:relative}
.trilho{display:flex;gap:18px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;padding:6px 4px 22px;margin:0 -4px}
.trilho::-webkit-scrollbar{display:none}
.trilho>*{flex:0 0 calc((100% - 54px)/4);scroll-snap-align:start}
.mover{position:absolute;top:38%;width:46px;height:46px;border-radius:50%;border:0;background:#fff;box-shadow:0 6px 20px rgba(20,32,28,.14);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2}
.mover.ant{left:-14px}.mover.prox{right:-14px}
.mover[disabled]{opacity:0;pointer-events:none}
/* Cartão */
.card{text-decoration:none;background:#fff;border-radius:24px;padding:12px;display:flex;flex-direction:column;box-shadow:0 2px 12px rgba(20,32,28,.05);transition:transform .25s,box-shadow .25s}
.card:hover{transform:translateY(-4px);box-shadow:0 18px 36px rgba(20,32,28,.12)}
.card .foto{position:relative;aspect-ratio:1/1;border-radius:18px;overflow:hidden;background:#E4E8E6}
.card .foto img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .5s}
.card:hover .foto img{transform:scale(1.04)}
.card .selo{position:absolute;left:10px;top:10px;background:rgba(255,255,255,.94);font-size:11px;font-weight:800;letter-spacing:.5px;padding:6px 10px;border-radius:999px}
.feat{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;background:#F4F6F5;border-radius:16px;padding:14px;margin:12px 0 10px}
.feat span{display:flex;align-items:center;gap:8px;font-size:13.5px;color:#3B4743;min-width:0}
.feat svg{width:18px;height:18px;flex-shrink:0;color:#6A7772}
.card .cod{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:#5A6762;padding:0 6px}
.card .cod b{font-weight:700;color:#15201C}
.card .lugar{font-size:13px;color:#5A6762;padding:4px 6px 0}
.card h3{font-size:18px;line-height:1.3;margin:8px 6px 0;color:var(--marca);font-weight:800}
.card .preco{font-size:17px;font-weight:800;padding:10px 6px 4px;margin-top:auto}
.card .preco small{font-size:.75em;font-weight:600;color:#5A6762}
.sem-foto{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9AA6A1}
.sem-foto svg{width:38px;height:38px}
/* Lançamentos: o cartão ganha a cor da marca */
.lanc .card{background:var(--marca);color:#fff}
.lanc .card .feat{background:rgba(255,255,255,.1)}
.lanc .card .feat span,.lanc .card .feat svg,.lanc .card .cod,.lanc .card .lugar,.lanc .card .preco small{color:rgba(255,255,255,.85)}
.lanc .card .cod b,.lanc .card h3{color:#fff}
.lanc .card .selo{background:rgba(0,0,0,.45);color:#fff}
/* Sobre */
.sobre{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:22px;align-items:stretch}
.sobre .texto{background:#fff;border-radius:24px;padding:clamp(22px,3vw,36px);font-size:16.5px;line-height:1.75;color:#3B4743;white-space:pre-line}
.numeros{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.numeros div{background:#fff;border-radius:22px;padding:22px;display:flex;flex-direction:column;justify-content:flex-end;min-height:120px}
.numeros b{font-size:clamp(28px,3vw,38px);font-weight:800;color:var(--marca);letter-spacing:-.02em}
.numeros span{font-size:13.5px;color:#5A6762}
/* Depoimentos */
.depo{background:#fff;border-radius:24px;padding:26px;display:flex;flex-direction:column;gap:14px}
.depo svg{width:30px;height:30px;color:var(--marca)}
.depo p{margin:0;font-size:16px;line-height:1.65;color:#3B4743}
.depo b{font-weight:800;margin-top:auto}
.trilho.depos>*{flex-basis:calc((100% - 36px)/3)}
/* Equipe */
.trilho.time>*{flex-basis:calc((100% - 54px)/4)}
.pessoa{background:#fff;border-radius:24px;padding:22px;margin-top:56px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.pessoa .rosto{width:132px;height:132px;border-radius:50%;margin-top:-78px;overflow:hidden;background:var(--marca);color:#fff;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800;border:5px solid #F4F5F4}
.pessoa .rosto img{width:100%;height:100%;object-fit:cover}
.pessoa b{font-size:17px;margin-top:8px}
.pessoa span{font-size:13.5px;color:#5A6762}
.pessoa a{margin-top:10px;font-size:14px;min-height:44px}
/* Anunciar */
.anunciar{margin:64px 0 0;background:var(--marca);color:#fff;border-radius:28px;padding:clamp(26px,4vw,48px);display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between;align-items:center}
.anunciar h2{margin:0 0 6px;font-size:clamp(24px,3vw,34px);font-weight:800;letter-spacing:-.015em}
.anunciar p{margin:0;opacity:.88;font-size:16px}
/* Rodapé */
.rodape{margin-top:64px;background:#fff;border-top:1px solid #E6E9E7;padding:40px 0 30px}
.rodape .wrap{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between;align-items:center}
.rodape .fina{width:100%;font-size:12.5px;color:#6A7772;display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:space-between;border-top:1px solid #EEF1EF;padding-top:18px}
.flutua{position:fixed;right:20px;bottom:20px;z-index:15;width:60px;height:60px;border-radius:50%;background:#1FA855;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 26px rgba(31,168,85,.4)}
.flutua svg{width:30px;height:30px}
/* Lista (resultado da busca) */
.lista-topo{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin:34px 0 18px}
.lista-topo h1{margin:0;font-size:clamp(24px,2.6vw,32px);font-weight:800}
.lista-topo span{color:#5A6762}
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.paginas{display:flex;gap:8px;justify-content:center;margin:30px 0 0}
.vazio{background:#fff;border-radius:24px;padding:40px;text-align:center}
/* Página do imóvel */
.volta{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:600;font-size:14px;color:#3B4743;min-height:44px;margin:16px 0 6px}
.volta svg{width:18px;height:18px}
.galeria .trilho>*{flex:0 0 min(880px,86%);height:clamp(260px,50vw,560px);object-fit:cover;border-radius:24px;background:#E4E8E6}
.galeria .trilho>.so{flex-basis:100%}
.corpo{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;align-items:start;margin-top:10px}
.corpo h1{font-size:clamp(28px,3.6vw,44px);line-height:1.12;margin:12px 0 8px;font-weight:800;letter-spacing:-.02em}
.corpo .onde{color:#5A6762;font-size:16px}
.etiq-esc{color:#5A6762}
.specs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:24px 0}
.specs div{background:#fff;border-radius:18px;padding:16px;display:flex;align-items:center;gap:12px}
.specs svg{width:24px;height:24px;color:var(--marca);flex-shrink:0}
.specs b{display:block;font-size:17px}
.specs span{font-size:12.5px;color:#5A6762}
.bloco{background:#fff;border-radius:24px;padding:clamp(20px,3vw,30px);margin-bottom:18px}
.bloco h2{font-size:18px;margin:0 0 12px;font-weight:800}
.bloco .texto{white-space:pre-line;line-height:1.75;color:#3B4743;font-size:16px;margin:0}
video{width:100%;border-radius:18px;background:#000}
.lateral{position:sticky;top:96px;background:#fff;border-radius:24px;padding:24px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 30px rgba(20,32,28,.07)}
.lateral .preco{font-size:32px;font-weight:800;letter-spacing:-.02em}
.lateral .preco small{font-size:.5em;color:#5A6762;font-weight:600}
.custos{display:flex;flex-direction:column;gap:6px;font-size:14px;color:#3B4743}
.barra-cel{display:none}
@media (max-width:1100px){
  .nav{display:none}
  .menu-cel{display:block;position:relative}
  .menu-cel summary{list-style:none}
  .menu-cel summary::-webkit-details-marker{display:none}
  .menu-cel nav{position:absolute;right:0;top:calc(100% + 10px);background:#fff;border-radius:18px;box-shadow:0 18px 40px rgba(0,0,0,.16);padding:8px;display:flex;flex-direction:column;min-width:220px}
  .menu-cel nav a{text-decoration:none;padding:13px 14px;border-radius:12px;font-weight:600}
  .menu-cel nav a:hover{background:#EEF1EF}
  .busca{grid-template-columns:repeat(3,minmax(0,1fr))}
  .busca .seg-campo{grid-column:1/-1}
  .trilho>*{flex-basis:calc((100% - 36px)/3)}
  .trilho.time>*{flex-basis:calc((100% - 36px)/3)}
  .sobre{grid-template-columns:1fr}
  .corpo{grid-template-columns:1fr}
  .lateral{position:static}
}
@media (max-width:760px){
  .topo .wrap{min-height:64px;gap:8px}
  .marca img{height:38px}
  .zap .num{display:none}
  .zap{padding:4px}
  .redes{display:none}
  .capa{padding:0 10px;margin-top:10px}
  .slide{height:72vh;min-height:430px}
  .slide .txt{padding:0 20px 120px}
  .navcapa{display:none}
  .contador{right:18px;top:14px}
  .pontos{bottom:96px}
  .busca-area{margin-top:-80px}
  .chamada{margin:0 6px 12px}
  .porcod form{right:auto;left:0;width:min(300px,calc(100vw - 40px))}
  .busca{grid-template-columns:repeat(2,minmax(0,1fr));padding:16px;border-radius:22px}
  .busca .btn,.busca .campo-ate{grid-column:1/-1}
  .secao{padding-top:48px}
  .trilho>*,.trilho.time>*{flex-basis:78%}
  .trilho.depos>*{flex-basis:86%}
  .mover{display:none}
  .numeros div{min-height:100px;padding:18px}
  .galeria .trilho>*{flex-basis:88%}
  .barra-cel{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:16;gap:10px;align-items:center;background:#fff;box-shadow:0 -8px 24px rgba(0,0,0,.08);padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
  .barra-cel .preco{font-size:18px;font-weight:800;flex:1;min-width:0}
  body.tem-barra{padding-bottom:84px}
  body.tem-barra .flutua{display:none}
  .flutua{right:14px;bottom:14px;width:54px;height:54px}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
`;

/* Os carrosséis: setas que andam um "cartão" por vez e somem nas pontas. A
   capa ganha os pontos, o contador e a troca sozinha a cada 6 segundos — que
   para quando a pessoa mexe, e não existe para quem pediu menos movimento. */
const SCRIPT = `<script>(function(){
document.querySelectorAll('[data-contato]').forEach(function(a){a.addEventListener('click',function(){try{if(window.fbq)fbq('track','Lead',{content_name:a.getAttribute('data-nome')||'Site'})}catch(e){}})});
document.querySelectorAll('.carrossel').forEach(function(c){var t=c.querySelector('.trilho'),a=c.querySelector('.mover.ant'),p=c.querySelector('.mover.prox');if(!t)return;
function passo(){var f=t.firstElementChild;return f?f.getBoundingClientRect().width+18:t.clientWidth}
function marca(){if(a)a.disabled=t.scrollLeft<8;if(p)p.disabled=t.scrollLeft+t.clientWidth>=t.scrollWidth-8}
if(a)a.onclick=function(){t.scrollBy({left:-passo(),behavior:'smooth'})};if(p)p.onclick=function(){t.scrollBy({left:passo(),behavior:'smooth'})};
t.addEventListener('scroll',marca,{passive:true});marca();});
var s=document.getElementById('slides');if(!s)return;var n=s.children.length,pts=document.querySelectorAll('.pontos button'),cont=document.getElementById('contador'),parado=false;
function atual(){return Math.round(s.scrollLeft/s.clientWidth)}
function ir(i){i=(i+n)%n;s.scrollTo({left:i*s.clientWidth,behavior:'smooth'})}
function marcar(){var i=atual();pts.forEach(function(b,k){b.classList.toggle('on',k===i)});if(cont)cont.textContent=String(i+1).padStart(2,'0')+' de '+String(n).padStart(2,'0')}
s.addEventListener('scroll',marcar,{passive:true});marcar();
pts.forEach(function(b,k){b.onclick=function(){parado=true;ir(k)}});
var ant=document.querySelector('.navcapa.ant'),prox=document.querySelector('.navcapa.prox');
if(ant)ant.onclick=function(){parado=true;ir(atual()-1)};if(prox)prox.onclick=function(){parado=true;ir(atual()+1)};
['pointerdown','touchstart','wheel'].forEach(function(e){s.addEventListener(e,function(){parado=true},{passive:true})});
if(n>1&&!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches))setInterval(function(){if(!parado&&!document.hidden)ir(atual()+1)},6000);
})();</script>`;

const tipoTexto = (i) => {
  const base = i.tipo === "terreno" ? "Terreno" : i.empreendimento ? "Empreendimento" : "Casa";
  return i.tipo !== "terreno" && i.quartos ? `${base} ${i.quartos} ${i.quartos > 1 ? "quartos" : "quarto"}` : base;
};
const precoDe = (i) => (i.valor ? moeda(i.valor) + (i.finalidade === "aluguel" ? "<small>/mês</small>" : "") : "Consulte");
const icoCod = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9v6M12 9v6M16 9v6"/></svg>';

function cartao(ctx, i) {
  const feat = caracteristicas(i, true).map(([ic, v, r]) => `<span>${ICO[ic]}${esc(v)}${r ? " " + esc(r) : ""}</span>`).join("");
  return `<a class="card" href="${esc(comPrevia(ctx, hrefImovel(ctx, i)))}">
  <div class="foto">${i.fotos[0] ? imgFoto(i.fotos[0], { alt: i.titulo, sizes: "(max-width: 760px) 78vw, (max-width: 1100px) 33vw, 300px" }) : `<div class="sem-foto">${ICO.casa}</div>`}
    <span class="selo">${i.finalidade === "aluguel" ? "ALUGUEL" : i.empreendimento ? "LANÇAMENTO" : "VENDA"}</span></div>
  ${feat ? `<div class="feat">${feat}</div>` : '<div style="height:12px"></div>'}
  <div class="cod"><span>Cód. <b>${esc(i.codigo)}</b></span><span>${esc(tipoTexto(i))}</span></div>
  ${i.local.curta ? `<div class="lugar">${esc(i.local.curta)}</div>` : ""}
  <h3>${esc(i.titulo)}</h3>
  <div class="preco">${precoDe(i)}</div></a>`;
}

function carrossel(itens, html, extra = "") {
  return `<div class="carrossel"><div class="trilho ${extra}">${itens.map(html).join("")}</div>
    ${itens.length > 1 ? `<button class="mover ant" type="button" aria-label="Anterior">${ICO.voltar}</button><button class="mover prox" type="button" aria-label="Próximo">${ICO.seta}</button>` : ""}</div>`;
}

function secaoTopo(titulo, href, id) {
  return `<div class="secao-topo"${id ? ` id="${id}"` : ""}><h2><i aria-hidden="true"></i>${esc(titulo)}</h2>${href ? `<a class="vertodos" href="${esc(href)}">Ver todos ${ICO.seta}</a>` : ""}</div>`;
}

/* A casca de toda página do modelo: cabeçalho, rodapé, WhatsApp flutuante. */
function moldura(ctx, { titulo, descricao, url, imagem, corpo, pixelExtra = "", indexar = true, classeBody = "", dados = null, conteudo }) {
  const { org, marca, cfg, base } = ctx;
  const logo = marca.logo ? abs(base, marca.logo) : null;
  const home = comPrevia(ctx, inicio(ctx));
  const ancora = (h) => (ctx.previa ? `${home}#${h}` : `${inicio(ctx)}#${h}`);
  const msgGeral = `Olá! Vim pelo site da ${org.name} e gostaria de ajuda para encontrar um imóvel.`;
  const msgAnunciar = `Olá! Vim pelo site da ${org.name} e quero anunciar meu imóvel.`;
  const c = conteudo;
  const links = [
    c.sobre ? ["sobre", "Sobre nós"] : null,
    c.equipe.length ? ["equipe", "Equipe"] : null,
    ["anunciar", "Anunciar imóvel"],
    ["contato", "Fale conosco"],
  ].filter(Boolean);
  const nav = links.map(([h, t]) => `<a href="${esc(ancora(h))}">${t}</a>`).join("");
  const redes = Object.entries(c.redes).filter(([, u]) => u)
    .map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${k === "youtube" ? "YouTube" : k[0].toUpperCase() + k.slice(1)}">${SOCIAL[k]}</a>`).join("");
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
<meta name="theme-color" content="#FFFFFF">
${logo ? `<link rel="icon" href="${esc(logo)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>:root{--marca:${esc(marca.cor)}}${CSS}</style>
${pixel(cfg, pixelExtra)}${jsonLd(dados)}
</head><body class="${classeBody}">${gtmBody(cfg)}
${ctx.previa ? `<div class="previa">PRÉVIA DO MODELO — o site no ar continua com o modelo escolhido</div>` : ""}
<header class="topo"><div class="wrap">
  <a class="marca" href="${esc(home)}" aria-label="${esc(org.name)} — início">${logo ? `<img src="${esc(logo)}" alt="${esc(org.name)}">` : `<span>${esc(org.name)}</span>`}</a>
  <nav class="nav" aria-label="Menu">${nav}</nav>
  <div class="acoes">
    <a class="zap" data-contato href="${esc(wa(cfg.whatsapp, msgGeral))}" target="_blank" rel="noopener" aria-label="WhatsApp ${esc(telefoneLegivel(cfg.whatsapp))}">
      <span class="num">${esc(telefoneLegivel(cfg.whatsapp))}</span><span class="mais">${ICO.wpp}</span></a>
    ${redes ? `<div class="redes">${redes}</div>` : ""}
    <a class="icone" href="${esc(ancora("buscar"))}" aria-label="Buscar imóveis">${LUPA}</a>
    <details class="menu-cel"><summary class="icone" aria-label="Abrir o menu">${MENU}</summary><nav>${nav}${Object.entries(c.redes).filter(([, u]) => u).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${k === "youtube" ? "YouTube" : k[0].toUpperCase() + k.slice(1)}</a>`).join("")}</nav></details>
  </div>
</div></header>
${corpo}
<footer class="rodape" id="contato"><div class="wrap">
  <a class="marca" href="${esc(home)}">${logo ? `<img src="${esc(logo)}" alt="${esc(org.name)}">` : `<span>${esc(org.name)}</span>`}</a>
  <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
    ${redes ? `<div class="redes" style="display:flex">${redes}</div>` : ""}
    <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, msgGeral))}" target="_blank" rel="noopener">${ICO.wpp}Fale conosco · ${esc(telefoneLegivel(cfg.whatsapp))}</a>
  </div>
  <div class="fina"><span>© ${new Date().getFullYear()} ${esc(org.name)}</span>
    <span>${cfg.pixel_id || cfg.gtm_id ? "Este site usa cookies para medir anúncios e visitas. · " : ""}<a href="${esc(wa(cfg.whatsapp, msgAnunciar))}" data-contato target="_blank" rel="noopener">Anunciar imóvel</a> · Site por Cetrolab</span></div>
</div></footer>
<a class="flutua" data-contato href="${esc(wa(cfg.whatsapp, msgGeral))}" target="_blank" rel="noopener" aria-label="Conversar no WhatsApp">${ICO.wpp}</a>
${SCRIPT}
</body></html>`;
}

/* A busca: o mesmo formulário na página inicial e na lista. Vai para a
   página inicial com `busca=1`, que é o que liga a lista. */
function formBusca(ctx, f, cidades, bairros) {
  const opc = (lista, sel, vazio) => `<option value="">${vazio}</option>` + lista.map(v => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(v)}</option>`).join("");
  const fin = f.finalidade || "venda";
  return `<form class="busca" method="get" action="${esc(inicio(ctx))}" role="search">
    <input type="hidden" name="busca" value="1">${ctx.previa ? `<input type="hidden" name="previa" value="${esc(ctx.previa)}">` : ""}
    <div class="campo seg-campo"><span class="rot">Quero</span><div class="seg">
      <label><input type="radio" name="finalidade" value="venda"${fin === "venda" ? " checked" : ""}><span>Comprar</span></label>
      <label><input type="radio" name="finalidade" value="aluguel"${fin === "aluguel" ? " checked" : ""}><span>Alugar</span></label></div></div>
    <div class="campo"><label for="b-tipo">Tipo de imóvel</label><select id="b-tipo" name="tipo">
      <option value="">Todos</option><option value="casa"${f.tipo === "casa" ? " selected" : ""}>Casa</option><option value="terreno"${f.tipo === "terreno" ? " selected" : ""}>Terreno</option></select></div>
    <div class="campo"><label for="b-cidade">Cidade</label><select id="b-cidade" name="cidade">${opc(cidades, f.cidade, "Todas")}</select></div>
    <div class="campo"><label for="b-bairro">Bairro</label><select id="b-bairro" name="bairro">${opc(bairros, f.bairro, "Todos")}</select></div>
    <div class="campo"><label for="b-quartos">Quartos</label><select id="b-quartos" name="quartos">
      <option value="">Qualquer</option>${[1, 2, 3, 4].map(q => `<option value="${q}"${f.quartos === q ? " selected" : ""}>${q}+</option>`).join("")}</select></div>
    <div class="campo campo-ate"><label for="b-ate">Valor até (R$)</label><input id="b-ate" name="ate" inputmode="numeric" placeholder="Sem limite" value="${f.ate || ""}"></div>
    <button class="btn btn-marca" type="submit">${LUPA}Buscar</button>
  </form>`;
}

const buscando = (q, f) => q.busca === "1" || q.todos === "1" || !!(f.finalidade || f.tipo || f.cidade || f.bairro || f.quartos || f.ate || f.codigo || f.lancamentos) || f.p > 1;

export function paginaPortal(ctx, query) {
  const { org, cfg, base } = ctx;
  const conteudo = conteudoPublico(org.id);
  const f = filtrosDe(query);
  const bairros = bairrosDoCatalogo(org.id).map(b => b.bairro).sort((a, b) => a.localeCompare(b, "pt-BR"));
  if (buscando(query, f)) return paginaLista(ctx, query, f, conteudo, bairros);

  const todos = catalogo(org.id, filtrosDe({}));
  const r = resumoDoCatalogo(org.id);
  const slides = todos.itens.filter(i => i.fotos[0]).slice(0, 6);
  const venda = catalogo(org.id, filtrosDe({ finalidade: "venda" })).itens.filter(i => !i.empreendimento).slice(0, 10);
  const lanc = catalogo(org.id, filtrosDe({ lancamentos: "1" })).itens.slice(0, 10);
  const aluguel = catalogo(org.id, filtrosDe({ finalidade: "aluguel" })).itens.slice(0, 10);
  const link = (q) => comPrevia(ctx, inicio(ctx) + "?" + new URLSearchParams(q).toString());
  const msgPessoa = (nome) => `Olá! Vim pelo site da ${org.name} e gostaria de falar com ${String(nome).split(" ")[0]}.`;

  const capa = slides.length ? `
<section class="capa" aria-label="Imóveis em destaque">
  <div class="slides" id="slides">${slides.map((i, n) => `
    <div class="slide">${imgFoto(i.fotos[0], { alt: i.titulo, sizes: "100vw", lazy: n > 0 })}
      <div class="txt"><div class="etiq"><span>${icoCod}Cód. ${esc(i.codigo)}</span><span>${ICO.casa}${esc(tipoTexto(i))}</span></div>
        <h2>${esc(i.titulo)}</h2>${i.local.curta ? `<div class="onde">${esc(i.local.curta)}</div>` : ""}
        <a class="btn btn-marca" href="${esc(comPrevia(ctx, hrefImovel(ctx, i)))}">Mais detalhes</a></div></div>`).join("")}</div>
  ${slides.length > 1 ? `<button class="navcapa ant" type="button" aria-label="Imóvel anterior">${ICO.voltar}</button><button class="navcapa prox" type="button" aria-label="Próximo imóvel">${ICO.seta}</button>
  <div class="pontos">${slides.map((_, n) => `<button type="button" aria-label="Imóvel ${n + 1}"${n ? "" : ' class="on"'}></button>`).join("")}</div>
  <div class="contador" id="contador">01 de ${String(slides.length).padStart(2, "0")}</div>` : ""}
</section>` : `<section class="capa"><div class="slides"><div class="slide" style="background:var(--marca)"><div class="txt"><h2>${esc(cfg.frase || FRASE_PADRAO)}</h2></div></div></div></section>`;

  const corpo = `${capa}
<div class="wrap busca-area" id="buscar">
  <div class="chamada"><h1>${r.total ? `São ${r.total} ${r.total === 1 ? "imóvel disponível" : "imóveis disponíveis"} à sua espera!` : esc(cfg.frase || FRASE_PADRAO)}</h1>
    <details class="porcod"><summary>${icoCod}Buscar por código</summary>
      <form method="get" action="${esc(inicio(ctx))}">${ctx.previa ? `<input type="hidden" name="previa" value="${esc(ctx.previa)}">` : ""}
        <input name="codigo" placeholder="Ex.: 3F2A9C" maxlength="6" aria-label="Código do imóvel" autocomplete="off"><button class="btn btn-marca" type="submit">Ir</button></form></details></div>
  ${formBusca(ctx, f, todos.cidades, bairros)}
</div>
<main class="wrap">
  ${venda.length ? `<section class="secao">${secaoTopo("Imóveis em destaque", link({ finalidade: "venda", busca: "1" }))}${carrossel(venda, i => cartao(ctx, i))}</section>` : ""}
  ${lanc.length ? `<section class="secao lanc">${secaoTopo("Lançamentos", link({ lancamentos: "1" }))}${carrossel(lanc, i => cartao(ctx, i))}</section>` : ""}
  ${aluguel.length ? `<section class="secao">${secaoTopo("Para alugar", link({ finalidade: "aluguel", busca: "1" }))}${carrossel(aluguel, i => cartao(ctx, i))}</section>` : ""}
  ${conteudo.sobre ? `<section class="secao">${secaoTopo("Sobre nós", null, "sobre")}
    <div class="sobre"><div class="texto">${esc(conteudo.sobre)}</div>
      <div class="numeros"><div><b>${r.total}</b><span>${r.total === 1 ? "imóvel disponível" : "imóveis disponíveis"}</span></div>
        ${r.bairros ? `<div><b>${r.bairros}</b><span>${r.bairros === 1 ? "bairro" : "bairros"} com imóveis</span></div>` : ""}
        ${r.venda_desde ? `<div><b style="font-size:clamp(20px,2.2vw,26px)">${moeda(r.venda_desde)}</b><span>para comprar, a partir de</span></div>` : ""}
        ${r.aluguel_desde ? `<div><b style="font-size:clamp(20px,2.2vw,26px)">${moeda(r.aluguel_desde)}</b><span>para alugar, a partir de (mês)</span></div>` : ""}</div></div></section>` : ""}
  ${conteudo.depoimentos.length ? `<section class="secao">${secaoTopo("O que falam de nós")}${carrossel(conteudo.depoimentos,
    d => `<figure class="depo" style="margin:0">${ASPAS}<p>${esc(d.texto)}</p><b>${esc(d.nome)}</b></figure>`, "depos")}</section>` : ""}
  ${conteudo.equipe.length ? `<section class="secao">${secaoTopo("Nossa equipe", null, "equipe")}${carrossel(conteudo.equipe,
    p => `<div class="pessoa"><div class="rosto">${p.foto ? `<img src="${esc(abs(base, p.foto))}" alt="${esc(p.nome)}" loading="lazy">` : esc(String(p.nome).trim()[0] || "?")}</div>
      <b>${esc(p.nome)}</b><span>${esc(p.cargo)}</span>
      <a class="btn btn-linha" style="color:var(--marca)" data-contato data-nome="${esc(p.nome)}" href="${esc(wa(cfg.whatsapp, msgPessoa(p.nome)))}" target="_blank" rel="noopener">${ICO.wpp}Conversar</a></div>`, "time")}</section>` : ""}
  <section class="anunciar" id="anunciar"><div><h2>Quer vender ou alugar seu imóvel?</h2><p>A ${esc(org.name)} anuncia, mostra e cuida da negociação com você.</p></div>
    <a class="btn btn-claro" data-contato data-nome="Anunciar imóvel" href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e quero anunciar meu imóvel.`))}" target="_blank" rel="noopener">${ICO.wpp}Anunciar meu imóvel</a></section>
</main>`;
  return moldura(ctx, {
    titulo: cfg.seo_titulo || `${org.name} — Imóveis à venda e para alugar`,
    descricao: cfg.seo_descricao || `${r.total} imóveis à venda e para alugar. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + inicio(ctx), corpo, conteudo, dados: dadosDaImobiliaria(ctx),
    imagem: ctx.marca.logo ? abs(base, ctx.marca.logo) : slides[0] ? abs(base, slides[0].fotos[0]) : null,
  });
}

function paginaLista(ctx, query, f, conteudo, bairros) {
  const { org, cfg, base } = ctx;
  const c = catalogo(org.id, f);
  const pagina = (p) => {
    const s = new URLSearchParams();
    for (const k of ["finalidade", "tipo", "cidade", "bairro"]) if (f[k]) s.set(k, f[k]);
    if (f.quartos) s.set("quartos", f.quartos); if (f.ate) s.set("ate", f.ate); if (f.codigo) s.set("codigo", f.codigo);
    if (f.lancamentos) s.set("lancamentos", "1"); s.set("busca", "1"); if (p > 1) s.set("p", p);
    if (ctx.previa) s.set("previa", ctx.previa);
    return inicio(ctx) + "?" + s.toString();
  };
  const titulo = f.codigo ? `Código ${f.codigo}` : f.lancamentos ? "Lançamentos" : f.finalidade === "aluguel" ? "Imóveis para alugar" : f.finalidade === "venda" ? "Imóveis à venda" : "Imóveis";
  const corpo = `<div class="wrap" style="padding-top:22px" id="buscar">${formBusca(ctx, f, c.cidades, bairros)}</div>
<main class="wrap">
  <div class="lista-topo"><h1>${esc(titulo)}</h1><span>${c.total} ${c.total === 1 ? "imóvel encontrado" : "imóveis encontrados"}</span></div>
  ${c.itens.length ? `<div class="grade${f.lancamentos ? " lanc" : ""}">${c.itens.map(i => cartao(ctx, i)).join("")}</div>`
    : `<div class="vazio"><h2 style="margin-top:0">Nada com esses filtros agora</h2><p>Muitas vezes o imóvel certo ainda não foi anunciado. Conta pra gente o que você procura.</p>
       <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e não encontrei o que procuro. Pode me ajudar?`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div>`}
  ${c.paginas > 1 ? `<nav class="paginas">${f.p > 1 ? `<a class="btn btn-claro" href="${esc(pagina(f.p - 1))}">Anterior</a>` : ""}<span class="btn btn-claro" aria-current="page">${f.p} de ${c.paginas}</span>${f.p < c.paginas ? `<a class="btn btn-claro" href="${esc(pagina(f.p + 1))}">Próxima</a>` : ""}</nav>` : ""}
</main>`;
  return moldura(ctx, {
    titulo: `${titulo} — ${org.name}`, descricao: `${c.total} imóveis. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + inicio(ctx), corpo, conteudo, indexar: false,
  });
}

export function paginaImovel(ctx, i) {
  const { org, cfg, base } = ctx;
  const conteudo = conteudoPublico(org.id);
  const url = base + hrefImovel(ctx, i);
  const linkWa = wa(cfg.whatsapp, `Olá! Tenho interesse no imóvel "${i.titulo}" (cód. ${i.codigo}) que vi no site: ${url}`);
  const specs = caracteristicas(i, false).map(([ic, v, r]) => `<div>${ICO[ic]}<span><b>${esc(v)}</b><span>${esc(r || "área")}</span></span></div>`).join("");
  const custos = [i.condominio ? `Condomínio: <b>${moeda(i.condominio)}/mês</b>` : "", i.iptu ? `IPTU: <b>${moeda(i.iptu)}/ano</b>` : ""].filter(Boolean);
  const fotos = i.fotos;
  const outros = catalogo(org.id, filtrosDe({ finalidade: i.finalidade })).itens.filter(x => x.id !== i.id).slice(0, 8);
  const corpo = `<main class="wrap">
  <a class="volta" href="${esc(comPrevia(ctx, inicio(ctx)))}">${ICO.voltar}Todos os imóveis</a>
  ${fotos.length ? `<div class="galeria">${carrossel(fotos, (u, n) => imgFoto(u, { cls: fotos.length === 1 ? "so" : "", alt: `${i.titulo} — foto ${n + 1}`, sizes: "(max-width: 760px) 88vw, 880px", lazy: n > 0 }))}</div>` : ""}
  <div class="corpo">
    <article>
      <div class="etiq etiq-esc"><span>${icoCod}Cód. ${esc(i.codigo)}</span><span>${ICO.casa}${esc(tipoTexto(i))}</span><span>${i.finalidade === "aluguel" ? "Aluguel" : "Venda"}</span></div>
      <h1>${esc(i.titulo)}</h1>
      ${i.local.linha ? `<div class="onde">${esc(i.local.linha)}</div>` : ""}
      ${specs ? `<div class="specs">${specs}</div>` : ""}
      ${i.descricao ? `<section class="bloco"><h2>Sobre o imóvel</h2><p class="texto">${esc(i.descricao)}</p></section>` : ""}
      ${i.video ? `<section class="bloco"><h2>Vídeo</h2><video src="${esc(i.video)}" controls preload="metadata" playsinline></video></section>` : ""}
    </article>
    <aside class="lateral">
      <span class="rot">${i.finalidade === "aluguel" ? "Aluguel" : "Valor"}</span>
      <div class="preco">${precoDe(i)}</div>
      ${custos.length ? `<div class="custos">${custos.map(t => `<span>${t}</span>`).join("")}</div>` : ""}
      <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(linkWa)}" target="_blank" rel="noopener">${ICO.wpp}Quero saber mais</a>
      <span class="rot">Código ${esc(i.codigo)}</span>
    </aside>
  </div>
  ${outros.length ? `<section class="secao">${secaoTopo(i.finalidade === "aluguel" ? "Outros para alugar" : "Outros imóveis à venda", comPrevia(ctx, inicio(ctx) + `?busca=1&finalidade=${i.finalidade}`))}${carrossel(outros, x => cartao(ctx, x))}</section>` : ""}
</main>
<div class="barra-cel"><div class="preco">${precoDe(i)}</div>
  <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(linkWa)}" target="_blank" rel="noopener">${ICO.wpp}WhatsApp</a></div>`;
  return moldura(ctx, {
    titulo: `${i.titulo} — ${org.name}`, descricao: resumoDoImovel(i), url, corpo, conteudo,
    classeBody: "tem-barra", pixelExtra: pixelDoImovel(i), dados: dadosDoImovel(ctx, i, url),
    imagem: fotos[0] ? abs(base, fotos[0]) : (ctx.marca.logo ? abs(base, ctx.marca.logo) : null),
  });
}
