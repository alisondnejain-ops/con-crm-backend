/* MODELO "PRIME" (23/11/2026) — pedido do Ali a partir do site da Chiabai
   Imóveis (chiabaiimoveis.com.br): *"igual a esse, só que, se possível, mais
   responsivo e mais bonito"*.

   A ESTRUTURA é a do site de referência, de cima para baixo: topo com menu
   (Imóveis, Lançamentos, Serviços, Institucional, Contato) e WhatsApp; capa
   com uma frase e a busca (comprar/alugar, tipo, cidade, bairro, valor,
   quartos e o código); atalhos em fotos (Lançamentos, Para a família, Para
   alugar, Todos); Destaques de venda; os três cartões de serviço (Imóvel sob
   encomenda, Financiamento, Cadastre seu imóvel); Imóveis recentes; Sobre nós,
   depoimentos e equipe; e "Imóveis por região" com um link por bairro. A
   página do imóvel tem galeria, ficha, descrição e os TRÊS pedidos do site
   deles — Quero visitar, Fazer uma proposta, Quero mais informações —, cada
   um abrindo o WhatsApp com a mensagem certa.

   O QUE MUDOU para ficar melhor:
     - no celular, a busca vira um botão que abre uma folha por cima (em vez de
       empurrar a capa para baixo), o menu é uma gaveta, os carrosséis deslizam
       com o dedo e, na página do imóvel, preço e WhatsApp ficam presos no
       rodapé enquanto a pessoa vê as fotos;
     - no computador, a galeria é um mosaico (uma foto grande e quatro menores)
       com tela cheia, e a coluna do preço acompanha a rolagem;
     - o topo começa transparente sobre a capa e vira sólido ao rolar.

   AS REGRAS SÃO AS DE TODO SITE DO CETRO (services/site.js → `pecas`): só a
   lista branca do imóvel, contato pelo WhatsApp da imobiliária, Pixel, Tag
   Manager e dados para o Google. Os dados vêm de `ctx.fonte` quando existe
   (a prévia de demonstração) e, no site de verdade, de services/cetrolab/fonte.js. */
import { FRASE_PADRAO } from "../../site.js";
import * as fonteReal from "../fonte.js";
import { pecas, comPrevia } from "./comum.js";

const { esc, abs, inicio, hrefImovel, jsonLd, gtmHead, gtmBody, pixel, moeda, numero, telefoneLegivel, wa,
  caracteristicas, ICO, dadosDaImobiliaria, dadosDoImovel, resumoDoImovel, pixelDoImovel, imgFoto, altDaFoto, tituloDoImovel, verificacaoGoogle } = pecas;

const fonte = (ctx) => ctx.fonte || fonteReal;
/* Na demonstração não há WhatsApp de verdade: o link não pode mandar mensagem
   para ninguém. A página mostra um aviso no lugar. */
const zap = (ctx, texto) => (ctx.demo ? "#whatsapp" : wa(ctx.cfg.whatsapp, texto));

const IC = {
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  lupa: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>',
  baixo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>',
  prop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4M9.5 13h5M9.5 16.5h5"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/></svg>',
  busca2: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m19 19-4.2-4.2M8.5 10.5h4M10.5 8.5v4"/></svg>',
  cifra: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="3"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9v6M17.5 9v6"/></svg>',
  chave: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/></svg>',
  fotos: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4 4 3 3-2 4 3"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 1 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  insta: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/></svg>',
  face: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M15 8h-1.5A1.5 1.5 0 0 0 12 9.5V21M9.5 13H15"/></svg>',
  yt: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.5v5l4.5-2.5z"/></svg>',
  aspas: '<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke:none"><path fill="currentColor" d="M9.5 6C6.5 7 5 9.4 5 13v5h5.5v-5.5H8c0-2 .8-3.3 2.3-4ZM18.5 6c-3 1-4.5 3.4-4.5 7v5h5.5v-5.5H17c0-2 .8-3.3 2.3-4Z"/></svg>',
};

