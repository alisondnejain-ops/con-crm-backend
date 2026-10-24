/* MARKETING — rotas da estrutura do disparo em massa (27/09/2026).

   Só o gestor (inclusive o dono de conta autônoma, via `roles`). As travas de
   "liberado" e "termo aceito" moram em services/marketing.js → exigirPronto,
   e não aqui: rota nova chamando o serviço herda as duas sem lembrar delas.
   Fluxos, público e disparos moram em services/disparo.js. */

import express, { Router } from "express";
import { roles } from "../auth.js";
import {
  ErroMarketing, estado, aceitarTermo, historicoDeAceites, exigirPronto,
  criarLista, listas, arquivoOriginal, arquivarLista,
  bloquear, listaDeBloqueio, salvarNumero, removerNumero, salvarLimites,
} from "../services/marketing.js";
import {
  listarFluxos, criarFluxo, lerFluxo, salvarFluxo, apagarFluxo, ativarFluxo, logsDoFluxo,
  opcoesDePublico, previaDoPublico, criarCampanha, listarCampanhas, relatorio,
  pausar, retomar, cancelar, DECLARACAO_DISPARO, RODAPE_SAIR, enviarTeste,
} from "../services/disparo.js";
import { salvar, limiteBytes, ehVideo, LIMITE_VIDEO_MB, limiteVideoBinario } from "../services/storage.js";
import { garantirH264 } from "../services/video.js";
import db from "../db.js";
import { garantirWebhook } from "../services/webhook-uazapi.js";
import { linhaDaMeta } from "../services/uazapi.js";
import { listarModelos } from "../services/whatsapp_oficial.js";

const r = Router();
r.use(roles("adm"));

const trata = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof ErroMarketing) return res.status(e.status).json({ error: e.message });
    console.error("[marketing] erro:", e);
    res.status(500).json({ error: "Não consegui concluir. Tente de novo." });
  }
};

r.get("/", trata((req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  /* A URL que a instância de disparo precisa ter no webhook: sem ela as
     RESPOSTAS não chegam, e o fluxo que espera resposta nunca anda. */
  res.json({ ...estado(req.user.org_id, req.user), webhook_url: `${base}/webhooks/uazapi`,
    fluxos: listarFluxos(req.user.org_id).length,
    declaracao_disparo: DECLARACAO_DISPARO, rodape_sair: RODAPE_SAIR });
}));

r.post("/termo", trata((req, res) => {
  if (req.body?.aceito !== true) throw new ErroMarketing(400, "Marque que leu e aceita o termo.");
  aceitarTermo(req.user.org_id, req.user, { ip: req.ip, userAgent: req.get("user-agent") });
  res.json(estado(req.user.org_id, req.user));
}));
r.get("/termo/historico", trata((req, res) => res.json({ aceites: historicoDeAceites(req.user.org_id) })));

r.put("/numero", trata(async (req, res) => {
  const numero = await salvarNumero(req.user.org_id, req.user, req.body || {});
  // A resposta do cliente ao disparo chega por esta linha: o recebimento é
  // ligado aqui, como nas outras (services/webhook-uazapi.js).
  const linha = db.prepare("SELECT canal_id FROM marketing_numero WHERE org_id = ?").get(req.user.org_id);
  const recebimento = linha && linha.canal_id ? await garantirWebhook(req.user.org_id, linha.canal_id) : null;
  res.json({ ok: true, numero, recebimento });
}));
r.put("/numero/limites", trata((req, res) => {
  res.json({ ok: true, limites: salvarLimites(req.user.org_id, req.body || {}) });
}));
r.delete("/numero", trata((req, res) => {
  exigirPronto(req.user.org_id);
  removerNumero(req.user.org_id);
  res.json({ ok: true });
}));

