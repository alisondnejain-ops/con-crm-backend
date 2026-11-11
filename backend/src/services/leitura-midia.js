/* ===== A LEITURA DOS ÁUDIOS E DAS FOTOS DO CLIENTE (11/11/2026) =====

   Pedido do Ali: "trabalha durante a noite nesse trabalho pra fazer uma
   leitura precisa de áudios e imagens". Até aqui a conversa guardava o
   áudio e a foto, e para a IA eles eram só o rótulo "Áudio" / "Foto": o
   Autoatendimento pedia "manda por escrito" a todo cliente que mandava voz
   (que no WhatsApp é quase todo cliente), e o resumo da conversa pulava o
   que a pessoa tinha dito de mais importante.

   Agora cada áudio e cada foto que o CLIENTE manda ganha uma LEITURA,
   guardada na própria mensagem (`messages.leitura`):

   - ÁUDIO → transcrição, por um serviço de transcrição compatível com a API
     da OpenAI (`/v1/audio/transcriptions`). A Anthropic não transcreve
     áudio, e por isso é a única peça do CRM que fala com outro provedor de
     IA. Liga com `TRANSCRICAO_API_KEY` (ou `OPENAI_API_KEY`); `TRANSCRICAO_URL`
     e `TRANSCRICAO_MODELO` trocam o serviço (Groq, por exemplo, tem o mesmo
     formato). O áudio vira MP3 mono antes de sair (o ogg do WhatsApp nem
     sempre é aceito do jeito que vem, e o arquivo fica menor).
   - FOTO → descrição pela mesma IA do resto do CRM (`descreverImagem` em
     services/ia.js), com o texto que a imagem tiver transcrito.

   A leitura aparece embaixo do áudio e da foto na conversa, e TODA leitura
   da conversa pela IA (Autoatendimento, resumo, etapa, temperatura,
   sugestão de mensagem, fluxos, aprendizado) passa a ver o conteúdo no
   lugar do rótulo — por um lugar só, `CORPO_PARA_IA`.

   AS TRAVAS:
   - Automático só para o que o CLIENTE manda, e só com a conta deixando
     (`orgs.ler_midia`, nulo = ligado; o gestor desliga em Configurações →
     Atendimento). O áudio e a foto saem do servidor rumo ao provedor — é a
     mesma natureza do resumo, e por isso a conta pode dizer não.
   - Sob demanda, para qualquer áudio ou foto (o botão "Transcrever" / "Ler
     a imagem"), por quem pode abrir a conversa.
   - Uma leitura por mensagem: a mesma mensagem pedida duas vezes ao mesmo
     tempo espera a primeira (`emCurso`), e a que já tem leitura não é lida
     de novo (não paga duas vezes).
   - Falhou, fica o motivo em `leitura_erro` e a tela oferece tentar de
     novo. Mensagem apagada não é lida.
   - Nunca lança: o webhook dispara sem esperar, e o Autoatendimento espera
     com teto de tempo — leitura que demora não pode calar o atendimento. */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import db from "../db.js";
import { bytesParaBaixar } from "./storage.js";
import { descreverImagem, iaConfigurada } from "./ia.js";
import { registrar } from "./iauso.js";

const chaveTranscricao = () => (process.env.TRANSCRICAO_API_KEY || process.env.OPENAI_API_KEY || "").trim();
const urlTranscricao = () => (process.env.TRANSCRICAO_URL || "https://api.openai.com/v1/audio/transcriptions").trim();
const modeloTranscricao = () => (process.env.TRANSCRICAO_MODELO || "gpt-4o-transcribe").trim();
// Dólares por minuto de áudio, para o "Uso da IA" do master (o preço do gpt-4o-transcribe e do whisper-1).
const CUSTO_MINUTO = Number(process.env.TRANSCRICAO_CUSTO_MIN || 0.006);
// Áudio mais longo que isto não é transcrito: é raro no atendimento e custaria caro de uma vez.
const MAX_MINUTOS = Number(process.env.TRANSCRICAO_MAX_MIN || 30);

export const transcricaoConfigurada = () => !!chaveTranscricao();
export const leituraDeImagemConfigurada = () => iaConfigurada();

const ehAudio = (mime) => /^audio\//.test(mime || "");
const ehImagem = (mime) => /^image\//.test(mime || "");

/* O texto que a IA lê no lugar do corpo da mensagem. É SQL para entrar nos
   SELECTs que já existem sem mudar a forma do que eles devolvem (`body`). A
   marca entre parênteses diz à IA o que aquilo era — a instrução do
   Autoatendimento explica as duas marcas. A tabela de mensagens precisa vir
   sem apelido ou com o prefixo passado. */
