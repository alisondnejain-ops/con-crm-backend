/* PERMISSÕES POR PESSOA OU POR GRUPO (28/11/2026, pedido do Fernando).

   Uma regra diz, para UMA PESSOA ou para um GRUPO da estrutura (um nível,
   filtrado por função: todos, o responsável, gestores, corretores ou
   atendentes):
     - escopo: quais LEADS a pessoa vê —
         'proprio'  = só a carteira dela;
         'equipe'   = os leads das pessoas das equipes autorizadas (ou, sem
                      escolha, do nível dela e dos de baixo), mais os dela;
         'operacao' = todos os leads da imobiliária.
     - ferramentas: o que pode fazer em cada ferramenta (entrega B).

   SEM REGRA, VALE O DE SEMPRE: gestor e atendente veem a operação, corretor
   vê a carteira dele. É o que garante que nenhuma conta muda até o gestor
   configurar alguma coisa.

   Ordem: a regra da PESSOA vale mais que a de grupo; entre grupos, o nível
   mais próximo dela (o dela, depois o de cima…), e dentro do mesmo nível a
   regra da função dela vale mais que a de "todos".

   Este arquivo só importa o banco: auth.js usa ele em podeVerLead. */
import { randomUUID } from "node:crypto";
import db from "../db.js";

export const ESCOPOS = ["proprio", "equipe", "operacao"];
export const QUEM = ["todos", "responsavel", "gestor", "corretor", "atendente"];
const FUNCAO_DO_PAPEL = { adm: "gestor", corretor: "corretor", sdr: "atendente" };

/* As ferramentas e as ações que existem em cada uma (o resto é "—" na tela). */
export const FERRAMENTAS = [
  { id: "painel", nome: "Painel e indicadores", acoes: ["consultar"] },
  { id: "relatorios", nome: "Relatórios e Score", acoes: ["consultar", "exportar"] },
  { id: "funil", nome: "Funil e ficha", acoes: ["consultar", "criar", "editar", "excluir"] },
  { id: "catracas", nome: "Catracas", acoes: ["consultar", "criar", "editar", "excluir"] },
  { id: "imoveis", nome: "Imóveis", acoes: ["consultar", "criar", "editar", "excluir"] },
  { id: "cetrolab", nome: "Cetrolab", acoes: ["consultar", "editar"] },
  { id: "plantao", nome: "Plantão", acoes: ["consultar", "criar", "editar", "excluir"] },
  { id: "marketing", nome: "Marketing", acoes: ["consultar", "criar", "editar", "excluir"] },
  { id: "base", nome: "Base de leads", acoes: ["consultar", "editar", "exportar"] },
  { id: "equipe", nome: "Equipe", acoes: ["consultar", "criar", "editar", "excluir"] },
  { id: "configuracoes", nome: "Configurações", acoes: ["consultar", "editar"] },
];
export const ACOES = ["consultar", "criar", "editar", "excluir", "exportar"];

const json = (t, d) => { try { const v = JSON.parse(t || ""); return v ?? d; } catch { return d; } };

function niveisDaConta(orgId) {
  return db.prepare("SELECT id, pai_id, responsavel_id FROM estrutura_niveis WHERE org_id=?").all(orgId);
}
function abaixo(niveis, id) {
  const out = new Set([id]); const fila = [id];
  while (fila.length) { const x = fila.shift(); for (const n of niveis) if (n.pai_id === x && !out.has(n.id)) { out.add(n.id); fila.push(n.id); } }
  return out;
}
function acima(niveis, id) {
  const out = []; const visto = new Set(); let x = id;
  while (x && !visto.has(x)) { visto.add(x); out.push(x); x = (niveis.find(n => n.id === x) || {}).pai_id || null; }
  return out;
}

function formatar(r) {
  return r && { id: r.id, alvo_tipo: r.alvo_tipo, alvo_id: r.alvo_id, quem: r.quem, escopo: r.escopo || null,
    equipes: json(r.equipes_json, []), ferramentas: json(r.ferramentas_json, null), atualizado_em: r.atualizado_em };
}

