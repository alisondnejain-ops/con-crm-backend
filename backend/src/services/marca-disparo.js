/* O QUE MARCA UMA MENSAGEM COMO DO DISPARO (27/09/2026).

   A mensagem que o disparo em massa manda entra na conversa do lead como
   `direction='out'`, sem autor (`from_user_id` nulo) e com o nome
   "Disparo · <campanha>". Para os relatórios ela NÃO é atendimento:

   - não fecha a espera do cliente — quem perguntou algo ontem e hoje recebeu
     a campanha continua esperando resposta de gente;
   - não conta como interação para o prazo (SLA) da etapa — trezentos leads
     esquecidos não podem ficar verdes porque uma campanha passou por eles;
   - não é primeira resposta de ninguém.

   A regra mora aqui, num lugar só, porque a pergunta "a última mensagem é do
   cliente?" é feita em cinco pontos (lista de conversas, aviso de espera,
   robô, painel, score). Escrita em cada um, a quinta cópia divergiria.

   Este módulo não importa nada de propósito: é lido pelo webhook, pelo
   disparo e pelos relatórios, e não pode criar ciclo entre eles. */

export const ROTULO_DISPARO = "Disparo";

/* Condição SQL: a linha NÃO é mensagem de disparo. `a` é o apelido da tabela
   de mensagens com o ponto ("m."), ou vazio. */
export const semDisparo = (a = "") =>
  `NOT (${a}direction = 'out' AND ${a}from_user_id IS NULL AND COALESCE(${a}from_name, '') LIKE '${ROTULO_DISPARO}%')`;

export const ehDeDisparo = (m) =>
  !!m && m.direction === "out" && !m.from_user_id && String(m.from_name || "").startsWith(ROTULO_DISPARO);

/* ENVIOS EM CURSO. A Uazapi às vezes entrega o eco de uma mensagem enviada
   (webhook com fromMe) ANTES de a chamada de envio devolver a resposta — e
   então o disparo ainda não gravou o registro que permite reconhecer o eco.
   Pelo número de atendimento, esse eco entrava como "enviada pelo celular":
   gente respondendo, carimbando a primeira resposta do lead no relatório.
   Enquanto o envio está no ar, o número fica marcado aqui.

   A chave usa os 8 últimos dígitos: o eco pode chegar com ou sem o nono
   dígito, e dentro de uma mesma imobiliária, por segundos, não há colisão. */
const emEnvio = new Map();
const chave = (orgId, telefone) => `${orgId}:${String(telefone || "").replace(/\D/g, "").slice(-8)}`;

export function marcarEnvio(orgId, telefone, campanha) {
  emEnvio.set(chave(orgId, telefone), { campanha: campanha || "", ate: Date.now() + 120000 });
}
export function desmarcarEnvio(orgId, telefone) {
  emEnvio.delete(chave(orgId, telefone));
}
export function envioEmCurso(orgId, telefone) {
  const k = chave(orgId, telefone);
  const v = emEnvio.get(k);
  if (!v) return null;
  if (v.ate < Date.now()) { emEnvio.delete(k); return null; }
  return v;
}