r.get("/listas", trata((req, res) => {
  exigirPronto(req.user.org_id);
  res.json({ listas: listas(req.user.org_id) });
}));
r.post("/listas", trata((req, res) => {
  const lista = criarLista(req.user.org_id, req.user, req.body || {}, { ip: req.ip });
  res.status(201).json({ ok: true, lista });
}));
r.get("/listas/:id/arquivo", trata((req, res) => {
  exigirPronto(req.user.org_id, { termo: false });
  const a = arquivoOriginal(req.user.org_id, req.params.id);
  res.json({ nome: a.nome, hash: a.hash, base64: a.buffer.toString("base64") });
}));
r.post("/listas/:id/arquivar", trata((req, res) => {
  exigirPronto(req.user.org_id);
  arquivarLista(req.user.org_id, req.params.id, req.user);
  res.json({ ok: true, listas: listas(req.user.org_id) });
}));

/* Bloquear na mão vale mesmo sem termo aceito: respeitar quem pediu para sair
   nunca pode depender de uma etapa de configuração. Desbloquear não existe —
   quem pediu para sair não volta por um clique. */
r.get("/bloqueio", trata((req, res) => {
  exigirPronto(req.user.org_id, { termo: false });
  res.json(listaDeBloqueio(req.user.org_id));
}));
r.post("/bloqueio", trata((req, res) => {
  exigirPronto(req.user.org_id, { termo: false });
  bloquear(req.user.org_id, req.body?.telefone, { motivo: "manual", por: req.user.id });
  res.json(listaDeBloqueio(req.user.org_id));
}));

/* ===== FLUXOS ===== */
r.get("/fluxos", trata((req, res) => {
  exigirPronto(req.user.org_id);
  res.json({ fluxos: listarFluxos(req.user.org_id) });
}));
r.post("/fluxos", trata((req, res) => res.status(201).json(criarFluxo(req.user.org_id, req.user, req.body || {}))));
r.get("/fluxos/:id", trata((req, res) => {
  exigirPronto(req.user.org_id);
  res.json(lerFluxo(req.user.org_id, req.params.id));
}));
r.put("/fluxos/:id", trata((req, res) => res.json(salvarFluxo(req.user.org_id, req.params.id, req.body || {}, req.user))));
/* Ligar e desligar a automação de um fluxo com gatilho (services/automacoes.js),
   e o histórico de quem passou por ela. */
r.post("/fluxos/:id/ativar", trata((req, res) => res.json(ativarFluxo(req.user.org_id, req.params.id, req.user, req.body?.ativo !== false))));
r.get("/fluxos/:id/logs", trata((req, res) => {
  exigirPronto(req.user.org_id);
  res.json(logsDoFluxo(req.user.org_id, req.params.id));
}));
r.post("/fluxos/:id/teste", trata(async (req, res) => {
  res.json(await enviarTeste(req.user.org_id, req.params.id, { telefone: req.body?.telefone, nome: req.user.name }));
}));
r.delete("/fluxos/:id", trata((req, res) => {
  exigirPronto(req.user.org_id);
  apagarFluxo(req.user.org_id, req.params.id);
  res.json({ ok: true });
}));

/* ===== MODELOS APROVADOS DA META (08/10/2026) =====
   Os modelos da conta do WhatsApp Business conectada pela API oficial. Sem
   linha na API oficial a lista vem vazia com o motivo — o bloco de mensagem
   continua aceitando texto livre, que é o que a Uazapi manda. */
r.get("/modelos-meta", trata(async (req, res) => {
  exigirPronto(req.user.org_id);
  const linha = linhaDaMeta(req.user.org_id);
  if (!linha) return res.json({ modelos: [], aviso: "Esta conta não usa a API oficial da Meta. Modelo aprovado só existe nela; aqui a mensagem sai como texto livre." });
  try { res.json({ modelos: await listarModelos(linha) }); }
  catch (e) { res.json({ modelos: [], aviso: "A Meta não devolveu os modelos: " + e.message }); }
}));

