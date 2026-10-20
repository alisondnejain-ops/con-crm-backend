/* REDES SOCIAIS (20/10/2026, pedido do Ali: "conectar facebook e instagram na
   ferramenta, pra que possa inclusive programar posts e acompanhar o
   engajamento dessas redes").

   Mora no Marketing (mesma liberação), e só o gestor mexe — conectar a página
   já era só dele. A conexão é a MESMA do "Continuar com o Facebook" dos
   anúncios: a página fica em `meta_paginas`, e o Instagram profissional
   ligado a ela vem junto. Não há um segundo login.

   COMO O AGENDAMENTO FUNCIONA. O Instagram não tem agendamento pela API, e o
   do Facebook não se cancela pelo mesmo caminho. Por isso o ConHub guarda o
   post e PUBLICA ELE MESMO na hora marcada (`processarRedes`, batimento no
   server.js). Quem manda é o registro, não o relógio: servidor que estava
   fora do ar às 10h publica quando volta.

   Cada rede é uma linha em `redes_destinos`, com o próprio andamento:
   - Facebook publica numa chamada só (foto, várias fotos, vídeo, texto).
   - Instagram são dois passos: cria o "contêiner" (a Meta baixa a mídia do
     nosso endereço público) e, quando ele fica pronto, publica. Vídeo pode
     levar minutos; carrossel tem um contêiner por item antes do principal.

   NADA AQUI INVENTA NÚMERO. Métrica que a Meta não devolve (permissão que
   falta, métrica que ela aposentou) vai como `null` e a tela escreve "—". */
import { randomUUID } from "crypto";
import db from "../db.js";
import { graph, PERMISSOES_REDES } from "./meta.js";
import { abrir } from "./cofre.js";
import { liberado } from "./marketing.js";

export class ErroRedes extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export const REDES = ["facebook", "instagram"];
export const FORMATOS = ["post", "reels", "story"];
const LIMITE_TEXTO_IG = 2200, LIMITE_TEXTO_FB = 5000, LIMITE_HASHTAGS = 30, MAX_MIDIAS = 10;
const PRAZO_MAX = 90 * 86400000;
const PRAZO_PROCESSAMENTO = 30 * 60000;   // vídeo que o Instagram não termina em 30 min vira falha

/* O que cada coisa precisa. A tela usa esta lista para dizer o que falta. */
export const PRECISA = {
  publicar_facebook: ["pages_manage_posts"],
  publicar_instagram: ["instagram_basic", "instagram_content_publish"],
  engajamento_facebook: ["pages_read_engagement"],
  engajamento_instagram: ["instagram_basic", "instagram_manage_insights"],
  responder_facebook: ["pages_manage_engagement", "pages_read_user_content"],
  privada_facebook: ["pages_messaging"],
  responder_instagram: ["instagram_manage_comments"],
  privada_instagram: ["instagram_manage_messages"],
};

export function exigirLiberado(orgId) {
  if (!liberado(orgId)) throw new ErroRedes(403, "As redes sociais fazem parte do Marketing, que não está liberado para esta conta. Fale com o ConHub.");
}

const lista = (txt) => String(txt || "").split(",").map(x => x.trim()).filter(Boolean);
/* `null` = a página foi conectada antes de o ConHub anotar as permissões, e
   não dá para saber. Aí não se barra nada: o erro da Meta, se vier, diz. */
export function faltando(pagina, chave) {
  if (!pagina.permissoes) return [];
  const tem = new Set(lista(pagina.permissoes));
  return (PRECISA[chave] || []).filter(p => !tem.has(p));
}

export function paginaDaConta(orgId, pageId) {
  const p = db.prepare("SELECT * FROM meta_paginas WHERE page_id = ? AND org_id = ?").get(String(pageId || ""), orgId);
  if (!p) throw new ErroRedes(404, "Página não encontrada nesta conta. Conecte a página em Configurações → Anúncios do Meta.");
  return p;
}
function tokenDa(p) {
  const t = abrir(p.page_token);
  if (!t) throw new ErroRedes(409, "Não consegui abrir a conexão desta página. Conecte de novo em Configurações → Anúncios do Meta.");
  return t;
}

/* ===== Visão geral ===== */

