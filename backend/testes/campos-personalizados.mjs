/* VALOR dos campos personalizados, por HTTP (03/09/2026 achado, 08/09/2026 corrigido).

   28/08/2026 criou a DEFINIÇÃO do campo (nome, tipo, onde aparece) e o
   "obrigatório para entrar nesta etapa" — mas nunca ganhou uma rota para
   ESCREVER o valor num lead. Na prática: um gestor marcava "Orçamento máximo"
   como obrigatório para "Proposta", o corretor tentava mover o lead, o
   sistema dizia "preencha: Orçamento máximo" — e não existia lugar nenhum,
   em rota nenhuma, para preencher. A trava existia; a porta não.

   O que este teste protege:

   - a rota escreve só campos que EXISTEM e estão ATIVOS — chave desconhecida
     é ignorada, não vira lixo no JSON do lead;
   - cada tipo valida do jeito certo: número não aceita texto, seleção não
     aceita valor fora da lista;
   - valor vazio APAGA a chave (mesma convenção da qualificação);
   - quem não tem o lead não escreve nada;
   - depois de preencher, o campo obrigatório da etapa deixa de bloquear —
     é o fim a fim que prova que a porta e a trava são a mesma peça.

   Rodar:  npm run teste:campos-personalizados
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-campos.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4629";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4629";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "CF-1", Date.now());
const { garantirPipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org); // esta org nasceu depois do bootstrap do servidor — precisa do próprio funil

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@cf.com", senha, role, Date.now());
  return id; };
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"), ali = user("Ali", "adm");

const lead = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,custom_fields,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','{}','Atendimento',?,?)`).run(lead, org, "Jhennyfer", "5587911110000", marina, Date.now());

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@cf.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const tMarina = await entrar("Marina"), tRafael = await entrar("Rafael"), tAli = await entrar("Ali");

console.log("1. O gestor cria três campos: número, seleção e texto");
let r = await chamar(tAli, "/pipelines/campos", { method: "POST",
  body: JSON.stringify({ name: "Orçamento máximo", type: "currency" }) });
let d = await r.json();
console.log(`   ${r.status} · chave: ${d.campo.key}`);
assert.equal(r.status, 200);
const campoOrcamento = d.campo.key;

r = await chamar(tAli, "/pipelines/campos", { method: "POST",
  body: JSON.stringify({ name: "Tipologia", type: "select", options: ["Casa", "Apartamento", "Terreno"] }) });
d = await r.json();
const campoTipologia = d.campo.key;
console.log(`   Tipologia: ${campoTipologia}`);

console.log("2. O corretor preenche o número e a seleção");
r = await chamar(tMarina, `/leads/${lead}/campos`, { method: "PATCH",
  body: JSON.stringify({ [campoOrcamento]: "350000", [campoTipologia]: "Apartamento" }) });
d = await r.json();
console.log(`   ${r.status} · ${JSON.stringify(d.campos)}`);
assert.equal(r.status, 200);
assert.equal(d.campos[campoOrcamento], 350000);
assert.equal(d.campos[campoTipologia], "Apartamento");

console.log("3. Número que não é número é recusado");
r = await chamar(tMarina, `/leads/${lead}/campos`, { method: "PATCH",
  body: JSON.stringify({ [campoOrcamento]: "trezentos mil" }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("4. Seleção fora da lista é recusada");
r = await chamar(tMarina, `/leads/${lead}/campos`, { method: "PATCH",
  body: JSON.stringify({ [campoTipologia]: "Fazenda" }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("5. Chave que não existe é ignorada, não vira erro nem lixo no lead");
r = await chamar(tMarina, `/leads/${lead}/campos`, { method: "PATCH",
  body: JSON.stringify({ campo_que_nao_existe: "qualquer coisa" }) });
d = await r.json();
console.log(`   ${r.status} · guardou: ${JSON.stringify(d.campos)}`);
assert.equal(r.status, 200);
assert.equal(d.campos.campo_que_nao_existe, undefined);

console.log("6. Valor vazio apaga a chave");
r = await chamar(tMarina, `/leads/${lead}/campos`, { method: "PATCH", body: JSON.stringify({ [campoTipologia]: "" }) });
d = await r.json();
console.log(`   ${r.status} · tem tipologia? ${campoTipologia in d.campos}`);
assert.equal(r.status, 200);
assert.ok(!(campoTipologia in d.campos));

console.log("7. Quem não tem o lead não escreve nada");
r = await chamar(tRafael, `/leads/${lead}/campos`, { method: "PATCH", body: JSON.stringify({ [campoOrcamento]: "1" }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("8. Sem login, nada");
r = await fetch(`${BASE}/leads/${lead}/campos`, { method: "PATCH", body: JSON.stringify({}) });
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("9. FIM A FIM: campo obrigatório bloqueia, e preencher pela rota destrava");
const funil = await (await chamar(tAli, "/pipelines?todos=1")).json();
const padrao = funil.pipelines.find(p => p.id === funil.padrao);
const aprovacao = padrao.stages.find(s => s.name === "Aprovação");
r = await chamar(tAli, `/pipelines/etapas/${aprovacao.id}`, { method: "PATCH",
  body: JSON.stringify({ required_fields: [campoOrcamento] }) });
assert.equal(r.status, 200, "configurar a etapa deveria funcionar");

// Lead novo, sem o campo preenchido.
const lead2 = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,custom_fields,stage,pipeline_id,stage_id,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','{}','Atendimento',?,?,?,?)`)
  .run(lead2, org, "Cliente Novo", "5587922220000", padrao.id, padrao.stages.find(s => s.name === "Atendimento").id, marina, Date.now());

r = await chamar(tMarina, `/leads/${lead2}/stage`, { method: "PATCH", body: JSON.stringify({ stage_id: aprovacao.id }) });
d = await r.json();
console.log(`   sem preencher: ${r.status} · ${d.error}`);
assert.equal(r.status, 422);
assert.ok(/Orçamento máximo/.test(d.error));

r = await chamar(tMarina, `/leads/${lead2}/campos`, { method: "PATCH", body: JSON.stringify({ [campoOrcamento]: "420000" }) });
assert.equal(r.status, 200);

r = await chamar(tMarina, `/leads/${lead2}/stage`, { method: "PATCH", body: JSON.stringify({ stage_id: aprovacao.id }) });
d = await r.json();
console.log(`   depois de preencher: ${r.status} · etapa: ${d.stage}`);
assert.equal(r.status, 200);
assert.equal(d.stage, "Aprovação");

console.log("\nTudo certo ✅");
process.exit(0);
