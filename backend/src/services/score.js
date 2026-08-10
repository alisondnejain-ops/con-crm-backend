import db from "../db.js";
import { semMaster } from "../auth.js";

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

export const mediana = (arr) => {
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
export function temposDeResposta(leadIds) {
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
  // Só CORRETOR entra no ranking. A atendente faz o primeiro contato e repassa
  // — a venda não é dela, e cobrá-la por conversão seria medir a pessoa errada.
  const equipe = db.prepare(
    `SELECT u.id,u.name,u.role FROM users u WHERE u.org_id=? AND u.role='corretor' AND u.status='ativo'${semMaster("u")} ORDER BY u.name`
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
  // O dono atual entra na comparação: a recomendação vale para lead novo e para
  // lead já em andamento. Se quem está com ele já é o melhor, o retorno diz isso
  // em vez de sugerir troca por trocar.
  const lista = ranking(orgId);
  const disponiveis = new Set(
    db.prepare(`SELECT u.id FROM users u WHERE u.org_id=? AND u.role='corretor' AND u.status='ativo' AND u.available=1${semMaster("u")}`).all(orgId).map(u => u.id)
  );

  const candidatos = lista
    .filter(m => disponiveis.has(m.id))
    .map(m => ({ ...m, perfil: m.por_temperatura[temperatura] }));

  if (!candidatos.length) return { temperatura, situacao: "sem_corretor_disponivel" };

  const comHistorico = candidatos.filter(c => c.perfil.confiavel);
  if (comHistorico.length < 2) {
    /* Sem 5 atendimentos concluídos por temperatura, a comparação por conversão
       não se sustenta — e ESPERAR por ela travava a sugestão por semanas, que
       foi a reclamação do Ali: na prática a atendente nunca via recomendação
       nenhuma, só o aviso de "histórico insuficiente".

       O critério passa a ser o desempenho da SEMANA entre os 5 melhores.
       Semana porque é o que descreve a equipe agora — quem está atendendo
       rápido nesta semana, e não quem converteu bem há três meses. Cinco
       porque comparar o time inteiro traz para a conta quem mal recebeu lead
       no período e só faz barulho.

       Não é a mesma pergunta que "quem converte mais leads mornos", e a tela
       diz isso: é sugestão por desempenho recente, não por conversão. */
    const daSemana = ranking(orgId, 7).filter(m => !m.sem_dados);
    const top5 = daSemana.slice(0, 5);
    const disponivelNoTop = top5.filter(m => disponiveis.has(m.id));
    const escolhido = disponivelNoTop[0]
      || candidatos.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    const media = top5.length
      ? Math.round(top5.reduce((soma, m) => soma + (m.score || 0), 0) / top5.length)
      : null;

    return {
      temperatura,
      situacao: "por_desempenho_da_semana",
      sugerido: { id: escolhido.id, nome: escolhido.nome, score: escolhido.score },
      base: { dias: 7, considerados: top5.length, media_score: media },
      explicacao: top5.length
        ? `Pelo desempenho da última semana: ${escolhido.nome} está entre os ${top5.length} melhores` +
          (media != null ? ` (média do grupo: ${media} de 100` + (escolhido.score != null ? `, ele está em ${escolhido.score}` : "") + ")" : "") + "."
        : `Ainda não houve movimento na última semana para comparar. Sugestão pelo desempenho geral.`,
    };
  }

  const ordenados = [...comHistorico].sort((a, b) => b.perfil.conversao - a.perfil.conversao);
  const melhor = ordenados[0], pior = ordenados[ordenados.length - 1];

  // Já está com o melhor da temperatura: confirmar é mais útil que sugerir troca.
  if (lead.assigned_to === melhor.id)
    return {
      temperatura, situacao: "ja_com_o_melhor",
      sugerido: { id: melhor.id, nome: melhor.nome, conversao: melhor.perfil.conversao, score: melhor.score },
      explicacao: `${melhor.nome} é quem mais converte leads ${temperatura.toLowerCase()}s (${melhor.perfil.conversao}%). O lead já está com a pessoa certa.`,
    };

  // Lead já direcionado a outro corretor: compara com quem está, não com o pior
  // da equipe — é essa a diferença que interessa ao gestor.
  const atual = lead.assigned_to ? comHistorico.find(c => c.id === lead.assigned_to) : null;
  if (atual) {
    const ganho = Math.round((melhor.perfil.conversao - atual.perfil.conversao) * 10) / 10;
    return {
      temperatura, situacao: "trocar",
      sugerido: { id: melhor.id, nome: melhor.nome, conversao: melhor.perfil.conversao, amostra: melhor.perfil.resolvidos, score: melhor.score },
      comparado: { id: atual.id, nome: atual.nome, conversao: atual.perfil.conversao, amostra: atual.perfil.resolvidos },
      ganho,
      explicacao: `${melhor.nome} converte ${melhor.perfil.conversao}% dos leads ${temperatura.toLowerCase()}s (${melhor.perfil.vendas} de ${melhor.perfil.resolvidos}). ${atual.nome} converte ${atual.perfil.conversao}%. Passar para ${melhor.nome.split(" ")[0]} aumenta a chance estimada em ${ganho} pontos.`,
    };
  }
  return {
    temperatura,
    situacao: "ok",
    sugerido: { id: melhor.id, nome: melhor.nome, conversao: melhor.perfil.conversao, amostra: melhor.perfil.resolvidos, score: melhor.score },
    comparado: { id: pior.id, nome: pior.nome, conversao: pior.perfil.conversao, amostra: pior.perfil.resolvidos },
    ganho: Math.round((melhor.perfil.conversao - pior.perfil.conversao) * 10) / 10,
    explicacao: `${melhor.nome} converte ${melhor.perfil.conversao}% dos leads ${temperatura.toLowerCase()}s (${melhor.perfil.vendas} de ${melhor.perfil.resolvidos}). ${pior.nome} converte ${pior.perfil.conversao}%. Direcionar para ${melhor.nome.split(" ")[0]} aumenta a chance estimada em ${Math.round((melhor.perfil.conversao - pior.perfil.conversao) * 10) / 10} pontos.`,
  };
}

/* Painel de recomendações — o "gerente operacional" da tela inicial.

   Em vez de esperar o gestor abrir lead por lead, junta o que merece decisão
   agora: quem está sem corretor, quem está com alguém que converte bem menos
   naquela temperatura, e quem está esperando resposta há tempo demais.

   GANHO_MINIMO existe para a lista não virar barulho: trocar um lead de mãos
   por 2 pontos de diferença é ruído estatístico, não recomendação. */
export const GANHO_MINIMO = 10;   // pontos de conversão
const ESPERA_ALERTA = 60;         // minutos sem primeira resposta

export function recomendacoes(orgId, limite = 8) {
  const abertos = db.prepare(
    `SELECT * FROM leads WHERE org_id=? AND closed_at IS NULL
       AND stage NOT IN ('Venda','Perdido') ORDER BY created_at DESC LIMIT 200`
  ).all(orgId);

  const nomes = {};
  for (const u of db.prepare("SELECT id,name FROM users WHERE org_id=?").all(orgId)) nomes[u.id] = u.name;

  const itens = [];
  for (const lead of abertos) {
    const agora = Date.now();

    // 1) Esperando primeira resposta há tempo demais. É o mais urgente: lead
    //    parado esfria, e nenhuma recomendação de corretor adianta se ninguém falou.
    if (!lead.first_resp_at) {
      const espera = Math.round((agora - lead.created_at) / 60000);
      if (espera >= ESPERA_ALERTA)
        itens.push({
          tipo: "sem_resposta", urgencia: 3, lead_id: lead.id, lead: lead.name,
          temperatura: lead.priority || "MORNO",
          texto: `${lead.name} está há ${espera >= 120 ? Math.round(espera / 60) + "h" : espera + " min"} sem primeira resposta${lead.assigned_to ? ` (com ${nomes[lead.assigned_to] || "alguém"})` : " e sem dono"}.`,
        });
    }

    const r = recomendar(orgId, lead);
    // 2) Sem corretor: quem deve pegar.
    if (r.situacao === "ok" && r.ganho >= GANHO_MINIMO)
      itens.push({ tipo: "direcionar", urgencia: 2, lead_id: lead.id, lead: lead.name,
        temperatura: r.temperatura, sugerido: r.sugerido, texto: r.explicacao });
    // 3) Já direcionado, mas há quem converta bem mais naquela temperatura.
    else if (r.situacao === "trocar" && r.ganho >= GANHO_MINIMO)
      itens.push({ tipo: "trocar", urgencia: 1, lead_id: lead.id, lead: lead.name,
        temperatura: r.temperatura, sugerido: r.sugerido, texto: r.explicacao });
  }

  itens.sort((a, b) => b.urgencia - a.urgencia);
  return { total: itens.length, itens: itens.slice(0, limite) };
}
