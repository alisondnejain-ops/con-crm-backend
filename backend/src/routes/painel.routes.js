/* API DO PAINEL DE GESTAO (28/08/2026).

   Quatro leituras, todas com os mesmos filtros: o painel, o funil de um
   pipeline, as campanhas e as opções que a tela oferece.

   SO QUEM SUPERVISIONA. O corretor tem a produtividade dele em Relatórios; o
   painel aqui mostra a equipe inteira, quem está atrasado e quanto cada um
   produziu. Isso é leitura de gestão, e abrir para todos transformaria o CRM
   num ranking público entre colegas — que é outra decisão, e não foi tomada. */

import { Router } from "express";
import { authRequired, supervisiona } from "../auth.js";
import { painel, funil, campanhas, opcoesDeFiltro, atividades, resolverPeriodo } from "../services/painel.js";

const r = Router();
r.use(authRequired, (req, res, next) => supervisiona(req.user)
  ? next()
  : res.status(403).json({ error: "O painel de gestão é da supervisão." }));

/* Os filtros chegam pela query e vão inteiros para o serviço. Cada rota é uma
   leitura diferente da MESMA peneira — foi o descasamento corrigido em
   13/08/2026 no score, quando duas telas usavam períodos diferentes e
   ninguém conseguia dizer qual número estava certo. */
const filtrosDe = (q) => ({
  periodo: q.periodo, de: q.de, ate: q.ate,
  pipeline_id: q.pipeline_id, stage_id: q.stage_id,
  responsavel: q.responsavel, origem: q.origem, source: q.source,
  campanha: q.campanha, campaign_id: q.campaign_id, produto_id: q.produto_id,
});

r.get("/", (req, res) => res.json(painel(req.user.org_id, filtrosDe(req.query))));

r.get("/opcoes", (req, res) => res.json(opcoesDeFiltro(req.user.org_id)));

r.get("/equipe", (req, res) => {
  const f = filtrosDe(req.query);
  res.json({ periodo: resolverPeriodo(f), equipe: atividades(req.user.org_id, resolverPeriodo(f), f) });
});

r.get("/funil/:pipelineId", (req, res) => {
  const d = funil(req.user.org_id, req.params.pipelineId, filtrosDe(req.query));
  if (d.erro) return res.status(404).json({ error: d.erro });
  res.json(d);
});

r.get("/campanhas", (req, res) => res.json(campanhas(req.user.org_id, filtrosDe(req.query))));

export default r;
