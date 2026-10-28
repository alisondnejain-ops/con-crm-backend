/* MENSAGEM AGENDADA NA CONVERSA (28/10/2026, pedido do Fernando).

   O corretor escreve agora e escolhe quando a mensagem sai — o follow-up de
   "amanhã às 9h" sem depender de lembrar. Regras:

   - Sai pelo MESMO envio do botão Enviar (`enviarTextoDoCrm`): mesma linha,
     mesma assinatura, mesmo registro na conversa. A mensagem agendada é uma
     mensagem de quem a escreveu, só que mais tarde.
   - Na hora de sair, confere de novo se quem agendou ainda pode falar com
     esse lead. Lead repassado a outra pessoa, conta desativada ou lead apagado
     CANCELAM com o motivo escrito — mandar em nome de quem não está mais no
     atendimento seria uma mensagem que ninguém da equipe espera.
   - Uma tentativa só. Se o WhatsApp recusar, fica "falhou" com o motivo, e a
     tela mostra: tentar de novo sozinho arrisca mandar duas vezes.
   - "enviando" é a trava: a linha só é pega por quem conseguir trocar
     pendente → enviando, então dois ciclos nunca mandam a mesma mensagem. */
import { randomUUID } from "crypto";
import db from "../db.js";
import { podeVerLead, supervisiona } from "../auth.js";
import { enviarTextoDoCrm } from "../routes/messages.routes.js";

export const TETO_TEXTO = 4000;
export const TETO_POR_LEAD = 20;
const MIN_ANTECEDENCIA = 60000;          // pelo menos 1 minuto no futuro
const MAX_ANTECEDENCIA = 90 * 86400000;  // até 90 dias

const lerLinha = (id) => db.prepare("SELECT * FROM mensagens_agendadas WHERE id = ?").get(id);

function formatar(a) {
  const u = db.prepare("SELECT name FROM users WHERE id = ?").get(a.user_id);
  return { id: a.id, texto: a.texto, quando: a.quando, status: a.status, motivo: a.motivo || null,
    enviada_em: a.enviada_em || null, user_id: a.user_id, de_quem: u ? u.name : null, created_at: a.created_at };
}

/* As que esperam e as que deram errado nos últimos 7 dias: é o que a tela
   precisa mostrar. A enviada já está na conversa. */
export function listarDoLead(leadId, agora = Date.now()) {
  return db.prepare(`SELECT * FROM mensagens_agendadas WHERE lead_id = ?
      AND (status IN ('pendente','enviando') OR (status IN ('falhou','cancelada') AND created_at >= ?))
    ORDER BY quando ASC`).all(leadId, agora - 7 * 86400000).map(formatar);
}

export function agendar({ user, lead, texto, quando, agora = Date.now() }) {
  const t = String(texto || "").trim();
  if (!t) return { erro: "Escreva a mensagem.", status: 400 };
  if (t.length > TETO_TEXTO) return { erro: `A mensagem passa de ${TETO_TEXTO} letras.`, status: 400 };
  const q = Number(quando);
  if (!Number.isFinite(q)) return { erro: "Escolha a data e a hora.", status: 400 };
  if (q < agora + MIN_ANTECEDENCIA) return { erro: "Escolha um horário pelo menos 1 minuto à frente.", status: 400 };
  if (q > agora + MAX_ANTECEDENCIA) return { erro: "Dá para agendar até 90 dias à frente.", status: 400 };
  const pendentes = db.prepare("SELECT COUNT(*) n FROM mensagens_agendadas WHERE lead_id = ? AND status = 'pendente'").get(lead.id).n;
  if (pendentes >= TETO_POR_LEAD) return { erro: `Este lead já tem ${TETO_POR_LEAD} mensagens agendadas.`, status: 409 };
  const id = "ag_" + randomUUID();
  db.prepare(`INSERT INTO mensagens_agendadas (id,org_id,lead_id,user_id,texto,quando,status,created_at)
    VALUES (?,?,?,?,?,?,'pendente',?)`).run(id, lead.org_id, lead.id, user.id, t, q, agora);
  return { ok: true, agendada: formatar(lerLinha(id)) };
}

