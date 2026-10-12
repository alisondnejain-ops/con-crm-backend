/* A FONTE DE DADOS DOS MODELOS DO CETROLAB (12/10/2026).

   O Cetrolab vai virar um produto à parte (pedido do Ali): quem contratar só o
   site não terá o CRM. Por isso o que um modelo precisa saber do catálogo
   passa por AQUI — e não por consultas espalhadas pelos templates. No dia da
   separação, é este arquivo (e as funções de catálogo de services/site.js)
   que troca de fonte; os modelos não mudam.

   O que um modelo pode ler é sempre a LISTA BRANCA do imóvel (`publico()` em
   services/site.js): nunca a linha do banco, que guarda comissão, captador e
   observações internas. */
import db from "../../db.js";
import { catalogo, filtrosDe, imovelDoSite } from "../site.js";

export { catalogo, filtrosDe, imovelDoSite };

/* Os bairros do catálogo disponível, com quantos imóveis e o menor preço de
   venda e de aluguel de cada um — é o que o modelo Bairros mostra no painel.
   Imóvel sem bairro preenchido não entra aqui (continua na lista geral). */
export function bairrosDoCatalogo(orgId) {
  return db.prepare(`SELECT bairro, MIN(cidade) AS cidade, COUNT(*) AS total,
      MIN(CASE WHEN COALESCE(finalidade,'venda') = 'venda' AND valor > 0 THEN valor END) AS venda_desde,
      MIN(CASE WHEN finalidade = 'aluguel' AND valor > 0 THEN valor END) AS aluguel_desde
    FROM produtos WHERE org_id = ? AND status = 'ativo' AND bairro IS NOT NULL AND TRIM(bairro) <> ''
    GROUP BY bairro ORDER BY total DESC, bairro LIMIT 40`).all(orgId);
}
