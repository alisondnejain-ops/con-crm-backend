/* MOVER UM LEAD, COM AS REGRAS DA ETAPA DE DESTINO (28/08/2026).

   `moverEtapa` (services/etapas.js) grava a mudança. Este arquivo é o que
   acontece EM VOLTA dela: conferir o que a etapa exige antes, e disparar o que
   a etapa manda depois.

   POR QUE NUM LUGAR SO

   Lead muda de etapa por cinco caminhos diferentes hoje — a rota manual, o
   arrasto no kanban, a confirmação da recomendação da IA, o registro da venda
   e a reanálise em lote. Se a regra de campo obrigatório morasse na rota, ela
   valeria para um caminho e não para os outros quatro: o gestor configuraria
   "Proposta exige orçamento", veria funcionar ao clicar, e descobriria meses
   depois que arrastar no kanban passa direto. Regra que vale às vezes é pior
   que regra nenhuma, porque ninguém sabe quando confiar nela.

   A ORDEM IMPORTA, E É ESTA:

   1. conferir campos obrigatórios — antes de mexer em qualquer coisa;
   2. mover a etapa;
   3. rodar a automação da etapa de destino.

   O passo 1 vem primeiro porque bloquear DEPOIS de mover é não bloquear. E o
   passo 3 vem por último porque distribuir um lead que não chegou a entrar na
   etapa é entregar trabalho que não existe.

   O QUE ESTE ARQUIVO NAO FAZ: decidir se a pessoa pode. Permissão é da rota,
   que sabe quem está pedindo. Aqui a pergunta é outra — se a operação faz
   sentido. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { moverEtapa, camposQueFaltam } from "./etapas.js";
import { etapaPorId, etapaPorNome, pipelinePadrao, primeiraEtapa, entradaDe } from "./pipelines.js";
import { pegarProximo, marcarQueRecebeu } from "./rodizio.js";

/* Resolve o destino aceitando nome OU id.

   O nome existe porque é o que todo o código de hoje usa; o id é o caminho
   novo. Os dois chegam aqui e saem como a mesma etapa. */
function resolverDestino(orgId, lead, { para, paraEtapaId }) {
  if (paraEtapaId) return etapaPorId(orgId, paraEtapaId);
  const pipelineId = lead.pipeline_id || pipelinePadrao(orgId)?.id;
  return pipelineId ? etapaPorNome(orgId, pipelineId, para) : null;
}

/* Move o lead aplicando as regras. Devolve um dos três desfechos:

   { bloqueado: true, faltam: [...] }  — a etapa exige o que o lead não tem
   { ok: true, mudou: false }          — já estava lá
   { ok: true, mudou: true, ... }      — moveu, e conta o que a automação fez

   `forcar` existe para os caminhos em que a exigência não faz sentido: a venda
   registrada leva o lead para a etapa de ganho porque a venda ACONTECEU, e
   segurar isso por falta de um campo seria o CRM discordando de um fato. */
export function moverLead({ leadId, para = null, paraEtapaId = null, motivo = "mao",
  userId = null, forcar = false }) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) return { erro: "Lead não encontrado." };

  const destino = resolverDestino(lead.org_id, lead, { para, paraEtapaId });
  const nomeDestino = destino ? destino.name : para;
  if (!nomeDestino) return { erro: "Etapa de destino não encontrada." };

  // 1. O que a etapa exige.
  if (!forcar && destino) {
    const faltam = camposQueFaltam(lead.org_id, destino, lead);
    if (faltam.length) return {
      bloqueado: true, faltam, etapa: destino.name,
      /* A frase sai daqui e não da tela porque quem move o lead são cinco
         telas diferentes, e a mensagem tem que ser a mesma nas cinco. */
      error: faltam.length === 1
        ? `Para mover para "${destino.name}", preencha: ${faltam[0].label}.`
        : `Para mover para "${destino.name}", preencha: ${faltam.map(f => f.label).join(", ")}.`,
    };
  }

  // 2. A mudança.
  const mudou = moverEtapa({ leadId, para: nomeDestino, paraEtapaId: destino?.id || null, motivo, userId });
  if (!mudou) return { ok: true, mudou: false, stage: nomeDestino };

  // 3. O que a etapa manda fazer.
  const automacao = destino ? rodarAutomacao(lead, destino, userId) : {};
  return { ok: true, mudou: true, stage: nomeDestino, stage_id: destino?.id || null, ...automacao };
}

