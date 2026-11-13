/* TAREFAS WORKFLOW — A CADÊNCIA DE CADA ETAPA (CETRO capítulo 10, 13/11/2026).

   Uma cadência é trabalho HUMANO preso à entrada numa etapa: "dia 1 ligar,
   dia 2 mandar a apresentação, dia 3 retomar a conversa". Não é um fluxo de
   mensagens que o robô manda sozinho — isso é Marketing → Fluxos.

   As regras que sustentam o número:

   - ENTRAR NA ETAPA instancia os passos como tarefas do lead, de modo
     IDEMPOTENTE: a chave (lead, passo, instante da entrada) é única no banco.
     Reentrar na mesma etapa é uma entrada NOVA — as tarefas em aberto da
     entrada anterior saem e as novas nascem. SAIR da etapa tira as tarefas
     da cadência que ainda estavam em aberto (as feitas ficam no histórico):
     trabalho de uma etapa em que o lead não está mais não é cobrável.
   - Mudança de etapa EM MASSA (Arrumar a base, reanálise — `gatilhos:false`)
     limpa o que ficou para trás mas NÃO cria tarefa: trezentas cadências por
     causa de uma arrumação seria o pior desfecho.
   - A TAREFA CONCLUI SOZINHA só com evidência real, e só a de janela já
     aberta: "mensagem" = uma mensagem de saída escrita por alguém da equipe;
     "ligação" = um registro de tentativa no Ligar; "conversa" = ligação
     atendida ("falou") ou o cliente respondendo depois de uma mensagem da
     equipe — texto unilateral NÃO é conversa. Uma ação de hoje conclui UMA
     tarefa (a mais antiga de janela aberta), nunca as dos próximos dias.
   - A tarefa da cadência NÃO segura o prazo da etapa (o SLA): vencer uma
     tarefa e vencer o prazo são fatos distintos. */
import { randomUUID } from "crypto";
import db from "../db.js";
import { semDisparo } from "./marca-disparo.js";

export const CRITERIOS = {
  mensagem: "Mensagem enviada",
  ligacao: "Ligação realizada",
  conversa: "Conversa efetiva",
  manual: "Marcar à mão",
};
export const MAX_PASSOS = 30;
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function passosDaEtapa(orgId, stageId, { soAtivos = false } = {}) {
  return db.prepare(`SELECT id, dia, hora, acao, instrucao, criterio, ativo, ordem FROM cadencia_passos
    WHERE org_id = ? AND stage_id = ? ${soAtivos ? "AND ativo = 1" : ""} ORDER BY dia, ordem, created_at`)
    .all(orgId, stageId).map(p => ({ ...p, ativo: !!p.ativo }));
}

// Quantos passos cada etapa da conta tem (a tela mostra ao lado do nome).
export function contagemPorEtapa(orgId) {
  return new Map(db.prepare(`SELECT stage_id, COUNT(*) n FROM cadencia_passos WHERE org_id = ? AND ativo = 1 GROUP BY stage_id`)
    .all(orgId).map(r => [r.stage_id, r.n]));
}

/* Confere e normaliza a lista que veio da tela (ou do extrator). Devolve
   {passos} ou {erro} com a frase de qual linha está errada. */
export function conferirPassos(lista) {
  if (!Array.isArray(lista)) return { erro: "Envie a lista de passos." };
  if (lista.length > MAX_PASSOS) return { erro: `No máximo ${MAX_PASSOS} passos por etapa.` };
  const passos = [];
  for (const [i, p] of lista.entries()) {
    const n = i + 1;
    const dia = Number(p && p.dia);
    if (!Number.isInteger(dia) || dia < 1 || dia > 90) return { erro: `Passo ${n}: o dia vai de 1 a 90 (1 = o dia em que o lead entra na etapa).` };
    const hora = p.hora ? String(p.hora).trim() : null;
    if (hora && !HORA.test(hora)) return { erro: `Passo ${n}: horário inválido (use 09:00).` };
    const acao = String(p.acao || "").replace(/\s+/g, " ").trim();
    if (!acao) return { erro: `Passo ${n}: escreva a ação.` };
    if (acao.length > 120) return { erro: `Passo ${n}: a ação passa de 120 letras — o detalhe vai na instrução.` };
    const instrucao = String(p.instrucao || "").trim();
    if (instrucao.length > 600) return { erro: `Passo ${n}: a instrução passa de 600 letras.` };
    const criterio = CRITERIOS[p.criterio] ? p.criterio : null;
    if (!criterio) return { erro: `Passo ${n}: escolha como a tarefa é concluída.` };
    passos.push({ id: p.id ? String(p.id) : null, dia, hora, acao, instrucao: instrucao || null, criterio, ativo: p.ativo === false ? 0 : 1 });
  }
  return { passos };
}

