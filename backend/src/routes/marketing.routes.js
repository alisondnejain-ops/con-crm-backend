/* MARKETING — rotas da estrutura do disparo em massa (27/09/2026).

   Só o gestor (inclusive o dono de conta autônoma, via `roles`). As travas de
   "liberado" e "termo aceito" moram em services/marketing.js → exigirPronto,
   e não aqui: rota nova chamando o serviço herda as duas sem lembrar delas.
   O disparo em si ainda não existe — é a próxima etapa. */

import { Router } from "express";
import { roles } from "../auth.js";
import {
  ErroMarketing, estado, aceitarTermo, historicoDeAceites, exigirPronto,
  criarLista, listas, arquivoOriginal, arquivarLista,
  bloquear, listaDeBloqueio, salvarNumero, removerNumero,
} from "../services/marketing.js";

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

r.get("/", trata((req, res) => res.json(estado(req.user.org_id, req.user))));

r.post("/termo", trata((req, res) => {
  if (req.body?.aceito !== true) throw new ErroMarketing(400, "Marque que leu e aceita o termo.");
  aceitarTermo(req.user.org_id, req.user, { ip: req.ip, userAgent: req.get("user-agent") });
  res.json(estado(req.user.org_id, req.user));
}));
r.get("/termo/historico", trata((req, res) => res.json({ aceites: historicoDeAceites(req.user.org_id) })));

r.put("/numero", trata(async (req, res) => {
  const numero = await salvarNumero(req.user.org_id, req.user, req.body || {});
  res.json({ ok: true, numero });
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

export default r;