export function visaoGeral(orgId) {
  const paginas = db.prepare(`SELECT page_id, nome, ig_id, ig_usuario, ig_foto, ig_seguidores, permissoes, avisos_campos,
      redes_atualizado_em, conectado_em FROM meta_paginas WHERE org_id = ? ORDER BY conectado_em`).all(orgId)
    .map(p => ({
      page_id: p.page_id, nome: p.nome, conectado_em: p.conectado_em,
      instagram: p.ig_id ? { id: p.ig_id, usuario: p.ig_usuario, foto: p.ig_foto, seguidores: p.ig_seguidores } : null,
      permissoes_conhecidas: !!p.permissoes,
      faltam: Object.fromEntries(Object.keys(PRECISA).map(k => [k, faltando(p, k)])),
      comentarios_ligados: lista(p.avisos_campos).includes("feed"),
    }));
  const contar = (st) => db.prepare("SELECT COUNT(*) n FROM redes_posts WHERE org_id = ? AND status = ?").get(orgId, st).n;
  return {
    paginas,
    permissoes_redes: PERMISSOES_REDES,
    contagens: { agendados: contar("agendado"), publicando: contar("publicando"), falharam: contar("falhou") + contar("parcial") },
  };
}

/* Relê o Instagram ligado à página (quem liga o Instagram depois de conectar
   não precisa reconectar a página). */
export async function atualizarPagina(orgId, pageId) {
  const p = paginaDaConta(orgId, pageId);
  let ig;
  try { ig = await (await import("./meta.js")).instagramDaPagina(p.page_id, tokenDa(p)); }
  catch (e) { throw new ErroRedes(502, "A Meta não deixou ler o Instagram desta página: " + traduzir(e)); }
  db.prepare(`UPDATE meta_paginas SET ig_id = ?, ig_usuario = ?, ig_foto = ?, ig_seguidores = ?, redes_atualizado_em = ? WHERE page_id = ?`)
    .run(ig?.id || null, ig?.usuario || null, ig?.foto || null, ig?.seguidores ?? null, Date.now(), p.page_id);
  return visaoGeral(orgId);
}

/* ===== Erros da Meta em português ===== */

export function traduzir(e) {
  const c = e?.codigo, sub = e?.subcodigo, msg = String(e?.message || "erro desconhecido");
  if (c === 190) return "a conexão com a página venceu ou foi desfeita no Facebook — conecte a página de novo";
  if (c === 10 || c === 200 || (c >= 200 && c < 300))
    return "a Meta não deu permissão para isso (" + msg.slice(0, 120) + "). Se a permissão já foi aprovada, conecte a página de novo";
  if (c === 4 || c === 17 || c === 32 || c === 613) return "a Meta pediu para esperar (limite de uso). O ConHub tenta de novo sozinho";
  if (sub === 2207026) return "o Instagram não aceitou o vídeo (formato, duração ou tamanho)";
  if (sub === 2207003 || sub === 2207020 || c === 9004)
    return "a Meta não conseguiu baixar a mídia do ConHub. Confira o armazenamento de arquivos em /integracoes";
  if (sub === 2207009) return "a proporção da foto não é aceita pelo Instagram (no feed vale de 4:5 em pé até 1,91:1 deitada)";
  if (sub === 2207042) return "esta conta do Instagram chegou ao limite de posts das últimas 24 horas";
  return (e?.titulo ? e.titulo + " — " : "") + msg.slice(0, 200);
}
const passageiro = (e) => e?.codigo === undefined || [1, 2, 4, 17, 32, 341, 613].includes(e?.codigo);

/* ===== Conferência do post ===== */

