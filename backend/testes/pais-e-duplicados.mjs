/* PAÍS PADRÃO DA CONTA E AVISO DE POSSÍVEL DUPLICADO (02/11/2026, pedido do
   Ali depois do Fabian, argentino, na VJ).

   1. O número que chega SEM o código do país era lido sempre como brasileiro.
      Agora a conta escolhe o país (Configurações → Atendimento) e ele vale no
      formulário/portal, no cadastro, na planilha e nas listas. Conta que não
      escolheu continua exatamente como antes.
   2. A ficha avisa quando outro lead parece ser a mesma pessoa, com o atalho
      para ele e o "não é a mesma pessoa".

   Rodar:  npm run teste:pais-e-duplicados
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { normalizarPeloPadrao } from "../src/services/telefone.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-pais-e-duplicados.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

console.log("1. A regra do país padrão, sozinha");
// Brasil: a regra de sempre.
assert.equal(normalizarPeloPadrao("(87) 9 9111-2222", "BR"), "5587991112222");
assert.equal(normalizarPeloPadrao("11 2222-3333", "BR"), "5511922223333");
// Argentina: o número nacional ganha o 54 9.
assert.equal(normalizarPeloPadrao("11 2222-3333", "AR"), "5491122223333");
// O brasileiro escrito inteiro sem "+" continua brasileiro (não vira 54 55…).
assert.equal(normalizarPeloPadrao("5587991112222", "AR"), "5587991112222");
assert.equal(normalizarPeloPadrao("558791112222", "AR"), "5587991112222");
// Com "+", vale como veio.
assert.equal(normalizarPeloPadrao("+351 912 345 678", "AR"), "351912345678");
// Portugal: o número nacional de 9 dígitos.
assert.equal(normalizarPeloPadrao("912 345 678", "PT"), "351912345678");
console.log("   ok");

const PORTA = 4794;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "T-1",
         ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456", UAZAPI_AUTOCONFIGURAR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (c) => { servidor.kill("SIGTERM"); process.exit(c); };
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1500)); fim(1); });
process.on("unhandledRejection", e => { console.error("\n" + (e && e.message)); console.error(saida.slice(-1500)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
const { default: db } = await import("../src/db.js");
const { receberLead, lerLead } = await import("../src/services/portais.js");
const bcrypt = (await import("bcryptjs")).default;
const org = db.prepare("SELECT id FROM orgs WHERE adm_code = 'T-1'").get().id;

const senha = bcrypt.hashSync("123456", 8);
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@teste.com", senha, role, Date.now());
  return id; };
const marina = pessoa("Marina", "corretor");
const rafael = pessoa("Rafael", "corretor");
const entrar = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tG = await entrar("ali@teste.com"), tM = await entrar("marina@teste.com");
const pedir = async (t, metodo, p, corpo) => { const r = await fetch(url(p), { method: metodo,
  headers: { "Content-Type": "application/json", authorization: "Bearer " + t }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const foneDoLead = (id) => db.prepare("SELECT phone FROM leads WHERE id = ?").get(id).phone;

console.log("2. Conta que não escolheu: Brasil, como sempre");
let r = await pedir(tG, "GET", "/distribution/pais");
assert.equal(r.d.pais, "BR");
let out = receberLead(org, lerLead({ name: "Paulo", phone: "11 2222-3333" }, "zap"));
assert.ok(out.ok, JSON.stringify(out));
assert.equal(foneDoLead(out.lead_id), "5511922223333");
console.log("   ok");

console.log("3. Só o gestor escolhe o país; país inventado é recusado");
r = await pedir(tM, "PATCH", "/distribution/pais", { pais: "AR" });
assert.equal(r.status, 403);
r = await pedir(tG, "PATCH", "/distribution/pais", { pais: "ZZ" });
assert.equal(r.status, 400);
r = await pedir(tG, "PATCH", "/distribution/pais", { pais: "AR" });
assert.equal(r.status, 200);
assert.equal(r.d.pais, "AR");
r = await pedir(tG, "GET", "/auth/me");
assert.equal(r.d.org.pais_padrao, "AR", "a sessão não trouxe o país da conta");
console.log("   ok");

console.log("4. Na conta argentina, o portal e o formulário leem pela Argentina");
out = receberLead(org, lerLead({ name: "Fabian", phone: "11 4444-5555" }, "zap"));
assert.equal(foneDoLead(out.lead_id), "5491144445555");
out = receberLead(org, lerLead({ field_data: [
  { name: "full_name", values: ["Lucía"] }, { name: "phone_number", values: ["351 666-7777"] }] }, "meta"));
assert.ok(out.ok, JSON.stringify(out));
assert.equal(foneDoLead(out.lead_id), "5493516667777");
// O brasileiro inteiro sem "+" continua brasileiro.
out = receberLead(org, lerLead({ name: "Joana", phone: "5587991113333" }, "zap"));
assert.equal(foneDoLead(out.lead_id), "5587991113333");
console.log("   ok");

console.log("5. Cadastro na mão: sem país escolhido vale o da conta; escolhido, vale o escolhido");
r = await pedir(tG, "POST", "/leads", { nome: "Diego", telefone: "11 5555-6666", assigned_to: "fila" });
assert.equal(r.status, 201, JSON.stringify(r.d));
assert.equal(db.prepare("SELECT phone FROM leads WHERE name='Diego'").get().phone, "5491155556666");
r = await pedir(tG, "POST", "/leads", { nome: "Ana", telefone: "(87) 9 9222-3333", pais: "BR", assigned_to: "fila" });
assert.equal(r.status, 201);
assert.equal(db.prepare("SELECT phone FROM leads WHERE name='Ana'").get().phone, "5587992223333");
console.log("   ok");

console.log("6. Planilha sem país escolhido lê pela conta");
r = await pedir(tG, "POST", "/leads/import", { linhas: [{ nome: "Sofía planilha", telefone: "11 7777-8888" }] });
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.equal(db.prepare("SELECT phone FROM leads WHERE name='Sofía planilha'").get().phone, "5491177778888");
console.log("   ok");

console.log("7. Voltar para Brasil apaga a escolha");
r = await pedir(tG, "PATCH", "/distribution/pais", { pais: "BR" });
assert.equal(r.d.pais, "BR");
assert.equal(db.prepare("SELECT pais_padrao FROM orgs WHERE id = ?").get(org).pais_padrao, null);
console.log("   ok");

const lead = (nome, phone, dono = null, email = null) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,email,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,?,'{}','Lead',?,?)`)
    .run(id, org, nome, phone, email, Date.now(), dono);
  return id; };

console.log("8. A outra forma do mesmo celular aparece como possível duplicado");
const fa = lead("Esteban Ruiz", "541133334444"), fb = lead("Esteban", "5491133334444");
r = await pedir(tG, "GET", `/leads/${fa}/duplicados`);
assert.equal(r.status, 200);
assert.deepEqual(r.d.itens.map(x => [x.id, x.motivo]), [[fb, "forma"]]);
console.log("   ok");

console.log("9. O mesmo número com o código errado (o 55 do estrangeiro lido como brasileiro)");
const ua = lead("Ana Smith", "5512025550123"), ub = lead("Ana S.", "12025550123");
r = await pedir(tG, "GET", `/leads/${ub}/duplicados`);
assert.deepEqual(r.d.itens.map(x => [x.id, x.motivo]), [[ua, "final"]]);
console.log("   ok");

console.log("10. Mesmo e-mail, e mesmo nome completo — mas um nome só não basta");
const ea = lead("Carlos A", "5587990001111", null, "carlos@ex.com"), eb = lead("Carlinhos", "5587990002222", null, "CARLOS@ex.com");
r = await pedir(tG, "GET", `/leads/${ea}/duplicados`);
assert.deepEqual(r.d.itens.map(x => [x.id, x.motivo]), [[eb, "email"]]);
const na = lead("Maria Clara Souza", "5587990003333"), nb = lead("maria clara souza", "5587990004444");
r = await pedir(tG, "GET", `/leads/${na}/duplicados`);
assert.deepEqual(r.d.itens.map(x => [x.id, x.motivo]), [[nb, "nome"]]);
const ma = lead("Maria", "5587990005555"); lead("Maria", "5587990006666");
r = await pedir(tG, "GET", `/leads/${ma}/duplicados`);
assert.equal(r.d.itens.length, 0, "um primeiro nome sozinho virou aviso");
console.log("   ok");

console.log("11. O corretor só vê o lead dele; o do colega vira contagem, sem nome nem número");
const ca = lead("Roberto Lima", "5587990007777", marina), cb = lead("Roberto Lima", "5587990008888", rafael);
r = await pedir(tM, "GET", `/leads/${ca}/duplicados`);
assert.equal(r.status, 200);
assert.equal(r.d.itens.length, 0);
assert.equal(r.d.outros, 1);
assert.ok(!JSON.stringify(r.d).includes("5587990008888"));
r = await pedir(tM, "GET", `/leads/${cb}/duplicados`);
assert.equal(r.status, 403, "o corretor leu os duplicados do lead de um colega");
r = await pedir(tM, "POST", `/leads/${ca}/duplicados/${cb}/nao-e`);
assert.equal(r.status, 404, "o corretor marcou um lead que não vê");
console.log("   ok");

console.log("12. \"Não é a mesma pessoa\" cala o aviso daquele par, nos dois lados");
r = await pedir(tG, "POST", `/leads/${na}/duplicados/${nb}/nao-e`);
assert.equal(r.status, 200);
assert.equal(r.d.itens.length, 0);
r = await pedir(tG, "GET", `/leads/${nb}/duplicados`);
assert.equal(r.d.itens.length, 0, "o aviso voltou do outro lado");
console.log("   ok");

console.log("\nTudo certo ✅");
fim(0);