const CSS = `
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:84px;-webkit-text-size-adjust:100%}
body{margin:0;background:#F6F5F2;color:#16181B;font-family:'Plus Jakarta Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-size:16px}
a{color:inherit}
img{display:block;max-width:100%}
button{font-family:inherit}
svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.serif{font-family:'Fraunces',Georgia,serif;font-weight:500;letter-spacing:-.02em}
.wrap{max-width:1260px;margin:0 auto;padding:0 20px}
.previa{position:relative;z-index:40;background:#16181B;color:#fff;text-align:center;font-size:12.5px;padding:8px 14px;line-height:1.4}
/* Topo */
.topo{position:fixed;left:0;right:0;top:0;z-index:30;transition:background .3s,box-shadow .3s,color .3s;color:#fff}
.tem-previa .topo{top:var(--previa,0px)}
.topo.solido,.topo.claro{background:rgba(255,255,255,.96);color:#16181B;box-shadow:0 1px 0 #E8E6E1;backdrop-filter:saturate(1.5) blur(14px);-webkit-backdrop-filter:saturate(1.5) blur(14px)}
.topo .wrap{display:flex;align-items:center;gap:16px;min-height:76px}
.marca{display:flex;align-items:center;text-decoration:none;font-weight:800;font-size:19px;letter-spacing:-.01em;flex-shrink:0;min-height:44px}
.marca img{height:44px;width:auto;max-width:190px;object-fit:contain}
.marca .clara{display:block}.marca .escura{display:none}
.topo.solido .marca .clara,.topo.claro .marca .clara{display:none}
.topo.solido .marca .escura,.topo.claro .marca .escura{display:block}
.nav{display:flex;gap:2px;margin:0 auto;align-items:center}
.nav>a,.drop>button{display:inline-flex;align-items:center;gap:4px;text-decoration:none;font-size:15px;font-weight:500;padding:10px 14px;border-radius:999px;background:none;border:0;color:inherit;cursor:pointer;min-height:44px}
.nav>a:hover,.drop>button:hover{background:rgba(127,127,127,.14)}
.drop{position:relative}
.drop svg{width:16px;height:16px}
.drop .sub{position:absolute;left:0;top:calc(100% + 6px);min-width:240px;background:#fff;color:#16181B;border-radius:18px;box-shadow:0 22px 50px rgba(0,0,0,.16);padding:8px;display:none;flex-direction:column}
.drop:hover .sub,.drop:focus-within .sub{display:flex}
.sub a{text-decoration:none;padding:12px 14px;border-radius:12px;font-size:14.5px;display:flex;flex-direction:column;gap:2px}
.sub a small{color:#6B6F76;font-size:12.5px}
.sub a:hover{background:#F3F2EE}
.acoes{display:flex;align-items:center;gap:8px;margin-left:auto}
.zap{display:inline-flex;align-items:center;gap:9px;text-decoration:none;background:#1FA855;color:#fff;border-radius:999px;padding:0 18px 0 14px;min-height:46px;font-weight:700;font-size:14.5px;white-space:nowrap}
.zap svg{width:20px;height:20px}
.ico-btn{width:46px;height:46px;border-radius:14px;border:0;background:rgba(127,127,127,.14);color:inherit;display:none;align-items:center;justify-content:center;cursor:pointer}
/* Gaveta (celular) */
.gaveta{position:fixed;inset:0;z-index:50;display:none}
.gaveta.aberta{display:block}
.gaveta .fundo{position:absolute;inset:0;background:rgba(10,12,14,.45)}
.gaveta .folha{position:absolute;right:0;top:0;bottom:0;width:min(360px,88vw);background:#fff;display:flex;flex-direction:column;padding:16px 16px calc(16px + env(safe-area-inset-bottom));overflow-y:auto;animation:entra .25s ease}
@keyframes entra{from{transform:translateX(30px);opacity:.4}to{transform:none;opacity:1}}
.gaveta .linha{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.gaveta a.g{display:block;text-decoration:none;padding:14px 12px;border-radius:14px;font-weight:600;font-size:16px}
.gaveta a.g:hover{background:#F3F2EE}
.gaveta .grupo{font-size:11.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#8A8E95;padding:16px 12px 4px}
.fechar{width:44px;height:44px;border-radius:12px;border:0;background:#F3F2EE;display:flex;align-items:center;justify-content:center;cursor:pointer}
/* Capa */
.capa{position:relative;min-height:min(92vh,780px);display:flex;align-items:flex-end;color:#fff;overflow:hidden;background:#1B1E22}
.capa>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.capa::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,11,13,.55) 0%,rgba(9,11,13,.15) 34%,rgba(9,11,13,.25) 60%,rgba(9,11,13,.82) 100%)}
.capa .wrap{position:relative;z-index:1;width:100%;padding-top:120px;padding-bottom:42px}
.capa .kick{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:8px 14px;backdrop-filter:blur(8px)}
.capa h1{font-size:clamp(36px,6vw,74px);line-height:1.02;margin:18px 0 14px;max-width:860px}
.capa p.sub2{font-size:clamp(16px,1.7vw,19px);opacity:.9;max-width:620px;margin:0 0 28px;line-height:1.55}
/* Busca */
.busca{background:#fff;color:#16181B;border-radius:26px;padding:18px;box-shadow:0 30px 70px rgba(0,0,0,.25);display:grid;grid-template-columns:repeat(5,minmax(0,1fr)) auto;gap:10px;align-items:end}
.busca .topo-busca{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.abas{display:flex;background:#F1F0EC;border-radius:14px;padding:4px}
.abas label{display:flex}
.abas input{position:absolute;opacity:0;width:1px;height:1px}
.abas span{display:flex;align-items:center;min-height:42px;padding:0 20px;border-radius:11px;font-weight:700;font-size:14.5px;color:#5E6269;cursor:pointer}
.abas input:checked+span{background:#16181B;color:#fff}
.abas input:focus-visible+span{outline:2px solid var(--marca);outline-offset:2px}
.porcod{display:flex;align-items:center;gap:6px;background:#F1F0EC;border-radius:14px;padding:4px 4px 4px 12px}
.porcod input{background:transparent;min-height:42px;width:150px;padding:0}
.porcod button{min-height:42px;border-radius:11px;border:0;background:#16181B;color:#fff;font-weight:700;padding:0 14px;cursor:pointer}
.campo{display:flex;flex-direction:column;gap:6px;min-width:0}
.campo label{font-size:12.5px;font-weight:700;color:#5E6269;padding-left:4px}
select,input{font-family:inherit;font-size:15.5px;color:#16181B;background:#F6F5F2;border:1.5px solid transparent;border-radius:14px;min-height:52px;padding:0 14px;width:100%;outline:none;-webkit-appearance:none;appearance:none}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235E6269' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:18px;padding-right:38px}
select:focus,input:focus{border-color:var(--marca);background-color:#fff}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;text-decoration:none;border-radius:16px;padding:0 24px;min-height:52px;font-weight:700;font-size:15.5px;border:0;cursor:pointer;transition:transform .15s,filter .15s}
.btn:active{transform:scale(.98)}
.btn-marca{background:var(--marca);color:#fff}
.btn-marca:hover{filter:brightness(1.08)}
.btn-escuro{background:#16181B;color:#fff}
.btn-claro{background:#fff;color:#16181B}
.btn-linha{background:transparent;color:#16181B;box-shadow:inset 0 0 0 1.5px #D9D6CF}
.btn-zap{background:#1FA855;color:#fff}
.abrir-busca{display:none}
.linha-cod{display:flex;justify-content:flex-end;margin-top:10px}
.linha-cod .porcod{background:rgba(255,255,255,.92)}
/* Atalhos */
.atalhos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:-1px;padding-top:34px}
.atalho{position:relative;display:flex;align-items:flex-end;min-height:190px;border-radius:24px;overflow:hidden;text-decoration:none;color:#fff;background:#2A2E33}
.atalho img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .6s}
.atalho:hover img{transform:scale(1.05)}
.atalho::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.72) 100%)}
.atalho div{position:relative;z-index:1;padding:18px}
.atalho b{display:block;font-size:19px;font-weight:700}
.atalho span{font-size:13.5px;opacity:.88}
/* Seções */
.secao{padding:72px 0 0}
.secao-topo{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;margin-bottom:24px;flex-wrap:wrap}
.secao-topo .rot{font-size:12.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--marca)}
.secao-topo h2{font-size:clamp(28px,3.2vw,42px);margin:6px 0 0;line-height:1.08}
.vertodos{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14.5px;min-height:44px;padding:0 16px;border-radius:999px;background:#fff;box-shadow:inset 0 0 0 1px #E8E6E1}
.vertodos svg{width:16px;height:16px}
.carrossel{position:relative}
.trilho{display:flex;gap:18px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;padding:4px 4px 18px;margin:0 -4px;overscroll-behavior-x:contain}
.trilho::-webkit-scrollbar{display:none}
.trilho>*{flex:0 0 calc((100% - 54px)/4);scroll-snap-align:start}
.mover{position:absolute;top:34%;width:48px;height:48px;border-radius:50%;border:0;background:#fff;box-shadow:0 10px 26px rgba(0,0,0,.14);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;transition:opacity .2s}
.mover.ant{left:-16px}.mover.prox{right:-16px}
.mover[disabled]{opacity:0;pointer-events:none}
/* Cartão */
.card{text-decoration:none;display:flex;flex-direction:column;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 1px 0 #ECEAE5,0 8px 24px rgba(20,22,25,.04);transition:transform .25s,box-shadow .25s}
.card:hover{transform:translateY(-4px);box-shadow:0 1px 0 #ECEAE5,0 22px 40px rgba(20,22,25,.11)}
.card .foto{position:relative;aspect-ratio:4/3;overflow:hidden;background:#E7E5DF}
.card .foto img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .6s}
.card:hover .foto img{transform:scale(1.045)}
.card .selo{position:absolute;left:12px;top:12px;background:rgba(255,255,255,.95);color:#16181B;font-size:11px;font-weight:800;letter-spacing:.5px;padding:7px 11px;border-radius:999px}
.card .cnt{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:5px;background:rgba(10,12,14,.6);color:#fff;font-size:12px;font-weight:600;padding:6px 10px;border-radius:999px}
.card .cnt svg{width:15px;height:15px}
.card .txt{padding:16px 18px 18px;display:flex;flex-direction:column;gap:6px;flex:1}
.card .lugar{display:flex;align-items:center;gap:5px;font-size:13px;color:#6B6F76}
.card .lugar svg{width:15px;height:15px}
.card h3{font-size:17.5px;line-height:1.3;margin:0;font-weight:700}
.feat{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13.5px;color:#44484E;margin-top:4px}
.feat span{display:inline-flex;align-items:center;gap:6px}
.feat svg{width:17px;height:17px;color:#8A8E95}
.card .rodape-card{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:auto;padding-top:12px;border-top:1px solid #F0EEE9}
.card .preco{font-size:19px;font-weight:800;letter-spacing:-.01em}
.card .preco small{font-size:.66em;color:#6B6F76;font-weight:600}
.card .cod{font-size:12px;color:#8A8E95;font-weight:600}
.sem-foto{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#A7AAB0}
.sem-foto svg{width:40px;height:40px}
/* Serviços */
.servicos{margin-top:72px;background:#16181B;color:#fff;border-radius:32px;padding:clamp(28px,4vw,56px);position:relative;overflow:hidden}
.servicos::before{content:"";position:absolute;right:-120px;top:-120px;width:360px;height:360px;border-radius:50%;background:var(--marca);opacity:.35;filter:blur(60px)}
.servicos h2{position:relative;font-size:clamp(28px,3.2vw,40px);margin:0 0 8px;line-height:1.1}
.servicos>p{position:relative;margin:0 0 28px;color:rgba(255,255,255,.72);max-width:620px;line-height:1.6}
.serv-grade{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.serv{display:flex;flex-direction:column;gap:10px;text-decoration:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:22px;transition:background .2s}
.serv:hover{background:rgba(255,255,255,.1)}
.serv .ic{width:48px;height:48px;border-radius:14px;background:var(--marca);display:flex;align-items:center;justify-content:center}
.serv .ic svg{width:24px;height:24px}
.serv b{font-size:18.5px}
.serv span{color:rgba(255,255,255,.72);font-size:14.5px;line-height:1.55}
.serv i{font-style:normal;margin-top:auto;font-weight:700;font-size:14.5px;display:inline-flex;align-items:center;gap:6px}
.serv i svg{width:16px;height:16px}
/* Grade */
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px}
/* Sobre */
.sobre{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:20px}
.sobre .texto{background:#fff;border-radius:26px;padding:clamp(24px,3vw,38px);font-size:16.5px;line-height:1.8;color:#3E4248;white-space:pre-line}
.numeros{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.numeros div{background:#fff;border-radius:22px;padding:22px;display:flex;flex-direction:column;justify-content:flex-end;min-height:130px}
.numeros b{font-size:clamp(26px,3vw,38px);color:var(--marca);letter-spacing:-.02em}
.numeros span{font-size:13.5px;color:#6B6F76}
.depo{background:#fff;border-radius:24px;padding:26px;margin:0;display:flex;flex-direction:column;gap:14px;height:100%}
.depo svg{width:30px;height:30px;color:var(--marca)}
.depo p{margin:0;font-size:16px;line-height:1.7;color:#3E4248}
.trilho.depos>*{flex-basis:calc((100% - 36px)/3)}
.pessoa{background:#fff;border-radius:24px;padding:22px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.pessoa .rosto{width:104px;height:104px;border-radius:50%;overflow:hidden;background:var(--marca);color:#fff;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800}
.pessoa .rosto img{width:100%;height:100%;object-fit:cover}
.pessoa b{font-size:17px;margin-top:8px}
.pessoa span{font-size:13.5px;color:#6B6F76}
/* Regiões */
.regioes{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.regiao{background:#fff;border-radius:22px;padding:20px}
.regiao b{display:block;font-size:16px;margin-bottom:8px}
.regiao a{display:flex;justify-content:space-between;gap:8px;text-decoration:none;font-size:14.5px;color:#44484E;padding:8px 0;border-top:1px solid #F0EEE9}
.regiao a span{color:#8A8E95;font-size:13px}
.regiao a:hover{color:var(--marca)}
/* Rodapé */
.rodape{margin-top:80px;background:#101214;color:#C9CCD1;padding:54px 0 calc(28px + env(safe-area-inset-bottom))}
.rodape .cols{display:grid;grid-template-columns:1.4fr repeat(3,minmax(0,1fr));gap:28px}
.rodape h4{color:#fff;margin:0 0 12px;font-size:14px;letter-spacing:.6px;text-transform:uppercase}
.rodape a{display:block;text-decoration:none;padding:6px 0;color:#C9CCD1;font-size:14.5px}
.rodape a:hover{color:#fff}
.rodape .marca{color:#fff;margin-bottom:12px}
.rodape .redes{display:flex;gap:8px;margin-top:14px}
.rodape .redes a{width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;padding:0}
.rodape .fina{margin-top:36px;padding-top:20px;border-top:1px solid rgba(255,255,255,.1);display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between;font-size:12.5px;color:#8A8E95}
.flutua{position:fixed;right:20px;bottom:20px;z-index:25;width:60px;height:60px;border-radius:50%;background:#1FA855;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 28px rgba(31,168,85,.42)}
.flutua svg{width:30px;height:30px}
/* Folha de busca (celular) */
dialog.folha-busca{border:0;padding:0;margin:auto 0 0;width:100%;max-width:100%;max-height:92dvh;border-radius:26px 26px 0 0;background:#fff;color:#16181B}
dialog.folha-busca::backdrop{background:rgba(10,12,14,.5)}
dialog.folha-busca .cab{display:flex;justify-content:space-between;align-items:center;padding:16px 16px 0}
dialog.folha-busca .cab b{font-size:18px}
dialog.folha-busca .busca{box-shadow:none;border-radius:0;padding:14px 16px 10px}
dialog.folha-busca .linha-cod .porcod{background:#F1F0EC}
/* Lista */
.lista-capa{padding:110px 0 0}
.lista-capa .busca{box-shadow:0 10px 30px rgba(20,22,25,.08)}
.lista-topo{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin:34px 0 18px}
.lista-topo h1{margin:0;font-size:clamp(28px,3vw,40px)}
.lista-topo span{color:#6B6F76}
.paginas{display:flex;gap:8px;justify-content:center;margin:32px 0 0;flex-wrap:wrap}
.vazio{background:#fff;border-radius:26px;padding:40px;text-align:center}
/* Página do imóvel */
.imovel-pg{padding-top:96px}
.volta{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:600;font-size:14.5px;color:#44484E;min-height:44px;margin-bottom:8px}
.volta svg{width:18px;height:18px}
.mosaico{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:10px;height:min(62vh,520px);border-radius:26px;overflow:hidden;position:relative}
.mosaico button{border:0;padding:0;cursor:zoom-in;background:#E7E5DF;position:relative;overflow:hidden}
.mosaico button img{width:100%;height:100%;object-fit:cover;transition:transform .5s}
.mosaico button:hover img{transform:scale(1.03)}
.mosaico button:first-child{grid-row:1/3}
.mosaico.um{grid-template-columns:1fr;grid-template-rows:1fr}
.mosaico.dois{grid-template-columns:1fr 1fr;grid-template-rows:1fr}
.mosaico.dois button:first-child,.mosaico.um button:first-child{grid-row:auto}
.todas{position:absolute;right:16px;bottom:16px;z-index:2;display:inline-flex;align-items:center;gap:8px;background:#fff;color:#16181B;border:0;border-radius:14px;padding:0 16px;min-height:46px;font-weight:700;font-size:14.5px;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.18)}
.galeria-cel{display:none;position:relative;margin:0 -20px}
.galeria-cel .trilho{gap:0;padding:0;margin:0}
.galeria-cel .trilho>*{flex:0 0 100%;height:min(68vw,420px)}
.galeria-cel img{width:100%;height:100%;object-fit:cover}
.galeria-cel .cnt{position:absolute;right:16px;bottom:14px;background:rgba(10,12,14,.62);color:#fff;font-size:12.5px;font-weight:700;padding:7px 11px;border-radius:999px}
.corpo{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:32px;align-items:start;margin-top:28px}
.etiq{display:flex;flex-wrap:wrap;gap:8px}
.etiq span{font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;background:#fff;border-radius:999px;padding:7px 12px;box-shadow:inset 0 0 0 1px #E8E6E1}
.corpo h1{font-size:clamp(30px,3.6vw,46px);line-height:1.08;margin:14px 0 10px}
.corpo .onde{display:flex;align-items:center;gap:6px;color:#6B6F76;font-size:16px}
.specs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:26px 0}
.specs div{background:#fff;border-radius:18px;padding:16px;display:flex;align-items:center;gap:12px}
.specs svg{width:26px;height:26px;color:var(--marca)}
.specs b{display:block;font-size:18px}
.specs span{font-size:12.5px;color:#6B6F76}
.bloco{background:#fff;border-radius:26px;padding:clamp(22px,3vw,32px);margin-bottom:18px}
.bloco h2{font-size:22px;margin:0 0 14px}
.bloco .texto{white-space:pre-line;line-height:1.8;color:#3E4248;font-size:16px;margin:0}
.bloco .texto.curto{max-height:16.2em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.ler-mais{margin-top:10px;border:0;background:none;color:var(--marca);font-weight:700;font-size:15px;cursor:pointer;padding:8px 0;min-height:44px}
video{width:100%;border-radius:18px;background:#000}
.lateral{position:sticky;top:96px;background:#fff;border-radius:26px;padding:26px;display:flex;flex-direction:column;gap:12px;box-shadow:0 1px 0 #ECEAE5,0 18px 40px rgba(20,22,25,.07)}
.lateral .rot{font-size:12.5px;font-weight:700;color:#6B6F76;text-transform:uppercase;letter-spacing:.6px}
.lateral .preco{font-size:34px;font-weight:800;letter-spacing:-.02em;line-height:1.1}
.lateral .preco small{font-size:.48em;color:#6B6F76;font-weight:600}
.custos{display:flex;flex-direction:column;gap:6px;font-size:14px;color:#44484E;padding-bottom:6px}
.pedidos{display:flex;flex-direction:column;gap:10px}
.pedidos .btn{justify-content:flex-start}
.lateral .cod{font-size:13px;color:#8A8E95;text-align:center}
.barra-cel{display:none}
/* Tela cheia das fotos */
.luz{position:fixed;inset:0;z-index:60;background:#0A0B0D;display:none;flex-direction:column;height:100vh;height:100dvh}
.luz.aberta{display:flex}
.luz .cab{display:flex;justify-content:space-between;align-items:center;color:#fff;padding:calc(10px + env(safe-area-inset-top)) 14px 10px}
.luz .cab span{font-size:14px;font-weight:600}
.luz .fechar{background:rgba(255,255,255,.12);color:#fff}
.luz .trilho{flex:1;gap:0;padding:0;margin:0;align-items:center}
.luz .trilho>*{flex:0 0 100%;height:100%;display:flex;align-items:center;justify-content:center;padding:0 10px}
.luz img{max-width:100%;max-height:100%;object-fit:contain}
.luz .mover{top:50%;transform:translateY(-50%);background:rgba(255,255,255,.14);color:#fff}
.luz .mover.ant{left:14px}.luz .mover.prox{right:14px}
.aviso-demo{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:70;background:#16181B;color:#fff;border-radius:16px;padding:14px 18px;font-size:14px;max-width:calc(100vw - 32px);box-shadow:0 18px 40px rgba(0,0,0,.25);display:none}
@media (max-width:1180px){
  .nav{display:none}
  .ico-btn{display:inline-flex}
  .busca{grid-template-columns:repeat(3,minmax(0,1fr))}
  .busca .btn-buscar{grid-column:span 3}
  .trilho>*{flex-basis:calc((100% - 36px)/3)}
  .atalhos{grid-template-columns:repeat(2,minmax(0,1fr))}
  .corpo{grid-template-columns:1fr}
  .lateral{position:static}
  .sobre{grid-template-columns:1fr}
  .rodape .cols{grid-template-columns:1fr 1fr}
}
@media (max-width:760px){
  body{font-size:15.5px}
  .wrap{padding:0 16px}
  .topo .wrap{min-height:64px;gap:8px}
  .marca img{height:36px;max-width:150px}
  .zap span{display:none}
  .zap{padding:0;width:46px;justify-content:center}
  .capa{min-height:86vh;min-height:86svh}
  .capa .wrap{padding-bottom:22px}
  .capa .busca-desk{display:none}
  .abrir-busca{display:flex;align-items:center;gap:12px;width:100%;background:#fff;color:#16181B;border:0;border-radius:18px;padding:0 8px 0 16px;min-height:60px;font-size:16px;font-weight:600;text-align:left;cursor:pointer;box-shadow:0 18px 40px rgba(0,0,0,.28)}
  .abrir-busca span{flex:1;color:#6B6F76;font-weight:500}
  .abrir-busca i{display:flex;width:44px;height:44px;border-radius:13px;background:var(--marca);color:#fff;align-items:center;justify-content:center}
  .busca{grid-template-columns:1fr 1fr}
  .busca .btn-buscar{grid-column:1/-1}
  .busca .campo-largo{grid-column:1/-1}
  .porcod{width:100%}
  .porcod input{flex:1;width:auto}
  .atalhos{gap:10px;padding-top:22px}
  .atalho{min-height:140px;border-radius:20px}
  .atalho div{padding:14px}
  .atalho b{font-size:16.5px}
  .secao{padding-top:52px}
  .trilho>*{flex-basis:82%}
  .trilho.depos>*{flex-basis:88%}
  .mover{display:none}
  .serv-grade{grid-template-columns:1fr}
  .servicos{border-radius:26px;margin-top:52px}
  .rodape .cols{grid-template-columns:1fr}
  .lista-capa{padding-top:84px}
  .imovel-pg{padding-top:64px}
  .mosaico{display:none}
  .galeria-cel{display:block}
  .corpo{margin-top:18px;gap:18px}
  .lateral{display:none}
  .barra-cel{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:26;gap:8px;align-items:center;background:#fff;box-shadow:0 -10px 30px rgba(0,0,0,.1);padding:10px 12px calc(10px + env(safe-area-inset-bottom))}
  .barra-cel .preco{flex:1;min-width:0;font-size:17px;font-weight:800;line-height:1.15}
  .barra-cel .preco small{display:block;font-size:11.5px;color:#6B6F76;font-weight:600}
  .barra-cel .btn{min-height:48px;padding:0 16px;border-radius:14px;font-size:14.5px}
  body.tem-barra{padding-bottom:78px}
  body.tem-barra .flutua{display:none}
  .pedidos-cel{display:grid!important;grid-template-columns:1fr;gap:10px}
  .flutua{right:14px;bottom:14px;width:56px;height:56px}
}
.pedidos-cel{display:none}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}
`;

