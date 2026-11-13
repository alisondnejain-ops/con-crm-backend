/* METAS DE CONVERSÃO DO CONE (CETRO 16.4). Cada etapa-marco tem duas metas
   INDEPENDENTES: a da etapa anterior e a acumulada desde a entrada — nunca o
   mesmo número nas duas por conveniência. Escopo: a operação (user_id '') ou
   uma pessoa. Uma pessoa sem meta própria herda a da operação (escrito em
   `origem`). Não se mistura com as metas de atividade do Painel. */
import db from "../db.js";

const pctOk = (v) => v === null || v === undefined || v === "" ? null : Number(String(v).replace(",", "."));

export function metasDoFunil(orgId, pipelineId, userId = "") {
  const ler = (u) => new Map(db.prepare("SELECT stage_id, anterior_pct, acumulada_pct FROM metas_conversao WHERE org_id=? AND pipeline_id=? AND user_id=?")
    .all(orgId, pipelineId, u).map(r => [r.stage_id, r]));
  const op = ler(""), pessoa = userId ? ler(userId) : new Map();
  const ids = new Set([...op.keys(), ...pessoa.keys()]);
  const out = {};
  for (const id of ids) {
    const p = pessoa.get(id), o = op.get(id);
    out[id] = {
      anterior: p?.anterior_pct ?? o?.anterior_pct ?? null, acumulada: p?.acumulada_pct ?? o?.acumulada_pct ?? null,
      origem: p && (p.anterior_pct != null || p.acumulada_pct != null) ? "pessoa" : "operacao",
    };
  }
  return out;
}

export function salvarMetas(orgId, pipelineId, userId, lista) {
  if (!db.prepare("SELECT 1 FROM pipelines WHERE id=? AND org_id=?").get(pipelineId, orgId)) return { erro: "Funil não encontrado.", status: 404 };
  if (userId && !db.prepare("SELECT 1 FROM users WHERE id=? AND org_id=?").get(userId, orgId)) return { erro: "Pessoa não encontrada.", status: 404 };
  if (!Array.isArray(lista)) return { erro: "Envie a lista de metas." };
  const etapas = new Set(db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id=?").all(pipelineId).map(r => r.id));
  const prontas = [];
  for (const m of lista) {
    if (!etapas.has(m.stage_id)) return { erro: "Etapa de outro funil." };
    const a = pctOk(m.anterior), c = pctOk(m.acumulada);
    for (const v of [a, c]) if (v != null && (!isFinite(v) || v < 0 || v > 100)) return { erro: "Meta é um percentual entre 0 e 100." };
    prontas.push([m.stage_id, a, c]);
  }
  db.transaction(() => {
    for (const [sid, a, c] of prontas) {
      if (a == null && c == null) db.prepare("DELETE FROM metas_conversao WHERE org_id=? AND pipeline_id=? AND stage_id=? AND user_id=?").run(orgId, pipelineId, sid, userId || "");
      else db.prepare(`INSERT INTO metas_conversao (org_id,pipeline_id,stage_id,user_id,anterior_pct,acumulada_pct,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(org_id,pipeline_id,stage_id,user_id) DO UPDATE SET anterior_pct=excluded.anterior_pct, acumulada_pct=excluded.acumulada_pct, updated_at=excluded.updated_at`)
        .run(orgId, pipelineId, sid, userId || "", a, c, Date.now());
    }
  })();
  return { ok: true, metas: metasDoFunil(orgId, pipelineId, userId || "") };
}
