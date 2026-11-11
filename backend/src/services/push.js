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

/* QUEM É AVISADO DE UM LEAD SEM DONO (05/11/2026, relato do Ali: "a galera da
   VJ não tá recebendo notificação"). O aviso só ia para `assigned_to` — e o
   lead que chega com nenhuma atendente ativa fica na fila, sem dono, e
   ninguém era chamado. É justamente o lead que mais precisa de alguém.

   Primeiro as atendentes ATIVAS (são elas que pegam a fila); sem nenhuma,
   todas as atendentes e gestores ativos da conta. O master fica de fora, como
   em toda lista de equipe. */
export function quemCuidaDaFila(orgId) {
  const base = `SELECT id FROM users WHERE org_id = ? AND status = 'ativo' AND COALESCE(master, 0) = 0`;
  const ativas = db.prepare(`${base} AND role = 'sdr' AND available = 1`).all(orgId).map(u => u.id);
  if (ativas.length) return ativas;
  return db.prepare(`${base} AND role IN ('sdr', 'adm')`).all(orgId).map(u => u.id);
}

/* Avisa quem está com o lead; sem dono, quem cuida da fila. Nunca lança. */
export function avisarDoLead(orgId, assignedTo, aviso) {
  const ids = assignedTo ? [assignedTo] : quemCuidaDaFila(orgId);
  // Só nos testes: o servidor roda em outro processo, e esta linha é como o
  // teste sabe quem foi chamado sem depender de um serviço de push de verdade.
  if (process.env.PUSH_REGISTRAR === "1") for (const id of ids) console.log(`[push-teste] ${id} | ${aviso.titulo}`);
  for (const id of ids) avisar(id, aviso).catch(() => {});
  return ids.length;
}
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

/* As linhas da mesma pessoa (mesmo e-mail) ativas, em todas as contas. */
export function linhasDaPessoa(userId) {
  const eu = db.prepare("SELECT u.email, u.org_id, u.master, o.name AS org_nome FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.id = ?").get(userId);
  const linhas = eu && !eu.master
    ? db.prepare("SELECT id FROM users WHERE email = ? AND status = 'ativo' AND COALESCE(master,0) = 0").all(eu.email).map(x => x.id)
    : [];
  return { eu, ids: [...new Set([userId, ...linhas])] };
}

/* Dispara para todos os aparelhos do usuário. Não lança nunca: push é aviso,
   não pode derrubar o recebimento de um lead nem o repasse de uma conversa. */
export async function avisar(userId, { titulo, corpo, leadId }) {
  if (!configurado() || !userId) return { enviados: 0 };
  /* A MESMA PESSOA EM MAIS DE UMA CONTA (11/11/2026): o aparelho fica
     inscrito na linha da conta em que ela estava quando ativou o aviso, e o
     lead da outra conta chegaria a ninguém. Vai para os aparelhos de todas as
     linhas dela (mesmo e-mail), com o nome da conta no título — e `conta`
     faz o app trocar para ela ao tocar. */
  const { eu, ids } = linhasDaPessoa(userId);
  const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  if (!subs.length) return { enviados: 0, aparelhos: 0, removidos: 0, falhas: [] };

  const variasContas = ids.length > 1 && eu?.org_nome;
  const carga = JSON.stringify({ titulo: variasContas ? `${eu.org_nome} · ${titulo}` : titulo, corpo,
    leadId: leadId || null, conta: variasContas ? eu.org_id : null });
  let enviados = 0, removidos = 0;
  const falhas = [];
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
        removidos++;
        console.log("[push] inscrição expirada, removida");
      } else {
        falhas.push(e.statusCode || 0);
        console.warn("[push] falhou:", e.statusCode || "", e.message);
      }
    }
  }));
  // `aparelhos`, `removidos` e `falhas` existem para o "Enviar teste" dizer
  // POR QUE não chegou — "nenhum aparelho" e "o serviço recusou" pedem
  // remédios diferentes. Quem só quer avisar continua lendo `enviados`.
  return { enviados, aparelhos: subs.length, removidos, falhas };
}
