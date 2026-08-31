import { Router } from "express";
import db from "../db.js";
import { authRequired, supervisiona, semMaster } from "../auth.js";
import { STAGES } from "../services/stages.js";
import { ranking, recomendar, recomendacoes, temposDeResposta, primeirasRespostas, mediana, pct, COMPONENTES_DO_SCORE } from "../services/score.js";
import { ponto, aplicarCorte } from "../services/expediente.js";
import { escala as escalaPlantao, resumoPresenca, meiaNoite as meiaNoitePlantao } from "../services/plantao.js";

const r = Router();
r.use(authRequired);

/* Ponto das atendentes — diário, semanal e mensal.

   Fica em Relatórios porque é material de gestão, não de operação: quem lê é
   quem cobra presença. A atendente vê o próprio; a equipe inteira, só o gestor.

   ?periodo=dia|semana|mes  (ou ?de= &ate= para um intervalo à mão) */
r.get("/ponto", (req, res) => {
  // O corte das 18:00 fecha o dia de quem esqueceu de sair. Aplicado antes de
  // somar, senão o relatório mostraria o dia de ontem ainda aberto.
  try { aplicarCorte(req.user.org_id); } catch (e) {}

  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const janelas = {
    dia: [hoje.getTime(), Date.now()],
    semana: [hoje.getTime() - 6 * 86400000, Date.now()],
    mes: [hoje.getTime() - 29 * 86400000, Date.now()],
  };
  const escolhida = janelas[req.query.periodo] || janelas.semana;
  const de = req.query.de ? inicioDoDia(req.query.de) : escolhida[0];
  const ate = req.query.ate ? fimDoDia(req.query.ate) : escolhida[1];
  if (!isFinite(de) || !isFinite(ate)) return res.status(400).json({ error: "Período inválido." });

  // Gestor vê a equipe; qualquer outro vê só a própria linha.
  const soMinha = req.user.role !== "adm";
  const linhas = ponto(req.user.org_id, {
    de, ate, roles: ["sdr"], userId: soMinha ? req.user.id : null,
  });
  res.json({ de, ate, periodo: req.query.periodo || "semana", pessoas: linhas });
});

