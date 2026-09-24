/* O SITE DA IMOBILIÁRIA (24/09/2026, pedido do Ali).

   Cada imobiliária cliente ganha um portal próprio — /imoveis/<slug> — com o
   catálogo e uma página por imóvel, na marca DELA (logo e cor que o gestor já
   escolhe em Configurações → Identidade). O botão de contato vai SEMPRE para
   o WhatsApp da imobiliária, e quem clica entra no CRM pelo caminho de sempre:
   a mensagem chega na Uazapi, a catraca entrega à atendente da vez.

   AS PÁGINAS SÃO MONTADAS NO SERVIDOR, e não no navegador. É o que faz o link
   colado no WhatsApp mostrar a prévia com foto e título: o WhatsApp lê o HTML
   que chega e não roda JavaScript nenhum. Uma página montada no navegador
   chegaria vazia para ele, e o link iria sem foto — justamente no lugar em
   que o corretor mais vai usá-lo.

   O QUE O VISITANTE VÊ É UMA LISTA BRANCA (`publico()`), nunca a linha do
   banco. O cadastro do imóvel guarda coisa que é só da casa — construtora,
   comissão, captador, observações ("dono aceita 10% abaixo"). Montar a página
   a partir da linha inteira seria confiar que ninguém nunca vai escrever
   `p.observacoes` num template; montar a partir de um objeto que não TEM esse
   campo é a garantia. */
import db from "../db.js";
import { normalizePhone } from "./stages.js";
import { marcaDaOrg } from "./marca.js";
import { situacao } from "./assinatura.js";

/* ===== CONFIGURAÇÃO ===== */

export const FRASE_PADRAO = "Encontre o imóvel certo para você";
const POR_PAGINA = 24;

export function slugify(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60).replace(/-+$/g, "");
}

const SLUG_VALIDO = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function slugLivre(base) {
  const raiz = (slugify(base) || "imobiliaria").slice(0, 36).replace(/-+$/g, "") || "imobiliaria";
  let s = raiz.length >= 3 ? raiz : `${raiz}-imoveis`;
  for (let i = 2; db.prepare("SELECT 1 FROM sites WHERE slug = ?").get(s); i++) s = `${raiz}-${i}`;
  return s;
}

/* O número que o gestor provavelmente quer: o que já está pareado na linha da
   casa, ou o contato que ele pôs nos portais. É só o PONTO DE PARTIDA —
   aparece preenchido na tela, e quem liga o site confere. */
function whatsappSugerido(orgId) {
  const casa = db.prepare("SELECT wa_number FROM canais WHERE org_id = ? AND tipo = 'imobiliaria' AND ativo = 1").get(orgId);
  const portal = db.prepare("SELECT telefone FROM portais_config WHERE org_id = ?").get(orgId);
  for (const bruto of [casa && casa.wa_number, portal && portal.telefone]) {
    const n = normalizePhone(bruto);
    if (/^55\d{10,11}$/.test(n)) return n;
  }
  return null;
}

/* Cria a linha na primeira vez que alguém olha — desligada. */
export function configDoSite(orgId) {
  let cfg = db.prepare("SELECT * FROM sites WHERE org_id = ?").get(orgId);
  if (cfg) return cfg;
  const org = db.prepare("SELECT name FROM orgs WHERE id = ?").get(orgId);
  db.prepare("INSERT INTO sites (org_id, slug, ligado, whatsapp, created_at) VALUES (?,?,0,?,?)")
    .run(orgId, slugLivre(org && org.name), whatsappSugerido(orgId), Date.now());
  return db.prepare("SELECT * FROM sites WHERE org_id = ?").get(orgId);
}

/* Devolve `{cfg}` ou `{erro}`. O erro é uma frase para o gestor ler. */
export function salvarSite(orgId, b = {}) {
  const atual = configDoSite(orgId);
  const novo = { ...atual };

  if (b.slug !== undefined) {
    const s = String(b.slug || "").trim().toLowerCase();
    if (!SLUG_VALIDO.test(s))
      return { erro: "O endereço usa só letras sem acento, números e hífen, com 3 a 40 caracteres (ex.: conecta-imoveis)." };
    const dono = db.prepare("SELECT org_id FROM sites WHERE slug = ?").get(s);
    if (dono && dono.org_id !== orgId) return { erro: "Esse endereço já está em uso por outra imobiliária. Escolha outro." };
    novo.slug = s;
  }
  if (b.whatsapp !== undefined) {
    const bruto = String(b.whatsapp || "").trim();
    if (!bruto) novo.whatsapp = null;
    else {
      const n = normalizePhone(bruto);
      if (!/^55\d{10,11}$/.test(n)) return { erro: "WhatsApp inválido. Use DDD + número, ex.: (87) 99999-0000." };
      novo.whatsapp = n;
    }
  }
  if (b.pixel_id !== undefined) {
    const p = String(b.pixel_id || "").replace(/\s/g, "");
    if (p && !/^\d{10,20}$/.test(p))
      return { erro: "O ID do Pixel tem só números (em geral 15 ou 16), e fica no Gerenciador de Eventos do Facebook." };
    novo.pixel_id = p || null;
  }
  if (b.frase !== undefined) {
    const f = String(b.frase || "").replace(/\s+/g, " ").trim();
    if (f.length > 90) return { erro: "A frase de apresentação passa de 90 caracteres — no celular ela ocuparia a tela inteira." };
    novo.frase = f || null;
  }
  if (b.ligado !== undefined) novo.ligado = b.ligado ? 1 : 0;
  // Site no ar sem WhatsApp seria uma vitrine sem porta: o visitante gosta do
  // imóvel e não tem como falar com ninguém.
  if (novo.ligado && !novo.whatsapp) return { erro: "Informe o WhatsApp da imobiliária antes de ligar o site — é para ele que o botão de contato leva." };

  db.prepare("UPDATE sites SET slug=?, ligado=?, whatsapp=?, pixel_id=?, frase=?, atualizado_em=? WHERE org_id=?")
    .run(novo.slug, novo.ligado, novo.whatsapp, novo.pixel_id, novo.frase, Date.now(), orgId);
  return { cfg: configDoSite(orgId) };
}

