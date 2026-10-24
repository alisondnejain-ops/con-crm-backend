/* AUTOMAÇÃO DE COMENTÁRIOS, estilo ManyChat (20/10/2026, pedido do Ali:
   "liberar para fazer automação de posts igual o manychat").

   A pessoa comenta a palavra ("EU QUERO", "valor", "info") num post da
   página ou do Instagram, e na hora recebe:
   - uma RESPOSTA PÚBLICA no comentário ("Te mandei no direct! 📩"), escolhida
     ao acaso entre as variações escritas — a mesma frase repetida cem vezes é
     o que a Meta marca como robô;
   - uma MENSAGEM NO PRIVADO (a "resposta privada" da Meta: uma por
     comentário, até 7 dias depois dele). Com `{whatsapp}` ela leva o link do
     WhatsApp da imobiliária — e é por aí que a conversa vira lead no CRM, pelo
     caminho de sempre (catraca, funil, ficha).

   As respostas que a pessoa der no direct NÃO entram no CRM (não há caixa de
   Instagram aqui): o direct serve para levar ao WhatsApp. A tela diz isso.

   As travas: cada comentário é atendido uma vez só (o id é a chave — a Meta
   pode avisar duas vezes); comentário da própria página não dispara (senão a
   resposta pública dispararia a si mesma); conta sem Marketing liberado não
   responde; e no máximo 300 respostas por hora por conta — um post viral não
   pode virar uma enxurrada que a Meta pune bloqueando a página. */
import { randomUUID } from "crypto";
import db from "../db.js";
import { graph } from "./meta.js";
import { abrir } from "./cofre.js";
import { liberado } from "./marketing.js";
import { ErroRedes, paginaDaConta, faltando, traduzir, REDES } from "./redes.js";

const MAX_PALAVRAS = 20, MAX_RESPOSTAS = 5, MAX_POSTS = 30, TETO_HORA = 300;

const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const lerJson = (t, padrao) => { try { return t ? JSON.parse(t) : padrao; } catch { return padrao; } };

/* A palavra vale inteira, sem olhar maiúscula nem acento: "valor" acha
   "Qual o VALOR?" mas não "valorizou". */
export function palavraQueBate(texto, palavras) {
  const t = " " + semAcento(texto).replace(/[^a-z0-9]+/g, " ") + " ";
  if (!palavras.length) return "";
  for (const p of palavras) {
    const n = semAcento(p).replace(/[^a-z0-9]+/g, " ").trim();
    if (n && t.includes(" " + n + " ")) return p;
  }
  return null;
}

function limpar(dados, orgId) {
  const p = paginaDaConta(orgId, dados.page_id);
  const nome = String(dados.nome || "").trim().slice(0, 60);
  if (!nome) throw new ErroRedes(400, "Dê um nome à automação (ex.: “Lançamento Horizon”).");
  const redes = [...new Set((Array.isArray(dados.redes) ? dados.redes : []).map(String))].filter(r => REDES.includes(r));
  if (!redes.length) throw new ErroRedes(400, "Escolha em que rede ela vale: Facebook, Instagram ou as duas.");
  if (redes.includes("instagram") && !p.ig_id) throw new ErroRedes(409, "Esta página não tem um Instagram profissional ligado.");
  const palavras = [...new Set((Array.isArray(dados.palavras) ? dados.palavras : []).map(x => String(x || "").trim().slice(0, 40)).filter(Boolean))];
  if (palavras.length > MAX_PALAVRAS) throw new ErroRedes(400, `No máximo ${MAX_PALAVRAS} palavras.`);
  const respostas = (Array.isArray(dados.respostas) ? dados.respostas : []).map(x => String(x || "").trim()).filter(Boolean);
  if (respostas.length > MAX_RESPOSTAS) throw new ErroRedes(400, `No máximo ${MAX_RESPOSTAS} variações de resposta.`);
  if (respostas.some(x => x.length > 300)) throw new ErroRedes(400, "Cada resposta pública vai até 300 letras.");
  const mensagem = String(dados.mensagem_privada || "").trim();
  if (mensagem.length > 1000) throw new ErroRedes(400, "A mensagem no privado vai até 1.000 letras.");
  if (!respostas.length && !mensagem) throw new ErroRedes(400, "Escreva a resposta pública, a mensagem no privado, ou as duas.");
  const posts = (Array.isArray(dados.posts) ? dados.posts : []).slice(0, MAX_POSTS + 1)
    .map(x => ({ id: String(x?.id || ""), rede: REDES.includes(x?.rede) ? x.rede : null, texto: String(x?.texto || "").slice(0, 80) }))
    .filter(x => x.id && x.rede);
  if (posts.length > MAX_POSTS) throw new ErroRedes(400, `No máximo ${MAX_POSTS} posts por automação.`);
  return { pagina: p, nome, redes, palavras, respostas, mensagem, posts, ativo: dados.ativo === false ? 0 : 1 };
}

