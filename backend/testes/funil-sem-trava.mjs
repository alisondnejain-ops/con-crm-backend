/* CAMPO OBRIGATÓRIO QUE NINGUÉM CONSEGUE PREENCHER NÃO TRAVA O FUNIL, E A
   NOTA DO SCORE NÃO NASCE DE PARTE SEM BASE. (30/09/2026, vídeo do Fernando.)

   1. Uma etapa exigia o campo "Entrada na etapa", que depois foi desativado.
      A exigência ficou gravada na etapa, o campo sumiu da ficha e da tela de
      configuração, e a recusa dizia "preencha: entrada_na_etapa" para sempre.
   2. A recusa (422) traz o jeito de preencher (tipo e opções do campo), que
      é o que a janela "Para entrar em…" usa.
   3. Dois corretores sem nada feito apareciam com nota 23: "Perda" de 0% sobre
      zero atendimentos encerrados valia nota 100.
   4. Etapa de perda com outro nome ("Descartado") conta como perda.

   Rodar:  npm run teste:funil-sem-trava  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-funil-sem-trava.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4631";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://127.0.0.1:4631";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa Teste", "FT-1", Date.now());
const { garantirPipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@ft.com", senha, role, Date.now());
  return id; };
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"); user("Ali", "adm");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@ft.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token } });
const tAli = await entrar("Ali"), tMarina = await entrar("Marina");

const funil = await (await chamar(tAli, "/pipelines?todos=1")).json();
const padrao = funil.pipelines.find(p => p.id === funil.padrao);
const etapa = (n) => padrao.stages.find(s => s.name === n);
const novoLead = (nome, fone, stage, dono, extra = {}) => {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,custom_fields,stage,pipeline_id,stage_id,assigned_to,assigned_at,created_at)
    VALUES (?,?,?,?,'WhatsApp','{}','{}',?,?,?,?,?,?)`)
    .run(id, org, nome, fone, stage, padrao.id, etapa(stage).id, dono, Date.now(), Date.now());
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE leads SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
};

console.log("1. A recusa traz o jeito de preencher o campo");
let r = await chamar(tAli, "/pipelines/campos", { method: "POST",
  body: JSON.stringify({ name: "Entrada na etapa", type: "select", options: ["Sim", "Não"] }) });
const campo = (await r.json()).campo;
r = await chamar(tAli, `/pipelines/etapas/${etapa("Pasta").id}`, { method: "PATCH",
  body: JSON.stringify({ required_fields: [campo.key] }) });
assert.equal(r.status, 200);
const lead = novoLead("Ameliano", "5587911110001", "Atendimento", marina);
r = await chamar(tMarina, `/leads/${lead}/stage`, { method: "PATCH", body: JSON.stringify({ stage_id: etapa("Pasta").id }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 422);
assert.equal(d.faltam[0].label, "Entrada na etapa", "a frase usa o NOME do campo, não a chave");
assert.equal(d.faltam[0].campo.type, "select");
assert.deepEqual(d.faltam[0].campo.options, ["Sim", "Não"]);

console.log("2. Desativar o campo tira a exigência da etapa");
r = await chamar(tAli, `/pipelines/campos/${campo.id}`, { method: "DELETE" });
assert.equal(r.status, 200);
const req = JSON.parse(db.prepare("SELECT required_fields FROM pipeline_stages WHERE id = ?").get(etapa("Pasta").id).required_fields);
console.log(`   exigências da etapa agora: ${JSON.stringify(req)}`);
assert.deepEqual(req, []);
r = await chamar(tMarina, `/leads/${lead}/stage`, { method: "PATCH", body: JSON.stringify({ stage_id: etapa("Pasta").id }) });
d = await r.json();
console.log(`   mover: ${r.status} · etapa ${d.stage}`);
assert.equal(r.status, 200);
assert.equal(d.stage, "Pasta");

console.log("3. Exigência órfã já gravada (o caso do Fernando) não trava");
db.prepare("UPDATE pipeline_stages SET required_fields = ? WHERE id = ?").run(JSON.stringify(["entrada_na_etapa"]), etapa("Aprovação").id);
r = await chamar(tMarina, `/leads/${lead}/stage`, { method: "PATCH", body: JSON.stringify({ stage_id: etapa("Aprovação").id }) });
d = await r.json();
console.log(`   ${r.status} · etapa ${d.stage || d.error}`);
assert.equal(r.status, 200);

console.log("4. Campo nativo continua valendo (temperatura)");
db.prepare("UPDATE pipeline_stages SET required_fields = ? WHERE id = ?").run(JSON.stringify(["temperatura"]), etapa("Visita").id);
r = await chamar(tMarina, `/leads/${lead}/stage`, { method: "PATCH", body: JSON.stringify({ stage_id: etapa("Visita").id }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 422);
assert.equal(d.faltam[0].label, "Temperatura");
assert.ok(d.faltam[0].nativo);

console.log("5. Score: corretor com leads e nenhum atendimento encerrado não ganha nota de perda");
const { ranking } = await import("../src/services/score.js");
novoLead("Parado 1", "5587911110002", "Atendimento", rafael);
novoLead("Parado 2", "5587911110003", "Atendimento", rafael);
let rafaelScore = ranking(org, 30).find(x => x.id === rafael);
const perda = rafaelScore.partes.find(p => p.chave === "perda");
console.log(`   Rafael: nota ${rafaelScore.score} · perda: ${perda.valor_texto}`);
assert.ok(perda.fora, "perda sem atendimento encerrado fica fora da conta");
assert.ok(rafaelScore.score < 23, "sem nada feito a nota não pode ser a de antes (23)");
const soma = rafaelScore.partes.filter(p => !p.fora).reduce((s, p) => s + p.contribuiu, 0);
assert.ok(Math.abs(soma - rafaelScore.score) <= 2, `a coluna "contribuiu" fecha com a nota (${soma} x ${rafaelScore.score})`);

console.log("6. Etapa de perda com outro nome conta como perda");
const descartado = db.prepare("SELECT id FROM pipeline_stages WHERE org_id = ? AND name = 'Perdido'").get(org);
db.prepare("UPDATE pipeline_stages SET name = 'Descartado', status_type = 'perdido' WHERE id = ?").run(descartado.id);
novoLead("Descartado 1", "5587911110004", "Atendimento", rafael, { stage: "Descartado", stage_id: descartado.id });
rafaelScore = ranking(org, 30).find(x => x.id === rafael);
const perda2 = rafaelScore.partes.find(p => p.chave === "perda");
console.log(`   Rafael: perda ${perda2.valor_texto} · perdidos ${rafaelScore.perdidos}`);
assert.equal(rafaelScore.perdidos, 1);
assert.ok(!perda2.fora);

console.log("\nTudo certo ✅");
process.exit(0);
