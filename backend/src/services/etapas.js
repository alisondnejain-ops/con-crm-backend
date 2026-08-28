/* Quando cada lead entrou na etapa em que está.

   O CRM guardava só ONDE o lead está, nunca DESDE QUANDO. Isso derrubava duas
   coisas ao mesmo tempo:

   - no funil, o card não sabia dizer se o lead está em "Aprovação" desde ontem
     ou desde o mês passado — e essa é a diferença entre um atendimento andando
     e um parado;
   - no relatório, "quantos avançaram para Visita nesta semana" era impossível,
     e por isso o número que existe é "onde estão hoje" (foto do momento).

   Agora toda mudança de etapa passa por aqui e fica registrada com quem mexeu e
   por quê. O histórico começa no dia em que isto entrou: lead que nunca mais
   mudou de etapa não tem linha nenhuma, e a tela diz "—" em vez de inventar
   uma data. Fingir que a etapa começou na criação do lead seria mentira fácil
   de contar e difícil de desfazer depois.

   `motivo` diz de onde veio a mudança — mão, palavra-chave, IA confirmada,
   venda registrada, reanálise. É o que permite, mais para frente, responder
   "o funil anda sozinho ou é a equipe que move?". */

import { randomUUID } from "crypto";
import db from "../db.js";
import { etapaPorId, etapaPorNome, pipelinePadrao } from "./pipelines.js";

export const MOTIVOS = {
  mao: "mudança na mão",
  palavra: "palavra-chave na conversa",
  ia: "leitura da IA confirmada",
  venda: "venda registrada",
  reanalise: "reanálise da base",
};

/* ===== O UNICO CAMINHO POR ONDE ETAPA MUDA =====

   Toda mudança passa por aqui — a mão, a confirmação da recomendação, a venda
   registrada, a reanálise em lote. É por ser um caminho só que dá para pendurar
   nele as regras novas (SLA, campo obrigatório, distribuição) sem sair
   caçando os trinta lugares que mexem em lead.

   ESCREVE O NOME E O VINCULO JUNTOS. `stage` (nome) é o que o sistema inteiro
   lê hoje; `stage_id` é o que as regras configuráveis usam. Gravar só um dos
   dois deixaria metade do CRM olhando para um estado e metade para outro — o
   tipo de divergência que não dá erro e só aparece num relatório errado
   semanas depois.

   Aceita `para` como NOME (compatível com todo o código de hoje) ou
   `paraEtapaId` como vínculo (o caminho novo). Devolve `true` quando houve
   mudança de fato. */
