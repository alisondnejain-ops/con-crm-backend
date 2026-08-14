/* O tempo de resposta do corretor tem que ser DELE.

   Na Conecta a atendente faz o primeiro contato e repassa. O CRM guardava a
   primeira resposta no lead (`first_resp_at`), sem dizer de quem era — e era
   esse número que aparecia como "1ª resposta do corretor".

   Consequência, e é a queixa do Ali sobre o ranking: o corretor que recebeu um
   lead repassado carregava o tempo da atendente. Se ela foi rápida, ele ganhava
   nota por trabalho que não fez; se ela demorou, levava a culpa. E a agilidade
   dele mesmo não aparecia em lugar nenhum do relatório.

   Este teste monta o caso exato e trava o conserto.

   Rodar:  npm run teste:tempo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-tempo.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { primeirasRespostas, temposDeResposta, mediana } = await import("../src/services/score.js");

const MIN = 60000;
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
const camila = user("Camila", "sdr"), marina = user("Marina", "corretor");

/* O caso real, minuto a minuto:
   00:00  o lead entra
   00:03  CAMILA responde (rápida) e faz o primeiro contato
   00:40  ela repassa para a MARINA
   01:30  a Marina fala com o cliente pela primeira vez  → 50 min DELA */
const t0 = Date.now() - 5 * 3600000;
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,assigned_at,first_resp_at,created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(leadId, org, "Joana", "5587900001111", "Atendimento",
    marina, t0 + 40 * MIN, t0 + 3 * MIN, t0);

const msg = (dir, quem, texto, min) => db.prepare(
  `INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at) VALUES (?,?,?,?,?,?)`)
  .run("m_" + randomUUID(), leadId, dir, quem, texto, t0 + min * MIN);

msg("in", null, "Oi, vi o anúncio", 0);
msg("out", camila, "Oi! Aqui é a Camila, vou te atender", 3);
msg("in", null, "Quanto fica a entrada?", 45);
msg("out", marina, "Oi Joana, aqui é a Marina, assumi seu atendimento", 90);
msg("in", null, "E o financiamento?", 120);
msg("out", marina, "Consigo simular pra você", 130);

const leads = db.prepare("SELECT * FROM leads WHERE assigned_to = ?").all(marina);

console.log("1. A 1ª resposta da MARINA conta da hora em que o lead virou dela");
const dela = primeirasRespostas(leads, marina);
console.log(`   ${dela[0]} min (repassado aos 40, ela falou aos 90)`);
assert.deepEqual(dela, [50], "50 min: de 00:40 (repasse) a 01:30 (primeira fala dela)");

console.log("2. NÃO é o tempo da Camila, que estava gravado no lead");
const comoEraAntes = (leads[0].first_resp_at - leads[0].created_at) / MIN;
console.log(`   o número antigo era ${comoEraAntes} min — o da Camila`);
assert.equal(comoEraAntes, 3);
assert.notEqual(dela[0], comoEraAntes, "o corretor não pode herdar o tempo de quem repassou");

console.log("3. A Camila também é medida pelo que ELA fez");
const daCamila = primeirasRespostas(
  db.prepare("SELECT * FROM leads WHERE id=?").all(leadId).map(l => ({ ...l, assigned_at: null })), camila);
console.log(`   ${daCamila[0]} min`);
assert.deepEqual(daCamila, [3]);

console.log("4. Tempo de atendimento: só as esperas que ELA causou");
const esperasMarina = temposDeResposta([leadId], marina);
const esperasTodos = temposDeResposta([leadId]);
console.log(`   da Marina: ${esperasMarina.join(", ")} min | de todo mundo: ${esperasTodos.join(", ")} min`);
assert.deepEqual(esperasMarina, [45, 10], "45 min (pergunta 00:45 → resposta 01:30) e 10 min");
assert.deepEqual(esperasTodos, [3, 45, 10], "sem filtro entra a resposta da Camila também");
console.log(`   mediana da Marina: ${mediana(esperasMarina)} min`);

console.log("5. Resposta anterior ao repasse não conta para quem recebeu");
const antes = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,assigned_at,created_at)
  VALUES (?,?,?,?,?,?,?,?)`).run(antes, org, "Outro", "5587900002222", "Atendimento", marina, t0 + 60 * MIN, t0);
db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at) VALUES (?,?,?,?,?,?)`)
  .run("m_" + randomUUID(), antes, "out", marina, "falei antes de o lead ser meu", t0 + 10 * MIN);
const semResposta = primeirasRespostas(db.prepare("SELECT * FROM leads WHERE id=?").all(antes), marina);
console.log(`   respostas contadas: ${semResposta.length}`);
assert.deepEqual(semResposta, [], "mensagem anterior à entrega não é resposta a esta entrega");

console.log("6. Visita só conta quando uma PESSOA colocou o lead ali");
const { moverEtapa } = await import("../src/services/etapas.js");
const porPalavra = "l_" + randomUUID(), porGente = "l_" + randomUUID();
for (const [id, nome] of [[porPalavra, "Pela palavra"], [porGente, "Pela pessoa"]])
  db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, org, nome, "5587900003" + id.slice(-3), "Atendimento", marina, Date.now());
moverEtapa({ leadId: porPalavra, para: "Agendamento", motivo: "palavra" });
moverEtapa({ leadId: porGente, para: "Agendamento", motivo: "mao", userId: marina });

const { ranking } = await import("../src/services/score.js");
const m = ranking(org, 365).find(x => x.id === marina);
console.log(`   no funil: ${m.visitas} · confirmadas por pessoa: ${m.visitas_confirmadas} · da regra automática: ${m.visitas_automaticas}`);
assert.equal(m.visitas, 2, "o funil mostra as duas");
assert.equal(m.visitas_confirmadas, 1, "só uma foi decisão de gente");
assert.equal(m.visitas_automaticas, 1);

console.log("\nTudo certo ✅");
