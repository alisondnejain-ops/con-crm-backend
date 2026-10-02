/* A CATRACA DAS ATENDENTES E A IA NO TIME DE SDR (01/10/2026, pedido do Ali).

   "Chegou lead, a atendente que está ativa recebe o lead e ele automaticamente
   cai no funil de SDR; caso tenha mais de uma atendente vale a regra dos
   corretores (catraca)." E a IA, quando contratada, cobre quando nenhuma
   atendente está ativa. Mais o defeito do repasse: lead que chegava no
   corretor e não ia para o funil comercial.

   Rodar:  npm run teste:atendentes-e-ia  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-atendentes-ia.db");
process.env.JWT_SECRET = "teste";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "chave-de-teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const P = await import("../src/services/pipelines.js");
const M = await import("../src/services/movimento.js");
const { proximoAtendente, vezDasAtendentes } = await import("../src/services/catraca.js");
const { podeAtender } = await import("../src/services/robo.js");

const org = "org_casa";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "AI-1", Date.now());
let t0 = Date.now() - 100000;
const novo = (id, nome, papel, available = 0) => db.prepare(
  `INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
   VALUES (?,?,?,?,'x',?,?,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@c.com", papel, available, t0++);
novo("u_ali", "Ali", "adm");
novo("u_vanessa", "Vanessa", "sdr");
novo("u_camila", "Camila", "sdr");
novo("u_marina", "Marina", "corretor", 1);

const disponivel = (id, v) => db.prepare("UPDATE users SET available = ? WHERE id = ?").run(v ? 1 : 0, id);
const varias = (n) => Array.from({ length: n }, () => proximoAtendente(org));

console.log("1. Só a atendente ATIVA recebe");
disponivel("u_vanessa", 1); disponivel("u_camila", 0);
let r = varias(4);
console.log(`   ${r.join(", ")}`);
assert.deepEqual(r, ["u_vanessa", "u_vanessa", "u_vanessa", "u_vanessa"]);

console.log("2. As duas ativas: reveza, uma por vez");
disponivel("u_camila", 1);
r = varias(4);
console.log(`   ${r.join(", ")}`);
assert.deepEqual(r, ["u_camila", "u_vanessa", "u_camila", "u_vanessa"]);

console.log("3. Alguém sair e voltar da disponibilidade não desloca a vez");
// A última a receber foi a Vanessa: a próxima é a Camila, saia quem sair.
disponivel("u_vanessa", 0); disponivel("u_vanessa", 1);
assert.equal(vezDasAtendentes(org).proximo, "u_camila");
console.log("   próxima continua sendo a Camila");

console.log("4. Nenhuma ativa e SEM IA: o lead fica na fila, sem dono — indisponível não recebe");
disponivel("u_vanessa", 0); disponivel("u_camila", 0);
db.prepare("UPDATE orgs SET robo_ativo = 0 WHERE id = ?").run(org);
r = varias(2);
console.log(`   ${r.join(", ")}`);
assert.deepEqual(r, [null, null], "atendente indisponível não pode receber lead novo");
assert.equal(vezDasAtendentes(org).ia, false);

console.log("5. Nenhuma ativa e IA LIGADA: o lead fica para a IA, sem dono");
db.prepare("UPDATE orgs SET robo_ativo = 1 WHERE id = ?").run(org);
assert.equal(vezDasAtendentes(org).ia, true);
assert.equal(proximoAtendente(org), null);
console.log("   sem dono — a IA cobre");

console.log("6. O lead sem dono nasce no funil de SDR");
const comercial = P.criarDoTemplate(org, "comercial", { is_default: true });
const sdr = P.criarDoTemplate(org, "sdr", {});
const lead = (dono, entrada = P.entradaDe(org, dono)) => {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at,
              pipeline_id,stage_id,stage_entered_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, org, "Cliente", "8799" + Math.random().toString().slice(2, 8), entrada.nome, dono, Date.now(),
         entrada.pipeline_id, entrada.stage_id, Date.now());
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','Oi',?)")
    .run("m_" + randomUUID(), id, Date.now());
  return id;
};
const funilDe = (id) => db.prepare("SELECT pipeline_id FROM leads WHERE id = ?").get(id).pipeline_id;
const semDono = lead(null);
assert.equal(funilDe(semDono), sdr.pipeline.id);
console.log("   fila → SDR");

console.log("7. A IA atende o lead sem dono mesmo DENTRO do expediente");
// Terça, 11h: dentro do expediente da imobiliária (18h → 9h é a janela do robô).
const terca11h = new Date(2026, 8, 29, 11, 0).getTime();
let p = podeAtender(org, semDono, terca11h);
console.log(`   ${p.pode ? "atende" : "calada: " + p.motivo}`);
assert.equal(p.pode, true);

console.log("8. Mas o lead que JÁ está com uma atendente espera por ela durante o dia");
const comAtendente = lead("u_vanessa");
p = podeAtender(org, comAtendente, terca11h);
console.log(`   calada: ${p.motivo}`);
assert.equal(p.pode, false);
assert.equal(p.motivo, "dentro_do_expediente");

console.log("9. Uma atendente ficou ativa: a IA para de pegar os leads novos");
disponivel("u_camila", 1);
assert.equal(proximoAtendente(org), "u_camila");
p = podeAtender(org, semDono, terca11h);
console.log(`   lead da fila agora: ${p.pode ? "IA" : "espera a atendente (" + p.motivo + ")"}`);
assert.equal(p.pode, false);

console.log("\n===== O LEAD VAI PARA O COMERCIAL AO CHEGAR NO CORRETOR =====");

console.log("10. Funil de pré-atendimento montado DO ZERO (não pelo modelo SDR)");
// O caso do Fernando: Inbox → Aguardando interação → Qualificado, criado como
// funil comum e posto como entrada da atendente.
db.prepare("UPDATE pipelines SET is_active = 0 WHERE id = ?").run(sdr.pipeline.id);
const proprio = P.criarPipeline(org, { name: "Pré-atendimento", type: "custom" });
P.criarEtapa(org, proprio.pipeline.id, { name: "Inbox" });
P.criarEtapa(org, proprio.pipeline.id, { name: "Qualificado" });
db.prepare("UPDATE users SET pipeline_entrada = ? WHERE role = 'sdr'").run(proprio.pipeline.id);
const l10 = lead("u_vanessa");
assert.equal(funilDe(l10), proprio.pipeline.id, "nasce no pré-atendimento");
M.trocarResponsavel(l10, "u_marina", "u_vanessa");
console.log(`   depois do repasse: ${funilDe(l10) === comercial.pipeline.id ? "Comercial" : "PRESO no pré-atendimento"}`);
assert.equal(funilDe(l10), comercial.pipeline.id);

console.log("11. Funil de SDR marcado como PADRÃO da casa");
db.prepare("UPDATE users SET pipeline_entrada = NULL").run();
db.prepare("UPDATE pipelines SET is_active = 1 WHERE id = ?").run(sdr.pipeline.id);
db.prepare("UPDATE pipelines SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE org_id = ?").run(sdr.pipeline.id, org);
const l11 = lead("u_vanessa");
assert.equal(funilDe(l11), sdr.pipeline.id);
M.trocarResponsavel(l11, "u_marina", "u_vanessa");
console.log(`   depois do repasse: ${funilDe(l11) === comercial.pipeline.id ? "Comercial" : "PRESO no SDR"}`);
assert.equal(funilDe(l11), comercial.pipeline.id);

console.log("12. Lead que nasce direto com o corretor também vai para o comercial");
assert.equal(P.entradaDe(org, "u_marina").pipeline_id, comercial.pipeline.id);
console.log("   Marina → Comercial");

console.log("\nTudo certo ✅");
process.exit(0);
