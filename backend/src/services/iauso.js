/* Quanto a IA gastou, e por conta de quem.

   O consumo aparecia só no log do servidor — quantos tokens, sem dizer quem
   clicou. Quem paga a conta pergunta duas coisas: "quanto já usamos" e "quem
   usou". Sem registro, nenhuma das duas tinha resposta.

   O que fica guardado é só número: tokens e custo. Nem a conversa nem o resumo
   passam por aqui — o texto do cliente não precisa ser copiado para um
   relatório de gasto.

   O custo é gravado NO MOMENTO do uso. Preço de tabela muda, e relatório que
   recalcula o passado com o preço de hoje conta uma história que não
   aconteceu. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { modeloIA } from "./ia.js";

/* Preço por MILHÃO de tokens, em dólar. Fonte: tabela pública da Anthropic.
   O modelo padrão é o Haiku, que é o barato; se alguém trocar o modelo por
   variável de ambiente, o preço desconhecido vira custo zero em vez de um
   número inventado — e a tela avisa. */
const PRECOS = {
  "claude-haiku-4-5-20251001": { entrada: 1, saida: 5 },
  "claude-haiku-4-5": { entrada: 1, saida: 5 },
  "claude-sonnet-5": { entrada: 3, saida: 15 },
  "claude-opus-5": { entrada: 5, saida: 25 },
};

export function custoDe(uso, modelo) {
  const p = PRECOS[modelo];
  if (!p || !uso) return 0;
  return ((uso.entrada || 0) * p.entrada + (uso.saida || 0) * p.saida) / 1e6;
}

/* Nunca lança: a IA já respondeu ao usuário quando isto roda. Falhar em gravar
   a estatística não pode transformar um resumo entregue em erro na tela. */
export function registrar({ orgId, userId, leadId, recurso, uso }) {
  try {
    if (!orgId || !uso) return;
    const modelo = modeloIA();
    db.prepare(`INSERT INTO ia_uso
      (id,org_id,user_id,lead_id,recurso,modelo,tokens_entrada,tokens_saida,custo_usd,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run("iu_" + randomUUID(), orgId, userId || null, leadId || null, recurso, modelo,
        uso.entrada || 0, uso.saida || 0, custoDe(uso, modelo), Date.now());
  } catch (e) {
    console.warn("[ia] não consegui registrar o consumo:", e.message);
  }
}

const ROTULOS = { resumo: "Resumo da conversa", print_simulacao: "Leitura do print da Caixa" };

/* O painel de consumo: total da imobiliária, por pessoa e por recurso.

   `desde` limita a janela (padrão: 30 dias). O "hoje" e o "mês" saem juntos
   porque a pergunta real nunca é só uma das duas — é "está acelerando?". */
export function resumoDeUso(orgId, dias = 30) {
  const desde = Date.now() - dias * 86400000;
  const inicioDoDia = new Date(); inicioDoDia.setHours(0, 0, 0, 0);

  const som = (sql, ...a) => db.prepare(sql).get(orgId, ...a) || {};
  const total = som(`SELECT COUNT(*) usos, COALESCE(SUM(tokens_entrada),0) entrada,
    COALESCE(SUM(tokens_saida),0) saida, COALESCE(SUM(custo_usd),0) custo
    FROM ia_uso WHERE org_id = ? AND created_at >= ?`, desde);
  const hoje = som(`SELECT COUNT(*) usos, COALESCE(SUM(custo_usd),0) custo
    FROM ia_uso WHERE org_id = ? AND created_at >= ?`, inicioDoDia.getTime());
  const sempre = som(`SELECT COUNT(*) usos, COALESCE(SUM(custo_usd),0) custo
    FROM ia_uso WHERE org_id = ?`);

  const porPessoa = db.prepare(`
    SELECT u.name AS nome, u.role AS papel, COUNT(*) usos,
      COALESCE(SUM(i.custo_usd),0) custo, MAX(i.created_at) ultimo
    FROM ia_uso i LEFT JOIN users u ON u.id = i.user_id
    WHERE i.org_id = ? AND i.created_at >= ?
    GROUP BY i.user_id ORDER BY usos DESC`).all(orgId, desde)
    .map(l => ({ ...l, nome: l.nome || "Conta removida", custo: +l.custo.toFixed(4) }));

  const porRecurso = db.prepare(`
    SELECT recurso, COUNT(*) usos, COALESCE(SUM(custo_usd),0) custo
    FROM ia_uso WHERE org_id = ? AND created_at >= ?
    GROUP BY recurso ORDER BY usos DESC`).all(orgId, desde)
    .map(l => ({ ...l, rotulo: ROTULOS[l.recurso] || l.recurso, custo: +l.custo.toFixed(4) }));

  return {
    dias, modelo: modeloIA(),
    // Preço só aparece quando é conhecido — melhor dizer que não sabe.
    preco_conhecido: !!PRECOS[modeloIA()],
    total: { ...total, custo: +(total.custo || 0).toFixed(4) },
    hoje: { ...hoje, custo: +(hoje.custo || 0).toFixed(4) },
    sempre: { ...sempre, custo: +(sempre.custo || 0).toFixed(4) },
    por_pessoa: porPessoa,
    por_recurso: porRecurso,
  };
}
