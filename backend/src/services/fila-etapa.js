/* ===== A FILA É A PRIMEIRA ETAPA DO FUNIL (11/11/2026) =====

   Pedido do Fernando ("Etapa 01 — Correção dos indicadores"), com a decisão
   do Ali: "entender como fila a primeira etapa do funil, sem mexer na conta
   dos outros clientes — ir ajustando pela VJ".

   Por isso tudo aqui vale SÓ na conta em que o master ligou a régua nova
   (`orgs.fila_por_etapa`, botão Ferramentas da conta no hub). Desligada, as
   telas continuam exatamente como estavam.

   O QUE MUDA, LIGADA:

   - FILA = lead parado na PRIMEIRA ETAPA ATIVA do funil. Antes a fila era o
     lead SEM DONO, e por isso o aviso da Catraca misturava cliente do SDR com
     cliente esperando corretor.
       · Fila do SDR: a primeira etapa do funil de SDR (na VJ, "Lead Novo").
       · Fila do corretor: a primeira etapa do funil comercial principal
         (na VJ, "NOVO"), enquanto nenhum corretor PEGOU o lead.
   - PEGAR (captura) = o corretor que está com o lead mandou a primeira
     mensagem ou fez a primeira ligação depois de recebê-lo. É o mesmo evento
     do "tempo para pegar o lead" da catraca e do "ao pegar, mover para". A
     roleta entregar o lead a ele NÃO é pegar.
   - PRÉ-QUALIFICADO PELO SDR = o lead sair do funil de SDR para outro funil
     (fora de etapa de perda). A etiqueta "qualificado" deixa de contar
     (`preAtendimento(..., { semEtiqueta: true })`).
   - INDICADORES DO SDR viram UM resultado só (gente, robô e IA juntos), e só
     com os leads que ENTRARAM NO FUNIL DE SDR no período. Todos os números
     são dessa mesma coorte, contados até o corte (o fim do período, ou agora)
     — assim os cartões somam o "Por origem", e nenhuma taxa passa de 100%.

   Nada aqui depende do NOME de funil ou de etapa: só da ordem das etapas e do
   tipo do funil. */
import db, { emLotes } from "../db.js";
import { ehFunilDeSdr, funilComercial } from "./pipelines.js";
import { preAtendimento } from "./sdr-funil.js";
import { ROTULO_DISPARO } from "./marca-disparo.js";
import { mediana, pct } from "./score.js";

export function filaPorEtapaLigada(orgId) {
  const o = db.prepare("SELECT fila_por_etapa FROM orgs WHERE id = ?").get(orgId);
  return !!(o && o.fila_por_etapa);
}

/* A primeira etapa ATIVA de um funil (a de menor ordem). */
function primeiraEtapa(orgId, pipelineId) {
  if (!pipelineId) return null;
  return db.prepare(`SELECT id, name, pipeline_id FROM pipeline_stages
    WHERE org_id = ? AND pipeline_id = ? AND is_active = 1 ORDER BY ordem, rowid LIMIT 1`).get(orgId, pipelineId) || null;
}

/* As etapas de fila da conta: as primeiras dos funis de SDR e a primeira do
   funil comercial principal. */
export function etapasDeFila(orgId) {
  const pipes = db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND is_active = 1").all(orgId).map(p => p.id);
  const sdr = [];
  for (const id of pipes) if (ehFunilDeSdr(orgId, id)) { const e = primeiraEtapa(orgId, id); if (e) sdr.push(e); }
  const com = funilComercial(orgId);
  const corretor = com && !ehFunilDeSdr(orgId, com.id) ? primeiraEtapa(orgId, com.id) : null;
  return { sdr, corretor };
}

/* Mensagem que conta como contato com o cliente: tudo que saiu da casa,
   menos o disparo em massa (é campanha, não atendimento). Gente, IA e a
   automação de boas-vindas contam — é o "humano, bot e IA" do Fernando. */
const CONTATO = `m.direction = 'out' AND NOT (m.from_user_id IS NULL AND COALESCE(m.from_name, '') LIKE '${ROTULO_DISPARO}%')`;

/* Os leads que a pessoa responsável já PEGOU: mensagem dela ou ligação dela
   depois de o lead chegar na mão dela. */
