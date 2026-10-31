/* ===== INDICADORES DO SDR (31/10/2026, primeira versão para o Fernando) =====

   O que a atendente (SDR) faz com o lead ANTES do corretor: recebe, faz o
   primeiro contato, conversa, qualifica e repassa. Os números são DA PESSOA:

   - recebidos: leads que chegaram na mão dela no período (o mesmo histórico de
     atribuição de Relatórios — `eventosDeAtribuicao`);
   - contatados: leads para os quais ELA escreveu no período;
   - 1ª resposta: de quando o lead chegou na mão dela até a primeira mensagem
     dela (mediana — um lead esquecido não pode puxar a média sozinho);
   - responderam: dos contatados, quantos clientes escreveram depois da
     primeira mensagem dela no período;
   - qualificados: leads que ELA moveu para uma etapa de qualificação (a de
     início do processo comercial de cada funil, ou com "qualific" no nome —
     a mesma régua do Painel, `etapasDeQualificacao`);
   - repassados ao corretor: trocas de dono dela para um corretor;
   - perdidos: leads que ela moveu para uma etapa de perda.

   As taxas dividem pelo que tem base ("—" sem base, nunca 0%). Por origem,
   a mesma conta sobre os leads que as atendentes receberam no período. */
import db from "../db.js";
import { semMaster } from "../auth.js";
import { eventosDeAtribuicao, noPeriodo } from "./movimento.js";
import { etapasDeQualificacao } from "./painel-geral.js";
import { mediana, pct } from "./score.js";

const NOMES_ORIGEM = { meta: "Anúncio (Meta)", whatsapp: "WhatsApp", portal: "Portal", site: "Site", manual: "Cadastro na mão",
  importacao: "Planilha", disparo: "Disparo" };
const origemDe = (l) => (l.origem && String(l.origem).trim()) || NOMES_ORIGEM[l.source] || l.source || "Não informada";

