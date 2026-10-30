/* VALOR EM NEGOCIAÇÃO (30/10/2026, lista do Fernando: "VGV em aberto por etapa").

   1. Quem pode abrir a conversa grava; outro corretor não.
   2. Aceita como o brasileiro escreve ("R$ 350.000", "1.250.000,50"); vazio apaga;
      lixo é recusado.
   3. Vem na lista de leads (é o que soma nas colunas do Funil).
   4. NÃO é venda: não mexe em sale_value.

   Rodar:  npm run teste:valor-negociacao */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-valor-negociacao.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4653";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { sign } = await import("../src/auth.js");
await new Promise(r => setTimeout(r, 700));
const org = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get().id;
const user = (id, nome, role) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, id + "@vn.com", role, Date.now());
user("u_m", "Marina", "corretor"); user("u_r", "Rafael", "corretor"); user("u_g", "Gestora", "adm");
const lead = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Atendimento',?,?)`)
  .run(lead, org, "Cliente", "5587991230000", Date.now(), "u_m");
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch("http://localhost:4653" + p, { method: metodo, headers: { authorization: "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(quem)), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let r = await api("u_r", "PATCH", `/leads/${lead}/negociacao`, { valor: "100000" });
assert.equal(r.status, 403, "outro corretor não grava");
r = await api("u_m", "PATCH", `/leads/${lead}/negociacao`, { valor: "R$ 350.000" });
assert.equal(r.status, 200); assert.equal(r.body.valor_negociacao, 350000);
r = await api("u_g", "PATCH", `/leads/${lead}/negociacao`, { valor: "1.250.000,50" });
assert.equal(r.body.valor_negociacao, 1250000.5, "a gestão também grava");
r = await api("u_m", "PATCH", `/leads/${lead}/negociacao`, { valor: "abc" });
assert.equal(r.status, 400);
const lista = (await api("u_m", "GET", "/leads")).body;
assert.equal(lista.find(l => l.id === lead).valor_negociacao, 1250000.5, "vem na lista");
assert.equal(db.prepare("SELECT sale_value FROM leads WHERE id=?").get(lead).sale_value, null, "não é venda");
r = await api("u_m", "PATCH", `/leads/${lead}/negociacao`, { valor: "" });
assert.equal(r.body.valor_negociacao, null, "vazio apaga");
console.log("Valor em negociação: tudo certo ✅");
process.exit(0);
