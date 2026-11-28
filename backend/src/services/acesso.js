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
    if (tipo === "operacao") valor = { tipo, ids: null, fila: true, explicito: !!(regra && regra.escopo) };
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
      valor = { tipo, ids, fila: u.role === "sdr", explicito: !!(regra && regra.escopo) };
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
  if (!f || typeof f !== "object") return null;
  const out = {};
  for (const t of FERRAMENTAS) {
    const v = f[t.id]; if (!v || typeof v !== "object") continue;
    const a = {}; for (const ac of t.acoes) if (ac in v) a[ac] = !!v[ac];
    if (Object.keys(a).length) out[t.id] = a;
  }
  return Object.keys(out).length ? out : null;
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
