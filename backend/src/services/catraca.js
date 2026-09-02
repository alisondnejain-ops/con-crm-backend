import db from "../db.js";
import { semMaster } from "../auth.js";

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
    `SELECT u.id FROM users u WHERE u.org_id = ? AND u.role = 'sdr' AND u.status = 'ativo'${semMaster("u")} ORDER BY u.created_at, u.name`
  ).all(orgId);
  if (!fila.length) {
    /* CORRETOR AUTÔNOMO: o lead cai NELE. (02/09/2026)

       Numa imobiliária, lead sem atendente fica na fila sem dono — melhor do
       que sumir na conta errada, porque existem várias contas possíveis e
       escolher uma seria chutar.

       Na casa de uma pessoa só não há chute nenhum: só existe ele. Deixar o
       lead na fila ali é deixá-lo parado esperando um repasse que nunca vem,
       de alguém que não existe — e essa casa nasce sem atendente, então era o
       caso NORMAL e não a exceção. */
    const org = db.prepare("SELECT tipo, dono_user_id FROM orgs WHERE id = ?").get(orgId);
    if (org && org.tipo === "autonomo" && org.dono_user_id) {
      const dono = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'ativo'").get(org.dono_user_id);
      if (dono) return dono.id;
    }
    return null;
  }

  const org = db.prepare("SELECT atendente_ptr FROM orgs WHERE id = ?").get(orgId);
  const ptr = (org && org.atendente_ptr) || 0;
  const escolhido = fila[ptr % fila.length].id;
  db.prepare("UPDATE orgs SET atendente_ptr = ? WHERE id = ?").run(ptr + 1, orgId);
  return escolhido;
}
