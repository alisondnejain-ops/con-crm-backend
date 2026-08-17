import webpush from "web-push";
import db from "../db.js";

/* Notificação push (Web Push).

   Serve para o corretor saber que chegou lead ou que o cliente respondeu sem
   precisar ficar com o CRM aberto. Dois avisos, decididos com o Ali:
     - o lead foi transferido para você
     - o seu lead respondeu

   Sem VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY nas variáveis, tudo aqui vira
   silêncio: `configurado()` devolve false, a tela nem oferece o botão de
   ativar e nada quebra. Mesmo espírito do e-mail em services/mail.js.

   CUIDADO no iPhone: só funciona se o corretor ADICIONAR O SITE À TELA DE
   INÍCIO. Aba aberta no Safari não recebe push — é limitação da Apple, não do
   nosso código. No Android funciona direto pelo navegador. */

const PUBLICA = process.env.VAPID_PUBLIC_KEY || "";
const PRIVADA = process.env.VAPID_PRIVATE_KEY || "";
// O "assunto" identifica quem envia; o padrão exige mailto: ou uma URL.
const CONTATO = process.env.VAPID_SUBJECT || "mailto:contato@conhubcrm.com.br";

export const configurado = () => !!(PUBLICA && PRIVADA);
export const chavePublica = () => PUBLICA;

if (configurado()) webpush.setVapidDetails(CONTATO, PUBLICA, PRIVADA);

export function inscrever(userId, sub) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error("Inscrição inválida");
  db.prepare(`INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`)
    .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now());
}

export const cancelar = (endpoint) => db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);

/* O navegador trocou a inscrição deste aparelho.

   Chamado pelo service worker, SEM login — ele não tem o token da pessoa. A
   prova de posse é o endereço antigo: só o navegador daquele aparelho o
   conhece, e aqui só se TRANSFERE uma inscrição que já existe. Endereço
   desconhecido não cria nada, para esta rota não virar uma porta de inscrever
   qualquer um em nome de outro. */
export function trocar(antigo, nova) {
  if (!antigo || !nova || !nova.endpoint || !nova.keys) return { trocada: false };
  const atual = db.prepare("SELECT user_id FROM push_subs WHERE endpoint = ?").get(antigo);
  if (!atual) return { trocada: false };
  db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(antigo);
  inscrever(atual.user_id, nova);
  console.log("[push] inscrição renovada pelo navegador");
  return { trocada: true };
}
export const inscricoesDe = (userId) => db.prepare("SELECT COUNT(*) n FROM push_subs WHERE user_id = ?").get(userId).n;

/* Dispara para todos os aparelhos do usuário. Não lança nunca: push é aviso,
   não pode derrubar o recebimento de um lead nem o repasse de uma conversa. */
export async function avisar(userId, { titulo, corpo, leadId }) {
  if (!configurado() || !userId) return { enviados: 0 };
  const subs = db.prepare("SELECT * FROM push_subs WHERE user_id = ?").all(userId);
  if (!subs.length) return { enviados: 0 };

  const carga = JSON.stringify({ titulo, corpo, leadId: leadId || null });
  let enviados = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        carga
      );
      enviados++;
    } catch (e) {
      // 404/410 = o aparelho desinstalou o app ou revogou a permissão. A
      // inscrição morreu; guardá-la só geraria erro em toda notificação futura.
      if (e.statusCode === 404 || e.statusCode === 410) {
        cancelar(s.endpoint);
        console.log("[push] inscrição expirada, removida");
      } else {
        console.warn("[push] falhou:", e.statusCode || "", e.message);
      }
    }
  }));
  return { enviados };
}