/* Comportamento da página, sem biblioteca: topo que fica sólido ao rolar,
   gaveta do menu, folha de busca, carrosséis, tela cheia das fotos, "ler mais"
   e, na demonstração, o aviso no lugar do WhatsApp. */
const SCRIPT = `<script>(function(){
var pv=document.querySelector('.previa');if(pv){document.body.classList.add('tem-previa');document.documentElement.style.setProperty('--previa',pv.offsetHeight+'px')}
var topo=document.querySelector('.topo');function rolar(){if(!topo.classList.contains('claro'))topo.classList.toggle('solido',window.scrollY>40)}window.addEventListener('scroll',rolar,{passive:true});rolar();
var g=document.querySelector('.gaveta');document.querySelectorAll('[data-abre-menu]').forEach(function(b){b.onclick=function(){g.classList.add('aberta')}});
if(g)g.querySelectorAll('[data-fecha],a').forEach(function(b){b.addEventListener('click',function(){g.classList.remove('aberta')})});
var fb=document.querySelector('dialog.folha-busca');document.querySelectorAll('[data-abre-busca]').forEach(function(b){b.onclick=function(){if(fb&&fb.showModal)fb.showModal()}});
if(fb){fb.querySelector('[data-fecha-busca]').onclick=function(){fb.close()};fb.addEventListener('click',function(e){if(e.target===fb)fb.close()})}
document.querySelectorAll('[data-contato]').forEach(function(a){a.addEventListener('click',function(){try{if(window.fbq)fbq('track','Lead',{content_name:a.getAttribute('data-nome')||'Site'})}catch(e){}})});
function liga(c){var t=c.querySelector('.trilho'),a=c.querySelector('.mover.ant'),p=c.querySelector('.mover.prox'),n=c.querySelector('[data-cnt]');if(!t)return;
function passo(){var f=t.firstElementChild;return f?f.getBoundingClientRect().width+parseFloat(getComputedStyle(t).columnGap||0):t.clientWidth}
function marca(){if(a)a.disabled=t.scrollLeft<8;if(p)p.disabled=t.scrollLeft+t.clientWidth>=t.scrollWidth-8;if(n){var i=Math.round(t.scrollLeft/(passo()||1));n.textContent=(i+1)+' / '+t.children.length}}
if(a)a.onclick=function(){t.scrollBy({left:-passo(),behavior:'smooth'})};if(p)p.onclick=function(){t.scrollBy({left:passo(),behavior:'smooth'})};
t.addEventListener('scroll',marca,{passive:true});marca();c._ir=function(i){t.scrollTo({left:i*t.clientWidth})}}
document.querySelectorAll('.carrossel').forEach(liga);
var luz=document.querySelector('.luz');function abreLuz(i){if(!luz)return;luz.classList.add('aberta');document.body.style.overflow='hidden';setTimeout(function(){var c=luz.querySelector('.carrossel');if(c&&c._ir)c._ir(i||0)},0)}
function fechaLuz(){luz.classList.remove('aberta');document.body.style.overflow=''}
document.querySelectorAll('[data-foto]').forEach(function(b){b.onclick=function(){abreLuz(+b.getAttribute('data-foto'))}});
if(luz){luz.querySelector('.fechar').onclick=fechaLuz;document.addEventListener('keydown',function(e){if(!luz.classList.contains('aberta'))return;var c=luz.querySelector('.carrossel');if(e.key==='Escape')fechaLuz();if(e.key==='ArrowRight')c.querySelector('.mover.prox').click();if(e.key==='ArrowLeft')c.querySelector('.mover.ant').click()})}
document.querySelectorAll('.ler-mais').forEach(function(b){var t=document.getElementById(b.getAttribute('data-alvo'));if(!t)return;if(t.scrollHeight<=t.clientHeight+4){t.classList.remove('curto');b.remove();return}b.onclick=function(){t.classList.remove('curto');b.remove()}});
var av=document.querySelector('.aviso-demo');if(av)document.querySelectorAll('a[href="#whatsapp"]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();av.style.display='block';clearTimeout(av._t);av._t=setTimeout(function(){av.style.display='none'},4200)})});
})();</script>`;