const contarHashtags = (t) => (String(t || "").match(/#[\p{L}\p{N}_]+/gu) || []).length;

function midiasLimpas(midias) {
  if (!Array.isArray(midias)) return [];
  return midias.slice(0, MAX_MIDIAS + 1).map(m => ({
    url: String(m?.url || ""), tipo: m?.tipo === "video" ? "video" : "foto",
    chave: m?.chave ? String(m.chave) : null,
    largura: Number.isFinite(+m?.largura) && +m.largura > 0 ? +m.largura : null,
    altura: Number.isFinite(+m?.altura) && +m.altura > 0 ? +m.altura : null,
  }));
}

export function conferirPost(orgId, dados, agora = Date.now()) {
  const p = paginaDaConta(orgId, dados.page_id);
  const redes = [...new Set((Array.isArray(dados.redes) ? dados.redes : []).map(String))].filter(r => REDES.includes(r));
  if (!redes.length) throw new ErroRedes(400, "Escolha onde publicar: Facebook, Instagram ou os dois.");
  const formato = FORMATOS.includes(dados.formato) ? dados.formato : "post";
  const texto = String(dados.texto || "").trim();
  const midias = midiasLimpas(dados.midias);
  const fotos = midias.filter(m => m.tipo === "foto"), videos = midias.filter(m => m.tipo === "video");

  if (midias.some(m => !/^https?:\/\//.test(m.url))) throw new ErroRedes(400, "Uma das mídias não tem endereço válido. Envie de novo.");
  if (midias.length > MAX_MIDIAS) throw new ErroRedes(400, `No máximo ${MAX_MIDIAS} fotos ou vídeos por post.`);
  if (redes.includes("instagram") && !p.ig_id)
    throw new ErroRedes(409, "Esta página não tem um Instagram profissional ligado. Ligue o Instagram à página no Facebook e clique em “Atualizar” aqui.");

  if (formato === "story") {
    if (redes.includes("facebook")) throw new ErroRedes(400, "Story só pode ser programado no Instagram.");
    if (midias.length !== 1) throw new ErroRedes(400, "O story leva uma foto ou um vídeo.");
  } else if (formato === "reels") {
    if (midias.length !== 1 || videos.length !== 1) throw new ErroRedes(400, "O Reels leva um vídeo.");
  } else {
    if (!texto && !midias.length) throw new ErroRedes(400, "Escreva o texto ou adicione uma foto ou vídeo.");
    if (redes.includes("instagram") && !midias.length) throw new ErroRedes(400, "O Instagram não aceita post só de texto. Adicione uma foto ou vídeo, ou publique só no Facebook.");
    if (redes.includes("facebook") && midias.length > 1 && videos.length)
      throw new ErroRedes(400, "No Facebook, um post com várias mídias só aceita fotos. Tire o vídeo ou publique só no Instagram.");
    // Um vídeo só, no Instagram, sai como Reels: a Meta não tem mais vídeo de feed pela API.
  }
  // Proporção da foto no feed do Instagram: fora de 4:5 a 1,91:1 a Meta recusa.
  if (redes.includes("instagram") && formato === "post") for (const [i, f] of fotos.entries()) {
    if (!f.largura || !f.altura) continue;
    const r = f.largura / f.altura;
    if (r < 0.79 || r > 1.92)
      throw new ErroRedes(400, `A foto ${midias.length > 1 ? i + 1 + " " : ""}é ${r < 1 ? "em pé" : "deitada"} demais para o feed do Instagram (vale de 4:5 em pé até 1,91:1 deitada). Use outra foto, recorte, ou publique como story.`);
  }
  if (redes.includes("instagram") && texto.length > LIMITE_TEXTO_IG) throw new ErroRedes(400, `O Instagram aceita até ${LIMITE_TEXTO_IG} letras na legenda (este tem ${texto.length}).`);
  if (texto.length > LIMITE_TEXTO_FB) throw new ErroRedes(400, `O texto passa de ${LIMITE_TEXTO_FB} letras.`);
  if (redes.includes("instagram") && contarHashtags(texto) > LIMITE_HASHTAGS) throw new ErroRedes(400, `O Instagram aceita até ${LIMITE_HASHTAGS} hashtags (este tem ${contarHashtags(texto)}).`);

  let quando = dados.agendar_para == null || dados.agendar_para === "" ? agora : Number(dados.agendar_para);
  if (!Number.isFinite(quando)) throw new ErroRedes(400, "Data e hora inválidas.");
  if (quando < agora - 60000) throw new ErroRedes(400, "Essa data e hora já passou.");
  if (quando > agora + PRAZO_MAX) throw new ErroRedes(400, "Dá para programar até 90 dias à frente.");
  quando = Math.max(quando, agora);

  for (const r of redes) {
    const f = faltando(p, `publicar_${r}`);
    if (f.length) throw new ErroRedes(409, `Para publicar no ${r === "facebook" ? "Facebook" : "Instagram"} falta a permissão ${f.join(", ")}. ` +
      "Se a Meta já aprovou, conecte a página de novo em Configurações → Anúncios do Meta; se ainda não, ela precisa ser aprovada na análise do app.");
  }
  return { pagina: p, redes, formato, texto, midias, quando };
}

/* ===== Posts ===== */

const lerJson = (t, padrao) => { try { return t ? JSON.parse(t) : padrao; } catch { return padrao; } };

function montarPost(row) {
  const destinos = db.prepare("SELECT * FROM redes_destinos WHERE post_id = ? ORDER BY rede").all(row.id);
  const pag = db.prepare("SELECT nome, ig_usuario FROM meta_paginas WHERE page_id = ?").get(row.page_id);
  const autor = row.criado_por ? db.prepare("SELECT name FROM users WHERE id = ?").get(row.criado_por) : null;
  return {
    id: row.id, page_id: row.page_id, pagina: pag?.nome || null, instagram: pag?.ig_usuario || null,
    formato: row.formato, texto: row.texto || "", midias: lerJson(row.midias_json, []),
    redes: lerJson(row.redes_json, []), agendar_para: row.agendar_para, status: row.status,
    criado_por: autor?.name || null, criado_em: row.criado_em,
    destinos: destinos.map(d => ({ rede: d.rede, status: d.status, link: d.link, erro: d.erro, publicado_em: d.publicado_em })),
  };
}

export function listarPosts(orgId, { status } = {}) {
  const linhas = status
    ? db.prepare("SELECT * FROM redes_posts WHERE org_id = ? AND status = ? ORDER BY agendar_para DESC LIMIT 200").all(orgId, status)
    : db.prepare("SELECT * FROM redes_posts WHERE org_id = ? ORDER BY agendar_para DESC LIMIT 200").all(orgId);
  return linhas.map(montarPost);
}

export function criarPost(orgId, userId, dados, agora = Date.now()) {
  const c = conferirPost(orgId, dados, agora);
  const id = "rp_" + randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO redes_posts (id,org_id,page_id,formato,texto,midias_json,redes_json,agendar_para,status,criado_por,criado_em,atualizado_em)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, orgId, c.pagina.page_id, c.formato, c.texto, JSON.stringify(c.midias), JSON.stringify(c.redes), c.quando, "agendado", userId, agora, agora);
    for (const r of c.redes)
      db.prepare(`INSERT INTO redes_destinos (id,post_id,org_id,rede,status,proxima_em) VALUES (?,?,?,?,?,?)`)
        .run("rd_" + randomUUID(), id, orgId, r, "pendente", c.quando);
  })();
  return montarPost(db.prepare("SELECT * FROM redes_posts WHERE id = ?").get(id));
}

function postDaConta(orgId, id) {
  const p = db.prepare("SELECT * FROM redes_posts WHERE id = ? AND org_id = ?").get(String(id || ""), orgId);
  if (!p) throw new ErroRedes(404, "Post não encontrado.");
  return p;
}
const aindaNaoSaiu = (postId) => db.prepare("SELECT COUNT(*) n FROM redes_destinos WHERE post_id = ? AND status != 'pendente'").get(postId).n === 0;

/* Editar só antes de começar a publicar: depois que uma rede já saiu, mudar
   o texto faria o Facebook e o Instagram dizerem coisas diferentes. */
export function editarPost(orgId, id, dados, agora = Date.now()) {
  const atual = postDaConta(orgId, id);
  if (atual.status !== "agendado" || !aindaNaoSaiu(id)) throw new ErroRedes(409, "Este post já começou a ser publicado e não pode mais ser editado.");
  const c = conferirPost(orgId, { ...dados, page_id: dados.page_id || atual.page_id }, agora);
  db.transaction(() => {
    db.prepare(`UPDATE redes_posts SET page_id=?, formato=?, texto=?, midias_json=?, redes_json=?, agendar_para=?, atualizado_em=? WHERE id=?`)
      .run(c.pagina.page_id, c.formato, c.texto, JSON.stringify(c.midias), JSON.stringify(c.redes), c.quando, agora, id);
    db.prepare("DELETE FROM redes_destinos WHERE post_id = ?").run(id);
    for (const r of c.redes)
      db.prepare(`INSERT INTO redes_destinos (id,post_id,org_id,rede,status,proxima_em) VALUES (?,?,?,?,?,?)`)
        .run("rd_" + randomUUID(), id, orgId, r, "pendente", c.quando);
  })();
  apagarMidiasSoltas(lerJson(atual.midias_json, []), c.midias);
  return montarPost(db.prepare("SELECT * FROM redes_posts WHERE id = ?").get(id));
}

/* Cancelar o que ainda não saiu. O que já foi publicado continua no ar — o
   ConHub não apaga post do Facebook nem do Instagram. */
export function cancelarPost(orgId, id) {
  const p = postDaConta(orgId, id);
  if (!["agendado", "publicando"].includes(p.status)) throw new ErroRedes(409, "Só dá para cancelar post que ainda não foi publicado.");
  const pendentes = db.prepare("UPDATE redes_destinos SET status = 'cancelado' WHERE post_id = ? AND status = 'pendente'").run(id).changes;
  if (!pendentes && p.status === "publicando") throw new ErroRedes(409, "A publicação já começou. Espere terminar.");
  recalcularStatus(id);
  return montarPost(db.prepare("SELECT * FROM redes_posts WHERE id = ?").get(id));
}

// Apagar do ConHub (o histórico). Não mexe no que já está no ar.
export function apagarPost(orgId, id) {
  const p = postDaConta(orgId, id);
  if (["agendado", "publicando"].includes(p.status) && db.prepare(
    "SELECT COUNT(*) n FROM redes_destinos WHERE post_id = ? AND status IN ('pendente','processando')").get(id).n)
    throw new ErroRedes(409, "Cancele o post antes de apagar.");
  db.prepare("DELETE FROM redes_destinos WHERE post_id = ?").run(id);
  db.prepare("DELETE FROM redes_posts WHERE id = ?").run(id);
  // Arquivo que só este post usava: já foi publicado (a Meta guardou a cópia dela) ou nunca vai ser.
  apagarMidiasSoltas(lerJson(p.midias_json, []), []);
  return { ok: true };
}

async function apagarMidiasSoltas(antes, depois) {
  const ficam = new Set(depois.map(m => m.chave).filter(Boolean));
  const { apagar } = await import("./storage.js");
  for (const m of antes) if (m.chave && String(m.chave).startsWith("redes/") && !ficam.has(m.chave)) {
    const outro = db.prepare("SELECT COUNT(*) n FROM redes_posts WHERE midias_json LIKE ?").get(`%${m.chave}%`).n;
    if (!outro) await apagar(m.chave).catch(() => {});
  }
}

function recalcularStatus(postId) {
  const ds = db.prepare("SELECT status FROM redes_destinos WHERE post_id = ?").all(postId).map(d => d.status);
  let st;
  if (ds.every(s => s === "cancelado")) st = "cancelado";
  else if (ds.some(s => s === "pendente" || s === "processando")) st = ds.some(s => s !== "pendente" && s !== "cancelado") ? "publicando" : "agendado";
  else if (ds.filter(s => s !== "cancelado").every(s => s === "publicado")) st = "publicado";
  else if (ds.some(s => s === "publicado")) st = "parcial";
  else st = "falhou";
  db.prepare("UPDATE redes_posts SET status = ?, atualizado_em = ? WHERE id = ?").run(st, Date.now(), postId);
  return st;
}

/* ===== A publicação ===== */

async function publicarFacebook(post, pagina, token) {
  const midias = lerJson(post.midias_json, []);
  const texto = post.texto || "";
  const pg = pagina.page_id;
  let id;
  if (!midias.length) {
    id = (await graph(`${pg}/feed`, { metodo: "POST", token, params: { message: texto } })).id;
  } else if (midias.length === 1 && midias[0].tipo === "video") {
    const r = await graph(`${pg}/videos`, { metodo: "POST", token, params: { file_url: midias[0].url, description: texto } });
    return { id: r.id, link: `https://www.facebook.com/${pg}/videos/${r.id}` };
  } else if (midias.length === 1) {
    const r = await graph(`${pg}/photos`, { metodo: "POST", token, params: { url: midias[0].url, message: texto } });
    id = r.post_id || r.id;
  } else {
    const anexos = [];
    for (const m of midias) anexos.push((await graph(`${pg}/photos`, { metodo: "POST", token, params: { url: m.url, published: false } })).id);
    const params = { message: texto };
    anexos.forEach((fbid, i) => { params[`attached_media[${i}]`] = { media_fbid: fbid }; });
    id = (await graph(`${pg}/feed`, { metodo: "POST", token, params })).id;
  }
  let link = `https://www.facebook.com/${id}`;
  try { const r = await graph(String(id), { token, params: { fields: "permalink_url" } }); if (r.permalink_url) link = r.permalink_url; } catch {}
  return { id, link };
}

const paramsDeMidia = (m) => m.tipo === "video" ? { video_url: m.url } : { image_url: m.url };

// Instagram, um passo por vez. Devolve o que mudou na linha do destino.
async function passoInstagram(d, post, pagina, token, agora) {
  const ig = pagina.ig_id;
  const midias = lerJson(post.midias_json, []);
  const texto = post.texto || "";
  if (!d.etapa) {
    if (post.formato === "story") {
      const c = await graph(`${ig}/media`, { metodo: "POST", token, params: { media_type: "STORIES", ...paramsDeMidia(midias[0]) } });
      return { etapa: "aguardar", container_id: c.id, proxima_em: agora + 5000 };
    }
    if (midias.length === 1 && midias[0].tipo === "video") {
      const c = await graph(`${ig}/media`, { metodo: "POST", token,
        params: { media_type: "REELS", video_url: midias[0].url, caption: texto, share_to_feed: true } });
      return { etapa: "aguardar", container_id: c.id, proxima_em: agora + 15000 };
    }
    if (midias.length === 1) {
      const c = await graph(`${ig}/media`, { metodo: "POST", token, params: { image_url: midias[0].url, caption: texto } });
      return { etapa: "aguardar", container_id: c.id, proxima_em: agora + 3000 };
    }
    const filhos = [];
    for (const m of midias) {
      const params = m.tipo === "video" ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: true } : { image_url: m.url, is_carousel_item: true };
      filhos.push((await graph(`${ig}/media`, { metodo: "POST", token, params })).id);
    }
    return { etapa: "filhos", filhos_json: JSON.stringify(filhos), proxima_em: agora + 5000 };
  }
  if (d.etapa === "filhos") {
    const filhos = lerJson(d.filhos_json, []);
    for (const f of filhos) {
      const s = await graph(String(f), { token, params: { fields: "status_code,status" } });
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") return { falhou: "o Instagram recusou um item do carrossel" + (s.status ? `: ${s.status}` : "") };
      if (s.status_code !== "FINISHED") return { proxima_em: agora + 15000 };
    }
    const c = await graph(`${ig}/media`, { metodo: "POST", token, params: { media_type: "CAROUSEL", children: filhos.join(","), caption: texto } });
    return { etapa: "aguardar", container_id: c.id, proxima_em: agora + 5000 };
  }
  // aguardar: o contêiner está pronto?
  const s = await graph(String(d.container_id), { token, params: { fields: "status_code,status" } });
  if (s.status_code === "ERROR" || s.status_code === "EXPIRED")
    return { falhou: "o Instagram não conseguiu processar a mídia" + (s.status ? `: ${s.status}` : "") };
  if (s.status_code && s.status_code !== "FINISHED") return { proxima_em: agora + 15000 };
  const pub = await graph(`${ig}/media_publish`, { metodo: "POST", token, params: { creation_id: d.container_id } });
  let link = null;
  try { link = (await graph(String(pub.id), { token, params: { fields: "permalink" } })).permalink || null; } catch {}
  return { publicado: { id: pub.id, link } };
}