/* Grava a cadência da etapa INTEIRA (o que não veio é apagado). Passo que já
   existia mantém o id — as tarefas em aberto continuam ligadas a ele. As
   tarefas já criadas não são reescritas: valem para quem entrar daqui em diante. */
export function salvarCadencia(orgId, stageId, lista) {
  const etapa = db.prepare("SELECT id FROM pipeline_stages WHERE id = ? AND org_id = ?").get(stageId, orgId);
  if (!etapa) return { erro: "Etapa não encontrada." };
  const c = conferirPassos(lista);
  if (c.erro) return c;
  const agora = Date.now();
  const existentes = new Set(db.prepare("SELECT id FROM cadencia_passos WHERE org_id = ? AND stage_id = ?").all(orgId, stageId).map(r => r.id));
  db.transaction(() => {
    const ficam = new Set();
    c.passos.forEach((p, ordem) => {
      if (p.id && existentes.has(p.id)) {
        db.prepare(`UPDATE cadencia_passos SET dia=?, hora=?, acao=?, instrucao=?, criterio=?, ativo=?, ordem=?, updated_at=? WHERE id=?`)
          .run(p.dia, p.hora, p.acao, p.instrucao, p.criterio, p.ativo, ordem, agora, p.id);
        ficam.add(p.id);
      } else {
        db.prepare(`INSERT INTO cadencia_passos (id,org_id,stage_id,ordem,dia,hora,acao,instrucao,criterio,ativo,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("cp_" + randomUUID(), orgId, stageId, ordem, p.dia, p.hora, p.acao, p.instrucao, p.criterio, p.ativo, agora, agora);
      }
    });
    for (const id of existentes) if (!ficam.has(id)) db.prepare("DELETE FROM cadencia_passos WHERE id = ?").run(id);
  })();
  return { ok: true, passos: passosDaEtapa(orgId, stageId) };
}

/* Quando o passo vence e quando a janela abre. Dia 1 é o dia da entrada.
   Sem horário, vale o fim do dia. Nunca vence antes de 1 hora depois da
   entrada — senão o passo "dia 1 às 09:00" de quem entra às 15:00 nasceria
   atrasado. A janela do dia 1 abre na entrada; dos outros, à meia-noite. */
export function momentosDoPasso(entrada, dia, hora) {
  const d = new Date(entrada); d.setDate(d.getDate() + dia - 1);
  const inicio = new Date(d); inicio.setHours(0, 0, 0, 0);
  if (hora) { const [h, m] = hora.split(":").map(Number); d.setHours(h, m, 0, 0); }
  else d.setHours(23, 59, 0, 0);
  return { quando: Math.max(d.getTime(), entrada + 3600000), janela: dia === 1 ? entrada : inicio.getTime() };
}

/* O lead mudou de etapa (ou nasceu numa). Tira as tarefas da cadência em
   aberto que não são desta entrada e, com `criar`, instancia os passos da
   etapa atual. Nunca lança: cadência com problema não impede mover lead. */
export function entrarNaCadencia(leadId, { criar = true, entrada = null } = {}) {
  try {
    const lead = db.prepare("SELECT id, org_id, stage_id, assigned_to, stage_entered_at FROM leads WHERE id = ?").get(leadId);
    if (!lead) return 0;
    const quando = entrada || lead.stage_entered_at || Date.now();
    // Saída da etapa (ou reentrada): o que ficou em aberto de outra entrada sai.
    db.prepare(`DELETE FROM tarefas WHERE lead_id = ? AND cadencia_passo_id IS NOT NULL AND feito_em IS NULL
      AND (cadencia_stage_id IS NOT ? OR cadencia_entrada IS NOT ?)`).run(lead.id, lead.stage_id, quando);
    if (!criar || !lead.stage_id) return 0;
    const passos = passosDaEtapa(lead.org_id, lead.stage_id, { soAtivos: true });
    let n = 0;
    for (const p of passos) {
      const m = momentosDoPasso(quando, p.dia, p.hora);
      const r = db.prepare(`INSERT OR IGNORE INTO tarefas (id,org_id,lead_id,user_id,criado_por,titulo,quando,created_at,
          cadencia_passo_id,cadencia_stage_id,cadencia_entrada,criterio,instrucao,janela_inicio)
        VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run("tf_" + randomUUID(), lead.org_id, lead.id, lead.assigned_to || null,
        p.acao, m.quando, Date.now(), p.id, lead.stage_id, quando, p.criterio, p.instrucao, m.janela);
      n += r.changes;
    }
    return n;
  } catch (e) {
    console.error("[cadencia] não instanciei:", e.message);
    return 0;
  }
}

/* Aconteceu uma ação com evidência real. Conclui a tarefa da cadência MAIS
   ANTIGA daquele critério cuja janela já abriu. Nunca lança. */
export function acaoDaCadencia(leadId, tipo, { quando = Date.now(), userId = null, evidencia = null } = {}) {
  try {
    if (!CRITERIOS[tipo] || tipo === "manual") return null;
    const t = db.prepare(`SELECT id FROM tarefas WHERE lead_id = ? AND cadencia_passo_id IS NOT NULL AND feito_em IS NULL
        AND criterio = ? AND janela_inicio <= ? ORDER BY quando ASC LIMIT 1`).get(leadId, tipo, quando);
    if (!t) return null;
    db.prepare(`UPDATE tarefas SET feito_em = ?, concluida_por = ?, evidencia = ?, concluida_user = ? WHERE id = ? AND feito_em IS NULL`)
      .run(quando, tipo, evidencia ? String(evidencia).slice(0, 200) : null, userId, t.id);
    return t.id;
  } catch (e) {
    console.error("[cadencia] não concluí:", e.message);
    return null;
  }
}

/* O cliente escreveu: só é CONVERSA EFETIVA se alguém da equipe tinha
   escrito antes (mensagem com autor de gente). O "oi" de quem chega sozinho
   não conclui nada. */
export function clienteRespondeu(leadId, quando = Date.now()) {
  try {
    // Mensagem de gente: do CRM com autor ou digitada no celular — não disparo,
    // automação nem o Autoatendimento.
    const houve = db.prepare(`SELECT 1 FROM messages m WHERE m.lead_id = ? AND m.direction = 'out' AND m.created_at < ?
      AND ${semDisparo("m.")} AND NOT (m.from_user_id IS NULL AND COALESCE(m.from_name, '') = 'Atendimento automático') LIMIT 1`).get(leadId, quando);
    if (!houve) return null;
    return acaoDaCadencia(leadId, "conversa", { quando, evidencia: "o cliente respondeu" });
  } catch { return null; }
}

/* ===== IMPORTAR A CADÊNCIA DE UM DOCUMENTO =====
   Lê o texto (colado, .txt, .docx, .csv) e devolve os passos para REVISÃO —
   nada é gravado aqui. Uma linha com "Dia N" abre um passo; o resto da linha
   é a ação; as linhas seguintes sem "dia" viram a instrução. O critério é
   adivinhado pelas palavras e a tela deixa trocar antes de salvar. */
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function adivinharCriterio(texto) {
  const t = semAcento(texto);
  if (/conversa efetiva|falar com|conversar|retom|contato efetivo|atend(a|er) a liga/.test(t)) return "conversa";
  if (/\blig(ar|ue|acao|ar para)|telefon/.test(t)) return "ligacao";
  if (/mensag|envi|mand|whats|apresenta|material|video|foto|audio|e-?mail/.test(t)) return "mensagem";
  return "manual";
}
export function extrairCadencia(texto) {
  const linhas = String(texto || "").replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  const passos = [], ignoradas = [];
  let atual = null;
  for (const linha of linhas) {
    const m = /^(?:[-•*\d.)\s]*)?d(?:ia)?\s*0?(\d{1,2})\b\s*[:\-–—.)]?\s*(.*)$/i.exec(linha);
    if (m) {
      const dia = Number(m[1]);
      let resto = m[2].trim();
      let hora = null;
      const h = /(?:^|\s|às|as|@)\s*(\d{1,2})[:h](\d{2})?\b/i.exec(resto);
      if (h && Number(h[1]) < 24) {
        hora = String(h[1]).padStart(2, "0") + ":" + (h[2] || "00");
        resto = (resto.slice(0, h.index) + resto.slice(h.index + h[0].length)).replace(/^\s*[-–—,:]\s*|\s*[-–—,:]\s*$/g, "").trim();
      }
      const [acao, ...det] = resto.split(/\s+[-–—:]\s+|\.\s+/);
      atual = { dia: Math.min(Math.max(dia, 1), 90), hora, acao: (acao || "").slice(0, 120) || `Passo do dia ${dia}`,
        instrucao: det.join(". ").trim() || null, criterio: adivinharCriterio(resto) };
      passos.push(atual);
    } else if (atual) {
      atual.instrucao = ((atual.instrucao ? atual.instrucao + "\n" : "") + linha).slice(0, 600);
      if (atual.criterio === "manual") atual.criterio = adivinharCriterio(linha);
    } else ignoradas.push(linha);
  }
  return { passos: passos.slice(0, MAX_PASSOS), ignoradas: ignoradas.length, cortados: Math.max(passos.length - MAX_PASSOS, 0) };
}
