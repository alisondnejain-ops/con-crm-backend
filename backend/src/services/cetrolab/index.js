/* CETROLAB — a ferramenta de sites do ConHub (12/10/2026, pedido do Ali).

   Hoje mora dentro do ConHub, como uma ferramenta da conta. Amanhã vira um
   produto à parte, que quem não é cliente do CRM contrata sozinho. O código
   foi separado pensando nisso:

     services/cetrolab/index.js    o catálogo de modelos e quem pode usar qual
     services/cetrolab/planos.js   os planos que o master cadastra no hub
     services/cetrolab/fonte.js    a ÚNICA porta dos modelos para os dados
     services/cetrolab/modelos/    um arquivo por modelo (o Clássico ainda mora
                                   em services/site.js, onde sempre esteve)

   AS REGRAS DE ACESSO (decisão do Ali):
     - o Clássico é de todo mundo, em todo plano — ninguém perde o site que tem;
     - os modelos premium exigem a ferramenta `cetrolab` (services/recursos.js:
       liberada pelo master ou contratada pelo preço que o master cadastrou).

   E A REGRA QUE PROTEGE O CLIENTE DELE: sem a ferramenta, o site NÃO cai. Ele
   volta a ser desenhado no Clássico, com o mesmo endereço, os mesmos imóveis e
   o mesmo WhatsApp — a escolha de modelo continua guardada e volta sozinha
   quando a ferramenta voltar. Site fora do ar por causa de cobrança seria
   anúncio pago levando para página nenhuma. */
import db from "../../db.js";
import { temRecurso } from "../recursos.js";
import { paginaPortal as portalClassico, paginaImovel as imovelClassico } from "../site.js";
import * as bairros from "./modelos/bairros.js";
import * as editorial from "./modelos/editorial.js";
import * as lancamento from "./modelos/lancamento.js";

/* A ORDEM É A DA VITRINE (pedido do Ali, 12/10/2026): o Bairros primeiro — é o
   que ele achou mais bonito —, depois Editorial e Lançamento, e o Clássico
   por último, como o "padrão, grátis". Os três premium vêm JUNTOS no plano
   Cetrolab: não existe preço por modelo (também pedido dele). */
export const MODELOS = [
  { id: "bairros", nome: "Bairros", premium: true,
    resumo: "Claro e minimalista: a pessoa escolhe o bairro antes do imóvel e vê quanto custa morar em cada um." },
  { id: "editorial", nome: "Editorial", premium: true,
    resumo: "Escuro, como uma revista: um imóvel em destaque na capa, os bairros como coleções e o catálogo como índice numerado." },
  { id: "lancamento", nome: "Lançamento", premium: true,
    resumo: "Escuro, com a capa em tela cheia e os números da imobiliária em destaque. Combina com campanha de anúncio." },
  { id: "classico", nome: "Clássico", premium: false,
    resumo: "A vitrine com busca por tipo, cidade, quartos e valor. O padrão, grátis em todo plano." },
];
const RENDER = {
  classico: { portal: portalClassico, imovel: imovelClassico },
  bairros: { portal: bairros.paginaPortal, imovel: bairros.paginaImovel },
  editorial: { portal: editorial.paginaPortal, imovel: editorial.paginaImovel },
  lancamento: { portal: lancamento.paginaPortal, imovel: lancamento.paginaImovel },
};
export const ehModelo = (id) => MODELOS.some(m => m.id === id);
const modelo = (id) => MODELOS.find(m => m.id === id) || MODELOS.find(m => m.id === "classico");

export const podeUsarModelo = (orgId, id) => !modelo(id).premium || temRecurso(orgId, "cetrolab");

/* O modelo que vai ao ar: o escolhido, se a conta ainda pode usá-lo. */
export function modeloEfetivo(cfg) {
  const escolhido = ehModelo(cfg?.modelo) ? cfg.modelo : "classico";
  return podeUsarModelo(cfg.org_id, escolhido) ? escolhido : "classico";
}

/* Quem desenha a página. `previa` (?previa=bairros no endereço) mostra outro
   modelo sem trocar o do site — é o "experimentar antes de contratar", com
   noindex e a faixa de prévia, então não concorre no Google com o site de verdade. */
export function desenhar(ctx, pagina, arg, previa) {
  const id = previa && ehModelo(previa) ? previa : modeloEfetivo(ctx.cfg);
  const c = previa && ehModelo(previa) && previa !== modeloEfetivo(ctx.cfg) ? { ...ctx, previa } : ctx;
  return RENDER[id][pagina](c, arg);
}

/* Trocar o modelo do site. Devolve `{modelo}` ou `{erro, status}`. */
export function escolherModelo(orgId, id) {
  if (!ehModelo(id)) return { erro: "Modelo desconhecido.", status: 400 };
  if (!podeUsarModelo(orgId, id))
    return { erro: `O modelo ${modelo(id).nome} faz parte do Cetrolab. Contrate a ferramenta para usá-lo.`, status: 402 };
  db.prepare("UPDATE sites SET modelo = ?, atualizado_em = ? WHERE org_id = ?").run(id === "classico" ? null : id, Date.now(), orgId);
  return { modelo: id };
}
