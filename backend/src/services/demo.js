/* ===== A CONTA DE DEMONSTRAÇÃO (03/09/2026, pedido do Ali) =====

   Uma imobiliária de mentira — "Imobiliária" — para reunião comercial e para
   print. Por dentro ela é uma org como qualquer outra (`orgs.demo = 1` é só
   uma etiqueta, ver db.js): mesma catraca, mesmo funil, mesmo robô. Isso é
   de propósito — o que aparece na reunião precisa ser exatamente o que o
   cliente vai usar, não uma versão maquiada.

   O QUE ESTE ARQUIVO FAZ É REESCREVER OS LEADS TODO DIA. Uma conta de
   demonstração que existisse uma vez só envelheceria na mesma hora: o lead
   "aguardando há 20 minutos" que aparece bem numa reunião vira, três semanas
   depois, um lead esquecido há 21 dias — o oposto do que se quer mostrar.
   Por isso `reseedDemo()` APAGA e RECRIA os leads da conta inteira sempre que
   roda, com todo horário calculado a partir de `Date.now()` — nunca uma data
   fixa. Rodar hoje ou daqui a um mês produz a mesma "sensação de agora".

   O QUE NÃO É APAGADO: a org, a equipe (login fixo, mesma senha sempre) e o
   pipeline. Recriar isso a cada rodada faria o link de login mudar sozinho,
   e é exatamente o que a gestão comercial não pode ter — o mesmo e-mail/senha
   precisa continuar funcionando amanhã. */
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import db from "../db.js";
import { garantirPipelinePadrao, pipelinePadrao, etapaPorNome } from "./pipelines.js";
import { moverEtapa } from "./etapas.js";
import { ASSINATURA_ROBO } from "./robo.js";

export const ORG_ID = "org_demo";
const SENHA = "Demo@2026";

const EQUIPE = [
  { id: "u_demo_gestor", name: "Fernanda Rocha", email: "gestor@imobiliariademo.com.br", role: "adm", available: 0 },
  { id: "u_demo_sdr", name: "Camila Duarte", email: "atendente@imobiliariademo.com.br", role: "sdr", available: 1 },
  { id: "u_demo_marina", name: "Marina Alves", email: "marina@imobiliariademo.com.br", role: "corretor", available: 1 },
  { id: "u_demo_rafael", name: "Rafael Nunes", email: "rafael@imobiliariademo.com.br", role: "corretor", available: 1 },
  { id: "u_demo_bruno", name: "Bruno Cardoso", email: "bruno@imobiliariademo.com.br", role: "corretor", available: 1 },
];

export const CREDENCIAIS = {
  senha: SENHA,
  gestor: EQUIPE[0].email,
  atendente: EQUIPE[1].email,
  corretores: EQUIPE.slice(2).map(p => p.email),
};

/* Cria a org e a equipe se ainda não existirem — SEM MEXER em nada que já
   esteja lá. É o que roda em todo start do servidor (barato, idempotente,
   mesmo padrão de `garantirCasa`): garante que a conta sempre existe, mas o
   login e a senha de quem já entrou uma vez nunca mudam por baixo. */