function montar(r) {
  const p = db.prepare("SELECT * FROM meta_paginas WHERE page_id = ?").get(r.page_id) || {};
  const redes = lerJson(r.redes_json, []);
  const conta = (sql, ...a) => db.prepare(`SELECT COUNT(*) n FROM redes_comentarios WHERE regra_id = ? ${sql}`).get(r.id, ...a).n;
  const desde = Date.now() - 7 * 86400000;
  const ultimoErro = db.prepare("SELECT erro, em FROM redes_comentarios WHERE regra_id = ? AND erro IS NOT NULL ORDER BY em DESC LIMIT 1").get(r.id);
  const mensagem = r.mensagem_privada || "", respostas = lerJson(r.respostas_json, []);
  const faltam = [...new Set(redes.flatMap(rede => [
    ...(respostas.length ? faltando(p, `responder_${rede}`) : []),
    ...(mensagem ? faltando(p, `privada_${rede}`) : []),
  ]))];
  return {
    id: r.id, page_id: r.page_id, nome: r.nome, redes, posts: lerJson(r.posts_json, []), palavras: lerJson(r.palavras_json, []),
    respostas, mensagem_privada: mensagem, ativo: !!r.ativo, criado_em: r.criado_em,
    faltam_permissoes: faltam,
    comentarios_ligados: String(p.avisos_campos || "").split(",").includes("feed"),
    numeros: {
      total: conta(""), semana: conta("AND em >= ?", desde),
      publicas: conta("AND publica = 'ok'"), privadas: conta("AND privada = 'ok'"), falhas: conta("AND erro IS NOT NULL"),
    },
    ultimo_erro: ultimoErro ? { erro: ultimoErro.erro, em: ultimoErro.em } : null,
  };
}

export const listarRegras = (orgId) =>
  db.prepare("SELECT * FROM redes_regras WHERE org_id = ? ORDER BY criado_em").all(orgId).map(montar);

