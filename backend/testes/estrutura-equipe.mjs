/* ESTRUTURA DA EQUIPE E PARTICIPAÇÃO NOS INDICADORES (CETRO 23, 13/11/2026).
   Rodar:  npm run teste:estrutura-equipe */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-estrutura.db");
process.env.JWT_SECRET = "teste"; process.env.PORT = "4669";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4669";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (n) => { const id = "org_" + randomUUID().slice(0, 8); db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, n, "E-" + id, Date.now()); return id; };
const org = novaOrg("Imob E"), outra = novaOrg("Outra");
const novo = (o, nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, o, nome, email, senha, role, Date.now()); return id; };
const ges = novo(org, "Diretora", "g@e.com", "adm"); const ana = novo(org, "Ana", "a@e.com", "corretor"); novo(outra, "X", "x@e.com", "adm");
const login = async (e) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "123456" }) })).json()).token;
const cli = (t) => (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const G = cli(await login("g@e.com")), A = cli(await login("a@e.com")), X = cli(await login("x@e.com"));
let falhas = 0;
const caso = async (n, f) => { try { await f(); console.log("  ✓ " + n); } catch (e) { falhas++; console.log("  ✗ " + n + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } };
let r, dir, ger;
await caso("1. Começa vazia; corretor não lê; só o gestor cria", async () => {
  r = await G("/estrutura"); assert.equal(r.status, 200); assert.equal(r.body.niveis.length, 0);
  r = await A("/estrutura"); assert.equal(r.status, 403);
  r = await A("/estrutura/niveis", { method: "POST", body: { nome: "X" } }); assert.equal(r.status, 403);
});
await caso("2. Cria diretoria e gerência dentro; ciclo é recusado", async () => {
  r = await G("/estrutura/niveis", { method: "POST", body: { nome: "Diretoria Comercial", tipo: "diretoria" } }); dir = r.body.id;
  r = await G("/estrutura/niveis", { method: "POST", body: { nome: "Gerência Petrolina", tipo: "gerencia", pai_id: dir } }); ger = r.body.id;
  assert.equal(r.body.niveis.length, 2);
  r = await G(`/estrutura/niveis/${dir}`, { method: "PATCH", body: { nome: "Diretoria Comercial", pai_id: ger } }); assert.equal(r.status, 400); assert.match(r.body.error, /dentro dele/);
});
await caso("3. Pessoa no nível; apagar com filho é recusado; outra conta não vê", async () => {
  r = await G(`/estrutura/pessoas/${ana}`, { method: "PATCH", body: { nivel_id: ger } }); assert.equal(r.status, 200);
  assert.deepEqual(r.body.niveis.find(n => n.id === ger).membros, [ana]);
  r = await G(`/estrutura/niveis/${dir}`, { method: "DELETE" }); assert.equal(r.status, 400);
  r = await X(`/estrutura/niveis/${dir}`, { method: "DELETE" }); assert.equal(r.status, 404);
  r = await X(`/estrutura/pessoas/${ana}`, { method: "PATCH", body: { nivel_id: null } }); assert.equal(r.status, 404);
});
await caso("4. Participação: a diretora que produz entra no Score; o corretor marcado fora sai", async () => {
  r = await G("/reports/score?periodo=este_mes"); assert.ok(!r.body.equipe.some(m => m.id === ges)); assert.ok(r.body.equipe.some(m => m.id === ana));
  await G(`/estrutura/pessoas/${ges}`, { method: "PATCH", body: { participa_indicadores: true } });
  await G(`/estrutura/pessoas/${ana}`, { method: "PATCH", body: { participa_indicadores: false } });
  r = await G("/reports/score?periodo=este_mes"); assert.ok(r.body.equipe.some(m => m.id === ges)); assert.ok(!r.body.equipe.some(m => m.id === ana));
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nOK — estrutura da equipe.");
process.exit(falhas ? 1 : 0);