export function garantirContaDemo() {
  let org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(ORG_ID);
  if (!org) {
    db.prepare(`INSERT INTO orgs (id,name,adm_code,demo,robo_ativo,created_at)
      VALUES (?,?,?,1,1,?)`).run(ORG_ID, "Imobiliária", "IMOBILIARIA-DEMO", Date.now());
    org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(ORG_ID);
    console.log("[demo] conta de demonstração criada");
  }
  // Idempotente mesmo se a org já existia de uma versão anterior desta função.
  garantirPipelinePadrao(ORG_ID);

  const hash = bcrypt.hashSync(SENHA, 10);
  for (const p of EQUIPE) {
    const existe = db.prepare("SELECT id FROM users WHERE id = ?").get(p.id);
    if (existe) continue;
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
      VALUES (?,?,?,?,?,?,?,?,'ativo')`)
      .run(p.id, ORG_ID, p.name, p.email, hash, p.role, p.available, Date.now());
  }
  return org;
}

const h = (horas) => Date.now() - Math.round(horas * 3600000);
const fone = (i) => "5581" + String(90000000 + i);

/* ===== OS LEADS =====

   Um de cada etapa do funil, pelo menos, e variedade de temperatura — é isso
   que faz o Kanban de um print parecer uma operação de verdade, não uma
   tela vazia com três exemplos. `dono` usa a chave da EQUIPE acima; null é
   "na fila", que é o estado que a catraca também precisa mostrar bem.

   `robo` marca a conversa atendida pela IA fora do expediente — é o cartão
   mais vendável da demonstração, e por isso ganha uma conversa mais completa
   e termina com a despedida (regra do robô: a última mensagem dele é sempre
   um adeus, nunca some no meio). As mensagens do robô são ESCRITAS AQUI, não
   geradas pela IA de verdade — chamar a Anthropic para popular uma conta de
   demonstração custaria dinheiro toda vez que a base for renovada, e o texto
   de exemplo já mostra a régua (acolhe, pergunta uma coisa por vez, nunca
   fala valor de parcela). */
const LEADS = [
  { nome: "Juliana Martins", stage: "Lead", dono: null, criadoH: 0.15,
    conversas: [] },
  { nome: "Carlos Eduardo", stage: "Lead", dono: null, criadoH: 0.4,
    conversas: [{ q: "cliente", t: "Boa tarde! Vi o anúncio de vocês no Instagram, ainda está disponível?", m: 24 }] },

  { nome: "Patrícia Nunes", stage: "Atendimento", dono: "sdr", temp: "MORNO", criadoH: 3,
    conversas: [
      { q: "cliente", t: "Oi, boa tarde! Gostaria de mais informações sobre financiamento.", m: 45 },
      { q: "atendente", t: "Oi Patrícia, tudo bem? Claro! Você já tem em mente comprar ou está começando a pesquisar agora?", m: 40 },
      { q: "cliente", t: "Comprar, mas ainda não sei se consigo aprovar o financiamento.", m: 12 },
    ] },

  { nome: "Ricardo Silva", stage: "Atendimento", dono: "sdr", temp: "QUENTE", criadoH: 14,
    robo: true, roboEncerrado: true,
    conversas: [
      { q: "cliente", t: "Boa noite, vi o apartamento de 2 quartos no anúncio, ainda tem?", m: 620 },
      { q: "robo", t: "Boa noite! Que bom que você chamou 🙂 Consigo te ajudar por aqui mesmo. É pra comprar ou alugar?", m: 615 },
      { q: "cliente", t: "Comprar", m: 610 },
      { q: "robo", t: "Perfeito! Pra eu já ir adiantando sua simulação, qual a renda mensal da família, mais ou menos?", m: 605 },
      { q: "cliente", t: "Fica em torno de 6 mil", m: 598 },
      { q: "robo", t: "Show, dá pra fazer boas contas com isso. E hoje você tem algum valor guardado pra dar de entrada?", m: 592 },
      { q: "cliente", t: "Tenho uns 15 mil", m: 588 },
      { q: "robo", t: "Ótimo, Ricardo! Já anotei tudo aqui. Amanhã cedo alguém da nossa equipe continua com você e traz os próximos passos — combinado? Tenha uma boa noite! 🌙", m: 585 },
    ] },

  { nome: "Ana Beatriz Lopes", stage: "Atendimento", dono: "marina", temp: "QUENTE", criadoH: 30,
    tarefa: { titulo: "Ligar para confirmar renda", diasRel: 1 },
    conversas: [
      { q: "cliente", t: "Marina, consegui separar os documentos que você pediu!", m: 200 },
      { q: "atendente", t: "Que ótimo, Ana! Pode me mandar por aqui mesmo, foto ou PDF tá bom.", m: 195 },
      { q: "cliente", t: "Vou mandar amanhã de manhã, só preciso tirar foto do comprovante ainda", m: 190 },
    ] },

  { nome: "Tatiane Correia", stage: "Atendimento", dono: null, criadoH: 0.08,
    conversas: [{ q: "cliente", t: "Olá! Peguei esse número com uma amiga que comprou com vocês. Vocês têm casa na planta?", m: 3 }] },

  { nome: "Leonardo Xavier", stage: "Atendimento", dono: "sdr", temp: "MORNO", criadoH: 6,
    conversas: [
      { q: "cliente", t: "Oi, ainda não decidi nada, só queria entender como funciona o processo.", m: 130 },
      { q: "atendente", t: "Sem problema, Leonardo! O processo começa com uma simulação rápida — posso te fazer 3 perguntas curtas?", m: 128 },
    ] },

  { nome: "Fernando Souza", stage: "Pasta", dono: "rafael", temp: "MORNO", criadoH: 96,
    observacao: "Já separou os documentos, falta só o comprovante de renda atualizado.",
    conversas: [
      { q: "atendente", t: "Fernando, como está a organização da documentação?", m: 1500 },
      { q: "cliente", t: "Já separei quase tudo, só falta atualizar o comprovante de renda", m: 1440 },
    ] },
  { nome: "Larissa Gomes", stage: "Pasta", dono: "marina", temp: "QUENTE", criadoH: 120,
    conversas: [
      { q: "cliente", t: "Marina, já mandei a pasta completa pro e-mail que você passou!", m: 900 },
      { q: "atendente", t: "Recebi sim, Larissa! Vou conferir tudo e já te aviso se falta algo.", m: 895 },
    ] },

  { nome: "Diego Almeida", stage: "Aprovação", dono: "bruno", temp: "QUENTE", criadoH: 200,
    tarefa: { titulo: "Acompanhar retorno do banco", diasRel: -2 },
    conversas: [
      { q: "atendente", t: "Diego, sua pasta já está no banco, aguardando o parecer.", m: 2800 },
      { q: "cliente", t: "Perfeito, obrigado por avisar! Alguma previsão?", m: 2790 },
    ] },
  { nome: "Beatriz Moreira", stage: "Aprovação", dono: "rafael", temp: "MORNO", criadoH: 180,
    conversas: [{ q: "atendente", t: "Beatriz, sua análise de crédito já foi enviada para o banco.", m: 2600 }] },

  { nome: "Thiago Ferreira", stage: "Agendamento", dono: "marina", temp: "QUENTE", criadoH: 48,
    tarefa: { titulo: "Confirmar visita agendada", diasRel: 1 },
    conversas: [
      { q: "cliente", t: "Marina, pode ser sábado de manhã pra visita?", m: 500 },
      { q: "atendente", t: "Pode sim! Vou confirmar o horário com o proprietário e já te aviso.", m: 495 },
    ] },
  { nome: "Renata Vieira", stage: "Agendamento", dono: "bruno", temp: "QUENTE", criadoH: 60,
    conversas: [{ q: "cliente", t: "Bruno, topo ir ver o imóvel amanhã à tarde!", m: 300 }] },

  { nome: "Eduardo Pinto", stage: "Visita", dono: "rafael", temp: "QUENTE", criadoH: 72,
    observacao: "Só atende depois das 18h — trabalha até tarde.",
    conversas: [
      { q: "cliente", t: "Rafael, adorei o imóvel! Vou conversar com minha esposa e te dou um retorno.", m: 1000 },
      { q: "atendente", t: "Fico no aguardo, Eduardo! Qualquer dúvida, é só chamar.", m: 995 },
    ] },
  { nome: "Débora Teixeira", stage: "Visita", dono: "marina", temp: "MORNO", criadoH: 90,
    conversas: [{ q: "cliente", t: "Gostei bastante, mas achei o valor um pouco acima do que eu esperava.", m: 1300 }] },

  { nome: "Marcelo Barros", stage: "Proposta", dono: "bruno", temp: "QUENTE", criadoH: 150,
    conversas: [
      { q: "cliente", t: "Bruno, consigo fechar por 380 mil à vista?", m: 1900 },
      { q: "atendente", t: "Vou levar sua proposta ao proprietário agora e te retorno ainda hoje!", m: 1895 },
    ] },
  { nome: "Fabiana Reis", stage: "Proposta", dono: "rafael", temp: "QUENTE", criadoH: 130,
    conversas: [{ q: "cliente", t: "Rafael, topamos as condições! Como seguimos agora?", m: 1600 }] },

  { nome: "Gustavo Freitas", stage: "Venda", dono: "marina", temp: "QUENTE", criadoH: 400,
    venda: { valor: 320000, diasAtras: 4 },
    conversas: [{ q: "atendente", t: "Gustavo, parabéns pela nova casa! Foi um prazer te ajudar nessa conquista 🎉", m: 5760 }] },
  { nome: "Priscila Andrade", stage: "Venda", dono: "bruno", temp: "QUENTE", criadoH: 500,
    venda: { valor: 410000, diasAtras: 9 },
    conversas: [{ q: "atendente", t: "Priscila, contrato assinado! Qualquer coisa que precisar, estou à disposição.", m: 12960 }] },

  { nome: "Rodrigo Nascimento", stage: "Perdido", dono: "rafael", temp: "FRIO", criadoH: 700,
    conversas: [{ q: "cliente", t: "Acabei fechando com outra imobiliária, mas obrigado pela atenção.", m: 8000 }] },

  { nome: "Simone Carvalho", stage: "Recaptação", dono: "sdr", temp: "FRIO", criadoH: 1200,
    conversas: [{ q: "cliente", t: "Oi, cheguei a conversar com vocês faz uns meses, ainda dá pra retomar?", m: 20000 }] },

  { nome: "André Moraes", stage: "Transferido por ligação", dono: "marina", criadoH: 250,
    conversas: [{ q: "atendente", t: "André, vamos seguir por ligação daqui pra frente, combinado?", m: 3200 }] },
];

/* Apaga só o que a demonstração recria: leads e tudo que pendura neles.
   Equipe, org e pipeline ficam de pé — são eles que sustentam o login. */
function limparLeadsDemo() {
  const rodar = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE lead_id IN (SELECT id FROM leads WHERE org_id = ?)`).run(ORG_ID);
    db.prepare(`DELETE FROM tarefas WHERE org_id = ?`).run(ORG_ID);
    db.prepare(`DELETE FROM observacoes WHERE org_id = ?`).run(ORG_ID);
    db.prepare(`DELETE FROM ligacoes WHERE lead_id IN (SELECT id FROM leads WHERE org_id = ?)`).run(ORG_ID);
    db.prepare(`DELETE FROM lead_etapas WHERE org_id = ?`).run(ORG_ID);
    db.prepare(`DELETE FROM leads WHERE org_id = ?`).run(ORG_ID);
  });
  rodar();
}

