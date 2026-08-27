/* A conta do CORRETOR AUTÔNOMO — a imobiliária de um corretor só.

   Pedido do Ali (26/08/2026). Por dentro é uma org como qualquer outra, e é
   por isso que ela saiu barata: WhatsApp próprio, kanban, funil, IA,
   expediente, importação de leads e mensalidade já existiam. O que muda é o
   TAMANHO da casa, e é isso que este teste tranca:

   - só UM atendente, e nenhum corretor além do titular. A conta é uma org, e
     sem trava o link de cadastro montaria uma equipe inteira numa assinatura
     vendida como individual;
   - o TESTE DE 14 DIAS começa quando a conta é EFETIVADA, não quando é criada.
     Criar na segunda e mandar o link na quinta não pode custar três dias a
     quem ainda nem tinha entrado;
   - acabado o teste sem pagamento, o CRM TRAVA — é o "pagou libera, não pagou
     trava". E o master destrava com um botão, sem esperar vencimento;
   - o autônomo aparece numa lista SEPARADA no hub: são perguntas diferentes.

   Rodar:  npm run teste:autonomo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-autonomo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4623";
process.env.SITE_URL = "https://www.conhubcrm.com.br";
/* Chave falsa de sandbox: sem ela a rota para no "Asaas não configurado" antes
   de chegar nas validações, e o que este teste precisa checar é justamente
   quem preenche o quê. A chamada ao Asaas em si não acontece — o teste para
   antes, ou o provedor recusa, e as duas coisas servem. */
process.env.ASAAS_API_KEY = "$aact_test_chave_de_teste";
process.env.ASAAS_SANDBOX = "true";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { situacao } = await import("../src/services/assinatura.js");
await import("../src/server.js");
const BASE = "http://localhost:4623";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

const casa = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casa, "Casa do Master", "MST-1", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,'Ali','ali@hub.com',?,'adm',1,?,'ativo',1)`).run("u_" + randomUUID(), casa, senha, Date.now());

async function entrar(email, pass = "123456") {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: pass }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });
const publico = (caminho, corpo) => fetch(BASE + caminho, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });

const tAli = await entrar("ali@hub.com");

console.log("1. O master cria a conta do autônomo e recebe o link");
let r = await chamar(tAli, "/orgs/autonomos", { method: "POST",
  body: JSON.stringify({ nome: "Bruno Corretor", email: "bruno@corretor.com", marca: "Bruno Imóveis" }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.org.nome} (${d.org.codigo}) · teste de ${d.dias} dias`);
assert.equal(r.status, 200);
assert.equal(d.org.tipo, "autonomo");
assert.equal(d.dias, 14);
const orgId = d.org.id, codigo = d.org.codigo, token = d.link.split("token=")[1];

console.log("2. O relógio do teste NÃO começou ainda");
/* Pedido do Ali: começa quando a conta está efetivada. Se começasse aqui, o
   corretor perderia os dias entre a criação e o momento em que abre o link. */
console.log(`   trial_ate: ${db.prepare("SELECT trial_ate FROM orgs WHERE id=?").get(orgId).trial_ate}`);
assert.equal(db.prepare("SELECT trial_ate FROM orgs WHERE id=?").get(orgId).trial_ate, null);

console.log("3. Ele define a senha e entra DIRETO como gestor da própria conta");
r = await publico("/auth/set-password", { token, password: "senhaboa1" });
d = await r.json();
console.log(`   ${r.status} · papel: ${d.user.funcao} · aguardando aprovação? ${!!d.aguardandoAprovacao}`);
assert.equal(r.status, 200);
assert.equal(d.user.role, "adm", "ele é o gestor da casa dele");
assert.ok(!d.aguardandoAprovacao, "não há quem aprove numa casa que acabou de nascer");

console.log("4. AGORA o teste começou, e a conta sabe quantos dias faltam");
const s1 = situacao(orgId);
console.log(`   status: ${s1.status} · faltam ${s1.dias} dia(s) · é teste? ${!!s1.teste}`);
assert.equal(s1.status, "teste");
assert.equal(s1.teste, true);
assert.equal(s1.dias, 14);

console.log("5. A contagem regressiva anda sozinha");
/* É o que alimenta a barra no painel dele: "faltam 14", "faltam 13"… */
const puxar = (dias) => db.prepare("UPDATE orgs SET trial_ate = ? WHERE id = ?")
  .run(Date.now() + dias * 86400000, orgId);
for (const d2 of [13, 7, 1, 0]) {
  puxar(d2);
  console.log(`   trial_ate em ${d2} dia(s) → a tela diz: faltam ${situacao(orgId).dias}`);
  assert.equal(situacao(orgId).dias, d2);
  assert.equal(situacao(orgId).status, "teste", "no último dia ainda é teste, não bloqueio");
}

