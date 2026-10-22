/* DESEMPENHO DOS ANÚNCIOS DA META (22/10/2026).

   A Meta recusou a `ads_read` porque o ConHub só a usava para ler o NOME da
   campanha junto do lead, e o revisor quer ver o uso que a permissão existe
   para cobrir: números de desempenho (investimento, impressões, alcance,
   cliques, resultados) lidos AO VIVO da conta de anúncios e mostrados no
   painel. E é o que faltava ao gestor: até aqui ele via quantos leads e vendas
   cada campanha trouxe, mas não quanto custou — sem o investimento não existe
   custo por lead nem custo por venda, que é a pergunta de quem paga o anúncio.

   O token é o DE USUÁRIO (insights de conta de anúncios não abrem com token de
   página), guardado fechado pelo cofre, uma conexão por imobiliária. Ele vale
   cerca de 60 dias: vencido, a tela manda conectar de novo, e o lead continua
   entrando, porque o lead usa o token da PÁGINA, que não vence.

   Só leitura. O ConHub não cria, pausa nem altera anúncio nenhum. */
import db from "../db.js";
import { fechar, abrir } from "./cofre.js";
import { graph } from "./meta.js";

db.exec(`CREATE TABLE IF NOT EXISTS meta_anuncios (
  org_id TEXT PRIMARY KEY,
  user_token TEXT,
  token_expira INTEGER,
  permissoes TEXT,
  conectado_por TEXT,
  conectado_em INTEGER,
  conta_id TEXT,
  conta_nome TEXT,
  moeda TEXT,
  ultimo_erro TEXT,
  ultimo_erro_em INTEGER
)`);

export class ErroAnuncios extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const tem = (permissoes, p) => !permissoes || permissoes.includes(p);

/* Chamado na escolha da página: a pessoa acabou de conectar o Facebook dela
   nesta conta. Só guarda quando a `ads_read` foi concedida (ou quando não se
   sabe — a Meta, se recusar, diz). Reconectar troca o token e mantém a conta
   de anúncios escolhida. */
export function guardarTokenDoUsuario(orgId, userId, token, expiraEm, permissoes) {
  if (!token || (permissoes && !permissoes.includes("ads_read"))) return false;
  db.prepare(`INSERT INTO meta_anuncios (org_id,user_token,token_expira,permissoes,conectado_por,conectado_em)
      VALUES (?,?,?,?,?,?)
    ON CONFLICT(org_id) DO UPDATE SET user_token = excluded.user_token, token_expira = excluded.token_expira,
      permissoes = excluded.permissoes, conectado_por = excluded.conectado_por, conectado_em = excluded.conectado_em,
      ultimo_erro = NULL, ultimo_erro_em = NULL`)
    .run(orgId, fechar(token), expiraEm || null, permissoes ? permissoes.join(",") : null, userId, Date.now());
  limparCache(orgId);
  return true;
}

const linhaDa = (orgId) => db.prepare("SELECT * FROM meta_anuncios WHERE org_id = ?").get(orgId);

export function estado(orgId) {
  const l = linhaDa(orgId);
  if (!l || !l.user_token) return { conectado: false };
  return {
    conectado: true,
    conta: l.conta_id ? { id: l.conta_id, nome: l.conta_nome, moeda: l.moeda } : null,
    token_expira: l.token_expira || null,
    vencido: !!(l.token_expira && l.token_expira < Date.now()),
    ultimo_erro: l.ultimo_erro || null, ultimo_erro_em: l.ultimo_erro_em || null,
  };
}

function tokenDa(orgId) {
  const l = linhaDa(orgId);
  const t = l && abrir(l.user_token);
  if (!t) throw new ErroAnuncios(409, "Conecte o Facebook em Configurações → Anúncios do Meta para ver o desempenho dos anúncios.");
  return { linha: l, token: t };
}

/* O erro da Meta em português, e anotado na conta — a tela de configuração
   mostra o último. Token vencido (190) é o caso comum depois de 60 dias. */
