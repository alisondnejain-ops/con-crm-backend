/* O MESMO CELULAR EM DUAS FORMAS NÃO VIRA DOIS LEADS. (02/11/2026, print do
   Ali: o Fabian, argentino, apareceu duas vezes na conta da VJ.)

   O WhatsApp registra uns celulares com o dígito a mais (54 9 … na Argentina,
   52 1 … no México, o nono dígito no Brasil) e outros sem. O envio já tentava
   a outra forma quando o WhatsApp recusava; a chegada procurava o lead só pela
   forma exata. O cliente recebia pela forma alternativa, respondia por ela, e
   nascia um segundo lead. Aqui: a mensagem, o formulário/portal, o cadastro na
   mão, a planilha e a correção do telefone acham o lead nas duas formas.

   Rodar:  npm run teste:numero-duas-formas
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formasDoTelefone } from "../src/services/telefone.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-numero-duas-formas.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

console.log("1. As formas de cada número");
assert.deepEqual(formasDoTelefone("5491122223333"), ["5491122223333", "541122223333"]);
assert.deepEqual(formasDoTelefone("541122223333"), ["541122223333", "5491122223333"]);
assert.deepEqual(formasDoTelefone("5215512345678"), ["5215512345678", "525512345678"]);
assert.deepEqual(formasDoTelefone("5587996695813"), ["5587996695813", "558796695813"]);
assert.deepEqual(formasDoTelefone("12025550123"), ["12025550123"]);   // sem outra forma
assert.deepEqual(formasDoTelefone(""), []);
console.log("   ok");

const PORTA = 4799;
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
const C = await import("../src/services/canais.js");
const { receberLead } = await import("../src/services/portais.js");
const { leadPorTelefone } = await import("../src/services/telefone.js");
const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host='https://casa.uazapi.com', uazapi_token='token-da-casa' WHERE id=?").run(org);
C.garantirCasa(org);

const tAli = (await (await fetch(url("/auth/login"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "ali@teste.com", password: "123456" }) })).json()).token;
const pedir = (metodo, p, corpo) => fetch(url(p), {
  method: metodo, headers: { "Content-Type": "application/json", authorization: "Bearer " + tAli },
  body: corpo ? JSON.stringify(corpo) : undefined });
const chega = async (numero, texto, id) => {
  await fetch(url("/webhooks/uazapi"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "token-da-casa", event: "messages",
      message: { chatid: `${numero}@s.whatsapp.net`, text: texto, senderName: "Cliente", messageid: id } }) });
  await new Promise(r => setTimeout(r, 500));
};
const leadsCom = (...f) => db.prepare(`SELECT id, phone FROM leads WHERE org_id=? AND phone IN (${f.map(() => "?").join(",")})`).all(org, ...f);
const msgs = (leadId) => db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id=? AND direction='in'").get(leadId).n;

console.log("2. Lead cadastrado SEM o 9 argentino; o cliente responde COM o 9");
let r = await pedir("POST", "/leads", { nome: "Fabian", telefone: "+54 11 2222 3333", assigned_to: "fila" });
assert.equal(r.status, 201, "cadastro: " + r.status);
const fabian = db.prepare("SELECT id, phone FROM leads WHERE org_id=? AND name='Fabian'").get(org);
assert.equal(fabian.phone, "541122223333");
await chega("5491122223333", "Hola, me interesa", "wa_dois_1");
let todos = leadsCom("541122223333", "5491122223333");
assert.equal(todos.length, 1, "nasceu um segundo lead para o Fabian");
assert.equal(msgs(fabian.id), 1, "a resposta não caiu no lead que já existia");
console.log("   um lead só, com a resposta dentro");

console.log("3. O contrário: lead COM o 9 e o cliente responde SEM");
r = await pedir("POST", "/leads", { nome: "Lucía", telefone: "+54 9 11 4444 5555", assigned_to: "fila" });
assert.equal(r.status, 201);
const lucia = db.prepare("SELECT id FROM leads WHERE org_id=? AND name='Lucía'").get(org);
await chega("541144445555", "¿Sigue disponible?", "wa_dois_2");
assert.equal(leadsCom("5491144445555", "541144445555").length, 1);
assert.equal(msgs(lucia.id), 1);
console.log("   ok");

console.log("4. México: 52 1 … e 52 …");
r = await pedir("POST", "/leads", { nome: "Diego", telefone: "+52 55 1234 5678", assigned_to: "fila" });
assert.equal(r.status, 201);
const diego = db.prepare("SELECT id FROM leads WHERE org_id=? AND name='Diego'").get(org);
await chega("5215512345678", "Hola", "wa_dois_3");
assert.equal(leadsCom("525512345678", "5215512345678").length, 1);
assert.equal(msgs(diego.id), 1);
console.log("   ok");

console.log("5. Brasileiro sem o nono dígito continua caindo no lead certo");
r = await pedir("POST", "/leads", { nome: "Joana", telefone: "(87) 9 9111-2222", assigned_to: "fila" });
assert.equal(r.status, 201);
const joana = db.prepare("SELECT id FROM leads WHERE org_id=? AND name='Joana'").get(org);
await chega("558791112222", "Oi", "wa_dois_4");
assert.equal(leadsCom("5587991112222", "558791112222").length, 1);
assert.equal(msgs(joana.id), 1);
console.log("   ok");

console.log("6. Formulário/portal com a outra forma completa o lead que existe");
const res = receberLead(org, { portal: "meta", externo: "meta-fabian-1", nome: "Fabian Esteban", telefone: "5491122223333" });
assert.ok(res.ok, JSON.stringify(res));
assert.equal(leadsCom("541122223333", "5491122223333").length, 1, "o formulário criou outro lead");
console.log("   ok");

console.log("7. Cadastro na mão com a outra forma é recusado, dizendo qual lead já existe");
r = await pedir("POST", "/leads", { nome: "Fabian de novo", telefone: "+54 9 11 2222 3333", assigned_to: "fila" });
let d = await r.json();
assert.equal(r.status, 409, "deixou cadastrar a mesma pessoa de novo: " + r.status);
assert.equal(d.lead_id, fabian.id);
console.log("   ok");

console.log("8. Planilha com a outra forma fica de fora como 'já cadastrado'");
r = await pedir("POST", "/leads/import", { linhas: [{ nome: "Lucía planilha", telefone: "+54 11 4444 5555" }], previa: true });
d = await r.json();
assert.equal(d.criados, 0, JSON.stringify(d));
console.log("   ok");

console.log("9. Corrigir o telefone de outro lead para a outra forma do Fabian é recusado");
r = await pedir("PATCH", `/leads/${diego.id}/telefone`, { telefone: "+54 9 11 2222 3333" });
assert.equal(r.status, 409, "deixou dois leads com a mesma pessoa: " + r.status);
// E corrigir o PRÓPRIO lead para a outra forma continua permitido.
r = await pedir("PATCH", `/leads/${fabian.id}/telefone`, { telefone: "+54 9 11 2222 3333" });
assert.equal(r.status, 200, "não deixou corrigir o próprio número: " + r.status);
console.log("   ok");

console.log("10. Duplicado de antes da correção: vale a forma EXATA");
/* Duas cópias já existentes (uma em cada forma) — a mensagem não pode pular
   de uma para a outra. */
const agora = Date.now();
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES ('dup-a',?,'Cópia A','543511112222','Lead',?)").run(org, agora - 1000);
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES ('dup-b',?,'Cópia B','5493511112222','Lead',?)").run(org, agora);
assert.equal(leadPorTelefone(db, org, "543511112222").id, "dup-a");
assert.equal(leadPorTelefone(db, org, "5493511112222").id, "dup-b");
console.log("   ok");

console.log("\nTudo certo ✅");
fim(0);
