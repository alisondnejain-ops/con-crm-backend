/* PASSAR OS LEADS DE UMA PESSOA PARA OUTRA (02/11/2026, pedido do Fernando
   pelo Ali). Base de leads → Arrumar a base, só gestor.

   Confere: só o gestor usa; a prévia conta certo (em aberto, finalizados e os
   que ficam por ter venda); a venda NÃO muda de dono; o finalizado só vai se
   pedir; o repasse fica no histórico com motivo "lote"; e a penalidade de
   "leads perdidos para outro corretor" não pega quem perdeu.

   Rodar:  npm run teste:passar-leads
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-passar-leads.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4796;
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
const bcrypt = (await import("bcryptjs")).default;
const org = db.prepare("SELECT id FROM orgs WHERE adm_code = 'T-1'").get().id;
const gestor = db.prepare("SELECT id FROM users WHERE email = 'ali@teste.com'").get().id;

const senha = bcrypt.hashSync("123456", 8);
const pessoa = (nome, role, o = org) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, o, nome, nome.toLowerCase() + "@teste.com", senha, role, Date.now());
  return id; };
const fernando = pessoa("Fernando", "corretor");
const marina = pessoa("Marina", "corretor");
const outraOrg = "org_" + randomUUID();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(outraOrg, "Outra", "T-2", Date.now());
const deFora = pessoa("Estranho", "corretor", outraOrg);

const entrar = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tG = await entrar("ali@teste.com"), tM = await entrar("marina@teste.com");
const pedir = async (t, metodo, p, corpo) => { const r = await fetch(url(p), { method: metodo,
  headers: { "Content-Type": "application/json", authorization: "Bearer " + t }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };

let n = 0;
const lead = (extra = {}) => { const id = "l_" + randomUUID(); n++;
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at,sale_date,sale_value,closed_at,anonimizado_em)
    VALUES (?,?,?,?,'{}','Atendimento',?,?,?,?,?,?,?)`).run(id, org, "Cliente " + n, "55879910000" + String(n).padStart(2, "0"),
    Date.now() - 86400000, fernando, Date.now() - 86400000, extra.venda ? Date.now() - 3600000 : null,
    extra.venda ? 300000 : null, extra.finalizado ? Date.now() - 3600000 : null, extra.anonimo ? Date.now() : null);
  return id; };
const abertos = [lead(), lead(), lead()];
const vendido = lead({ venda: true });
const finalizado = lead({ finalizado: true });
const anonimo = lead({ anonimo: true });
const dono = (id) => db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(id).assigned_to;

console.log("1. Só o gestor usa");
let r = await pedir(tM, "GET", `/leads/lote/passar?de=${fernando}&para=${marina}`);
assert.equal(r.status, 403);
r = await pedir(tM, "POST", "/leads/lote/passar", { de: fernando, para: marina });
assert.equal(r.status, 403);
assert.equal(dono(abertos[0]), fernando, "o corretor passou leads");
console.log("   ok");

console.log("2. Destino inválido é recusado");
r = await pedir(tG, "GET", `/leads/lote/passar?de=${fernando}&para=${fernando}`);
assert.equal(r.status, 400);
r = await pedir(tG, "GET", `/leads/lote/passar?de=${fernando}&para=${deFora}`);
assert.equal(r.status, 400, "aceitou passar para alguém de outra imobiliária");
console.log("   ok");

console.log("3. A prévia conta certo");
r = await pedir(tG, "GET", `/leads/lote/passar?de=${fernando}&para=${marina}`);
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.deepEqual([r.d.vao, r.d.abertos, r.d.finalizados, r.d.fechados], [3, 3, 1, 1]);
r = await pedir(tG, "GET", `/leads/lote/passar?de=${fernando}&para=${marina}&finalizados=1`);
assert.equal(r.d.vao, 4);
console.log("   ok");

console.log("4. Passa os em aberto; venda, finalizado e anonimizado ficam");
r = await pedir(tG, "POST", "/leads/lote/passar", { de: fernando, para: marina });
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.equal(r.d.passados, 3);
for (const id of abertos) assert.equal(dono(id), marina);
assert.equal(dono(vendido), fernando, "a venda mudou de dono");
assert.equal(dono(finalizado), fernando, "o finalizado foi sem pedir");
assert.equal(dono(anonimo), fernando);
const tr = db.prepare("SELECT trigger_reason, from_user_id, to_user_id, triggered_by_user_id FROM lead_transfers WHERE lead_id = ?").get(abertos[0]);
assert.deepEqual([tr.trigger_reason, tr.from_user_id, tr.to_user_id, tr.triggered_by_user_id], ["lote", fernando, marina, gestor]);
assert.ok(db.prepare("SELECT assigned_at FROM leads WHERE id = ?").get(abertos[0]).assigned_at > Date.now() - 60000,
  "o lead não ganhou a hora de chegada (selo 'novo com você')");
console.log("   ok");

console.log("5. Com 'finalizados' marcado, o finalizado vai também");
r = await pedir(tG, "POST", "/leads/lote/passar", { de: fernando, para: marina, incluir_finalizados: true });
assert.equal(r.d.passados, 1);
assert.equal(dono(finalizado), marina);
assert.equal(dono(vendido), fernando);
console.log("   ok");

console.log("6. O repasse em lote não vira penalidade para quem perdeu");
r = await pedir(tG, "GET", "/reports?periodo=hoje");
assert.equal(r.status, 200, JSON.stringify(r.d));
const linhaF = (r.d.atendentes || []).find(x => x.nome === "Fernando" || x.name === "Fernando");
assert.ok(linhaF, "Fernando não apareceu no relatório");
assert.equal(linhaF.leads_perdidos_para_outro, 0, "o repasse em lote contou como lead perdido");
console.log("   ok");

console.log("\nTudo certo ✅");
fim(0);
