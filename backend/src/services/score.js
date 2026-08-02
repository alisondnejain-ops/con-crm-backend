import db from "../db.js";

/* Score de performance e recomendação de direcionamento.

   Duas honestidades importantes sobre este arquivo:

   1) NÃO é modelo de linguagem. É estatística do histórico da própria
      imobiliária — média, mediana e percentual. Chamar de "IA" na tela é
      escolha de produto; aqui embaixo é conta, e conta que dá para conferir.

   2) Percentual com pouco histórico MENTE. Um corretor que fechou 2 de 5 leads
      aparece com "40% de conversão" e a recomendação vira ruído. Por isso
      existe AMOSTRA_MINIMA: abaixo dela a resposta é "sem histórico
      suficiente" em vez de um número inventado. É preferível calar a boca a
      empurrar o gestor para a decisão errada com ar de certeza.

   Perfil do lead = TEMPERATURA (quente/morno/frio), decidido com o Ali. */

export const AMOSTRA_MINIMA = 5;   // leads já resolvidos, por temperatura
const PRIORIDADES = ["QUENTE", "MORNO", "FRIO"];

// Etapas que encerram o ciclo: o lead virou venda ou virou perda. Só elas
// contam para conversão — lead em andamento ainda não é acerto nem erro.
const VENDIDO = "Venda";
const PERDIDO = "Perdido";
const resolvido = (l) => l.stage === VENDIDO || l.stage === PERDIDO;

const mediana = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
// Nota 0–100 entre dois limites, com o melhor podendo ser o menor valor.
const nota = (valor, bom, ruim) => {
  if (valor == null) return null;
  const t = (valor - ruim) / (bom - ruim);
  return Math.max(0, Math.min(100, Math.round(t * 100)));
};

/* Tempo de resposta ao longo da conversa, não só o primeiro.
   Para cada mensagem do cliente sem resposta anterior pendente, mede quanto
   levou até a próxima mensagem do atendente. É o "tempo de atendimento" que
   o gestor sente na prática: o cliente pergunta, quanto demora a resposta. */
function temposDeResposta(leadIds) {
  if (!leadIds.length) return [];
  const marcas = "?,".repeat(leadIds.length).slice(0, -1);
  const msgs = db.prepare(
    `SELECT lead_id,direction,created_at FROM messages WHERE lead_id IN (${marcas}) ORDER BY lead_id, created_at`
  ).all(...leadIds);

  const esperas = [];
  let leadAtual = null, perguntaEm = null;
  for (const m of msgs) {
    if (m.lead_id !== leadAtual) { leadAtual = m.lead_id; perguntaEm = null; }
    if (m.direction === "in") { if (perguntaEm == null) perguntaEm = m.created_at; }
    else if (perguntaEm != null) { esperas.push((m.created_at - perguntaEm) / 60000); perguntaEm = null; }
  }
  return esperas;
}

/* Números de um atendente no período. */
function metricas(u, leads, ligacoesPorUsuario) {
  const meus = leads.filter(l => l.assigned_to === u.id);
  const ids = meus.map(l => l.id);
  const fechados = meus.filter(resolvido);
  const vendas = meus.filter(l => l.stage === VENDIDO);
  const perdidos = meus.filter(l => l.stage === PERDIDO);
  const visitas = meus.filter(l => l.stage === "Agendamento" || l.stage === "Visita");
  const primeiras = meus.filter(l => l.first_resp_at).map(l => (l.first_resp_at - l.created_at) / 60000);

  // Conversão por temperatura: a base da recomendação.
  const porTemperatura = {};
  for (const p of PRIORIDADES) {
    const doPerfil = meus.filter(l => (l.priority || "MORNO") === p);
    const fechadosPerfil = doPerfil.filter(resolvido);
    const vendasPerfil = doPerfil.filter(l => l.stage === VENDIDO);
    porTemperatura[p] = {
      recebidos: doPerfil.length,
      resolvidos: fechadosPerfil.length,
      vendas: vendasPerfil.length,
      conversao: pct(vendasPerfil.length, fechadosPerfil.length),
      confiavel: fechadosPerfil.length >= AMOSTRA_MINIMA,
    };
  }

  return {
    id: u.id, nome: u.name, papel: u.role,
    recebidos: meus.length,
    resposta_min: mediana(primeiras),
    atendimento_min: mediana(temposDeResposta(ids)),
    conversao: pct(vendas.length, fechados.length),
    resolvidos: fechados.length,
    vendas: vendas.length,
    perdidos: perdidos.length,
    perda: pct(perdidos.length, fechados.length),
    visitas: visitas.length,
    visitas_pct: pct(visitas.length, meus.length),
    ligacoes: ligacoesPorUsuario[u.id] || 0,
    por_temperatura: porTemperatura,
  };
}

/* Nota final. Os pesos dizem o que a Conecta valoriza: converter e responder
   rápido pesam mais que volume de atividade — corretor que liga muito e não
   fecha não pode ficar à frente de quem fecha. */
const PESOS = { conversao: 30, resposta: 25, visitas: 15, perda: 15, vendas: 10, ligacoes: 5 };

