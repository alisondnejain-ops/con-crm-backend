/* ESPELHO DE LOTES (11/11/2026) — regras em services/lotes.js.

   Só existe na conta com o modo empreendimento ligado pelo master; nas outras
   a rota responde 404, como se não existisse. Quem pode o quê (reservar,
   liberar, vender, editar) é decidido no serviço, num lugar só. */
import { Router } from "express";
import { authRequired, roles } from "../auth.js";
import { ehEmpreendimento, listar, reservar, liberar, prorrogar, vender, editar, historico, importar, salvarConfig, ErroLote } from "../services/lotes.js";

const r = Router();
r.use(authRequired);
r.use((req, res, next) => ehEmpreendimento(req.user.org_id) ? next()
  : res.status(404).json({ error: "Esta conta não usa o espelho de lotes." }));

const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    if (e instanceof ErroLote) return res.status(e.status).json({ error: e.message });
    console.error("[lotes]", e);
    res.status(500).json({ error: "Não consegui concluir. Tente de novo." });
  }
};

r.get("/", responder(req => listar(req.user.org_id, req.user)));
r.patch("/config", roles("adm"), responder(req => ({ config: salvarConfig(req.user.org_id, req.body || {}) })));
r.post("/importar", responder(req => importar(req.user.org_id, req.user, req.body?.texto, { previa: !!req.body?.previa })));
r.get("/:id/historico", responder(req => ({ historico: historico(req.user.org_id, req.user, req.params.id) })));
r.post("/:id/reservar", responder(req => reservar(req.user.org_id, req.user, req.params.id, req.body || {})));
r.post("/:id/liberar", responder(req => liberar(req.user.org_id, req.user, req.params.id)));
r.post("/:id/prorrogar", responder(req => prorrogar(req.user.org_id, req.user, req.params.id, req.body?.horas)));
r.post("/:id/vender", responder(req => vender(req.user.org_id, req.user, req.params.id, req.body || {})));
r.patch("/:id", responder(req => editar(req.user.org_id, req.user, req.params.id, req.body || {})));

export default r;