let rodando = false;
/* Um ciclo do agendador. Pega o que está na hora, faz UM passo de cada, e
   devolve quantos passos deu. Nunca lança. */
export async function processarRedes(agora = Date.now(), { max = 6 } = {}) {
  if (rodando) return 0;
  rodando = true;
  let passos = 0;
  try {
    const fila = db.prepare(`SELECT d.* FROM redes_destinos d JOIN redes_posts p ON p.id = d.post_id
      WHERE d.status IN ('pendente','processando') AND d.proxima_em <= ? AND p.status IN ('agendado','publicando')
      ORDER BY d.proxima_em LIMIT ?`).all(agora, max);
    for (const d of fila) {
      passos++;
      const post = db.prepare("SELECT * FROM redes_posts WHERE id = ?").get(d.post_id);
      const falhar = (motivo) => db.prepare("UPDATE redes_destinos SET status='falhou', erro=?, proxima_em=NULL WHERE id=?").run(String(motivo).slice(0, 400), d.id);
      try {
        // Conta sem o Marketing não publica (a liberação pode ter caído depois de programar).
        if (!liberado(d.org_id)) { falhar("o Marketing desta conta não está mais liberado"); continue; }
        const pagina = db.prepare("SELECT * FROM meta_paginas WHERE page_id = ? AND org_id = ?").get(post.page_id, d.org_id);
        if (!pagina) { falhar("a página foi desconectada do ConHub"); continue; }
        const token = abrir(pagina.page_token);
        if (!token) { falhar("não consegui abrir a conexão da página — conecte de novo"); continue; }
        if (d.status === "pendente") db.prepare("UPDATE redes_destinos SET status='processando', iniciado_em=? WHERE id=?").run(agora, d.id);
        // Trava: o próximo ciclo não pega a mesma linha enquanto este passo roda.
        db.prepare("UPDATE redes_destinos SET proxima_em=? WHERE id=?").run(agora + 120000, d.id);

        if (d.rede === "facebook") {
          const r = await publicarFacebook(post, pagina, token);
          db.prepare("UPDATE redes_destinos SET status='publicado', publicado_id=?, link=?, erro=NULL, publicado_em=?, proxima_em=NULL WHERE id=?")
            .run(String(r.id), r.link, Date.now(), d.id);
        } else {
          if (!pagina.ig_id) { falhar("a página não tem mais um Instagram ligado"); continue; }
          if (d.iniciado_em && agora - d.iniciado_em > PRAZO_PROCESSAMENTO) { falhar("o Instagram não terminou de processar a mídia em 30 minutos"); continue; }
          const r = await passoInstagram(d, post, pagina, token, agora);
          if (r.falhou) falhar(r.falhou);
          else if (r.publicado) db.prepare("UPDATE redes_destinos SET status='publicado', publicado_id=?, link=?, erro=NULL, publicado_em=?, proxima_em=NULL WHERE id=?")
            .run(String(r.publicado.id), r.publicado.link, Date.now(), d.id);
          else db.prepare(`UPDATE redes_destinos SET etapa=COALESCE(?,etapa), container_id=COALESCE(?,container_id),
              filhos_json=COALESCE(?,filhos_json), proxima_em=? WHERE id=?`)
            .run(r.etapa || null, r.container_id || null, r.filhos_json || null, r.proxima_em, d.id);
        }
      } catch (e) {
        const tentativas = (d.tentativas || 0) + 1;
        if (passageiro(e) && tentativas < 4) {
          // Rede caiu ou a Meta pediu para esperar: tenta de novo, cada vez mais tarde.
          db.prepare("UPDATE redes_destinos SET tentativas=?, erro=?, proxima_em=? WHERE id=?")
            .run(tentativas, traduzir(e), agora + tentativas * 5 * 60000, d.id);
        } else falhar(traduzir(e));
        console.error(`[redes] ${d.rede} do post ${d.post_id}:`, e.message);
      }
      recalcularStatus(d.post_id);
    }
  } catch (e) {
    console.error("[redes] erro no ciclo:", e.message);
  } finally { rodando = false; }
  return passos;
}

