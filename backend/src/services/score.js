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
/* UMA função de percentual para o CRM inteiro, exportada de propósito.

   A tela de Relatórios tinha a sua e o score tinha a sua: uma arredondava para
   inteiro, a outra guardava uma casa decimal. Resultado, para o mesmo corretor
   no mesmo período: 33% na tabela e 33,3% no score. Números certos, e mesmo
   assim o relatório desmonta na primeira pessoa que conferir.

   Enquanto forem duas funções, elas voltam a divergir na próxima mudança. */
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
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

/* Números de um atendente no período.

   TUDO AQUI USA A MESMA DEFINIÇÃO DA TELA DE RELATÓRIOS. Não é preciosismo:
   o score e a tela mostravam números diferentes para a mesma pessoa no mesmo
   período, e aí nenhum dos dois servia para levar a uma reunião.

   As três diferenças que existiam, e como ficaram:

   - VENDA. A tela conta pela `sale_date` (venda fechada HOJE de um lead de
     junho é venda deste mês); o score contava lead da coorte que hoje está na
     etapa "Venda". Agora as duas contam pela data da venda. De quebra, some o
     caso do lead arrastado para "Venda" no funil sem valor lançado — que
     virava venda no score e não existia na tela.
   - CONVERSÃO. A tela divide pelos RECEBIDOS; o score dividia pelos
     RESOLVIDOS (só os já fechados), o que dá um percentual muito maior para
     quem tem poucos casos encerrados. Agora as duas dividem pelos recebidos.
   - PERÍODO. A tela usa o intervalo que o gestor escolheu; o score usava
     "últimos 90 dias" fixos. Agora o score recebe o mesmo intervalo. */
function metricas(u, leads, ligacoesPorUsuario, vendasDoPeriodo) {
  const meus = leads.filter(l => l.assigned_to === u.id);
  const ids = meus.map(l => l.id);
  const fechados = meus.filter(resolvido);
  // Mesma conta da tela: venda é a que FECHOU no período, venha o lead de quando vier.
  const vendas = vendasDoPeriodo.filter(l => l.assigned_to === u.id);
  const vendasDaCoorte = meus.filter(l => l.stage === VENDIDO);
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
    // Nome idêntico ao da tela, e conta idêntica: dos leads que entraram no
    // período, quantos já viraram venda.
    conversao: pct(vendasDaCoorte.length, meus.length),
    resolvidos: fechados.length,
    vendas: vendas.length,
    vendas_da_coorte: vendasDaCoorte.length,
    valor_vendido: vendas.reduce((s, l) => s + (l.sale_value || 0), 0),
    perdidos: perdidos.length,
    perda: pct(perdidos.length, fechados.length),
    visitas: visitas.length,
    visitas_pct: pct(visitas.length, meus.length),
    ligacoes: ligacoesPorUsuario[u.id] || 0,
    por_temperatura: porTemperatura,
  };
}

/* ===== A NOTA, ABERTA =====

   Os pesos dizem o que a Conecta valoriza: converter e responder rápido pesam
   mais que volume de atividade — corretor que liga muito e não fecha não pode
   ficar à frente de quem fecha.

   Cada parte sai da conta com o VALOR, a RÉGUA e o PESO. É o que permite levar
   isto para uma reunião: quando o corretor perguntar "por que eu tirei 62?", a
   resposta está na tela, item por item, e não numa fórmula que só o sistema
   conhece. Nota fechada sem as partes é palavra contra palavra.

   Réguas absolutas x comparativas, e a diferença importa na hora de explicar:
   conversão, resposta, visitas e perda têm alvo fixo — não dependem de como a
   equipe foi neste mês. Vendas e ligações são comparativas com o melhor da
   equipe, porque não existe número absoluto de "quantas vendas é bom": depende
   do mês, do estoque e de quantos leads entraram. */
const COMPONENTES = [
  { chave: "conversao", rotulo: "Conversão", peso: 30, unidade: "%", bom: 8, ruim: 0,
    como: "Dos leads que entraram no período, quantos já viraram venda. Mesma conta da tela de Relatórios.",
    regua: "8% ou mais = 100. 0% = 0." },
  { chave: "resposta", rotulo: "Tempo da 1ª resposta", peso: 25, unidade: "min", bom: 5, ruim: 60,
    como: "Mediana do tempo entre o lead entrar e a primeira resposta. Mediana, não média: um lead esquecido no fim de semana não pode definir o mês inteiro.",
    regua: "Até 5 min = 100. 60 min ou mais = 0." },
  { chave: "visitas", rotulo: "Leads que chegaram à visita", peso: 15, unidade: "%", bom: 40, ruim: 0,
    como: "Quantos dos leads recebidos estão hoje em Agendamento ou Visita. É foto do momento — o sistema não guarda a data de cada mudança de etapa.",
    regua: "40% ou mais = 100. 0% = 0." },
  { chave: "perda", rotulo: "Perda", peso: 15, unidade: "%", bom: 0, ruim: 60,
    como: "Dos atendimentos já encerrados (venda ou perdido), quantos foram perdidos.",
    regua: "0% = 100. 60% ou mais = 0." },
  { chave: "vendas", rotulo: "Vendas fechadas", peso: 10, comparativo: true,
    como: "Vendas com data DENTRO do período, venha o lead de quando vier. Mesma conta da tela.",
    regua: "Comparativo: quem mais vendeu na equipe = 100." },
  { chave: "ligacoes", rotulo: "Ligações", peso: 5, comparativo: true,
    como: "Tentativas de ligação registradas pelo botão Ligar.",
    regua: "Comparativo: quem mais ligou na equipe = 100." },
];

