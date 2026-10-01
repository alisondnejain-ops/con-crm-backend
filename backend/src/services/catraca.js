import db from "../db.js";
import { rodaDeAtendentes, ordemDaVez } from "./rodizio.js";
import { roboCobre } from "./robo.js";

/* Catraca dos ATENDENTES.

   Todo lead que entra (Meta, WhatsApp, portal) vai direto para uma atendente,
   em vez de ficar na fila esperando alguém distribuir.

   QUEM ESTÁ ATIVA RECEBE (01/10/2026, pedido do Ali). Até aqui a disponibilidade
   era ignorada (decisão de 30/07, quando havia uma atendente só: se ela
   esquecesse de marcar prontidão, nenhum lead podia ficar parado). Com duas, a
   que saiu continuava recebendo metade dos leads. Agora vale a regra dos
   corretores, sem tela nova: a vez gira pela roda a partir de quem recebeu por
   último (`ordemDaVez`), e só recebe quem está ativa. Quem entra ou sai da
   disponibilidade não desloca ninguém.

   E QUANDO NINGUÉM ESTÁ ATIVA, nesta ordem:
     1. A IA cobre — se a conta tem o Autoatendimento e o robô está ligado. O
        lead fica SEM dono, no funil de SDR, e a IA atende na hora, a qualquer
        horário (`podeAtender`). A atendente pega da fila quando voltar.
     2. Sem IA, reveza entre TODAS as atendentes, ativas ou não: lead novo
        nunca fica solto — é a proteção de 30/07, que continua de pé.

   A memória da vez fica em `orgs.atendente_ultimo`, separada da dos
   corretores (`rodizio_ultimo`) — se fosse a mesma, uma catraca embaralharia
   a ordem da outra. */
export function proximoAtendente(orgId) {
  const roda = rodaDeAtendentes(orgId);
  if (!roda.length) {
    /* CORRETOR AUTÔNOMO: o lead cai NELE. (02/09/2026)

       Numa imobiliária, lead sem atendente fica na fila sem dono — melhor do
       que sumir na conta errada, porque existem várias contas possíveis e
       escolher uma seria chutar. Ali, com a IA ligada, ela atende.

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

  const vez = vezDasAtendentes(orgId, roda);
  if (!vez.proximo) return null;   // a IA atende; o lead espera na fila do SDR
  db.prepare("UPDATE orgs SET atendente_ultimo = ? WHERE id = ?").run(vez.proximo, orgId);
  return vez.proximo;
}

/* Quem recebe o PRÓXIMO lead, sem mexer na vez. A mesma conta serve à
   catraca e à tela do gestor — se fossem duas, a tela diria um nome e o lead
   cairia em outro. `ia: true` = ninguém ativa, e a IA é quem cobre. */
export function vezDasAtendentes(orgId, roda = rodaDeAtendentes(orgId)) {
  if (!roda.length) return { proximo: null, ia: false, ordem: [] };
  const org = db.prepare("SELECT atendente_ultimo FROM orgs WHERE id = ?").get(orgId) || {};
  const ordem = ordemDaVez(roda, org.atendente_ultimo);
  const ativa = ordem.find(u => u.available);
  if (ativa) return { proximo: ativa.id, ia: false, ordem };
  if (roboCobre(orgId)) return { proximo: null, ia: true, ordem };
  return { proximo: ordem[0].id, ia: false, ordem };
}
