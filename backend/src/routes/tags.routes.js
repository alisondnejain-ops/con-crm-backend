/* API DAS TAGS (08/09/2026).

   Duas permissões diferentes no mesmo arquivo, e a diferença é o ponto:

   - a DEFINIÇÃO (criar, renomear, apagar) é da supervisão, porque tag é o
     vocabulário da casa;
   - a MARCAÇÃO num lead é de quem pode abrir aquele lead, pela mesma regra
     das observações: quem está atendendo é quem descobre que aquele cliente é
     investidor.

   As rotas de marcar/desmarcar vivem em `leads.routes.js`, junto das outras
   coisas que se fazem COM um lead — aqui ficam só as da definição. */

import { Router } from "express";
import { authRequired, supervisiona } from "../auth.js";
import { listarTags, criarTag, editarTag, apagarTag, CORES_TAG, TETO_TAGS } from "../services/tags.js";

const r = Router();
r.use(authRequired);

/* LER é de todo mundo que está logado, de propósito: o corretor precisa da
   lista para marcar o lead dele e para filtrar o próprio funil. Esconder a
   lista dele só faria a tela quebrar sem motivo. */
r.get("/", (req, res) => {
  res.json({ tags: listarTags(req.user.org_id), cores: CORES_TAG, teto: TETO_TAGS });
});

const soGestao = (req, res, next) => supervisiona(req.user)
  ? next()
  : res.status(403).json({ error: "Só a gestão cria e apaga tag." });

/* A recusa sai como `error`, e não como `erro`.

   O serviço fala português e o protocolo fala inglês: o `api()` do navegador
   lê `data.error` e, sem a tradução aqui, toda recusa chegava na tela como a
   frase genérica "erro ao falar com o servidor" — a mensagem escrita com
   cuidado ("já existe uma tag chamada Investidor") morria no caminho. Mesmo
   `ok()` de `pipelines.routes.js`. Os campos extras seguem junto: a tela
   precisa deles para perguntar antes de apagar. */
const resposta = (res, r1) => r1.erro
  ? res.status(r1.precisa_confirmar ? 409 : 400)
      .json({ error: r1.erro, precisa_confirmar: r1.precisa_confirmar, leads: r1.leads, nome: r1.nome })
  : res.json(r1);

r.post("/", soGestao, (req, res) =>
  resposta(res, criarTag(req.user.org_id, req.body || {}, req.user.id)));

r.patch("/:id", soGestao, (req, res) =>
  resposta(res, editarTag(req.user.org_id, req.params.id, req.body || {})));

/* O `?confirmar=1` não é burocracia: sem ele, apagar uma tag usada em quarenta
   leads tiraria a marca dos quarenta em silêncio. A primeira chamada volta 409
   dizendo em quantos ela está; a tela mostra o número e pergunta. */
r.delete("/:id", soGestao, (req, res) =>
  resposta(res, apagarTag(req.user.org_id, req.params.id, { confirmar: req.query.confirmar === "1" })));

export default r;
