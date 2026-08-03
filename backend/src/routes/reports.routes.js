import { Router } from "express";
import db from "../db.js";
import { authRequired, supervisiona, semMaster } from "../auth.js";
import { STAGES } from "../services/stages.js";
import { ranking, recomendar, recomendacoes, temposDeResposta, mediana } from "../services/score.js";
import { ponto, aplicarCorte } from "../services/expediente.js";

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

  const linhas = equipe.map(u => {
    const meus = leads.filter(l => l.assigned_to === u.id);
    const atendidos = meus.filter(l => l.first_resp_at != null);
    const temposResposta = atendidos.map(l => (l.first_resp_at - l.created_at) / 60000);
    // Tempo de ATENDIMENTO: quanto o cliente espera a cada pergunta ao longo da
    // conversa, não só na primeira. É o que ele sente do começo ao fim — o
    // primeiro contato pode ser rápido e o resto do atendimento arrastado.
    const vendas = meus.filter(l => l.stage === "Venda");
    const porEtapa = STAGES.reduce((o, s) => (o[s] = meus.filter(l => l.stage === s).length, o), {});

    return {
      id: u.id, nome: u.name, papel: u.role,
      recebidos: meus.length,
      atendidos: atendidos.length,
      taxa_atendimento: pct(atendidos.length, meus.length),
      // Mediana em vez de média: um único lead esquecido no fim de semana
      // distorce a média e faz o corretor parecer pior do que é.
      primeira_resposta_mediana_min: mediana(temposResposta) ?? 0,
      atendimento_mediana_min: mediana(temposDeResposta(meus.map(l => l.id))),
      agendamentos: porEtapa["Agendamento"] + porEtapa["Visita"],
      vendas: vendas.length,
      conversao: pct(vendas.length, meus.length),
      valor_vendido: vendas.reduce((s, l) => s + (l.sale_value || 0), 0),
      por_etapa: porEtapa,
    };
  });

  // O total é da imobiliária inteira — quantos leads entraram, quanto foi
  // vendido. Isso é informação de gestão: o corretor via o faturamento da casa
  // dentro da própria tela de produtividade. Só supervisão recebe.
  const total = supervisiona(req.user) ? {
    leads: leads.length,
    na_fila: leads.filter(l => !l.assigned_to).length,
    vendas: leads.filter(l => l.stage === "Venda").length,
    valor_vendido: leads.reduce((s, l) => s + (l.sale_value || 0), 0),
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

const inicioDoDia = (s) => new Date(`${s}T00:00:00`).getTime();
const fimDoDia = (s) => new Date(`${s}T23:59:59.999`).getTime();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
// Score de performance da equipe. Só gestão: é material de decisão sobre
// pessoas, não painel de auto-avaliação do corretor.
r.get("/score", (req, res) => {
  if (!supervisiona(req.user)) return res.status(403).json({ error: "Sem permissão" });
  const dias = Math.min(365, Math.max(7, Number(req.query.dias) || 90));
  res.json({ dias, equipe: ranking(req.user.org_id, dias) });
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
