/* ===== GOOGLE AGENDA E MEET (31/10/2026, lista do Fernando) =====

   Cada pessoa liga a PRÓPRIA conta Google (Minha conta → Google Agenda). Com
   ela ligada, a tarefa que nasce no nome dela vira um evento na agenda dela,
   e quem cria a tarefa pode pedir um link do Meet junto.

   O QUE DEPENDE DO GOOGLE, e não do código: um projeto no Google Cloud com a
   API do Calendar ligada, um "ID do cliente OAuth" (GOOGLE_CLIENT_ID e
   GOOGLE_CLIENT_SECRET no servidor), o endereço de retorno
   `APP_URL/conectar-google/retorno` cadastrado lá, e — para qualquer pessoa
   de fora da equipe de testes — a VERIFICAÇÃO do app pelo Google, porque o
   escopo de agenda é sensível. Sem as variáveis, a tela diz que não está
   ligado e nada muda.

   O QUE VAI PARA O GOOGLE: o título da tarefa, a hora e o NOME do lead, com o
   link da conversa no CRM. Telefone, conversa e dados de financiamento não
   saem daqui.

   Nunca lança para a tarefa: Google fora do ar não pode impedir ninguém de
   marcar uma tarefa no CRM. A falha fica escrita na tarefa. */
import db from "../db.js";
import { randomUUID } from "crypto";
import { fechar, abrir } from "./cofre.js";

const OAUTH = () => (process.env.GOOGLE_OAUTH_URL || "https://oauth2.googleapis.com").replace(/\/$/, "");
const AUTH = () => (process.env.GOOGLE_AUTH_URL || "https://accounts.google.com").replace(/\/$/, "");
const API = () => (process.env.GOOGLE_API_URL || "https://www.googleapis.com").replace(/\/$/, "");
const ESCOPOS = "https://www.googleapis.com/auth/calendar.events";
const TEMPO = 15000;

export const googleConfigurado = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function urlDeLogin(state, redirect) {
  const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code",
    scope: ESCOPOS, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return `${AUTH()}/o/oauth2/v2/auth?${q}`;
}

async function postarForm(url, campos) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(campos), signal: AbortSignal.timeout(TEMPO) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error_description || d.error || `o Google respondeu ${r.status}`);
  return d;
}