const precoDe = (i) => (i.valor ? moeda(i.valor, i.moeda) + (i.finalidade === "aluguel" ? "<small>/mês</small>" : "") : "Consulte");
const CATEGORIA = { empreendimento: "Lançamento", loteamento: "Loteamento", terreno: "Terreno", pronto: "Imóvel pronto", casa: "Casa", apartamento: "Apartamento", comercial: "Comercial", rural: "Rural", cobertura: "Cobertura" };
const tipoTexto = (i) => CATEGORIA[i.categoria] || (i.tipo === "terreno" ? "Terreno" : i.empreendimento ? "Lançamento" : "Imóvel");

function cartao(ctx, i) {
  const feat = caracteristicas(i, true).map(([ic, v, r]) => `<span>${ICO[ic]}${esc(v)}${r ? " " + esc(r) : ""}</span>`).join("");
  return `<a class="card" href="${esc(comPrevia(ctx, hrefImovel(ctx, i)))}">
  <div class="foto">${i.fotos[0] ? imgFoto(i.fotos[0], { alt: altDaFoto(i), sizes: "(max-width: 760px) 82vw, (max-width: 1180px) 33vw, 300px" }) : `<div class="sem-foto">${ICO.casa}</div>`}
    <span class="selo">${i.finalidade === "aluguel" ? "ALUGUEL" : i.empreendimento ? "LANÇAMENTO" : "VENDA"}</span>
    ${i.fotos.length > 1 ? `<span class="cnt">${IC.fotos}${i.fotos.length}</span>` : ""}</div>
  <div class="txt">
    ${i.local.curta ? `<div class="lugar">${IC.pin}${esc(i.local.curta)}</div>` : ""}
    <h3>${esc(i.titulo)}</h3>
    ${feat ? `<div class="feat">${feat}</div>` : ""}
    <div class="rodape-card"><div class="preco">${precoDe(i)}</div><span class="cod">Cód. ${esc(i.codigo)}</span></div>
  </div></a>`;
}

