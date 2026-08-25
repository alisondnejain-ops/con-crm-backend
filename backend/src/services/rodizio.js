/* A CATRACA DOS CORRETORES: quem é o próximo da vez.

   Antes isto vivia solto dentro de duas rotas, e elas discordavam entre si.
   Dois defeitos, e os dois faziam a fila mudar sozinha:

   1) POSIÇÃO POR CONTA DE DIVISÃO. A vez era `contador % quantos estão
      disponíveis`. Como a lista só tem quem se prontificou, ela muda de
      tamanho o dia inteiro — e o resto da divisão muda junto. Alguém marcar
      disponibilidade no meio da tarde reordenava a fila de todo mundo, sem
      ninguém ter recebido lead nenhum. Um número na tela calculado assim
      mentiria em poucos minutos.

   2) DUAS LISTAS, UM CONTADOR SÓ. `/next` sorteava entre corretores E
      atendentes; `/handoff` só entre corretores. Os dois avançavam o MESMO
      `distribution_ptr`, então usar um embaralhava a vez do outro.

   Agora a memória é OUTRA: guarda-se QUEM foi o último a receber
   (`orgs.rodizio_ultimo`), e o próximo é o primeiro disponível depois dele na
   roda. Quem entra ou sai da disponibilidade não desloca mais ninguém — só
   entra ou sai da fila.

   E a fila é uma só, de CORRETORES. A atendente saiu de `/next`: ela é quem
   distribui, e a regra escrita no CLAUDE.md já dizia que o repasse nunca volta
   para ela. */

import db from "../db.js";
import { semMaster } from "../auth.js";

/* A roda inteira, na ordem fixa em que ela gira.

   Ordem por data de entrada e nome: é estável: não muda quando alguém marca
   disponibilidade, e é a mesma coisa que a tela vai numerar. */
export function rodaDeCorretores(orgId) {
  return db.prepare(
    `SELECT u.id, u.name, u.available, u.avatar_url FROM users u
     WHERE u.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'${semMaster("u")}
     ORDER BY u.created_at, u.name`).all(orgId);
}

/* Quem é o próximo, e a fila numerada a partir dele.

   `posicao` só existe para quem está disponível: é a ordem real de quem vai
   receber. Quem não se prontificou aparece na lista sem número — some da
   fila, mas não some da tela, senão o gestor não entende por que a equipe tem
   seis corretores e a catraca mostra dois. */
export function filaDaVez(orgId) {
  const roda = rodaDeCorretores(orgId);
  const org = db.prepare("SELECT rodizio_ultimo FROM orgs WHERE id = ?").get(orgId) || {};

  const disponiveis = roda.filter(u => u.available);
  if (!disponiveis.length) {
    return { proximo: null, fila: roda.map(u => ({ ...u, disponivel: !!u.available, posicao: null })), disponiveis: 0 };
  }

  /* O último a receber pode ter ficado indisponível, ou até saído da equipe.
     Procuramos a posição dele na RODA (não na fila de disponíveis) e seguimos
     dali — assim a vez continua de onde parou mesmo com gente entrando e
     saindo. Sem registro nenhum, começa do primeiro. */
  const iUltimo = roda.findIndex(u => u.id === org.rodizio_ultimo);
  const ordenada = [];
  for (let k = 1; k <= roda.length; k++) {
    const u = roda[(iUltimo + k + roda.length) % roda.length];
    if (u.available) ordenada.push(u);
  }

  const posicoes = new Map(ordenada.map((u, i) => [u.id, i + 1]));
  return {
    proximo: ordenada[0] ? { id: ordenada[0].id, name: ordenada[0].name } : null,
    disponiveis: ordenada.length,
    fila: roda.map(u => ({
      id: u.id, name: u.name, avatar_url: u.avatar_url || null,
      disponivel: !!u.available,
      posicao: posicoes.get(u.id) || null,
    })).sort((a, b) => (a.posicao || 99) - (b.posicao || 99) || a.name.localeCompare(b.name)),
  };
}

/* Entrega ao próximo e move a vez. Devolve null quando não há ninguém
   disponível — quem chama decide o que dizer, porque a frase muda conforme a
   tela. */
export function pegarProximo(orgId) {
  const { proximo } = filaDaVez(orgId);
  if (!proximo) return null;
  db.prepare("UPDATE orgs SET rodizio_ultimo = ? WHERE id = ?").run(proximo.id, orgId);
  return proximo.id;
}

/* Um corretor escolhido a dedo também MOVE a vez.

   Sem isto, a atendente escolher a Marina na mão não mudava nada no rodízio, e
   a Marina continuava sendo a próxima da fila — recebia dois leads seguidos. O
   rodízio existe para dividir o trabalho; quem acabou de receber vai para o
   fim, tenha sido por sorteio ou por escolha. */
export function marcarQueRecebeu(orgId, userId) {
  db.prepare("UPDATE orgs SET rodizio_ultimo = ? WHERE id = ?").run(userId, orgId);
}
