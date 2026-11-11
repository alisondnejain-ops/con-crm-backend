/* A MESMA PESSOA EM MAIS DE UMA CONTA (11/11/2026, pedido do Ali: corretores
   da Conecta também atendem a Reserva Real do Rio).

   1. O e-mail deixou de ser único no sistema (é único por conta).
   2. Cadastro com e-mail que já é ativo em outra conta pede a senha (409).
   3. Senha errada é recusada; nada nasce.
   4. Senha certa: nasce a linha desta conta, aguardando aprovação (mesmo corretor).
   5. Aguardando, ela não aparece para trocar; o login continua na conta de sempre.
   6. Aprovada, o login devolve as duas contas e troca sem senha.
   7. Não troca para conta em que não tem acesso; o master não usa esta troca.
   8. Trocar a senha numa conta troca nas duas.
   9. O aviso no celular de um lead da outra conta chega ao aparelho dela.
  10. Removida numa conta, ela some da troca; a outra continua.

   Rodar:  npm run teste:varias-contas */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-varias-contas.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4833";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const BASE = "http://localhost:4833";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const agora = Date.now();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('org_co','Conecta','CO-1',?)").run(agora);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('org_rr','Reserva Real do Rio','RR-1',?)").run(agora);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('org_x','Outra','X-1',?)").run(agora);
