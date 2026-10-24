/* O AGENTE DE DESENVOLVIMENTO NO WHATSAPP (24/10/2026, pedido do Ali: "criar
   um canal no WhatsApp exclusivo para que eu e o Fernando se comunique com
   esse agente… dentro desses horários o agente atenda as solicitações e faça
   as alterações").

   O CAMINHO DE UMA MENSAGEM:
   1. Ali ou Fernando escreve para o número do agente. Esse número é uma
      instância da Uazapi SÓ DELE, fora das linhas das imobiliárias
      (AGENTE_UAZAPI_HOST/TOKEN): mensagem para o agente nunca vira lead,
      nunca cai em caixa nem em relatório de conta nenhuma.
   2. O webhook (`/webhooks/agente/<AGENTE_SEGREDO>`) guarda a mensagem como
      'pendente'. Número que não está em AGENTE_NUMEROS é ignorado em
      silêncio: responder confirmaria a desconhecidos que o número é de um
      agente que mexe no código do ConHub.
   3. Dentro do horário (AGENTE_HORARIO, padrão seg–sex 07:00–18:00), o
      batimento junta as pendentes — espera 20s sem mensagem nova, para três
      mensagens seguidas virarem UM pedido — e acorda o agente: um POST na
      rotina do Claude Code (AGENTE_FIRE_URL/TOKEN) com os pedidos e a
      conversa recente. Fora do horário, responde uma vez que anotou e
      quando começa; as pendentes saem quando o horário abre.
   4. O agente trabalha numa sessão própria, com o código, e responde pelo
      `POST /agente/responder` (Bearer AGENTE_SEGREDO) — que só aceita mandar
      para os números autorizados.

   PUBLICAR É DE QUEM ESTÁ EM AGENTE_PUBLICA (hoje, só o Ali). A trava não
   fica só no texto que vai ao agente: antes de juntar a mudança em main o
   agente pergunta ao CONHUB (`GET /agente/publicacao?pr=N`), que confere no
   próprio banco se alguém autorizado escreveu "publicar" para aquele número
   de proposta. O texto do pedido passa por um sistema de terceiros; o banco
   daqui não.

   Nada aqui lança para fora: quem chama é um webhook e um batimento. */

import db from "../db.js";
import { normalizePhone } from "./telefone.js";
import { numeroAlternativo } from "./uazapi.js";
import { pedir, lista } from "./webhook-uazapi.js";

const agora = () => Date.now();
const soDigitos = (t) => String(t || "").replace(/\D/g, "");
const limpar = (h) => String(h || "").trim().replace(/\/+$/, "");
const TIMEOUT_MS = 20000;
const ESPERA_JUNTAR_MS = 20000;      // mensagens seguidas viram um pedido só
const ESPERA_APOS_FALHA_MS = 5 * 60000;
const LEMBRETE_FORA_MS = 2 * 3600000; // "fora do horário" no máximo a cada 2h por pessoa

