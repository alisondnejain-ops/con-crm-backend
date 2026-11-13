/* A estrutura da equipe (CETRO 23): lê quem supervisiona; grava o gestor. */
import { Router } from "express";
import { authRequired, roles, supervisiona } from "../auth.js";
import { listar, criar, editar, apagar, ajustarPessoa } from "../services/estrutura.js";

const r = Router();
r.use(authRequired);
const resp = (res, x) => x.erro ? res.status(x.status || 400).json({ error: x.erro }) : res.json(x);
r.get("/", (req, res) => supervisiona(req.user) ? res.json(listar(req.user.org_id)) : res.status(403).json({ error: "A estrutura da equipe é da supervisão." }));
r.post("/niveis", roles("adm"), (req, res) => resp(res, criar(req.user.org_id, req.body || {})));
r.patch("/niveis/:id", roles("adm"), (req, res) => resp(res, editar(req.user.org_id, req.params.id, req.body || {})));
r.delete("/niveis/:id", roles("adm"), (req, res) => resp(res, apagar(req.user.org_id, req.params.id)));
r.patch("/pessoas/:id", roles("adm"), (req, res) => resp(res, ajustarPessoa(req.user.org_id, req.params.id, req.body || {})));
export default r;
