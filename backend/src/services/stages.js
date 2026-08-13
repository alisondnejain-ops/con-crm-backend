// Lógica compartilhada com o frontend: etapas, avanço automático, prioridade e telefone.

export const STAGES = ["Lead", "Atendimento", "Pasta", "Aprovação", "Agendamento", "Visita", "Proposta", "Venda", "Perdido", "Recaptação", "Transferido por ligação"];
export const LINEAR = ["Lead", "Atendimento", "Pasta", "Aprovação", "Agendamento", "Visita", "Proposta", "Venda"];

/* ===== AVANÇO DE ETAPA POR PALAVRA-CHAVE =====

   Regra da casa, decidida em 04/08/2026: o lead só muda de etapa quando a
   palavra daquela etapa é dita na conversa — pelo corretor ou pelo cliente.

   Antes o funil andava sozinho: abrir a conversa já jogava o lead em
   "Atendimento", e um "sábado" solto virava "Agendamento". O funil enchia de
   lead em etapa que ninguém tinha feito, e o relatório descrevia uma coisa
   enquanto o atendimento era outra. Com a palavra-chave, quem move o funil é
   o atendimento: a etapa passa a ser consequência do que foi dito.

   Duas coisas continuam valendo:
   - Só para a FRENTE. A conversa não desfaz o que já aconteceu.
   - Etapa mexida na mão manda. Perdido, Recaptação e Transferido por ligação
     ficam fora daqui — quem marcou sabe de algo que a conversa não mostra.

   Vale a palavra mais adiantada que aparecer na conversa inteira: se o
   corretor já falou em aprovação, a pasta ficou para trás — não faz sentido
   segurar o lead numa etapa que o próprio atendimento já passou. */

const semAcento = (t) => String(t || "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/* A palavra de cada etapa. `palavra` é o que a equipe lê na tela; `padroes` é
   o que o sistema procura, sem acento e por palavra inteira — para "aprova"
   não disparar dentro de outra palavra.

   As três últimas pedem contexto, e não a palavra solta: "imóvel" e
   "contrato" aparecem o tempo todo numa conversa de imobiliária, e o lead
   pularia para Visita ou Venda no primeiro "tenho um imóvel aqui". O que
   dispara é a FRASE que só se diz naquele momento do atendimento. */
export const GATILHOS = [
  { etapa: "Atendimento", palavra: "atendimento",
    padroes: [/\batendiment/, /\bvou atender\b/, /\bdar continuidade\b/] },
  { etapa: "Pasta", palavra: "documentação",
    padroes: [/\bdocumenta/, /\bdocumentos?\b/] },
  { etapa: "Aprovação", palavra: "aprovação",
    padroes: [/\baprova/] },
  { etapa: "Agendamento", palavra: "visita",
    padroes: [/\bvisita/, /\bagendar\b/, /\bagendamento\b/] },
  { etapa: "Visita", palavra: "o que achou do imóvel",
    padroes: [
      /\b(o que|oque|oq)\s+(voce\s+|vc\s+|tu\s+)?ach(ou|aram|o)\b/,
      /\bach(ou|aram)\s+d[oa]s?\s+(imove|casa|apartament|ape\b|apto|unidade|empreendiment)/,
      /\bgost(ou|aram)\s+d[oa]s?\s+(imove|casa|apartament|ape\b|apto|unidade|empreendiment)/,
      /\bdepois d[ae]\s+visita/,
    ] },
  { etapa: "Proposta", palavra: "fechar",
    padroes: [/\bfechar\b/, /\bfecharmos\b/, /\bfechamos\b/, /\bproposta\b/] },
  { etapa: "Venda", palavra: "contrato",
    padroes: [/\bcontrato/] },
];

// A palavra que leva a etapa atual para a próxima — é o que a ficha do lead
// mostra para o corretor, para ele não precisar decorar a lista.
export function proximoGatilho(etapa) {
  const i = LINEAR.indexOf(etapa);
  if (i < 0 || i >= LINEAR.length - 1) return null;
  return GATILHOS.find(g => g.etapa === LINEAR[i + 1]) || null;
}

// O texto da conversa como a regra o enxerga: tudo junto, minúsculo, sem acento.
export const textoDaConversa = (messages) =>
  semAcento(messages.filter(m => m.direction).map(m => m.body || "").join("\n"));

/* Quais palavras apareceram nesta conversa. Separado do `inferStage` porque
   responder "por que este lead não andou" exige ver o que bateu e o que não
   bateu — e não só a etapa final. É o que alimenta o diagnóstico do funil. */
export function gatilhosNaConversa(messages) {
  const texto = textoDaConversa(messages);
  return GATILHOS.filter(g => g.padroes.some(p => p.test(texto)));
}

export function inferStage(current, messages) {
  const i = LINEAR.indexOf(current);
  if (i < 0) return current;
  let t = i;
  for (const g of gatilhosNaConversa(messages)) t = Math.max(t, LINEAR.indexOf(g.etapa));
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