export function criarRegra(orgId, userId, dados) {
  const c = limpar(dados, orgId);
  const id = "rr_" + randomUUID(), agora = Date.now();
  db.prepare(`INSERT INTO redes_regras (id,org_id,page_id,nome,redes_json,posts_json,palavras_json,respostas_json,mensagem_privada,ativo,criado_por,criado_em,atualizado_em)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, c.pagina.page_id, c.nome, JSON.stringify(c.redes), JSON.stringify(c.posts), JSON.stringify(c.palavras),
      JSON.stringify(c.respostas), c.mensagem || null, c.ativo, userId, agora, agora);
  return montar(db.prepare("SELECT * FROM redes_regras WHERE id = ?").get(id));
}

function regraDaConta(orgId, id) {
  const r = db.prepare("SELECT * FROM redes_regras WHERE id = ? AND org_id = ?").get(String(id || ""), orgId);
  if (!r) throw new ErroRedes(404, "Automação não encontrada.");
  return r;
}

export function editarRegra(orgId, id, dados) {
  const atual = regraDaConta(orgId, id);
  // Ligar/desligar sozinho não exige o resto do formulário.
  if (Object.keys(dados || {}).length === 1 && "ativo" in dados) {
    db.prepare("UPDATE redes_regras SET ativo = ?, atualizado_em = ? WHERE id = ?").run(dados.ativo ? 1 : 0, Date.now(), id);
    return montar(db.prepare("SELECT * FROM redes_regras WHERE id = ?").get(id));
  }
  const c = limpar({ ...dados, page_id: dados.page_id || atual.page_id }, orgId);
  db.prepare(`UPDATE redes_regras SET page_id=?, nome=?, redes_json=?, posts_json=?, palavras_json=?, respostas_json=?,
      mensagem_privada=?, ativo=?, atualizado_em=? WHERE id=?`)
    .run(c.pagina.page_id, c.nome, JSON.stringify(c.redes), JSON.stringify(c.posts), JSON.stringify(c.palavras),
      JSON.stringify(c.respostas), c.mensagem || null, c.ativo, Date.now(), id);
  return montar(db.prepare("SELECT * FROM redes_regras WHERE id = ?").get(id));
}

// O histórico de comentários atendidos fica (é o número da automação), sem a regra.
export function apagarRegra(orgId, id) {
  regraDaConta(orgId, id);
  db.prepare("DELETE FROM redes_regras WHERE id = ?").run(id);
  return { ok: true };
}

export function comentariosDaRegra(orgId, id) {
  regraDaConta(orgId, id);
  return db.prepare("SELECT rede, autor, palavra, publica, privada, erro, em FROM redes_comentarios WHERE regra_id = ? ORDER BY em DESC LIMIT 50").all(id);
}

/* O link do WhatsApp da imobiliária para `{whatsapp}`: o número do site (que
   a imobiliária escolheu mostrar em público) ou o da linha da casa. */
export function linkDoWhatsapp(orgId) {
  const site = db.prepare("SELECT whatsapp FROM sites WHERE org_id = ?").get(orgId);
  const casa = db.prepare("SELECT wa_number FROM canais WHERE org_id = ? AND tipo = 'imobiliaria' LIMIT 1").get(orgId);
  let n = String(site?.whatsapp || casa?.wa_number || "").replace(/\D/g, "");
  if (!n) return null;
  if (n.length <= 11) n = "55" + n;
  return `https://wa.me/${n}`;
}

function preencher(texto, { nome, orgId }) {
  let t = String(texto || "").replaceAll("{nome}", nome || "");
  if (t.includes("{whatsapp}")) t = t.replaceAll("{whatsapp}", linkDoWhatsapp(orgId) || "");
  return t.replace(/[ \t]+\n/g, "\n").trim();
}

/* Um comentário que chegou pelo webhook. Nunca lança.
   `c`: { rede, orgId?, pageId?, igId?, comentarioId, postId, texto, autorId, autorNome } */
export async function comentarioRecebido(c) {
  try {
    const pagina = c.rede === "instagram"
      ? db.prepare("SELECT * FROM meta_paginas WHERE ig_id = ?").get(String(c.igId || ""))
      : db.prepare("SELECT * FROM meta_paginas WHERE page_id = ?").get(String(c.pageId || ""));
    if (!pagina || !c.comentarioId) return { resultado: "sem_pagina" };
    // Comentário da própria página/Instagram (inclusive a nossa resposta pública).
    if (c.autorId && (String(c.autorId) === pagina.page_id || String(c.autorId) === String(pagina.ig_id || ""))) return { resultado: "proprio" };
    const orgId = pagina.org_id;
    if (!liberado(orgId)) return { resultado: "sem_marketing" };
    if (db.prepare("SELECT 1 FROM redes_comentarios WHERE id = ?").get(String(c.comentarioId))) return { resultado: "repetido" };

    const regras = db.prepare("SELECT * FROM redes_regras WHERE org_id = ? AND page_id = ? AND ativo = 1 ORDER BY criado_em").all(orgId, pagina.page_id);
    let regra = null, palavra = null;
    for (const r of regras) {
      if (!lerJson(r.redes_json, []).includes(c.rede)) continue;
      const posts = lerJson(r.posts_json, []);
      if (posts.length && !posts.some(p => p.rede === c.rede && String(p.id) === String(c.postId))) continue;
      const bate = palavraQueBate(c.texto, lerJson(r.palavras_json, []));
      if (bate === null) continue;
      regra = r; palavra = bate || null; break;
    }
    if (!regra) return { resultado: "nenhuma_regra" };

    const agora = Date.now();
    // Grava primeiro: é a trava contra o mesmo comentário avisado duas vezes.
    const ins = db.prepare(`INSERT OR IGNORE INTO redes_comentarios (id,org_id,regra_id,rede,post_id,autor,palavra,em) VALUES (?,?,?,?,?,?,?,?)`)
      .run(String(c.comentarioId), orgId, regra.id, c.rede, String(c.postId || ""), String(c.autorNome || "").slice(0, 80) || null, palavra, agora);
    if (!ins.changes) return { resultado: "repetido" };
    const naHora = db.prepare("SELECT COUNT(*) n FROM redes_comentarios WHERE org_id = ? AND em >= ? AND (publica = 'ok' OR privada = 'ok')").get(orgId, agora - 3600000).n;
    if (naHora >= TETO_HORA) {
      db.prepare("UPDATE redes_comentarios SET erro = ? WHERE id = ?").run(`limite de ${TETO_HORA} respostas por hora atingido — este comentário ficou sem resposta`, String(c.comentarioId));
      return { resultado: "teto" };
    }

    const token = abrir(pagina.page_token);
    if (!token) {
      db.prepare("UPDATE redes_comentarios SET erro = ? WHERE id = ?").run("não consegui abrir a conexão da página — conecte de novo", String(c.comentarioId));
      return { resultado: "erro" };
    }
    const nome = c.rede === "instagram" ? (c.autorNome || "") : String(c.autorNome || "").split(/\s+/)[0];
    const erros = [];
    let publica = null, privada = null;
    const respostas = lerJson(regra.respostas_json, []);
    if (respostas.length) {
      const texto = preencher(respostas[Math.floor(Math.random() * respostas.length)], { nome, orgId });
      try {
        await graph(c.rede === "instagram" ? `${c.comentarioId}/replies` : `${c.comentarioId}/comments`,
          { metodo: "POST", token, params: { message: texto } });
        publica = "ok";
      } catch (e) { publica = "erro"; erros.push("resposta pública: " + traduzir(e)); }
    }
    if (regra.mensagem_privada) {
      const texto = preencher(regra.mensagem_privada, { nome, orgId });
      try {
        await graph(`${pagina.page_id}/messages`, { metodo: "POST", token,
          params: { recipient: { comment_id: String(c.comentarioId) }, message: { text: texto } } });
        privada = "ok";
      } catch (e) { privada = "erro"; erros.push("mensagem no privado: " + traduzir(e)); }
    }
    db.prepare("UPDATE redes_comentarios SET publica = ?, privada = ?, erro = ? WHERE id = ?")
      .run(publica, privada, erros.length ? erros.join(" · ").slice(0, 400) : null, String(c.comentarioId));
    return { resultado: erros.length ? "erro" : "respondido", regra_id: regra.id };
  } catch (e) {
    console.error("[redes] comentário:", e.message);
    return { resultado: "erro" };
  }
}

/* Os comentários que vêm no webhook da Meta, nos dois formatos. Devolve a
   lista para `comentarioRecebido`. */
export function comentariosDoAviso(corpo) {
  const out = [];
  for (const entry of corpo?.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    if (corpo.object === "instagram" && ch.field === "comments") {
      out.push({ rede: "instagram", igId: String(entry.id || ""), comentarioId: v.id, postId: v.media?.id, texto: v.text || "",
        autorId: v.from?.id, autorNome: v.from?.username || "" });
    } else if (ch.field === "feed" && v.item === "comment" && v.verb === "add") {
      out.push({ rede: "facebook", pageId: String(entry.id || ""), comentarioId: v.comment_id, postId: v.post_id, texto: v.message || "",
        autorId: v.from?.id, autorNome: v.from?.name || "" });
    }
  }
  return out;
}
