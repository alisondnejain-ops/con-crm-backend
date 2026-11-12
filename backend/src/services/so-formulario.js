/* SÓ LEADS DO FORMULÁRIO (11/11/2026, pedido do Ali para o Reserva Real do
   Rio, que atende pelo número do ConHub: "nada pode chegar lá, nele só serão
   atendidos os leads que se cadastrarem no formulário").

   Uma chave por conta (orgs.so_formulario), ligada pelo master. Nula = como
   sempre — nenhuma outra conta muda.

   Ligada, no WhatsApp da conta:
   • número que ainda não é lead NÃO vira lead, e nada da mensagem é gravado
     (nem o arquivo, nem a triagem de "Novos contatos");
   • lead que nasceu espontâneo pelo WhatsApp e nunca mandou formulário também
     não recebe mais mensagem no CRM (é o "retira" do pedido);
   • passa quem preencheu formulário (site, Meta, portal — `formulario_em` ou a
     origem do lead) e quem a equipe cadastrou na mão ou importou.

   "Retirar os contatos espontâneos" tira da tela os leads que já entraram
   assim, com prévia antes e uma cópia inteira em leads_retirados. */
import db from "../db.js";

export function soFormulario(orgId) {
  const o = db.prepare("SELECT so_formulario FROM orgs WHERE id = ?").get(orgId);
  return !!(o && o.so_formulario);
}

export function definirSoFormulario(orgId, ligado) {
  db.prepare("UPDATE orgs SET so_formulario = ? WHERE id = ?").run(ligado ? 1 : null, orgId);
}

/* O lead nasceu de alguém escrever no WhatsApp (ou responder a um disparo) e
   nunca mandou formulário. Venda registrada nunca é espontânea para isto: já é
   cliente. */
const ESPONTANEO_SQL = `source = 'whatsapp' AND formulario_em IS NULL
  AND sale_date IS NULL AND sale_value IS NULL`;

export function leadEspontaneo(lead) {
  if (!lead) return false;
  return lead.source === "whatsapp" && !lead.formulario_em && !lead.sale_date && !lead.sale_value;
}

/* Marca que o lead mandou um formulário (chamado pelo caminho único dos
   formulários, receberLead). É o que libera a conversa de quem primeiro
   escreveu e depois preencheu. */
export function marcarFormulario(leadId) {
  db.prepare("UPDATE leads SET formulario_em = ? WHERE id = ?").run(Date.now(), leadId);
}

/* Decide, no webhook, se a mensagem fica de fora. Devolve o motivo (texto para
   o registro de webhooks) ou null. */
export function barrarMensagem(orgId, lead) {
  if (!soFormulario(orgId)) return null;
  if (!lead) return "ignorado: esta conta só recebe leads do formulário — número que escreveu espontaneamente não entra";
  if (leadEspontaneo(lead)) return "ignorado: esta conta só recebe leads do formulário — este lead entrou espontaneamente pelo WhatsApp";
  return null;
}

export function previaEspontaneos(orgId) {
  const lista = db.prepare(`SELECT id, name, phone, created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id) AS mensagens
    FROM leads WHERE org_id = ? AND ${ESPONTANEO_SQL} ORDER BY created_at DESC`).all(orgId);
  const comVenda = db.prepare(`SELECT COUNT(*) n FROM leads WHERE org_id = ? AND source = 'whatsapp'
    AND formulario_em IS NULL AND (sale_date IS NOT NULL OR sale_value IS NOT NULL)`).get(orgId).n;
  return {
    total: lista.length,
    mensagens: lista.reduce((s, l) => s + l.mensagens, 0),
    com_venda_ficam: comVenda,
    exemplos: lista.slice(0, 8).map(l => ({ id: l.id, nome: l.name, telefone_final: String(l.phone || "").slice(-4), entrou_em: l.created_at, mensagens: l.mensagens })),
  };
}

/* Tira da conta os leads espontâneos: guarda a linha do lead e a conversa
   inteira em leads_retirados, depois apaga tudo que pende do lead (descoberto
   pelo banco, a mesma régua da exclusão de conta). Os arquivos ficam no
   armazenamento — a cópia aponta para eles. */
export function retirarEspontaneos(orgId, userId, ids = null) {
  const alvos = db.prepare(`SELECT * FROM leads WHERE org_id = ? AND ${ESPONTANEO_SQL}`).all(orgId)
    .filter(l => !ids || ids.includes(l.id));
  if (!alvos.length) return { retirados: 0, mensagens: 0 };
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name)
    .filter(t => t !== "leads" && t !== "leads_retirados"
      && db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === "lead_id"));
  let mensagens = 0;
  const agora = Date.now();
  db.transaction(() => {
    for (const l of alvos) {
      const msgs = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at").all(l.id);
      mensagens += msgs.length;
      db.prepare("INSERT OR REPLACE INTO leads_retirados (id,org_id,lead_json,mensagens_json,retirado_por,retirado_em) VALUES (?,?,?,?,?,?)")
        .run(l.id, orgId, JSON.stringify(l), JSON.stringify(msgs), userId || null, agora);
      for (const t of tabelas) db.prepare(`DELETE FROM "${t}" WHERE lead_id = ?`).run(l.id);
      db.prepare("DELETE FROM leads WHERE id = ?").run(l.id);
    }
  })();
  console.log(`[so-formulario] ${alvos.length} contato(s) espontâneo(s) retirado(s) da conta (${mensagens} mensagens guardadas em leads_retirados)`);
  return { retirados: alvos.length, mensagens };
}
