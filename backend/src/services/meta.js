/* META: anúncios de formulário (Lead Ads).

   Dois jeitos de uma página entregar lead ao CRM:
   1. O BOTÃO "Conectar com Facebook" (01/10/2026): cada imobiliária entra com
      o próprio Facebook, escolhe a página, e o token DAQUELA página fica
      guardado em `meta_paginas`, preso à conta que a conectou.
   2. A página antiga da instalação: o token em META_PAGE_ACCESS_TOKEN, de
      antes do botão existir (a Conecta). Continua funcionando até ela ser
      conectada pelo botão. */

const VERSION = process.env.META_GRAPH_VERSION || "v19.0";
// Endereço da Graph API trocável só para os testes falarem com uma Meta de mentira.
const GRAPH = () => (process.env.META_GRAPH_URL || "https://graph.facebook.com").replace(/\/$/, "");
const TOKEN_ANTIGO = () => process.env.META_PAGE_ACCESS_TOKEN || "";

/* As permissões que o botão pede. São as que o App Review da Meta precisa
   aprovar: listar as páginas da pessoa, assinar a página nos avisos de lead e
   ler o lead. `business_management` é o que faz aparecer a página que está
   dentro de um Gerenciador de Negócios (o caso comum de imobiliária), e
   `ads_read` é o que traz o NOME da campanha junto do lead. */
export const PERMISSOES = (process.env.META_PERMISSOES ||
  "pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval,business_management,ads_read")
  .split(",").map(x => x.trim()).filter(Boolean);

export const botaoConfigurado = () => !!(process.env.META_APP_ID && process.env.META_APP_SECRET);

async function graph(caminho, { metodo = "GET", token, params = {} } = {}) {
  const u = new URL(`${GRAPH()}/${VERSION}/${caminho.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  if (token) u.searchParams.set("access_token", token);
  const res = await fetch(u, { method: metodo, signal: AbortSignal.timeout(20000) });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok || corpo.error) {
    const e = new Error(corpo.error?.message || `Meta respondeu ${res.status}`);
    e.codigo = corpo.error?.code;
    throw e;
  }
  return corpo;
}

/* ===== O botão ===== */

export function urlDeLogin(state, redirectUri) {
  const u = new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", process.env.META_APP_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  /* App do tipo "Empresa" usa o "Login do Facebook para Empresas", em que as
     permissões ficam numa CONFIGURAÇÃO criada no painel da Meta e o pedido
     leva só o id dela. Sem META_CONFIG_ID, vai a lista de permissões. */
  if (process.env.META_CONFIG_ID) u.searchParams.set("config_id", process.env.META_CONFIG_ID);
  else u.searchParams.set("scope", PERMISSOES.join(","));
  u.searchParams.set("response_type", "code");
  return u.toString();
}

/* Código → token de usuário de LONGA duração. É com ele que se pede a lista
   de páginas, e o token de página que vem dessa lista NÃO EXPIRA — é o que
   deixa o lead entrando por meses sem ninguém reconectar. */
export async function trocarCodigo(code, redirectUri) {
  const curto = await graph("oauth/access_token", { params: {
    client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri, code } });
  const longo = await graph("oauth/access_token", { params: {
    grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET, fb_exchange_token: curto.access_token } });
  return longo.access_token || curto.access_token;
}

export async function paginasDoUsuario(userToken) {
  const lista = [];
  let r = await graph("me/accounts", { token: userToken, params: { fields: "id,name,access_token", limit: 100 } });
  lista.push(...(r.data || []));
  for (let i = 0; i < 5 && r.paging?.next; i++) {
    const res = await fetch(r.paging.next, { signal: AbortSignal.timeout(20000) });
    r = await res.json().catch(() => ({}));
    lista.push(...(r.data || []));
  }
  return lista.filter(p => p.id && p.access_token).map(p => ({ id: String(p.id), nome: p.name || "", token: p.access_token }));
}

// Liga a página aos avisos de lead deste aplicativo. Sem isto a Meta não avisa nada.
export const assinarPagina = (pageId, pageToken) =>
  graph(`${pageId}/subscribed_apps`, { metodo: "POST", token: pageToken, params: { subscribed_fields: "leadgen" } });
export const desassinarPagina = (pageId, pageToken) =>
  graph(`${pageId}/subscribed_apps`, { metodo: "DELETE", token: pageToken });

/* ===== O lead ===== */

/* OS CAMPOS DE ATRIBUIÇÃO PRECISAM SER PEDIDOS PELO NOME: a Graph API devolve
   um conjunto mínimo quando ninguém pede nada, e campanha, conjunto, anúncio e
   formulário NÃO estão nele. É dado que não volta — lead que entrou sem a
   campanha gravada perdeu a atribuição para sempre. */
export async function buscarLead(leadgenId, token = TOKEN_ANTIGO()) {
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN não configurado");
  const campos = ["id", "created_time", "field_data", "platform", "campaign_id", "campaign_name",
    "adset_id", "adset_name", "ad_id", "ad_name", "form_id"].join(",");
  let dados;
  try { dados = await graph(String(leadgenId), { token, params: { fields: campos } }); }
  catch (e) {
    // Token sem `ads_read` recusa os campos de campanha; o lead vale mais que a atribuição.
    dados = await graph(String(leadgenId), { token, params: { fields: "id,created_time,field_data,platform,form_id" } });
  }
  if (dados.form_id) dados.form_name = await nomeDoFormulario(dados.form_id, token);
  return dados;
}

/* Qual página é a do token antigo do servidor? `undefined` quando não dá para
   saber (o token é de pessoa ou de usuário do sistema, não de página). */
let antiga = null, antigaEm = 0;
export async function paginaDoTokenAntigo() {
  if (process.env.META_PAGE_ID) return String(process.env.META_PAGE_ID);
  if (antiga !== null && Date.now() - antigaEm < 3600_000) return antiga;
  try {
    const r = await graph("me", { token: TOKEN_ANTIGO(), params: { fields: "id,category" } });
    antiga = r.category !== undefined ? String(r.id) : undefined;
  } catch { antiga = undefined; }
  antigaEm = Date.now();
  return antiga;
}

const nomesDeFormulario = new Map();
async function nomeDoFormulario(formId, token) {
  if (nomesDeFormulario.has(formId)) return nomesDeFormulario.get(formId);
  try {
    const r = await graph(String(formId), { token, params: { fields: "name" } });
    nomesDeFormulario.set(formId, r.name || null);
    return r.name || null;
  } catch { return null; }
}

/* As respostas do formulário que viram os campos da ficha (renda, entrada,
   situação, CPF, prazo). Uma regra só para os dois caminhos por onde o lead do
   formulário chega — o webhook nativo da Meta e a ponte do Zapier/Make
   (services/portais.js) —, senão a mesma pergunta cairia num campo por um
   caminho e em outro pelo outro. A pergunta é procurada por PEDAÇO do nome,
   porque cada imobiliária escreve a sua ("Qual a sua renda?", "renda_mensal"). */
export function qualDasRespostas(field) {
  const pick = (...frags) => {
    for (const frag of frags) {
      const key = Object.keys(field).find(k => k.toLowerCase().includes(frag));
      if (key && String(field[key] || "").trim()) return String(field[key]).trim().slice(0, 300);
    }
    return "";
  };
  return {
    renda: pick("renda"),
    entrada: pick("entrada", "disponível", "disponivel"),
    situacao: pick("situação", "situacao", "profissional"),
    cpf: pick("cpf", "restrição", "restricao"),
    prazo: pick("tempo", "prazo"),
  };
}
