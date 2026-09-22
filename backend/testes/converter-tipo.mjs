/* MIGRAR O TIPO DA CONTA — imobiliária ⇄ autônomo (22/09/2026, pedido do Ali).

   Um cliente se cadastrou como imobiliária sendo, na prática, um corretor
   autônomo sozinho. Faltava um jeito de o master corrigir isso sem apagar a
   conta e recomeçar — e sem deixar a casa num estado misto (tipo trocado,
   papel de quem manda na conta esquecido, ou os dois divergindo).

   Este teste tranca:
   - só o master mexe nisso;
   - imobiliária → autônomo exige escolher o titular, e recusa se a equipe
     for grande demais para caber no plano (mesma régua da porta de cadastro);
   - o titular vira `corretor` e ganha `dono_user_id`; ao converter de volta,
     ele recupera `adm`;
   - o crachá do titular é derrubado na hora — ele estava numa tela pensada
     para o papel antigo.

   Rodar:  npm run teste:converter-tipo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-converter-tipo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4629";
process.env.SITE_URL = "https://www.conhubcrm.com.br";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4629";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

const hub = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(hub, "Casa do Master", "MST-1", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,'Ali','ali@hub.com',?,'adm',1,?,'ativo',1)`).run("u_" + randomUUID(), hub, senha, Date.now());

async function entrar(email, pass = "123456") {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: pass }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });
const novoUser = (orgId, nome, email, role) => {
  const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, orgId, nome, email, senha, role, Date.now());
  return id;
};

const tAli = await entrar("ali@hub.com");

console.log("1. Imobiliária com equipe grande demais para autônomo — recusa e diz o motivo");
const grande = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(grande, "Imobiliária Grande Demais", "GRD-1", Date.now());
const gestor1 = novoUser(grande, "Gestor Um", "g1@grande-demais.com", "adm");
novoUser(grande, "Gestor Dois", "g2@grande-demais.com", "adm");
novoUser(grande, "Corretor Extra", "c1@grande-demais.com", "corretor");
novoUser(grande, "Atendente Um", "a1@grande-demais.com", "sdr");
novoUser(grande, "Atendente Dois", "a2@grande-demais.com", "sdr");

let r = await chamar(tAli, `/orgs/${grande}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "autonomo", dono_user_id: gestor1 }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.match(d.error, /gestor|corretor|atendente/);

console.log("2. A imobiliária certinha (dono + 1 corretor + 1 atendente) — o cenário real do relato");
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Enganada", "ENG-1", Date.now());
const dono = novoUser(org, "Marcos Corretor", "marcos@enganada.com", "adm");
const tMarcos = await entrar("marcos@enganada.com");

console.log("3. Sem escolher o titular, recusa");
r = await chamar(tAli, `/orgs/${org}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "autonomo" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);

console.log("4. Titular de OUTRA conta é recusado — não vaza entre imobiliárias");
r = await chamar(tAli, `/orgs/${org}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "autonomo", dono_user_id: gestor1 }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);

console.log("5. Só o master converte — o próprio dono não pode");
r = await chamar(tMarcos, `/orgs/${org}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "autonomo", dono_user_id: dono }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("6. O master converte de verdade");
r = await chamar(tAli, `/orgs/${org}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "autonomo", dono_user_id: dono }) });
d = await r.json();
console.log(`   ${r.status} · tipo agora: ${d.org.tipo}`);
assert.equal(r.status, 200);
assert.equal(d.org.tipo, "autonomo");
const linha = db.prepare("SELECT tipo, dono_user_id FROM orgs WHERE id = ?").get(org);
const marcos = db.prepare("SELECT role, available FROM users WHERE id = ?").get(dono);
console.log(`   orgs.dono_user_id = ${linha.dono_user_id === dono} · role do Marcos = ${marcos.role} · available = ${marcos.available}`);
assert.equal(linha.dono_user_id, dono);
assert.equal(marcos.role, "corretor");
assert.equal(marcos.available, 1);

console.log("7. O crachá antigo do Marcos morreu — ele estava numa tela pensada pro papel de gestor");
r = await chamar(tMarcos, "/leads");
console.log(`   ${r.status}`);
assert.equal(r.status, 401, "o token emitido antes da conversão precisa cair");

console.log("8. Logado de novo, ele já é o dono autônomo — entra em rotas de gestor por ser dono");
const tMarcos2 = await entrar("marcos@enganada.com");
r = await chamar(tMarcos2, "/config/conexao");
console.log(`   ${r.status}`);
assert.equal(r.status, 200, "ehDonoAutonomo libera rota de adm para o dono");

console.log("9. Converter para o mesmo tipo de novo é recusado, com a razão");
r = await chamar(tAli, `/orgs/${org}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "autonomo", dono_user_id: dono }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);

console.log("10. Convertendo de volta para imobiliária, o Marcos vira gestor de novo");
r = await chamar(tAli, `/orgs/${org}/tipo`, { method: "POST", body: JSON.stringify({ tipo: "imobiliaria" }) });
d = await r.json();
console.log(`   ${r.status} · tipo agora: ${d.org.tipo}`);
assert.equal(r.status, 200);
assert.equal(d.org.tipo, "imobiliaria");
const marcos2 = db.prepare("SELECT role FROM users WHERE id = ?").get(dono);
console.log(`   role do Marcos = ${marcos2.role}`);
assert.equal(marcos2.role, "adm");

console.log("11. E o crachá autônomo dele também morreu na volta");
r = await chamar(tMarcos2, "/leads");
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("\nTudo certo ✅");
process.exit(0);
