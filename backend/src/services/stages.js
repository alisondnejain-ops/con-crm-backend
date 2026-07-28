// Lógica compartilhada com o frontend: etapas, avanço automático, prioridade e telefone.

export const STAGES = ["Lead", "Atendimento", "Pasta", "Aprovação", "Agendamento", "Visita", "Proposta", "Venda", "Perdido", "Recaptação", "Transferido por ligação"];
export const LINEAR = ["Lead", "Atendimento", "Pasta", "Aprovação", "Agendamento", "Visita", "Proposta", "Venda"];

// Avança a etapa conforme a conversa evolui. Forward-only; nunca fecha como Venda
// automaticamente e não mexe em etapas manuais (Perdido/Recaptação/Transferido).
export function inferStage(current, messages) {
  const i = LINEAR.indexOf(current);
  if (i < 0) return current;
  const text = messages.filter(m => m.direction).map(m => (m.body || "").toLowerCase()).join(" ");
  const leadReplies = messages.filter(m => m.direction === "in").length;
  const has = (arr) => arr.some(k => text.includes(k));
  let t = i;
  if (messages.some(m => m.direction === "out") || leadReplies >= 1) t = Math.max(t, LINEAR.indexOf("Atendimento"));
  if (has(["documento", "documentação", "documentacao", "pasta", "cadastro", "comprovante"])) t = Math.max(t, LINEAR.indexOf("Pasta"));
  if (has(["aprov", "crédito", "credito", "análise", "analise", "financiamento", "banco", "caixa", "simulação", "simulacao"])) t = Math.max(t, LINEAR.indexOf("Aprovação"));
  if (has(["agendar", "agenda", "marcar", "horário", "horario", "que dia", "sábado", "sabado", "disponibilidade"])) t = Math.max(t, LINEAR.indexOf("Agendamento"));
  if (has(["confirmad", "te espero", "endereço", "endereco", "combinado", "no local"])) t = Math.max(t, LINEAR.indexOf("Visita"));
  if (has(["proposta", "contrato", "assinar", "valor final"])) t = Math.max(t, LINEAR.indexOf("Proposta"));
  t = Math.min(t, LINEAR.indexOf("Proposta"));
  return LINEAR[t];
}

// Normaliza telefone brasileiro para 55 + DDD + 9 + 8 dígitos (formato wa/Uazapi).
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) return d;
  if (d.length === 11) return "55" + d;
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

// Prioridade a partir das respostas de qualificação (mesma régua do MCMV usada no frontend).
export function scorePriority(q = {}) {
  const low = (v) => String(v || "").toLowerCase();
  let s = 0;
  const rd = low(q.renda);
  s += rd.includes("acima") ? 3 : rd.includes("3.501") ? 2 : rd.includes("2.001") ? 1 : 0;
  const en = low(q.entrada);
  s += (en.includes("15 mil") && en.includes("acima")) ? 3 : en.includes("entre") ? 2 : en.includes("até r$ 5") ? 1 : 0;
  const cp = low(q.cpf);
  s += (cp.includes("regular") && cp.includes("não")) ? 2 : cp.includes("regularizado") ? 1 : 0;
  const pz = low(q.prazo);
  s += pz.includes("rápido") || pz.includes("rapido") ? 3 : pz.includes("próximos 3") || pz.includes("proximos 3") ? 2 : pz.includes("3 e 6") ? 1 : 0;
  return s >= 8 ? "QUENTE" : s >= 5 ? "MORNO" : "FRIO";
}
