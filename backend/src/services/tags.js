/* TAGS DO LEAD (08/09/2026).

   A marcação livre que faltava. Etapa é uma só e anda em ordem; campo tem um
   valor por lead; observação é texto que ninguém consegue filtrar. A tag é o
   que sobra: "investidor", "indicação da Marina", "só financia", "não
   perturbe" — várias por lead, e feitas para serem FILTRADAS.

   É também a peça que o motor de automação vai pedir primeiro: boa parte das
   ações que o roadmap descreve para ele ("ao entrar nesta etapa, marque X",
   "quem tem a tag Y não recebe") não existe sem isto aqui.

   QUEM PODE O QUÊ, e a divisão não é a mesma dos campos personalizados:

   - CRIAR e APAGAR a definição é da supervisão. Tag nova é vocabulário da
     casa, e vocabulário que qualquer um inventa vira trinta maneiras de
     escrever a mesma coisa ("investidor", "Investidor", "invest");
   - MARCAR e DESMARCAR num lead é de quem pode abrir aquela conversa — o dono
     e a supervisão. Quem está atendendo é quem descobre que o cliente é
     investidor, e ter que pedir para a gestão marcar seria o mesmo que não
     ter a tag. */

import { randomUUID } from "crypto";
import db from "../db.js";

/* A PALETA É FECHADA, e isso é decisão, não preguiça.

   Cor escolhida a esmo num seletor livre produz amarelo ilegível e dois tons
   de azul que ninguém distingue — e a tag existe justamente para ser lida de
   relance. Estas sete passaram no teste de daltonismo como paleta categórica
   (o pior par adjacente fica em ΔE 9.1 sob protanopia, acima do piso de 8).

   O coral do sistema (#E1553A) ficou de fora de propósito: ele é o sinal de
   urgência do CRM — cronômetro estourado, tarefa vencida —, e uma tag daquela
   cor faria "não perturbe" parecer um alerta. Mesma razão pela qual a cor da
   barra da marca não pode pintar a tela inteira. */
export const CORES_TAG = [
  "#0E8F6E", // esmeralda
  "#D97706", // âmbar
  "#2563EB", // azul
  "#DB2777", // rosa
  "#65A30D", // verde-limão
  "#7C3AED", // roxo
  "#0891B2", // ciano
];

/* Teto por imobiliária. Não é economia de banco: é que uma lista de duzentas
   tags deixa de ser vocabulário e vira um campo de texto com passos extras —
   ninguém acha a tag certa, todo mundo cria outra. */
export const TETO_TAGS = 60;

const agora = () => Date.now();
const limpo = (t) => String(t || "").trim().replace(/\s+/g, " ").slice(0, 40);
// Comparação sem diferenciar maiúscula e acento: "Investidor" e "investidor"
// são a mesma tag, e deixar as duas existirem é o começo da bagunça.
const chave = (t) => limpo(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function listarTags(orgId) {
  return db.prepare(`
    SELECT t.id, t.nome, t.cor, t.created_at,
           (SELECT COUNT(*) FROM lead_tags lt WHERE lt.tag_id = t.id) AS leads
    FROM tags t WHERE t.org_id = ? ORDER BY t.nome COLLATE NOCASE`).all(orgId);
}

export function criarTag(orgId, { nome, cor }, userId) {
  const n = limpo(nome);
  if (!n) return { erro: "A tag precisa de um nome." };
  if (!CORES_TAG.includes(cor)) return { erro: "Escolha uma das cores da lista." };

  const { total } = db.prepare("SELECT COUNT(*) total FROM tags WHERE org_id = ?").get(orgId);
  if (total >= TETO_TAGS)
    return { erro: `Esta conta já tem ${TETO_TAGS} tags. Apague alguma antes de criar outra.` };

  const repetida = db.prepare("SELECT nome FROM tags WHERE org_id = ?").all(orgId)
    .find(t => chave(t.nome) === chave(n));
  if (repetida) return { erro: `Já existe uma tag chamada "${repetida.nome}".` };

  const id = "tag_" + randomUUID().slice(0, 12);
  db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at,criada_por) VALUES (?,?,?,?,?,?)")
    .run(id, orgId, n, cor, agora(), userId || null);
  return { tag: db.prepare("SELECT *, 0 AS leads FROM tags WHERE id = ?").get(id) };
}

