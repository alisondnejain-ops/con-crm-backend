/* O WHATSAPP PESSOAL DO ANTIGO DONO SAI DO LEAD NO REPASSE. (05/11/2026,
   pedido do Fernando, opção b do Ali.)

   Repassado o lead, a conversa volta para o número da imobiliária; o que o
   antigo dono e o cliente conversarem pelo celular dele não entra mais no
   lead; quando o cliente escreve ali, quem está com o lead é avisado, sem o
   texto. Voltando para o antigo dono, a linha dele volta a valer.

   Rodar:  npm run teste:linha-solta
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-linha-solta.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4806;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "T-1",
         ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456", UAZAPI_AUTOCONFIGURAR: "0", PUSH_REGISTRAR: "1" },
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
const { trocarResponsavel } = await import("../src/services/movimento.js");
const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host='https://casa.uazapi.com', uazapi_token='token-da-casa' WHERE id=?").run(org);
C.garantirCasa(org);
const novo = (id, nome) => db.prepare(`INSERT INTO users
  (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`)
  .run(id, org, nome, id + "@t.com", Date.now());
novo("u_marina", "Marina Lopes");
novo("u_rafael", "Rafael Souza");
const linha = C.criarCanalDoCorretor(org, "u_marina").canal;
C.salvarConexao(linha.id, { host: "https://marina.uazapi.com", token: "token-da-marina" });
db.prepare("UPDATE canais SET triagem = 0 WHERE id = ?").run(linha.id);

let lidos = 0;
const chamados = () => { const linhas = saida.split("\n").filter(l => l.includes("[push-teste]"));
  const novos = linhas.slice(lidos); lidos = linhas.length;
  return novos.map(l => l.split("[push-teste] ")[1]); };
const chega = async (token, texto, id, fromMe = false) => {
  await fetch(url("/webhooks/uazapi"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, event: "messages",
      message: { chatid: "5587991112222@s.whatsapp.net", text: texto, senderName: "Cliente", messageid: id, fromMe } }) });
  await new Promise(r => setTimeout(r, 500));
};
const lead = () => db.prepare("SELECT * FROM leads WHERE phone = '5587991112222'").get();
const temMsg = (texto) => !!db.prepare("SELECT 1 FROM messages WHERE lead_id = ? AND body = ?").get(lead().id, texto);

console.log("1. O cliente escreve no WhatsApp da Marina: o lead nasce dela, na linha dela");
await chega("token-da-marina", "Oi Marina, tudo bem?", "m1");
assert.equal(lead().assigned_to, "u_marina");
assert.equal(lead().canal_id, linha.id);
chamados();

console.log("2. Repassado para o Rafael: a conversa volta para o número da imobiliária");
trocarResponsavel(lead().id, "u_rafael", null, "mao");
assert.equal(lead().assigned_to, "u_rafael");
assert.equal(lead().canal_id, null, "a conversa devia sair da linha da Marina");
assert.ok(temMsg("Oi Marina, tudo bem?"), "o histórico gravado continua");

console.log("3. A Marina escreve ao cliente pelo celular dela: não entra no lead");
await chega("token-da-marina", "Oi, sou eu de novo, me chama aqui", "m2", true);
assert.ok(!temMsg("Oi, sou eu de novo, me chama aqui"));
assert.equal(lead().canal_id, null, "a conversa não pode voltar para a linha dela");

console.log("4. O cliente responde à Marina: não entra no lead, e o Rafael é avisado sem o texto");
await chega("token-da-marina", "Pode me mandar o endereço?", "m3");
assert.ok(!temMsg("Pode me mandar o endereço?"));
let c = chamados();
assert.equal(c.length, 1, "um aviso só");
assert.ok(c[0].startsWith("u_rafael | ") && c[0].includes("WhatsApp de Marina"), c[0]);
assert.ok(!c[0].includes("endereço"), "o aviso não leva o texto");

console.log("5. Mais mensagens seguidas no número antigo não tocam o celular de novo");
await chega("token-da-marina", "Oi?", "m4");
assert.deepEqual(chamados(), []);

console.log("6. O cliente escreve no número da imobiliária: entra normal e avisa o Rafael");
await chega("token-da-casa", "Oi, mudei para este número", "m5");
assert.ok(temMsg("Oi, mudei para este número"));
assert.equal(lead().canal_id, null);
c = chamados();
assert.ok(c.some(x => x.startsWith("u_rafael | ")));

console.log("7. O lead volta para a Marina: a linha dela volta a valer");
trocarResponsavel(lead().id, "u_marina", null, "mao");
await chega("token-da-marina", "Voltei a falar com você", "m6");
assert.ok(temMsg("Voltei a falar com você"));
assert.equal(lead().canal_id, linha.id);

console.log("8. Devolver à fila também solta a linha do antigo dono");
trocarResponsavel(lead().id, null, null, "mao");
assert.equal(lead().canal_id, null);
await chega("token-da-marina", "Alguém aí?", "m7", true);
assert.ok(!temMsg("Alguém aí?"));

console.log("\nOK — linha pessoal do antigo dono solta no repasse.");
fim(0);
