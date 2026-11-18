/* A MENSAGEM QUE SÓ ENCERRA A CONVERSA (18/11/2026, pedido do Fernando, a
   partir do relato de uma corretora da Conecta).

   O cliente fecha a conversa com "legal", "ok", "obrigado" ou um 👍, a
   corretora não responde porque não há o que responder, e também não
   finaliza porque o atendimento continua. O sistema tratava isso como
   "cliente esperando": o relógio contava, o aviso de "sem resposta" tocava, o
   prazo da etapa vencia e o tempo de atendimento do relatório inflava com uma
   espera que não existiu.

   Duas saídas, gravadas no mesmo lugar (`messages.encerra`):
     1 = automática: a mensagem é curta e só tem palavras de fechamento, ou é
         só emoji/figurinha;
     2 = alguém tocou "Não precisa responder" na conversa (`encerra_por`
         guarda quem — a gestão confere se o botão está escondendo lead).
   E `leads.conversa_encerrada_em` diz que a última palavra da conversa é uma
   dessas — o gatilho `trg_msg_encerra` (db.js) acende e apaga.

   Fica DE FORA de propósito: cumprimento ("boa noite" pode ser o começo de
   uma conversa nova), "sim" (costuma ser resposta a uma pergunta que pede
   continuação) e qualquer pergunta. Na dúvida, conta como esperando — errar
   para esse lado é o que a regra já fazia.

   Este módulo não importa nada: é lido pelo webhook e pelos relatórios. */

const FECHAMENTO = new Set([
  "ok", "okay", "okk", "oks", "okey", "blz", "beleza", "legal", "show", "top", "perfeito", "perfeita",
  "combinado", "combinados", "certo", "certinho", "obrigado", "obrigada", "obrigadu", "obg", "obgd", "obgda",
  "brigado", "brigada", "valeu", "vlw", "tmj", "otimo", "otima", "massa", "joia", "maravilha", "bacana",
  "entendi", "entendido", "grato", "grata", "agradeco", "fechado", "tranquilo", "suave", "demais",
]);
// Aparecem junto de uma palavra de fechamento ("tá bom", "muito obrigado",
// "ok, obrigado viu"), mas sozinhas não fecham nada.
const DE_APOIO = new Set(["ta", "esta", "bom", "muito", "mto", "mt", "viu", "entao", "e", "de", "nada", "pelo", "pela",
  "atencao", "ajuda", "por", "tudo", "sr", "sra", "moço", "moca", "querida", "querido", "amigo", "amiga", "aqui", "sim"]);

const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

export function mensagemQueEncerra(texto, { mime = null } = {}) {
  const bruto = String(texto || "").trim();
  // Figurinha (sem texto do cliente) e o rótulo que o webhook dá a ela.
  if (/^\[?(figurinha|sticker)/i.test(bruto) || (!bruto && /webp/i.test(String(mime || "")))) return true;
  if (!bruto || bruto.length > 60) return false;
  if (bruto.includes("?")) return false;
  // Só emoji / pontuação: um 👍, um 🙏, "😊😊".
  if (!/[\p{L}\p{N}]/u.test(bruto)) return true;
  const palavras = semAcento(bruto.toLowerCase()).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!palavras.length || palavras.length > 5) return false;
  let forte = false;
  for (const p of palavras) {
    if (FECHAMENTO.has(p) || /^k{2,}$/.test(p) || /^(ha){2,}h?$/.test(p) || /^(rs)+$/.test(p) || /^o+k+$/.test(p)) { forte = true; continue; }
    if (DE_APOIO.has(p)) continue;
    return false;
  }
  // "tá bom" fecha; "muito" sozinho não.
  if (!forte && /\b(ta|esta) bom\b/.test(palavras.join(" "))) forte = true;
  return forte;
}

/* Condição SQL: a mensagem do cliente NÃO é uma das que só encerram. Vai junto
   do `semDisparo` nos pontos que perguntam "o cliente está esperando?". */
export const naoEncerra = (a = "") => `NOT (${a}direction = 'in' AND ${a}encerra IS NOT NULL)`;
