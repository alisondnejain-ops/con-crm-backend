/* Portais de imóveis — ver services/portais.js para as regras.

   Três roteadores, três portas diferentes, e é por isso que moram juntos:
   ler cada um sozinho não mostra que eles só funcionam em conjunto.
     - `feeds`   (público, token do FEED)  — o portal lê os anúncios.
     - `webhook` (público, token dos LEADS) — o portal entrega o lead.
     - `gestao`  (logado, gestor)          — a tela de Portais. */
import express, { Router } from "express";
import { roles } from "../auth.js";
import {
  configDaOrg, salvarContato, trocarToken, orgPorTokenFeed, orgPorTokenLeads,
  situacaoDaOrg, feedVRSync, feedChavesNaMao, lerLead, receberLead,
} from "../services/portais.js";

const baseDe = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/* ===== FEED (público) ===== */
export const feeds = Router();
function servirFeed(gerar) {
  return (req, res) => {
    const orgId = orgPorTokenFeed(req.params.token);
    // 404 e não 401: endereço errado não deve contar que existe um certo.
    if (!orgId) return res.status(404).type("text/plain").send("Feed não encontrado.");
    res.set("Content-Type", "application/xml; charset=utf-8");
    // Curto de propósito: preço trocado ou imóvel vendido tem que sair do
    // portal na próxima leitura, não depois de um cache de um dia.
    res.set("Cache-Control", "public, max-age=300");
    res.send(gerar(orgId, baseDe(req)));
  };
}
// O mesmo arquivo com dois nomes: quem cola "zap" e quem cola "vrsync" chega igual.
feeds.get(["/:token/zap.xml", "/:token/vrsync.xml", "/:token/grupo-olx.xml"], servirFeed(feedVRSync));
feeds.get("/:token/chavesnamao.xml", servirFeed(feedChavesNaMao));

/* ===== LEADS (público) ===== */
export const webhook = Router();
// Alguns portais mandam formulário em vez de JSON; o lead não pode se perder por isso.
webhook.post("/portais/:token", express.urlencoded({ extended: true, limit: "200kb" }), (req, res) => {
  const orgId = orgPorTokenLeads(req.params.token);
  if (!orgId) return res.status(404).json({ error: "Endereço de leads não encontrado." });
  try {
    const out = receberLead(orgId, lerLead(req.body || {}, req.query.portal));
    if (!out.ok) return res.status(out.status || 400).json({ error: out.erro });
    res.json({ ok: true, novo: !!out.novo, repetido: !!out.repetido });
  } catch (e) {
    console.error("[portais] erro ao receber lead:", e.message);
    // 500 faz o portal tentar de novo — que é o que se quer quando o erro é nosso.
    res.status(500).json({ error: "Falha ao registrar o lead." });
  }
});

/* ===== GESTÃO (logado) ===== */
export const gestao = Router();
gestao.use(roles("adm"));

function resposta(req) {
  const cfg = configDaOrg(req.user.org_id);
  const base = baseDe(req);
  return {
    email: cfg.email || "", telefone: cfg.telefone || "",
    feeds: {
      grupo_olx: `${base}/feeds/${cfg.token_feed}/zap.xml`,
      chaves_na_mao: `${base}/feeds/${cfg.token_feed}/chavesnamao.xml`,
    },
    leads_url: `${base}/webhooks/portais/${cfg.token_leads}`,
    situacao: situacaoDaOrg(req.user.org_id),
  };
}

gestao.get("/", (req, res) => res.json(resposta(req)));

gestao.patch("/", (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "E-mail de contato inválido." });
  salvarContato(req.user.org_id, { email, telefone: req.body?.telefone });
  res.json(resposta(req));
});

gestao.post("/token", (req, res) => {
  const qual = req.body?.qual === "leads" ? "leads" : "feed";
  trocarToken(req.user.org_id, qual);
  res.json(resposta(req));
});