export const corpoParaIA = (a = "") => `CASE
  WHEN ${a}leitura IS NULL OR ${a}leitura = '' THEN ${a}body
  WHEN ${a}media_mime LIKE 'audio/%' THEN '(áudio transcrito) ' || ${a}leitura
  ELSE (CASE WHEN ${a}body IS NULL OR ${a}body IN ('', 'Foto') THEN '' ELSE ${a}body || ' ' END) || '(foto: ' || ${a}leitura || ')'
END`;

/* A conta deixa ler automaticamente? Nulo = sim. */
export function contaLeAutomatico(orgId) {
  const o = db.prepare("SELECT ler_midia FROM orgs WHERE id = ?").get(orgId);
  return !o || o.ler_midia === null || o.ler_midia === undefined || Number(o.ler_midia) !== 0;
}

export function estadoDaLeitura(orgId) {
  return {
    automatico: contaLeAutomatico(orgId),
    audio: transcricaoConfigurada(),
    imagem: leituraDeImagemConfigurada(),
  };
}

function rodar(bin, args, ms = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let erro = "";
    const t = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("demorou demais para converter o áudio")); }, ms);
    proc.stderr.on("data", (d) => { erro += d; });
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(erro);
      else reject(new Error(erro.trim().slice(-300) || `saiu com código ${code}`));
    });
  });
}

/* Áudio qualquer → MP3 mono 16 kHz, e quantos segundos ele tem (lido da
   saída do próprio ffmpeg, sem chamar o ffprobe à parte). */