/* Caminho público de um imóvel, ou null se o site não está no ar. O título vai
   no fim do endereço só para ele ser legível no WhatsApp; quem manda é o id. */
export function caminhoDoImovel(orgId, p) {
  const cfg = db.prepare("SELECT slug, ligado FROM sites WHERE org_id = ?").get(orgId);
  if (!cfg || !cfg.ligado) return null;
  return `/imoveis/${cfg.slug}/${p.id}/${slugify(p.titulo) || "imovel"}`;
}

/* ===== O QUE PODE SAIR PARA A INTERNET ===== */

const fotosDe = (id) => db.prepare("SELECT url FROM produto_midias WHERE produto_id = ? AND tipo = 'foto' ORDER BY ordem, created_at").all(id).map(f => f.url);
const videoDe = (id) => (db.prepare("SELECT url FROM produto_midias WHERE produto_id = ? AND tipo = 'video' ORDER BY ordem, created_at LIMIT 1").get(id) || {}).url || null;

const codigoDe = (id) => String(id).replace(/^p_/, "").replace(/-/g, "").slice(0, 6).toUpperCase();

/* Endereço conforme a escolha do cadastro (`exibir_endereco`). O padrão é só o
   bairro: endereço completo no anúncio leva o cliente direto ao proprietário.

   SEM MAPA, de propósito (24/09/2026, decisão do Ali): a localização exata
   quem manda é o corretor, na conversa, quando achar que é a hora. Mapa na
   página seria entregar ao visitante — e a quem quer pular a imobiliária —
   o que a conversa existe para conduzir. */
function localDe(p) {
  const modo = ["bairro", "rua", "completo"].includes(p.exibir_endereco) ? p.exibir_endereco : "bairro";
  const cidadeUf = [p.cidade, p.uf].filter(Boolean).join(" - ");
  const rua = modo === "completo" ? [p.endereco, p.numero_end].filter(Boolean).join(", ") : modo === "rua" ? (p.endereco || "") : "";
  const linha = [rua, p.bairro, cidadeUf].filter(Boolean).join(" · ");
  return { linha, curta: [p.bairro, p.cidade].filter(Boolean).join(" · ") };
}

export function publico(p) {
  const aluguel = p.finalidade === "aluguel";
  return {
    id: p.id,
    codigo: codigoDe(p.id),
    titulo: p.titulo,
    finalidade: aluguel ? "aluguel" : "venda",
    tipo: p.tipo === "terreno" ? "terreno" : "casa",
    valor: p.valor > 0 ? p.valor : null,
    condominio: p.condominio > 0 ? p.condominio : null,
    iptu: p.iptu > 0 ? p.iptu : null,
    quartos: p.quartos > 0 ? p.quartos : null,
    suites: p.suites > 0 ? p.suites : null,
    banheiros: p.banheiros > 0 ? p.banheiros : null,
    vagas: p.vagas > 0 ? p.vagas : null,
    area_util: p.area_util > 0 ? p.area_util : null,
    terreno: p.metragem > 0 ? p.metragem : null,
    descricao: (p.descricao || "").trim() || null,   // a PÚBLICA — nunca `observacoes`
    modalidade: !aluguel && p.modalidade ? p.modalidade : null,
    local: localDe(p),
    fotos: fotosDe(p.id),
    video: videoDe(p.id),
  };
}

/* ===== LEITURA PÚBLICA ===== */

/* O site só existe ligado, e só enquanto a conta está em dia. Conta travada
   por falta de pagamento não mantém vitrine grátis na internet — mas também
   não some com um 404: o visitante vê "voltamos em breve", porque o link pode
   estar num anúncio pago rodando agora. */
export function siteDoSlug(slug) {
  const cfg = db.prepare("SELECT * FROM sites WHERE slug = ? AND ligado = 1").get(String(slug || "").toLowerCase());
  if (!cfg) return null;
  const org = db.prepare("SELECT id, name, logo_url, cor_barra FROM orgs WHERE id = ?").get(cfg.org_id);
  if (!org) return null;
  let pausado = false;
  try { pausado = ["bloqueado", "aguardando_cartao"].includes(situacao(org.id).status); } catch { pausado = false; }
  return { cfg, org, marca: marcaDaOrg(org), pausado };
}

const FAIXAS = {
  venda: [150000, 200000, 300000, 500000, 800000, 1500000],
  aluguel: [1000, 1500, 2000, 3000, 5000, 8000],
};

export function filtrosDe(q = {}) {
  const f = {
    finalidade: ["venda", "aluguel"].includes(q.finalidade) ? q.finalidade : "",
    tipo: ["casa", "terreno"].includes(q.tipo) ? q.tipo : "",
    cidade: String(q.cidade || "").slice(0, 80),
    quartos: [1, 2, 3, 4].includes(Number(q.quartos)) ? Number(q.quartos) : 0,
    ate: Number(q.ate) > 0 ? Number(q.ate) : 0,
    p: Math.max(1, Math.min(500, parseInt(q.p, 10) || 1)),
  };
  // Faixa de preço só vale dentro de uma finalidade: "até R$ 2.000" num
  // catálogo misturado cortaria todas as casas à venda sem ninguém entender.
  if (!f.finalidade) f.ate = 0;
  return f;
}

export function catalogo(orgId, f) {
  const where = ["org_id = ?", "status = 'ativo'"], args = [orgId];
  if (f.finalidade) { where.push("COALESCE(finalidade,'venda') = ?"); args.push(f.finalidade); }
  if (f.tipo) { where.push("tipo = ?"); args.push(f.tipo); }
  if (f.cidade) { where.push("cidade = ?"); args.push(f.cidade); }
  if (f.quartos) { where.push("COALESCE(quartos,0) >= ?"); args.push(f.quartos); }
  if (f.ate) { where.push("valor > 0 AND valor <= ?"); args.push(f.ate); }
  const w = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) n FROM produtos WHERE ${w}`).get(...args).n;
  const linhas = db.prepare(`SELECT * FROM produtos WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, POR_PAGINA, (f.p - 1) * POR_PAGINA);
  const cidades = db.prepare("SELECT DISTINCT cidade FROM produtos WHERE org_id = ? AND status = 'ativo' AND cidade IS NOT NULL AND cidade <> '' ORDER BY cidade").all(orgId).map(r => r.cidade);
  const disponiveis = db.prepare("SELECT COUNT(*) n FROM produtos WHERE org_id = ? AND status = 'ativo'").get(orgId).n;
  return { total, itens: linhas.map(publico), cidades, disponiveis, paginas: Math.max(1, Math.ceil(total / POR_PAGINA)) };
}

