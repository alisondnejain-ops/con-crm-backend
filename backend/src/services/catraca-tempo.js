/* TEMPO PARA PEGAR O LEAD, POR CATRACA (30/10/2026, áudio do Fernando: "se o
   corretor não pegou o lead em X minutos, passa para o próximo da catraca").

   Cada catraca de produto pode ter um tempo (`catracas.tempo_resposta_min`).
   O lead dela que está com um corretor MEMBRO da catraca e que, passado esse
   tempo desde que chegou na mão dele (`assigned_at`), não recebeu nenhuma
   mensagem nem ligação DELE, vai para o próximo disponível da mesma catraca,
   movendo a vez. As regras:

   - "Pegar" é falar com o cliente: mensagem escrita por ele (não disparo,
     automação nem IA — essas não têm autor) ou ligação registrada por ele.
     Abrir a conversa não conta: não há como saber se alguém leu.
   - Só corretor membro da catraca. Lead entregue a dedo a quem não é da
     catraca não é tirado: foi escolha de alguém, não da roda.
   - No máximo `max_voltas` (padrão 2) vezes por lead. Depois, fica com quem
     está — a catraca inteira já teve a chance, e girar para sempre seria
     tirar o lead de todo mundo sem ninguém atender.
   - Só lead entregue DEPOIS de o tempo ser ligado na catraca (`tempo_desde`):
     ligar não pode tirar de uma vez os leads antigos de todo mundo.
   - Ninguém mais disponível na catraca: fica, e tenta no minuto seguinte. À
     noite, com a disponibilidade encerrada, nada se move.
   - Lead finalizado ou com venda fica de fora; a etapa e o funil não mudam.
   - Passa por `trocarResponsavel` com motivo 'sem_resposta' (histórico e linha
     do tempo), e os dois são avisados no celular. Não conta na penalidade de
     "perdidos para outro corretor", que é só repasse feito por uma pessoa. */
import db from "../db.js";
import { trocarResponsavel } from "./movimento.js";
import { filaDaCatraca, marcarQueRecebeuNoLead } from "./catracas.js";
import { avisar } from "./push.js";

const PADRAO_VOLTAS = 2;

export function semRespostaParaAgir(orgId, agora = Date.now(), limite = 50) {
  const linhas = db.prepare(`SELECT l.*, c.nome catraca_nome, c.tempo_resposta_min, c.max_voltas, u.name dono_nome
    FROM leads l JOIN catracas c ON c.id = l.catraca_id AND c.org_id = l.org_id
    JOIN users u ON u.id = l.assigned_to
    JOIN catraca_membros m ON m.catraca_id = c.id AND m.user_id = l.assigned_to
    WHERE l.org_id = ? AND c.ativa = 1 AND c.tempo_resposta_min > 0
      AND l.closed_at IS NULL AND l.sale_date IS NULL AND l.assigned_at IS NOT NULL
      AND u.role = 'corretor' AND u.status = 'ativo'
      AND l.assigned_at >= COALESCE(c.tempo_desde, 0)
      AND l.assigned_at + c.tempo_resposta_min * 60000 <= ?
      AND COALESCE(l.catraca_voltas, 0) < COALESCE(c.max_voltas, ${PADRAO_VOLTAS})
      AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.lead_id = l.id AND x.direction = 'out'
        AND x.from_user_id = l.assigned_to AND x.created_at >= l.assigned_at)
      AND NOT EXISTS (SELECT 1 FROM ligacoes g WHERE g.lead_id = l.id
        AND g.user_id = l.assigned_to AND g.created_at >= l.assigned_at)
    LIMIT ?`).all(orgId, agora, limite);
  return linhas;
}

export async function agirSemResposta(orgId, agora = Date.now()) {
  const feitos = [];
  for (const l of semRespostaParaAgir(orgId, agora)) {
    const f = filaDaCatraca(orgId, l.catraca_id);
    const proximo = f && (f.fila || []).filter(p => p.posicao && p.id !== l.assigned_to)
      .sort((a, b) => a.posicao - b.posicao)[0];
    if (!proximo) continue;
    marcarQueRecebeuNoLead(orgId, l, proximo.id);
    const r = trocarResponsavel(l, proximo.id, null, "sem_resposta", { manterFunil: true });
    if (!r) continue;
    db.prepare("UPDATE leads SET catraca_voltas = COALESCE(catraca_voltas, 0) + 1 WHERE id = ?").run(l.id);
    feitos.push({ lead_id: l.id, de: l.assigned_to, para: proximo.id });
    console.log(`[catraca] ${l.name}: ${l.dono_nome} não pegou em ${l.tempo_resposta_min} min — foi para o próximo de "${l.catraca_nome}"`);
    avisar(proximo.id, { titulo: "Lead para você", corpo: `${l.name} — ${l.dono_nome} não falou com o cliente em ${l.tempo_resposta_min} min.`, leadId: l.id }).catch(() => {});
    avisar(l.assigned_to, { titulo: "Lead repassado", corpo: `${l.name} foi para ${proximo.name}: ninguém falou com o cliente em ${l.tempo_resposta_min} min.`, leadId: l.id }).catch(() => {});
  }
  return feitos;
}

export async function agirSemRespostaEmTodas(agora = Date.now()) {
  const orgs = db.prepare("SELECT DISTINCT org_id FROM catracas WHERE ativa = 1 AND tempo_resposta_min > 0").all();
  for (const o of orgs) {
    try { await agirSemResposta(o.org_id, agora); }
    catch (e) { console.error("[catraca] erro no tempo para pegar, conta", o.org_id, e.message); }
  }
}
