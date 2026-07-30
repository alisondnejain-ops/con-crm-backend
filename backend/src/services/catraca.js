import db from "../db.js";

/* Catraca dos ATENDENTES.

   Todo lead que entra (Meta ou WhatsApp) vai direto para a conta de um
   atendente, em vez de ficar na fila esperando alguém distribuir. Com uma
   atendente só, cai sempre nela; quando entrar a segunda, o rodízio começa a
   girar sozinho, sem precisar mexer em nada.

   Decisão do Ali (30/07/2026): aqui NÃO se olha disponibilidade. Ninguém atende
   antes da atendente, então um lead novo não pode ficar parado só porque ela
   esqueceu de marcar prontidão no dia. A regra de disponibilidade continua
   valendo na catraca dos corretores (services/distribution), que é outra coisa.

   O contador fica em orgs.atendente_ptr, separado do distribution_ptr dos
   corretores — se fosse o mesmo, uma catraca embaralharia a ordem da outra. */
export function proximoAtendente(orgId) {
  const fila = db.prepare(
    "SELECT id FROM users WHERE org_id = ? AND role = 'sdr' AND status = 'ativo' ORDER BY created_at, name"
  ).all(orgId);
  // Sem atendente cadastrado (ou todos ainda pendentes de aprovação), o lead
  // cai na fila sem dono, como era antes. Melhor do que sumir na conta errada.
  if (!fila.length) return null;

  const org = db.prepare("SELECT atendente_ptr FROM orgs WHERE id = ?").get(orgId);
  const ptr = (org && org.atendente_ptr) || 0;
  const escolhido = fila[ptr % fila.length].id;
  db.prepare("UPDATE orgs SET atendente_ptr = ? WHERE id = ?").run(ptr + 1, orgId);
  return escolhido;
}
