/* GRUPOS DO WHATSAPP (31/10/2026) — regras em services/grupos.js. */
import { Router } from "express";
import db from "../db.js";
import { authRequired, ehDonoAutonomo } from "../auth.js";
import { gruposVisiveis, mensagensDoGrupo, enviarAoGrupo, ligarGrupos, ErroGrupo } from "../services/grupos.js";
import { garantirWebhook } from "../services/webhook-uazapi.js";

const r = Router();
r.use(authRequired);
const gestor = (u) => u.role === "adm" || ehDonoAutonomo(u);
const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    if (e instanceof ErroGrupo) return res.status(e.status).json({ error: e.message });
    console.error("[grupos]", e);
    res.status(500).json({ error: e.message && /Uazapi|WhatsApp/i.test(e.message) ? e.message : "Não consegui concluir. Tente de novo." });
  }
};

r.get("/", responder(req => gruposVisiveis(req.user)));
// As linhas em que esta pessoa pode ligar os grupos: a da casa (gestor) e a dela.
r.get("/linhas", responder(req => ({
  linhas: db.prepare("SELECT id, tipo, nome, user_id, grupos, provider FROM canais WHERE org_id = ? AND ativo = 1 AND tipo IN ('imobiliaria','corretor')").all(req.user.org_id)
    .filter(c => c.provider !== "meta" && (c.tipo === "imobiliaria" ? gestor(req.user) : c.user_id === req.user.id))
    .map(c => ({ id: c.id, nome: c.tipo === "imobiliaria" ? "Número da imobiliária" : "Meu WhatsApp", grupos: c.grupos === 1 })),
})));
r.post("/linhas/:id", responder(async req => {
  const out = ligarGrupos(req.user, { canalId: req.params.id, ligado: !!req.body?.ligado, gestor: gestor(req.user) });
  // Liga (ou volta a filtrar) os grupos no webhook da instância.
  const c = db.prepare("SELECT tipo FROM canais WHERE id = ?").get(req.params.id);
  const recebimento = await garantirWebhook(req.user.org_id, c.tipo === "imobiliaria" ? null : req.params.id);
  return { ...out, recebimento };
}));
r.get("/:id", responder(req => mensagensDoGrupo(req.user, req.params.id)));
r.post("/:id/mensagens", responder(req => enviarAoGrupo(req.user, req.params.id, req.body?.texto)));

export default r;
