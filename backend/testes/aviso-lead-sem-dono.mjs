/* LEAD SEM DONO TAMBÉM AVISA ALGUÉM. (05/11/2026, relato do Ali: "a galera
   da VJ não tá recebendo notificação".)

   O aviso no celular só ia para quem está com o lead. Com nenhuma atendente
   ativa, o lead novo fica na fila, sem dono — e ninguém era chamado. Agora:
   as atendentes ativas; sem nenhuma, atendentes e gestores ativos. O master
   e quem está fora da equipe nunca entram. Lead com dono continua avisando
   só o dono.

   Rodar:  npm run teste:aviso-lead-sem-dono
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-aviso-sem-dono.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4803;
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
const { receberLead } = await import("../src/services/portais.js");
const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host='https://casa.uazapi.com', uazapi_token='token-da-casa' WHERE id=?").run(org);
C.garantirCasa(org);
const novo = (id, nome, papel, ativa, extra = {}) => db.prepare(`INSERT INTO users
  (id,org_id,name,email,pass_hash,role,available,created_at,status,master) VALUES (?,?,?,?,'x',?,?,?,?,?)`)
  .run(id, org, nome, id + "@t.com", papel, ativa ? 1 : 0, Date.now(), extra.status || "ativo", extra.master ? 1 : 0);
novo("u_vanessa", "Vanessa", "sdr", false);
novo("u_luiza", "Luiza", "sdr", false);
novo("u_marina", "Marina", "corretor", true);
novo("u_saiu", "Saiu", "sdr", false, { status: "removido" });
novo("u_master", "Master", "adm", false, { master: true });
novo("u_gestora", "Gestora", "adm", false);
// A conta do .env (ali@teste.com) nasce como master neste servidor: fica de fora também.
const ali = "u_gestora";

let lidos = 0;
const chamados = () => { const linhas = saida.split("\n").filter(l => l.includes("[push-teste]"));
  const novos = linhas.slice(lidos); lidos = linhas.length;
  return novos.map(l => l.split("[push-teste] ")[1].split(" | ")[0]).sort(); };
const chega = async (numero, texto, id) => {
  await fetch(url("/webhooks/uazapi"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "token-da-casa", event: "messages",
      message: { chatid: `${numero}@s.whatsapp.net`, text: texto, senderName: "Cliente", messageid: id } }) });
  await new Promise(r => setTimeout(r, 600));
};
chamados();

console.log("1. Nenhuma atendente ativa: o lead fica na fila e avisa atendentes e gestores ativos");
await chega("5587991110001", "Oi, quero saber do imóvel", "m1");
const l1 = db.prepare("SELECT id, assigned_to FROM leads WHERE phone='5587991110001'").get();
assert.ok(l1 && !l1.assigned_to, "o lead devia ficar na fila");
let c = chamados();
console.log("   avisados:", c.join(", "));
assert.deepEqual(c, [ali, "u_luiza", "u_vanessa"].sort(), "atendentes e gestor ativos, sem master, sem quem saiu, sem corretor");

console.log("2. O cliente da fila responde de novo: avisa os mesmos");
await chega("5587991110001", "Alguém?", "m2");
assert.deepEqual(chamados(), [ali, "u_luiza", "u_vanessa"].sort());

console.log("3. Com uma atendente ativa, o lead novo vai para ela, e só ela é avisada");
db.prepare("UPDATE users SET available=1 WHERE id='u_vanessa'").run();
await chega("5587991110002", "Boa tarde", "m3");
const l2 = db.prepare("SELECT assigned_to FROM leads WHERE phone='5587991110002'").get();
assert.equal(l2.assigned_to, "u_vanessa");
assert.deepEqual(chamados(), ["u_vanessa"]);

console.log("4. Lead da fila com uma atendente ativa: só as atendentes ativas são avisadas");
await chega("5587991110001", "Ainda estou aqui", "m4");
assert.deepEqual(chamados(), ["u_vanessa"], "a fila é das atendentes ativas");

console.log("5. Lead com dono continua avisando só o dono");
db.prepare("UPDATE leads SET assigned_to='u_marina' WHERE id=?").run(l1.id);
await chega("5587991110001", "Oi Marina", "m5");
assert.deepEqual(chamados(), ["u_marina"]);

console.log("5b. Lead da fila com a IA conversando: a resposta seguinte não chama ninguém");
const l3 = db.prepare("SELECT id FROM leads WHERE phone='5587991110002'").get();
db.prepare("UPDATE leads SET assigned_to=NULL, robo_msgs=2, robo_parado=0 WHERE id=?").run(l3.id);
await chega("5587991110002", "Pode me mandar fotos?", "m6");
assert.deepEqual(chamados(), [], "a IA está atendendo: ninguém é acordado");
db.prepare("UPDATE leads SET robo_parado=1 WHERE id=?").run(l3.id);
await chega("5587991110002", "Oi?", "m7");
assert.deepEqual(chamados(), ["u_vanessa"], "a IA saiu: volta a avisar a fila");

console.log("6. Formulário/portal sem atendente ativa: avisa quem cuida da fila");
db.prepare("UPDATE users SET available=0 WHERE id='u_vanessa'").run();
const r = await receberLead(org, { portal: "zap", nome: "Paulo", telefone: "5587991110003", mensagem: "Quero visitar" });
assert.equal(r.ok, true);
assert.ok(!db.prepare("SELECT assigned_to FROM leads WHERE id=?").get(r.lead_id).assigned_to);
await new Promise(x => setTimeout(x, 300));
// receberLead roda NESTE processo (não no servidor): confere a regra direto.
const { quemCuidaDaFila } = await import("../src/services/push.js");
assert.deepEqual(quemCuidaDaFila(org).sort(), [ali, "u_luiza", "u_vanessa"].sort());

console.log("\nTudo certo ✅");
fim(0);