/* A regra que vale para esta pessoa, ou null. */
export function regraDe(orgId, u) {
  if (!u) return null;
  const pessoa = db.prepare("SELECT * FROM acesso_regras WHERE org_id=? AND alvo_tipo='pessoa' AND alvo_id=?").get(orgId, u.id);
  if (pessoa) return formatar(pessoa);
  const niveis = niveisDaConta(orgId);
  if (!niveis.length) return null;
  const funcao = FUNCAO_DO_PAPEL[u.role] || "corretor";
  // O nível dela e os de cima; e os níveis de que ela é responsável (e os de cima deles).
  const cadeia = [];
  for (const n of niveis.filter(n => n.responsavel_id === u.id)) for (const x of acima(niveis, n.id)) if (!cadeia.includes(x)) cadeia.push(x);
  if (u.nivel_id) for (const x of acima(niveis, u.nivel_id)) if (!cadeia.includes(x)) cadeia.push(x);
  for (const nivelId of cadeia) {
    const n = niveis.find(x => x.id === nivelId);
    const regras = db.prepare("SELECT * FROM acesso_regras WHERE org_id=? AND alvo_tipo='nivel' AND alvo_id=?").all(orgId, nivelId);
    if (!regras.length) continue;
    const ehResp = n && n.responsavel_id === u.id;
    const membro = u.nivel_id && abaixo(niveis, nivelId).has(u.nivel_id);
    const achar = (q) => regras.find(r => r.quem === q);
    const r = (ehResp && achar("responsavel")) || (membro && achar(funcao)) || ((membro || ehResp) && achar("todos"));
    if (r) return formatar(r);
  }
  return null;
}

const CACHE = new Map(); // userId -> { em, valor }
export const limparCache = () => CACHE.clear();

/* Quais leads a pessoa vê: { tipo, ids: Set|null, fila, explicito }.
   ids nulo = a operação inteira. */
export function alcanceDe(user) {
  if (!user || !user.id) return { tipo: "proprio", ids: new Set(), fila: false, explicito: false };
  const c = CACHE.get(user.id);
  if (c && Date.now() - c.em < 15000) return c.valor;
  const u = db.prepare("SELECT id, org_id, role, nivel_id, COALESCE(master,0) master FROM users WHERE id=?").get(user.id);
  let valor;
  if (!u) valor = { tipo: "proprio", ids: new Set([user.id]), fila: false, explicito: false };
  else {
    const orgId = user.org_id || u.org_id;
    const org = db.prepare("SELECT tipo, dono_user_id FROM orgs WHERE id=?").get(orgId) || {};
    const dono = org.tipo === "autonomo" && org.dono_user_id === u.id;
    const regra = (dono || u.master) ? null : regraDe(orgId, u);
    const sup = u.role === "adm" || u.role === "sdr" || dono || !!u.master;
    const tipo = regra && regra.escopo ? regra.escopo : (sup ? "operacao" : "proprio");
    if (tipo === "operacao") valor = { tipo, ids: null, fila: true, explicito: !!(regra && regra.escopo), ferramentas: (regra && regra.ferramentas) || null };
    else {
      const ids = new Set([u.id]);
      if (tipo === "equipe") {
        const niveis = niveisDaConta(orgId);
        let base = (regra.equipes || []).filter(id => niveis.some(n => n.id === id));
        if (!base.length) base = [...niveis.filter(n => n.responsavel_id === u.id).map(n => n.id), ...(u.nivel_id ? [u.nivel_id] : [])];
        const todosNiveis = new Set(); for (const b of base) for (const x of abaixo(niveis, b)) todosNiveis.add(x);
        if (todosNiveis.size) {
          const lista = [...todosNiveis];
          for (const p of db.prepare(`SELECT id FROM users WHERE org_id=? AND nivel_id IN (${lista.map(() => "?").join(",")})`).all(orgId, ...lista)) ids.add(p.id);
          for (const n of niveis) if (todosNiveis.has(n.id) && n.responsavel_id) ids.add(n.responsavel_id);
        }
      }
      valor = { tipo, ids, fila: u.role === "sdr", explicito: !!(regra && regra.escopo), ferramentas: (regra && regra.ferramentas) || null };
    }
  }
  CACHE.set(user.id, { em: Date.now(), valor });
  return valor;
}

/* O lead cabe no alcance? (o org_id é conferido por quem chama) */
export function alcancaLead(user, lead) {
  const a = alcanceDe(user);
  if (!a.ids) return true;
  if (!lead.assigned_to) return a.fila;
  return a.ids.has(lead.assigned_to);
}

/* O filtro de pessoas de um relatório, limitado ao alcance. `atual` é o que
   veio na query (id, "a,b", lista, "fila"). Devolve string (uma) ou lista. */
