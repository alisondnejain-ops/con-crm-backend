/* ===== O PRÉ-ATENDIMENTO DA CASA, MEDIDO PELO FUNIL DE SDR =====
   (07/11/2026, pedido do Fernando: "leads recebidos = todos que entraram no
   funil SDR no período", e "qualificado pelo SDR = a etiqueta qualificado SDR
   e a passagem do funil SDR para o braço externo")

   Até aqui o SDR era medido só por PESSOA (a atendente) e pela IA — e o lead
   que chegava pelo formulário, ficava na fila e era qualificado e repassado
   por outra pessoa não aparecia em linha nenhuma: "a gente teve três
   qualificados e três repassados e o relatório diz zero". Esta é a conta da
   ETAPA, não de quem a fez:

   - ENTRARAM: leads que entraram num funil de SDR no período — nasceram nele
     ou foram movidos para ele de outro funil. Sem funil de SDR na conta, o
     pré-atendimento é a FILA: os leads que nasceram sem dono no período.
   - QUALIFICADOS: leads que saíram do funil de SDR para um funil que não é
     de SDR (fora de etapa de perda), ou que ganharam uma etiqueta com
     "qualific" no nome, no período. Um por lead.
   - REPASSADOS AO CORRETOR: trocas de dono para um corretor, no período, de
     lead que estava no funil de SDR, na fila (sem dono) ou com uma atendente.

   Cada conjunto guarda, por lead, o momento e quem fez — é o que deixa a
   linha de uma atendente contar só o que ela fez. */
import db, { emLotes } from "../db.js";
import { ehFunilDeSdr } from "./pipelines.js";
import { alcancesNoPeriodo } from "./marcos.js";