/* ===== AUTOMACAO DA ETAPA =====

   `automation_config` é um JSON na etapa. Hoje entende três coisas, e cada uma
   resolve um problema que a operação tem hoje:

     { "distribuir": "rodizio" }        entrega ao próximo corretor da fila
     { "distribuir": "<user_id>" }      entrega sempre à mesma pessoa
     { "mover_para_pipeline": "<id>" }  o lead troca de funil ao chegar aqui
     { "limpar_responsavel": true }     volta para a fila, sem dono

   É o caso principal do sprint: o lead chega em "Lead qualificado" no funil do
   SDR e, sozinho, vai para o comercial na mão de um corretor.

   POR QUE UM JSON E NAO COLUNAS: porque a lista vai crescer (criar tarefa,
   notificar, mandar mensagem, chamar a IA) e cada ação nova viraria uma
   migração de coluna. O JSON aceita o que ainda não existe; o que ele NÃO
   aceita é regra escondida — tudo que este arquivo entende está escrito acima.

   NUNCA LANCA. Automação que derruba a movimentação transformaria uma
   configuração errada do gestor numa etapa em que ninguém consegue entrar. O
   lead move; o que falhou vira aviso na resposta. */
function rodarAutomacao(lead, etapa, userId) {
  const cfg = etapa.automation_config || {};
  if (!cfg || !Object.keys(cfg).length) return {};
  const resultado = {};

  try {
    // 1. Troca de funil.
    if (cfg.mover_para_pipeline) {
      const alvo = primeiraEtapa(lead.org_id, cfg.mover_para_pipeline);
      if (alvo) {
        moverEtapa({ leadId: lead.id, paraEtapaId: alvo.id, motivo: "automatica", userId });
        resultado.movido_para_pipeline = cfg.mover_para_pipeline;
        resultado.stage = alvo.name;
        resultado.stage_id = alvo.id;
      } else {
        resultado.aviso = "A etapa manda mover para um funil que não tem etapas. O lead ficou onde estava.";
      }
    }

    // 2. Responsável.
    if (cfg.limpar_responsavel) {
      trocarResponsavel(lead, null, userId, "automatica");
      resultado.responsavel = null;
    } else if (cfg.distribuir) {
      const novo = cfg.distribuir === "rodizio"
        ? pegarProximo(lead.org_id)
        : validarPessoa(lead.org_id, cfg.distribuir);
      if (novo) {
        if (cfg.distribuir !== "rodizio") marcarQueRecebeu(lead.org_id, novo);
        trocarResponsavel(lead, novo, userId, "automatica");
        resultado.responsavel = novo;
        resultado.responsavel_nome = db.prepare("SELECT name FROM users WHERE id = ?").get(novo)?.name || null;
      } else {
        /* NINGUEM DISPONIVEL É UM AVISO, NAO UM SILENCIO.
           O lead entrou na etapa e não tem dono: sem esta frase ele fica na
           fila parecendo distribuído, e ninguém descobre até o cliente
           reclamar. */
        resultado.aviso = cfg.distribuir === "rodizio"
          ? "Ninguém está disponível no rodízio agora — o lead entrou na etapa sem responsável."
          : "A pessoa configurada nesta etapa não está mais ativa — o lead entrou sem responsável.";
      }
    }
  } catch (e) {
    console.error("[movimento] automação da etapa falhou:", e.message);
    resultado.aviso = "A automação desta etapa não pôde ser aplicada. O lead foi movido mesmo assim.";
  }
  return resultado;
}

const validarPessoa = (orgId, userId) =>
  db.prepare("SELECT id FROM users WHERE id = ? AND org_id = ? AND status = 'ativo'").get(userId, orgId)?.id || null;

