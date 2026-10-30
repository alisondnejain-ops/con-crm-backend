/* LINHA DO TEMPO DO LEAD (28/10/2026, pedido do Fernando).

   "Por onde este lead passou?" — a pergunta de quem recebe um lead repassado
   ou de quem cobra um atendimento na reunião. Os fatos já estavam gravados em
   sete lugares (histórico de etapas, de donos, ligações, tarefas,
   observações, etiquetas, a venda e as próprias mensagens); faltava um lugar
   que os pusesse em ordem.

   É SÓ LEITURA, e só do que aconteceu: nada aqui é calculado nem estimado.
   As mensagens NÃO entram uma a uma (a conversa já está na tela ao lado) —
   entram só os marcos: a primeira do cliente, e a primeira de cada pessoa da
   equipe, que é o que responde "quem falou com ele e quando".

   O histórico de etapas existe desde 14/08/2026 e o de donos desde
   02/09/2026: lead mais antigo tem lacunas, e a linha do tempo não inventa o
   que não foi gravado. */
import db from "../db.js";
import { ROTULO_DISPARO, ROTULO_AUTOMACAO } from "./marca-disparo.js";

const MOTIVO_ETAPA = {
  mao: "na mão", palavra: "pela palavra-chave", ia: "confirmada pela IA", ia_lote: "pela leitura da IA",
  venda: "pela venda registrada", reanalise: "pela reanálise", automatica: "pela regra automática",
};
const MOTIVO_DONO = {
  mao: "", automatica: "pela regra da etapa", saida_equipe: "porque a pessoa saiu da equipe",
  prazo_vencido: "porque o prazo da etapa venceu", sem_resposta: "porque ninguém falou com o cliente no tempo da catraca", catraca: "pela catraca",
};
const RESULTADO_LIGACAO = { falou: "falou com o cliente", nao_atendeu: "não atendeu",
  caixa_postal: "caixa postal", numero_errado: "número errado" };

const nomeDe = (mapa, id) => (id && mapa.get(id)) || null;

export function linhaDoTempo(lead) {
  const pessoas = new Map(db.prepare("SELECT id, name FROM users WHERE org_id = ?").all(lead.org_id).map(u => [u.id, u.name]));
  const ev = [];
  const add = (quando, tipo, texto, extra = {}) => { if (quando) ev.push({ quando, tipo, texto, ...extra }); };

  const origem = lead.campaign_name ? `${lead.origem || "Anúncio"} · ${lead.campaign_name}` : (lead.origem || "WhatsApp");
  add(lead.created_at, "entrada", `Entrou pelo ${origem}`);

  for (const e of db.prepare(`SELECT e.de, e.para, e.motivo, e.created_at, e.user_id FROM lead_etapas e
      WHERE e.lead_id = ? ORDER BY e.created_at`).all(lead.id)) {
    const como = MOTIVO_ETAPA[e.motivo] || "";
    add(e.created_at, "etapa", e.de ? `Etapa: ${e.de} → ${e.para}` : `Etapa: ${e.para}`,
      { quem: nomeDe(pessoas, e.user_id), detalhe: como });
  }

  for (const t of db.prepare(`SELECT from_user_id, to_user_id, triggered_by_user_id, trigger_reason, created_at,
      from_pipeline_id, to_pipeline_id FROM lead_transfers WHERE lead_id = ? ORDER BY created_at`).all(lead.id)) {
    const de = nomeDe(pessoas, t.from_user_id) || "a fila", para = nomeDe(pessoas, t.to_user_id) || "a fila";
    add(t.created_at, "dono", t.to_user_id ? `Passou de ${de} para ${para}` : `${de} devolveu à fila`,
      { quem: nomeDe(pessoas, t.triggered_by_user_id), detalhe: MOTIVO_DONO[t.trigger_reason] || "" });
  }

  for (const g of db.prepare("SELECT user_id, resultado, obs, created_at FROM ligacoes WHERE lead_id = ? ORDER BY created_at").all(lead.id))
    add(g.created_at, "ligacao", `Ligação${g.resultado ? ": " + (RESULTADO_LIGACAO[g.resultado] || g.resultado) : " (sem resultado anotado)"}`,
      { quem: nomeDe(pessoas, g.user_id), detalhe: g.obs || "" });

  for (const t of db.prepare("SELECT titulo, quando, feito_em, created_at, criado_por, user_id FROM tarefas WHERE lead_id = ? ORDER BY created_at").all(lead.id)) {
    add(t.created_at, "tarefa", `Tarefa marcada: ${t.titulo}`, { quem: nomeDe(pessoas, t.criado_por), para_quando: t.quando });
    if (t.feito_em) add(t.feito_em, "tarefa_feita", `Tarefa feita: ${t.titulo}`, { quem: nomeDe(pessoas, t.user_id) });
  }

  for (const o of db.prepare("SELECT texto, autor_id, created_at FROM observacoes WHERE lead_id = ? ORDER BY created_at").all(lead.id))
    add(o.created_at, "observacao", "Observação", { quem: nomeDe(pessoas, o.autor_id), detalhe: o.texto });

  for (const t of db.prepare(`SELECT t.nome, lt.marcada_em, lt.marcada_por FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.lead_id = ? ORDER BY lt.marcada_em`).all(lead.id))
    add(t.marcada_em, "tag", `Etiqueta: ${t.nome}`, { quem: nomeDe(pessoas, t.marcada_por) });

  // Mensagens: só os marcos. A primeira do cliente e a primeira de cada pessoa.
  const primeiraDoCliente = db.prepare("SELECT MIN(created_at) t FROM messages WHERE lead_id = ? AND direction = 'in'").get(lead.id)?.t;
  add(primeiraDoCliente, "mensagem", "Primeira mensagem do cliente");
  for (const m of db.prepare(`SELECT from_user_id, MIN(created_at) t FROM messages
      WHERE lead_id = ? AND direction = 'out' AND from_user_id IS NOT NULL GROUP BY from_user_id`).all(lead.id))
    add(m.t, "mensagem", `Primeira mensagem de ${nomeDe(pessoas, m.from_user_id) || "alguém da equipe"}`);
  const roboOuAuto = db.prepare(`SELECT from_name, MIN(created_at) t FROM messages WHERE lead_id = ? AND direction = 'out'
      AND from_user_id IS NULL AND from_name IS NOT NULL AND (from_name LIKE ? OR from_name LIKE ? OR from_name = 'Atendimento automático')
      GROUP BY from_name`).all(lead.id, `${ROTULO_DISPARO}%`, `${ROTULO_AUTOMACAO}%`);
  for (const r of roboOuAuto)
    add(r.t, "mensagem", r.from_name === "Atendimento automático" ? "O Autoatendimento falou com o cliente" : `Recebeu: ${r.from_name}`);

  if (lead.sale_date)
    add(lead.sale_date, "venda", "Venda registrada", { valor: lead.sale_value || null, detalhe: lead.sale_property || "" });
  if (lead.closed_at) add(lead.closed_at, "finalizado", "Atendimento finalizado");

  ev.sort((a, b) => b.quando - a.quando);
  return { eventos: ev, historico_desde: { etapas: "2026-08-14", donos: "2026-09-02" } };
}