/* ===================================================== configuração */
// "Ali:5581999353988, Fernando:5587988887777" → [{nome, numero}]
function lerPessoas(bruto) {
  return String(bruto || "").split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const [nome, num] = s.includes(":") ? s.split(":") : ["", s];
    const numero = normalizePhone(soDigitos(num));
    return numero ? { nome: nome.trim() || numero, numero } : null;
  }).filter(Boolean);
}
// "1-5 07:00-18:00" → { dias:Set, ini, fim } em minutos do dia
function lerHorario(bruto) {
  const m = String(bruto || "1-5 07:00-18:00").match(/^\s*([0-6](?:\s*-\s*[0-6])?(?:\s*,\s*[0-6](?:\s*-\s*[0-6])?)*)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return lerHorario("1-5 07:00-18:00");
  const dias = new Set();
  for (const parte of m[1].split(",")) {
    const [a, b] = parte.split("-").map(x => Number(x.trim()));
    for (let d = a; d <= (b ?? a); d++) dias.add(d);
  }
  return { dias, ini: Number(m[2]) * 60 + Number(m[3]), fim: Number(m[4]) * 60 + Number(m[5]), texto: m[0].trim() };
}
export function configDoAgente() {
  const e = process.env;
  const pessoas = lerPessoas(e.AGENTE_NUMEROS);
  const publicam = new Set(lerPessoas(e.AGENTE_PUBLICA).map(p => p.numero));
  return {
    host: limpar(e.AGENTE_UAZAPI_HOST),
    token: String(e.AGENTE_UAZAPI_TOKEN || "").trim(),
    segredo: String(e.AGENTE_SEGREDO || "").trim(),
    fireUrl: String(e.AGENTE_FIRE_URL || "").trim(),
    fireToken: String(e.AGENTE_FIRE_TOKEN || "").trim(),
    pessoas: pessoas.map(p => ({ ...p, publica: publicam.has(p.numero) })),
    horario: lerHorario(e.AGENTE_HORARIO),
  };
}
// Segredo curto é chute: ele é a senha do webhook e da rota de resposta.
export const agenteLigado = (c = configDoAgente()) => !!(c.host && c.token && c.segredo.length >= 24 && c.pessoas.length);

/* A pessoa pelo número. O WhatsApp pode entregar o celular brasileiro com ou
   sem o nono dígito, então as duas formas valem. */
export function pessoaDoNumero(numero, c = configDoAgente()) {
  const n = normalizePhone(soDigitos(numero));
  if (!n) return null;
  const alt = numeroAlternativo(n);
  return c.pessoas.find(p => p.numero === n || (alt && p.numero === alt) || numeroAlternativo(p.numero) === n) || null;
}

export function dentroDoHorario(d = new Date(), c = configDoAgente()) {
  const h = c.horario;
  const min = d.getHours() * 60 + d.getMinutes();
  return h.dias.has(d.getDay()) && min >= h.ini && min < h.fim;
}
const NOMES_DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export function proximaAbertura(d = new Date(), c = configDoAgente()) {
  const h = c.horario;
  for (let i = 0; i < 8; i++) {
    const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, Math.floor(h.ini / 60), h.ini % 60);
    if (h.dias.has(dia.getDay()) && dia > d) return dia;
  }
  return null;
}
function quandoAbre(d = new Date(), c = configDoAgente()) {
  const p = proximaAbertura(d, c);
  if (!p) return "no próximo horário de trabalho";
  const amanha = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();
  const dia = mesmoDia(p, d) ? "hoje" : mesmoDia(p, amanha) ? "amanhã" : NOMES_DIAS[p.getDay()];
  return `${dia} às ${hhmm(p.getHours() * 60 + p.getMinutes())}`;
}

