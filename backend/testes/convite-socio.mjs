/* O convite de SÓCIO da plataforma — a conta master.

   Pedido do Ali (26/08/2026). Antes só havia duas portas: `/cadastro?c=CODIGO`,
   que põe alguém dentro de UMA imobiliária, e a variável `MASTER_EMAIL` no
   servidor, que promove uma conta já existente. Sócio novo exigia mexer na
   configuração da hospedagem.

   O que este teste protege, e o mais importante vem primeiro:

   - o convite é NOMINAL e de uso único, não um código repassável. O master vê
     todas as imobiliárias, os clientes de todas elas e o que cada uma paga:
     link encaminhável que cria super-administrador é outra categoria de risco;
   - quem convida precisa SER master. Gestor de imobiliária não fabrica sócio;
   - e-mail que já é de alguém da equipe é RECUSADO em vez de virar master —
     promover o corretor por causa de um e-mail digitado errado é o pior
     desfecho possível desta tela;
   - o sócio convidado entra DIRETO ao definir a senha. Sem isto ele cairia em
     "aguardando aprovação" dentro de uma imobiliária qualquer e ficaria preso
     lá para sempre, porque o master não aparece na lista de equipe — que é
     onde o gestor aprova. Convite que não dá para aceitar nem recusar;
   - o último sócio ativo não pode ser removido, senão ninguém mais cria
     imobiliária nem convida sócio.

   Rodar:  npm run teste:socio
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-socio.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4617";
process.env.SITE_URL = "https://www.conhubcrm.com.br";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4617";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

const org = (nome, codigo) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, nome, codigo, Date.now());
  return id; };
const user = (orgId, nome, email, role, master = 0) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, orgId, nome, email, senha, role, Date.now(), master);
  return id; };

const alfa = org("Imobiliária Alfa", "ALFA-1"), beta = org("Imobiliária Beta", "BETA-1");
user(alfa, "Ali", "ali@conhub.com", "adm", 1);          // sócio fundador
user(alfa, "Gestor da Alfa", "gestor@alfa.com", "adm", 0);
user(beta, "Marina", "marina@beta.com", "corretor", 0);

async function entrar(email, pass = "123456") {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: pass }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const tAli = await entrar("ali@conhub.com"), tGestor = await entrar("gestor@alfa.com");

console.log("1. Só quem JÁ é sócio convida sócio");
/* Se o gestor de uma imobiliária pudesse convidar, ele fabricaria para si um
   acesso à base de todos os concorrentes que usam a plataforma. */
let r = await chamar(tGestor, "/orgs/masters", { method: "POST",
  body: JSON.stringify({ nome: "Invasor", email: "invasor@x.com" }) });
console.log(`   gestor de imobiliária: ${r.status}`);
assert.equal(r.status, 403);
r = await fetch(`${BASE}/orgs/masters`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ nome: "Ninguém", email: "n@x.com" }) });
console.log(`   sem login: ${r.status}`);
assert.equal(r.status, 401);

console.log("2. O sócio convida, e o LINK volta na resposta");
/* O link volta sempre, mesmo com e-mail ligado: é ele que o Ali manda no
   WhatsApp enquanto o Resend não está contratado. */
