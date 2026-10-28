/* PRAZO DA ETAPA VENCIDO, COM CONSEQUÊNCIA (28/10/2026, pedido do Fernando;
   o Ali decidiu que a escolha é do gestor, em Configurações → Atendimento).

   Até aqui o prazo (`sla_minutes` da etapa) só pintava o lead de coral. Agora
   o gestor escolhe o que acontece quando ele vence num lead de CORRETOR:

     'marcar'            só marca, como sempre foi (é o padrão: nula também);
     'proximo_corretor'  o lead vai para o próximo corretor disponível da
                         catraca do lead (ou da principal), movendo a vez;
     'atendente'         o lead volta para a atendente da vez.

   AS REGRAS QUE SEGURAM ISSO:

   - Só lead de CORRETOR ativo. Com a atendente, na fila ou com o gestor, o
     prazo continua só marcando — devolver o lead da atendente para ela mesma,
     ou tirar o do gestor, não é o que a regra existe para resolver.
   - O relógio conta da última conversa com o cliente, como o prazo de sempre
     (`slaDoLead`), MAS também de quando o lead chegou na mão da pessoa e da
     última vez que esta regra agiu. Sem isso, o lead recém-repassado já
     chegaria vencido no próximo corretor e rodaria a equipe inteira em minutos.
   - Tarefa marcada para o futuro segura o lead (pedido do Fernando: "lead com
     tarefa marcada não fica atrasado"): o corretor combinou voltar depois.
   - Etapa de ganho ou perda, lead finalizado e lead com venda ficam de fora.
   - No máximo `prazo_max_repasses` vezes seguidas (padrão 2) sem alguém falar
     com o cliente — depois disso o lead fica onde está, em coral. A contagem
     zera quando a conversa volta a acontecer.
   - Ninguém disponível (corretor) ou nenhuma atendente ativa: o lead fica
     onde está e a regra tenta de novo no minuto seguinte. À noite, com a
     disponibilidade encerrada, nada se move.
   - O lead NÃO muda de etapa nem de funil: muda quem atende.
   - Conta de autônomo não tem catraca nem atendente para onde mandar.

   A troca passa por `trocarResponsavel` (o único caminho por onde o dono muda),
   com motivo 'prazo_vencido' — fica no histórico e o relatório mostra quem
   perdeu e quem recebeu. Não entra na penalidade "perdidos para outro
   corretor", que conta só repasse feito por uma pessoa (motivo 'mao'). */
import db from "../db.js";
import { trocarResponsavel } from "./movimento.js";
import { filaDoLead, marcarQueRecebeuNoLead } from "./catracas.js";
import { proximoAtendente } from "./catraca.js";
import { avisar } from "./push.js";

export const ACOES = ["marcar", "proximo_corretor", "atendente"];
export const PADRAO_MAX = 2;

export function configDoPrazo(orgId) {
  const o = db.prepare("SELECT prazo_acao, prazo_max_repasses, tipo FROM orgs WHERE id = ?").get(orgId) || {};
  return {
    acao: ACOES.includes(o.prazo_acao) ? o.prazo_acao : "marcar",
    max_repasses: o.prazo_max_repasses || PADRAO_MAX,
    // A conta de um corretor só não tem para onde mandar o lead.
    disponivel: o.tipo !== "autonomo",
  };
}

export function definirConfigDoPrazo(orgId, { acao, max_repasses } = {}) {
  const atual = configDoPrazo(orgId);
  if (!atual.disponivel) return { erro: "Na conta de corretor autônomo não há para quem passar o lead." };
  const a = acao === undefined ? atual.acao : acao;
  if (!ACOES.includes(a)) return { erro: "Escolha o que acontece quando o prazo vence." };
  let m = max_repasses === undefined ? atual.max_repasses : Number(max_repasses);
  if (!Number.isInteger(m) || m < 1 || m > 10) return { erro: "O número de repasses seguidos vai de 1 a 10." };
  db.prepare("UPDATE orgs SET prazo_acao = ?, prazo_max_repasses = ? WHERE id = ?").run(a, m, orgId);
  return configDoPrazo(orgId);
}

// Quantas etapas desta conta têm prazo — a tela diz isso, porque sem prazo em
// etapa nenhuma a escolha não faz nada.
export function etapasComPrazo(orgId) {
  return db.prepare(`SELECT COUNT(*) n FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.org_id = ? AND s.is_active = 1 AND p.is_active = 1 AND s.sla_minutes > 0`).get(orgId).n;
}

