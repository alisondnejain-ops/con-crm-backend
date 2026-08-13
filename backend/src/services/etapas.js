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

export const MOTIVOS = {
  mao: "mudança na mão",
  palavra: "palavra-chave na conversa",
  ia: "leitura da IA confirmada",
  venda: "venda registrada",
  reanalise: "reanálise da base",
};

/* Grava a mudança E aplica na tabela de leads, numa transação só.

   As duas juntas de propósito: etapa gravada sem histórico volta a ser o
   problema de hoje, e histórico gravado sem a etapa é registro de uma coisa
   que não aconteceu. Devolve `true` quando houve mudança de fato. */
export function moverEtapa({ leadId, para, motivo = "mao", userId = null, de = null }) {
  const lead = db.prepare("SELECT id, org_id, stage FROM leads WHERE id = ?").get(leadId);
  if (!lead) return false;
  const anterior = de ?? lead.stage;
  if (anterior === para) return false;

  const aplicar = db.transaction(() => {
    db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(para, leadId);
    db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,motivo,user_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run("le_" + randomUUID(), lead.org_id, leadId, anterior, para, motivo, userId, Date.now());
  });
  aplicar();
  return true;
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
