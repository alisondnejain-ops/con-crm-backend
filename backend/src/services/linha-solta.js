/* ===== O WHATSAPP PESSOAL DE QUEM PERDEU O LEAD (05/11/2026) =====

   Pedido do Fernando, decisão do Ali (opção b): quando um lead troca de dono
   — repasse na mão, prazo vencido, tempo da catraca, lote, saída da equipe —,
   o WhatsApp pessoal do dono ANTIGO deixa de fazer parte daquele lead.

   Antes, duas coisas aconteciam sem ninguém ver:
   1. a conversa continuava na linha pessoal do antigo dono, e o que o novo
      dono escrevia SAÍA PELO CELULAR DELE, sem assinatura;
   2. tudo que o antigo dono conversasse com o cliente pelo celular depois
      do repasse continuava entrando na conversa do lead.

   Agora, no repasse (`soltarLinhaDoAntigo`, chamado por `trocarResponsavel`):
   a conversa volta para o número da imobiliária, e a linha pessoal do antigo
   dono fica marcada como SOLTA deste lead. Daí em diante (`linhaSoltaDoLead`,
   chamado no começo do caminho da mensagem que chega), o que passar por ela
   com este cliente NÃO é gravado — nem o que ele digitar, nem o que o cliente
   responder a ele. Quando é o CLIENTE escrevendo, quem está com o lead recebe
   um aviso no celular, SEM o texto: a conversa do antigo dono continua dele,
   e o novo dono sabe que precisa chamar o cliente pelo número da imobiliária.

   O histórico que já estava gravado fica. Se o lead voltar para o antigo
   dono, a marca sai e a linha dele volta a valer. */

import db from "../db.js";

db.exec(`CREATE TABLE IF NOT EXISTS leads_linhas_soltas (
  lead_id TEXT NOT NULL, canal_id TEXT NOT NULL, org_id TEXT NOT NULL,
  user_id TEXT, desde INTEGER NOT NULL, aviso_em INTEGER,
  PRIMARY KEY (lead_id, canal_id))`);

// Um aviso por lead a cada 30 minutos: o cliente que manda cinco mensagens
// seguidas no número antigo não pode tocar o celular cinco vezes.
const INTERVALO_AVISO = 30 * 60 * 1000;

const linhaPessoal = (orgId, userId) => userId
  ? db.prepare("SELECT id, nome FROM canais WHERE org_id = ? AND user_id = ? AND tipo = 'corretor' LIMIT 1").get(orgId, userId) || null
  : null;

/* Chamada dentro da troca de dono. Nunca lança: falha aqui não pode impedir
   um repasse. Devolve true quando a conversa saiu da linha pessoal. */
export function soltarLinhaDoAntigo(lead, novoUserId) {
  try {
    // Voltou para quem já foi dono: a linha dele volta a valer neste lead.
    const doNovo = linhaPessoal(lead.org_id, novoUserId);
    if (doNovo) db.prepare("DELETE FROM leads_linhas_soltas WHERE lead_id = ? AND canal_id = ?").run(lead.id, doNovo.id);

    const doAntigo = linhaPessoal(lead.org_id, lead.assigned_to);
    if (!doAntigo || lead.assigned_to === novoUserId) return false;
    db.prepare(`INSERT OR IGNORE INTO leads_linhas_soltas (lead_id, canal_id, org_id, user_id, desde)
      VALUES (?,?,?,?,?)`).run(lead.id, doAntigo.id, lead.org_id, lead.assigned_to, Date.now());
    if (lead.canal_id === doAntigo.id) {
      db.prepare("UPDATE leads SET canal_id = NULL WHERE id = ?").run(lead.id);
      return true;
    }
    return false;
  } catch (e) {
    console.error("[linha-solta] não consegui soltar a linha do antigo dono:", e.message);
    return false;
  }
}

/* A mensagem chegou por uma linha pessoal que já foi solta deste lead?
   Devolve a marca (com o nome da linha) ou null. Quem está HOJE com o lead
   sendo o dono da linha conta como não solta — é o caso de o lead ter
   voltado para ele por um caminho que não passou pela troca. */
export function linhaSoltaDoLead(lead, canal) {
  if (!lead || !canal || canal.tipo !== "corretor") return null;
  if (canal.user_id && lead.assigned_to === canal.user_id) return null;
  return db.prepare("SELECT * FROM leads_linhas_soltas WHERE lead_id = ? AND canal_id = ?").get(lead.id, canal.id) || null;
}

/* Marca a hora do aviso e diz se ele deve sair agora. */
export function podeAvisarLinhaSolta(marca, agora = Date.now()) {
  if (marca.aviso_em && agora - marca.aviso_em < INTERVALO_AVISO) return false;
  db.prepare("UPDATE leads_linhas_soltas SET aviso_em = ? WHERE lead_id = ? AND canal_id = ?").run(agora, marca.lead_id, marca.canal_id);
  return true;
}

/* OS LEADS REPASSADOS ANTES DESTA REGRA. Uma vez só: lead que está com uma
   pessoa e com a conversa presa na linha pessoal de OUTRA volta para o número
   da imobiliária, e aquela linha fica solta dele — senão o que o novo dono
   escreve continuaria saindo pelo celular do antigo. Lead na fila (sem dono)
   não é tocado: não dá para saber se a linha é de um antigo dono. */
if (!db.prepare("SELECT 1 FROM config_plataforma WHERE chave = 'linhas_soltas_antigas'").get()) {
  try {
    const presos = db.prepare(`SELECT l.id, l.org_id, c.id AS canal_id, c.user_id FROM leads l
      JOIN canais c ON c.id = l.canal_id
      WHERE c.tipo = 'corretor' AND l.assigned_to IS NOT NULL AND c.user_id IS NOT NULL AND c.user_id <> l.assigned_to`).all();
    db.transaction(() => {
      for (const p of presos) {
        db.prepare(`INSERT OR IGNORE INTO leads_linhas_soltas (lead_id, canal_id, org_id, user_id, desde)
          VALUES (?,?,?,?,?)`).run(p.id, p.canal_id, p.org_id, p.user_id, Date.now());
        db.prepare("UPDATE leads SET canal_id = NULL WHERE id = ?").run(p.id);
      }
      db.prepare("INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES ('linhas_soltas_antigas', ?, ?)")
        .run(String(presos.length), Date.now());
    })();
    if (presos.length) console.log(`[linha-solta] ${presos.length} lead(s) repassado(s) antes da regra voltaram para o número da imobiliária`);
  } catch (e) {
    console.error("[linha-solta] ajuste dos leads antigos falhou (tenta de novo no próximo start):", e.message);
  }
}