function carrossel(itens, html, extra = "") {
  return `<div class="carrossel"><div class="trilho ${extra}">${itens.map(html).join("")}</div>
    ${itens.length > 1 ? `<button class="mover ant" type="button" aria-label="Anterior">${ICO.voltar}</button><button class="mover prox" type="button" aria-label="Próximo">${ICO.seta}</button>` : ""}</div>`;
}
const secaoTopo = (rot, titulo, href, id) => `<div class="secao-topo"${id ? ` id="${id}"` : ""}><div>${rot ? `<div class="rot">${esc(rot)}</div>` : ""}<h2 class="serif">${esc(titulo)}</h2></div>${href ? `<a class="vertodos" href="${esc(href)}">Ver todos ${ICO.seta}</a>` : ""}</div>`;

/* A casca de toda página: topo, gaveta, rodapé, WhatsApp flutuante. */
function moldura(ctx, { titulo, descricao, url, imagem, corpo, pixelExtra = "", indexar = true, classeBody = "", dados = null, conteudo, topoClaro = false, extraFim = "" }) {
  const { org, marca, cfg, base } = ctx;
  const logo = marca.logo ? abs(base, marca.logo) : null;
  const logoClaro = marca.logo_claro ? abs(base, marca.logo_claro) : logo;
  const home = comPrevia(ctx, inicio(ctx));
  const busca = (q) => comPrevia(ctx, inicio(ctx) + "?" + new URLSearchParams(q).toString());
  const ancora = (h) => `${home}#${h}`;
  const c = conteudo;
  const msg = (t) => `Olá! Vim pelo site da ${org.name} e ${t}`;
  const L = {
    venda: busca({ busca: "1", finalidade: "venda" }), aluguel: busca({ busca: "1", finalidade: "aluguel" }),
    lanc: busca({ lancamentos: "1" }), todos: busca({ busca: "1" }),
    encomenda: zap(ctx, msg("quero encomendar um imóvel. Procuro: ")),
    financiar: zap(ctx, msg("quero simular um financiamento.")),
    anunciar: zap(ctx, msg("quero anunciar meu imóvel.")),
    falar: zap(ctx, msg("gostaria de ajuda para encontrar um imóvel.")),
  };
  const marcaHtml = (claro) => logo
    ? `<img class="clara" src="${esc(claro ? logoClaro : logo)}" alt="${esc(org.name)}"><img class="escura" src="${esc(logo)}" alt="" aria-hidden="true">`
    : `<span>${esc(org.name)}</span>`;
  const redes = Object.entries(c.redes || {}).filter(([, u]) => u).map(([k, u]) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${k === "youtube" ? "YouTube" : k[0].toUpperCase() + k.slice(1)}">${k === "instagram" ? IC.insta : k === "facebook" ? IC.face : IC.yt}</a>`).join("");
  const sobre = c.sobre || c.equipe.length;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
${gtmHead(cfg)}${verificacaoGoogle(cfg)}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
${indexar && !ctx.previa && !ctx.demo ? "" : '<meta name="robots" content="noindex">'}
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(org.name)}">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao)}">
<meta property="og:url" content="${esc(url)}">${imagem ? `<meta property="og:image" content="${esc(imagem)}"><meta name="twitter:card" content="summary_large_image">` : ""}
<meta name="theme-color" content="#16181B">
${logo ? `<link rel="icon" href="${esc(logo)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>:root{--marca:${esc(marca.cor)}}${CSS}</style>
${pixel(cfg, pixelExtra)}${jsonLd(dados)}
</head><body class="${classeBody}">${gtmBody(cfg)}
${ctx.demo ? `<div class="previa">${esc(ctx.demo)}</div>` : ctx.previa ? `<div class="previa">PRÉVIA DO MODELO — o site no ar continua com o modelo escolhido</div>` : ""}
<header class="topo${topoClaro ? " claro" : ""}"><div class="wrap">
  <a class="marca" href="${esc(home)}" aria-label="${esc(org.name)} — início">${marcaHtml(true)}</a>
  <nav class="nav" aria-label="Menu">
    <div class="drop"><button type="button" aria-haspopup="true">Imóveis${IC.baixo}</button><div class="sub">
      <a href="${esc(L.venda)}">Comprar<small>Imóveis à venda</small></a>
      <a href="${esc(L.aluguel)}">Alugar<small>Imóveis para alugar</small></a>
      <a href="${esc(L.todos)}">Todos os imóveis<small>Busca completa</small></a></div></div>
    <a href="${esc(L.lanc)}">Lançamentos</a>
    <div class="drop"><button type="button" aria-haspopup="true">Serviços${IC.baixo}</button><div class="sub">
      <a href="${esc(L.encomenda)}" data-contato data-nome="Encomenda" target="_blank" rel="noopener">Imóvel sob encomenda<small>A gente procura por você</small></a>
      <a href="${esc(L.financiar)}" data-contato data-nome="Financiamento" target="_blank" rel="noopener">Financiamento<small>Simule com a nossa equipe</small></a>
      <a href="${esc(L.anunciar)}" data-contato data-nome="Anunciar" target="_blank" rel="noopener">Cadastre seu imóvel<small>Venda ou alugue com a gente</small></a></div></div>
    ${sobre ? `<a href="${esc(ancora("sobre"))}">Sobre nós</a>` : ""}
    <a href="${esc(ancora("contato"))}">Contato</a>
  </nav>
  <div class="acoes">
    <a class="zap" data-contato href="${esc(L.falar)}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">${ICO.wpp}<span>${cfg.whatsapp ? esc(telefoneLegivel(cfg.whatsapp)) : "WhatsApp"}</span></a>
    <button class="ico-btn" type="button" data-abre-menu aria-label="Abrir o menu">${IC.menu}</button>
  </div>
</div></header>
<div class="gaveta" role="dialog" aria-label="Menu"><div class="fundo" data-fecha></div><div class="folha">
  <div class="linha"><a class="marca" href="${esc(home)}" style="color:#16181B">${logo ? `<img src="${esc(logo)}" alt="${esc(org.name)}">` : esc(org.name)}</a><button class="fechar" type="button" data-fecha aria-label="Fechar">${ICO.fechar}</button></div>
  <div class="grupo">Imóveis</div>
  <a class="g" href="${esc(L.venda)}">Comprar</a><a class="g" href="${esc(L.aluguel)}">Alugar</a><a class="g" href="${esc(L.lanc)}">Lançamentos</a>
  <div class="grupo">Serviços</div>
  <a class="g" href="${esc(L.encomenda)}" data-contato target="_blank" rel="noopener">Imóvel sob encomenda</a>
  <a class="g" href="${esc(L.financiar)}" data-contato target="_blank" rel="noopener">Financiamento</a>
  <a class="g" href="${esc(L.anunciar)}" data-contato target="_blank" rel="noopener">Cadastre seu imóvel</a>
  <div class="grupo">Institucional</div>
  ${sobre ? `<a class="g" href="${esc(ancora("sobre"))}">Sobre nós</a>` : ""}<a class="g" href="${esc(ancora("contato"))}">Contato</a>
  <a class="btn btn-zap" style="margin-top:auto" data-contato href="${esc(L.falar)}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a>
</div></div>
${corpo}
<footer class="rodape" id="contato"><div class="wrap">
  <div class="cols">
    <div><a class="marca" href="${esc(home)}">${logo ? `<img src="${esc(logoClaro)}" alt="${esc(org.name)}">` : esc(org.name)}</a>
      <div style="font-size:14.5px;line-height:1.6;max-width:320px">${esc(cfg.frase || FRASE_PADRAO)}</div>
      ${redes ? `<div class="redes">${redes}</div>` : ""}</div>
    <div><h4>Imóveis</h4><a href="${esc(L.venda)}">Comprar</a><a href="${esc(L.aluguel)}">Alugar</a><a href="${esc(L.lanc)}">Lançamentos</a></div>
    <div><h4>Serviços</h4><a href="${esc(L.encomenda)}" target="_blank" rel="noopener">Imóvel sob encomenda</a><a href="${esc(L.financiar)}" target="_blank" rel="noopener">Financiamento</a><a href="${esc(L.anunciar)}" target="_blank" rel="noopener">Cadastre seu imóvel</a></div>
    <div><h4>Contato</h4><a href="${esc(L.falar)}" data-contato target="_blank" rel="noopener">WhatsApp${cfg.whatsapp ? " · " + esc(telefoneLegivel(cfg.whatsapp)) : ""}</a></div>
  </div>
  <div class="fina"><span>© ${new Date().getFullYear()} ${esc(org.name)}</span><span>${cfg.pixel_id || cfg.gtm_id ? "Este site usa cookies para medir anúncios e visitas. · " : ""}Site por Cetrolab</span></div>
</div></footer>
<a class="flutua" data-contato href="${esc(L.falar)}" target="_blank" rel="noopener" aria-label="Conversar no WhatsApp">${ICO.wpp}</a>
${extraFim}
${ctx.demo ? `<div class="aviso-demo" role="status">Na prévia o WhatsApp não abre. No site no ar, este botão abre a conversa com a imobiliária, com a mensagem já escrita.</div>` : ""}
${SCRIPT}
</body></html>`;
}

/* A busca: o mesmo formulário na capa, na folha do celular e na lista. */
function formBusca(ctx, f, cidades, bairros, sufixo = "") {
  const opc = (lista, sel, vazio) => `<option value="">${vazio}</option>` + lista.map(v => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(v)}</option>`).join("");
  const fin = f.finalidade || "venda";
  const id = (n) => `b${sufixo}-${n}`;
  return `<form class="busca" method="get" action="${esc(inicio(ctx))}" role="search">
    <input type="hidden" name="busca" value="1">${ctx.previa ? `<input type="hidden" name="previa" value="${esc(ctx.previa)}">` : ""}
    <div class="topo-busca"><div class="abas" role="radiogroup" aria-label="Quero">
      <label><input type="radio" name="finalidade" value="venda"${fin === "venda" ? " checked" : ""}><span>Comprar</span></label>
      <label><input type="radio" name="finalidade" value="aluguel"${fin === "aluguel" ? " checked" : ""}><span>Alugar</span></label></div></div>
    <div class="campo"><label for="${id("tipo")}">Tipo</label><select id="${id("tipo")}" name="tipo">
      <option value="">Todos</option><option value="casa"${f.tipo === "casa" ? " selected" : ""}>Casa e apartamento</option><option value="terreno"${f.tipo === "terreno" ? " selected" : ""}>Terreno</option></select></div>
    <div class="campo"><label for="${id("cidade")}">Cidade</label><select id="${id("cidade")}" name="cidade">${opc(cidades, f.cidade, "Todas")}</select></div>
    <div class="campo"><label for="${id("bairro")}">Bairro</label><select id="${id("bairro")}" name="bairro">${opc(bairros, f.bairro, "Todos")}</select></div>
    <div class="campo"><label for="${id("quartos")}">Quartos</label><select id="${id("quartos")}" name="quartos">
      <option value="">Qualquer</option>${[1, 2, 3, 4].map(q => `<option value="${q}"${f.quartos === q ? " selected" : ""}>${q} ou mais</option>`).join("")}</select></div>
    <div class="campo"><label for="${id("ate")}">Valor até (R$)</label><input id="${id("ate")}" name="ate" inputmode="numeric" placeholder="Sem limite" value="${f.ate || ""}"></div>
    <button class="btn btn-marca btn-buscar" type="submit">${IC.lupa}Buscar</button>
  </form>`;
}
const formCodigo = (ctx) => `<form class="porcod" method="get" action="${esc(inicio(ctx))}" role="search">${ctx.previa ? `<input type="hidden" name="previa" value="${esc(ctx.previa)}">` : ""}
  <input name="codigo" placeholder="Buscar por código" maxlength="6" aria-label="Código do imóvel" autocomplete="off"><button type="submit">Ir</button></form>`;

const buscando = (q, f) => q.busca === "1" || q.todos === "1" || !!(f.finalidade || f.tipo || f.cidade || f.bairro || f.quartos || f.ate || f.codigo || f.lancamentos) || f.p > 1;

export function paginaPortal(ctx, query) {
  const F = fonte(ctx);
  const { org, cfg, base } = ctx;
  const conteudo = F.conteudoPublico(org.id);
  const f = F.filtrosDe(query);
  const regioes = F.bairrosDoCatalogo(org.id);
  const bairros = regioes.map(b => b.bairro).sort((a, b) => a.localeCompare(b, "pt-BR"));
  if (buscando(query, f)) return paginaLista(ctx, query, f, conteudo, bairros);

  const todos = F.catalogo(org.id, F.filtrosDe({}));
  const r = F.resumoDoCatalogo(org.id);
  const capaImovel = todos.itens.find(i => i.fotos[0]);
  const venda = F.catalogo(org.id, F.filtrosDe({ finalidade: "venda" })).itens.filter(i => !i.empreendimento);
  const lanc = F.catalogo(org.id, F.filtrosDe({ lancamentos: "1" })).itens;
  const aluguel = F.catalogo(org.id, F.filtrosDe({ finalidade: "aluguel" })).itens;
  const familia = F.catalogo(org.id, F.filtrosDe({ quartos: "3" }));
  const link = (q) => comPrevia(ctx, inicio(ctx) + "?" + new URLSearchParams(q).toString());
  const fotoDe = (lista, n = 0) => (lista[n] && lista[n].fotos[0]) || (lista[0] && lista[0].fotos[0]) || null;

  /* Os atalhos só aparecem quando há o que mostrar atrás deles: um atalho que
     abre lista vazia é o primeiro clique da pessoa caindo em "nada encontrado". */
  const atalhos = [
    lanc.length ? { t: "Lançamentos", s: `${lanc.length} ${lanc.length === 1 ? "empreendimento" : "empreendimentos"} na planta`, href: link({ lancamentos: "1" }), foto: fotoDe(lanc) } : null,
    familia.total ? { t: "Para a família", s: `${familia.total} com 3 quartos ou mais`, href: link({ busca: "1", quartos: "3" }), foto: fotoDe(familia.itens, 1) } : null,
    aluguel.length ? { t: "Para alugar", s: `${aluguel.length} ${aluguel.length === 1 ? "imóvel" : "imóveis"} disponíveis`, href: link({ busca: "1", finalidade: "aluguel" }), foto: fotoDe(aluguel) } : null,
    regioes[0] ? { t: regioes[0].bairro, s: `${regioes[0].total} ${regioes[0].total === 1 ? "imóvel" : "imóveis"} no bairro`, href: link({ busca: "1", bairro: regioes[0].bairro }), foto: fotoDe(F.catalogo(org.id, F.filtrosDe({ bairro: regioes[0].bairro })).itens, 2) } : null,
    { t: "Todos os imóveis", s: `${r.total} disponíveis`, href: link({ busca: "1" }), foto: fotoDe(todos.itens, 3) },
  ].filter(Boolean).slice(0, 4);

  const porCidade = new Map();
  for (const b of regioes) { const k = b.cidade || "Outras"; if (!porCidade.has(k)) porCidade.set(k, []); porCidade.get(k).push(b); }

  const msg = (t) => `Olá! Vim pelo site da ${org.name} e ${t}`;
  const corpo = `
<section class="capa" aria-label="Busque seu imóvel">
  ${capaImovel ? imgFoto(capaImovel.fotos[0], { alt: altDaFoto(capaImovel), sizes: "100vw", lazy: false }) : ""}
  <div class="wrap">
    <span class="kick">${IC.pin}${r.total} ${r.total === 1 ? "imóvel disponível" : "imóveis disponíveis"}</span>
    <h1 class="serif">${esc(cfg.frase || "Encontre o imóvel perfeito dos seus sonhos")}</h1>
    <p class="sub2">Invista com confiança, segurança e a orientação de uma equipe de corretores especializada.</p>
    <div class="busca-desk" id="buscar">${formBusca(ctx, f, todos.cidades, bairros, "c")}<div class="linha-cod">${formCodigo(ctx)}</div></div>
    <button class="abrir-busca" type="button" data-abre-busca>${IC.lupa}<span>Cidade, bairro, quartos…</span><i>${ICO.seta}</i></button>
  </div>
</section>
<main class="wrap">
  ${atalhos.length ? `<div class="atalhos">${atalhos.map(a => `<a class="atalho" href="${esc(a.href)}">${a.foto ? imgFoto(a.foto, { alt: a.t, sizes: "(max-width: 760px) 50vw, 300px" }) : ""}<div><b>${esc(a.t)}</b><span>${esc(a.s)}</span></div></a>`).join("")}</div>` : ""}
  ${venda.length ? `<section class="secao">${secaoTopo("Selecionados", "Destaques de venda", link({ busca: "1", finalidade: "venda" }))}${carrossel(venda.slice(0, 10), i => cartao(ctx, i))}</section>` : ""}
  ${lanc.length ? `<section class="secao">${secaoTopo("Na planta", "Lançamentos", link({ lancamentos: "1" }))}${carrossel(lanc.slice(0, 10), i => cartao(ctx, i))}</section>` : ""}
  <section class="servicos" aria-label="Serviços">
    <h2 class="serif">A gente cuida do caminho até as chaves</h2>
    <p>Do primeiro contato à assinatura: procura, financiamento e anúncio do seu imóvel, com quem conhece a região.</p>
    <div class="serv-grade">
      <a class="serv" data-contato data-nome="Encomenda" href="${esc(zap(ctx, msg("quero encomendar um imóvel. Procuro: ")))}" target="_blank" rel="noopener"><span class="ic">${IC.busca2}</span><b>Imóvel sob encomenda</b><span>Descreva o imóvel que você procura e nós avisamos quando encontrarmos.</span><i>Encomendar ${ICO.seta}</i></a>
      <a class="serv" data-contato data-nome="Financiamento" href="${esc(zap(ctx, msg("quero simular um financiamento.")))}" target="_blank" rel="noopener"><span class="ic">${IC.cifra}</span><b>Financiamento</b><span>As melhores ofertas de crédito para você financiar o seu imóvel.</span><i>Fazer uma simulação ${ICO.seta}</i></a>
      <a class="serv" data-contato data-nome="Anunciar" href="${esc(zap(ctx, msg("quero anunciar meu imóvel.")))}" target="_blank" rel="noopener"><span class="ic">${IC.chave}</span><b>Cadastre seu imóvel</b><span>Anuncie com a gente: encontramos o melhor negócio para você.</span><i>Cadastrar ${ICO.seta}</i></a>
    </div>
  </section>
  ${todos.itens.length ? `<section class="secao">${secaoTopo("Novidades", "Imóveis recentes", link({ busca: "1" }))}<div class="grade">${todos.itens.slice(0, 8).map(i => cartao(ctx, i)).join("")}</div></section>` : ""}
  ${aluguel.length ? `<section class="secao">${secaoTopo("Locação", "Para alugar", link({ busca: "1", finalidade: "aluguel" }))}${carrossel(aluguel.slice(0, 10), i => cartao(ctx, i))}</section>` : ""}
  ${conteudo.sobre ? `<section class="secao">${secaoTopo("Quem somos", "Sobre nós", null, "sobre")}
    <div class="sobre"><div class="texto">${esc(conteudo.sobre)}</div>
      <div class="numeros"><div><b class="serif">${r.total}</b><span>${r.total === 1 ? "imóvel disponível" : "imóveis disponíveis"}</span></div>
        ${r.bairros ? `<div><b class="serif">${r.bairros}</b><span>${r.bairros === 1 ? "bairro" : "bairros"} com imóveis</span></div>` : ""}
        ${r.venda_desde ? `<div><b class="serif" style="font-size:clamp(20px,2.2vw,26px)">${moeda(r.venda_desde)}</b><span>para comprar, a partir de</span></div>` : ""}
        ${r.aluguel_desde ? `<div><b class="serif" style="font-size:clamp(20px,2.2vw,26px)">${moeda(r.aluguel_desde)}</b><span>para alugar, a partir de (mês)</span></div>` : ""}</div></div></section>` : ""}
  ${conteudo.depoimentos.length ? `<section class="secao">${secaoTopo("Depoimentos", "O que falam de nós")}${carrossel(conteudo.depoimentos,
    d => `<figure class="depo">${IC.aspas}<p>${esc(d.texto)}</p><b>${esc(d.nome)}</b></figure>`, "depos")}</section>` : ""}
  ${conteudo.equipe.length ? `<section class="secao">${secaoTopo("Nosso time", "Nossa equipe", null, conteudo.sobre ? "equipe" : "sobre")}${carrossel(conteudo.equipe,
    p => `<div class="pessoa"><div class="rosto">${p.foto ? `<img src="${esc(abs(base, p.foto))}" alt="${esc(p.nome)}" loading="lazy">` : esc(String(p.nome).trim()[0] || "?")}</div>
      <b>${esc(p.nome)}</b><span>${esc(p.cargo)}</span>
      <a class="btn btn-linha" style="margin-top:10px;min-height:44px" data-contato data-nome="${esc(p.nome)}" href="${esc(zap(ctx, msg(`gostaria de falar com ${String(p.nome).split(" ")[0]}.`)))}" target="_blank" rel="noopener">${ICO.wpp}Conversar</a></div>`)}</section>` : ""}
  ${porCidade.size ? `<section class="secao">${secaoTopo("Onde estamos", "Imóveis por região")}
    <div class="regioes">${[...porCidade.entries()].map(([cid, lista]) => `<div class="regiao"><b>${esc(cid)}</b>${lista.slice(0, 8).map(b =>
      `<a href="${esc(link({ busca: "1", bairro: b.bairro }))}">${esc(b.bairro)}<span>${b.total}</span></a>`).join("")}</div>`).join("")}</div></section>` : ""}
</main>`;
  const folhaBusca = `<dialog class="folha-busca" aria-label="Buscar imóveis"><div class="cab"><b>Buscar imóveis</b><button class="fechar" type="button" data-fecha-busca aria-label="Fechar">${ICO.fechar}</button></div>
    ${formBusca(ctx, f, todos.cidades, bairros, "f")}<div class="linha-cod" style="padding:0 16px calc(18px + env(safe-area-inset-bottom))">${formCodigo(ctx)}</div></dialog>`;
  return moldura(ctx, {
    titulo: cfg.seo_titulo || `${org.name} — Imóveis à venda e para alugar`,
    descricao: cfg.seo_descricao || `${r.total} imóveis à venda e para alugar. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + inicio(ctx), corpo, conteudo, dados: ctx.demo ? null : dadosDaImobiliaria(ctx), extraFim: folhaBusca,
    imagem: capaImovel ? abs(base, capaImovel.fotos[0]) : (ctx.marca.logo ? abs(base, ctx.marca.logo) : null),
  });
}

