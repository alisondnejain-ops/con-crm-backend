/* AÇÕES EM LOTE SOBRE LEADS ESCOLHIDOS (CETRO 22.2, 13/11/2026).

   Três escolhas INDEPENDENTES, cada uma com "manter":
   - responsável: manter, ou uma pessoa ativa da equipe;
   - funil: manter, ou mover para outro funil — cada etapa de origem precisa
     de um destino; o que tem o mesmo nome casa sozinho, o resto a pessoa
     escolhe. Nunca cai na primeira etapa em silêncio;
   - etapa: manter, ou uma etapa só (do funil de destino, ou do funil comum
     aos leads quando o funil não muda).

   Antes de aplicar, a PRÉVIA mostra cada mudança (lead, de onde, para onde) e
   uma assinatura; aplicar exige a mesma assinatura (o que foi conferido é o
   que roda) e uma trava por conta impede a mesma operação duas vezes ao mesmo
   tempo. Ficam de fora: venda registrada e lead anonimizado (o motivo vai
   escrito). A troca de dono passa por `trocarResponsavel` (histórico, aviso,
   mensagens agendadas do dono antigo canceladas); a etapa, por `moverEtapa`
   (histórico de etapas), sem disparar automações — mudança em massa nunca
   dispara (regra de 03/10/2026). */
import { createHash } from "node:crypto";
import db, { emLotes } from "../db.js";
import { moverEtapa } from "./etapas.js";
import { trocarResponsavel } from "./movimento.js";
import { avisar } from "./push.js";

const LIMITE = 5000;
const chave = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const EM_CURSO = new Set();

function carregar(orgId, ids) {
  return emLotes([...new Set(ids)], (marcas, lote) => db.prepare(`SELECT l.id, l.name, l.assigned_to, l.pipeline_id, l.stage_id, l.stage, l.sale_date, l.anonimizado_em
      FROM leads l WHERE l.org_id = ? AND l.id IN (${marcas})`).all(orgId, ...lote));
}