export function imovelDoSite(orgId, id) {
  const p = db.prepare("SELECT * FROM produtos WHERE id = ? AND org_id = ?").get(String(id || ""), orgId);
  if (!p) return { existe: false };
  // Aguardando aprovação e recusado nunca foram públicos: para o visitante,
  // não existem. Vendido, alugado e inativo JÁ foram — o link pode estar num
  // anúncio ou numa conversa, e merece uma resposta melhor que "não achei".
  if (["aguardando_aprovacao", "recusado"].includes(p.status)) return { existe: false };
  if (p.status !== "ativo") return { existe: true, disponivel: false, titulo: p.titulo, status: p.status };
  return { existe: true, disponivel: true, imovel: publico(p) };
}

/* ===== HTML ===== */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const abs = (base, u) => (!u ? "" : /^https?:\/\//i.test(u) ? u : base + (u.startsWith("/") ? "" : "/") + u);

const moeda = (v) => {
  if (v == null) return "";
  const inteiro = Math.abs(v - Math.round(v)) < 0.005;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: inteiro ? 0 : 2, maximumFractionDigits: inteiro ? 0 : 2 }).format(v);
};
const numero = (v) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(v);
const precoDe = (i) => (i.valor ? moeda(i.valor) + (i.finalidade === "aluguel" ? "<small>/mês</small>" : "") : "Consulte");
const precoTexto = (i) => (i.valor ? moeda(i.valor) + (i.finalidade === "aluguel" ? "/mês" : "") : "Valor sob consulta");

function telefoneLegivel(n) {
  const d = String(n || "").replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}
const wa = (numeroWa, texto) => `https://wa.me/${numeroWa}?text=${encodeURIComponent(texto)}`;

// Tom suave da cor da marca, para fundos de etiqueta. Misturar com branco
// mantém a família da cor sem inventar uma segunda cor de marca.
function suave(hex, quanto = 0.9) {
  const n = hex.replace("#", "");
  return "#" + [0, 1, 2].map(i => {
    const c = parseInt(n.slice(i * 2, i * 2 + 2), 16);
    return Math.round(c + (255 - c) * quanto).toString(16).padStart(2, "0");
  }).join("");
}

const ICO = {
  /* O ícone do WhatsApp é PREENCHIDO e sem traço. O CSS geral dos ícones põe
     `stroke` em todo svg (os outros são desenhos de linha), e com traço por
     cima o contorno do balão engrossava e os detalhes do fone viravam borrão —
     "qualidade baixa" na tela, sem nada errado no arquivo. Caminho oficial,
     com precisão total. */
  wpp: '<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke:none"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>',
  cama: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 14h18M3 18v2M21 18v2M7 9V6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3"/></svg>',
  banho: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3ZM6 12V5a2 2 0 0 1 3.5-1.3M7 19l-1 2M17 19l1 2"/></svg>',
  suite: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M2 21h20M12 12h.01M16 7h3a1 1 0 0 1 1 1v13"/></svg>',
  carro: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17h14M5 17v2M19 17v2M4 17v-5l2-5h12l2 5v5M4 12h16M7.5 14.5h.01M16.5 14.5h.01"/></svg>',
  area: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM4 9h3M4 14h3M9 4v3M14 4v3"/></svg>',
  pino: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  voltar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  seta: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  fechar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  grade: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>',
  casa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11 12 4l9 7M5 10v10h14V10"/></svg>',
};

function caracteristicas(i, curto) {
  const itens = [];
  if (i.quartos) itens.push(["cama", i.quartos, i.quartos > 1 ? "quartos" : "quarto"]);
  if (!curto && i.suites) itens.push(["suite", i.suites, i.suites > 1 ? "suítes" : "suíte"]);
  if (i.banheiros) itens.push(["banho", i.banheiros, i.banheiros > 1 ? "banheiros" : "banheiro"]);
  if (i.vagas) itens.push(["carro", i.vagas, i.vagas > 1 ? "vagas" : "vaga"]);
  if (i.tipo === "casa" && i.area_util) itens.push(["area", `${numero(i.area_util)} m²`, curto ? "" : "construídos"]);
  if ((i.tipo === "terreno" || !curto) && i.terreno) itens.push(["area", `${numero(i.terreno)} m²`, curto ? "" : "de terreno"]);
  return itens;
}

/* Pixel do Facebook: o código padrão da Meta, só quando o gestor informou o
   ID — e o ID já foi conferido como só dígitos em `salvarSite`, então não há
   como ele carregar outra coisa para dentro da página. */