function traduzir(orgId, e) {
  let msg;
  if (e.codigo === 190) msg = "A conexão com o Facebook venceu. Conecte de novo em Configurações → Anúncios do Meta.";
  else if (e.codigo === 10 || e.codigo === 200 || e.codigo === 294 || /permission/i.test(e.message))
    msg = "O Facebook não deu permissão para ler esta conta de anúncios (ads_read). Confira se quem conectou tem acesso à conta de anúncios e conecte de novo.";
  else if (e.codigo === 4 || e.codigo === 17 || e.codigo === 613) msg = "A Meta pediu uma pausa nas consultas. Tente de novo em alguns minutos.";
  else msg = "A Meta não respondeu: " + String(e.titulo || e.message || "").slice(0, 160);
  db.prepare("UPDATE meta_anuncios SET ultimo_erro = ?, ultimo_erro_em = ? WHERE org_id = ?").run(msg, Date.now(), orgId);
  return new ErroAnuncios(e.codigo === 190 ? 409 : 502, msg);
}

const STATUS_CONTA = { 1: "ativa", 2: "desativada", 3: "com pagamento pendente", 7: "em análise", 9: "em período de carência", 101: "fechada" };

export async function contasDeAnuncio(orgId) {
  const { token } = tokenDa(orgId);
  try {
    const lista = [];
    let r = await graph("me/adaccounts", { token, params: { fields: "id,account_id,name,account_status,currency,business{name}", limit: 100 } });
    lista.push(...(r.data || []));
    for (let i = 0; i < 5 && r.paging?.next; i++) {
      const res = await fetch(r.paging.next, { signal: AbortSignal.timeout(20000) });
      r = await res.json().catch(() => ({}));
      lista.push(...(r.data || []));
    }
    return lista.filter(c => c.id).map(c => ({
      id: String(c.id).startsWith("act_") ? String(c.id) : `act_${c.id}`,
      nome: c.name || c.account_id || c.id, moeda: c.currency || null,
      status: STATUS_CONTA[c.account_status] || null, empresa: c.business?.name || null,
    }));
  } catch (e) { throw traduzir(orgId, e); }
}

export async function escolherConta(orgId, contaId) {
  const id = String(contaId || "");
  if (!id) {
    db.prepare("UPDATE meta_anuncios SET conta_id = NULL, conta_nome = NULL, moeda = NULL WHERE org_id = ?").run(orgId);
    limparCache(orgId);
    return estado(orgId);
  }
  // Só uma conta que o Facebook de quem conectou mostra — nunca um id digitado.
  const c = (await contasDeAnuncio(orgId)).find(x => x.id === id);
  if (!c) throw new ErroAnuncios(404, "Esta conta de anúncios não aparece para o Facebook conectado.");
  db.prepare("UPDATE meta_anuncios SET conta_id = ?, conta_nome = ?, moeda = ? WHERE org_id = ?").run(c.id, c.nome, c.moeda, orgId);
  limparCache(orgId);
  return estado(orgId);
}

export function desligar(orgId) {
  db.prepare("DELETE FROM meta_anuncios WHERE org_id = ?").run(orgId);
  limparCache(orgId);
}

/* ===== Os números ===== */

const CACHE = new Map();
const CACHE_MS = 15 * 60_000;
function limparCache(orgId) { for (const k of CACHE.keys()) if (k.startsWith(orgId + "|")) CACHE.delete(k); }

const dia = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const num = (v) => (v == null || v === "" || !isFinite(Number(v))) ? null : Number(v);

/* "Resultados" de formulário. A Meta conta o lead em mais de um nome; vale o
   primeiro que vier, nessa ordem, para não somar o mesmo lead duas vezes. */
