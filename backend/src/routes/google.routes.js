/* GOOGLE AGENDA (31/10/2026) — regras em services/google-agenda.js. */
import { Router } from "express";
import { authRequired, emitirTokenCurto, verificarTokenCurto } from "../auth.js";
import { googleConfigurado, urlDeLogin, conectar, estado, desconectar } from "../services/google-agenda.js";

const ESCOPO = "google-conectar";
const baseDe = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const retornoDe = (req) => `${baseDe(req)}/conectar-google/retorno`;

export const gestao = Router();   // montado em /google, com login
gestao.use(authRequired);
gestao.get("/estado", (req, res) => res.json(estado(req.user)));
gestao.get("/conectar", (req, res) => {
  if (!googleConfigurado()) return res.status(503).json({ error: "O Google Agenda ainda não está ligado nesta instalação." });
  // A volta do Google é navegação comum, sem o crachá: quem diz de quem é o pedido é o `state` assinado.
  const state = emitirTokenCurto({ id: req.user.id, org_id: req.user.org_id }, ESCOPO);
  res.json({ url: urlDeLogin(state, retornoDe(req)) });
});
gestao.delete("/", async (req, res) => res.json(await desconectar(req.user)));

export const retorno = Router();  // montado em /conectar-google, sem login
retorno.get("/retorno", async (req, res) => {
  const voltar = (q) => res.redirect(`${baseDe(req)}/app?${new URLSearchParams(q)}`);
  const st = verificarTokenCurto(req.query.state, ESCOPO);
  if (!st) return voltar({ google: "erro", motivo: "A conexão demorou demais ou o link não é válido. Clique em Conectar de novo." });
  if (req.query.error === "access_denied") return voltar({ google: "cancelado" });
  if (req.query.error || !req.query.code) return voltar({ google: "erro", motivo: String(req.query.error || "O Google não devolveu a autorização.").slice(0, 200) });
  try {
    await conectar({ id: st.id, org_id: st.org_id }, String(req.query.code), retornoDe(req));
    voltar({ google: "ok" });
  } catch (e) {
    voltar({ google: "erro", motivo: String(e.message).slice(0, 200) });
  }
});