export function editarTag(orgId, id, { nome, cor }) {
  const atual = db.prepare("SELECT * FROM tags WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!atual) return { erro: "Tag não encontrada." };
  const n = nome === undefined ? atual.nome : limpo(nome);
  if (!n) return { erro: "A tag precisa de um nome." };
  const c = cor === undefined ? atual.cor : cor;
  if (!CORES_TAG.includes(c)) return { erro: "Escolha uma das cores da lista." };

  const repetida = db.prepare("SELECT id, nome FROM tags WHERE org_id = ? AND id <> ?").all(orgId, id)
    .find(t => chave(t.nome) === chave(n));
  if (repetida) return { erro: `Já existe uma tag chamada "${repetida.nome}".` };

  /* Renomear vale nos leads que já têm a tag, sem tocar em nenhum deles: eles
     apontam para o id, não para o nome. É a vantagem de a definição morar
     separada — o oposto de `leads.stage`, que guarda o nome da etapa e por
     isso obriga a atualizar todos os leads quando alguém a renomeia. */
  db.prepare("UPDATE tags SET nome = ?, cor = ? WHERE id = ?").run(n, c, id);
  return { tag: db.prepare(`SELECT *, (SELECT COUNT(*) FROM lead_tags lt WHERE lt.tag_id = tags.id) AS leads
                            FROM tags WHERE id = ?`).get(id) };
}

/* Apagar é DE VEZ, e leva as marcações junto — diferente do campo
   personalizado, que se desativa guardando o valor.

   A diferença é o que se perde. O campo guarda algo que alguém digitou (um
   orçamento, uma data), e apagá-lo joga fora trabalho. A tag não guarda valor
   nenhum: ela É a marcação. Uma tag "desativada" que continuasse colada em
   quarenta leads seria uma marca invisível na tela e visível no banco — o pior
   dos dois mundos.

   Por isso a tela precisa dizer ANTES em quantos leads ela está, e o servidor
   exige a confirmação explícita quando esse número não é zero. */
export function apagarTag(orgId, id, { confirmar = false } = {}) {
  const t = db.prepare("SELECT * FROM tags WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!t) return { erro: "Tag não encontrada." };
  const { leads } = db.prepare("SELECT COUNT(*) leads FROM lead_tags WHERE tag_id = ?").get(id);
  if (leads > 0 && !confirmar)
    return { precisa_confirmar: true, leads, nome: t.nome,
      erro: `A tag "${t.nome}" está em ${leads} lead(s). Apagar tira a marca de todos eles.` };

  const rodar = db.transaction(() => {
    db.prepare("DELETE FROM lead_tags WHERE tag_id = ?").run(id);
    db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  });
  rodar();
  return { ok: true, apagada: t.nome, leads };
}

export const tagsDoLead = (leadId) => db.prepare(`
  SELECT t.id, t.nome, t.cor FROM lead_tags lt
  JOIN tags t ON t.id = lt.tag_id
  WHERE lt.lead_id = ? ORDER BY t.nome COLLATE NOCASE`).all(leadId);

/* As tags de VÁRIOS leads de uma vez.

   A lista de conversas e o kanban carregam dezenas de leads e recarregam de
   dez em dez segundos. Perguntar as tags lead a lead ali seriam sessenta
   consultas por atualização, em todo aparelho da equipe — o mesmo custo que os
   índices de 27/08 vieram tirar. Aqui é uma consulta só, e a tela distribui. */
export function tagsDeLeads(ids) {
  const mapa = new Map();
  if (!ids || !ids.length) return mapa;
  const marcadores = "?,".repeat(ids.length).slice(0, -1);
  const linhas = db.prepare(`
    SELECT lt.lead_id, t.id, t.nome, t.cor FROM lead_tags lt
    JOIN tags t ON t.id = lt.tag_id
    WHERE lt.lead_id IN (${marcadores}) ORDER BY t.nome COLLATE NOCASE`).all(...ids);
  for (const l of linhas) {
    if (!mapa.has(l.lead_id)) mapa.set(l.lead_id, []);
    mapa.get(l.lead_id).push({ id: l.id, nome: l.nome, cor: l.cor });
  }
  return mapa;
}

export function marcarTag(orgId, leadId, tagId, userId) {
  /* A tag TEM que ser desta imobiliária. O id chega do navegador, e sem esta
     conferência bastaria conhecer o id de uma tag alheia para colá-la num lead
     daqui — e a partir daí ela apareceria na tela sem existir na lista da
     casa, sem ninguém conseguir tirá-la pela tela. */
  const t = db.prepare("SELECT id FROM tags WHERE id = ? AND org_id = ?").get(tagId, orgId);
  if (!t) return { erro: "Essa tag não é desta imobiliária." };
  db.prepare(`INSERT OR IGNORE INTO lead_tags (lead_id,tag_id,org_id,marcada_em,marcada_por)
              VALUES (?,?,?,?,?)`).run(leadId, tagId, orgId, agora(), userId || null);
  return { ok: true, tags: tagsDoLead(leadId) };
}

export function desmarcarTag(orgId, leadId, tagId) {
  db.prepare("DELETE FROM lead_tags WHERE lead_id = ? AND tag_id = ? AND org_id = ?")
    .run(leadId, tagId, orgId);
  return { ok: true, tags: tagsDoLead(leadId) };
}
