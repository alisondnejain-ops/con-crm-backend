/* O WHATSAPP DE QUEM USA O CRM PODE SER DE OUTRO PAÍS. (02/11/2026, pedido do
   Ali: uma corretora argentina da VJ não conseguia cadastrar o próprio número.)

   As páginas de cadastro tinham a máscara brasileira, que cortava em 11
   dígitos, e o servidor só aceitava número começando com 55. Agora o cadastro
   de corretor/atendente/gestor, a criação de imobiliária, a porta do site e
   Minha conta aceitam o país escolhido — a mesma regra do telefone do lead.
   E o número brasileiro continua saindo exatamente como saía.

   Rodar:  npm run teste:telefone-equipe
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-telefone-equipe.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4793;
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
const post = (p, corpo, token, metodo = "POST") => fetch(url(p), {
  method: metodo, headers: { "Content-Type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
  body: JSON.stringify(corpo) });
const foneDe = (email) => db.prepare("SELECT phone FROM users WHERE email = ?").get(email)?.phone;

console.log("1. A lista de países é pública e vem do servidor");
let r = await fetch(url("/publico/paises"));
assert.equal(r.status, 200);
let d = await r.json();
assert.ok(d.paises.find(p => p.iso === "AR" && p.ddi === "54"));
assert.ok(d.paises.find(p => p.iso === "BR"));
console.log(`   ${d.paises.length} países`);

console.log("2. Corretora argentina se cadastra com o número dela");
r = await post("/auth/register", { name: "Lucía Fernández", email: "lucia@vj.com", phone: "11 2222-3333", pais: "AR", adm_code: "T-1" });
d = await r.json();
assert.ok(r.ok, JSON.stringify(d));
assert.equal(foneDe("lucia@vj.com"), "5491122223333", "o 9 do celular argentino não entrou");
console.log("   gravado: 5491122223333");

console.log("3. Com o + na frente, sem escolher país, também vale");
r = await post("/auth/register", { name: "Diego Pérez", email: "diego@vj.com", phone: "+54 9 351 444-5555", adm_code: "T-1", funcao: "atendente" });
assert.ok(r.ok);
assert.equal(foneDe("diego@vj.com"), "5493514445555");
console.log("   ok");

console.log("4. O brasileiro continua igual");
r = await post("/auth/register", { name: "Marina Alves", email: "marina@vj.com", phone: "(87) 9 9111-2222", adm_code: "T-1" });
assert.ok(r.ok);
assert.equal(foneDe("marina@vj.com"), "5587991112222");
console.log("   ok");

console.log("5. Número curto demais é recusado");
r = await post("/auth/register", { name: "Curto", email: "curto@vj.com", phone: "1122", pais: "AR", adm_code: "T-1" });
d = await r.json();
assert.equal(r.status, 400);
assert.match(d.error, /incompleto|Argentina/i);
r = await post("/auth/register", { name: "Curto BR", email: "curtobr@vj.com", phone: "9111-2222", adm_code: "T-1" });
d = await r.json();
assert.equal(r.status, 400);
assert.match(d.error, /DDD/);
console.log("   ok");

console.log("6. País inventado é recusado, em vez de virar Brasil em silêncio");
r = await post("/auth/register", { name: "X", email: "x@vj.com", phone: "1122223333", pais: "ZZ", adm_code: "T-1" });
assert.equal(r.status, 400);
console.log("   ok");

console.log("7. Gestor de imobiliária nova, com WhatsApp de Portugal");
r = await post("/auth/criar-imobiliaria", { imobiliaria: "Casa Lisboa", name: "João Silva", email: "joao@lisboa.pt", phone: "912 345 678", pais: "PT" });
d = await r.json();
assert.ok(r.status === 200 || r.status === 201, JSON.stringify(d));
assert.equal(foneDe("joao@lisboa.pt"), "351912345678");
console.log("   ok");

console.log("8. A porta do site aceita número de fora");
r = await post("/publico/comecar", { nome: "Ana Smith", email: "ana@us.com", telefone: "202 555 0123", pais: "US" });
d = await r.json();
assert.ok(r.ok, JSON.stringify(d));
assert.equal(foneDe("ana@us.com"), "12025550123", "o número americano virou brasileiro");
console.log("   ok");

console.log("9. Minha conta: trocar para um número argentino, e trocar só o nome sem mexer no número");
const tAli = (await (await post("/auth/login", { email: "ali@teste.com", password: "123456" })).json()).token;
db.prepare("UPDATE users SET phone = '87' WHERE email = 'ali@teste.com'").run();   // número velho e inválido
r = await post("/auth/me", { name: "Ali Nejain" }, tAli, "PATCH");
assert.equal(r.status, 200, "trocar só o nome foi barrado pelo número antigo");
r = await post("/auth/me", { name: "Ali Nejain", phone: "87", pais: "BR" }, tAli, "PATCH");
assert.equal(r.status, 200, "mandar o mesmo número de volta foi barrado");
r = await post("/auth/me", { name: "Ali Nejain", phone: "11 6666-7777", pais: "AR" }, tAli, "PATCH");
d = await r.json();
assert.equal(r.status, 200, JSON.stringify(d));
assert.equal(foneDe("ali@teste.com"), "5491166667777");
r = await post("/auth/me", { name: "Ali Nejain", phone: "123", pais: "BR" }, d.token, "PATCH");
assert.equal(r.status, 400);
assert.equal(foneDe("ali@teste.com"), "5491166667777", "o número recusado foi gravado");
console.log("   ok");

console.log("\nTudo certo ✅");
fim(0);
