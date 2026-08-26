/* Convite que nunca virou conta precisa ter como sair da lista.

   O caso real (Ali, 26/08/2026): um cadastro de teste ficou preso na tela
   Equipe como "Não confirmou o e-mail", e não havia botão nenhum que o
   tirasse de lá. O buraco não aparecia olhando cada parte sozinha:

   - a tela só oferece "Remover" para conta ATIVA;
   - e só oferece "Apagar de vez" para conta JÁ REMOVIDA;
   - o servidor exigia `status='removido'` para apagar.

   Quem nunca definiu senha não é nenhum dos dois estados. Duas metades que
   não se encontravam, e no meio delas um cadastro imortal.

   Aqui apagar é seguro justamente porque a pessoa nunca entrou: não atendeu
   ninguém, não tem conversa nem relatório apontando para ela. O que a regra
   "remova primeiro" protege — o histórico — não existe neste caso.

   E a trava do "único gestor ativo" também estava pegando quem não estava
   ativo: tirar da equipe um gestor que nunca confirmou o e-mail não muda a
   cobertura da imobiliária em nada.

   Rodar:  npm run teste:apagar-convite
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-convite.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4619";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4619";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Aurora", "AUR-1", Date.now());

const user = (nome, email, role, status, master = 0) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,0,?,?,?)`).run(id, org, nome, email, senha, role, Date.now(), status, master);
  return id; };

/* O gestor que manda é MASTER, como o Ali. É o detalhe que fazia a trava do
   "único gestor ativo" morder: `semMaster` não conta o master, então a
   contagem de gestores ativos dava zero. */
user("Ali", "ali@aur.com", "adm", "ativo", 1);
const teste = user("Conta de Teste", "teste@aur.com", "adm", "pendente");
const recusado = user("Recusado", "recusado@aur.com", "corretor", "recusado");
const ativo = user("Marina", "marina@aur.com", "corretor", "ativo");

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });
const existe = (id) => !!db.prepare("SELECT id FROM users WHERE id = ?").get(id);

const tAli = await entrar("ali@aur.com");

console.log("1. O cadastro de teste está lá, como 'não confirmou o e-mail'");
let d = await (await chamar(tAli, "/auth/users")).json();
const lista = d.users || d;
console.log(`   ${lista.length} na equipe · "${lista.find(u => u.id === teste)?.name}" está ${lista.find(u => u.id === teste)?.status}`);
assert.equal(lista.find(u => u.id === teste).status, "pendente");

console.log("2. Apagar direto FUNCIONA — sem precisar remover antes");
/* Era aqui que travava: o servidor exigia status='removido', e a tela não
   oferecia "Remover" para quem não estava ativo. */
let r = await chamar(tAli, `/auth/users/${teste}`, { method: "DELETE" });
console.log(`   ${r.status} · ${JSON.stringify(await r.json())}`);
assert.equal(r.status, 200);
assert.ok(!existe(teste), "o cadastro sai da plataforma");

console.log("3. O mesmo vale para quem foi recusado");
r = await chamar(tAli, `/auth/users/${recusado}`, { method: "DELETE" });
console.log(`   ${r.status}`);
assert.equal(r.status, 200);
assert.ok(!existe(recusado));

console.log("4. Quem ESTÁ ativo continua exigindo remover primeiro");
/* A regra não sumiu: ela existe para proteger o histórico de quem atendeu, e
   isso continua valendo para conta que foi usada de verdade. */
r = await chamar(tAli, `/auth/users/${ativo}`, { method: "DELETE" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.ok(existe(ativo), "e a conta ativa continua inteira");

console.log("5. Remover um gestor PENDENTE não esbarra na trava do 'único gestor ativo'");
/* Com o Ali sendo master, `semMaster` não o conta, então a contagem de
   gestores ativos era zero e a trava recusava — impedindo tirar da equipe
   alguém cuja saída não mudava a cobertura da imobiliária em nada. */
const outroPendente = user("Gestor Pendente", "gp@aur.com", "adm", "pendente");
r = await chamar(tAli, `/auth/users/${outroPendente}/remover`, { method: "POST", body: JSON.stringify({}) });
console.log(`   ${r.status} · ${JSON.stringify(await r.json())}`);
assert.equal(r.status, 200);

console.log("6. Mas o último gestor ATIVO continua protegido");
const gestorAtivo = user("Gestora da casa", "ga@aur.com", "adm", "ativo");
r = await chamar(tAli, `/auth/users/${gestorAtivo}/remover`, { method: "POST", body: JSON.stringify({}) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409, "a imobiliária não pode ficar sem gestor ativo");

console.log("7. Só o GESTOR apaga — e ninguém apaga a própria conta");
const tMarina = await entrar("marina@aur.com");
const outroTeste = user("Outro teste", "outro@aur.com", "corretor", "pendente");
r = await chamar(tMarina, `/auth/users/${outroTeste}`, { method: "DELETE" });
console.log(`   corretora tentando: ${r.status}`);
assert.equal(r.status, 403);
assert.ok(existe(outroTeste));
r = await chamar(tAli, `/auth/users/${db.prepare("SELECT id FROM users WHERE email='ali@aur.com'").get().id}`, { method: "DELETE" });
console.log(`   o próprio gestor: ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("8. E ninguém apaga cadastro de OUTRA imobiliária");
const outraOrg = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(outraOrg, "Vizinha", "VIZ-1", Date.now());
const deLa = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,'corretor',0,?,'pendente')`).run(deLa, outraOrg, "De outra casa", "x@viz.com", senha, Date.now());
r = await chamar(tAli, `/auth/users/${deLa}`, { method: "DELETE" });
console.log(`   ${r.status}`);
assert.equal(r.status, 404);
assert.ok(existe(deLa), "o cadastro da vizinha continua intacto");

console.log("\nTudo certo ✅");
process.exit(0);
