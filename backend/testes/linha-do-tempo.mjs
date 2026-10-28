/* LINHA DO TEMPO DO LEAD (28/10/2026).

   Protege: (1) cada fato gravado aparece, uma vez, com quem fez; (2) a mais
   recente vem em cima; (3) mensagens entram só como marcos (a primeira do
   cliente e a primeira de cada pessoa), não uma a uma; (4) quem não pode ver
   o lead não vê a linha do tempo dele.

   Rodar:  npm run teste:linha-do-tempo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-linha-do-tempo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4643";
process.env.PRAZO_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { moverEtapa } = await import("../src/services/etapas.js");
const { trocarResponsavel } = await import("../src/services/movimento.js");
const BASE = "http://localhost:4643";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "LT-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@lt.com", senha, role, Date.now());
  return id; };
const gestor = user("Gestor", "adm"), vanessa = user("Vanessa", "sdr"), marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");

const t0 = Date.now() - 10 * 3600000, M = 60000;
const lead = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,origem,campaign_name,assigned_to,created_at)
  VALUES (?,?,?,?,'{}','Lead','Meta Ads','Campanha Horizon',?,?)`).run(lead, org, "Joana", "5587991112222", vanessa, t0);
const msg = (dir, autor, nome, t) => db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
  VALUES (?,?,?,?,?,'oi',?)`).run("m_" + randomUUID(), lead, dir, autor, nome, t);
msg("in", null, null, t0 + 1 * M); msg("in", null, null, t0 + 2 * M);
msg("out", vanessa, "Vanessa", t0 + 5 * M); msg("out", vanessa, "Vanessa", t0 + 6 * M);
moverEtapa({ leadId: lead, para: "Atendimento", motivo: "mao", userId: vanessa });
trocarResponsavel(lead, marina, vanessa, "mao");
msg("out", marina, "Marina", Date.now());
db.prepare("INSERT INTO ligacoes (id,lead_id,user_id,resultado,obs,created_at) VALUES (?,?,?,?,?,?)")
  .run("lg1", lead, marina, "falou", "quer visitar sábado", Date.now());
db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,criado_por,titulo,quando,feito_em,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("t1", org, lead, marina, marina, "Mandar a planta", Date.now() + 3600000, Date.now(), Date.now());
db.prepare("INSERT INTO observacoes (id,org_id,lead_id,texto,autor_id,created_at) VALUES (?,?,?,?,?,?)")
  .run("o1", org, lead, "Quem decide é o marido", vanessa, Date.now());

const outro = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,assigned_to,created_at) VALUES (?,?,?,?,'{}','Lead',?,?)`)
  .run(outro, org, "Outro", "5587991113333", rafael, t0);

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  return (await r.json()).token;
}
const get = (t, c) => fetch(BASE + c, { headers: t ? { authorization: "Bearer " + t } : {} });
const tMarina = await entrar("marina@lt.com"), tGestor = await entrar("gestor@lt.com");

console.log("1. Cada fato aparece, com quem fez");
let r = await get(tMarina, `/leads/${lead}/linha-do-tempo`);
assert.equal(r.status, 200);
const d = await r.json();
for (const e of d.eventos) console.log(`   ${e.tipo.padEnd(12)} ${e.texto}${e.quem ? " · " + e.quem : ""}`);
const tem = (tipo, trecho) => d.eventos.find(e => e.tipo === tipo && e.texto.includes(trecho));
assert.ok(tem("entrada", "Campanha Horizon"));
assert.ok(tem("etapa", "Atendimento"));
const dono = tem("dono", "Passou de Vanessa para Marina"); assert.ok(dono); assert.equal(dono.quem, "Vanessa");
assert.ok(tem("ligacao", "falou com o cliente"));
assert.ok(tem("tarefa", "Mandar a planta")); assert.ok(tem("tarefa_feita", "Mandar a planta"));
assert.equal(tem("observacao", "Observação").detalhe, "Quem decide é o marido");

console.log("2. Mensagens só como marcos");
const msgs = d.eventos.filter(e => e.tipo === "mensagem").map(e => e.texto).sort();
assert.deepEqual(msgs, ["Primeira mensagem de Marina", "Primeira mensagem de Vanessa", "Primeira mensagem do cliente"]);

console.log("3. A mais recente em cima");
for (let i = 1; i < d.eventos.length; i++) assert.ok(d.eventos[i - 1].quando >= d.eventos[i].quando);
assert.equal(d.eventos[d.eventos.length - 1].tipo, "entrada");

console.log("4. Quem não pode ver o lead não vê a linha do tempo");
r = await get(tMarina, `/leads/${outro}/linha-do-tempo`);
assert.equal(r.status, 403);
r = await get(null, `/leads/${lead}/linha-do-tempo`);
assert.equal(r.status, 401);
r = await get(tGestor, `/leads/${outro}/linha-do-tempo`);
assert.equal(r.status, 200, "a gestão vê de todos");

console.log("\nTudo certo ✅");
process.exit(0);
