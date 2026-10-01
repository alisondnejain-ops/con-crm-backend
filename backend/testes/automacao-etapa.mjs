/* O QUE A ETAPA FAZ QUANDO O LEAD CHEGA — agora pela tela (01/10/2026, áudio
   do Fernando: "não sei como ativar a roleta").

   O motor existia desde 28/08 (services/movimento.js → rodarAutomacao) e só
   dava para ligar pelo banco. Com a tela, o que chega vem do navegador: o
   servidor confere antes de gravar (pipelines.js → validarAutomacao).

   Rodar:  npm run teste:automacao-etapa  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-automacao-etapa.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4638";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const BASE = "http://127.0.0.1:4638";
await new Promise(r => setTimeout(r, 700));
const P = await import("../src/services/pipelines.js");
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

const casa = (org, cod) => db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, org, cod, Date.now());
casa("org_a", "AE-1"); casa("org_b", "AE-2");
const user = (org, nome, role, status = "ativo") => { const id = "u_" + nome.toLowerCase();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,?)`).run(id, org, nome, nome.toLowerCase() + "@ae.com", senha, role, Date.now(), status);
  return id; };
user("org_a", "Ali", "adm"); user("org_a", "Vanessa", "sdr");
const marina = user("org_a", "Marina", "corretor"); user("org_a", "Saiu", "corretor", "removido");
const zeca = user("org_b", "Zeca", "corretor");

const sdr = P.criarDoTemplate("org_a", "sdr", {});
const comercial = P.criarDoTemplate("org_a", "comercial", { is_default: true });
const desligado = P.criarDoTemplate("org_a", "locacao", {});
P.editarPipeline("org_a", desligado.pipeline.id, { is_active: false });
const daOutra = P.criarDoTemplate("org_b", "comercial", {});
const qualificado = sdr.etapas.find(e => e.name === "Em qualificação");

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  return (await r.json()).token;
}
const chamar = (t, caminho, metodo = "GET", corpo) => fetch(BASE + caminho, { method: metodo,
  headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: corpo ? JSON.stringify(corpo) : undefined });
const tAli = await entrar("ali@ae.com"), tVanessa = await entrar("vanessa@ae.com"), tMarina = await entrar("marina@ae.com");
const salvar = (t, cfg) => chamar(t, `/pipelines/etapas/${qualificado.id}`, "PATCH", { automation_config: cfg });
const gravado = () => JSON.parse(db.prepare("SELECT automation_config FROM pipeline_stages WHERE id = ?").get(qualificado.id).automation_config || "{}");

console.log("1. Recusas com a razão escrita, e nada gravado");
for (const [cfg, frase] of [
  [{ distribuir: zeca }, /não está ativa/],                                   // pessoa de OUTRA imobiliária
  [{ distribuir: "u_saiu" }, /não está ativa/],                               // pessoa removida
  [{ mover_para_pipeline: daOutra.pipeline.id }, /não foi encontrado/],       // funil de OUTRA imobiliária
  [{ mover_para_pipeline: sdr.pipeline.id }, /já está neste funil/],
  [{ mover_para_pipeline: desligado.pipeline.id }, /desligado/],
  [{ distribuir: "rodizio", limpar_responsavel: true }, /uma coisa só/],
]) {
  const r = await salvar(tAli, cfg); const d = await r.json();
  console.log(`   ${r.status} · ${d.error}`);
  assert.equal(r.status, 400); assert.match(d.error, frase);
  assert.deepEqual(gravado(), {}, "nada foi gravado");
}

console.log("2. Configuração válida grava só as chaves conhecidas");
let r = await salvar(tAli, { distribuir: marina, mover_para_pipeline: comercial.pipeline.id, enviar_email_para: "x@y.com" });
assert.equal(r.status, 200);
assert.deepEqual(gravado(), { distribuir: marina, mover_para_pipeline: comercial.pipeline.id });
console.log(`   ${JSON.stringify(gravado())}`);

console.log("3. Mover o lead pela rota aplica a automação");
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,stage_id,pipeline_id,assigned_to,created_at,qual_json,custom_fields)
  VALUES ('l1','org_a','Cliente','5587999990001',?,?,?,'u_vanessa',?,'{}','{}')`)
  .run(sdr.etapas[0].name, sdr.etapas[0].id, sdr.pipeline.id, Date.now());
r = await chamar(tVanessa, "/leads/l1/stage", "PATCH", { stage_id: qualificado.id });
const d = await r.json();
const lead = db.prepare("SELECT assigned_to, pipeline_id, stage FROM leads WHERE id = 'l1'").get();
console.log(`   ${r.status} · dono ${lead.assigned_to} · funil ${lead.pipeline_id === comercial.pipeline.id ? "Comercial" : lead.pipeline_id} · etapa ${lead.stage}`);
assert.equal(r.status, 200);
assert.equal(lead.assigned_to, marina);
assert.equal(lead.pipeline_id, comercial.pipeline.id);
assert.equal(lead.stage, comercial.etapas[0].name, "entra na primeira etapa do funil de destino");
assert.equal(d.responsavel, marina);

console.log("4. Devolver à fila e roleta também gravam");
r = await salvar(tAli, { limpar_responsavel: true }); assert.equal(r.status, 200);
assert.deepEqual(gravado(), { limpar_responsavel: true });
r = await salvar(tVanessa, { distribuir: "rodizio" }); assert.equal(r.status, 200, "a atendente também configura");
assert.deepEqual(gravado(), { distribuir: "rodizio" });

console.log("5. Desligar a automação é mandar vazio");
r = await salvar(tAli, {}); assert.equal(r.status, 200);
assert.deepEqual(gravado(), {});

console.log("6. Corretor não configura");
r = await salvar(tMarina, { distribuir: "rodizio" });
assert.equal(r.status, 403);

console.log("\nTudo certo ✅");
process.exit(0);