function paginaLista(ctx, query, f, conteudo, bairros) {
  const F = fonte(ctx);
  const { org, cfg, base } = ctx;
  const c = F.catalogo(org.id, f);
  const pagina = (p) => {
    const s = new URLSearchParams();
    for (const k of ["finalidade", "tipo", "cidade", "bairro"]) if (f[k]) s.set(k, f[k]);
    if (f.quartos) s.set("quartos", f.quartos); if (f.ate) s.set("ate", f.ate); if (f.codigo) s.set("codigo", f.codigo);
    if (f.lancamentos) s.set("lancamentos", "1"); s.set("busca", "1"); if (p > 1) s.set("p", p);
    if (ctx.previa) s.set("previa", ctx.previa);
    return inicio(ctx) + "?" + s.toString();
  };
  const titulo = f.codigo ? `Código ${f.codigo}` : f.lancamentos ? "Lançamentos" : f.bairro ? `Imóveis em ${f.bairro}` : f.finalidade === "aluguel" ? "Imóveis para alugar" : f.finalidade === "venda" ? "Imóveis à venda" : "Imóveis";
  const corpo = `<div class="wrap lista-capa" id="buscar">${formBusca(ctx, f, c.cidades, bairros, "l")}</div>
<main class="wrap">
  <div class="lista-topo"><h1 class="serif">${esc(titulo)}</h1><span>${c.total} ${c.total === 1 ? "imóvel encontrado" : "imóveis encontrados"}</span></div>
  ${c.itens.length ? `<div class="grade">${c.itens.map(i => cartao(ctx, i)).join("")}</div>`
    : `<div class="vazio"><h2 class="serif" style="margin-top:0">Nada com esses filtros agora</h2><p>Muitas vezes o imóvel certo ainda não foi anunciado. Conta pra gente o que você procura.</p>
       <a class="btn btn-zap" data-contato href="${esc(zap(ctx, `Olá! Vim pelo site da ${org.name} e não encontrei o que procuro. Pode me ajudar?`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div>`}
  ${c.paginas > 1 ? `<nav class="paginas">${f.p > 1 ? `<a class="btn btn-claro" href="${esc(pagina(f.p - 1))}">Anterior</a>` : ""}<span class="btn btn-claro" aria-current="page">${f.p} de ${c.paginas}</span>${f.p < c.paginas ? `<a class="btn btn-claro" href="${esc(pagina(f.p + 1))}">Próxima</a>` : ""}</nav>` : ""}
</main>`;
  return moldura(ctx, {
    titulo: `${titulo} — ${org.name}`, descricao: `${c.total} imóveis. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + inicio(ctx), corpo, conteudo, indexar: false, topoClaro: true,
  });
}