async function paraMp3(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conhub-audio-"));
  const entrada = path.join(dir, "entrada"), saida = path.join(dir, "saida.mp3");
  try {
    await fs.writeFile(entrada, buffer);
    const log = await rodar(ffmpegPath, ["-hide_banner", "-y", "-i", entrada, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", saida]);
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    const segundos = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    return { buffer: await fs.readFile(saida), segundos };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* Áudio → texto. Devolve {ok, texto, segundos} ou {ok:false, erro}. */
export async function transcreverAudio(buffer) {
  if (!transcricaoConfigurada()) return { ok: false, erro: "A transcrição de áudio não está ligada nesta instalação." };
  let mp3;
  try { mp3 = await paraMp3(buffer); }
  catch (e) { return { ok: false, erro: "Não consegui abrir o áudio: " + e.message }; }
  if (mp3.segundos && mp3.segundos > MAX_MINUTOS * 60)
    return { ok: false, erro: `O áudio tem mais de ${MAX_MINUTOS} minutos — não é transcrito automaticamente.` };
  const form = new FormData();
  form.append("file", new Blob([mp3.buffer], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", modeloTranscricao());
  form.append("response_format", "json");
  // Vocabulário do atendimento: ajuda o serviço a escrever certo o que mais se fala aqui.
  form.append("prompt", "Áudio de WhatsApp de um cliente para uma imobiliária: imóvel, apartamento, casa, terreno, financiamento, entrada, FGTS, Caixa, Minha Casa Minha Vida, condomínio, aluguel, visita.");
  let res, corpo;
  try {
    res = await fetch(urlTranscricao(), {
      method: "POST", headers: { authorization: "Bearer " + chaveTranscricao() }, body: form,
      signal: AbortSignal.timeout(120000),
    });
    corpo = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, erro: "Não consegui falar com o serviço de transcrição: " + e.message };
  }
  if (!res.ok) {
    const msg = corpo?.error?.message || `HTTP ${res.status}`;
    return { ok: false, erro: res.status === 401 ? "A chave da transcrição foi recusada." : "A transcrição falhou: " + msg };
  }
  const texto = String(corpo.text || "").trim();
  if (!texto) return { ok: false, erro: "O áudio não tem fala que dê para transcrever." };
  return { ok: true, texto: texto.slice(0, 8000), segundos: mp3.segundos };
}

/* Foto → descrição. A imagem vai reduzida (a IA lê até ~1568 px e cobra
   pelo tamanho) e em JPEG, deitada pelo EXIF. */
async function lerImagem(buffer, legenda) {
  if (!leituraDeImagemConfigurada()) return { ok: false, erro: "A IA não está ligada nesta instalação." };
  let jpg;
  try {
    jpg = await sharp(buffer, { failOn: "none" }).rotate()
      .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  } catch (e) {
    return { ok: false, erro: "Não consegui abrir a imagem." };
  }
  return descreverImagem({ base64: jpg.toString("base64"), mime: "image/jpeg", legenda });
}

const emCurso = new Map();

/* Lê UMA mensagem (áudio ou foto) e grava a leitura. Devolve a linha
   atualizada ({leitura, leitura_erro}). `forcar` relê o que falhou. */
export function lerMensagem(messageId, { userId = null, forcar = false } = {}) {
  if (emCurso.has(messageId)) return emCurso.get(messageId);
  const p = (async () => {
    const m = db.prepare(`SELECT m.id, m.lead_id, m.body, m.media_url, m.media_mime, m.leitura, m.leitura_erro, m.apagada_em, l.org_id
      FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ?`).get(messageId);
    if (!m) return { erro: "Mensagem não encontrada." };
    if (m.apagada_em) return { erro: "A mensagem foi apagada." };
    if (m.leitura) return { leitura: m.leitura };
    if (m.leitura_erro && !forcar) return { erro: m.leitura_erro };
    if (!m.media_url || !(ehAudio(m.media_mime) || ehImagem(m.media_mime))) return { erro: "Só áudio e foto têm leitura." };
    if (ehAudio(m.media_mime) && !transcricaoConfigurada()) return { erro: "A transcrição de áudio não está ligada nesta instalação." };
    if (ehImagem(m.media_mime) && !leituraDeImagemConfigurada()) return { erro: "A IA não está ligada nesta instalação." };
    let bytes;
    try { bytes = await bytesParaBaixar(m.media_url); }
    catch (e) { return gravarErro(m.id, "Não consegui buscar o arquivo: " + e.message); }
    let r;
    if (ehAudio(m.media_mime)) {
      r = await transcreverAudio(bytes);
      if (r.ok) registrar({ orgId: m.org_id, userId, leadId: m.lead_id, recurso: "transcricao",
        uso: { entrada: 0, saida: 0 }, modelo: modeloTranscricao(),
        custo: r.segundos ? Math.round(r.segundos / 60 * CUSTO_MINUTO * 1e6) / 1e6 : 0 });
    } else {
      const legenda = m.body && m.body !== "Foto" ? m.body : "";
      r = await lerImagem(bytes, legenda);
      if (r.ok) registrar({ orgId: m.org_id, userId, leadId: m.lead_id, recurso: "leitura_imagem", uso: r.uso, modelo: r.modelo });
    }
    if (!r.ok) return gravarErro(m.id, r.erro);
    db.prepare("UPDATE messages SET leitura = ?, leitura_em = ?, leitura_erro = NULL WHERE id = ?").run(r.texto, Date.now(), m.id);
    return { leitura: r.texto };
  })().catch(e => {
    console.warn("[leitura] falhou:", e.message);
    return { erro: "A leitura falhou: " + e.message };
  }).finally(() => emCurso.delete(messageId));
  emCurso.set(messageId, p);
  return p;
}

function gravarErro(id, erro) {
  try { db.prepare("UPDATE messages SET leitura_erro = ?, leitura_em = ? WHERE id = ?").run(String(erro).slice(0, 300), Date.now(), id); } catch (e) {}
  return { erro };
}

/* Chamado pelo webhook, sem esperar: a mensagem do cliente que é áudio ou
   foto começa a ser lida assim que entra. */
export function lerAoChegar({ messageId, orgId, mime }) {
  try {
    if (!(ehAudio(mime) || ehImagem(mime))) return;
    if (!contaLeAutomatico(orgId)) return;
    if (ehAudio(mime) && !transcricaoConfigurada()) return;
    if (ehImagem(mime) && !leituraDeImagemConfigurada()) return;
    lerMensagem(messageId).catch(() => {});
  } catch (e) {}
}

/* O Autoatendimento, antes de responder, espera as leituras que ainda
   faltam nas mensagens recentes do cliente — com teto: passado o tempo, ele
   responde com o que tem (o rótulo, e a instrução manda pedir por escrito). */
export async function esperarLeiturasDoLead(leadId, { ms = 45000, orgId = null } = {}) {
  try {
    const desde = Date.now() - 6 * 3600000;
    const linhas = db.prepare(`SELECT id, media_mime FROM messages WHERE lead_id = ? AND direction = 'in' AND apagada_em IS NULL
      AND leitura IS NULL AND leitura_erro IS NULL AND media_url IS NOT NULL AND created_at > ?
      AND (media_mime LIKE 'audio/%' OR media_mime LIKE 'image/%')`).all(leadId, desde);
    if (!linhas.length) return;
    const org = orgId || (db.prepare("SELECT org_id FROM leads WHERE id = ?").get(leadId) || {}).org_id;
    if (!contaLeAutomatico(org)) return;
    const pedidos = linhas
      .filter(l => (ehAudio(l.media_mime) && transcricaoConfigurada()) || (ehImagem(l.media_mime) && leituraDeImagemConfigurada()))
      .map(l => lerMensagem(l.id));
    if (!pedidos.length) return;
    await Promise.race([Promise.allSettled(pedidos), new Promise(r => setTimeout(r, ms))]);
  } catch (e) {}
}

export const _paraTeste = { paraMp3, randomUUID };