/* ===== TROCA DE RESPONSAVEL =====

   Fica aqui, e não solto num UPDATE, porque toda troca precisa deixar rastro.
   "Quem estava com este lead em março" é uma das perguntas que a gestão mais
   faz, e ela não tem resposta se a atribuição só sobrescrever a anterior.

   `assigned_at` continua sendo carimbado: é ele que faz o lead repassado subir
   ao topo da caixa do corretor com o selo "novo com você" (regra de
   13/08/2026). */
export function trocarResponsavel(lead, novoUserId, quemMandou, motivo = "mao") {
  const atual = typeof lead === "string"
    ? db.prepare("SELECT * FROM leads WHERE id = ?").get(lead) : lead;
  if (!atual) return false;
  if (atual.assigned_to === novoUserId) return false;

  const quando = Date.now();
  const aplicar = db.transaction(() => {
    db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ?")
      .run(novoUserId, novoUserId ? quando : null, atual.id);
    db.prepare(`INSERT INTO lead_transfers
      (id,org_id,lead_id,from_pipeline_id,from_stage_id,to_pipeline_id,to_stage_id,
       from_user_id,to_user_id,triggered_by_user_id,trigger_reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "tr_" + randomUUID(), atual.org_id, atual.id,
      atual.pipeline_id, atual.stage_id, atual.pipeline_id, atual.stage_id,
      atual.assigned_to, novoUserId, quemMandou, motivo, quando);
  });
  aplicar();

  /* O FUNIL SEGUE QUEM ESTÁ COM O LEAD — quando essa pessoa tem um funil
     escolhido.

     É a outra metade da regra de 01/09/2026. Sem ela, o lead entrava no funil
     de pré-atendimento com a atendente e FICAVA lá depois de repassado: o
     corretor abria o kanban dele, no comercial, e o lead que acabou de receber
     não estava em coluna nenhuma.

     Só move quando o destinatário tem `pipeline_entrada` ESCRITO. Vazio
     significa "uso o funil padrão da casa", e mover por causa disso puxaria de
     volta para o padrão um lead que alguém pôs de propósito num funil especial
     — uma mudança silenciosa em quem nunca configurou nada. */
  const funil = novoUserId ? mudarParaOFunilDe(atual, novoUserId, quemMandou) : null;
  return { trocou: true, funil };
}

function mudarParaOFunilDe(lead, userId, quemMandou) {
  const entrada = entradaDe(lead.org_id, userId);
  if (!entrada.proprio) return null;                       // não escolheu funil
  if (entrada.pipeline_id === lead.pipeline_id) return null; // já está nele
  if (!entrada.stage_id) return null;                      // funil sem etapa ativa
  moverEtapa({ leadId: lead.id, paraEtapaId: entrada.stage_id, motivo: "automatica", userId: quemMandou });
  const p = db.prepare("SELECT name FROM pipelines WHERE id = ?").get(entrada.pipeline_id);
  console.log(`[movimento] ${lead.name} foi para o funil "${p?.name}" junto com o novo responsável`);
  return { pipeline_id: entrada.pipeline_id, pipeline: p?.name || null, etapa: entrada.nome };
}

/* Por onde o lead passou: funil, etapa e dono, em ordem. É o que a ficha mostra
   quando alguém pergunta "de onde veio este atendimento". */
export const transferenciasDoLead = (leadId) => db.prepare(`
  SELECT t.*, de.name AS de_nome, para.name AS para_nome,
         pde.name AS pipeline_de, ppara.name AS pipeline_para, q.name AS quem
  FROM lead_transfers t
  LEFT JOIN users de ON de.id = t.from_user_id
  LEFT JOIN users para ON para.id = t.to_user_id
  LEFT JOIN users q ON q.id = t.triggered_by_user_id
  LEFT JOIN pipelines pde ON pde.id = t.from_pipeline_id
  LEFT JOIN pipelines ppara ON ppara.id = t.to_pipeline_id
  WHERE t.lead_id = ? ORDER BY t.created_at DESC`).all(leadId);
