/* Arrumar a base inteira de uma vez: temperatura e etapa do funil.

   Duas operações que mexem em centenas de leads ao mesmo tempo. Três regras
   valem para as duas, e elas existem porque desfazer isso na mão é inviável:

   1) CONFERIR ANTES DE APLICAR. Toda operação tem uma prévia que diz quantos
      leads seriam tocados, quem fica de fora e por quê — e, quando gasta
      dinheiro, quanto vai custar.
   2) TUDO FICA REGISTRADO. Mudança de etapa passa por `moverEtapa`, então
      cada lead guarda de onde veio, para onde foi e por qual motivo.
   3) QUEM ESTÁ COM A ATENDENTE FICA DE FORA. Ela faz o primeiro contato e
      repassa; o lead que ainda está com ela não é atendimento de corretor
      nenhum, e mexer na etapa dele sujaria o relatório de quem não o atendeu.

   Sobre a temperatura: todo lead do WhatsApp nascia "MORNO" — não era leitura
   de nada, era o padrão da coluna. A tela mostrava aquilo como se alguém
   tivesse avaliado o cliente. Tirar é devolver a verdade: quem sabe a
   temperatura é quem conversou. */

import db from "../db.js";
import { LINEAR } from "./stages.js";
import { moverEtapa } from "./etapas.js";
import { etapaDaConversa, iaConfigurada } from "./ia.js";
import { registrar as registrarUsoIA, custoEstimado } from "./iauso.js";

/* ===== TEMPERATURA ===== */

// Quem seria afetado por apagar uma temperatura. Só conta, não muda nada.
export function previaTemperatura(orgId, temperatura) {
  const n = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=? AND priority=?").get(orgId, temperatura).n;
  const total = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=?").get(orgId).n;
  const restam = db.prepare(
    `SELECT priority p, COUNT(*) n FROM leads WHERE org_id=? AND priority IS NOT NULL AND priority<>?
     GROUP BY priority`).all(orgId, temperatura);
  return { temperatura, leads: n, total, restam };
}

/* Apaga a marcação, não o lead. O campo fica nulo e a tela mostra "sem
   temperatura" — estado de verdade, e não um "morno" que ninguém escolheu. */
export function limparTemperatura(orgId, temperatura) {
  const info = db.prepare("UPDATE leads SET priority = NULL WHERE org_id=? AND priority=?").run(orgId, temperatura);
  console.log(`[lote] temperatura "${temperatura}" removida de ${info.changes} lead(s)`);
  return { limpos: info.changes };
}

/* ===== ETAPA DO FUNIL, LIDA PELA IA ===== */

/* Quem entra na reanálise por IA.

   Fica de fora, e cada motivo tem uma razão diferente:
   - SEM DONO ou COM A ATENDENTE: não é atendimento de corretor;
   - SEM CONVERSA: não há o que a IA ler — ela inventaria;
   - VENDA REGISTRADA: tem valor e data lançados, é dinheiro e não palpite;
   - ETAPA MANUAL (Perdido, Recaptação, Transferido): quem marcou sabe de algo
     que a conversa não mostra. */
export function elegiveis(orgId) {
  const vagas = LINEAR.map(() => "?").join(",");
  return db.prepare(`
    SELECT l.id, l.name, l.stage, l.assigned_to, u.name AS corretor
    FROM leads l JOIN users u ON u.id = l.assigned_to
    WHERE l.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'
      AND l.sale_value IS NULL AND l.stage IN (${vagas})
      AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id)
    ORDER BY u.name, l.created_at`).all(orgId, ...LINEAR);
}

