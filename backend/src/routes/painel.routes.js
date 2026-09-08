/* API DO PAINEL DE GESTAO (28/08/2026).

   Quatro leituras, todas com os mesmos filtros: o painel, o funil de um
   pipeline, as campanhas e as opções que a tela oferece.

   SO QUEM SUPERVISIONA, com UMA exceção. O painel mostra a equipe inteira,
   quem está atrasado e quanto cada um produziu: isso é leitura de gestão, e
   abrir para todos transformaria o CRM num ranking público entre colegas —
   que é outra decisão, e não foi tomada.

   A exceção é `/funil/:pipelineId`, e o porquê está escrito lá embaixo. */

import { Router } from "express";
import { authRequired, supervisiona } from "../auth.js";
import { painel, funil, campanhas, opcoesDeFiltro, atividades, resolverPeriodo } from "../services/painel.js";
import { visaoGeral, metasComRealizado, metasConfig, salvarMeta, mesAtual } from "../services/painel-geral.js";

const r = Router();
r.use(authRequired);

const soGestao = (req, res, next) => supervisiona(req.user)
  ? next()
  : res.status(403).json({ error: "O painel de gestão é da supervisão." });

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

r.get("/", soGestao, (req, res) => res.json(painel(req.user.org_id, filtrosDe(req.query))));

r.get("/opcoes", soGestao, (req, res) => res.json(opcoesDeFiltro(req.user.org_id)));

r.get("/equipe", soGestao, (req, res) => {
  const f = filtrosDe(req.query);
  res.json({ periodo: resolverPeriodo(f), equipe: atividades(req.user.org_id, resolverPeriodo(f), f) });
});

/* O FUNIL É A EXCEÇÃO DESTA PÁGINA — o corretor vê o DELE (08/09/2026).

   O resto do painel continua sendo da supervisão: ele descreve a equipe, quem
   está atrasado e quanto cada um produziu. Este aqui é o único que responde
   uma pergunta que também é do corretor: "onde estão os meus leads, e há
   quanto tempo estão parados aí".

   A trava não é esconder a rota, é FORÇAR o filtro: quem não supervisiona sai
   daqui com `responsavel` sobrescrito pelo próprio id, e o que ele mandar na
   query é descartado. Confiar no filtro que chega do navegador seria dar a
   qualquer corretor o funil do colega trocando um parâmetro no endereço.

   Sem isso, a mesma tela teria duas versões: a do gestor, com tempo por etapa,
   e a do corretor, sem — e tela que muda de conteúdo conforme quem abre é
   exatamente o defeito que custou esta semana inteira de conserto. */
r.get("/funil/:pipelineId", (req, res) => {
  const f = filtrosDe(req.query);
  if (!supervisiona(req.user)) f.responsavel = req.user.id;
  const d = funil(req.user.org_id, req.params.pipelineId, f);
  if (d.erro) return res.status(404).json({ error: d.erro });
  res.json(d);
});

r.get("/campanhas", soGestao, (req, res) => res.json(campanhas(req.user.org_id, filtrosDe(req.query))));

/* A TELA DE ENTRADA — mesma exceção do /funil acima, e pelo mesmo motivo:
   isto não é "como está a equipe", é "como estão OS MEUS números" quando
   quem pergunta é o corretor. A trava é a mesma — sobrescreve o filtro que
   chegou, nunca confia nele. */
r.get("/geral", (req, res) => {
  const f = filtrosDe(req.query);
  if (!supervisiona(req.user)) f.responsavel = req.user.id;
  const dados = visaoGeral(req.user.org_id, f);
  const alvo = f.responsavel && f.responsavel !== "fila" ? f.responsavel : null;
  dados.metas = metasComRealizado(req.user.org_id, alvo, mesAtual());
  res.json(dados);
});

/* METAS: LER e ESCREVER são só da gestão — é ela quem combina o número do
   mês, para a casa inteira ou para um corretor. O corretor vê a PRÓPRIA meta
   já dentro de `/geral`, sem rota separada: ele não configura, só acompanha. */
r.get("/metas", soGestao, (req, res) => res.json(metasConfig(req.user.org_id, req.query.mes)));

r.post("/metas", soGestao, (req, res) => {
  const { user_id, mes, ...dados } = req.body || {};
  const r1 = salvarMeta(req.user.org_id, user_id || null, mes || mesAtual(), dados);
  if (r1.erro) return res.status(400).json({ error: r1.erro });
  res.json(r1);
});

export default r;
