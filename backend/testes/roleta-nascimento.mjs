/* A ROLETA DA ETAPA TAMBÉM DISTRIBUI O LEAD QUE NASCE NELA (18/11/2026).

   Pedido do Fernando, decidido pelo Ali: "a roleta distribui o lead novo".
   A roleta configurada em "Lead Novo" só valia para quem era MOVIDO para a
   etapa; o lead que nascia nela ficava com a atendente da vez ou na fila.

   Rodar:  npm run teste:roleta-nascimento  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-roleta-nascimento.db");
process.env.JWT_SECRET = "teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const P = await import("../src/services/pipelines.js");
const { receberLead } = await import("../src/services/portais.js");
const { nascerLeadDoWhatsapp } = await import("../src/services/lead-whatsapp.js");

const org = "org_roleta";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "RN-1", Date.now());
let t0 = Date.now() - 100000;
const novo = (id, nome, papel, available = 1) => db.prepare(
  `INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
   VALUES (?,?,?,?,'x',?,?,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@r.com", papel, available, t0++);
novo("u_ali", "Ali", "adm", 0);
novo("u_vanessa", "Vanessa", "sdr", 1);
novo("u_marina", "Marina", "corretor", 1);
novo("u_rafael", "Rafael", "corretor", 1);

const comercial = P.criarDoTemplate(org, "comercial", { is_default: true });
const sdr = P.criarDoTemplate(org, "sdr", {});
const primeiraSdr = P.primeiraEtapa(org, sdr.pipeline.id);
const lerLead = (id) => db.prepare("SELECT assigned_to, pipeline_id, stage_id FROM leads WHERE id = ?").get(id);
const casa = db.prepare("SELECT * FROM canais WHERE org_id = ? AND tipo = 'imobiliaria'").get(org)
  || (() => { db.prepare("INSERT INTO canais (id,org_id,tipo,nome,created_at) VALUES ('c_casa',?, 'imobiliaria','Casa',?)").run(org, Date.now());
    return db.prepare("SELECT * FROM canais WHERE id = 'c_casa'").get(); })();
let seq = 0;
const tel = () => "55879911" + String(++seq).padStart(5, "0");
const doPortal = () => { const r = receberLead(org, { portal: "Portal", nome: "Cliente " + seq, telefone: tel() }); assert.ok(r.ok !== false, r.erro); return r.lead_id || db.prepare("SELECT id FROM leads ORDER BY created_at DESC, rowid DESC LIMIT 1").get().id; };
const doWhats = () => nascerLeadDoWhatsapp({ canal: casa, phone: tel(), nome: "Whats " + seq }).id;

console.log("1. Sem roleta na etapa: tudo como antes (a atendente da vez recebe)");
let l = lerLead(doPortal());
assert.equal(l.assigned_to, "u_vanessa");
assert.equal(l.pipeline_id, sdr.pipeline.id);

console.log("2. Roleta ligada na primeira etapa do SDR: o lead novo vai para o corretor da vez");
const ultimaAntes = db.prepare("SELECT atendente_ultimo FROM orgs WHERE id = ?").get(org).atendente_ultimo;
db.prepare("UPDATE pipeline_stages SET automation_config = ? WHERE id = ?").run(JSON.stringify({ distribuir: "rodizio" }), primeiraSdr.id);
const a = lerLead(doPortal()), b = lerLead(doWhats());
console.log(`   portal → ${a.assigned_to} · WhatsApp → ${b.assigned_to}`);
assert.deepEqual([a.assigned_to, b.assigned_to].sort(), ["u_marina", "u_rafael"], "um para cada, revezando");
assert.equal(a.pipeline_id, comercial.pipeline.id, "do SDR para o funil de quem recebeu, como no repasse");
assert.equal(db.prepare("SELECT atendente_ultimo FROM orgs WHERE id = ?").get(org).atendente_ultimo, ultimaAntes,
  "a vez da atendente não anda: ela não recebeu");
assert.equal(db.prepare("SELECT COUNT(*) n FROM lead_transfers WHERE org_id = ?").get(org).n, 0,
  "nasce com o corretor, sem repasse no histórico (a atendente não conta como 'recebeu')");

console.log("3. Ninguém disponível na roleta: fica como ia nascer (com a atendente)");
db.prepare("UPDATE users SET available = 0 WHERE role = 'corretor'").run();
l = lerLead(doPortal());
assert.equal(l.assigned_to, "u_vanessa");
db.prepare("UPDATE users SET available = 1 WHERE role = 'corretor'").run();

console.log("4. Sem atendente ativa (fila): a roleta também entrega");
db.prepare("UPDATE users SET available = 0 WHERE id = 'u_vanessa'").run();
l = lerLead(doWhats());
assert.ok(["u_marina", "u_rafael"].includes(l.assigned_to));

console.log("5. Roleta numa etapa do comercial (o lead do corretor nasce ali): fica na etapa");
db.prepare("UPDATE pipeline_stages SET automation_config = NULL WHERE id = ?").run(primeiraSdr.id);
db.prepare("UPDATE users SET available = 1 WHERE id = 'u_vanessa'").run();
db.prepare("UPDATE users SET pipeline_entrada = ? WHERE id = 'u_vanessa'").run(comercial.pipeline.id);
const primeiraCom = P.primeiraEtapa(org, comercial.pipeline.id);
db.prepare("UPDATE pipeline_stages SET automation_config = ? WHERE id = ?").run(JSON.stringify({ distribuir: "u_rafael" }), primeiraCom.id);
l = lerLead(doPortal());
assert.equal(l.assigned_to, "u_rafael", "pessoa fixa da etapa");
assert.equal(l.stage_id, primeiraCom.id);

console.log("\nTudo certo ✅");
process.exit(0);