function pegos(leads) {
  const comDono = leads.filter(l => l.assigned_to);
  const res = new Set();
  emLotes(comDono.map(l => l.id), (m, lote) => {
    for (const r of db.prepare(`SELECT l.id FROM leads l WHERE l.id IN (${m}) AND (
        EXISTS (SELECT 1 FROM messages x WHERE x.lead_id = l.id AND x.direction = 'out' AND x.from_user_id = l.assigned_to
          AND x.created_at >= COALESCE(l.assigned_at, l.created_at))
        OR EXISTS (SELECT 1 FROM ligacoes g WHERE g.lead_id = l.id AND g.user_id = l.assigned_to
          AND g.created_at >= COALESCE(l.assigned_at, l.created_at)))`).all(...lote)) res.add(r.id);
    return [];
  });
  return res;
}

/* QUEM ESTÁ NA FILA AGORA. Só lead em aberto (não finalizado, não
   anonimizado). Devolve os ids, para a rota montar as linhas com o mesmo
   SELECT da lista de leads. */
export function filaAgora(orgId) {
  const { sdr, corretor } = etapasDeFila(orgId);
  const abertos = (ids) => !ids.length ? [] : db.prepare(`SELECT id, assigned_to, assigned_at, created_at, stage_id FROM leads
    WHERE org_id = ? AND closed_at IS NULL AND COALESCE(anonimizado_em, 0) = 0 AND stage_id IN (${ids.map(() => "?").join(",")})`)
    .all(orgId, ...ids);
  const naSdr = abertos(sdr.map(e => e.id));
  let noCorretor = corretor ? abertos([corretor.id]) : [];
  const jaPegos = pegos(noCorretor);
  noCorretor = noCorretor.filter(l => !jaPegos.has(l.id));
  return {
    etapa_sdr: sdr.map(e => e.name), etapa_corretor: corretor ? corretor.name : null,
    sdr: naSdr.map(l => l.id), corretor: noCorretor.map(l => l.id),
  };
}

/* A lista de quem está esperando, com o momento em que chegou à etapa. */
function listaDeIds(orgId, ids) {
  return emLotes(ids, (m, lote) => db.prepare(`SELECT id, name, origem, source, COALESCE(stage_entered_at, created_at) t FROM leads
    WHERE org_id = ? AND id IN (${m})`).all(orgId, ...lote))
    .map(l => ({ id: l.id, nome: l.name || "Sem nome", origem: origemDe(l), quando: l.t, quem: null }))
    .sort((a, b) => a.quando - b.quando);
}

const NOMES_ORIGEM = { meta: "Anúncio (Meta)", whatsapp: "WhatsApp", portal: "Portal", site: "Site", manual: "Cadastro na mão",
  importacao: "Planilha", disparo: "Disparo" };
const origemDe = (l) => (l.origem && String(l.origem).trim()) || NOMES_ORIGEM[l.source] || l.source || "Não informada";

/* O RESULTADO DO SDR, CONSOLIDADO. Coorte: os leads que entraram no funil de
   SDR no período. Para cada um, até o corte: foi contatado (por gente, robô
   ou IA), respondeu, foi pré-qualificado (saiu do SDR para outro funil), foi
   repassado a um corretor, foi perdido (etapa de perda do funil de SDR).
   `leads` guarda, por indicador, a lista que está por trás do número — é o
   que a tela abre ao clicar (a conferência). */
