/* O CRM LIGA O RECEBIMENTO SOZINHO (29/09/2026).

   Relato do Ali, no dia seguinte ao onboarding de uma imobiliária grande de
   Maragogi: "os números cadastrados, tanto da imobiliária quanto dos
   corretores, não estão chegando as mensagens no CRM". O envio funcionava; o
   recebimento não existia.

   O motivo é de desenho, não de um cliente: a mensagem do cliente só chega ao
   CRM se a INSTÂNCIA da Uazapi tiver o webhook apontando para
   `/webhooks/uazapi` — e isso era um passo MANUAL, o quinto do tutorial ("cole
   o webhook"). Na linha do corretor era pior: a tela "Meu WhatsApp" nem
   mencionava o webhook. Cada número novo dependia de alguém lembrar de colar
   uma URL no painel de outro sistema, e esquecer não dava erro nenhum: o CRM
   conectava, enviava, e simplesmente não recebia.

   Agora o próprio CRM confere e configura, pela API da Uazapi (`GET/POST
   /webhook`, com o token da instância):
   - ao salvar a conexão de qualquer linha (casa, corretor, disparo);
   - no start e a cada 30 minutos, para TODAS as linhas conectadas — é o que
     conserta as contas que já existem sem ninguém precisar mexer;
   - no botão "Conferir recebimento" da tela de Conexão.

   TRÊS CUIDADOS, porque isto mexe na configuração de um sistema do cliente:

   1. Webhook que JÁ aponta para o CRM (qualquer endereço terminado em
      `/webhooks/uazapi`, ligado e com mensagens) não é tocado. As contas que
      funcionam hoje continuam exatamente como estão.
   2. Webhook de OUTRO sistema do cliente (um n8n, um chatbot) não é
      sobrescrito: o do CRM entra AO LADO (`action: "add"`). Só quando não
      há nenhum webhook é que vai no modo simples.
   3. Só com `APP_URL` de verdade. Sem ele, ou com ele apontando para
      localhost, nada é configurado — senão um servidor de testes com uma
      cópia do banco apontaria o WhatsApp de um cliente real para uma máquina
      que ninguém alcança. `CONHUB_WEBHOOK_PERMITE_LOCAL=1` libera o localhost
      só para os testes automáticos.

   Grupos ficam de fora (`isGroupYes`): o CRM já os descarta ao receber, e
   mandá-los só gastaria a banda do servidor. O eco do que o próprio CRM
   enviou continua vindo, como sempre veio — é ele que faz a mensagem digitada
   no WhatsApp Web aparecer, e o CRM já o reconhece pelo id. */

import db from "../db.js";
import { canalPorId, canalDaCasa } from "./canais.js";

const TIMEOUT_MS = 20000;
const NOSSO = /\/webhooks\/uazapi\/?$/i;
const limpar = (h) => String(h || "").trim().replace(/\/+$/, "");