// Produtividade por atendente num período.
//   ?de=2026-07-01&ate=2026-07-31   (sem parâmetros: últimos 30 dias)
// A ADM vê a equipe inteira; corretor e SDR veem só a própria linha.
r.get("/", (req, res) => {
  const ate = req.query.ate ? fimDoDia(req.query.ate) : Date.now();
  const de = req.query.de ? inicioDoDia(req.query.de) : ate - 30 * 86400000;
  if (!isFinite(de) || !isFinite(ate)) return res.status(400).json({ error: "Período inválido." });

  /* CORRETORES na tabela do funil. A atendente saía aqui junto, com colunas de
     visitas agendadas, vendas e conversão — e nada disso é função dela: ela faz
     o primeiro atendimento e repassa. Pior: como o lead deixa de ser dela no
     repasse, o trabalho que ela fez sumia da conta. Ela tem um bloco próprio,
     logo abaixo, medido pelo que ela de fato faz. */
  const equipe = supervisiona(req.user)
    ? db.prepare(`SELECT u.id,u.name,u.role FROM users u WHERE u.org_id=? AND u.role='corretor' AND u.status='ativo'${semMaster("u")} ORDER BY u.name`).all(req.user.org_id)
    : db.prepare("SELECT id,name,role FROM users WHERE id=? AND role='corretor'").all(req.user.id);

  const leads = db.prepare("SELECT * FROM leads WHERE org_id=? AND created_at BETWEEN ? AND ?")
    .all(req.user.org_id, de, ate);

  /* VENDA é medida pela DATA DA VENDA, não pela data em que o lead entrou.

     Era o furo que fazia o relatório parecer desatualizado: a venda fechada
     hoje, de um lead que chegou em junho, não aparecia em "esta semana" —
     porque a busca acima pega só quem ENTROU no período. O gestor registrava
     a venda e o número não mexia.

     Lead que entrou no período continua sendo "recebidos": as duas perguntas
     são diferentes e agora cada uma é medida pelo que lhe cabe. */
  const vendasDoPeriodo = db.prepare(
    "SELECT * FROM leads WHERE org_id=? AND sale_value IS NOT NULL AND sale_date BETWEEN ? AND ?")
    .all(req.user.org_id, de, ate);

  /* Escala do período, para cruzar com a produção. "Recebeu 8 leads" diz uma
     coisa; "recebeu 8, sendo 5 em dias de plantão dele" diz outra. */
  const plantoes = escalaPlantao(req.user.org_id, { de, ate });
  // Em que dias cada pessoa esteve escalada — dias, não turnos: o lead entra
  // no dia, não no turno.
  const diasDePlantao = new Map();
  for (const p of plantoes) {
    if (!diasDePlantao.has(p.user_id)) diasDePlantao.set(p.user_id, new Set());
    diasDePlantao.get(p.user_id).add(p.dia);
  }
  // Marcações de disponibilidade feitas em dia de plantão, no período.
  const prontidaoEmPlantao = db.prepare(`
    SELECT user_id, COUNT(DISTINCT date(created_at/1000,'unixepoch','localtime')) AS dias
    FROM disponibilidade_log
    WHERE org_id = ? AND ativo = 1 AND plantao IS NOT NULL AND created_at BETWEEN ? AND ?
    GROUP BY user_id`).all(req.user.org_id, de, ate);
  const cumpriu = new Map(prontidaoEmPlantao.map(x => [x.user_id, x.dias]));
  /* PRESENÇA NO PLANTÃO, conferida pela atendente.

     É a única coisa do relatório que não sai do que o sistema observou sozinho
     — alguém teve que olhar e marcar. Por isso ela vem com `nao_conferidos` ao
     lado: sem esse número, "1 falta" num mês em que a atendente conferiu dois
     turnos parece um mês quase perfeito. É a mesma régua da visita confirmada
     e do lead sem temperatura — o que ninguém marcou não vira presença nem
     falta, vira o terceiro número. */
  const presencas = resumoPresenca(req.user.org_id, { de, ate });

  const linhas = equipe.map(u => {
    const meus = leads.filter(l => l.assigned_to === u.id);
    /* Leads recebidos DIA A DIA. É a pergunta direta do gestor: "no dia 4,
       quantos exatamente ele recebeu?". Com o total do período só dá para
       responder puxando um relatório por dia, um de cada vez. */
    const porDiaMapa = new Map();
    for (const l of meus) {
      const k = meiaNoitePlantao(l.created_at);
      porDiaMapa.set(k, (porDiaMapa.get(k) || 0) + 1);
    }
    const por_dia = [...porDiaMapa.entries()].sort((a, b) => a[0] - b[0])
      .map(([dia, recebidos]) => ({ dia, recebidos }));

    const escalados = diasDePlantao.get(u.id) || new Set();
    const emPlantao = meus.filter(l => escalados.has(meiaNoitePlantao(l.created_at)));
    /* ATENDIDOS e 1ª RESPOSTA são DELE, não do lead.

       Antes usavam `leads.first_resp_at`, que guarda a primeira resposta de
       QUALQUER pessoa. Na Conecta quem fala primeiro é a atendente, e ela
       repassa: o corretor aparecia com o tempo dela, e a própria agilidade não
       entrava em lugar nenhum. Agora conta da hora em que o lead ficou com ele
       até a primeira mensagem que ELE escreveu. */
    const temposResposta = primeirasRespostas(meus, u.id);
    const atendidos = { length: temposResposta.length };
    // Tempo de ATENDIMENTO: quanto o cliente espera a cada pergunta ao longo da
    // conversa, não só na primeira. É o que ele sente do começo ao fim — o
    // primeiro contato pode ser rápido e o resto do atendimento arrastado.
    // Fechadas por ele DENTRO do período, venham de quando vierem.
    const vendas = vendasDoPeriodo.filter(l => l.assigned_to === u.id);
    const porEtapa = STAGES.reduce((o, s) => (o[s] = meus.filter(l => l.stage === s).length, o), {});

    return {
      id: u.id, nome: u.name, papel: u.role,
      recebidos: meus.length,
      atendidos: atendidos.length,
      taxa_atendimento: pct(atendidos.length, meus.length),
      // Mediana em vez de média: um único lead esquecido no fim de semana
      // distorce a média e faz o corretor parecer pior do que é.
      primeira_resposta_mediana_min: mediana(temposResposta) ?? 0,
      atendimento_mediana_min: mediana(temposDeResposta(meus.map(l => l.id), u.id)),
      // Onde os leads DO PERÍODO estão hoje no funil. É uma foto do momento,
      // não "quantos avançaram nesta semana" — o sistema não guarda a data de
      // cada mudança de etapa, então prometer isso seria inventar número.
      /* Onde os leads DO PERÍODO estão hoje. `agendamentos` é a foto do funil
         (inclui o que a palavra-chave moveu sozinha); `agendamentos_confirmados`
         é só o que uma pessoa colocou ali. A tela mostra os dois, porque a
         diferença entre eles É a informação: ela diz o quanto o funil está
         descrevendo o atendimento de verdade. */
      agendamentos: porEtapa["Agendamento"] + porEtapa["Visita"],
      agendamentos_confirmados: confirmadosPorPessoa(meus),
      vendas: vendas.length,
      // Conversão é de COORTE: dos leads que entraram no período, quantos já
      // viraram venda. Dividir as vendas do período pelos leads do período
      // misturaria gente de meses diferentes e daria percentual sem sentido.
      conversao: pct(meus.filter(l => l.stage === "Venda").length, meus.length),
      vendas_da_coorte: meus.filter(l => l.stage === "Venda").length,
      valor_vendido: vendas.reduce((s, l) => s + (l.sale_value || 0), 0),
      por_etapa: porEtapa,
      por_dia,
      plantao: {
        dias_escalado: escalados.size,
        dias_que_se_prontificou: cumpriu.get(u.id) || 0,
        leads_em_dia_de_plantao: emPlantao.length,
        /* Em TURNOS, não em dias: dá para vir de manhã e faltar à tarde, e
           somar os dois no mesmo dia esconderia a metade que faltou. */
        ...(presencas.get(u.id) ||
          { turnos_escalado: 0, turnos_passados: 0, presencas: 0, faltas: 0, nao_conferidos: 0 }),
        // As datas em si, para a tela marcar "estava de plantão" no dia que o
        // gestor abrir — o número sozinho não responde "e no dia 4?".
        dias_plantao: [...escalados].sort((a, b) => a - b),
      },
    };
  });

  // O total é da imobiliária inteira — quantos leads entraram, quanto foi
  // vendido. Isso é informação de gestão: o corretor via o faturamento da casa
  // dentro da própria tela de produtividade. Só supervisão recebe.
  const total = supervisiona(req.user) ? {
    leads: leads.length,
    na_fila: leads.filter(l => !l.assigned_to).length,
    vendas: vendasDoPeriodo.length,
    valor_vendido: vendasDoPeriodo.reduce((s, l) => s + (l.sale_value || 0), 0),
  } : null;

  /* ===== ATENDIMENTO (a atendente) =====

     Medido pelo PRIMEIRO CONTATO, não por quem está com o lead agora. É a
     única forma correta: o lead que ela atendeu e repassou não está mais na
     conta dela, então contar por `assigned_to` apagaria quase todo o trabalho
     dela do relatório.

     A primeira mensagem enviada de cada conversa diz quem fez esse contato e a
     que horas — que é exatamente o indicador dela. */
  const sdrs = supervisiona(req.user)
    ? db.prepare(`SELECT u.id,u.name FROM users u WHERE u.org_id=? AND u.role='sdr' AND u.status='ativo'${semMaster("u")} ORDER BY u.name`).all(req.user.org_id)
    : db.prepare("SELECT id,name FROM users WHERE id=? AND role='sdr'").all(req.user.id);

  const primeiroContato = db.prepare(`
    SELECT m.lead_id, m.from_user_id, MIN(m.created_at) AS quando
    FROM messages m WHERE m.direction='out' AND m.from_user_id IS NOT NULL
    GROUP BY m.lead_id`).all();
  const porLead = new Map(primeiroContato.map(x => [x.lead_id, x]));

  const atendimento = sdrs.map(u => {
    const dela = leads.filter(l => { const c = porLead.get(l.id); return c && c.from_user_id === u.id; });
    const esperas = dela.map(l => (porLead.get(l.id).quando - l.created_at) / 60000).filter(n => n >= 0);
    // Repassado = ela abriu a conversa e hoje o lead está com outra pessoa.
    const repassados = dela.filter(l => l.assigned_to && l.assigned_to !== u.id);
    const naFila = leads.filter(l => !l.assigned_to);
    return {
      id: u.id, nome: u.name, papel: "sdr",
      // Quantos chegaram para ela no período (inclui os que ela já repassou).
      recebidos: leads.filter(l => l.assigned_to === u.id).length + repassados.length,
      primeiro_contato: dela.length,
      primeira_resposta_mediana_min: mediana(esperas) ?? 0,
      // Sem resposta: entrou no período, ninguém falou, e ainda está na fila
      // ou com ela. É o furo que a gestão precisa ver.
      sem_contato: leads.filter(l => !porLead.get(l.id) && (!l.assigned_to || l.assigned_to === u.id)).length,
      repassados: repassados.length,
      com_ela: leads.filter(l => l.assigned_to === u.id).length,
      na_fila: naFila.length,
    };
  });

  res.json({ periodo: { de, ate }, total, atendentes: linhas, atendimento });
});