console.log("6. Terminado o teste sem pagamento, o CRM TRAVA");
puxar(-1);
const s2 = situacao(orgId);
console.log(`   ${s2.status} · ${s2.motivo}`);
assert.equal(s2.status, "bloqueado");
const tBruno = await entrar("bruno@corretor.com", "senhaboa1");
r = await chamar(tBruno, "/leads");
console.log(`   e as rotas cobradas respondem: ${r.status}`);
assert.equal(r.status, 402, "o porteiro barra a conta bloqueada");

console.log("7. O master destrava com um botão");
r = await chamar(tAli, `/orgs/autonomos/${orgId}/liberar`, { method: "POST", body: JSON.stringify({ dias: 30 }) });
console.log(`   ${r.status} · ${situacao(orgId).status} · faltam ${situacao(orgId).dias}`);
assert.equal(r.status, 200);
assert.equal(situacao(orgId).status, "teste");
assert.equal((await (await chamar(tBruno, "/leads")).json()).error, undefined, "voltou a funcionar");

console.log("8. E trava de novo, também com um botão");
r = await chamar(tAli, `/orgs/autonomos/${orgId}/liberar`, { method: "POST", body: JSON.stringify({ dias: -1 }) });
console.log(`   ${r.status} · ${situacao(orgId).status}`);
assert.equal(situacao(orgId).status, "bloqueado");
await chamar(tAli, `/orgs/autonomos/${orgId}/liberar`, { method: "POST", body: JSON.stringify({ dias: 30 }) });

console.log("9. A conta aceita UM atendente");
r = await publico("/auth/register", { name: "Ana Atendente", email: "ana@corretor.com",
  phone: "87999990000", adm_code: codigo, funcao: "atendente" });
console.log(`   primeiro atendente: ${r.status}`);
assert.equal(r.status, 200);

