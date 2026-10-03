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
/* A mensagem que um FLUXO COM GATILHO manda (03/10/2026, services/automacoes.js)
   tem rótulo próprio — "Automação · Boas-vindas" — e a MESMA regra: não é
   atendimento de gente, não fecha a espera do cliente, não conta no prazo. */
export const ROTULO_AUTOMACAO = "Automação";

/* Condição SQL: a linha NÃO é mensagem de disparo nem de automação. `a` é o
   apelido da tabela de mensagens com o ponto ("m."), ou vazio. O gatilho
   `trg_msg_interacao` (db.js) repete esta regra em SQL — mudou uma, muda a outra. */
export const semDisparo = (a = "") =>
  `NOT (${a}direction = 'out' AND ${a}from_user_id IS NULL AND (COALESCE(${a}from_name, '') LIKE '${ROTULO_DISPARO}%' OR COALESCE(${a}from_name, '') LIKE '${ROTULO_AUTOMACAO}%'))`;

export const ehDeDisparo = (m) =>
  !!m && m.direction === "out" && !m.from_user_id
    && (String(m.from_name || "").startsWith(ROTULO_DISPARO) || String(m.from_name || "").startsWith(ROTULO_AUTOMACAO));

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

/* TODO ENVIO DO CRM, NÃO SÓ O DO DISPARO (29/09/2026, relato do Ali: "as
   mensagens ainda aparecem duplicadas"). O CRM grava a mensagem que enviou
   DEPOIS que a Uazapi responde — e o eco dela (webhook com fromMe) pode
   chegar antes disso, ou sem um id que case com o que a resposta trouxe.
   Nos dois casos o eco virava uma segunda cópia, "Enviada pelo WhatsApp".
   Piorou quando o CRM passou a ligar sozinho o webhook de cada número, que
   entrega também o eco do que saiu pela API.

   Quem registra é `call()` em services/uazapi.js — o único ponto por onde
   todo envio passa (texto, mídia, imóvel, localização, robô). Guarda, por
   número, quantos envios estão no ar e os ids que voltaram, por 3 minutos. */
const doCrm = new Map();
const JANELA_ECO = 180000;

function registroDoCrm(k) {
  const v = doCrm.get(k);
  if (v && v.ultimo + JANELA_ECO < Date.now() && !v.noAr) { doCrm.delete(k); return null; }
  return v || null;
}
export function inicioDeEnvioDoCrm(orgId, telefone) {
  const k = chave(orgId, telefone);
  const v = registroDoCrm(k) || { noAr: 0, ultimo: 0, ids: new Map() };
  v.noAr++; v.ultimo = Date.now();
  doCrm.set(k, v);
  return k;
}
export function fimDeEnvioDoCrm(k, messageid) {
  const v = doCrm.get(k);
  if (!v) return;
  v.noAr = Math.max(0, v.noAr - 1);
  v.ultimo = Date.now();
  if (messageid) v.ids.set(String(messageid).split(":").pop(), Date.now());
}
/* Este webhook com fromMe é o eco de algo que o próprio CRM mandou?
   - o id bate com um que a Uazapi devolveu num envio recente: sim;
   - há um envio para este número no ar agora: sim — a não ser que a
     Uazapi diga com todas as letras que NÃO saiu pela API (`wasSentByApi`
     falso), que é gente digitando no celular;
   - houve envio para este número nos últimos 3 minutos e a Uazapi diz
     que saiu pela API: sim (resposta que não trouxe id).
   Fora disso é gente digitando no celular, e a mensagem entra. */
export function ecoDoCrm(orgId, telefone, messageid, enviadaPelaApi) {
  const v = registroDoCrm(chave(orgId, telefone));
  if (!v) return false;
  const suf = messageid ? String(messageid).split(":").pop() : "";
  if (suf && v.ids.has(suf)) return true;
  if (enviadaPelaApi === false) return false;
  if (v.noAr > 0) return true;
  return enviadaPelaApi === true && v.ultimo + JANELA_ECO >= Date.now();
}