/* ===== Engajamento ===== */

const DIA = 86400000;
const diaDe = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);   // dia de Brasília

function anotarSeguidores(orgId, pageId, rede, n, agora) {
  if (!Number.isFinite(n)) return;
  db.prepare(`INSERT INTO redes_seguidores (org_id,page_id,rede,dia,seguidores) VALUES (?,?,?,?,?)
              ON CONFLICT(org_id,page_id,rede,dia) DO UPDATE SET seguidores = excluded.seguidores`)
    .run(orgId, pageId, rede, diaDe(agora), n);
}
function crescimento(orgId, pageId, rede, atual, agora) {
  const base = db.prepare(`SELECT dia, seguidores FROM redes_seguidores WHERE org_id=? AND page_id=? AND rede=? AND dia >= ? AND dia < ?
    ORDER BY dia LIMIT 1`).get(orgId, pageId, rede, diaDe(agora - 30 * DIA), diaDe(agora));
  if (!base || !Number.isFinite(atual) || base.seguidores == null) return null;
  return { desde: base.dia, valor: atual - base.seguidores };
}

// Pede cada métrica e devolve só as que a Meta respondeu.
async function metricas(objId, nomes, token) {
  const out = {};
  try {
    const r = await graph(`${objId}/insights`, { token, params: { metric: nomes.join(",") } });
    for (const m of r.data || []) out[m.name] = valorDe(m);
    return out;
  } catch {
    for (const n of nomes) {
      try {
        const r = await graph(`${objId}/insights`, { token, params: { metric: n } });
        for (const m of r.data || []) out[m.name] = valorDe(m);
      } catch {}
    }
    return out;
  }
}
function valorDe(m) {
  if (m.total_value && Number.isFinite(m.total_value.value)) return m.total_value.value;
  const v = (m.values || []).at(-1)?.value;
  return Number.isFinite(v) ? v : null;
}

