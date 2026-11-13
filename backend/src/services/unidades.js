/* UNIDADES E FLUXO DE PAGAMENTO (CETRO 12.4–12.5, 13/11/2026).

   Empreendimento e loteamento têm várias unidades/lotes, cada uma com
   identificação, tipologia, bloco/quadra, área, situação, MOEDA (BRL ou USD —
   metadado do preço: trocar a moeda não converte nada, e valores de moedas
   diferentes nunca são somados), preço, aluguel e o próprio fluxo:

     sinal (% e nº de parcelas) · mensais (% e quantidade) · reforços (% e
     quantidade) · chaves (%) · saldo a financiar (%)

   O conjunto de percentuais FECHA EM 100% do preço; parcela com percentual
   precisa de quantidade ≥ 1 (nunca divisão por zero). Os valores são
   calculados aqui, no servidor, a partir do preço — a tela mostra o mesmo
   cálculo, mas quem grava é este. Entrada adicional da simulação não é o
   sinal e não mora aqui. */
import { randomUUID } from "crypto";
import db from "../db.js";

export const MOEDAS = ["BRL", "USD"];
export const SITUACOES_UNIDADE = ["disponivel", "reservado", "vendido", "alugado", "indisponivel"];
export const TIPOLOGIAS = ["Studio", "1 quarto", "2 quartos", "3 quartos", "4 quartos", "Garden", "Cobertura", "Lote"];
const PARTES = [["sinal", true], ["mensais", true], ["reforcos", true], ["chaves", false], ["financiar", false]];
const MAX_UNIDADES = 500;

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(String(v).replace(",", ".")));

/* Confere o fluxo e devolve a versão gravável com os valores calculados. */
export function conferirFluxo(preco, f) {
  if (!f || typeof f !== "object") return { fluxo: null };
  const out = {}; let soma = 0, algum = false;
  for (const [k, temQtd] of PARTES) {
    // Aceita o formato do formulário (sinal_pct/sinal_qtd) e o que este mesmo
    // serviço devolve ({sinal:{pct,qtd}}) — reenviar a lista não pode apagar o fluxo.
    const aninhado = f[k] && typeof f[k] === "object" ? f[k] : null;
    if (aninhado) { f = { ...f, [k + "_pct"]: aninhado.pct, [k + "_qtd"]: aninhado.qtd }; }
    const pct = num(f[k + "_pct"]);
    if (pct == null || pct === 0) continue;
    if (!isFinite(pct) || pct < 0 || pct > 100) return { erro: `Percentual de ${rotulo(k)} inválido.` };
    algum = true; soma += pct;
    const parte = { pct };
    if (temQtd) {
      const q = num(f[k + "_qtd"]);
      if (!Number.isInteger(q) || q < 1 || q > 600) return { erro: `Informe a quantidade de parcelas de ${rotulo(k)} (1 a 600).` };
      parte.qtd = q;
    }
    if (preco) { parte.valor = arred(preco * pct / 100); if (parte.qtd) parte.parcela = arred(parte.valor / parte.qtd); }
    out[k] = parte;
  }
  if (!algum) return { fluxo: null };
  if (Math.abs(soma - 100) > 0.01) return { erro: `Os percentuais do fluxo somam ${String(arred(soma)).replace(".", ",")}% — precisam fechar em 100% do preço.` };
  return { fluxo: out };
}
const arred = (v) => Math.round(v * 100) / 100;
const rotulo = (k) => ({ sinal: "sinal", mensais: "mensais", reforcos: "reforços", chaves: "chaves", financiar: "saldo a financiar" }[k]);

export function unidadesDo(produtoId) {
  return db.prepare("SELECT * FROM produto_unidades WHERE produto_id = ? ORDER BY ordem, created_at").all(produtoId).map(u => {
    let fluxo = null; try { fluxo = JSON.parse(u.fluxo_json || "null"); } catch {}
    return { id: u.id, identificacao: u.identificacao, tipologia: u.tipologia, bloco: u.bloco, area: u.area, status: u.status,
      moeda: u.moeda, preco: u.preco, aluguel: u.aluguel, fluxo };
  });
}

