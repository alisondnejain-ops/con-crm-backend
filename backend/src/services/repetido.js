/* LEAD REPETIDO NA CATRACA (CETRO 11.5, 13/11/2026).

   A mesma pessoa (mesmo telefone ou e-mail — o lead é um só) voltou por um
   canal de uma catraca: preencheu outro formulário, pediu contato num portal.
   A política é da catraca que pegaria esse lead (a mesma precedência do lead
   novo). Opções:
   - 'atual' (padrão, e o seguro): fica com quem está. Não se roleta lead que
     já é de alguém.
   - 'origem': volta ao corretor de ORIGEM — o primeiro corretor que o lead
     teve —, só se ele ainda está ativo e o lead NÃO passou adiante por um
     repasse válido (prazo vencido, tempo da catraca, decisão de gente).
     "Atual" e "origem" são coisas diferentes, e a origem nunca desfaz um
     repasse legítimo.
   - 'gestor': vai para o gestor, que decide.
   - 'etapa': move para a etapa escolhida (pela porta de sempre) e avisa o
     gestor; o dono não muda.
   Lead com venda registrada nunca muda de mão por isto. Nunca lança. */
import db from "../db.js";
import { catracasDoLeadNovo, gestorDaConta } from "./catracas.js";
import { trocarResponsavel, moverLead } from "./movimento.js";
import { avisar } from "./push.js";

const REPASSE_VALIDO = ["mao", "prazo_vencido", "sem_resposta", "lote", "saida_equipe"];

export function aplicarRepetido(orgId, lead, canal, extras = {}) {
  try {
    if (!lead || lead.sale_date) return null;
    const c = catracasDoLeadNovo(orgId, canal, extras)[0];
    if (!c || !c.repetido || c.repetido === "atual") return null;
    const gestor = gestorDaConta(orgId);
    const avisarGestor = (texto) => { if (gestor) avisar(gestor, { titulo: "Lead voltou", corpo: texto, leadId: lead.id }).catch(() => {}); };
    if (c.repetido === "gestor") {
      if (!gestor || lead.assigned_to === gestor) return null;
      trocarResponsavel(lead, gestor, null, "repetido");
      avisarGestor(`${lead.name} voltou pela catraca ${c.nome} e ficou com você.`);
      return { politica: "gestor", para: gestor };
    }
    if (c.repetido === "origem") {
      const hist = db.prepare(`SELECT from_user_id, to_user_id, trigger_reason FROM lead_transfers WHERE lead_id = ? ORDER BY created_at, rowid`).all(lead.id);
      // Os donos na ordem em que o lead passou; a origem é o PRIMEIRO corretor.
      const donos = hist.length ? [hist[0].from_user_id, ...hist.map(t => t.to_user_id)] : [lead.assigned_to];
      const ehCorretor = (id) => id && db.prepare("SELECT 1 FROM users WHERE id = ? AND org_id = ? AND status = 'ativo' AND role = 'corretor'").get(id, orgId);
      const origem = donos.find(ehCorretor);
      // Saiu da mão da origem por um repasse legítimo? A origem não o desfaz.
      if (!origem || hist.some(t => t.from_user_id === origem && REPASSE_VALIDO.includes(t.trigger_reason))) return null;
      const u = { id: origem };
      if (!u || lead.assigned_to === u.id) return null;
      trocarResponsavel(lead, u.id, null, "repetido");
      avisar(u.id, { titulo: "Lead voltou para você", corpo: `${lead.name} entrou de novo pela catraca ${c.nome}.`, leadId: lead.id }).catch(() => {});
      return { politica: "origem", para: u.id };
    }
    if (c.repetido === "etapa" && c.repetido_stage_id) {
      if (lead.stage_id === c.repetido_stage_id) { avisarGestor(`${lead.name} voltou pela catraca ${c.nome}.`); return null; }
      moverLead({ leadId: lead.id, paraEtapaId: c.repetido_stage_id, motivo: "automatica", userId: null, forcar: true });
      avisarGestor(`${lead.name} voltou pela catraca ${c.nome} e foi movido de etapa.`);
      return { politica: "etapa" };
    }
    return null;
  } catch (e) {
    console.error("[repetido] não apliquei a política:", e.message);
    return null;
  }
}
