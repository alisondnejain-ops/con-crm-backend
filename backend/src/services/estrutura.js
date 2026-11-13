/* A ESTRUTURA DA EQUIPE (CETRO 23.1/23.2). Começa VAZIA: a operação cria só os
   níveis que tem (uma gerência e corretores; diretoria, gerência e corretores;
   várias diretorias…). Cada nível tem nome, tipo opcional e pai opcional.
   Mover um nível para dentro de si mesmo ou de um descendente é recusado
   (ciclo). Apagar só nível sem filhos; quem estava nele fica sem nível. O nível
   NÃO dá permissão nenhuma: é agrupamento e filtro. */
import { randomUUID } from "node:crypto";
import db from "../db.js";

export const TIPOS = ["diretoria", "gerencia", "subgerencia", "equipe", "outro"];

export function listar(orgId) {
  const niveis = db.prepare("SELECT id, nome, tipo, pai_id, ordem FROM estrutura_niveis WHERE org_id=? ORDER BY ordem, created_at").all(orgId);
  const pessoas = db.prepare(`SELECT id, name, role, nivel_id, participa_indicadores FROM users WHERE org_id=? AND status='ativo' AND COALESCE(master,0)=0 ORDER BY name`).all(orgId);
  return { niveis: niveis.map(n => ({ ...n, membros: pessoas.filter(p => p.nivel_id === n.id).map(p => p.id) })), pessoas, tipos: TIPOS };
}

function descendentes(orgId, id) {
  const todos = db.prepare("SELECT id, pai_id FROM estrutura_niveis WHERE org_id=?").all(orgId);
  const out = new Set(); const fila = [id];
  while (fila.length) { const x = fila.shift(); for (const n of todos) if (n.pai_id === x && !out.has(n.id)) { out.add(n.id); fila.push(n.id); } }
  return out;
}
/* As pessoas de um nível e de todos os níveis abaixo dele. */
export function pessoasDoNivel(orgId, id) {
  const ids = [id, ...descendentes(orgId, id)];
  return db.prepare(`SELECT id FROM users WHERE org_id=? AND status='ativo' AND nivel_id IN (${ids.map(() => "?").join(",")})`).all(orgId, ...ids).map(r => r.id);
}

function conferir(orgId, b, id = null) {
  const nome = String(b.nome || "").trim().slice(0, 60);
  if (!nome) return { erro: "Dê um nome ao nível (ex.: Gerência Petrolina)." };
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : null;
  let pai = b.pai_id ? String(b.pai_id) : null;
  if (pai) {
    if (!db.prepare("SELECT 1 FROM estrutura_niveis WHERE id=? AND org_id=?").get(pai, orgId)) return { erro: "Nível de cima não encontrado." };
    if (id && (pai === id || descendentes(orgId, id).has(pai))) return { erro: "Um nível não pode ficar dentro dele mesmo nem de um nível abaixo dele." };
  }
  return { nome, tipo, pai };
}

export function criar(orgId, b) {
  const c = conferir(orgId, b); if (c.erro) return c;
  if (db.prepare("SELECT COUNT(*) n FROM estrutura_niveis WHERE org_id=?").get(orgId).n >= 200) return { erro: "Limite de 200 níveis." };
  const id = "niv_" + randomUUID();
  db.prepare("INSERT INTO estrutura_niveis (id,org_id,nome,tipo,pai_id,ordem,created_at) VALUES (?,?,?,?,?,?,?)").run(id, orgId, c.nome, c.tipo, c.pai, Date.now(), Date.now());
  return { ok: true, id, ...listar(orgId) };
}
export function editar(orgId, id, b) {
  if (!db.prepare("SELECT 1 FROM estrutura_niveis WHERE id=? AND org_id=?").get(id, orgId)) return { erro: "Nível não encontrado.", status: 404 };
  const c = conferir(orgId, b, id); if (c.erro) return c;
  db.prepare("UPDATE estrutura_niveis SET nome=?, tipo=?, pai_id=? WHERE id=?").run(c.nome, c.tipo, c.pai, id);
  return { ok: true, ...listar(orgId) };
}
export function apagar(orgId, id) {
  if (!db.prepare("SELECT 1 FROM estrutura_niveis WHERE id=? AND org_id=?").get(id, orgId)) return { erro: "Nível não encontrado.", status: 404 };
  if (db.prepare("SELECT 1 FROM estrutura_niveis WHERE pai_id=?").get(id)) return { erro: "Este nível tem níveis abaixo dele. Mova ou apague esses primeiro." };
  db.transaction(() => {
    db.prepare("UPDATE users SET nivel_id=NULL WHERE org_id=? AND nivel_id=?").run(orgId, id);
    db.prepare("DELETE FROM estrutura_niveis WHERE id=?").run(id);
  })();
  return { ok: true, ...listar(orgId) };
}
export function ajustarPessoa(orgId, userId, b) {
  const u = db.prepare("SELECT id FROM users WHERE id=? AND org_id=? AND COALESCE(master,0)=0").get(userId, orgId);
  if (!u) return { erro: "Pessoa não encontrada.", status: 404 };
  if ("nivel_id" in b) {
    const n = b.nivel_id ? String(b.nivel_id) : null;
    if (n && !db.prepare("SELECT 1 FROM estrutura_niveis WHERE id=? AND org_id=?").get(n, orgId)) return { erro: "Nível não encontrado." };
    db.prepare("UPDATE users SET nivel_id=? WHERE id=?").run(n, userId);
  }
  if ("participa_indicadores" in b) {
    const v = b.participa_indicadores === null || b.participa_indicadores === "" ? null : (b.participa_indicadores ? 1 : 0);
    db.prepare("UPDATE users SET participa_indicadores=? WHERE id=?").run(v, userId);
  }
  return { ok: true, ...listar(orgId) };
}
