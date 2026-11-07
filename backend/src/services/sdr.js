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

/* A IA COMO ATENDENTE (07/11/2026, pedido do Ali: "o SDR deles é nossa IA").
   Numa conta em que o Autoatendimento faz o pré-atendimento (a VJ), não existe
   pessoa com o papel de atendente e o quadro ficava vazio. Ela entra como mais
   uma linha, com a MESMA régua, adaptada ao que dá para atribuir a ela:

   - atendidos (recebidos e contatados): leads em que a IA mandou a primeira
     mensagem dela no período. A mensagem da IA é a que sai com o autor
     "Atendimento automático" (ASSINATURA_ROBO), sem pessoa da equipe;
   - 1ª resposta: da última mensagem do cliente antes da primeira da IA até
     ela — é o tempo que a IA levou para responder;
   - responderam: o cliente escreveu depois da primeira mensagem da IA;
   - qualificados: leads atendidos por ela que o SISTEMA (não uma pessoa)
     moveu para uma etapa de qualificação depois — a etapa final do
     Autoatendimento e a regra da etapa. Movido por gente conta para a
     pessoa, não para a IA;
   - repassados ao corretor: leads atendidos por ela que foram a um corretor
     depois da primeira mensagem dela, por qualquer caminho (a catraca, a
     regra da etapa, a gestão) — é a passagem do pré-atendimento;
   - perdidos: movidos pelo sistema para uma etapa de perda depois dela. */
const AUTOR_IA = "Atendimento automático";

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

  const ia = linhaDaIA(orgId, de, ate, { ehQualificacao, etapasPerda, corretores, marca });
  if (ia && !soUserId) porPessoa.push(ia);

  // Por origem: os leads que passaram pelas atendentes (e pela IA) no período.
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
    tem_atendente: sdrs.length > 0,
  };
}

function linhaDaIA(orgId, de, ate, { ehQualificacao, etapasPerda, corretores, marca }) {
  const primeiras = db.prepare(`SELECT m.lead_id lead, MIN(m.created_at) primeira FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.org_id = ? AND m.direction = 'out' AND m.from_user_id IS NULL AND m.from_name = ?
    GROUP BY m.lead_id HAVING MIN(m.created_at) BETWEEN ? AND ?`).all(orgId, AUTOR_IA, de, ate);
  if (!primeiras.length) return null;

  /* QUEM CHEGOU NA FILA (07/11/2026, relato do Ali: "chegaram 7 e só
     registrou 6"). A linha da IA só contava quem ELA atendeu — e o lead de
     formulário que nunca escreveu no WhatsApp fica na fila sem a IA falar com
     ele (ela só responde, não puxa a conversa), então sumia do relatório.
     Agora "recebidos" é quem NASCEU SEM DONO no período (a fila, que é a caixa
     da IA) mais quem ela atendeu; "contatados" continua sendo quem ela
     atendeu. A diferença entre os dois é o lead que chegou e ninguém chamou.
     Nascer sem dono: sem troca de dono e sem dono hoje, ou a primeira troca
     saindo de "ninguém". */
  const naFila = db.prepare(`SELECT l.id FROM leads l WHERE l.org_id = ? AND l.created_at BETWEEN ? AND ?
    AND (
      (NOT EXISTS (SELECT 1 FROM lead_transfers t WHERE t.lead_id = l.id) AND l.assigned_to IS NULL)
      OR (SELECT t.from_user_id FROM lead_transfers t WHERE t.lead_id = l.id ORDER BY t.created_at ASC LIMIT 1) IS NULL
         AND EXISTS (SELECT 1 FROM lead_transfers t WHERE t.lead_id = l.id)
    )`).all(orgId, de, ate).map(x => x.id);
  const recebidos = new Set([...naFila, ...primeiras.map(p => p.lead)]);
  for (const id of recebidos) marca(id, "recebido");

  const esperas = [];
  let responderam = 0;
  const qualificados = new Set(), perdidos = new Set(), aoCorretor = new Set();
  for (const { lead, primeira } of primeiras) {
    marca(lead, "contatado");
    const antes = db.prepare("SELECT MAX(created_at) t FROM messages WHERE lead_id = ? AND direction = 'in' AND created_at <= ?").get(lead, primeira);
    if (antes && antes.t) esperas.push((primeira - antes.t) / 60000);
    if (db.prepare("SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'in' AND created_at > ? AND created_at <= ? LIMIT 1").get(lead, primeira, ate))
      responderam++;
    for (const r of db.prepare(`SELECT para_stage_id sid, para nome FROM lead_etapas
        WHERE lead_id = ? AND user_id IS NULL AND created_at >= ? AND created_at <= ?`).all(lead, primeira, ate)) {
      if (ehQualificacao(r)) qualificados.add(lead);
      if (r.sid && etapasPerda.has(r.sid)) perdidos.add(lead);
    }
    if (db.prepare(`SELECT to_user_id para FROM lead_transfers WHERE lead_id = ? AND created_at >= ? AND created_at <= ?`)
        .all(lead, primeira, ate).some(t => corretores.has(t.para))) aoCorretor.add(lead);
  }
  for (const l of qualificados) marca(l, "qualificado");
  for (const l of aoCorretor) marca(l, "repassado");
  const n = primeiras.length;
  return {
    id: "ia", nome: "Autoatendimento (IA)", ia: true,
    recebidos: recebidos.size, contatados: n,
    primeira_resposta_mediana_min: mediana(esperas),
    responderam,
    qualificados: qualificados.size,
    repassados_ao_corretor: aoCorretor.size,
    perdidos: perdidos.size,
    taxa_resposta: pct(responderam, n),
    taxa_qualificacao: pct(qualificados.size, n),
  };
}