export function indicadoresDoSdr(orgId, de, ate, { soUserId = null } = {}) {
  const sdrs = soUserId
    ? db.prepare("SELECT id, name FROM users WHERE id = ? AND org_id = ? AND role = 'sdr'").all(soUserId, orgId)
    : db.prepare(`SELECT u.id, u.name FROM users u WHERE u.org_id = ? AND u.role = 'sdr' AND u.status = 'ativo'${semMaster("u")} ORDER BY u.name`).all(orgId);
  const eventos = eventosDeAtribuicao(orgId);
  const q = etapasDeQualificacao(orgId);
  const ehQualificacao = (r) => r.sid ? q.ids.has(r.sid) : q.nomes.has(r.nome);
  const etapasPerda = new Set(db.prepare("SELECT id FROM pipeline_stages WHERE org_id = ? AND status_type = 'perdido'").all(orgId).map(x => x.id));
  const corretores = new Set(db.prepare("SELECT id FROM users WHERE org_id = ? AND role = 'corretor'").all(orgId).map(x => x.id));

  const porPessoa = [];
  const porLeadSdr = new Map();   // lead → {recebido, contatado, qualificado, repassado}
  const marca = (lead, campo) => { const x = porLeadSdr.get(lead) || {}; x[campo] = true; porLeadSdr.set(lead, x); };

  for (const u of sdrs) {
    const recebidos = noPeriodo(eventos.recebidos, u.id, de, ate);
    const chegou = new Map();
    for (const e of recebidos) if (!chegou.has(e.lead_id)) chegou.set(e.lead_id, e.quando);
    for (const l of chegou.keys()) marca(l, "recebido");

    // As mensagens DELA no período (de gente: o autor é ela).
    const minhas = db.prepare(`SELECT m.lead_id lead, MIN(m.created_at) primeira FROM messages m JOIN leads l ON l.id = m.lead_id
      WHERE l.org_id = ? AND m.direction = 'out' AND m.from_user_id = ? AND m.created_at BETWEEN ? AND ?
      GROUP BY m.lead_id`).all(orgId, u.id, de, ate);
    for (const m of minhas) marca(m.lead, "contatado");

    // 1ª resposta: da chegada à primeira mensagem dela depois da chegada.
    const esperas = [];
    for (const [lead, quando] of chegou) {
      const r = db.prepare(`SELECT MIN(created_at) t FROM messages WHERE lead_id = ? AND direction = 'out' AND from_user_id = ? AND created_at >= ?`)
        .get(lead, u.id, quando);
      if (r && r.t) esperas.push((r.t - quando) / 60000);
    }

    let responderam = 0;
    for (const m of minhas)
      if (db.prepare("SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'in' AND created_at > ? AND created_at <= ? LIMIT 1").get(m.lead, m.primeira, ate))
        responderam++;

    const movidas = db.prepare(`SELECT lead_id lead, para_stage_id sid, para nome FROM lead_etapas
      WHERE org_id = ? AND user_id = ? AND created_at BETWEEN ? AND ?`).all(orgId, u.id, de, ate);
    const qualificados = new Set(movidas.filter(ehQualificacao).map(r => r.lead));
    for (const l of qualificados) marca(l, "qualificado");
    const perdidos = new Set(movidas.filter(r => r.sid && etapasPerda.has(r.sid)).map(r => r.lead));

    const repasses = db.prepare(`SELECT lead_id lead, to_user_id para FROM lead_transfers
      WHERE org_id = ? AND from_user_id = ? AND created_at BETWEEN ? AND ?`).all(orgId, u.id, de, ate);
    const aoCorretor = new Set(repasses.filter(r => corretores.has(r.para)).map(r => r.lead));
    for (const l of aoCorretor) marca(l, "repassado");

    porPessoa.push({
      id: u.id, nome: u.name,
      recebidos: chegou.size,
      contatados: minhas.length,
      primeira_resposta_mediana_min: mediana(esperas),
      responderam,
      qualificados: qualificados.size,
      repassados_ao_corretor: aoCorretor.size,
      perdidos: perdidos.size,
      taxa_resposta: minhas.length ? pct(responderam, minhas.length) : null,
      taxa_qualificacao: minhas.length ? pct(qualificados.size, minhas.length) : null,
    });
  }

  // Por origem: os leads que passaram pelas atendentes no período.
  const grupos = new Map();
  const ids = [...porLeadSdr.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const lote = ids.slice(i, i + 500);
    for (const l of db.prepare(`SELECT id, origem, source FROM leads WHERE org_id = ? AND id IN (${lote.map(() => "?").join(",")})`).all(orgId, ...lote)) {
      const nome = origemDe(l);
      const g = grupos.get(nome) || { origem: nome, recebidos: 0, contatados: 0, qualificados: 0, repassados_ao_corretor: 0 };
      const x = porLeadSdr.get(l.id);
      if (x.recebido) g.recebidos++;
      if (x.contatado) g.contatados++;
      if (x.qualificado) g.qualificados++;
      if (x.repassado) g.repassados_ao_corretor++;
      grupos.set(nome, g);
    }
  }
  const porOrigem = [...grupos.values()]
    .map(g => ({ ...g, taxa_qualificacao: g.contatados ? pct(g.qualificados, g.contatados) : null }))
    .sort((a, b) => b.recebidos - a.recebidos || b.contatados - a.contatados);

  const soma = (k) => porPessoa.reduce((n, p) => n + (p[k] || 0), 0);
  return {
    periodo: { de, ate },
    sem_etapa_de_qualificacao: !q.ids.size && !q.nomes.size,
    total: { recebidos: soma("recebidos"), contatados: soma("contatados"), responderam: soma("responderam"),
      qualificados: soma("qualificados"), repassados_ao_corretor: soma("repassados_ao_corretor"), perdidos: soma("perdidos") },
    por_pessoa: porPessoa,
    por_origem: porOrigem,
  };
}