/* ===================================================== envio */
async function enviarCru(c, numero, texto) {
  const res = await fetch(`${c.host}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: c.token },
    body: JSON.stringify({ track_source: "conhub-agente", number: numero, text: texto }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bruto = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`a Uazapi respondeu ${res.status}: ${bruto.slice(0, 160)}`);
}
/* Manda uma mensagem do agente (ou do sistema) a uma pessoa autorizada e
   guarda na conversa. Só número da lista: a rota de resposta é chamada de
   fora, e não pode virar um jeito de mandar WhatsApp a qualquer um. */
export async function enviarAoTime(numero, texto, c = configDoAgente()) {
  const p = pessoaDoNumero(numero, c);
  if (!p) throw new Error("Este número não está em AGENTE_NUMEROS.");
  texto = String(texto || "").trim().slice(0, 4000);
  if (!texto) throw new Error("Texto vazio.");
  try { await enviarCru(c, p.numero, texto); }
  catch (e) {
    const alt = numeroAlternativo(p.numero);
    if (!alt || !/not on whatsapp|não está no whatsapp|not exist/i.test(e.message)) throw e;
    await enviarCru(c, alt, texto);
  }
  db.prepare("INSERT INTO agente_mensagens (numero, nome, direcao, texto, criado_em) VALUES (?,?,?,?,?)")
    .run(p.numero, p.nome, "out", texto, agora());
  return p;
}
const enviarSemFalhar = (n, t, c) => enviarAoTime(n, t, c).catch(e => console.warn("[agente] não consegui responder:", e.message));

/* ===================================================== entrada */
/* Chamado pelo webhook com o que `extrair` (uazapi.webhook.js) leu. Devolve
   o que fez, para o log e para o teste. */
export async function mensagemParaOAgente(m, c = configDoAgente()) {
  if (!agenteLigado(c)) return { ignorada: "agente desligado" };
  if (m.ignorar) return { ignorada: m.ignorar };
  if (m.fromMe) return { ignorada: "eco" };
  const p = pessoaDoNumero(m.phone, c);
  if (!p) return { ignorada: "número fora da lista" };
  if (m.messageid && db.prepare("SELECT 1 FROM agente_mensagens WHERE wa_id = ?").get(m.messageid)) return { ignorada: "repetida" };

  let texto = String(m.texto || "").trim();
  if (!texto) {
    const tipo = /audio|ptt/i.test(m.tipo) ? "áudio" : m.tipo ? "arquivo" : "mensagem";
    await enviarSemFalhar(p.numero, `🤖 Recebi um ${tipo}, mas por enquanto só leio texto. Pode mandar por escrito?`, c);
    return { ignorada: "sem texto" };
  }
  try {
    db.prepare("INSERT INTO agente_mensagens (numero, nome, direcao, texto, wa_id, estado, criado_em) VALUES (?,?,?,?,?,?,?)")
      .run(p.numero, p.nome, "in", texto.slice(0, 8000), m.messageid || null, "pendente", agora());
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { ignorada: "repetida" }; // a mesma entrega duas vezes
    throw e;
  }
  if (!dentroDoHorario(new Date(), c)) {
    const recente = db.prepare(`SELECT 1 FROM agente_mensagens WHERE numero = ? AND direcao = 'out'
      AND texto LIKE '🤖 Anotado%' AND criado_em > ?`).get(p.numero, agora() - LEMBRETE_FORA_MS);
    if (!recente)
      await enviarSemFalhar(p.numero, `🤖 Anotado! Fora do meu horário agora (${descreverHorario(c)}). Começo por isso ${quandoAbre(new Date(), c)}.`, c);
    return { guardada: true, foraDoHorario: true };
  }
  return { guardada: true };
}
function descreverHorario(c) {
  const d = [...c.horario.dias].sort();
  const seq = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const dias = seq ? `${NOMES_DIAS[d[0]]} a ${NOMES_DIAS[d[d.length - 1]]}` : d.map(x => NOMES_DIAS[x]).join(", ");
  return `${dias}, ${hhmm(c.horario.ini)}–${hhmm(c.horario.fim)}`;
}

/* ===================================================== acordar o agente */
const fmt = (t) => {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hhmm(d.getHours() * 60 + d.getMinutes())}`;
};
export function montarPedido(pendentes, c = configDoAgente()) {
  const primeiro = pendentes[0].id;
  const historico = db.prepare(`SELECT * FROM agente_mensagens WHERE id < ? ORDER BY id DESC LIMIT 30`).all(primeiro).reverse();
  const quem = (r) => r.direcao === "out" ? "Agente" : `${r.nome}${c.pessoas.find(p => p.numero === r.numero)?.publica ? " (pode publicar)" : ""}`;
  const pessoas = [...new Map(pendentes.map(r => [r.numero, r])).values()];
  return [
    "CANAL DO WHATSAPP DO AGENTE DE DESENVOLVIMENTO DO CONHUB",
    "",
    "PEDIDOS NOVOS (atenda estes):",
    ...pendentes.map(r => `[${fmt(r.criado_em)}] ${quem(r)}: ${r.texto}`),
    "",
    `RESPONDER PARA: ${pessoas.map(r => `${r.nome} (${r.numero})`).join(", ")}`,
    `QUEM PODE MANDAR PUBLICAR: ${c.pessoas.filter(p => p.publica).map(p => `${p.nome} (${p.numero})`).join(", ") || "ninguém"}`,
    "",
    historico.length ? "CONVERSA ANTERIOR (contexto, mais antiga primeiro):" : "CONVERSA ANTERIOR: nenhuma.",
    ...historico.map(r => `[${fmt(r.criado_em)}] ${quem(r)}: ${r.texto.slice(0, 1500)}`),
  ].join("\n").slice(0, 60000);
}

let ultimaFalha = 0;
let ultimoErro = null;
let rodando = false;
export const estadoDoAgente = () => ({ ultimaFalha, ultimoErro });

/* Batimento: junta as pendentes e acorda o agente. Um de cada vez. */
export async function processarAgente({ forcar = false } = {}) {
  const c = configDoAgente();
  if (rodando || !agenteLigado(c) || !c.fireUrl || !c.fireToken) return { feito: false };
  if (!dentroDoHorario(new Date(), c)) return { feito: false, motivo: "fora do horário" };
  if (!forcar && ultimaFalha && agora() - ultimaFalha < ESPERA_APOS_FALHA_MS) return { feito: false, motivo: "esperando depois de falha" };
  const pendentes = db.prepare("SELECT * FROM agente_mensagens WHERE direcao = 'in' AND estado = 'pendente' ORDER BY id").all();
  if (!pendentes.length) return { feito: false };
  if (!forcar && agora() - pendentes[pendentes.length - 1].criado_em < ESPERA_JUNTAR_MS) return { feito: false, motivo: "juntando" };
  rodando = true;
  try {
    const res = await fetch(c.fireUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.fireToken}`,
        "anthropic-beta": process.env.AGENTE_FIRE_BETA || "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: montarPedido(pendentes, c) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const bruto = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`a rotina respondeu ${res.status}: ${bruto.slice(0, 200)}`);
    let url = null; try { url = JSON.parse(bruto).claude_code_session_url || null; } catch { /* sem corpo */ }
    const marcar = db.prepare("UPDATE agente_mensagens SET estado = 'enviada', sessao_url = ? WHERE id = ?");
    for (const r of pendentes) marcar.run(url, r.id);
    ultimaFalha = 0; ultimoErro = null;
    for (const numero of new Set(pendentes.map(r => r.numero)))
      await enviarSemFalhar(numero, `🤖 Recebi${pendentes.length > 1 ? ` (${pendentes.length} mensagens)` : ""}, estou começando. Aviso por aqui quando tiver novidade.${url ? `\nAcompanhar: ${url}` : ""}`, c);
    return { feito: true, url, quantas: pendentes.length };
  } catch (e) {
    const primeiraFalha = !ultimaFalha;
    ultimaFalha = agora(); ultimoErro = e.message;
    console.warn("[agente] não consegui acordar o agente:", e.message);
    if (primeiraFalha)
      for (const numero of new Set(pendentes.map(r => r.numero)))
        await enviarSemFalhar(numero, `🤖 Não consegui acordar o agente agora (${e.message.slice(0, 160)}). Sua mensagem está guardada: tento de novo a cada 5 minutos.`, c);
    return { feito: false, erro: e.message };
  } finally { rodando = false; }
}

/* ===================================================== publicar */
/* Alguém de AGENTE_PUBLICA autorizou publicar a proposta N nas últimas 24h?
   Vale "publicar #N" / "pode publicar 123", ou "pode publicar" logo depois
   de uma mensagem do agente que falava da #N — que é como se responde no
   WhatsApp de verdade. */
export function autorizacaoDePublicar(pr, c = configDoAgente()) {
  const n = String(pr || "").replace(/\D/g, "");
  if (!n) return { autorizado: false, motivo: "número da proposta inválido" };
  const publicam = c.pessoas.filter(p => p.publica).map(p => p.numero);
  if (!publicam.length) return { autorizado: false, motivo: "ninguém está em AGENTE_PUBLICA" };
  const desde = agora() - 24 * 3600000;
  const pedidos = db.prepare(`SELECT * FROM agente_mensagens WHERE direcao = 'in' AND criado_em > ?
    AND numero IN (${publicam.map(() => "?").join(",")}) ORDER BY id DESC`).all(desde, ...publicam);
  const citaN = new RegExp(`(^|[^\\d])#?${n}([^\\d]|$)`);
  for (const r of pedidos) {
    if (!/publi(c|qu)/i.test(r.texto) || /n[ãa]o\s+publi/i.test(r.texto)) continue;
    if (citaN.test(r.texto)) return { autorizado: true, por: r.nome, em: r.criado_em, texto: r.texto };
    if (/\d{2,}/.test(r.texto.replace(/\d{1,2}[:h]\d{2}/g, ""))) continue; // citou OUTRO número
    const anterior = db.prepare(`SELECT texto FROM agente_mensagens WHERE direcao = 'out' AND numero = ? AND id < ? ORDER BY id DESC LIMIT 1`).get(r.numero, r.id);
    if (anterior && citaN.test(anterior.texto)) return { autorizado: true, por: r.nome, em: r.criado_em, texto: r.texto };
  }
  return { autorizado: false, motivo: `nenhuma autorização para publicar a #${n} nas últimas 24h` };
}

/* ===================================================== webhook da instância */
/* Aponta a instância do agente para `/webhooks/agente/<segredo>`. Mesma
   régua do services/webhook-uazapi.js: só com APP_URL de verdade, confere
   antes, e confere de novo depois ("respondeu 200" não é "configurou"). */
export function enderecoDoWebhookDoAgente(c = configDoAgente()) {
  const base = limpar(process.env.APP_URL);
  let u; try { u = new URL(base); } catch { return null; }
  if (/^(localhost|127\.|0\.0\.0\.0)/i.test(u.hostname) && process.env.CONHUB_WEBHOOK_PERMITE_LOCAL !== "1") return null;
  return `${base}/webhooks/agente/${c.segredo}`;
}
export async function garantirWebhookDoAgente(c = configDoAgente()) {
  if (!agenteLigado(c)) return { estado: "desligado" };
  const url = enderecoDoWebhookDoAgente(c);
  if (!url) return { estado: "sem_endereco" };
  try {
    const nosso = (w) => String(w.url || "") === url && w.enabled !== false;
    if (lista(await pedir(c.host, c.token, "GET")).some(nosso)) return { estado: "ok", acao: "ja_estava" };
    await pedir(c.host, c.token, "POST", { enabled: true, url, events: ["messages"], excludeMessages: ["isGroupYes", "wasSentByApi"] });
    if (lista(await pedir(c.host, c.token, "GET")).some(nosso)) { console.log("[agente] recebimento ligado na instância do agente"); return { estado: "ok", acao: "configurado" }; }
    return { estado: "erro", detalhe: "a Uazapi aceitou, mas o webhook não aparece configurado" };
  } catch (e) {
    console.warn("[agente] não consegui ligar o recebimento:", e.message);
    return { estado: "erro", detalhe: e.message };
  }
}