export function previaEtapaIA(orgId) {
  const vagas = LINEAR.map(() => "?").join(",");
  const conta = (sql, ...a) => db.prepare(sql).get(orgId, ...a).n;
  const lista = elegiveis(orgId);
  const porCorretor = new Map();
  for (const l of lista) porCorretor.set(l.corretor, (porCorretor.get(l.corretor) || 0) + 1);

  return {
    configurada: iaConfigurada(),
    leads: lista.length,
    por_corretor: [...porCorretor].map(([nome, n]) => ({ nome, leads: n })).sort((a, b) => b.leads - a.leads),
    fora: {
      com_atendente_ou_sem_dono: conta(`SELECT COUNT(*) n FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
        WHERE l.org_id=? AND (l.assigned_to IS NULL OR u.role <> 'corretor')`),
      sem_conversa: conta(`SELECT COUNT(*) n FROM leads l WHERE l.org_id=?
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id=l.id)`),
      venda_registrada: conta("SELECT COUNT(*) n FROM leads WHERE org_id=? AND sale_value IS NOT NULL"),
      etapa_manual: conta(`SELECT COUNT(*) n FROM leads WHERE org_id=? AND stage NOT IN (${vagas})`, ...LINEAR),
    },
    custo: custoEstimado(lista.length),
  };
}

/* Roda a IA num PEDAÇO da fila e devolve quantos faltam.

   Em pedaços de propósito: são centenas de conversas, cada chamada leva alguns
   segundos, e uma requisição só levaria minutos — o navegador desiste no meio e
   ninguém sabe quanto foi feito. Assim a tela mostra o avanço e o trabalho já
   feito fica gravado mesmo se pararem no meio.

   `motivo: "ia_lote"` distingue esta análise no histórico. Não é a palavra-
   chave (que é chute) nem o clique do corretor num lead — é uma leitura em
   massa que o gestor autorizou, e dá para separar as três depois. */
export async function rodarEtapaIA(orgId, { limite = 20, userId = null } = {}) {
  if (!iaConfigurada()) return { erro: "A IA não está ligada nesta instalação." };

  const fila = elegiveis(orgId).filter(l => !jaAnalisado(l.id));
  const lote = fila.slice(0, limite);
  const mudancas = [], erros = [];

  for (const l of lote) {
    const msgs = db.prepare("SELECT direction, body FROM messages WHERE lead_id=? ORDER BY created_at ASC").all(l.id);
    const r = await etapaDaConversa({
      nome: l.name,
      mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "imobiliaria", texto: m.body })),
    });

    if (!r.ok) { erros.push({ lead: l.name, erro: r.erro }); marcarAnalisado(l.id, null); continue; }
    registrarUsoIA({ orgId, userId, leadId: l.id, recurso: "etapa", uso: r.uso });
    db.prepare("UPDATE leads SET etapa_ia_json=?, etapa_ia_em=?, etapa_ia_msgs=? WHERE id=?")
      .run(JSON.stringify(r.sugestao), Date.now(), msgs.length, l.id);

    if (r.sugestao.etapa !== l.stage) {
      moverEtapa({ leadId: l.id, para: r.sugestao.etapa, motivo: "ia_lote", userId });
      mudancas.push({ nome: l.name, corretor: l.corretor, de: l.stage, para: r.sugestao.etapa, confianca: r.sugestao.confianca });
    }
  }

  const restam = fila.length - lote.length;
  console.log(`[lote] IA leu ${lote.length} conversa(s), ${mudancas.length} mudaram de etapa, faltam ${restam}`);
  return { analisados: lote.length, mudaram: mudancas.length, restam, mudancas: mudancas.slice(0, 20), erros };
}

/* Já foi lido nesta rodada? Marcamos pela data da leitura: lead com
   `etapa_ia_em` recente não é relido, então parar e continuar depois não paga
   duas vezes pela mesma conversa. */
const JANELA = 12 * 3600000;
const jaAnalisado = (id) => {
  const l = db.prepare("SELECT etapa_ia_em FROM leads WHERE id=?").get(id);
  return !!(l && l.etapa_ia_em && Date.now() - l.etapa_ia_em < JANELA);
};
const marcarAnalisado = (id) => db.prepare("UPDATE leads SET etapa_ia_em=? WHERE id=?").run(Date.now(), id);