const VALOR_DA_PARTE = {
  conversao: (m) => m.conversao,
  resposta: (m) => m.resposta_min,
  visitas: (m) => m.visitas_pct,
  perda: (m) => m.perda,
  vendas: (m) => m.vendas,
  ligacoes: (m) => m.ligacoes,
};

function pontuar(m, teto) {
  const partes = COMPONENTES.map(c => {
    const valor = VALOR_DA_PARTE[c.chave](m);
    const n = c.comparativo
      ? (teto[c.chave] ? Math.round((valor / teto[c.chave]) * 100) : 0)
      // Nunca respondeu é zero, não "sem dado": o cliente esperou de verdade.
      : (valor == null ? 0 : nota(valor, c.bom, c.ruim));
    return {
      chave: c.chave, rotulo: c.rotulo, peso: c.peso, nota: n,
      valor: valor == null ? 0 : valor,
      valor_texto: c.chave === "resposta"
        ? (valor == null ? "sem resposta" : `${valor} min`)
        : c.unidade === "%" ? `${valor}%` : String(valor),
      como: c.como, regua: c.regua,
      comparativo: !!c.comparativo,
      // Quanto esta parte contribuiu para a nota final. É o número que
      // responde "onde eu perdi ponto".
      contribuiu: Math.round(n * c.peso / 100),
    };
  });
  const pesoTotal = COMPONENTES.reduce((s, c) => s + c.peso, 0);
  const total = partes.reduce((s, p) => s + p.nota * p.peso, 0);
  return {
    score: Math.round(total / pesoTotal),
    partes,
    // Formato antigo, para não quebrar quem já lia `partes.conversao`.
    partes_nota: Object.fromEntries(partes.map(p => [p.chave, p.nota])),
  };
}

// A régua completa, para a tela e o relatório imprimirem a definição de cada
// número em vez de pedirem confiança.
export const COMPONENTES_DO_SCORE = COMPONENTES.map(({ chave, rotulo, peso, como, regua, comparativo }) =>
  ({ chave, rotulo, peso, como, regua, comparativo: !!comparativo }));

/* Ranking da equipe.

   `periodo` pode ser um número de dias (uso antigo, e o que a recomendação de
   direcionamento continua usando) ou o mesmo intervalo {de, ate} que o gestor
   escolheu na tela de Relatórios. A segunda forma existe para o relatório de
   reunião: score e tela precisam falar do MESMO pedaço de tempo, senão os dois
   números estão certos e mesmo assim não batem. */
export function ranking(orgId, periodo = 90) {
  const { de, ate } = typeof periodo === "object" && periodo
    ? { de: periodo.de, ate: periodo.ate ?? Date.now() }
    : { de: Date.now() - periodo * 86400000, ate: Date.now() };

  // Só CORRETOR entra no ranking. A atendente faz o primeiro contato e repassa
  // — a venda não é dela, e cobrá-la por conversão seria medir a pessoa errada.
  const equipe = db.prepare(
    `SELECT u.id,u.name,u.role FROM users u WHERE u.org_id=? AND u.role='corretor' AND u.status='ativo'${semMaster("u")} ORDER BY u.name`
  ).all(orgId);
  const leads = db.prepare("SELECT * FROM leads WHERE org_id=? AND created_at BETWEEN ? AND ?").all(orgId, de, ate);
  // Exatamente a mesma busca da tela de Relatórios — de propósito.
  const vendasDoPeriodo = db.prepare(
    "SELECT * FROM leads WHERE org_id=? AND sale_value IS NOT NULL AND sale_date BETWEEN ? AND ?").all(orgId, de, ate);

  /* As ligações são filtradas pela imobiliária. Antes a busca varria a tabela
     inteira e só depois pegava as linhas dos usuários desta casa: dava o
     resultado certo, mas lendo o movimento das outras — e com o CRM já rodando
     em mais de uma imobiliária isso é leitura que não deveria acontecer. */
  const ligacoesPorUsuario = {};
  for (const r of db.prepare(`SELECT g.user_id, COUNT(*) n FROM ligacoes g
      JOIN users u ON u.id = g.user_id
      WHERE u.org_id = ? AND g.created_at BETWEEN ? AND ? GROUP BY g.user_id`).all(orgId, de, ate))
    ligacoesPorUsuario[r.user_id] = r.n;

  const brutas = equipe.map(u => metricas(u, leads, ligacoesPorUsuario, vendasDoPeriodo));
  const teto = {
    vendas: Math.max(0, ...brutas.map(m => m.vendas)),
    ligacoes: Math.max(0, ...brutas.map(m => m.ligacoes)),
  };
  return brutas
    .map(m => {
      // Sem lead no período não há o que avaliar. Dar nota baixa a quem não
      // recebeu nada seria acusar de mau desempenho quem nem entrou em campo.
      /* Sem NADA no período não há o que avaliar — e "nada" agora inclui não
         ter fechado venda nem registrado ligação, não só não ter recebido
         lead. Com a venda contada pela data de fechamento, o corretor que não
         recebeu nenhum lead novo mas fechou um negócio de abril entrava aqui e
         desaparecia do ranking justamente no mês em que produziu. */
      if (!m.recebidos && !m.vendas && !m.ligacoes)
        return { ...m, score: null, sem_dados: true, partes: [], partes_nota: {} };
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