export function limitarResponsavel(user, atual, { leituraEquipe = false } = {}) {
  const a = alcanceDe(user);
  if (!a.ids) return atual;
  // O corretor com "ver os relatórios da equipe" e sem regra de escopo continua lendo a equipe.
  if (leituraEquipe && !a.explicito) return atual;
  const pode = new Set([...a.ids, ...(a.fila ? ["fila"] : [])]);
  const pedido = (Array.isArray(atual) ? atual : String(atual || "").split(",")).map(x => String(x).trim()).filter(Boolean);
  let l = pedido.filter(x => pode.has(x));
  if (!l.length) l = [...pode];
  return l.length === 1 ? l[0] : l;
}

/* ===== Leitura e gravação das regras (tela Equipe → Permissões) ===== */

export function listarRegras(orgId) {
  return db.prepare("SELECT * FROM acesso_regras WHERE org_id=? ORDER BY atualizado_em DESC").all(orgId).map(formatar);
}

function limparFerramentas(f) {
  // Nulo ou vazio = "padrão da função" (a tela só manda a tabela quando o gestor liga "Personalizar").
  if (!f || typeof f !== "object" || !Object.keys(f).length) return null;
  const out = {};
  for (const t of FERRAMENTAS) {
    const v = f[t.id];
    const a = {}; for (const ac of t.acoes) a[ac] = !!(v && v[ac]);
    out[t.id] = a;
  }
  return out;
}