function pontuar(m, teto) {
  const partes = {
    // 15% de conversão já é excelente no mercado; 0% é o piso.
    conversao: nota(m.conversao, 15, 0),
    // Responder em até 5 min é ótimo; 60 min é ruim. Sem resposta nenhuma, zero.
    resposta: m.resposta_min == null ? 0 : nota(m.resposta_min, 5, 60),
    visitas: nota(m.visitas_pct, 40, 0),
    perda: nota(m.perda, 0, 60),
    // Volume é comparativo com o melhor da equipe: não existe alvo absoluto.
    vendas: teto.vendas ? Math.round((m.vendas / teto.vendas) * 100) : 0,
    ligacoes: teto.ligacoes ? Math.round((m.ligacoes / teto.ligacoes) * 100) : 0,
  };
  let total = 0, pesoUsado = 0;
  for (const [k, peso] of Object.entries(PESOS)) {
    if (partes[k] == null) continue;
    total += partes[k] * peso; pesoUsado += peso;
  }
  return { score: pesoUsado ? Math.round(total / pesoUsado) : 0, partes };
}

/* Ranking da equipe. `dias` limita o histórico considerado. */
export function ranking(orgId, dias = 90) {
  const desde = Date.now() - dias * 86400000;
  const equipe = db.prepare(
    "SELECT id,name,role FROM users WHERE org_id=? AND role IN ('corretor','sdr') AND status='ativo' ORDER BY name"
  ).all(orgId);
  const leads = db.prepare("SELECT * FROM leads WHERE org_id=? AND created_at >= ?").all(orgId, desde);

  const ligacoesPorUsuario = {};
  for (const r of db.prepare("SELECT user_id, COUNT(*) n FROM ligacoes WHERE created_at >= ? GROUP BY user_id").all(desde))
    ligacoesPorUsuario[r.user_id] = r.n;

  const brutas = equipe.map(u => metricas(u, leads, ligacoesPorUsuario));
  const teto = {
    vendas: Math.max(0, ...brutas.map(m => m.vendas)),
    ligacoes: Math.max(0, ...brutas.map(m => m.ligacoes)),
  };
  return brutas
    .map(m => {
      // Sem lead no período não há o que avaliar. Dar nota baixa a quem não
      // recebeu nada seria acusar de mau desempenho quem nem entrou em campo.
      if (!m.recebidos) return { ...m, score: null, sem_dados: true, partes: {} };
      return { ...m, ...pontuar(m, teto), sem_dados: false };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/* Recomendação de para quem mandar um lead que ainda não tem corretor.

   Compara a conversão de cada CORRETOR disponível naquela temperatura. Só
   recomenda quando os dois lados têm amostra — comparar 40% (2 de 5) com 8%
   (1 de 12) seria enganoso. */
export function recomendar(orgId, lead) {
  const temperatura = (lead.priority || "MORNO").toUpperCase();
  const lista = ranking(orgId).filter(m => m.papel === "corretor");
  const disponiveis = new Set(
    db.prepare("SELECT id FROM users WHERE org_id=? AND role='corretor' AND status='ativo' AND available=1").all(orgId).map(u => u.id)
  );

  const candidatos = lista
    .filter(m => disponiveis.has(m.id))
    .map(m => ({ ...m, perfil: m.por_temperatura[temperatura] }));

  if (!candidatos.length) return { temperatura, situacao: "sem_corretor_disponivel" };

  const comHistorico = candidatos.filter(c => c.perfil.confiavel);
  if (comHistorico.length < 2) {
    return {
      temperatura,
      situacao: "historico_insuficiente",
      // Sem base para comparar, o critério honesto é o score geral.
      sugerido: { id: candidatos[0].id, nome: candidatos[0].nome, score: candidatos[0].score },
      explicacao: `Ainda não há ${AMOSTRA_MINIMA} atendimentos concluídos de leads ${temperatura.toLowerCase()}s por corretor para comparar conversão. Sugestão pelo desempenho geral.`,
    };
  }

  const ordenados = [...comHistorico].sort((a, b) => b.perfil.conversao - a.perfil.conversao);
  const melhor = ordenados[0], pior = ordenados[ordenados.length - 1];
  return {
    temperatura,
    situacao: "ok",
    sugerido: { id: melhor.id, nome: melhor.nome, conversao: melhor.perfil.conversao, amostra: melhor.perfil.resolvidos, score: melhor.score },
    comparado: { id: pior.id, nome: pior.nome, conversao: pior.perfil.conversao, amostra: pior.perfil.resolvidos },
    ganho: Math.round((melhor.perfil.conversao - pior.perfil.conversao) * 10) / 10,
    explicacao: `${melhor.nome} converte ${melhor.perfil.conversao}% dos leads ${temperatura.toLowerCase()}s (${melhor.perfil.vendas} de ${melhor.perfil.resolvidos}). ${pior.nome} converte ${pior.perfil.conversao}%. Direcionar para ${melhor.nome.split(" ")[0]} aumenta a chance estimada em ${Math.round((melhor.perfil.conversao - pior.perfil.conversao) * 10) / 10} pontos.`,
  };
}
