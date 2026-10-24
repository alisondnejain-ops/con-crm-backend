/* As portas do agente de desenvolvimento (services/agente-dev.js).

   `webhook` — POST /webhooks/agente/<AGENTE_SEGREDO>: a Uazapi da instância
   do agente entrega aqui. Segredo errado responde 404, nunca 401: não conta
   que existe um certo.

   `api` — /agente/*, chamado PELO AGENTE (a sessão do Claude Code), com
   "Authorization: Bearer <AGENTE_SEGREDO>". Não usa o login do CRM: o agente
   não é uma pessoa de conta nenhuma, e um crachá de 30 dias guardado na
   rotina daria a ele o CRM inteiro de alguém. O segredo só abre estas rotas. */
import { Router } from "express";
import { createHash, timingSafeEqual } from "crypto";
import db from "../db.js";
import { extrair } from "./uazapi.webhook.js";
import {
  configDoAgente, agenteLigado, mensagemParaOAgente, enviarAoTime,
  autorizacaoDePublicar, dentroDoHorario, estadoDoAgente,
} from "../services/agente-dev.js";

// compara pelo resumo: mesmo tamanho sempre, e sem vazar tempo
const igual = (a, b) => {
  const h = (s) => createHash("sha256").update(String(s || "")).digest();
  return !!a && !!b && timingSafeEqual(h(a), h(b));
};

export const webhook = Router();
webhook.post(["/agente/:segredo", "/agente/:segredo/:sufixo", "/agente/:segredo/:sufixo/:sufixo2"], (req, res) => {
  const c = configDoAgente();
  if (!agenteLigado(c) || !igual(req.params.segredo, c.segredo)) return res.status(404).json({ error: "não encontrado" });
  // responde já: webhook lento é webhook que a Uazapi desiste de chamar
  res.json({ ok: true });
  let m;
  try { m = extrair(req.body || {}); } catch (e) { return console.warn("[agente] payload ilegível:", e.message); }
  mensagemParaOAgente(m, c)
    .then(r => { if (r.ignorada && r.ignorada !== "eco") console.log(`[agente] mensagem ignorada: ${r.ignorada}`); })
    .catch(e => console.error("[agente] erro ao receber:", e.message));
});

export const api = Router();
api.use((req, res, next) => {
  const c = configDoAgente();
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!agenteLigado(c) || !igual(bearer, c.segredo)) return res.status(401).json({ error: "segredo do agente inválido" });
  req.agente = c;
  next();
});

// { para: "5581…" | "todos", texto }
api.post("/responder", async (req, res) => {
  const { para, texto } = req.body || {};
  if (!String(texto || "").trim()) return res.status(400).json({ error: "texto vazio" });
  const alvos = para === "todos" ? req.agente.pessoas.map(p => p.numero) : [para];
  const enviados = [], falhas = [];
  for (const n of alvos) {
    try { const p = await enviarAoTime(n, texto, req.agente); enviados.push(p.nome); }
    catch (e) { falhas.push({ para: n, erro: e.message }); }
  }
  res.status(enviados.length ? 200 : 400).json({ ok: enviados.length > 0, enviados, falhas });
});

api.get("/conversa", (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
  res.json(db.prepare("SELECT id, nome, numero, direcao, texto, estado, criado_em FROM agente_mensagens ORDER BY id DESC LIMIT ?").all(limite).reverse());
});

// o ConHub confere no próprio banco se quem pode publicar autorizou a proposta N
api.get("/publicacao", (req, res) => res.json(autorizacaoDePublicar(req.query.pr, req.agente)));

api.get("/estado", (req, res) => {
  const c = req.agente;
  res.json({
    pessoas: c.pessoas.map(p => ({ nome: p.nome, publica: p.publica })),
    horario: c.horario.texto, dentro_do_horario: dentroDoHorario(new Date(), c),
    rotina_configurada: !!(c.fireUrl && c.fireToken),
    pendentes: db.prepare("SELECT COUNT(*) n FROM agente_mensagens WHERE direcao = 'in' AND estado = 'pendente'").get().n,
    ...estadoDoAgente(),
  });
});