export function preAtendimento(orgId, de, ate, { semEtiqueta = null } = {}) {
  /* Sem dizer, vale a régua da conta: com a fila por etapa ligada
     (orgs.fila_por_etapa), a etiqueta não pré-qualifica. Lido aqui, e não
     importado de fila-etapa.js, porque aquele arquivo importa este. */
  if (semEtiqueta === null) semEtiqueta = !!(db.prepare("SELECT fila_por_etapa f FROM orgs WHERE id = ?").get(orgId) || {}).f;
  const pipes = db.prepare("SELECT id FROM pipelines WHERE org_id = ?").all(orgId).map(p => p.id);
  const sdr = new Set(pipes.filter(id => ehFunilDeSdr(orgId, id)));
  const etapaSdr = new Map(db.prepare("SELECT id, pipeline_id, status_type FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .map(e => [e.id, { sdr: sdr.has(e.pipeline_id), perdido: e.status_type === "perdido" }]));
  const ehSdr = (sid) => !!sid && !!(etapaSdr.get(sid) || {}).sdr;
  const sdrs = new Set(db.prepare("SELECT id FROM users WHERE org_id = ? AND role = 'sdr'").all(orgId).map(u => u.id));
  const corretores = new Set(db.prepare("SELECT id FROM users WHERE org_id = ? AND role = 'corretor'").all(orgId).map(u => u.id));

  const entraram = new Map();
  if (sdr.size) {
    // Nasceram no funil de SDR no período.
    for (const l of db.prepare(`SELECT l.id, l.created_at t, l.stage_id, l.pipeline_id,
        (SELECT e.de_stage_id FROM lead_etapas e WHERE e.lead_id = l.id ORDER BY e.created_at, e.rowid LIMIT 1) primeira_de,
        (SELECT COUNT(*) FROM lead_etapas e WHERE e.lead_id = l.id) n
      FROM leads l WHERE l.org_id = ? AND l.import_id IS NULL AND l.created_at BETWEEN ? AND ?`).all(orgId, de, ate)) {
      const nasceu = l.n ? l.primeira_de : l.stage_id;
      const noSdr = nasceu ? ehSdr(nasceu) : (!l.n && sdr.has(l.pipeline_id));
      if (noSdr) entraram.set(l.id, { t: l.t, user_id: null });
    }
    // Movidos para o funil de SDR vindos de fora dele.
    for (const r of db.prepare(`SELECT lead_id, de_stage_id, para_stage_id, created_at t, user_id FROM lead_etapas
        WHERE org_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at`).all(orgId, de, ate))
      if (ehSdr(r.para_stage_id) && !ehSdr(r.de_stage_id) && !entraram.has(r.lead_id))
        entraram.set(r.lead_id, { t: r.t, user_id: r.user_id || null });
  } else {
    for (const l of db.prepare(`SELECT l.id, l.created_at t FROM leads l WHERE l.org_id = ? AND l.import_id IS NULL
        AND l.created_at BETWEEN ? AND ?
        AND ((NOT EXISTS (SELECT 1 FROM lead_transfers t WHERE t.lead_id = l.id) AND l.assigned_to IS NULL)
          OR (EXISTS (SELECT 1 FROM lead_transfers t WHERE t.lead_id = l.id)
              AND (SELECT t.from_user_id FROM lead_transfers t WHERE t.lead_id = l.id ORDER BY t.created_at, t.rowid LIMIT 1) IS NULL))`)
      .all(orgId, de, ate)) entraram.set(l.id, { t: l.t, user_id: null });
  }

  const qualificados = new Map();
  const marcar = (mapa, lead, t, user) => { if (!mapa.has(lead)) mapa.set(lead, { t, user_id: user || null }); };
  /* Sem funil de SDR, "qualificado pelo pré-atendimento" é chegar a uma etapa
     com "qualific" no nome ("Lead qualificado"). */
  const ehQualific = (nome) => /qualific/i.test(String(nome || "").normalize("NFD").replace(/[̀-ͯ]/g, ""));
  const qualific = new Set(sdr.size ? [] : db.prepare("SELECT id, name FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .filter(e => ehQualific(e.name)).map(e => e.id));
  for (const r of db.prepare(`SELECT lead_id, de_stage_id, para_stage_id, para, created_at t, user_id FROM lead_etapas
      WHERE org_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at`).all(orgId, de, ate)) {
    const para = etapaSdr.get(r.para_stage_id);
    if (ehSdr(r.de_stage_id) && para && !para.sdr && !para.perdido) marcar(qualificados, r.lead_id, r.t, r.user_id);
    else if (!sdr.size && (qualific.has(r.para_stage_id) || (!r.para_stage_id && ehQualific(r.para)))) marcar(qualificados, r.lead_id, r.t, r.user_id);
  }
  /* A etiqueta "qualificado" só conta fora da régua nova (fila por etapa,
     services/fila-etapa.js): lá, pré-qualificar é só o lead sair do SDR. */
  if (!semEtiqueta) for (const r of db.prepare(`SELECT lt.lead_id, lt.marcada_em t, lt.marcada_por user_id, tg.nome FROM lead_tags lt
      JOIN tags tg ON tg.id = lt.tag_id WHERE lt.org_id = ? AND lt.marcada_em BETWEEN ? AND ? ORDER BY lt.marcada_em`).all(orgId, de, ate))
    if (/qualific/i.test(String(r.nome || "").normalize("NFD").replace(/[̀-ͯ]/g, ""))) marcar(qualificados, r.lead_id, r.t, r.user_id);

  const repassados = new Map();
  for (const t of db.prepare(`SELECT lead_id, from_user_id, to_user_id, from_pipeline_id, triggered_by_user_id, created_at t
      FROM lead_transfers WHERE org_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at`).all(orgId, de, ate)) {
    if (!corretores.has(t.to_user_id)) continue;
    const doPre = sdr.has(t.from_pipeline_id) || !t.from_user_id || sdrs.has(t.from_user_id);
    if (doPre) marcar(repassados, t.lead_id, t.t, t.from_user_id || t.triggered_by_user_id);
  }
  // Só leads que ainda existem.
  const existe = new Set(emLotes([...new Set([...entraram.keys(), ...qualificados.keys(), ...repassados.keys()])],
    (m, lote) => db.prepare(`SELECT id FROM leads WHERE org_id = ? AND id IN (${m})`).all(orgId, ...lote)).map(r => r.id));
  for (const mapa of [entraram, qualificados, repassados]) for (const k of [...mapa.keys()]) if (!existe.has(k)) mapa.delete(k);
  return { tem_funil_sdr: sdr.size > 0, entraram, qualificados, repassados };
}

/* "QUALIFICADO", PARA A CASA (07/11/2026). Num período, o lead foi
   qualificado se o SDR o qualificou (saiu do funil de SDR para o comercial,
   ou ganhou a etiqueta) OU se chegou ao marco "qualificado" do comercial
   (Atendimento qualificado, ou pulou direto para mais adiante —
   services/marcos.js). É a régua de Campanhas, do "Por origem" do SDR e do
   número de qualificados da Visão geral: as três telas dizem o mesmo número
   para o mesmo período. Um por lead, no primeiro momento. */
export function qualificadosNoPeriodo(orgId, de, ate, pre = null) {
  const res = new Map((pre || preAtendimento(orgId, de, ate)).qualificados);
  const ids = db.prepare("SELECT DISTINCT lead_id id FROM lead_etapas WHERE org_id = ? AND created_at BETWEEN ? AND ?")
    .all(orgId, de, ate).map(r => r.id);
  for (const a of alcancesNoPeriodo(orgId, ids, "qualificado", de, ate))
    if (!res.has(a.lead) || res.get(a.lead).t > a.t) res.set(a.lead, { t: a.t, user_id: a.user_id });
  return res;
}