console.log("10. O segundo é recusado, com a razão escrita");
r = await publico("/auth/register", { name: "Outra", email: "outra@corretor.com",
  phone: "87999990001", adm_code: codigo, funcao: "atendente" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.ok(/até um/i.test(d.error));

console.log("11. E corretor não entra: o corretor é ele");
r = await publico("/auth/register", { name: "Colega", email: "colega@corretor.com",
  phone: "87999990002", adm_code: codigo, funcao: "corretor" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 403);

console.log("12. Numa IMOBILIÁRIA nada disso muda");
/* A trava é do tipo de conta, não do sistema: quem paga por equipe continua
   montando equipe sem esbarrar em nada. */
r = await chamar(tAli, "/orgs", { method: "POST", body: JSON.stringify({ nome: "Imobiliária Grande" }) });
const grande = (await r.json()).org;
for (const [nome, funcao] of [["C1", "corretor"], ["C2", "corretor"], ["A1", "atendente"], ["A2", "atendente"]]) {
  const resp = await publico("/auth/register", { name: nome, email: `${nome.toLowerCase()}@grande.com`,
    phone: "8799999" + Math.floor(1000 + Math.random() * 8999), adm_code: grande.codigo, funcao });
  assert.equal(resp.status, 200, `${nome} (${funcao}) foi barrado numa imobiliária`);
}
console.log("   4 pessoas entraram na imobiliária, sem trava");

console.log("13. No hub, autônomo e imobiliária vêm em listas separadas");
d = await (await chamar(tAli, "/orgs")).json();
console.log(`   imobiliárias: ${d.orgs.map(o => o.nome).join(", ")}`);
console.log(`   autônomos: ${d.autonomos.map(o => `${o.nome} (${o.assinatura.status})`).join(", ")}`);
assert.ok(d.autonomos.some(o => o.id === orgId));
assert.ok(!d.orgs.some(o => o.id === orgId), "o autônomo não polui a lista de imobiliárias");
assert.ok(d.orgs.some(o => o.nome === "Imobiliária Grande"));

console.log("14. Só o master cria e libera conta de autônomo");
const tAna = await (async () => {
  const u = db.prepare("SELECT invite_token FROM users WHERE email='ana@corretor.com'").get();
  await publico("/auth/set-password", { token: u.invite_token, password: "senhaana1" });
  db.prepare("UPDATE users SET status='ativo' WHERE email='ana@corretor.com'").run();
  return entrar("ana@corretor.com", "senhaana1");
})();
r = await chamar(tAna, "/orgs/autonomos", { method: "POST",
  body: JSON.stringify({ nome: "X", email: "x@y.com" }) });
console.log(`   atendente tentando criar: ${r.status}`);
assert.equal(r.status, 403);
r = await chamar(tAna, `/orgs/autonomos/${orgId}/liberar`, { method: "POST", body: JSON.stringify({ dias: 999 }) });
console.log(`   atendente tentando liberar: ${r.status}`);
assert.equal(r.status, 403);

console.log("15. O cliente ativa a assinatura SOZINHO, digitando um campo só");
/* Antes esta rota exigia nome, e-mail, telefone e valor. Nome, e-mail e
   telefone o CRM já tem — pedi-los de novo transformava cada cliente novo numa
   digitação do Ali. Sobra o CPF/CNPJ, que o sistema não tem. */
db.prepare("UPDATE orgs SET valor_mensal = 97 WHERE id = ?").run(orgId);
r = await chamar(tBruno, "/assinatura");
d = await r.json();
console.log(`   a tela dele mostra a mensalidade: R$ ${d.valor_mensal}`);
assert.equal(d.valor_mensal, 97, "o preço combinado chega à tela antes de existir fatura");

r = await chamar(tBruno, "/assinatura/asaas", { method: "POST", body: JSON.stringify({}) });
d = await r.json();
console.log(`   sem CPF: ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
assert.ok(/CPF/i.test(d.error), "o unico campo que falta e dito pelo nome");

console.log("16. E NAO escolhe quanto paga");
/* Era um furo: o valor vinha do formulario. Quem ativasse a propria assinatura
   escolheria o proprio preco. Agora o servidor usa o que esta gravado na conta
   e ignora o que veio do cliente. */
r = await chamar(tBruno, "/assinatura/asaas", { method: "POST",
  body: JSON.stringify({ cpfCnpj: "12345678909", valor: 1 }) });
d = await r.json();
/* Sem ASAAS_API_KEY o servidor para antes de chamar o Asaas — o que este teste
   precisa provar e que ele NAO parou por falta de valor nem aceitou o 1. */
console.log(`   ${r.status} · passou das validações e foi falar com o Asaas`);
assert.ok(r.status === 502 || r.status === 200,
  `deveria ter chegado ao Asaas; parou antes com ${r.status}: ${d.error}`);
assert.equal(db.prepare("SELECT valor_mensal FROM orgs WHERE id=?").get(orgId).valor_mensal, 97,
  "o valor da conta nao foi trocado pelo que o cliente mandou");

console.log("17. Conta sem preco definido nao deixa ativar — e explica");
const semPreco = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo) VALUES (?,?,?,?,'autonomo')")
  .run(semPreco, "Sem Preco", "SP-1", Date.now());
const uSem = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,'Sem Preco','sem@preco.com',?,'adm',1,?,'ativo')`).run(uSem, semPreco, senha, Date.now());
db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(uSem, semPreco);
const tSem = await entrar("sem@preco.com");
r = await chamar(tSem, "/assinatura/asaas", { method: "POST", body: JSON.stringify({ cpfCnpj: "12345678909" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
assert.ok(/valor da mensalidade ainda/i.test(d.error));

console.log("18. E o cliente não baixa o próprio preço por outro caminho");
/* O furo não estava na tela de ativar: estava um passo antes. A rota de
   configurar o plano é do "dono da conta", e num cliente o dono é ele mesmo —
   dava para gravar valor_mensal = 1 e só então ativar a cobrança. */
r = await chamar(tBruno, "/assinatura", { method: "PATCH", body: JSON.stringify({ valor_mensal: 1 }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 403);
assert.equal(db.prepare("SELECT valor_mensal FROM orgs WHERE id=?").get(orgId).valor_mensal, 97,
  "o preço continua o que o ConHub combinou");

console.log("19. Mas ele ainda troca o NOME do plano, que é só rótulo");
r = await chamar(tBruno, "/assinatura", { method: "PATCH", body: JSON.stringify({ plano: "Meu plano" }) });
console.log(`   ${r.status} · plano: ${db.prepare("SELECT plano FROM orgs WHERE id=?").get(orgId).plano}`);
assert.equal(r.status, 200);

console.log("20. E o MASTER define o preço normalmente");
r = await chamar(tAli, `/orgs/${orgId}/entrar`, { method: "POST" });
const tAliNaConta = (await r.json()).token;
r = await chamar(tAliNaConta, "/assinatura", { method: "PATCH", body: JSON.stringify({ valor_mensal: 147 }) });
console.log(`   ${r.status} · agora R$ ${db.prepare("SELECT valor_mensal FROM orgs WHERE id=?").get(orgId).valor_mensal}`);
assert.equal(r.status, 200);
assert.equal(db.prepare("SELECT valor_mensal FROM orgs WHERE id=?").get(orgId).valor_mensal, 147);

console.log("\nTudo certo ✅");
process.exit(0);