const TIPOS_LEAD = ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead"];
function leadsDaMeta(actions, temLinha) {
  // A Meta omite `actions` quando a campanha não teve resultado: com a linha
  // de desempenho presente, isso é zero; sem linha nenhuma, ninguém sabe.
  if (!Array.isArray(actions)) return temLinha ? 0 : null;
  for (const t of TIPOS_LEAD) {
    const a = actions.find(x => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
}

const CAMPOS = "campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpm,actions";

async function insights(token, contaId, nivel, since, until) {
  const lista = [];
  let r = await graph(`${contaId}/insights`, { token, params: {
    level: nivel, fields: nivel === "account" ? "spend,impressions,reach,clicks,ctr,cpm,actions" : CAMPOS,
    time_range: { since, until }, limit: 500 } });
  lista.push(...(r.data || []));
  for (let i = 0; i < 10 && r.paging?.next; i++) {
    const res = await fetch(r.paging.next, { signal: AbortSignal.timeout(30000) });
    r = await res.json().catch(() => ({}));
    lista.push(...(r.data || []));
  }
  return lista;
}

const daMeta = (x) => ({
  investimento: num(x.spend), impressoes: num(x.impressions), alcance: num(x.reach), cliques: num(x.clicks),
  ctr: num(x.ctr), cpm: num(x.cpm), leads_meta: leadsDaMeta(x.actions, x.spend != null),
});
const divide = (a, b) => (a == null || !b) ? null : Math.round((a / b) * 100) / 100;

/* Período: o mesmo do resto da Operação ({de, ate} em ms). A Meta trabalha em
   DIAS no fuso da conta de anúncios; aqui se manda o dia de Brasília. */
export async function desempenho(orgId, periodo, { atualizar = false } = {}) {
  const { linha, token } = tokenDa(orgId);
  if (!linha.conta_id) throw new ErroAnuncios(409, "Escolha a conta de anúncios em Configurações → Anúncios do Meta.");
  const since = dia(periodo.de), until = dia(Math.min(periodo.ate, Date.now()));
  const chave = `${orgId}|${linha.conta_id}|${since}|${until}`;
  const guardado = CACHE.get(chave);
  if (!atualizar && guardado && guardado.em > Date.now() - CACHE_MS) return montar(orgId, linha, periodo, guardado);

  let conta, campanhas;
  try {
    [conta, campanhas] = await Promise.all([
      insights(token, linha.conta_id, "account", since, until),
      insights(token, linha.conta_id, "campaign", since, until),
    ]);
  } catch (e) { throw traduzir(orgId, e); }
  db.prepare("UPDATE meta_anuncios SET ultimo_erro = NULL, ultimo_erro_em = NULL WHERE org_id = ?").run(orgId);
  const dados = { em: Date.now(), since, until, conta: conta[0] || null, campanhas };
  CACHE.set(chave, dados);
  return montar(orgId, linha, periodo, dados);
}

/* Junta o número da Meta com o do CRM pela campanha (id primeiro, nome como
   reserva — lead antigo pode ter só o nome). Leads e vendas do CRM são da
   coorte do período, a mesma régua da tabela de Campanhas logo abaixo. */
function montar(orgId, linha, periodo, dados) {
  const leads = db.prepare(`SELECT campaign_id, campaign_name, sale_value FROM leads
    WHERE org_id = ? AND created_at BETWEEN ? AND ? AND (campaign_id IS NOT NULL OR campaign_name IS NOT NULL)`)
    .all(orgId, periodo.de, periodo.ate);
  const doCrm = (id, nome) => {
    const daqui = leads.filter(l => (id && l.campaign_id === id) || (!l.campaign_id && nome && l.campaign_name === nome));
    const vendas = daqui.filter(l => l.sale_value != null);
    return { leads_crm: daqui.length, vendas: vendas.length, vgv: vendas.reduce((s, l) => s + (l.sale_value || 0), 0) };
  };
  const linhas = dados.campanhas.map(c => {
    const m = daMeta(c);
    const crm = doCrm(String(c.campaign_id || ""), c.campaign_name);
    return { campaign_id: c.campaign_id || null, campanha: c.campaign_name || "(sem nome)", ...m, ...crm,
      custo_por_lead: divide(m.investimento, crm.leads_crm), custo_por_venda: divide(m.investimento, crm.vendas) };
  }).sort((a, b) => (b.investimento || 0) - (a.investimento || 0));
  const totalMeta = dados.conta ? daMeta(dados.conta) : daMeta({});
  const leadsCrm = linhas.reduce((s, l) => s + l.leads_crm, 0);
  const vendas = linhas.reduce((s, l) => s + l.vendas, 0);
  return {
    conta: { id: linha.conta_id, nome: linha.conta_nome, moeda: linha.moeda },
    periodo: { since: dados.since, until: dados.until },
    lido_em: dados.em,
    total: { ...totalMeta, leads_crm: leadsCrm, vendas,
      custo_por_lead: divide(totalMeta.investimento, leadsCrm), custo_por_venda: divide(totalMeta.investimento, vendas) },
    campanhas: linhas,
  };
}
