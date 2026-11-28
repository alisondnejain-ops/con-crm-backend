/* A estrutura da equipe (CETRO 23): lê quem supervisiona; grava o gestor. */
import { Router } from "express";
import { authRequired, roles, supervisiona } from "../auth.js";
import { listar, criar, editar, apagar, ajustarPessoa } from "../services/estrutura.js";
import { listarRegras, salvarRegra, apagarRegra, FERRAMENTAS, ESCOPOS, QUEM, alcanceDe, ferramentasDe, padraoFerramentas } from "../services/acesso.js";

const r = Router();
r.use(authRequired);
const resp = (res, x) => x.erro ? res.status(x.status || 400).json({ error: x.erro }) : res.json(x);
r.get("/", (req, res) => supervisiona(req.user) ? res.json(listar(req.user.org_id)) : res.status(403).json({ error: "A estrutura da equipe é da supervisão." }));
r.post("/niveis", roles("adm"), (req, res) => resp(res, criar(req.user.org_id, req.body || {})));
r.patch("/niveis/:id", roles("adm"), (req, res) => resp(res, editar(req.user.org_id, req.params.id, req.body || {})));
r.delete("/niveis/:id", roles("adm"), (req, res) => resp(res, apagar(req.user.org_id, req.params.id)));
r.patch("/pessoas/:id", roles("adm"), (req, res) => resp(res, ajustarPessoa(req.user.org_id, req.params.id, req.body || {})));
/* PERMISSÕES (28/11/2026): regras por pessoa ou por grupo da estrutura. Lê quem supervisiona, grava o gestor. */
r.get("/permissoes", (req, res) => supervisiona(req.user)
  ? res.json({ regras: listarRegras(req.user.org_id), ferramentas: FERRAMENTAS, escopos: ESCOPOS, quem: QUEM,
      padroes: { adm: padraoFerramentas("adm"), sdr: padraoFerramentas("sdr"), corretor: padraoFerramentas("corretor") } })
  : res.status(403).json({ error: "As permissões são da supervisão." }));
r.put("/permissoes", roles("adm"), (req, res) => resp(res, salvarRegra(req.user.org_id, req.body || {}, req.user.id)));
r.delete("/permissoes/:id", roles("adm"), (req, res) => resp(res, apagarRegra(req.user.org_id, req.params.id)));
/* O alcance de quem pergunta: a tela usa para mostrar o dono nos cards e o filtro de pessoas. */
r.get("/meu-alcance", (req, res) => { const a = alcanceDe(req.user); res.json({ tipo: a.tipo, ids: a.ids ? [...a.ids] : null, fila: a.fila, ferramentas: ferramentasDe(req.user) }); });
export default r;
