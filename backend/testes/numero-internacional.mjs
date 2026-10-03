/* NÚMEROS DE OUTROS PAÍSES. (03/10/2026, pedido do Ali: "acabamos de
   implementar um cliente que vende para estrangeiros, e o número do lead é
   lido automaticamente como brasileiro")

   Duas partes. A primeira confere a regra do número sozinha — é ela que
   decide se um celular americano vira um número de São José dos Campos. A
   segunda sobe o servidor e confere os caminhos por onde o número entra: o
   WhatsApp, o cadastro na mão, a correção na ficha e a planilha.

   E o que NÃO pode mudar: todo número brasileiro continua saindo exatamente
   como saía. Conversa antiga casa com lead antigo pelo número gravado — mudar
   a regra brasileira partiria essas conversas em duas.

   Rodar:  npm run teste:numero-internacional
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizePhone, validarTelefone, paisDoNumero } from "../src/services/telefone.js";
import { PAISES } from "../src/services/paises.js";
/* `uazapi.js` abre o banco ao ser importado: ele só entra depois de o
   DB_PATH do teste estar definido (abaixo), senão abriria o banco de verdade. */
const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-numero-internacional.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";
const { numeroAlternativo } = await import("../src/services/uazapi.js");

console.log("===== A REGRA DO NÚMERO =====");

console.log("1. Número brasileiro sai exatamente como saía antes");
/* A regra antiga, copiada aqui para comparar: qualquer diferença entre as
   duas num número brasileiro é uma conversa que deixaria de casar. */
const antiga = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) return d;
  if (d.length === 11) return "55" + d;
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
};
for (const n of ["(87) 9 9111-2222", "87991112222", "8799112222", "5587991112222", "558799112222",
                 "+55 87 99111-2222", "55 (87) 99111-2222", "123", ""])
  assert.equal(normalizePhone(n), antiga(n), `mudou: ${n}`);
console.log("   9 formatos brasileiros, iguais à regra antiga");

console.log("2. O número do WhatsApp já traz o país e não ganha 55");
// O caso que estragava: 11 dígitos americanos viravam um número de SP.
assert.equal(normalizePhone("12025550123", { comCodigo: true }), "12025550123");
assert.equal(antiga("12025550123"), "5512025550123");   // o defeito, para registro
assert.equal(normalizePhone("5491123456789", { comCodigo: true }), "5491123456789");
assert.equal(normalizePhone("351912345678", { comCodigo: true }), "351912345678");
// O brasileiro sem o nono dígito continua ganhando o 9, como sempre.
assert.equal(normalizePhone("558799112222", { comCodigo: true }), "5587999112222");
console.log("   EUA, Argentina e Portugal intactos; brasileiro ganha o 9 como antes");

console.log("3. Escrito com + ou 00 vale como veio, seja qual for o país escolhido");
assert.equal(normalizePhone("+1 (202) 555-0123"), "12025550123");
assert.equal(normalizePhone("+351 912 345 678", { pais: "AR" }), "351912345678");
assert.equal(normalizePhone("00 351 912 345 678"), "351912345678");
console.log("   +1, +351 e 00351 ok");

console.log("4. País escolhido + número nacional: o código entra e o zero de longa distância sai");
assert.equal(normalizePhone("(202) 555-0123", { pais: "US" }), "12025550123");
assert.equal(normalizePhone("912 345 678", { pais: "PT" }), "351912345678");
assert.equal(normalizePhone("07911 123456", { pais: "GB" }), "447911123456");
assert.equal(normalizePhone("06 1234 5678", { pais: "IT" }), "390612345678");   // na Itália o zero fica
// Argentina: celular no WhatsApp é 54 9 + área + número.
assert.equal(normalizePhone("11 2345-6789", { pais: "AR" }), "5491123456789");
assert.equal(normalizePhone("011 2345-6789", { pais: "AR" }), "5491123456789");
console.log("   EUA, Portugal, Reino Unido, Itália (com o zero) e Argentina (com o 9)");

console.log("5. Quem escolheu o país e digitou o código junto não ganha o código duas vezes");
assert.equal(normalizePhone("1 202 555 0123", { pais: "US" }), "12025550123");
assert.equal(normalizePhone("54 9 11 2345 6789", { pais: "AR" }), "5491123456789");
assert.equal(normalizePhone("351 912 345 678", { pais: "PT" }), "351912345678");
console.log("   ok");

console.log("6. A conferência separa número completo de número faltando dígito");
assert.equal(validarTelefone("5587991112222"), null);
assert.match(validarTelefone("55879911"), /DDD/);
assert.equal(validarTelefone("12025550123"), null);
assert.equal(validarTelefone("351912345678"), null);
assert.match(validarTelefone("3519123456"), /Portugal/);           // faltam 2 dígitos
assert.match(validarTelefone("999998888"), /incompleto/);          // brasileiro sem DDD
assert.equal(validarTelefone("2125551234567"), null);              // código fora da lista, comprido o bastante
assert.match(validarTelefone("123"), /incompleto/);
console.log("   ok");

console.log("7. A lista de países não tem código nem sigla repetidos");
/* Dois países com o mesmo código fariam a tela adivinhar a bandeira; duas
   siglas iguais fariam o seletor escolher um e gravar o outro. */
assert.equal(new Set(PAISES.map(p => p.ddi)).size, PAISES.length);
assert.equal(new Set(PAISES.map(p => p.iso)).size, PAISES.length);
assert.equal(paisDoNumero("351912345678").iso, "PT");    // o código mais longo ganha
assert.equal(paisDoNumero("5491123456789").iso, "AR");
console.log(`   ${PAISES.length} países`);