/* De quando o prazo conta, para esta regra. */
function baseDoPrazo(l) {
  const conversa = l.last_interaction_at || l.stage_entered_at || l.created_at || 0;
  return Math.max(conversa, l.assigned_at || 0, l.prazo_repasse_em || 0);
}

/* Os leads em que a regra agiria agora. Exportado para o teste. */
export function vencidosParaAgir(orgId, agora = Date.now(), limite = 50) {
  const cfg = configDoPrazo(orgId);
  if (!cfg.disponivel || cfg.acao === "marcar") return [];
  const linhas = db.prepare(`SELECT l.*, s.sla_minutes, s.name etapa_nome, u.name dono_nome
    FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id JOIN users u ON u.id = l.assigned_to
    WHERE l.org_id = ? AND l.closed_at IS NULL AND l.sale_date IS NULL
      AND s.sla_minutes > 0 AND s.is_active = 1 AND COALESCE(s.status_type, 'aberto') NOT IN ('ganho', 'perdido')
      AND u.role = 'corretor' AND u.status = 'ativo'`).all(orgId);
  const tarefaFutura = db.prepare("SELECT 1 FROM tarefas WHERE lead_id = ? AND feito_em IS NULL AND quando >= ? LIMIT 1");
  const fora = [];
  for (const l of linhas) {
    if (baseDoPrazo(l) + l.sla_minutes * 60000 > agora) continue;
    // A contagem zera quando alguém voltou a falar com o cliente.
    const seguidos = l.prazo_repasse_em && (l.last_interaction_at || 0) <= l.prazo_repasse_em ? (l.prazo_repasses || 0) : 0;
    if (seguidos >= cfg.max_repasses) continue;
    if (tarefaFutura.get(l.id, agora)) continue;
    fora.push({ ...l, seguidos });
    if (fora.length >= limite) break;
  }
  return fora;
}

/* O próximo corretor DISPONÍVEL que não é o dono atual, na ordem da vez da
   catraca do lead (ou da principal). Sem ninguém, nulo. */
function outroCorretor(orgId, lead) {
  const f = filaDoLead(orgId, lead);
  const proximo = (f.fila || []).filter(p => p.posicao && p.id !== lead.assigned_to)
    .sort((a, b) => a.posicao - b.posicao)[0];
  return proximo ? proximo.id : null;
}

export async function agirNosVencidos(orgId, agora = Date.now()) {
  const cfg = configDoPrazo(orgId);
  const feitos = [];
  for (const l of vencidosParaAgir(orgId, agora)) {
    let destino = null;
    if (cfg.acao === "proximo_corretor") {
      destino = outroCorretor(orgId, l);
      if (destino) marcarQueRecebeuNoLead(orgId, l, destino);
    } else if (cfg.acao === "atendente") {
      destino = proximoAtendente(orgId);
      // Para a "atendente" que for o próprio dono (não acontece: dono é
      // corretor), ou ninguém ativo: o lead fica onde está.
      if (destino === l.assigned_to) destino = null;
    }
    if (!destino) continue;
    const r = trocarResponsavel(l, destino, null, "prazo_vencido", { manterFunil: true });
    if (!r) continue;
    db.prepare("UPDATE leads SET prazo_repasses = ?, prazo_repasse_em = ? WHERE id = ?")
      .run(l.seguidos + 1, agora, l.id);
    feitos.push({ lead_id: l.id, de: l.assigned_to, para: destino });
    console.log(`[prazo] ${l.name}: prazo de "${l.etapa_nome}" venceu com ${l.dono_nome} — passou para outra pessoa`);
    const novo = db.prepare("SELECT name FROM users WHERE id = ?").get(destino);
    // Os avisos ficam fora do caminho: push que demora não segura a regra.
    avisar(destino, { titulo: "Lead para você", corpo: `${l.name} — o prazo da etapa ${l.etapa_nome} venceu com ${l.dono_nome}.`, leadId: l.id }).catch(() => {});
    avisar(l.assigned_to, { titulo: "Lead repassado", corpo: `${l.name} foi para ${novo?.name || "outra pessoa"}: o prazo da etapa ${l.etapa_nome} venceu.`, leadId: l.id }).catch(() => {});
  }
  return feitos;
}

export async function agirNosVencidosEmTodas(agora = Date.now()) {
  const orgs = db.prepare("SELECT id FROM orgs WHERE prazo_acao IN ('proximo_corretor','atendente')").all();
  for (const o of orgs) {
    try { await agirNosVencidos(o.id, agora); }
    catch (e) { console.error("[prazo] erro na conta", o.id, e.message); }
  }
}
