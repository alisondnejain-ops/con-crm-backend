/* PERMISSÕES INDIVIDUAIS (31/10/2026, lista do Fernando).

   1. Só o gestor dá; só a corretor; chave inventada é descartada.
   2. Sem a permissão, o corretor continua barrado como sempre.
   3. "Repassar os próprios leads": só o lead DELE, nunca para si.
   4. "Ver os relatórios da equipe": lê o ranking e a equipe.
   5. "Editar as mensagens prontas": cria mensagem.
   6. Tirar a permissão vale no próximo pedido, com o mesmo crachá.

   Rodar:  npm run teste:permissoes */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-permissoes.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4821";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const P = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4821";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_perm1";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(org, "Imobiliária Sol", "SOL-P", Date.now(), "");
P.garantirPipelinePadrao(org);
let ordem = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,available_desde,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@sol.com", senha, role, Date.now(), Date.now() + (++ordem));
  return id; };
pessoa("Gestora", "adm"); const vanessa = pessoa("Vanessa", "sdr");
const marina = pessoa("Marina", "corretor"); const rafael = pessoa("Rafael", "corretor");
const entrar = async (n) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: n.toLowerCase() + "@sol.com", password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("Gestora"), tV = await entrar("Vanessa"), tM = await entrar("Marina");
const lead = (dono) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Lead',?,?)`)
    .run(id, org, "Cliente " + (++ordem), "55879913" + String(ordem).padStart(5, "0"), Date.now(), dono);
  return id; };
const daMarina = lead(marina), doRafael = lead(rafael);
const disponiveis = () => db.prepare("UPDATE users SET available = 1, available_desde = ? WHERE org_id = ? AND role = 'corretor'").run(Date.now(), org);

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }

console.log("Permissões individuais");
await caso("1. Só o gestor dá, só a corretor, lista fechada", async () => {
  assert.equal((await chamar(tV, `/auth/users/${marina}/permissoes`, "PATCH", { permissoes: ["repassar_leads"] })).status, 403, "atendente não dá");
  assert.equal((await chamar(tG, `/auth/users/${vanessa}/permissoes`, "PATCH", { permissoes: ["repassar_leads"] })).status, 400, "só corretor");
  const r = await chamar(tG, `/auth/users/${marina}/permissoes`, "PATCH", { permissoes: ["inventada", "ver_conversas_de_todos"] });
  assert.equal(r.status, 200); assert.deepEqual(r.d.permissoes, [], "chave fora da lista some");
});
await caso("2. Sem a permissão, nada muda", async () => {
  assert.equal((await chamar(tM, "/distribution/handoff", "POST", { lead_id: daMarina })).status, 403);
  assert.equal((await chamar(tM, "/reports/score?periodo=este_mes")).status, 403);
  assert.equal((await chamar(tM, "/config/mensagens", "POST", { titulo: "x", corpo: "y" })).status, 403);
});
await caso("3. Repassar os próprios leads", async () => {
  assert.equal((await chamar(tG, `/auth/users/${marina}/permissoes`, "PATCH", { permissoes: ["repassar_leads"] })).status, 200);
  disponiveis();
  assert.equal((await chamar(tM, `/distribution/rodizio?lead_id=${doRafael}`)).status, 403, "fila de lead alheio, não");
  assert.equal((await chamar(tM, `/distribution/rodizio?lead_id=${daMarina}`)).status, 200);
  assert.equal((await chamar(tM, "/distribution/handoff", "POST", { lead_id: doRafael, user_id: marina })).status, 403, "lead do colega, não");
  assert.equal((await chamar(tM, "/distribution/handoff", "POST", { lead_id: daMarina, user_id: marina })).status, 400, "para si mesma, não");
  const r = await chamar(tM, "/distribution/handoff", "POST", { lead_id: daMarina, user_id: rafael });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(daMarina).assigned_to, rafael);
  assert.equal((await chamar(tM, "/distribution/transfer", "POST", { lead_id: doRafael, user_id: marina })).status, 403, "a transferência da supervisão continua dela");
});
await caso("4. Ver os relatórios da equipe", async () => {
  assert.equal((await chamar(tG, `/auth/users/${marina}/permissoes`, "PATCH", { permissoes: ["ver_relatorios_equipe"] })).status, 200);
  assert.equal((await chamar(tM, "/reports/score?periodo=este_mes")).status, 200);
  const r = await chamar(tM, "/reports?periodo=este_mes");
  assert.ok(r.d.atendentes.length >= 2, "vê a equipe, não só a si");
  assert.equal((await chamar(tM, "/distribution/handoff", "POST", { lead_id: doRafael })).status, 403, "a outra permissão saiu");
});
await caso("5. Editar as mensagens prontas", async () => {
  assert.equal((await chamar(tG, `/auth/users/${marina}/permissoes`, "PATCH", { permissoes: ["editar_mensagens"] })).status, 200);
  const r = await chamar(tM, "/config/mensagens", "POST", { titulo: "Follow-up", corpo: "Oi {nome}!" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
});
await caso("6. Tirar vale no próximo pedido, com o mesmo crachá", async () => {
  assert.equal((await chamar(tG, `/auth/users/${marina}/permissoes`, "PATCH", { permissoes: [] })).status, 200);
  assert.equal((await chamar(tM, "/config/mensagens", "POST", { titulo: "x", corpo: "y" })).status, 403);
  assert.equal((await chamar(tM, "/reports/score?periodo=este_mes")).status, 403);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