export function previaLote(orgId, pedido = {}) {
  const ids = Array.isArray(pedido.ids) ? pedido.ids.map(String) : [];
  if (!ids.length) return { erro: "Escolha ao menos um lead." };
  if (ids.length > LIMITE) return { erro: `No máximo ${LIMITE} leads por vez.` };
  const resp = pedido.responsavel || { acao: "manter" }, funil = pedido.funil || { acao: "manter" }, etapa = pedido.etapa || { acao: "manter" };
  if (resp.acao === "manter" && funil.acao === "manter" && etapa.acao === "manter") return { erro: "Escolha o que mudar: responsável, funil ou etapa." };

  const nomes = new Map(db.prepare("SELECT id, name, status, role FROM users WHERE org_id = ?").all(orgId).map(u => [u.id, u]));
  let novoDono = null;
  if (resp.acao === "pessoa") {
    const u = nomes.get(String(resp.user_id || ""));
    if (!u || u.status !== "ativo") return { erro: "Escolha uma pessoa ativa da equipe." };
    novoDono = u.id;
  }
  const etapas = new Map(db.prepare("SELECT id, name, pipeline_id, is_active FROM pipeline_stages WHERE org_id = ?").all(orgId).map(e => [e.id, e]));
  const funis = new Map(db.prepare("SELECT id, name, is_active FROM pipelines WHERE org_id = ?").all(orgId).map(p => [p.id, p]));

  const todos = carregar(orgId, ids);
  const fora = [], validos = [];
  for (const l of todos) {
    if (l.anonimizado_em) fora.push({ id: l.id, nome: l.name, motivo: "anonimizado (LGPD)" });
    else if (l.sale_date) fora.push({ id: l.id, nome: l.name, motivo: "tem venda registrada" });
    else validos.push(l);
  }
  const naoEncontrados = ids.length - todos.length;

  let destinoFunil = null, mapa = {};
  const faltam = [];
  if (funil.acao === "mover") {
    destinoFunil = funis.get(String(funil.pipeline_id || ""));
    if (!destinoFunil || !destinoFunil.is_active) return { erro: "Escolha um funil de destino ativo." };
    const doDestino = [...etapas.values()].filter(e => e.pipeline_id === destinoFunil.id && e.is_active);
    if (etapa.acao !== "etapa") {
      const enviado = funil.mapa || {};
      for (const sid of new Set(validos.map(l => l.stage_id || "sem"))) {
        const e = etapas.get(sid);
        if (e && e.pipeline_id === destinoFunil.id) { mapa[sid] = sid; continue; }
        const escolhido = enviado[sid] && etapas.get(enviado[sid]);
        if (escolhido && escolhido.pipeline_id === destinoFunil.id && escolhido.is_active) { mapa[sid] = escolhido.id; continue; }
        const mesmo = e && doDestino.find(d => chave(d.name) === chave(e.name));
        if (mesmo) { mapa[sid] = mesmo.id; continue; }
        faltam.push({ origem: sid, nome: e ? e.name : (validos.find(l => (l.stage_id || "sem") === sid)?.stage || "Sem etapa"),
          funil: e ? funis.get(e.pipeline_id)?.name || "" : "", leads: validos.filter(l => (l.stage_id || "sem") === sid).length });
      }
    }
  }
  let etapaUnica = null;
  if (etapa.acao === "etapa") {
    etapaUnica = etapas.get(String(etapa.stage_id || ""));
    if (!etapaUnica || !etapaUnica.is_active) return { erro: "Escolha uma etapa ativa." };
    if (destinoFunil && etapaUnica.pipeline_id !== destinoFunil.id) return { erro: "A etapa escolhida não é do funil de destino." };
    if (!destinoFunil) {
      const outros = validos.filter(l => l.pipeline_id !== etapaUnica.pipeline_id).length;
      if (outros) return { erro: `${outros} lead(s) estão em outro funil — para mandá-los a esta etapa, escolha também "mover para o funil ${funis.get(etapaUnica.pipeline_id)?.name || ""}".` };
    }
  }

  const linhas = validos.map(l => {
    let para = null;
    if (etapaUnica) para = etapaUnica.id;
    else if (destinoFunil) para = mapa[l.stage_id || "sem"] || null;
    const mudaEtapa = para && para !== l.stage_id;
    const mudaDono = novoDono && novoDono !== l.assigned_to;
    return { id: l.id, nome: l.name,
      de: { dono: l.assigned_to ? nomes.get(l.assigned_to)?.name || "—" : "na fila", etapa: etapas.get(l.stage_id)?.name || l.stage || "—", funil: funis.get(l.pipeline_id)?.name || "—" },
      para: { dono: mudaDono ? nomes.get(novoDono).name : null, etapa: mudaEtapa ? etapas.get(para).name : null, funil: mudaEtapa ? funis.get(etapas.get(para).pipeline_id)?.name : null },
      _etapa: mudaEtapa ? para : null, _dono: mudaDono ? novoDono : null };
  });
  const mudam = linhas.filter(x => x._etapa || x._dono);
  const agendadas = novoDono ? db.prepare(`SELECT COUNT(*) n FROM mensagens_agendadas WHERE status='pendente' AND lead_id IN (SELECT value FROM json_each(?)) AND user_id <> ?`)
    .get(JSON.stringify(mudam.filter(x => x._dono).map(x => x.id)), novoDono).n : 0;
  const assinatura = createHash("sha256").update(JSON.stringify([orgId, [...ids].sort(), resp, funil.acao, funil.pipeline_id || null, mapa, etapa])).digest("hex").slice(0, 24);
  return {
    total_pedido: ids.length, mudam: mudam.length, sem_mudanca: linhas.length - mudam.length, fora, nao_encontrados: naoEncontrados,
    faltam_mapear: faltam, pode_aplicar: !faltam.length && mudam.length > 0,
    consequencias: [
      novoDono ? `${mudam.filter(x => x._dono).length} lead(s) mudam de responsável — fica no histórico de cada um e a pessoa recebe um aviso.` : null,
      agendadas ? `${agendadas} mensagem(ns) agendada(s) pelo dono antigo serão canceladas.` : null,
      mudam.some(x => x._etapa) ? `${mudam.filter(x => x._etapa).length} lead(s) mudam de etapa${destinoFunil ? ` (para o funil ${destinoFunil.name})` : ""}; automações das etapas não disparam em mudança em massa.` : null,
      funil.acao === "manter" && novoDono ? "O funil e a etapa de cada lead ficam como estão." : null,
    ].filter(Boolean),
    linhas: mudam.slice(0, 200).map(({ _etapa, _dono, ...x }) => x),
    assinatura, _aplicar: mudam,
  };
}

export function aplicarLote(orgId, quem, pedido = {}) {
  if (EM_CURSO.has(orgId)) return { erro: "Já existe uma ação em lote rodando nesta conta. Espere terminar.", status: 409 };
  const p = previaLote(orgId, pedido);
  if (p.erro) return p;
  if (pedido.assinatura !== p.assinatura) return { erro: "A seleção ou as escolhas mudaram desde a prévia. Confira a prévia de novo.", status: 409 };
  if (!p.pode_aplicar) return { erro: p.faltam_mapear.length ? "Escolha o destino de cada etapa antes de aplicar." : "Nada a mudar." };
  EM_CURSO.add(orgId);
  let donos = 0, etapas = 0;
  const porPessoa = {};
  try {
    for (const x of p._aplicar) {
      db.transaction(() => {
        if (x._dono) { if (trocarResponsavel(x.id, x._dono, quem, "lote", { manterFunil: true })) { donos++; porPessoa[x._dono] = (porPessoa[x._dono] || 0) + 1; } }
        if (x._etapa) { if (moverEtapa({ leadId: x.id, paraEtapaId: x._etapa, motivo: "mao", userId: quem, gatilhos: false })) etapas++; }
      })();
    }
  } finally { EM_CURSO.delete(orgId); }
  for (const [uid, n] of Object.entries(porPessoa))
    avisar(uid, { titulo: `${n} lead(s) passados para você`, corpo: "A gestão reorganizou a carteira. Estão na sua caixa." }).catch(() => {});
  console.log(`[lote] ação em lote: ${donos} troca(s) de dono, ${etapas} mudança(s) de etapa`);
  return { ok: true, donos, etapas, fora: p.fora.length };
}