export function paginaImovel(ctx, i) {
  const F = fonte(ctx);
  const { org, cfg, base } = ctx;
  const conteudo = F.conteudoPublico(org.id);
  const url = base + hrefImovel(ctx, i);
  const sobre = `"${i.titulo}" (cód. ${i.codigo})`;
  const P = {
    visitar: zap(ctx, `Olá! Quero visitar o imóvel ${sobre} que vi no site: ${url}`),
    proposta: zap(ctx, `Olá! Quero fazer uma proposta para o imóvel ${sobre} que vi no site: ${url}`),
    info: zap(ctx, `Olá! Quero mais informações sobre o imóvel ${sobre} que vi no site: ${url}`),
  };
  const specs = caracteristicas(i, false).map(([ic, v, r]) => `<div>${ICO[ic]}<span><b>${esc(v)}</b><span>${esc(r || "área")}</span></span></div>`).join("");
  const custos = [i.valor_aluguel ? `Aluguel: <b>${moeda(i.valor_aluguel)}/mês</b>` : "", i.condominio ? `Condomínio: <b>${moeda(i.condominio)}/mês</b>` : "", i.iptu ? `IPTU: <b>${moeda(i.iptu)}/ano</b>` : ""].filter(Boolean);
  const fotos = i.fotos;
  const outros = F.catalogo(org.id, F.filtrosDe({ finalidade: i.finalidade })).itens.filter(x => x.id !== i.id).slice(0, 8);
  const mosaico = fotos.slice(0, 5);
  const pedidos = (cls = "") => `<div class="pedidos ${cls}">
      <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(P.visitar)}" target="_blank" rel="noopener">${IC.cal}Quero visitar</a>
      <a class="btn btn-escuro" data-contato data-nome="${esc(i.titulo)}" href="${esc(P.proposta)}" target="_blank" rel="noopener">${IC.prop}Fazer uma proposta</a>
      <a class="btn btn-linha" data-contato data-nome="${esc(i.titulo)}" href="${esc(P.info)}" target="_blank" rel="noopener">${IC.info}Quero mais informações</a></div>`;
  const corpo = `<main class="wrap imovel-pg">
  <a class="volta" href="${esc(comPrevia(ctx, inicio(ctx)))}">${ICO.voltar}Todos os imóveis</a>
  ${mosaico.length ? `<div class="mosaico${mosaico.length === 1 ? " um" : mosaico.length === 2 ? " dois" : ""}">${mosaico.map((u, n) =>
    `<button type="button" data-foto="${n}" aria-label="Ver a foto ${n + 1} em tela cheia">${imgFoto(u, { alt: altDaFoto(i, n, fotos.length), sizes: n ? "25vw" : "50vw", lazy: n > 0 })}</button>`).join("")}
    ${fotos.length > 1 ? `<button class="todas" type="button" data-foto="0">${IC.fotos}Ver as ${fotos.length} fotos</button>` : ""}</div>
  <div class="galeria-cel carrossel"><div class="trilho">${fotos.map((u, n) => `<button type="button" data-foto="${n}" style="border:0;padding:0;background:#E7E5DF">${imgFoto(u, { alt: altDaFoto(i, n, fotos.length), sizes: "100vw", lazy: n > 0 })}</button>`).join("")}</div>
    ${fotos.length > 1 ? `<span class="cnt" data-cnt>1 / ${fotos.length}</span>` : ""}</div>` : ""}
  <div class="corpo">
    <article>
      <div class="etiq"><span>${i.finalidade === "aluguel" ? "Aluguel" : "Venda"}</span><span>${esc(tipoTexto(i))}</span><span>Cód. ${esc(i.codigo)}</span></div>
      <h1 class="serif">${esc(i.titulo)}</h1>
      ${i.local.linha ? `<div class="onde">${IC.pin}${esc(i.local.linha)}</div>` : ""}
      ${specs ? `<div class="specs">${specs}</div>` : ""}
      ${pedidos("pedidos-cel")}
      ${i.descricao ? `<section class="bloco" style="margin-top:18px"><h2 class="serif">Sobre o imóvel</h2><p class="texto curto" id="desc">${esc(i.descricao)}</p><button class="ler-mais" type="button" data-alvo="desc">Ler a descrição inteira</button></section>` : ""}
      ${pecas.caracteristicasHtml(i, { secao: "bloco" })}
      ${pecas.secaoUnidades(i).replace('class="secao unidades"', 'class="bloco unidades"')}
      ${i.video ? `<section class="bloco"><h2 class="serif">Vídeo</h2><video src="${esc(i.video)}" controls preload="metadata" playsinline></video></section>` : ""}
    </article>
    <aside class="lateral">
      <span class="rot">${i.finalidade === "aluguel" ? "Aluguel" : "Valor de venda"}</span>
      <div class="preco">${precoDe(i)}</div>
      ${custos.length ? `<div class="custos">${custos.map(t => `<span>${t}</span>`).join("")}</div>` : ""}
      ${pedidos()}
      <span class="cod">Código do imóvel: ${esc(i.codigo)}</span>
    </aside>
  </div>
  ${outros.length ? `<section class="secao">${secaoTopo("Você também pode gostar", i.finalidade === "aluguel" ? "Outros para alugar" : "Outros imóveis à venda", comPrevia(ctx, inicio(ctx) + `?busca=1&finalidade=${i.finalidade}`))}${carrossel(outros, x => cartao(ctx, x))}</section>` : ""}
</main>
<div class="barra-cel"><div class="preco"><small>${i.finalidade === "aluguel" ? "Aluguel" : "Valor"}</small>${precoDe(i)}</div>
  <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(P.visitar)}" target="_blank" rel="noopener">${IC.cal}Visitar</a>
  <a class="btn btn-zap" data-contato data-nome="${esc(i.titulo)}" href="${esc(P.info)}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">${ICO.wpp}</a></div>`;
  const luz = fotos.length ? `<div class="luz" role="dialog" aria-label="Fotos do imóvel"><div class="cab"><span>${esc(i.titulo)}</span><button class="fechar" type="button" aria-label="Fechar">${ICO.fechar}</button></div>
    ${carrossel(fotos, (u, n) => `<div>${imgFoto(u, { alt: altDaFoto(i, n, fotos.length), sizes: "100vw", lazy: true })}</div>`)}</div>` : "";
  return moldura(ctx, {
    titulo: tituloDoImovel(ctx, i), descricao: resumoDoImovel(i), url, corpo, conteudo, topoClaro: true, extraFim: luz,
    classeBody: "tem-barra", pixelExtra: pixelDoImovel(i), dados: ctx.demo ? null : dadosDoImovel(ctx, i, url),
    imagem: fotos[0] ? abs(base, fotos[0]) : (ctx.marca.logo ? abs(base, ctx.marca.logo) : null),
  });
}