export function moverEtapa({ leadId, para, paraEtapaId = null, motivo = "mao", userId = null, de = null }) {
  const lead = db.prepare(
    "SELECT id, org_id, stage, stage_id, pipeline_id, assigned_to FROM leads WHERE id = ?").get(leadId);
  if (!lead) return false;

  /* Resolve o destino nas duas direções: veio o id, descobre o nome; veio o
     nome, procura o id no pipeline do lead. O nome continua mandando quando a
     etapa não existe como linha — é o caso da base anterior a 28/08/2026 e o
     motivo de isto não recusar nada. */
  const pipelineId = lead.pipeline_id || pipelinePadrao(lead.org_id)?.id || null;
  const destino = paraEtapaId
    ? etapaPorId(lead.org_id, paraEtapaId)
    : (pipelineId ? etapaPorNome(lead.org_id, pipelineId, para) : null);
  const nomeDestino = destino ? destino.name : para;
  if (!nomeDestino) return false;

  const anterior = de ?? lead.stage;
  if (anterior === nomeDestino && (!destino || destino.id === lead.stage_id)) return false;

  /* O PIPELINE ACOMPANHA A ETAPA.

     Aqui havia um COALESCE, e ele estava errado de um jeito silencioso: a
     intenção era preencher o pipeline de quem não tinha nenhum, mas o efeito
     era impedir a troca de pipeline de quem já tinha. O lead movido para uma
     etapa do funil Comercial ficava com `pipeline_id` do SDR e `stage_id` do
     Comercial — um estado que nenhum kanban consegue desenhar: a coluna não
     existe no funil em que ele diz estar.

     E é justamente esse o movimento mais importante do produto: o SDR
     qualifica e o lead passa para o comercial. */
  const pipelineDestino = destino ? destino.pipeline_id : pipelineId;
  const mudouDePipeline = !!(pipelineDestino && lead.pipeline_id && pipelineDestino !== lead.pipeline_id);

  const quando = Date.now();
  const aplicar = db.transaction(() => {
    db.prepare(`UPDATE leads SET stage = ?, stage_id = ?, pipeline_id = ?, stage_entered_at = ? WHERE id = ?`)
      .run(nomeDestino, destino ? destino.id : null, pipelineDestino, quando, leadId);
    db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,motivo,user_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run("le_" + randomUUID(), lead.org_id, leadId, anterior, nomeDestino, motivo, userId, quando);

    /* Troca de funil é outra pergunta que `lead_etapas` não responde: "por
       onde este lead passou". Fica em lead_transfers, junto com a troca de
       dono — as duas são movimento entre pessoas e fluxos, não avanço dentro
       de um deles. */
    if (mudouDePipeline)
      db.prepare(`INSERT INTO lead_transfers
        (id,org_id,lead_id,from_pipeline_id,from_stage_id,to_pipeline_id,to_stage_id,
         from_user_id,to_user_id,triggered_by_user_id,trigger_reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "tr_" + randomUUID(), lead.org_id, leadId, lead.pipeline_id, lead.stage_id,
        pipelineDestino, destino ? destino.id : null,
        lead.assigned_to, lead.assigned_to, userId, motivo, quando);
  });
  aplicar();
  return true;
}

/* ===== CAMPOS OBRIGATORIOS DA ETAPA DE DESTINO =====

   Pergunta antes de mover: o que a etapa exige já está preenchido?

   Devolve a lista do que falta, com o RÓTULO do campo e não a chave — quem lê
   é quem atende, e "falta `orcamento_max`" não é uma frase que alguém saiba o
   que fazer com ela.

   Só vale para ENTRAR na etapa. Exigir na saída travaria o lead dentro de uma
   etapa por causa de um dado que a etapa seguinte é que precisa. */
export function camposQueFaltam(orgId, etapa, lead) {
  const exigidos = (etapa && etapa.required_fields) || [];
  if (!exigidos.length) return [];

  const valores = (() => {
    try { return JSON.parse(lead.custom_fields || "{}"); } catch (e) { return {}; }
  })();
  /* Os campos NATIVOS do lead entram na mesma peneira que os personalizados.
     Do lado de quem configura a etapa, "telefone" e "orçamento" são a mesma
     coisa: informação que precisa estar lá. Que uma seja coluna e a outra
     viva no JSON é assunto do banco, não de quem monta o funil. */
  const nativos = {
    telefone: lead.phone, phone: lead.phone,
    email: lead.email,
    nome: lead.name, name: lead.name,
    temperatura: lead.priority, priority: lead.priority,
    origem: lead.origem, source: lead.source,
    campanha: lead.campaign_name, campaign: lead.campaign_name,
    responsavel: lead.assigned_to,
    produto: lead.produto_id,
    ticket: lead.sale_value,
  };

  const definicoes = db.prepare(
    "SELECT key, name FROM custom_fields WHERE org_id = ? AND is_active = 1").all(orgId);
  const rotulo = new Map(definicoes.map(d => [d.key, d.name]));

  const vazio = (v) => v === undefined || v === null || v === "" ||
    (Array.isArray(v) && !v.length);

  return exigidos
    .filter(k => vazio(valores[k]) && vazio(nativos[k]))
    .map(k => ({ key: k, label: rotulo.get(k) || k }));
}

/* ===== SLA DA ETAPA =====

   Três estados e uma regra: o relógio conta a partir da ÚLTIMA INTERAÇÃO, não
   da entrada na etapa. Lead que entrou ontem e conversou agora está saudável;
   lead que entrou hoje de manhã e ninguém tocou está abandonado. Medir pela
   entrada faria o segundo parecer melhor que o primeiro.

   Sem `sla_minutes` na etapa, não há SLA — e isso é `null`, não "ok". Dizer
   "em dia" para uma etapa que ninguém configurou é inventar uma medição que
   não existe. */
export function slaDoLead(etapa, lead, agora = Date.now()) {
  if (!etapa || !etapa.sla_minutes) return null;
  const base = lead.last_interaction_at || lead.stage_entered_at || lead.created_at;
  if (!base) return null;

  const minutos = Math.floor((agora - base) / 60000);
  const limite = etapa.sla_minutes;
  const aviso = etapa.warning_before_minutes ?? Math.round(limite * 0.75);
  const status = minutos >= limite ? "overdue"
    : minutos >= Math.max(0, limite - aviso) ? "warning"
    : "ok";
  return {
    status, minutos, limite,
    restam: Math.max(0, limite - minutos),
    desde: base,
  };
}

// Desde quando cada lead está na etapa atual. Um SELECT só para a lista
// inteira: uma consulta por card deixaria o funil lento com a base crescendo.
export function etapaDesdePorLead(orgId) {
  const linhas = db.prepare(`
    SELECT e.lead_id, MAX(e.created_at) AS quando
    FROM lead_etapas e JOIN leads l ON l.id = e.lead_id
    WHERE e.org_id = ? AND e.para = l.stage
    GROUP BY e.lead_id`).all(orgId);
  return new Map(linhas.map(l => [l.lead_id, l.quando]));
}

// O caminho completo de um lead, do começo ao que está agora.
export const historicoDoLead = (leadId) => db.prepare(
  `SELECT e.de, e.para, e.motivo, e.created_at, u.name AS quem
   FROM lead_etapas e LEFT JOIN users u ON u.id = e.user_id
   WHERE e.lead_id = ? ORDER BY e.created_at ASC`).all(leadId);
