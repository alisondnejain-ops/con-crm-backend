/* Corrigir o nome do lead.

   O nome que chega pelo WhatsApp é o que a pessoa escolheu no aparelho dela —
   "Jr 🏡", o número puro, o nome do marido. Quem descobre o nome de verdade é
   quem está conversando, então é quem corrige.

   O que este teste protege, além do óbvio: que a correção NÃO seja desfeita
   pela próxima mensagem que chegar pelo WhatsApp. Nome que volta sozinho é
   pior do que nome errado, porque a pessoa corrige duas vezes e desiste.

   Rodar:  npm run teste:nome
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-nome.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");

const org = "org_" + randomUUID().slice(0, 8), outra = "org_" + randomUUID().slice(0, 8);
for (const [o, n, c] of [[org, "Conecta", "A-1"], [outra, "Vizinha", "B-1"]])
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(o, n, c, Date.now());
const user = (o, nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, o, nome, nome + "@x.com", role, Date.now()); return id; };
const marina = user(org, "Marina", "corretor"), rafael = user(org, "Rafael", "corretor");
const ali = user(org, "Ali", "adm"), bruno = user(outra, "Bruno", "adm");

const leadId = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(leadId, org, "+55 87 8123-0808", "5587981230808", "Lead", marina, Date.now());

const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: leadsRoutes } = await import("../src/routes/leads.routes.js");
const app = express(); app.use(express.json()); app.use("/leads", leadsRoutes);
const srv = app.listen(0); const porta = srv.address().port;
const cracha = (id, role, o) => jwt.sign({ id, role, org_id: o || org, name: id }, "teste", { expiresIn: "1h" });
const renomear = (quem, nome) => fetch(`http://127.0.0.1:${porta}/leads/${leadId}/nome`,
  { method: "PATCH", headers: { authorization: "Bearer " + quem, "content-type": "application/json" },
    body: JSON.stringify({ nome }) }).then(async x => ({ status: x.status, corpo: await x.json() }));
const nomeAgora = () => db.prepare("SELECT name FROM leads WHERE id=?").get(leadId).name;

console.log("1. Quem atende corrige o nome");
let r = await renomear(cracha(marina, "corretor"), "Leonardo Nunes Mendonça");
console.log(`   "${nomeAgora()}"`);
assert.equal(r.status, 200);
assert.equal(nomeAgora(), "Leonardo Nunes Mendonça");

console.log("2. A supervisão também");
r = await renomear(cracha(ali, "adm"), "Leonardo Mendonça");
assert.equal(nomeAgora(), "Leonardo Mendonça");

console.log("3. Corretor de OUTRO lead não mexe");
r = await renomear(cracha(rafael, "corretor"), "Nome errado");
console.log("   ", r.status, r.corpo.error);
assert.equal(r.status, 403);
assert.equal(nomeAgora(), "Leonardo Mendonça");

console.log("4. Gestor da imobiliária vizinha não mexe");
r = await renomear(cracha(bruno, "adm", outra), "Nome da vizinha");
assert.equal(r.status, 403);
assert.equal(nomeAgora(), "Leonardo Mendonça");

console.log("5. Nome vazio é recusado — some da lista quem não tem nome");
for (const vazio of ["", "   ", "\t"]) {
  r = await renomear(cracha(marina, "corretor"), vazio);
  assert.equal(r.status, 400, `"${vazio}" deveria ser recusado`);
}
assert.equal(nomeAgora(), "Leonardo Mendonça");

console.log("6. Espaço sobrando é limpo, e nome gigante é cortado");
await renomear(cracha(marina, "corretor"), "  Ana   Paula  Souza  ");
assert.equal(nomeAgora(), "Ana Paula Souza");
await renomear(cracha(marina, "corretor"), "x".repeat(200));
assert.equal(nomeAgora().length, 80);

console.log("7. A correção RESISTE à próxima mensagem do WhatsApp");
await renomear(cracha(marina, "corretor"), "Leonardo Mendonça");
// É o que o webhook faz ao receber mensagem de um número que já é lead:
// grava a mensagem e NÃO toca no nome (ver uazapi.webhook.js).
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)")
  .run("m_" + randomUUID(), leadId, "in", "Bom dia", Date.now());
console.log(`   depois da mensagem: "${nomeAgora()}"`);
assert.equal(nomeAgora(), "Leonardo Mendonça", "o nome corrigido não pode voltar sozinho");

srv.close();
console.log("\nTudo certo ✅");