/* Grava a lista INTEIRA (o que não veio é apagado); unidade com id mantém o
   id. Adicionar a próxima nunca sobrescreve a anterior. */
export function salvarUnidades(orgId, produtoId, lista) {
  if (!Array.isArray(lista)) return { erro: "Envie a lista de unidades." };
  if (lista.length > MAX_UNIDADES) return { erro: `No máximo ${MAX_UNIDADES} unidades por imóvel.` };
  const prontas = [];
  const vistas = new Set();
  for (const [i, u] of lista.entries()) {
    const n = i + 1;
    const ident = String(u.identificacao || "").trim().slice(0, 40);
    if (!ident) return { erro: `Unidade ${n}: informe a identificação (ex.: Apto 101, Lote 12).` };
    const chave = (String(u.bloco || "").trim() + "|" + ident).toLowerCase();
    if (vistas.has(chave)) return { erro: `Unidade ${n}: "${ident}" aparece duas vezes${u.bloco ? ` no bloco ${u.bloco}` : ""}.` };
    vistas.add(chave);
    const moeda = MOEDAS.includes(u.moeda) ? u.moeda : "BRL";
    const status = SITUACOES_UNIDADE.includes(u.status) ? u.status : "disponivel";
    const preco = num(u.preco), aluguel = num(u.aluguel), area = num(u.area);
    if ([preco, aluguel, area].some(v => v != null && (!isFinite(v) || v < 0))) return { erro: `Unidade ${n}: preço, aluguel ou área inválido.` };
    const f = conferirFluxo(preco, u.fluxo);
    if (f.erro) return { erro: `Unidade ${n} (${ident}): ${f.erro}` };
    prontas.push({ id: u.id ? String(u.id) : null, identificacao: ident, tipologia: String(u.tipologia || "").trim().slice(0, 40) || null,
      bloco: String(u.bloco || "").trim().slice(0, 40) || null, area, status, moeda, preco, aluguel, fluxo: f.fluxo });
  }
  const existentes = new Set(db.prepare("SELECT id FROM produto_unidades WHERE produto_id = ?").all(produtoId).map(r => r.id));
  const agora = Date.now();
  db.transaction(() => {
    const ficam = new Set();
    prontas.forEach((u, ordem) => {
      const fj = u.fluxo ? JSON.stringify(u.fluxo) : null;
      if (u.id && existentes.has(u.id)) {
        db.prepare(`UPDATE produto_unidades SET identificacao=?, tipologia=?, bloco=?, area=?, status=?, moeda=?, preco=?, aluguel=?,
          fluxo_json=?, ordem=?, updated_at=? WHERE id=?`).run(u.identificacao, u.tipologia, u.bloco, u.area, u.status, u.moeda,
          u.preco, u.aluguel, fj, ordem, agora, u.id);
        ficam.add(u.id);
      } else {
        db.prepare(`INSERT INTO produto_unidades (id,org_id,produto_id,identificacao,tipologia,bloco,area,status,moeda,preco,aluguel,
          fluxo_json,ordem,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("un_" + randomUUID(), orgId, produtoId,
          u.identificacao, u.tipologia, u.bloco, u.area, u.status, u.moeda, u.preco, u.aluguel, fj, ordem, agora, agora);
      }
    });
    for (const id of existentes) if (!ficam.has(id)) db.prepare("DELETE FROM produto_unidades WHERE id = ?").run(id);
  })();
  return { ok: true, unidades: unidadesDo(produtoId) };
}

/* O resumo das unidades para o card e a página pública: quantas estão
   disponíveis e o menor preço POR MOEDA (nunca somando moedas). */
export function resumoDasUnidades(produtoId) {
  const us = unidadesDo(produtoId);
  const disp = us.filter(u => u.status === "disponivel");
  const desde = {};
  for (const u of disp) if (u.preco) desde[u.moeda] = Math.min(desde[u.moeda] ?? Infinity, u.preco);
  return { total: us.length, disponiveis: disp.length, desde };
}