console.log("8. O envio tenta a outra forma também na Argentina e no México");
assert.equal(numeroAlternativo("5491123456789"), "541123456789");
assert.equal(numeroAlternativo("541123456789"), "5491123456789");
assert.equal(numeroAlternativo("5215512345678"), "525512345678");
assert.equal(numeroAlternativo("12025550123"), null);
console.log("   ok");

/* ===== PELO SERVIDOR ===== */

const PORTA = 4797;
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
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1200)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
console.log("\nServidor no ar, igual à produção.\n");

const { default: db } = await import("../src/db.js");
const C = await import("../src/services/canais.js");
const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host='https://casa.uazapi.com', uazapi_token='token-da-casa' WHERE id=?").run(org);
C.garantirCasa(org);

const tAli = (await (await fetch(url("/auth/login"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "ali@teste.com", password: "123456" }) })).json()).token;
/* O Ali do teste é o master, que não fica dono de lead: os cadastros vão
   para a fila, e o que se confere aqui é só o número. */
const pedir = (metodo, p, corpo) => fetch(url(p), {
  method: metodo, headers: { "Content-Type": "application/json", authorization: "Bearer " + tAli },
  body: corpo ? JSON.stringify(corpo) : undefined });

console.log("===== POR ONDE O NÚMERO ENTRA =====");

console.log("9. Cliente americano escreve no WhatsApp: o lead nasce com o número dele");
await fetch(url("/webhooks/uazapi"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "token-da-casa", event: "messages",
    message: { chatid: "12025550123@s.whatsapp.net", text: "Hi, I saw the beach house [int9]", senderName: "John",
      messageid: "wa_int9" } }) });
await new Promise(r => setTimeout(r, 500));
const john = db.prepare("SELECT phone FROM leads WHERE org_id=? AND name='John'").get(org);
console.log(`   gravado: ${john && john.phone}`);
assert.equal(john.phone, "12025550123");
assert.ok(!db.prepare("SELECT 1 FROM leads WHERE phone='5512025550123'").get(), "virou número brasileiro");

console.log("10. Cadastro na mão com o país escolhido");
let r = await pedir("POST", "/leads", { nome: "Lucía Gómez", telefone: "11 2345-6789", pais: "AR", assigned_to: "fila" });
let d = await r.json();
console.log(`   ${r.status} · ${d.phone || JSON.stringify(d)}`);
assert.equal(r.status, 201);
assert.equal(d.phone, "5491123456789");

console.log("11. Número estrangeiro faltando dígito é recusado dizendo o país");
r = await pedir("POST", "/leads", { nome: "Pedro", telefone: "912 345", pais: "PT", assigned_to: "fila" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
assert.match(d.error, /Portugal/);

console.log("12. O mesmo cliente digitado de outro jeito é reconhecido como repetido");
r = await pedir("POST", "/leads", { nome: "Lucía de novo", telefone: "+54 9 11 2345 6789", assigned_to: "fila" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);

console.log("13. País desconhecido é recusado (não vira Brasil em silêncio)");
r = await pedir("POST", "/leads", { nome: "X", telefone: "912345678", pais: "ZZ", assigned_to: "fila" });
assert.equal(r.status, 400);
console.log("   400");

console.log("14. Cadastro brasileiro continua igual, sem escolher país");
r = await pedir("POST", "/leads", { nome: "João", telefone: "(87) 9 9111-2222", assigned_to: "fila" });
d = await r.json();
assert.equal(r.status, 201);
assert.equal(d.phone, "5587991112222");
console.log(`   ${d.phone}`);

console.log("15. A correção na ficha troca para um número de outro país");
r = await pedir("PATCH", `/leads/${d.id}/telefone`, { telefone: "912 345 678", pais: "PT" });
const corrigido = await r.json();
console.log(`   ${r.status} · ${corrigido.telefone}`);
assert.equal(r.status, 200);
assert.equal(corrigido.telefone, "351912345678");

console.log("16. A planilha: país dos números sem código, e o número com + vale como veio");
const linhas = [
  { nome: "Ana", telefone: "(305) 555-0199" },        // EUA, sem código
  { nome: "Marco", telefone: "+39 06 1234 5678" },    // Itália, com +
  { nome: "Curto", telefone: "555-01" },               // incompleto
];
r = await pedir("POST", "/leads/import", { linhas, pais: "US", previa: true });
d = await r.json();
console.log(`   prévia: ${d.criados} entram, ${d.ignorados} ficam de fora`);
assert.equal(d.criados, 2);
assert.equal(d.ignorados, 1);
r = await pedir("POST", "/leads/import", { linhas, pais: "US", rotulo: "Clientes de fora" });
d = await r.json();
assert.equal(d.criados, 2);
const ana = db.prepare("SELECT phone FROM leads WHERE org_id=? AND name='Ana'").get(org);
const marco = db.prepare("SELECT phone FROM leads WHERE org_id=? AND name='Marco'").get(org);
console.log(`   Ana ${ana.phone} · Marco ${marco.phone}`);
assert.equal(ana.phone, "13055550199");
assert.equal(marco.phone, "390612345678");

console.log("17. Sem escolher país, a planilha continua lendo como brasileiro");
r = await pedir("POST", "/leads/import", { linhas: [{ nome: "Bia", telefone: "87 99333-4444" }], previa: true });
d = await r.json();
assert.equal(d.criados, 1);
console.log("   ok");

console.log("\nTudo certo ✅");
fim(0);