/* ===== ARQUIVOS DOS BLOCOS DE MENSAGEM =====
   Foto, áudio e documento sobem em base64 (até o limite de sempre); vídeo vem
   CRU, pela mesma régua da conversa (150 MB, HEVC vira H.264 — o WhatsApp
   recusa HEVC em silêncio, e aqui seria em silêncio para a lista inteira). */
const tipoDaMidia = (mime) => /^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "document";
r.post("/midia", trata(async (req, res) => {
  exigirPronto(req.user.org_id);
  const { base64, mime, nome } = req.body || {};
  const m = String(mime || "");
  if (!m) throw new ErroMarketing(400, "Tipo de arquivo desconhecido.");
  if (ehVideo(m)) throw new ErroMarketing(400, "Vídeo sobe pela rota própria de vídeo.");
  const buffer = Buffer.from(String(base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buffer.length) throw new ErroMarketing(400, "Arquivo vazio.");
  if (buffer.length > limiteBytes(m)) throw new ErroMarketing(413, `O arquivo passa do limite de ${Math.round(limiteBytes(m) / 1048576)} MB.`);
  const { url } = await salvar({ buffer, mime: m, prefixo: "marketing" });
  res.json({ url, mime: m, tipo: tipoDaMidia(m), nome: String(nome || "arquivo").replace(/[\r\n]/g, "").slice(0, 200) });
}));
r.post("/midia/video", express.raw({ limit: `${LIMITE_VIDEO_MB + 5}mb`, type: () => true }), trata(async (req, res) => {
  exigirPronto(req.user.org_id);
  const mime = String(req.query.mime || "video/mp4");
  if (!ehVideo(mime)) throw new ErroMarketing(400, "Esta rota é só para vídeo.");
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) throw new ErroMarketing(400, "Arquivo vazio.");
  if (buffer.length > limiteVideoBinario()) throw new ErroMarketing(413, `O vídeo passa do limite de ${LIMITE_VIDEO_MB} MB.`);
  let p;
  try { p = await garantirH264(buffer); }
  catch (e) { throw new ErroMarketing(422, e.message); }
  const { url } = await salvar({ buffer: p.buffer, mime: p.mime, prefixo: "marketing" });
  let nome = String(req.query.nome || "video.mp4").replace(/[\r\n]/g, "").slice(0, 200);
  if (p.convertido) nome = nome.replace(/\.\w+$/, "") + ".mp4";
  res.json({ url, mime: p.mime, tipo: "video", nome, convertido: p.convertido });
}));

/* ===== PÚBLICO ===== */
r.get("/publico/opcoes", trata((req, res) => {
  exigirPronto(req.user.org_id);
  res.json(opcoesDePublico(req.user.org_id));
}));
r.post("/publico/previa", trata((req, res) => {
  exigirPronto(req.user.org_id);
  res.json(previaDoPublico(req.user.org_id, req.body?.publico));
}));

/* ===== DISPAROS ===== */
r.get("/campanhas", trata((req, res) => {
  exigirPronto(req.user.org_id, { termo: false });
  res.json({ campanhas: listarCampanhas(req.user.org_id) });
}));
r.post("/campanhas", trata((req, res) =>
  res.status(201).json(criarCampanha(req.user.org_id, req.user, req.body || {}, { ip: req.ip })))); 
r.get("/campanhas/:id", trata((req, res) => {
  exigirPronto(req.user.org_id, { termo: false });
  res.json(relatorio(req.user.org_id, req.params.id));
}));
/* Pausar e cancelar não exigem termo nem liberação: parar um disparo nunca
   pode depender de configuração nenhuma. Retomar exige tudo. */
r.post("/campanhas/:id/pausar", trata((req, res) => res.json(pausar(req.user.org_id, req.params.id, req.user))));
r.post("/campanhas/:id/retomar", trata((req, res) => res.json(retomar(req.user.org_id, req.params.id))));
r.post("/campanhas/:id/cancelar", trata((req, res) => res.json(cancelar(req.user.org_id, req.params.id))));

export default r;