export function enderecoDoWebhook() {
  const base = limpar(process.env.APP_URL);
  let u;
  try { u = new URL(base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(u.hostname);
  if (local && process.env.CONHUB_WEBHOOK_PERMITE_LOCAL !== "1") return null;
  return `${base}/webhooks/uazapi`;
}

/* A linha e as credenciais dela. A casa lê `orgs.uazapi_*` (é a coluna que o
   resto do sistema escreve); as outras leem a própria linha — e linha sem
   token NÃO cai para as credenciais da casa, senão conferir o número de um
   corretor que ainda não ligou mexeria no webhook da imobiliária. */
function alvo(orgId, canalId) {
  const canal = canalId ? canalPorId(canalId) : canalDaCasa(orgId);
  if (canal && canal.provider === "meta") return { canal, meta: true };
  if (canal && canal.tipo !== "imobiliaria")
    return { canal, host: canal.ativo ? limpar(canal.host) : "", token: canal.ativo ? String(canal.token || "") : "" };
  const o = db.prepare("SELECT uazapi_host, uazapi_token FROM orgs WHERE id = ?").get(orgId || (canal && canal.org_id)) || {};
  return { canal, host: limpar(o.uazapi_host), token: String(o.uazapi_token || "") };
}

async function pedir(host, token, metodo, corpo) {
  let res;
  try {
    res = await fetch(`${host}/webhook`, {
      method: metodo,
      headers: { "Content-Type": "application/json", token },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const tempo = e.name === "TimeoutError" || e.name === "AbortError";
    throw new Error(tempo ? `a Uazapi não respondeu em ${TIMEOUT_MS / 1000}s` : `não consegui falar com a Uazapi (${e.message})`);
  }
  const bruto = await res.text().catch(() => "");
  let data = null;
  try { data = bruto ? JSON.parse(bruto) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401) throw new Error("a Uazapi recusou o token desta instância (confira o token)");
    const motivo = data && (data.message || data.error);
    throw new Error(`a Uazapi respondeu ${res.status}${motivo ? `: ${String(motivo).slice(0, 140)}` : ""}`);
  }
  return data;
}

// A Uazapi devolve uma lista; aceita também objeto único e { webhooks: [...] }.
function lista(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.filter(Boolean);
  if (Array.isArray(data.webhooks)) return data.webhooks.filter(Boolean);
  if (typeof data === "object" && (data.url || data.id)) return [data];
  return [];
}
const recebeMensagens = (w) => w.enabled !== false
  && (!Array.isArray(w.events) || w.events.length === 0 || w.events.includes("messages"));

function gravar(canal, estado, detalhe) {
  if (!canal) return;
  db.prepare("UPDATE canais SET webhook_estado = ?, webhook_em = ?, webhook_detalhe = ? WHERE id = ?")
    .run(estado, Date.now(), detalhe || null, canal.id);
}

/* Confere uma linha e, faltando, configura. Nunca lança: quem chama é o
   salvamento da conexão, o batimento de 30 minutos e um botão — nenhum deles
   pode quebrar por causa disto. Devolve { estado, acao, detalhe }. */
export async function garantirWebhook(orgId, canalId = null, { corrigir = true } = {}) {
  const a = alvo(orgId, canalId);
  if (a.meta) return { estado: "meta", detalhe: "Linha na API oficial da Meta: o webhook é configurado no aplicativo da Meta." };
  if (!a.host || !a.token) return { estado: "sem_conexao", detalhe: "Esta linha ainda não tem WhatsApp conectado." };
  const url = enderecoDoWebhook();
  if (!url) {
    const detalhe = "O servidor não sabe o próprio endereço público (falta APP_URL), então não consegue ligar o recebimento sozinho.";
    return { estado: "sem_endereco", detalhe };
  }
  try {
    let atuais = lista(await pedir(a.host, a.token, "GET"));
    const certo = atuais.find(w => NOSSO.test(String(w.url || "")) && recebeMensagens(w));
    if (certo) {
      gravar(a.canal, "ok", null);
      return { estado: "ok", acao: "ja_estava", url: certo.url };
    }
    if (!corrigir) {
      const detalhe = "A instância não está mandando as mensagens para o CRM (webhook não configurado).";
      gravar(a.canal, "erro", detalhe);
      return { estado: "erro", detalhe };
    }
    const base = { enabled: true, url, events: ["messages"], excludeMessages: ["isGroupYes"] };
    // Um webhook do CRM desligado ou sem o evento de mensagens: conserta ELE,
    // em vez de criar um segundo (dois apontando para cá duplicariam cada
    // mensagem que chega).
    const nossoQuebrado = atuais.find(w => NOSSO.test(String(w.url || "")) && w.id);
    const deOutros = atuais.some(w => w.url && !NOSSO.test(String(w.url)));
    const corpo = nossoQuebrado ? { ...base, action: "update", id: nossoQuebrado.id }
      : deOutros ? { ...base, action: "add" }
      : base;
    await pedir(a.host, a.token, "POST", corpo);
    // Confere de novo: "respondeu 200" não é "ficou configurado".
    atuais = lista(await pedir(a.host, a.token, "GET"));
    if (atuais.some(w => NOSSO.test(String(w.url || "")) && recebeMensagens(w))) {
      gravar(a.canal, "ok", null);
      console.log(`[webhook] recebimento LIGADO na ${a.canal && a.canal.tipo !== "imobiliaria" ? "linha de " + (a.canal.nome || a.canal.id) : "linha da imobiliária"} (org ${orgId || a.canal?.org_id})`);
      return { estado: "ok", acao: "configurado", url };
    }
    const detalhe = "A Uazapi aceitou o pedido, mas o webhook não aparece configurado. Cole o endereço do webhook à mão no painel da Uazapi.";
    gravar(a.canal, "erro", detalhe);
    return { estado: "erro", detalhe };
  } catch (e) {
    const detalhe = `Não consegui ligar o recebimento sozinho (${e.message}). Cole o endereço do webhook à mão no painel da Uazapi — ele está no passo a passo da Uazapi, na tela de Conexão.`;
    gravar(a.canal, "erro", detalhe);
    console.warn(`[webhook] org ${orgId || a.canal?.org_id}: ${detalhe}`);
    return { estado: "erro", detalhe };
  }
}

/* Todas as linhas conectadas de uma imobiliária (ou da plataforma inteira).
   Uma de cada vez: são chamadas a um provedor externo, e disparar cem de uma
   vez no start seria o jeito de a Uazapi começar a recusar. */
export async function garantirWebhooksDaOrg(orgId) {
  const casa = canalDaCasa(orgId);
  const linhas = db.prepare(`SELECT id, tipo, nome FROM canais WHERE org_id = ? AND ativo = 1 AND token IS NOT NULL
    AND COALESCE(provider,'uazapi') = 'uazapi' AND tipo <> 'imobiliaria'`).all(orgId);
  const saida = [];
  const orgTemCasa = db.prepare("SELECT uazapi_token FROM orgs WHERE id = ?").get(orgId);
  if (orgTemCasa && orgTemCasa.uazapi_token && (!casa || casa.provider !== "meta"))
    saida.push({ canal_id: casa ? casa.id : null, tipo: "imobiliaria", nome: "Imobiliária", ...(await garantirWebhook(orgId, null)) });
  for (const l of linhas)
    saida.push({ canal_id: l.id, tipo: l.tipo, nome: l.nome, ...(await garantirWebhook(orgId, l.id)) });
  return saida;
}

let rodando = false;
export async function garantirWebhooksEmTodas() {
  if (rodando || !enderecoDoWebhook() || process.env.UAZAPI_AUTOCONFIGURAR === "0") return;
  rodando = true;
  try {
    const orgs = db.prepare(`SELECT DISTINCT org_id FROM (
      SELECT id AS org_id FROM orgs WHERE uazapi_token IS NOT NULL AND uazapi_token <> ''
      UNION SELECT org_id FROM canais WHERE ativo = 1 AND token IS NOT NULL AND COALESCE(provider,'uazapi') = 'uazapi')`).all();
    for (const { org_id } of orgs) await garantirWebhooksDaOrg(org_id);
  } catch (e) {
    console.error("[webhook] erro na conferência geral:", e.message);
  } finally {
    rodando = false;
  }
}
