/* Cliente esperando resposta.

   O CRM já mostrava o tempo de espera na tela — mas só para quem estava com a
   tela aberta. Quem fechou o CRM e foi almoçar não descobria nada, e o cliente
   ficava parado. Aqui o aviso vai atrás do corretor.

   Duas formas de o aviso sair:
   - SOZINHO, quando a espera passa do tempo combinado (`alerta_resposta_min`).
   - NA MÃO, quando a gestão cutuca um atendimento específico.

   Mesmo princípio do corte de expediente e do aviso de plantão: nada depende
   de um alarme tocar na hora certa. O que impede o aviso repetido é o carimbo
   `alerta_em` no próprio lead, e é ele também que faz o aviso ainda sair
   quando o servidor esteve fora do ar. */

import db from "../db.js";
import { avisar } from "./push.js";

export const PADRAO_MIN = 30;

// 0 (ou vazio) desliga o aviso automático para a imobiliária inteira.
export function minutosDaOrg(orgId) {
  const o = db.prepare("SELECT alerta_resposta_min FROM orgs WHERE id = ?").get(orgId);
  const v = o && o.alerta_resposta_min;
  return v === null || v === undefined ? PADRAO_MIN : Number(v);
}

export function definirMinutos(orgId, minutos) {
  const n = Math.max(0, Math.min(1440, Math.round(Number(minutos) || 0)));
  db.prepare("UPDATE orgs SET alerta_resposta_min = ? WHERE id = ?").run(n, orgId);
  return n;
}

/* Quem está esperando: a ÚLTIMA mensagem da conversa é do cliente.

   É a definição mais honesta de "sem resposta" — não depende de alguém marcar
   como lida nem de contador de não-lidas. Se o corretor respondeu, a última
   mensagem é dele e o lead sai da lista sozinho.

   Fica de fora: lead sem dono (é fila, não é atraso de ninguém), atendimento
   finalizado, e lead em etapa de encerramento — cobrar resposta de quem está
   em "Perdido" é cobrar o que não existe. */
const SEM_RESPOSTA = `
  SELECT l.id, l.name, l.assigned_to, l.alerta_em,
         (SELECT m.created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS ultima_em,
         (SELECT m.direction FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS ultima_dir
  FROM leads l
  WHERE l.org_id = ? AND l.assigned_to IS NOT NULL
    AND l.closed_at IS NULL
    AND l.stage NOT IN ('Perdido','Venda','Transferido por ligação')`;

export function esperando(orgId, { minutos = null, agora = Date.now() } = {}) {
  const limite = minutos === null ? minutosDaOrg(orgId) : Number(minutos);
  return db.prepare(SEM_RESPOSTA).all(orgId)
    .filter(l => l.ultima_dir === "in" && l.ultima_em)
    .map(l => ({ ...l, esperando_min: Math.floor((agora - l.ultima_em) / 60000) }))
    .filter(l => l.esperando_min >= limite)
    .sort((a, b) => b.esperando_min - a.esperando_min);
}

const tempo = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`);

/* Avisa quem tem cliente esperando. Um aviso por espera: o carimbo `alerta_em`
   guarda a hora da última mensagem do cliente que já gerou aviso, então uma
   nova mensagem dele volta a valer um aviso, e o mesmo silêncio não vira
   cobrança de dez em dez minutos. */
export async function avisarSemResposta(orgId, agora = Date.now()) {
  const limite = minutosDaOrg(orgId);
  if (!limite) return { avisados: 0, motivo: "aviso desligado nesta imobiliária" };

  const pendentes = esperando(orgId, { minutos: limite, agora })
    .filter(l => !l.alerta_em || l.alerta_em < l.ultima_em);
  if (!pendentes.length) return { avisados: 0 };

  // Carimba ANTES de enviar, pelo mesmo motivo do aviso de plantão: push que
  // falha não pode virar notificação repetida no minuto seguinte.
  const carimbar = db.transaction((lista) => {
    const up = db.prepare("UPDATE leads SET alerta_em = ? WHERE id = ?");
    for (const l of lista) up.run(l.ultima_em, l.id);
  });
  carimbar(pendentes);

  // Agrupado por corretor: cinco clientes parados são um aviso, não cinco.
  const porPessoa = new Map();
  for (const l of pendentes) {
    if (!porPessoa.has(l.assigned_to)) porPessoa.set(l.assigned_to, []);
    porPessoa.get(l.assigned_to).push(l);
  }

  let avisados = 0;
  for (const [userId, leads] of porPessoa) {
    const pior = leads[0];
    try {
      const r = await avisar(userId, {
        titulo: leads.length === 1 ? "Cliente esperando resposta" : `${leads.length} clientes esperando resposta`,
        corpo: leads.length === 1
          ? `${pior.name} está sem resposta há ${tempo(pior.esperando_min)}.`
          : `O mais antigo é ${pior.name}, há ${tempo(pior.esperando_min)}.`,
        url: "/app",
      });
      avisados += (r && r.enviados) || 0;
    } catch (e) { console.error("[alerta] falha ao avisar:", e.message); }
  }
  return { avisados, pessoas: porPessoa.size, leads: pendentes.length };
}

export async function avisarSemRespostaEmTodas(agora = Date.now()) {
  for (const { id } of db.prepare("SELECT id FROM orgs").all()) {
    try { await avisarSemResposta(id, agora); }
    catch (e) { console.error("[alerta] erro no aviso:", e.message); }
  }
}

/* Cutucada da gestão: o gestor vê o cliente parado e chama o corretor.

   Vai por push E fica registrado no lead, para o corretor ver o pedido mesmo
   sem notificação ligada — que é o caso de todo iPhone que não adicionou o
   site à tela de início. Sem esse registro, cutucar não faria nada para metade
   da equipe e o gestor não teria como saber. */
export async function cutucar({ orgId, leadId, autor, recado = "" }) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) return { ok: false, error: "Lead não encontrado." };
  if (!lead.assigned_to) return { ok: false, error: "Este lead ainda está na fila, sem corretor." };

  const ultima = db.prepare("SELECT created_at, direction FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId);
  const min = ultima ? Math.floor((Date.now() - ultima.created_at) / 60000) : 0;
  const quem = (autor && autor.name || "A gestão").split(" ")[0];
  const texto = String(recado || "").trim().slice(0, 200);

  db.prepare("UPDATE leads SET cutucado_em = ?, cutucado_por = ?, cutucado_recado = ? WHERE id = ?")
    .run(Date.now(), autor ? autor.id : null, texto || null, leadId);

  let enviados = 0;
  try {
    const r = await avisar(lead.assigned_to, {
      titulo: `${quem} pediu atenção neste atendimento`,
      corpo: texto || `${lead.name} está sem resposta${ultima ? ` há ${tempo(min)}` : ""}.`,
      url: "/app",
    });
    enviados = (r && r.enviados) || 0;
  } catch (e) { console.error("[alerta] cutucada sem push:", e.message); }

  // `push` diz se a notificação saiu de fato; a tela usa isso para não
  // prometer ao gestor um aviso que não chegou a tocar em lugar nenhum.
  return { ok: true, push: enviados > 0, enviados, esperando_min: min };
}

// O corretor confirma que viu. Some o aviso da tela dele e a gestão para de
// ver o lead marcado como cobrado.
export function limparCutucada(leadId) {
  db.prepare("UPDATE leads SET cutucado_em = NULL, cutucado_por = NULL, cutucado_recado = NULL WHERE id = ?").run(leadId);
}