export function sdrConsolidado(orgId, de, ate) {
  const corte = Math.min(ate, Date.now());
  const pre = preAtendimento(orgId, de, corte, { semEtiqueta: true });
  const pipes = db.prepare("SELECT id FROM pipelines WHERE org_id = ?").all(orgId).map(p => p.id);
  const sdr = new Set(pipes.filter(id => ehFunilDeSdr(orgId, id)));
  const etapas = new Map(db.prepare("SELECT id, pipeline_id, status_type FROM pipeline_stages WHERE org_id = ?").all(orgId)
    .map(e => [e.id, { sdr: sdr.has(e.pipeline_id), perdido: e.status_type === "perdido" }]));
  const ehSdr = (sid) => !!sid && !!(etapas.get(sid) || {}).sdr;
  const corretores = new Set(db.prepare("SELECT id FROM users WHERE org_id = ? AND role = 'corretor'").all(orgId).map(u => u.id));

  const chegaram = pre.entraram;            // lead → { t }
  const ids = [...chegaram.keys()];
  const leads = new Map();
  for (const l of emLotes(ids, (m, lote) => db.prepare(`SELECT id, name, origem, source FROM leads WHERE org_id = ? AND id IN (${m})`).all(orgId, ...lote))) leads.set(l.id, l);

  const contatados = new Map(), responderam = new Map(), prequal = new Map(), repassados = new Map(), perdidos = new Map();
  const esperas = [];
  const quem = (uid) => uid ? ((db.prepare("SELECT name FROM users WHERE id = ?").get(uid) || {}).name || null) : null;
  for (const id of ids) {
    const entrou = chegaram.get(id).t;
    const primeiro = db.prepare(`SELECT m.created_at t, m.from_user_id u, m.from_name n FROM messages m
      WHERE m.lead_id = ? AND ${CONTATO} AND m.created_at >= ? AND m.created_at <= ? ORDER BY m.created_at LIMIT 1`).get(id, entrou, corte);
    if (primeiro) {
      contatados.set(id, { t: primeiro.t, quem: quem(primeiro.u) || primeiro.n || null });
      esperas.push((primeiro.t - entrou) / 60000);
      const resp = db.prepare("SELECT created_at t FROM messages WHERE lead_id = ? AND direction = 'in' AND created_at > ? AND created_at <= ? ORDER BY created_at LIMIT 1")
        .get(id, primeiro.t, corte);
      if (resp) responderam.set(id, { t: resp.t, quem: null });
    }
    for (const r of db.prepare(`SELECT de_stage_id, para_stage_id, created_at t, user_id FROM lead_etapas
        WHERE lead_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at, rowid`).all(id, entrou, corte)) {
      const para = etapas.get(r.para_stage_id);
      if (!prequal.has(id) && ehSdr(r.de_stage_id) && para && !para.sdr && !para.perdido) prequal.set(id, { t: r.t, quem: quem(r.user_id) || "sistema" });
      if (!perdidos.has(id) && ehSdr(r.para_stage_id) && para && para.perdido) perdidos.set(id, { t: r.t, quem: quem(r.user_id) || "sistema" });
    }
    const rep = db.prepare(`SELECT to_user_id, triggered_by_user_id, created_at t FROM lead_transfers
      WHERE lead_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at, rowid`).all(id, entrou, corte)
      .find(t => corretores.has(t.to_user_id));
    if (rep) repassados.set(id, { t: rep.t, quem: quem(rep.to_user_id) });
  }

  // Aguardando na fila do SDR AGORA — não é da coorte: é quem ainda espera.
  const fila = filaAgora(orgId);

  const grupos = new Map();
  for (const id of ids) {
    const nome = origemDe(leads.get(id) || {});
    const g = grupos.get(nome) || { origem: nome, chegaram: 0, contatados: 0, pre_qualificados: 0, repassados_ao_corretor: 0 };
    g.chegaram++;
    if (contatados.has(id)) g.contatados++;
    if (prequal.has(id)) g.pre_qualificados++;
    if (repassados.has(id)) g.repassados_ao_corretor++;
    grupos.set(nome, g);
  }
  const porOrigem = [...grupos.values()]
    .map(g => ({ ...g, taxa_pre_qualificacao: g.chegaram ? pct(g.pre_qualificados, g.chegaram) : null }))
    .sort((a, b) => b.chegaram - a.chegaram);

  const n = ids.length;
  const lista = (mapa) => [...mapa].map(([id, x]) => ({ id, nome: (leads.get(id) || {}).name || "Sem nome",
    origem: origemDe(leads.get(id) || {}), quando: x.t, quem: x.quem || null }))
    .sort((a, b) => b.quando - a.quando);
  return {
    regra: "fila_por_etapa",
    tem_funil_sdr: pre.tem_funil_sdr,
    corte,
    etapa_fila: fila.etapa_sdr,
    chegaram: n,
    aguardando_agora: fila.sdr.length,
    contatados: contatados.size,
    primeira_resposta_mediana_min: mediana(esperas),
    responderam: responderam.size,
    pre_qualificados: prequal.size,
    repassados_ao_corretor: repassados.size,
    perdidos: perdidos.size,
    taxa_contato: n ? pct(contatados.size, n) : null,
    taxa_resposta: contatados.size ? pct(responderam.size, contatados.size) : null,
    taxa_pre_qualificacao: n ? pct(prequal.size, n) : null,
    taxa_repasse: n ? pct(repassados.size, n) : null,
    por_origem: porOrigem,
    leads: {
      chegaram: lista(new Map(ids.map(id => [id, { t: chegaram.get(id).t, quem: null }]))),
      contatados: lista(contatados), responderam: lista(responderam), pre_qualificados: lista(prequal),
      repassados_ao_corretor: lista(repassados), perdidos: lista(perdidos),
      aguardando_agora: listaDeIds(orgId, fila.sdr),
    },
  };
}