export async function conectar(user, code, redirect) {
  const d = await postarForm(`${OAUTH()}/token`, { code, client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code" });
  if (!d.refresh_token) throw new Error("o Google não devolveu a permissão permanente. Tire o acesso do ConHub na sua conta Google e conecte de novo.");
  db.prepare(`INSERT INTO google_contas (user_id, org_id, refresh_token, conectado_em) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET org_id = excluded.org_id, refresh_token = excluded.refresh_token, conectado_em = excluded.conectado_em`)
    .run(user.id, user.org_id, fechar(d.refresh_token), Date.now());
}

export function estado(user) {
  const c = db.prepare("SELECT conectado_em FROM google_contas WHERE user_id = ?").get(user.id);
  return { configurado: googleConfigurado(), conectado: !!c, conectado_em: c ? c.conectado_em : null };
}

export async function desconectar(user) {
  const c = db.prepare("SELECT refresh_token FROM google_contas WHERE user_id = ?").get(user.id);
  db.prepare("DELETE FROM google_contas WHERE user_id = ?").run(user.id);
  // Cortesia: avisa o Google para revogar. Falhando, a conta sai daqui do mesmo jeito.
  if (c) fetch(`${OAUTH()}/revoke?token=${encodeURIComponent(abrir(c.refresh_token))}`, { method: "POST", signal: AbortSignal.timeout(TEMPO) }).catch(() => {});
  return { ok: true };
}

async function tokenDeAcesso(userId) {
  const c = db.prepare("SELECT refresh_token FROM google_contas WHERE user_id = ?").get(userId);
  if (!c || !googleConfigurado()) return null;
  try {
    const d = await postarForm(`${OAUTH()}/token`, { refresh_token: abrir(c.refresh_token), client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" });
    return d.access_token || null;
  } catch (e) {
    // Acesso revogado na conta Google: a ligação daqui deixa de valer.
    if (/invalid_grant/i.test(e.message)) db.prepare("DELETE FROM google_contas WHERE user_id = ?").run(userId);
    throw e;
  }
}

async function chamarAgenda(token, metodo, caminho, corpo) {
  const r = await fetch(`${API()}/calendar/v3${caminho}`, { method: metodo,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(TEMPO) });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `o Google Agenda respondeu ${r.status}`);
  return d;
}

const pessoaTemGoogle = (userId) => !!(userId && googleConfigurado() && db.prepare("SELECT 1 FROM google_contas WHERE user_id = ?").get(userId));

/* A tarefa vira evento na agenda de QUEM É a tarefa (o dono do lead). */
export async function eventoDaTarefa(tarefaId, { meet = false } = {}) {
  const t = db.prepare(`SELECT t.*, l.name AS lead_nome FROM tarefas t JOIN leads l ON l.id = t.lead_id WHERE t.id = ?`).get(tarefaId);
  if (!t || !pessoaTemGoogle(t.user_id)) return { criado: false };
  try {
    const token = await tokenDeAcesso(t.user_id);
    if (!token) return { criado: false };
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    const evento = {
      summary: `${t.titulo} · ${t.lead_nome || "lead"}`,
      description: `Tarefa do ConHub${base ? `\nAbrir a conversa: ${base}/app?lead=${t.lead_id}` : ""}`,
      start: { dateTime: new Date(t.quando).toISOString() },
      end: { dateTime: new Date(t.quando + 30 * 60000).toISOString() },
      ...(meet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    };
    const d = await chamarAgenda(token, "POST", `/calendars/primary/events${meet ? "?conferenceDataVersion=1" : ""}`, evento);
    const link = d.hangoutLink || (d.conferenceData?.entryPoints || []).find(e => e.entryPointType === "video")?.uri || null;
    db.prepare("UPDATE tarefas SET google_event_id = ?, google_meet = ?, google_erro = NULL WHERE id = ?").run(d.id || null, link, t.id);
    return { criado: true, meet: link };
  } catch (e) {
    const erro = String(e.message || e).slice(0, 200);
    db.prepare("UPDATE tarefas SET google_erro = ? WHERE id = ?").run(erro, t.id);
    console.warn("[google] evento não criado:", erro);
    return { criado: false, erro };
  }
}

// A tarefa apagada sai da agenda; a feita fica (é o registro do que aconteceu).
export async function apagarEvento(tarefa) {
  if (!tarefa || !tarefa.google_event_id || !pessoaTemGoogle(tarefa.user_id)) return;
  try {
    const token = await tokenDeAcesso(tarefa.user_id);
    if (token) await chamarAgenda(token, "DELETE", `/calendars/primary/events/${encodeURIComponent(tarefa.google_event_id)}`);
  } catch (e) { console.warn("[google] evento não apagado:", String(e.message).slice(0, 160)); }
}

// Data e hora mudaram: o evento acompanha.
export async function moverEvento(tarefaId) {
  const t = db.prepare(`SELECT t.*, l.name AS lead_nome FROM tarefas t JOIN leads l ON l.id = t.lead_id WHERE t.id = ?`).get(tarefaId);
  if (!t || !t.google_event_id || !pessoaTemGoogle(t.user_id)) return;
  try {
    const token = await tokenDeAcesso(t.user_id);
    if (token) await chamarAgenda(token, "PATCH", `/calendars/primary/events/${encodeURIComponent(t.google_event_id)}`, {
      summary: `${t.titulo} · ${t.lead_nome || "lead"}`,
      start: { dateTime: new Date(t.quando).toISOString() }, end: { dateTime: new Date(t.quando + 30 * 60000).toISOString() } });
  } catch (e) { console.warn("[google] evento não atualizado:", String(e.message).slice(0, 160)); }
}
