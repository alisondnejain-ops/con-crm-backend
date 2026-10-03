/* TRIAGEM DE NÚMEROS NOVOS (03/10/2026) — regras em services/triagem.js.

   Quem vê e quem decide é resolvido lá, num lugar só: na linha pessoal, só o
   dono dela; no número da casa, quem supervisiona. Aqui só se traduz o erro. */

import { Router } from "express";
import { authRequired } from "../auth.js";
import { estado, decidir, voltarAReceber, definirTriagem, marcarLeadComoPessoal, ErroTriagem } from "../services/triagem.js";

const r = Router();
r.use(authRequired);

const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    if (e instanceof ErroTriagem) return res.status(e.status).json({ error: e.message });
    console.error("[triagem]", e);
    res.status(500).json({ error: "Não consegui concluir. Tente de novo." });
  }
};

r.get("/", responder(req => estado(req.user.org_id, req.user)));
r.post("/novos/:id", responder(req => decidir(req.user.org_id, req.user, req.params.id, req.body?.decisao)));
r.post("/linhas", responder(req => definirTriagem(req.user.org_id, req.user, req.body?.linha, !!req.body?.ligada)));
r.post("/pessoais/voltar", responder(req => voltarAReceber(req.user.org_id, req.user, req.body?.linha, req.body?.phone)));
r.post("/leads/:id/pessoal", responder(req => {
  // A confirmação vai escrita no corpo: apagar uma conversa não pode
  // acontecer por um clique solto ou uma chamada repetida.
  if (req.body?.confirmar !== "PESSOAL") throw new ErroTriagem(400, "Confirme escrevendo PESSOAL.");
  return marcarLeadComoPessoal(req.user.org_id, req.user, req.params.id);
}));

export default r;
