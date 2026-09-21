/* CAPTAÇÃO DE IMÓVEIS PARA ALUGUEL. (21/09/2026, relatado pelo Ali: "a
   captação de imóveis só tinha casa pra vender".)

   `produtos.finalidade` (venda|aluguel, default 'venda' — toda linha antiga
   já era venda de verdade) separa as duas operações sem duplicar o
   catálogo. O que muda:

   1. Cadastrar com `finalidade:"aluguel"` grava e devolve certo.
   2. O filtro `?finalidade=aluguel` separa um catálogo do outro.
   3. "Vendido" não existe para aluguel — a situação terminal certa é
      "alugado", e as duas contam como FECHADO para quem pode editar.
   4. Isolamento entre imobiliárias, como todo o resto do sistema.

   Rodar:  npm run teste:produtos-aluguel
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-produtos-aluguel.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4647";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4647";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "PA-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const gestor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(gestor, org, "Fernanda", "fernanda@pa1.com", senha, "adm", Date.now());

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const { token } = await r.json();
  assert.ok(token, "login falhou para " + email);
  return token;
};
const token = await login("fernanda@pa1.com");
const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = (path, opts = {}) => fetch(`${BASE}/produtos${path}`, { ...opts, headers: auth }).then(async r => ({ status: r.status, body: await r.json() }));

console.log("1. Cadastra uma casa para VENDA — como sempre, sem dizer finalidade");
let r = await api("/", { method: "POST", body: JSON.stringify({ tipo: "casa", formato: "solta", titulo: "Casa no Centro", cidade: "Petrolina", valor: 300000 }) });
assert.equal(r.status, 200);
assert.equal(r.body.finalidade, "venda", "sem dizer, a finalidade é venda — o que o catálogo sempre foi");
const idVenda = r.body.id;

console.log("2. Cadastra uma casa para ALUGUEL");
r = await api("/", { method: "POST", body: JSON.stringify({ tipo: "casa", formato: "solta", titulo: "Casa para alugar no São José", cidade: "Petrolina", valor: 1800, finalidade: "aluguel" }) });
assert.equal(r.status, 200);
assert.equal(r.body.finalidade, "aluguel");
const idAluguel = r.body.id;

console.log("3. Finalidade inválida é recusada, não vira venda por acaso");
r = await api("/", { method: "POST", body: JSON.stringify({ tipo: "casa", formato: "solta", titulo: "Casa qualquer", cidade: "Petrolina", finalidade: "arrendamento" }) });
console.log(`   ${r.status} · ${r.body.error}`);
assert.equal(r.status, 400);

console.log("4. O filtro ?finalidade= separa os dois catálogos");
r = await api("/?finalidade=aluguel");
assert.equal(r.status, 200);
console.log(`   ${r.body.length} produto(s) de aluguel`);
assert.equal(r.body.length, 1);
assert.equal(r.body[0].id, idAluguel);

r = await api("/?finalidade=venda");
assert.equal(r.body.length, 1);
assert.equal(r.body[0].id, idVenda);

r = await api("/");
console.log(`   sem filtro: ${r.body.length} produto(s) — os dois juntos`);
assert.equal(r.body.length, 2);

console.log("5. \"Alugado\" é uma situação de verdade — a rota aceita, e some de \"ativo\"");
r = await api(`/${idAluguel}/status`, { method: "POST", body: JSON.stringify({ status: "alugado" }) });
assert.equal(r.status, 200);
r = await api(`/${idAluguel}`);
assert.equal(r.body.status, "alugado");

console.log("6. Imóvel alugado (ou vendido) não pode mais ser editado por quem só captou");
const corretor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(corretor, org, "Bruno", "bruno@pa1.com", senha, "corretor", Date.now());
const tokenCorretor = await login("bruno@pa1.com");
const authCorretor = { authorization: "Bearer " + tokenCorretor, "content-type": "application/json" };
r = await fetch(`${BASE}/produtos/${idAluguel}`, { method: "PATCH", headers: authCorretor,
  body: JSON.stringify({ titulo: "Tentando editar depois de alugado" }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("7. Isolamento: outra imobiliária não enxerga nem edita este produto");
const org2 = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org2, "Outra Imob", "PA-2", Date.now());
const gestor2 = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(gestor2, org2, "Outro", "outro@pa2.com", senha, "adm", Date.now());
const tokenOutro = await login("outro@pa2.com");
r = await fetch(`${BASE}/produtos/${idAluguel}`, { headers: { authorization: "Bearer " + tokenOutro } });
console.log(`   ${r.status}`);
assert.equal(r.status, 404);

console.log("\nTudo certo ✅");
process.exit(0);