export function salvarRegra(orgId, b, quemSalvou) {
  const alvo_tipo = b.alvo_tipo === "nivel" ? "nivel" : b.alvo_tipo === "pessoa" ? "pessoa" : null;
  if (!alvo_tipo) return { erro: "Escolha uma pessoa ou um grupo." };
  const alvo_id = String(b.alvo_id || "");
  if (alvo_tipo === "pessoa" && !db.prepare("SELECT 1 FROM users WHERE id=? AND org_id=? AND COALESCE(master,0)=0").get(alvo_id, orgId))
    return { erro: "Pessoa não encontrada.", status: 404 };
  if (alvo_tipo === "nivel" && !db.prepare("SELECT 1 FROM estrutura_niveis WHERE id=? AND org_id=?").get(alvo_id, orgId))
    return { erro: "Nível não encontrado.", status: 404 };
  const quem = alvo_tipo === "pessoa" ? "todos" : (QUEM.includes(b.quem) ? b.quem : "todos");
  const escopo = b.escopo == null || b.escopo === "" ? null : (ESCOPOS.includes(b.escopo) ? b.escopo : undefined);
  if (escopo === undefined) return { erro: "Escopo inválido." };
  const niveis = new Set(niveisDaConta(orgId).map(n => n.id));
  const equipes = escopo === "equipe" ? [...new Set((Array.isArray(b.equipes) ? b.equipes : []).map(String))].filter(id => niveis.has(id)) : [];
  const ferramentas = limparFerramentas(b.ferramentas);
  const existe = db.prepare("SELECT id FROM acesso_regras WHERE org_id=? AND alvo_tipo=? AND alvo_id=? AND quem=?").get(orgId, alvo_tipo, alvo_id, quem);
  if (existe) db.prepare("UPDATE acesso_regras SET escopo=?, equipes_json=?, ferramentas_json=?, atualizado_por=?, atualizado_em=? WHERE id=?")
    .run(escopo, JSON.stringify(equipes), ferramentas ? JSON.stringify(ferramentas) : null, quemSalvou || null, Date.now(), existe.id);
  else db.prepare("INSERT INTO acesso_regras (id,org_id,alvo_tipo,alvo_id,quem,escopo,equipes_json,ferramentas_json,atualizado_por,atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("acr_" + randomUUID(), orgId, alvo_tipo, alvo_id, quem, escopo, JSON.stringify(equipes), ferramentas ? JSON.stringify(ferramentas) : null, quemSalvou || null, Date.now());
  limparCache();
  return { ok: true, regras: listarRegras(orgId) };
}

export function apagarRegra(orgId, id) {
  const r = db.prepare("DELETE FROM acesso_regras WHERE id=? AND org_id=?").run(id, orgId);
  limparCache();
  return r.changes ? { ok: true, regras: listarRegras(orgId) } : { erro: "Regra não encontrada.", status: 404 };
}

/* ===== A TABELA DE FERRAMENTAS VALENDO (entrega B, 28/11/2026) =====

   Sem tabela salva na regra, vale o papel, como sempre. Com tabela salva,
   ela é a verdade para aquela pessoa: o que está desmarcado é recusado (403),
   e o que está marcado e o papel não daria passa pelas travas `roles(...)`
   (o gestor deu de propósito). O que não está na tabela (WhatsApp, repasse,
   push, hub) continua só com o papel.

   PADRAO é o que cada função faz hoje — é ele que a tela mostra marcado quando
   ainda não há tabela, para salvar sem tirar nada sem querer. */
const tudo = () => Object.fromEntries(FERRAMENTAS.map(f => [f.id, Object.fromEntries(f.acoes.map(a => [a, true]))]));
export function padraoFerramentas(role) {
  if (role === "adm") return tudo();
  const m = (o) => Object.fromEntries(FERRAMENTAS.map(f => [f.id, Object.fromEntries(f.acoes.map(a => [a, !!(o[f.id] || []).includes(a)]))]));
  if (role === "sdr") return m({ painel: ["consultar"], relatorios: ["consultar"], funil: ["consultar", "criar", "editar"],
    catracas: ["consultar"], imoveis: ["consultar", "criar", "editar"], plantao: ["consultar", "editar"], equipe: ["consultar"],
    configuracoes: ["consultar", "editar"] });
  return m({ painel: ["consultar"], relatorios: ["consultar"], funil: ["consultar", "criar", "editar"],
    imoveis: ["consultar", "criar", "editar"], plantao: ["consultar"] });
}

/* De qual ferramenta e ação é este pedido; null = a tabela não decide. */
export function ferramentaDaRota(metodo, caminho) {
  const M = String(metodo || "GET").toUpperCase(), c = String(caminho || "").split("?")[0].replace(/\/+$/, "") || "/";
  const porMetodo = (exato) => M === "GET" ? "consultar" : M === "DELETE" ? "excluir" : (M === "POST" && exato) ? "criar" : "editar";
  const pre = (p) => c === p || c.startsWith(p + "/");
  if (pre("/leads/lote") || pre("/leads/import")) return { id: "base", acao: M === "GET" ? "consultar" : "editar" };
  if (c === "/leads/export") return { id: "base", acao: "exportar" };
  if (c === "/leads") return { id: "funil", acao: M === "POST" ? "criar" : "consultar" };
  if (/^\/leads\/[^/]+$/.test(c) && M === "DELETE") return { id: "funil", acao: "excluir" };
  if (/^\/leads\/[^/]+\/(lgpd\/anonimizar|pessoal)$/.test(c) && M === "POST") return { id: "funil", acao: "excluir" };
  if (pre("/leads") || pre("/tarefas")) return { id: "funil", acao: M === "GET" ? "consultar" : "editar" };
  if (pre("/painel")) return M === "GET" ? { id: "painel", acao: "consultar" } : null;
  if (pre("/reports")) return M === "GET" ? { id: "relatorios", acao: "consultar" } : null;
  if (pre("/distribution/catracas")) return { id: "catracas", acao: porMetodo(c === "/distribution/catracas") };
  if (pre("/produtos")) return { id: "imoveis", acao: porMetodo(c === "/produtos") };
  if (pre("/site")) return { id: "cetrolab", acao: M === "GET" ? "consultar" : "editar" };
  if (pre("/plantoes")) return { id: "plantao", acao: porMetodo(true) };
  if (pre("/marketing") || pre("/redes")) return { id: "marketing", acao: porMetodo(true) };
  if (pre("/auth/users")) return { id: "equipe", acao: porMetodo(c === "/auth/users") };
  if (pre("/estrutura") && c !== "/estrutura/meu-alcance") return { id: "equipe", acao: M === "GET" ? "consultar" : "editar" };
  // Configurações: só a escrita é conferida — a leitura alimenta telas do dia a dia (mensagens prontas, selo do WhatsApp, etapas).
  if ((pre("/config") || pre("/pipelines") || pre("/tags") || pre("/portais") || pre("/anuncios-meta")) && M !== "GET")
    return { id: "configuracoes", acao: "editar" };
  return null;
}

/* A tabela de quem pergunta, ou null (vale o papel). Usa o cache do alcance. */
export function ferramentasDe(user) {
  if (!user || !user.id) return null;
  alcanceDe(user);
  const c = CACHE.get(user.id);
  return c && c.valor ? c.valor.ferramentas || null : null;
}

/* { permitido, liberado, nome } — liberado = passa por cima do papel. */
export function conferirFerramenta(user, metodo, caminho) {
  const f = ferramentaDaRota(metodo, caminho);
  if (!f) return { permitido: true, liberado: false };
  const tab = ferramentasDe(user);
  if (!tab) return { permitido: true, liberado: false };
  const ok = !!(tab[f.id] && tab[f.id][f.acao]);
  const nome = (FERRAMENTAS.find(x => x.id === f.id) || {}).nome || f.id;
  return { permitido: ok, liberado: ok, nome, acao: f.acao };
}