function semearLead(spec, i, pipeline) {
  const id = "l_demo_" + i;
  const dono = spec.dono === "sdr" ? EQUIPE[1].id
    : spec.dono ? EQUIPE.find(p => p.id === `u_demo_${spec.dono}`)?.id || null
    : null;
  const criado = h(spec.criadoH);
  const etapaLead = etapaPorNome(ORG_ID, pipeline.id, "Lead");

  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,priority_por,priority_em,qual_json,
      stage,assigned_to,created_at,pipeline_id,stage_id,stage_entered_at,last_interaction_at,source,assigned_at)
    VALUES (?,?,?,?,'WhatsApp',?,?,?,'{}', 'Lead',?,?, ?,?,?,?, 'whatsapp',?)`)
    .run(id, ORG_ID, spec.nome, fone(i), spec.temp || null, spec.temp ? "mao" : null, spec.temp ? criado : null,
      dono, criado, pipeline.id, etapaLead ? etapaLead.id : null, criado, criado, dono ? criado : null);

  if (spec.stage !== "Lead") moverEtapa({ leadId: id, para: spec.stage, motivo: "mao", userId: dono });
  // Backdata a entrada na etapa — sem isso todo lead pareceria ter chegado
  // NESTA etapa agora mesmo, e "há 8 dias em Pasta" é parte do que o Kanban
  // existe para mostrar.
  const entrouEtapa = h(spec.criadoH * 0.6);
  db.prepare("UPDATE leads SET stage_entered_at = ? WHERE id = ?").run(entrouEtapa, id);
  db.prepare(`UPDATE lead_etapas SET created_at = ?
    WHERE id = (SELECT id FROM lead_etapas WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1)`).run(entrouEtapa, id);

  let roboMsgs = 0, primeiraRespostaHumana = null;
  for (const c of spec.conversas || []) {
    const quando = Date.now() - Math.round(c.m * 60000);
    if (c.q === "cliente") {
      db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
        VALUES (?,?,'in',NULL,NULL,?,?)`).run("m_demo_" + randomUUID(), id, c.t, quando);
    } else if (c.q === "robo") {
      db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
        VALUES (?,?,'out',NULL,?,?,?)`).run("m_demo_" + randomUUID(), id, ASSINATURA_ROBO, c.t, quando);
      roboMsgs++;
    } else {
      const nomeDono = db.prepare("SELECT name FROM users WHERE id = ?").get(dono)?.name || "";
      db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
        VALUES (?,?,'out',?,?,?,?)`).run("m_demo_" + randomUUID(), id, dono, nomeDono.split(" ")[0], c.t, quando);
      if (!primeiraRespostaHumana || quando < primeiraRespostaHumana) primeiraRespostaHumana = quando;
    }
  }
  if (roboMsgs) db.prepare("UPDATE leads SET robo_msgs = ?, robo_parado = ? WHERE id = ?")
    .run(roboMsgs, spec.roboEncerrado ? 1 : 0, id);
  if (primeiraRespostaHumana) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(primeiraRespostaHumana, id);

  if (spec.tarefa) {
    const quando = Date.now() + Math.round(spec.tarefa.diasRel * 86400000);
    db.prepare(`INSERT INTO tarefas (id,org_id,lead_id,user_id,criado_por,titulo,quando,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run("t_demo_" + randomUUID(), ORG_ID, id, dono, EQUIPE[1].id, spec.tarefa.titulo, quando, criado);
  }
  if (spec.observacao) {
    db.prepare(`INSERT INTO observacoes (id,org_id,lead_id,texto,autor_id,created_at)
      VALUES (?,?,?,?,?,?)`).run("o_demo_" + randomUUID(), ORG_ID, id, spec.observacao, EQUIPE[1].id, criado);
  }
  if (spec.venda) {
    const dataVenda = h(spec.venda.diasAtras * 24);
    db.prepare("UPDATE leads SET sale_value = ?, sale_date = ? WHERE id = ?").run(spec.venda.valor, dataVenda, id);
  }
}

/* A rotina inteira: garante a conta, apaga os leads de ontem e planta os de
   hoje. É o que roda de madrugada todo dia (server.js) e também sob pedido
   (rota do master), para o Ali poder atualizar na hora antes de uma reunião
   sem esperar o relógio. */
export function reseedDemo() {
  garantirContaDemo();
  const pipeline = pipelinePadrao(ORG_ID);
  limparLeadsDemo();
  LEADS.forEach((spec, i) => semearLead(spec, i, pipeline));
  console.log(`[demo] base recriada — ${LEADS.length} leads, timestamps relativos a agora`);
  return { ok: true, leads: LEADS.length };
}

/* ===== QUANDO RENOVAR SOZINHO =====

   Mesmo princípio do backup diário (`services/backup.js`): quem decide se
   roda hoje é um REGISTRO ("já fiz hoje"), não o relógio. Servidor fora do
   ar de madrugada renova assim que volta; servidor que reinicia dez vezes no
   mesmo dia renova uma só.

   A hora de madrugada não é só higiene — é a trava mais importante desta
   função. Se ela rodasse a qualquer momento, uma reunião comercial ao vivo
   às 15h poderia ver os leads sumirem da tela no meio da conversa. */
const CHAVE_ESTADO = "demo_estado";
const HORA = Number(process.env.DEMO_RESEED_HORA ?? 4);

const lerEstado = () => {
  const l = db.prepare("SELECT valor FROM config_plataforma WHERE chave = ?").get(CHAVE_ESTADO);
  try { return l ? JSON.parse(l.valor) : {}; } catch (e) { return {}; }
};
const gravarEstado = (v) =>
  db.prepare(`INSERT INTO config_plataforma (chave,valor,atualizado_em) VALUES (?,?,?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`)
    .run(CHAVE_ESTADO, JSON.stringify(v), Date.now());

const diaDe = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function reseedDemoSePassouDaHora(agora = Date.now()) {
  const hoje = diaDe(agora);
  const estado = lerEstado();
  if (estado.ultimo_dia === hoje) return;         // já foi renovada hoje
  if (new Date(agora).getHours() < HORA) return;   // ainda não chegou a madrugada
  reseedDemo();
  gravarEstado({ ultimo_dia: hoje });
}