async function engajamentoFacebook(orgId, p, token, agora) {
  const erros = [];
  let conta = null, posts = [];
  try {
    const r = await graph(p.page_id, { token, params: { fields: "name,followers_count,fan_count,picture{url}" } });
    const seg = Number.isFinite(r.followers_count) ? r.followers_count : (Number.isFinite(r.fan_count) ? r.fan_count : null);
    anotarSeguidores(orgId, p.page_id, "facebook", seg, agora);
    conta = { rede: "facebook", nome: r.name || p.nome, foto: r.picture?.data?.url || null, seguidores: seg,
      crescimento: crescimento(orgId, p.page_id, "facebook", seg, agora) };
  } catch (e) { erros.push("Facebook (página): " + traduzir(e)); }
  try {
    const r = await graph(`${p.page_id}/published_posts`, { token, params: {
      fields: "id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      limit: 20 } });
    posts = (r.data || []).map(x => ({
      rede: "facebook", id: String(x.id), texto: String(x.message || "").slice(0, 160), data: Date.parse(x.created_time) || null,
      link: x.permalink_url || `https://www.facebook.com/${x.id}`, imagem: x.full_picture || null,
      curtidas: x.reactions?.summary?.total_count ?? null, comentarios: x.comments?.summary?.total_count ?? null,
      compartilhamentos: x.shares?.count ?? (x.shares ? null : 0), salvos: null, visualizacoes: null, alcance: null,
    }));
  } catch (e) { erros.push("Facebook (posts): " + traduzir(e)); }
  return { conta, posts, erros };
}

async function engajamentoInstagram(orgId, p, token, agora) {
  const erros = [];
  let conta = null, posts = [];
  try {
    const r = await graph(p.ig_id, { token, params: { fields: "username,profile_picture_url,followers_count,media_count" } });
    const seg = Number.isFinite(r.followers_count) ? r.followers_count : null;
    anotarSeguidores(orgId, p.page_id, "instagram", seg, agora);
    db.prepare("UPDATE meta_paginas SET ig_usuario = COALESCE(?, ig_usuario), ig_foto = COALESCE(?, ig_foto), ig_seguidores = ? WHERE page_id = ?")
      .run(r.username || null, r.profile_picture_url || null, seg, p.page_id);
    conta = { rede: "instagram", nome: r.username ? "@" + r.username : (p.ig_usuario ? "@" + p.ig_usuario : "Instagram"),
      foto: r.profile_picture_url || p.ig_foto || null, seguidores: seg, posts: r.media_count ?? null,
      crescimento: crescimento(orgId, p.page_id, "instagram", seg, agora) };
  } catch (e) { erros.push("Instagram (conta): " + traduzir(e)); }
  try {
    const r = await graph(`${p.ig_id}/media`, { token, params: {
      fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url,media_url", limit: 20 } });
    posts = (r.data || []).map(x => ({
      rede: "instagram", id: String(x.id), texto: String(x.caption || "").slice(0, 160), data: Date.parse(x.timestamp) || null,
      link: x.permalink || null, imagem: x.thumbnail_url || (x.media_type !== "VIDEO" ? x.media_url : null) || null,
      tipo: x.media_product_type === "REELS" ? "reels" : x.media_type === "CAROUSEL_ALBUM" ? "carrossel" : null,
      curtidas: Number.isFinite(x.like_count) ? x.like_count : null, comentarios: Number.isFinite(x.comments_count) ? x.comments_count : null,
      compartilhamentos: null, salvos: null, visualizacoes: null, alcance: null,
    }));
    // Alcance, salvos, compartilhamentos e visualizações dos 12 mais recentes.
    await Promise.all(posts.slice(0, 12).map(async (x) => {
      const m = await metricas(x.id, ["reach", "saved", "shares", "views"], token);
      x.alcance = m.reach ?? null; x.salvos = m.saved ?? null; x.compartilhamentos = m.shares ?? null; x.visualizacoes = m.views ?? null;
    }));
  } catch (e) { erros.push("Instagram (posts): " + traduzir(e)); }
  return { conta, posts, erros };
}

const CACHE_MS = 15 * 60000;
export async function engajamento(orgId, pageId, { atualizar = false } = {}, agora = Date.now()) {
  const p = paginaDaConta(orgId, pageId);
  const chave = `engajamento:${p.page_id}`;
  if (!atualizar) {
    const c = db.prepare("SELECT json, em FROM redes_cache WHERE org_id = ? AND chave = ?").get(orgId, chave);
    if (c && agora - c.em < CACHE_MS) return { ...lerJson(c.json, {}), em: c.em, do_cache: true };
  }
  const token = tokenDa(p);
  const [fb, ig] = await Promise.all([
    engajamentoFacebook(orgId, p, token, agora),
    p.ig_id ? engajamentoInstagram(orgId, p, token, agora) : Promise.resolve({ conta: null, posts: [], erros: [] }),
  ]);
  // Quais vieram do ConHub (para a tela marcar "programado aqui").
  const nossos = new Set(db.prepare("SELECT publicado_id FROM redes_destinos WHERE org_id = ? AND publicado_id IS NOT NULL").all(orgId).map(x => x.publicado_id));
  const posts = [...fb.posts, ...ig.posts].map(x => ({ ...x, do_conhub: nossos.has(x.id) }))
    .sort((a, b) => (b.data || 0) - (a.data || 0));
  const ultimos30 = posts.filter(x => x.data && agora - x.data <= 30 * DIA);
  const soma = (campo, rede) => {
    const vals = ultimos30.filter(x => x.rede === rede && x[campo] != null).map(x => x[campo]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const resumo = Object.fromEntries(REDES.map(rede => {
    const qtd = ultimos30.filter(x => x.rede === rede).length;
    const interacoes = ["curtidas", "comentarios", "compartilhamentos", "salvos"].map(c => soma(c, rede)).filter(v => v != null);
    const total = interacoes.length ? interacoes.reduce((a, b) => a + b, 0) : null;
    return [rede, { posts: qtd, curtidas: soma("curtidas", rede), comentarios: soma("comentarios", rede),
      compartilhamentos: soma("compartilhamentos", rede), salvos: soma("salvos", rede), alcance: soma("alcance", rede),
      interacoes: total, media_por_post: total != null && qtd ? Math.round(total / qtd * 10) / 10 : null }];
  }));
  const out = { contas: [fb.conta, ig.conta].filter(Boolean), posts, resumo, erros: [...fb.erros, ...ig.erros], tem_instagram: !!p.ig_id };
  db.prepare(`INSERT INTO redes_cache (org_id,chave,json,em) VALUES (?,?,?,?)
              ON CONFLICT(org_id,chave) DO UPDATE SET json = excluded.json, em = excluded.em`).run(orgId, chave, JSON.stringify(out), agora);
  return { ...out, em: agora, do_cache: false };
}