/* Cancelar: o autor cancela a dele; a supervisão cancela qualquer uma. */
export function cancelar({ user, lead, id }) {
  const a = db.prepare("SELECT * FROM mensagens_agendadas WHERE id = ? AND lead_id = ?").get(id, lead.id);
  if (!a) return { erro: "Mensagem agendada não encontrada.", status: 404 };
  if (a.user_id !== user.id && !supervisiona(user)) return { erro: "Só quem agendou (ou a gestão) cancela.", status: 403 };
  const r = db.prepare(`UPDATE mensagens_agendadas SET status = 'cancelada', motivo = ?
    WHERE id = ? AND status = 'pendente'`).run("Cancelada por " + (user.name || "alguém da equipe"), id);
  if (!r.changes) return { erro: "Esta mensagem já saiu (ou está saindo agora) e não dá mais para cancelar.", status: 409 };
  return { ok: true };
}

/* Quem agendou, como o envio precisa dele — lido do BANCO na hora de sair,
   não do que estava valendo quando agendou. */
function autor(a) {
  const u = db.prepare("SELECT id, org_id, name, role, status, master FROM users WHERE id = ?").get(a.user_id);
  if (!u || u.status !== "ativo") return null;
  return { id: u.id, org_id: u.org_id, name: u.name, role: u.role, master: !!u.master };
}

const encerrar = (id, status, motivo, extra = {}) => db.prepare(
  `UPDATE mensagens_agendadas SET status = ?, motivo = ?, enviada_em = ? WHERE id = ?`)
  .run(status, motivo, extra.enviada_em || null, id);

let rodando = false;
export async function processarAgendadas(agora = Date.now(), limite = 20) {
  // Um ciclo por vez: o envio pode levar segundos, e o batimento não espera.
  if (rodando) return { enviadas: 0, vistas: 0 };
  rodando = true;
  try { return await ciclo(agora, limite); } finally { rodando = false; }
}

async function ciclo(agora, limite) {
  /* Ficou em "enviando" por mais de 10 minutos: o servidor reiniciou no meio
     do envio. Não dá para saber se saiu — a tela diz isso, sem mandar de novo.
     (`enviada_em` guarda, enquanto está "enviando", a hora em que começou.) */
  db.prepare(`UPDATE mensagens_agendadas SET status = 'falhou', enviada_em = NULL,
      motivo = 'O servidor reiniciou durante o envio — confira na conversa se a mensagem saiu.'
    WHERE status = 'enviando' AND enviada_em < ?`).run(agora - 10 * 60000);

  const vencidas = db.prepare(`SELECT id FROM mensagens_agendadas
    WHERE status = 'pendente' AND quando <= ? ORDER BY quando ASC LIMIT ?`).all(agora, limite);
  let enviadas = 0;
  for (const { id } of vencidas) {
    const pega = db.prepare("UPDATE mensagens_agendadas SET status = 'enviando', enviada_em = ? WHERE id = ? AND status = 'pendente'").run(agora, id);
    if (!pega.changes) continue;
    const a = lerLinha(id);
    const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(a.lead_id);
    if (!lead || lead.org_id !== a.org_id || lead.anonimizado_em) { encerrar(id, "cancelada", "O lead não existe mais."); continue; }
    const user = autor(a);
    if (!user) { encerrar(id, "cancelada", "Quem agendou não está mais ativo na equipe."); continue; }
    if (user.org_id !== lead.org_id || !podeVerLead(user, lead)) {
      encerrar(id, "cancelada", "O lead não está mais com quem agendou."); continue;
    }
    try {
      await enviarTextoDoCrm({ user, lead, text: a.texto });
      encerrar(id, "enviada", null, { enviada_em: Date.now() });
      enviadas++;
    } catch (e) {
      encerrar(id, "falhou", "O WhatsApp não aceitou: " + String(e.message || e).slice(0, 200));
    }
  }
  return { enviadas, vistas: vencidas.length };
}