function pixel(cfg, extra = "") {
  if (!cfg.pixel_id) return "";
  const id = esc(cfg.pixel_id);
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');${extra}</script><noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F6F6F3;color:#16181D;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block;max-width:100%}
svg{width:1em;height:1em;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.topo{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid #E7E7E2}
.topo .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;height:68px}
.marca{display:flex;align-items:center;gap:10px;min-width:0}
.marca img{height:48px;width:auto;max-width:210px;object-fit:contain}
.marca span{font-weight:700;font-size:18px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap;transition:filter .15s,transform .15s}
.btn:hover{filter:brightness(1.12)}
.btn:active{transform:scale(.98)}
.btn-marca{background:var(--marca);color:#fff;padding:11px 18px;font-size:15px}
.btn-marca svg{font-size:19px}
.btn-lg{width:100%;padding:15px 20px;font-size:16px}
.btn-claro{background:#fff;color:#16181D;border:1px solid #DADAD4;padding:10px 16px;font-size:14px}
.heroi{background:var(--marca);color:#fff;padding:40px 0 84px}
.heroi h1{font-size:clamp(26px,3.6vw,38px);line-height:1.12;letter-spacing:-.02em;font-weight:700;max-width:760px}
.heroi p{margin-top:12px;font-size:16px;opacity:.82}
.busca{background:#fff;border-radius:18px;box-shadow:0 12px 40px rgba(16,24,40,.12);padding:18px;margin-top:-62px;position:relative}
.abas{display:flex;gap:4px;background:#F1F1ED;border-radius:12px;padding:4px;width:max-content;max-width:100%;margin-bottom:14px}
.abas a{padding:8px 18px;border-radius:9px;font-size:14px;font-weight:600;color:#5F6670}
.abas a.on{background:#fff;color:#16181D;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.campos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto;gap:10px}
.campos.c3{grid-template-columns:repeat(3,minmax(0,1fr)) auto}
.campos select{appearance:none;-webkit-appearance:none;width:100%;font:inherit;font-size:15px;color:#16181D;background:#F8F8F5 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235F6670' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 12px center/16px;border:1px solid #E2E2DC;border-radius:12px;padding:13px 36px 13px 14px;min-height:48px}
.campos .btn{min-height:48px;padding:0 26px}
.resumo{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:34px 0 16px}
.resumo h2{font-size:20px;letter-spacing:-.01em}
.resumo a{font-size:14px;color:#5F6670;text-decoration:underline}
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:20px}
.card{background:#fff;border-radius:16px;overflow:hidden;border:1px solid #ECECE7;display:flex;flex-direction:column;transition:box-shadow .2s,transform .2s}
.card:hover{box-shadow:0 14px 34px rgba(16,24,40,.10);transform:translateY(-2px)}
.card .foto{position:relative;aspect-ratio:3/2;background:#EDEDE8;overflow:hidden}
.card .foto img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sem-foto{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#B9BDB5;font-size:44px}
.selo{position:absolute;top:12px;left:12px;background:rgba(255,255,255,.95);color:#16181D;font-size:12px;font-weight:600;padding:5px 10px;border-radius:999px}
.card .info{padding:14px 16px 16px;display:flex;flex-direction:column;gap:5px;flex:1}
.preco{font-size:22px;font-weight:700;letter-spacing:-.01em;color:#16181D}
.preco small{font-size:14px;font-weight:500;color:#5F6670;margin-left:2px}
.card h3{font-size:15px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.onde{display:flex;align-items:center;gap:5px;font-size:13.5px;color:#5F6670}
.feats{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:auto;padding-top:10px;border-top:1px solid #F0F0EB;font-size:13.5px;color:#3E434B}
.feats span{display:inline-flex;align-items:center;gap:6px}
.feats svg{font-size:17px;color:#7A808A}
.vazio{background:#fff;border:1px solid #ECECE7;border-radius:16px;padding:48px 24px;text-align:center}
.vazio h3{font-size:18px}
.vazio p{color:#5F6670;margin:8px 0 20px}
.paginas{display:flex;justify-content:center;gap:8px;margin:34px 0 0}
.rodape{margin-top:64px;border-top:1px solid #E7E7E2;background:#fff;padding:32px 0;color:#5F6670;font-size:14px}
.rodape .wrap{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between}
.rodape b{color:#16181D}
.rodape .fina{font-size:12px;color:#9AA0A8}
/* Página do imóvel */
.volta{display:inline-flex;align-items:center;gap:4px;font-size:14px;color:#5F6670;margin:22px 0 14px}
.volta svg{font-size:18px}
.gal{position:relative;border-radius:18px;overflow:hidden;background:#1a1a1a}
.trilho{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;height:clamp(280px,52vw,600px)}
.trilho::-webkit-scrollbar{display:none}
.trilho button{flex:0 0 100%;scroll-snap-align:center;border:0;padding:0;background:none;cursor:zoom-in}
.trilho img{width:100%;height:100%;object-fit:cover}
.gal .nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:999px;border:0;background:rgba(255,255,255,.92);color:#16181D;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.gal .ant{left:14px}.gal .prox{right:14px}
.gal .cont{position:absolute;right:14px;bottom:14px;background:rgba(0,0,0,.62);color:#fff;font-size:13px;font-weight:600;padding:5px 11px;border-radius:999px}
.miniaturas{display:flex;gap:8px;overflow-x:auto;padding:10px 0 2px;scrollbar-width:thin}
.miniaturas button{flex:0 0 auto;width:92px;height:66px;border-radius:10px;overflow:hidden;border:2px solid transparent;padding:0;cursor:pointer;opacity:.7;background:none}
.miniaturas button.on{border-color:var(--marca);opacity:1}
.miniaturas img{width:100%;height:100%;object-fit:cover}
/* No computador a galeria vira MOSAICO: uma foto grande e até quatro menores
   ao lado, numa altura contida. A foto única de 600px ocupava a tela inteira
   e empurrava preço, ficha e WhatsApp para baixo da dobra (pedido do Ali,
   24/09/2026). No celular continua o carrossel, que é o gesto de lá. */
.mosaico{display:none}
@media (min-width:901px){
  .gal,.miniaturas{display:none}
  .mosaico{display:grid;position:relative;gap:8px;height:clamp(300px,30vw,400px);border-radius:18px;overflow:hidden;
    grid-template-columns:2fr 1fr 1fr;grid-template-rows:1fr 1fr}
  .mosaico button{border:0;padding:0;background:#E9E9E4;cursor:zoom-in;overflow:hidden;min-height:0}
  .mosaico img{width:100%;height:100%;object-fit:cover;transition:transform .35s}
  .mosaico button:hover img{transform:scale(1.03)}
  .mosaico button:first-child{grid-row:1/3;grid-column:1/2}
  /* Uma foto só: inteira, sem corte — foto de celular em pé cortada numa faixa
     larga mostraria só o meio do cômodo. */
  .mosaico.m1{grid-template-columns:1fr;background:#1a1a1a}
  .mosaico.m1 img{object-fit:contain}
  .mosaico.m1 button{background:#1a1a1a}
  .mosaico.m1 button:first-child{grid-column:1/2}
  .mosaico.m2{grid-template-columns:1fr 1fr}
  .mosaico.m2 button:nth-child(2){grid-row:1/3}
  .mosaico.m3 button:nth-child(n+2){grid-column:2/4}
  .mosaico.m4 button:nth-child(2){grid-column:2/4}
  .mosaico .todas{position:absolute;right:14px;bottom:14px;background:#fff;color:#16181D;border:0;border-radius:10px;padding:9px 14px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.16);display:inline-flex;align-items:center;gap:6px}
}
.corpo{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:40px;margin-top:28px;align-items:start}
.corpo h1{font-size:clamp(24px,3.2vw,32px);line-height:1.2;letter-spacing:-.02em}
.corpo .onde{font-size:15px;margin-top:8px}
.etiquetas{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.etiqueta{background:var(--suave);color:var(--marca);font-size:12.5px;font-weight:600;padding:5px 11px;border-radius:999px}
.ficha{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin:26px 0 8px}
.ficha div{background:#fff;border:1px solid #ECECE7;border-radius:14px;padding:14px 16px}
.ficha svg{font-size:22px;color:var(--marca)}
.ficha b{display:block;font-size:17px;margin-top:8px}
.ficha span{font-size:13px;color:#5F6670}
.secao{margin-top:34px}
.secao h2{font-size:19px;letter-spacing:-.01em;margin-bottom:12px}
.texto{white-space:pre-line;color:#30343B;font-size:15.5px;line-height:1.7}
.video{width:100%;border-radius:16px;background:#000;max-height:520px}
.lateral{position:sticky;top:92px;background:#fff;border:1px solid #ECECE7;border-radius:18px;padding:24px;box-shadow:0 10px 30px rgba(16,24,40,.06)}
.lateral .rot{font-size:13px;color:#5F6670;font-weight:600}
.lateral .preco{font-size:30px;margin:4px 0 14px}
.custos{border-top:1px solid #F0F0EB;padding-top:12px;margin-bottom:18px;font-size:14px;color:#5F6670;display:flex;flex-direction:column;gap:6px}
.custos div{display:flex;justify-content:space-between;gap:6px}
.custos b{color:#16181D;font-weight:600}
.lateral .cod{text-align:center;font-size:12.5px;color:#9AA0A8;margin-top:12px}
.barra-cel{display:none}
.caixa{position:fixed;inset:0;background:rgba(10,10,10,.96);z-index:50;display:none;flex-direction:column}
.caixa.on{display:flex}
.caixa .trilho{flex:1;height:auto}
.caixa .trilho img{object-fit:contain}
.caixa .trilho button{cursor:default}
.caixa .fecha{position:absolute;top:14px;right:14px;z-index:2;width:44px;height:44px;border-radius:999px;border:0;background:rgba(255,255,255,.14);color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.caixa .nav{position:absolute;top:50%;transform:translateY(-50%);width:48px;height:48px;border-radius:999px;border:0;background:rgba(255,255,255,.14);color:#fff;font-size:24px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.caixa .ant{left:14px}.caixa .prox{right:14px}
.caixa .cont{position:absolute;left:50%;transform:translateX(-50%);bottom:18px;color:#fff;font-size:14px}
.aviso{max-width:560px;margin:72px auto;background:#fff;border:1px solid #ECECE7;border-radius:18px;padding:40px 28px;text-align:center}
.aviso h1{font-size:24px;letter-spacing:-.01em}
.aviso p{color:#5F6670;margin:10px 0 24px}
.aviso .acoes{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
@media (max-width:900px){
  .corpo{grid-template-columns:1fr;gap:0}
  .lateral{display:none}
  .barra-cel{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;background:#fff;border-top:1px solid #E7E7E2;padding:12px 16px calc(12px + env(safe-area-inset-bottom));align-items:center;gap:12px;box-shadow:0 -6px 20px rgba(0,0,0,.06)}
  .barra-cel .preco{font-size:19px}
  .barra-cel .btn{flex-shrink:0;padding:13px 18px}
  body.tem-barra{padding-bottom:84px}
  .preco-cel{display:block!important}
}
@media (max-width:760px){
  .wrap{padding:0 16px}
  .topo .wrap{height:60px}
  .marca img{height:34px}
  .topo .btn-marca span{display:none}
  .topo .btn-marca{padding:10px 12px}
  .heroi{padding:36px 0 84px}
  .busca{padding:14px;border-radius:16px}
  .campos,.campos.c3{grid-template-columns:1fr 1fr}
  .campos .btn{grid-column:1/-1}
  .gal{border-radius:0;margin:0 -16px}
  .gal .trilho{height:75vw}
  .gal .nav{display:none}
  .miniaturas{display:none}
  .volta{margin:14px 0 10px}
  .ficha{grid-template-columns:repeat(2,1fr)}
  .caixa .nav{display:none}
}
/* No celular o card vira uma LINHA (foto ao lado do texto), como nas listas
   dos portais: empilhado, cada imóvel ocupava a tela inteira e um catálogo de
   40 imóveis virava uma rolagem sem fim (pedido do Ali, 24/09/2026). */
@media (max-width:560px){
  .grade{grid-template-columns:1fr;gap:12px}
  .card{flex-direction:row;border-radius:14px}
  .card:hover{transform:none}
  .card .foto{width:40%;flex-shrink:0;aspect-ratio:auto;min-height:128px}
  .card .info{padding:11px 12px;gap:3px;min-width:0}
  .card .preco{font-size:17px}
  .card .preco small{font-size:12px}
  .card h3{font-size:13.5px}
  .card .onde{font-size:12px}
  .card .feats{font-size:12px;gap:4px 10px;padding-top:7px}
  .card .feats svg{font-size:14px}
  .selo{top:8px;left:8px;font-size:10.5px;padding:3px 8px}
  .resumo{margin:24px 0 12px}
  .resumo h2{font-size:17px}
}
.preco-cel{display:none;margin-top:14px}
.preco-cel .preco{font-size:26px}
.preco-cel .custos{border:0;padding:0;margin:6px 0 0;flex-direction:row;flex-wrap:wrap;gap:4px 16px}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

function moldura({ ctx, titulo, descricao, url, imagem, corpo, extraHead = "", pixelExtra = "", indexar = true, classeBody = "" }) {
  const { org, marca, cfg, base } = ctx;
  const cor = marca.cor;
  const logo = marca.logo ? abs(base, marca.logo) : null;
  const portal = `/imoveis/${cfg.slug}`;
  const numeroWa = cfg.whatsapp;
  const msgGeral = `Olá! Vim pelo site da ${org.name} e gostaria de ajuda para encontrar um imóvel.`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
${indexar ? "" : '<meta name="robots" content="noindex">'}
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(org.name)}">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao)}">
<meta property="og:url" content="${esc(url)}">${imagem ? `<meta property="og:image" content="${esc(imagem)}"><meta name="twitter:card" content="summary_large_image">` : ""}
<meta name="theme-color" content="${esc(cor)}">
${logo ? `<link rel="icon" href="${esc(logo)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>:root{--marca:${cor};--suave:${suave(cor)}}${CSS}</style>
${extraHead}${pixel(cfg, pixelExtra)}
</head><body class="${classeBody}">
<header class="topo"><div class="wrap">
  <a class="marca" href="${portal}" aria-label="${esc(org.name)} — início">${logo ? `<img src="${esc(logo)}" alt="${esc(org.name)}">` : `<span>${esc(org.name)}</span>`}</a>
  <a class="btn btn-marca" data-contato href="${esc(wa(numeroWa, msgGeral))}" target="_blank" rel="noopener">${ICO.wpp}<span>Fale conosco</span></a>
</div></header>
${corpo}
<footer class="rodape"><div class="wrap">
  <div><b>${esc(org.name)}</b><br>WhatsApp ${esc(telefoneLegivel(numeroWa))}</div>
  <div class="fina">${cfg.pixel_id ? "Este site usa cookies do Facebook para medir anúncios. · " : ""}© ${new Date().getFullYear()} ${esc(org.name)} · Site por ConHub</div>
</div></footer>
<script>
document.querySelectorAll('[data-contato]').forEach(function(a){a.addEventListener('click',function(){try{if(window.fbq)fbq('track','Lead',{content_name:a.getAttribute('data-nome')||'Site'})}catch(e){}})});
</script>
</body></html>`;
}

function cartao(i, slug) {
  const href = `/imoveis/${slug}/${i.id}/${slugify(i.titulo) || "imovel"}`;
  const feats = caracteristicas(i, true).map(([ic, v, r]) => `<span>${ICO[ic]}${esc(v)}${r ? " " + esc(r) : ""}</span>`).join("");
  return `<a class="card" href="${href}">
  <div class="foto">${i.fotos[0] ? `<img src="${esc(i.fotos[0])}" alt="${esc(i.titulo)}" loading="lazy">` : `<div class="sem-foto">${ICO.casa}</div>`}
    <span class="selo">${i.finalidade === "aluguel" ? "Para alugar" : "À venda"}</span></div>
  <div class="info">
    <div class="preco">${precoDe(i)}</div>
    <h3>${esc(i.titulo)}</h3>
    ${i.local.curta ? `<div class="onde">${ICO.pino}${esc(i.local.curta)}</div>` : ""}
    ${feats ? `<div class="feats">${feats}</div>` : ""}
  </div></a>`;
}

export function paginaPortal(ctx, query) {
  const { org, cfg, base } = ctx;
  const f = filtrosDe(query);
  const c = catalogo(org.id, f);
  const portal = `/imoveis/${cfg.slug}`;
  const link = (mudar) => {
    const q = { ...f, ...mudar };
    if (!q.finalidade) delete q.ate;
    const s = new URLSearchParams();
    for (const k of ["finalidade", "tipo", "cidade", "quartos", "ate"]) if (q[k]) s.set(k, q[k]);
    if (q.p > 1) s.set("p", q.p);
    const t = s.toString();
    return portal + (t ? "?" + t : "");
  };
  const aba = (v, t) => `<a href="${esc(link({ finalidade: v, ate: 0, p: 1 }))}" class="${f.finalidade === v ? "on" : ""}">${t}</a>`;
  const opt = (v, t, atual) => `<option value="${esc(v)}"${String(atual) === String(v) ? " selected" : ""}>${esc(t)}</option>`;
  const faixas = f.finalidade ? FAIXAS[f.finalidade] : null;
  const filtrando = f.tipo || f.cidade || f.quartos || f.ate || f.finalidade;
  const titulo = `${org.name} — Imóveis à venda e para alugar`;
  const capa = c.itens.find(i => i.fotos[0]);
  const imagem = ctx.marca.logo ? abs(base, ctx.marca.logo) : capa ? abs(base, capa.fotos[0]) : null;
  const nomeLista = f.finalidade === "aluguel" ? "para alugar" : f.finalidade === "venda" ? "à venda" : "disponíveis";

  const corpo = `
<section class="heroi"><div class="wrap">
  <h1>${esc(cfg.frase || FRASE_PADRAO)}</h1>
  <p>${c.disponiveis} ${c.disponiveis === 1 ? "imóvel disponível" : "imóveis disponíveis"} · ${esc(org.name)}</p>
</div></section>
<main class="wrap">
  <form class="busca" method="get" action="${portal}" onsubmit="Array.prototype.forEach.call(this.elements,function(e){if(e.name&&!e.value)e.disabled=true})">
    <nav class="abas" aria-label="Tipo de negócio">${aba("", "Todos")}${aba("venda", "Comprar")}${aba("aluguel", "Alugar")}</nav>
    ${f.finalidade ? `<input type="hidden" name="finalidade" value="${esc(f.finalidade)}">` : ""}
    <div class="campos${faixas ? "" : " c3"}">
      <select name="tipo" aria-label="Tipo de imóvel">${opt("", "Tipo", f.tipo)}${opt("casa", "Casas", f.tipo)}${opt("terreno", "Terrenos", f.tipo)}</select>
      <select name="cidade" aria-label="Cidade">${opt("", "Cidade", f.cidade)}${c.cidades.map(x => opt(x, x, f.cidade)).join("")}</select>
      <select name="quartos" aria-label="Quartos">${opt("", "Quartos", f.quartos || "")}${[1, 2, 3, 4].map(n => opt(n, `${n}+ quartos`, f.quartos || "")).join("")}</select>
      ${faixas
        ? `<select name="ate" aria-label="Valor máximo">${opt("", "Valor máximo", f.ate || "")}${faixas.map(v => opt(v, "até " + moeda(v), f.ate || "")).join("")}</select>`
        : ""}
      <button class="btn btn-marca" type="submit">Buscar</button>
    </div>
  </form>
  <div class="resumo">
    <h2>${c.total} ${c.total === 1 ? "imóvel" : "imóveis"} ${nomeLista}</h2>
    ${filtrando ? `<a href="${portal}">Limpar filtros</a>` : ""}
  </div>
  ${c.itens.length
    ? `<div class="grade">${c.itens.map(i => cartao(i, cfg.slug)).join("")}</div>`
    : `<div class="vazio"><h3>Nenhum imóvel com esses filtros</h3><p>Conte pra gente o que você procura — muitas vezes o imóvel certo ainda não foi anunciado.</p>
       <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e não encontrei o que procuro. Pode me ajudar?`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div>`}
  ${c.paginas > 1 ? `<nav class="paginas">${f.p > 1 ? `<a class="btn btn-claro" href="${esc(link({ p: f.p - 1 }))}">Anterior</a>` : ""}<span class="btn btn-claro" aria-current="page">${f.p} de ${c.paginas}</span>${f.p < c.paginas ? `<a class="btn btn-claro" href="${esc(link({ p: f.p + 1 }))}">Próxima</a>` : ""}</nav>` : ""}
</main>`;
  return moldura({
    ctx, titulo, corpo, imagem,
    descricao: `${c.disponiveis} imóveis à venda e para alugar. Fale com a ${org.name} pelo WhatsApp.`,
    url: base + link({}),
  });
}

export function paginaImovel(ctx, i) {
  const { org, cfg, base } = ctx;
  const portal = `/imoveis/${cfg.slug}`;
  const url = `${base}${portal}/${i.id}/${slugify(i.titulo) || "imovel"}`;
  const msg = `Olá! Tenho interesse no imóvel "${i.titulo}" (cód. ${i.codigo}) que vi no site: ${url}`;
  const linkWa = wa(cfg.whatsapp, msg);
  const fotos = i.fotos;
  const ficha = caracteristicas(i, false).map(([ic, v, r]) => `<div>${ICO[ic]}<b>${esc(v)}</b><span>${esc(r || "")}</span></div>`).join("");
  const custos = [
    i.condominio ? `<div><span>Condomínio</span><b>${moeda(i.condominio)}/mês</b></div>` : "",
    i.iptu ? `<div><span>IPTU</span><b>${moeda(i.iptu)}/ano</b></div>` : "",
  ].join("");
  const rotulo = i.finalidade === "aluguel" ? "Aluguel" : "Venda";
  const slides = (zoom) => fotos.map((u, n) => `<button type="button" data-i="${n}" aria-label="Foto ${n + 1} de ${fotos.length}"><img src="${esc(u)}" alt="${esc(i.titulo)} — foto ${n + 1}"${n > 0 || zoom ? ' loading="lazy"' : ""}></button>`).join("");

  const galeria = fotos.length
    ? `<div class="gal" id="gal"><div class="trilho">${slides(false)}</div>
        ${fotos.length > 1 ? `<button class="nav ant" type="button" aria-label="Foto anterior">${ICO.voltar}</button><button class="nav prox" type="button" aria-label="Próxima foto">${ICO.seta}</button><span class="cont">1 / ${fotos.length}</span>` : ""}</div>
       <div class="mosaico m${Math.min(fotos.length, 5)}">${fotos.slice(0, 5).map((u, n) => `<button type="button" data-i="${n}" aria-label="Ampliar foto ${n + 1} de ${fotos.length}"><img src="${esc(u)}" alt="${esc(i.titulo)} — foto ${n + 1}"${n ? ' loading="lazy"' : ""}></button>`).join("")}
         ${fotos.length > 1 ? `<button type="button" class="todas" data-i="0">${ICO.grade}Ver as ${fotos.length} fotos</button>` : ""}</div>
       ${fotos.length > 1 ? `<div class="miniaturas">${fotos.map((u, n) => `<button type="button" data-i="${n}" class="${n ? "" : "on"}" aria-label="Ver foto ${n + 1}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
       <div class="caixa" id="caixa" role="dialog" aria-modal="true" aria-label="Fotos do imóvel"><button class="fecha" type="button" aria-label="Fechar">${ICO.fechar}</button><div class="trilho">${slides(true)}</div>
        ${fotos.length > 1 ? `<button class="nav ant" type="button" aria-label="Foto anterior">${ICO.voltar}</button><button class="nav prox" type="button" aria-label="Próxima foto">${ICO.seta}</button>` : ""}<span class="cont">1 / ${fotos.length}</span></div>`
    : `<div class="gal"><div class="trilho"><div class="sem-foto" style="flex:1;background:#EDEDE8">${ICO.casa}</div></div></div>`;


  const corpo = `
<main class="wrap">
  <a class="volta" href="${portal}">${ICO.voltar}Todos os imóveis</a>
  ${galeria}
  <div class="corpo">
    <article>
      <div class="etiquetas"><span class="etiqueta">${i.finalidade === "aluguel" ? "Para alugar" : "À venda"}</span>${i.modalidade ? `<span class="etiqueta">Aceita ${esc(i.modalidade)}</span>` : ""}</div>
      <h1>${esc(i.titulo)}</h1>
      ${i.local.linha ? `<p class="onde">${ICO.pino}${esc(i.local.linha)}</p>` : ""}
      <div class="preco-cel"><div class="preco">${precoDe(i)}</div>${custos ? `<div class="custos">${custos}</div>` : ""}</div>
      ${ficha ? `<div class="ficha">${ficha}</div>` : ""}
      ${i.descricao ? `<div class="secao"><h2>Sobre o imóvel</h2><p class="texto">${esc(i.descricao)}</p></div>` : ""}
      ${i.video ? `<div class="secao"><h2>Vídeo</h2><video class="video" src="${esc(i.video)}" controls preload="metadata" playsinline></video></div>` : ""}
    </article>
    <aside class="lateral">
      <div class="rot">${rotulo}</div>
      <div class="preco">${precoDe(i)}</div>
      ${custos ? `<div class="custos">${custos}</div>` : ""}
      <a class="btn btn-marca btn-lg" data-contato data-nome="${esc(i.titulo)}" href="${esc(linkWa)}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a>
      <div class="cod">Código do imóvel: ${esc(i.codigo)}</div>
    </aside>
  </div>
</main>
<div class="barra-cel"><div style="flex:1;min-width:0"><div class="preco">${precoDe(i)}</div></div>
  <a class="btn btn-marca" data-contato data-nome="${esc(i.titulo)}" href="${esc(linkWa)}" target="_blank" rel="noopener">${ICO.wpp}WhatsApp</a></div>
<script>
(function(){
  function montar(raiz,aoMudar){
    if(!raiz)return null;var t=raiz.querySelector('.trilho'),c=raiz.querySelector('.cont'),n=t.children.length;
    function atual(){return Math.round(t.scrollLeft/Math.max(1,t.clientWidth))}
    function ir(k,suave){k=(k+n)%n;t.scrollTo({left:k*t.clientWidth,behavior:suave===false?'auto':'smooth'})}
    t.addEventListener('scroll',function(){var k=atual();if(c)c.textContent=(k+1)+' / '+n;if(aoMudar)aoMudar(k)},{passive:true});
    var a=raiz.querySelector('.ant'),p=raiz.querySelector('.prox');
    if(a)a.onclick=function(e){e.stopPropagation();ir(atual()-1)};if(p)p.onclick=function(e){e.stopPropagation();ir(atual()+1)};
    return{ir:ir,atual:atual,trilho:t};
  }
  var mini=document.querySelectorAll('.miniaturas button');
  var g=montar(document.getElementById('gal'),function(k){mini.forEach(function(b,j){b.classList.toggle('on',j===k)})});
  mini.forEach(function(b){b.onclick=function(){g.ir(+b.dataset.i)}});
  var cx=document.getElementById('caixa'),z=montar(cx);
  function fechar(){cx.classList.remove('on');document.body.style.overflow=''}
  function abrir(k){cx.classList.add('on');document.body.style.overflow='hidden';requestAnimationFrame(function(){z.ir(k,false)})}
  if(g&&cx){g.trilho.querySelectorAll('button').forEach(function(b){b.onclick=function(){abrir(+b.dataset.i)}});
    document.querySelectorAll('.mosaico button').forEach(function(b){b.onclick=function(){abrir(+b.dataset.i)}});
    cx.querySelector('.fecha').onclick=fechar;
    document.addEventListener('keydown',function(e){if(!cx.classList.contains('on'))return;if(e.key==='Escape')fechar();if(e.key==='ArrowRight')z.ir(z.atual()+1);if(e.key==='ArrowLeft')z.ir(z.atual()-1)});}
})();
</script>`;
  const descricao = [precoTexto(i), caracteristicas(i, true).map(([, v, r]) => `${v}${r ? " " + r : ""}`).join(", "), i.local.curta].filter(Boolean).join(" · ");
  const pixelExtra = `fbq('track','ViewContent',{content_ids:['${esc(i.codigo)}'],content_name:${JSON.stringify(i.titulo).replace(/</g, "\\u003c")},content_type:'product'${i.valor ? `,value:${Number(i.valor)},currency:'BRL'` : ""}});`;
  return moldura({
    ctx, corpo, url, pixelExtra, classeBody: "tem-barra",
    titulo: `${i.titulo} — ${org.name}`,
    descricao,
    imagem: fotos[0] ? abs(base, fotos[0]) : (ctx.marca.logo ? abs(base, ctx.marca.logo) : null),
  });
}

export function paginaAviso(ctx, { titulo, texto, indexar = false }) {
  const { org, cfg } = ctx;
  const corpo = `<main class="wrap"><div class="aviso"><h1>${esc(titulo)}</h1><p>${esc(texto)}</p>
    <div class="acoes"><a class="btn btn-claro" href="/imoveis/${cfg.slug}">Ver outros imóveis</a>
    <a class="btn btn-marca" data-contato href="${esc(wa(cfg.whatsapp, `Olá! Vim pelo site da ${org.name} e gostaria de ajuda para encontrar um imóvel.`))}" target="_blank" rel="noopener">${ICO.wpp}Falar no WhatsApp</a></div></div></main>`;
  return moldura({ ctx, titulo: `${titulo} — ${org.name}`, descricao: texto, url: ctx.base + `/imoveis/${cfg.slug}`, corpo, indexar });
}

/* Site que não existe (ou está desligado): página neutra, sem marca de
   ninguém — não há imobiliária a quem atribuir o endereço. */
export function paginaInexistente() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Página não encontrada</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#F6F6F3;color:#16181D;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#5F6670;margin:0}</style></head>
<body><div><h1>Página não encontrada</h1><p>Confira o endereço com quem te enviou o link.</p></div></body></html>`;
}

export function paginaPausada(ctx) {
  const { org } = ctx;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(org.name)}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#F6F6F3;color:#16181D;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#5F6670;margin:0 0 20px}a{display:inline-block;background:${esc(ctx.marca.cor)};color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:12px}</style></head>
<body><div><h1>${esc(org.name)}</h1><p>Nosso site está passando por uma atualização. Enquanto isso, fale com a gente pelo WhatsApp.</p>
<a href="${esc(wa(ctx.cfg.whatsapp, `Olá! Tentei acessar o site da ${org.name} e gostaria de ver os imóveis disponíveis.`))}">Falar no WhatsApp</a></div></body></html>`;
}