/* Quantos destes leads estão em Agendamento/Visita porque uma PESSOA decidiu.
   Mesma regra do score — se as duas contas divergirem, o relatório volta a
   discordar de si mesmo, que é o problema que a função `pct` já resolveu. */
function confirmadosPorPessoa(leads) {
  const ids = leads.map(l => l.id);
  if (!ids.length) return 0;
  return db.prepare(`SELECT COUNT(*) n FROM leads l
    WHERE l.id IN (${"?,".repeat(ids.length).slice(0, -1)})
      AND l.stage IN ('Agendamento','Visita')
      AND EXISTS (SELECT 1 FROM lead_etapas e
                  WHERE e.lead_id = l.id AND e.para = l.stage AND e.motivo IN ('mao','ia','ia_lote'))`).get(...ids).n;
}

const inicioDoDia = (s) => new Date(`${s}T00:00:00`).getTime();
const fimDoDia = (s) => new Date(`${s}T23:59:59.999`).getTime();
// `pct` vem do score.js: uma conta só, para os dois não divergirem de novo.
// Score de performance da equipe. Só gestão: é material de decisão sobre
// pessoas, não painel de auto-avaliação do corretor.
r.get("/score", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });

  /* Aceita o MESMO intervalo da tela de Relatórios (?de=&ate=). É o que faz o
     score bater com a tabela logo acima dele: antes o score olhava "últimos 90
     dias" enquanto a tela olhava o mês escolhido, e os dois números certos
     descreviam pedaços diferentes do tempo.

     ?dias= continua valendo para quem já chamava assim. */
  const temIntervalo = req.query.de || req.query.ate;
  const ate = req.query.ate ? fimDoDia(req.query.ate) : Date.now();
  const de = req.query.de ? inicioDoDia(req.query.de) : null;
  if (temIntervalo && (!isFinite(de) || !isFinite(ate)))
    return res.status(400).json({ error: "Período inválido." });

  const dias = Math.min(365, Math.max(7, Number(req.query.dias) || 90));
  const periodo = temIntervalo ? { de: de ?? (ate - dias * 86400000), ate } : dias;
  const equipe = ranking(req.user.org_id, periodo);

  res.json({
    dias,
    periodo: typeof periodo === "object" ? periodo : { de: Date.now() - dias * 86400000, ate: Date.now() },
    // A régua vai junto: relatório de reunião sem a definição de cada número
    // não se sustenta na primeira pergunta.
    componentes: COMPONENTES_DO_SCORE,
    equipe,
  });
});

// Para quem mandar este lead. Vale só enquanto ele não está com um corretor —
// depois de direcionado, recomendar de novo seria convidar ao troca-troca.
r.get("/recomendacao/:leadId", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });
  const lead = db.prepare("SELECT * FROM leads WHERE id=? AND org_id=?").get(req.params.leadId, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  const dono = lead.assigned_to
    ? db.prepare("SELECT role FROM users WHERE id=?").get(lead.assigned_to) : null;
  if (dono && dono.role === "corretor") return res.json({ situacao: "ja_direcionado" });
  res.json(recomendar(req.user.org_id, lead));
});

// Painel de recomendações: o que merece decisão do gestor agora.
r.get("/recomendacoes", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });
  res.json(recomendacoes(req.user.org_id, Number(req.query.limite) || 8));
});

export default r;