r = await chamar(tAli, "/orgs/masters", { method: "POST",
  body: JSON.stringify({ nome: "Sócia Nova", email: "socia@conhub.com" }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.link} · vale ${d.horas}h`);
assert.equal(r.status, 200);
assert.ok(/^https:\/\/www\.conhubcrm\.com\.br\/definir-senha\?token=/.test(d.link), "o link sai no endereço público");
assert.equal(d.horas, 48);
const link = d.link, token = link.split("token=")[1];

console.log("3. O convite é NOMINAL: nasce preso àquele e-mail");
const convidada = db.prepare("SELECT * FROM users WHERE email = ?").get("socia@conhub.com");
console.log(`   ${convidada.name} · master=${convidada.master} · status=${convidada.status}`);
assert.equal(convidada.master, 1);
assert.equal(convidada.status, "pendente", "ainda não é conta: é convite");
assert.ok(convidada.invite_token, "com token de uso único");

console.log("4. E-mail de quem JÁ é da equipe é recusado, não promovido");
/* O pior desfecho possível seria digitar o e-mail da Marina e transformar a
   corretora dela em administradora da plataforma inteira, em silêncio. */
r = await chamar(tAli, "/orgs/masters", { method: "POST",
  body: JSON.stringify({ nome: "Marina", email: "marina@beta.com" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.equal(db.prepare("SELECT master FROM users WHERE email=?").get("marina@beta.com").master, 0,
  "a corretora continua sendo só corretora");

console.log("5. Definindo a senha, o sócio entra DIRETO — sem fila de aprovação");
/* Sem isto ele cairia em "aguardando aprovação" numa imobiliária qualquer, e
   ficaria preso: o master não aparece na lista de equipe, que é onde se aprova. */
r = await fetch(`${BASE}/auth/set-password`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, password: "senhaforte1" }) });
d = await r.json();
console.log(`   ${r.status} · aguardando aprovação? ${!!d.aguardandoAprovacao} · master no crachá? ${d.user && d.user.master}`);
assert.equal(r.status, 200);
assert.ok(!d.aguardandoAprovacao, "o convite do sócio JÁ é a aprovação");
assert.ok(d.token, "sai daqui logado");
assert.equal(d.user.master, true);

console.log("6. O link é de uso único");
r = await fetch(`${BASE}/auth/set-password`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, password: "outrasenha" }) });
console.log(`   usar de novo: ${r.status} · ${(await r.json()).error}`);
assert.ok(r.status >= 400, "token queimado não serve duas vezes");

console.log("7. A sócia nova enxerga o hub das imobiliárias");
const tSocia = await entrar("socia@conhub.com", "senhaforte1");
d = await (await chamar(tSocia, "/orgs")).json();
console.log(`   ${d.orgs.length} imobiliária(s): ${d.orgs.map(o => o.nome).join(", ")}`);
/* O ambiente de teste já nasce com a org do bootstrap, então o que importa
   não é o total: é que a sócia enxerga imobiliárias em que ela nunca entrou. */
const vistas = d.orgs.map(o => o.nome);
assert.ok(vistas.includes("Imobiliária Alfa") && vistas.includes("Imobiliária Beta"),
  "sócio vê a plataforma inteira, não só a casa onde a conta dele foi criada");

console.log("8. E aparece na lista de sócios, sem poluir a equipe da imobiliária");
d = await (await chamar(tAli, "/orgs/masters")).json();
console.log(`   sócios: ${d.masters.map(m => m.name).join(", ")}`);
assert.deepEqual(d.masters.map(m => m.name).sort(), ["Ali", "Sócia Nova"]);
const equipe = await (await chamar(tGestor, "/auth/users")).json();
const nomes = (equipe.users || equipe).map(u => u.name);
console.log(`   equipe da Alfa: ${nomes.join(", ")}`);
assert.ok(!nomes.includes("Sócia Nova"), "sócio não vira gente da imobiliária");
assert.ok(!nomes.includes("Ali"), "nem o que já existia");

console.log("9. Convite repetido para quem já é sócio ATIVO é recusado");
r = await chamar(tAli, "/orgs/masters", { method: "POST",
  body: JSON.stringify({ nome: "Sócia Nova", email: "socia@conhub.com" }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 409);

console.log("10. E-mail inválido e nome vazio são recusados");
for (const corpo of [{ nome: "Fulano", email: "nao-e-email" }, { nome: "", email: "x@y.com" }]) {
  r = await chamar(tAli, "/orgs/masters", { method: "POST", body: JSON.stringify(corpo) });
  console.log(`   ${JSON.stringify(corpo)} → ${r.status}`);
  assert.equal(r.status, 400);
}

console.log("11. Tirar o crachá de sócio não apaga a conta");
r = await chamar(tAli, `/orgs/masters/${db.prepare("SELECT id FROM users WHERE email=?").get("socia@conhub.com").id}`,
  { method: "DELETE" });
d = await r.json();
const depois = db.prepare("SELECT master,status FROM users WHERE email=?").get("socia@conhub.com");
console.log(`   ${r.status} · master=${depois.master} · status=${depois.status}`);
assert.equal(r.status, 200);
assert.equal(depois.master, 0);
assert.equal(depois.status, "ativo", "a conta continua existindo, com o histórico dela");

console.log("12. O ÚLTIMO sócio ativo não pode ser removido");
/* Sem esta trava a plataforma fica sem ninguém que possa criar imobiliária ou
   convidar sócio — e não há caminho de volta pela tela. */
const idAli = db.prepare("SELECT id FROM users WHERE email=?").get("ali@conhub.com").id;
r = await chamar(tAli, `/orgs/masters/${idAli}`, { method: "DELETE" });
console.log(`   ele mesmo: ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400, "e ninguém tira o próprio acesso por acidente");

console.log("\nTudo certo ✅");
process.exit(0);