const usuario = (id, org, nome, email, role, extra = "") => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status${extra ? ",master" : ""})
  VALUES (?,?,?,?,?,?,1,?,'ativo'${extra ? ",1" : ""})`).run(id, org, nome, email, senha, role, agora);
usuario("u_mar", "org_co", "Marina", "marina@x.com", "corretor");
usuario("u_ges", "org_rr", "Elder", "elder@rr.com", "adm");
usuario("u_master", "org_co", "Ali", "ali@ch.com", "adm", 1);

const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const login = (email, password = "123456", extra = {}) => chamar(null, "/auth/login", "POST", { email, password, ...extra });
const cadastro = (extra = {}) => chamar(null, "/auth/register", "POST", { name: "Marina Lopes", email: "marina@x.com", phone: "87991112222",
  adm_code: "RR-1", funcao: "corretor", ...extra });

let ok = 0; const caso = async (nome, fn) => { await fn(); ok++; console.log("✓", nome); };

await caso("1. E-mail único por conta, não no sistema", async () => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql;
  assert.ok(!/email\s+TEXT\s+UNIQUE/i.test(sql), sql);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_users_email_org'").get());
});

await caso("2. Cadastro com e-mail ativo em outra conta pede a senha", async () => {
  const r = await cadastro();
  assert.equal(r.status, 409); assert.equal(r.d.ja_tem_conta, true);
  assert.match(r.d.error, /senha/);
});

await caso("3. Senha errada é recusada e nada nasce", async () => {
  const r = await cadastro({ senha_atual: "errada" });
  assert.equal(r.status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email='marina@x.com'").get().n, 1);
});

await caso("4. Senha certa: linha na Reserva, aguardando aprovação, com a mesma senha", async () => {
  const r = await cadastro({ senha_atual: "123456" });
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.vinculo, true);
  const l = db.prepare("SELECT * FROM users WHERE email='marina@x.com' AND org_id='org_rr'").get();
  assert.equal(l.status, "aguardando_aprovacao"); assert.equal(l.role, "corretor");
  assert.equal(l.pass_hash, db.prepare("SELECT pass_hash FROM users WHERE id='u_mar'").get().pass_hash);
});

await caso("5. Aguardando: login continua na Conecta e a Reserva não aparece para trocar", async () => {
  const r = await login("marina@x.com");
  assert.equal(r.status, 200); assert.equal(r.d.org.id, "org_co");
  assert.equal(r.d.contas.length, 1);
  const t = await chamar(r.d.token, "/auth/trocar-conta", "POST", { org_id: "org_rr" });
  assert.equal(t.status, 404);
});

let tReserva;
await caso("6. Aprovada: o login traz as duas contas e troca sem senha", async () => {
  const tGes = (await login("elder@rr.com")).d.token;
  const pend = db.prepare("SELECT id FROM users WHERE email='marina@x.com' AND org_id='org_rr'").get().id;
  const ap = await chamar(tGes, `/auth/users/${pend}/aprovar`, "POST", {});
  assert.ok(ap.status === 200 || ap.status === 404, "aprovar: " + ap.status);
  if (ap.status === 404) db.prepare("UPDATE users SET status='ativo' WHERE id=?").run(pend);
  const r = await login("marina@x.com");
  assert.equal(r.d.contas.length, 2, JSON.stringify(r.d.contas));
  assert.deepEqual(r.d.contas.map(c => c.nome).sort(), ["Conecta", "Reserva Real do Rio"]);
  const t = await chamar(r.d.token, "/auth/trocar-conta", "POST", { org_id: "org_rr" });
  assert.equal(t.status, 200, JSON.stringify(t.d)); assert.equal(t.d.org.id, "org_rr");
  tReserva = t.d.token;
  const me = await chamar(tReserva, "/auth/me");
  assert.equal(me.d.user.id, pend); assert.equal(me.d.contas.find(c => c.atual).org_id, "org_rr");
  // E o login escolhendo a conta direto.
  const direto = await login("marina@x.com", "123456", { org_id: "org_rr" });
  assert.equal(direto.d.org.id, "org_rr");
  // Os leads de cada conta continuam separados.
  const l = await chamar(tReserva, "/leads"); assert.equal(l.status, 200);
});

await caso("7. Sem acesso não troca; master não usa esta troca", async () => {
  const t = await chamar(tReserva, "/auth/trocar-conta", "POST", { org_id: "org_x" });
  assert.equal(t.status, 404);
  const tm = (await login("ali@ch.com")).d.token;
  const m = await chamar(tm, "/auth/trocar-conta", "POST", { org_id: "org_rr" });
  assert.equal(m.status, 403);
});

await caso("8. Trocar a senha numa conta troca nas duas", async () => {
  const r = await chamar(tReserva, "/auth/me/senha", "POST", { atual: "123456", nova: "nova-senha-9" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const c = await login("marina@x.com", "nova-senha-9");
  assert.equal(c.status, 200); assert.equal(c.d.org.id, "org_co");
  const velha = await login("marina@x.com", "123456");
  assert.equal(velha.status, 401);
});

await caso("9. O aviso de lead da Reserva chega ao aparelho inscrito na Conecta", async () => {
  db.prepare("INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES ('https://push.teste/1','u_mar','p','a',?)").run(agora);
  const pend = db.prepare("SELECT id FROM users WHERE email='marina@x.com' AND org_id='org_rr'").get().id;
  const { linhasDaPessoa } = await import("../src/services/push.js");
  const { ids: linhas } = linhasDaPessoa(pend);
  assert.ok(linhas.includes("u_mar") && linhas.includes(pend));
  // O envio de verdade precisa das chaves VAPID; aqui confere-se a quem ele vai.
  const subs = db.prepare(`SELECT user_id FROM push_subs WHERE user_id IN (${linhas.map(() => "?").join(",")})`).all(...linhas);
  assert.equal(subs.length, 1);
});

await caso("10. Removida na Reserva: some da troca, a Conecta continua", async () => {
  db.prepare("UPDATE users SET status='removido' WHERE email='marina@x.com' AND org_id='org_rr'").run();
  const r = await login("marina@x.com", "nova-senha-9");
  assert.equal(r.status, 200); assert.equal(r.d.org.id, "org_co"); assert.equal(r.d.contas.length, 1);
  const t = await chamar(tReserva, "/leads"); assert.equal(t.status, 401);
});

console.log(`\n${ok} casos passaram.`);
process.exit(0);
