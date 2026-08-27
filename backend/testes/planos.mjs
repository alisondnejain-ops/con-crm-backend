/* OS PLANOS DO CORRETOR AUTÔNOMO — mensal, semestral e anual.

   Pedido do Ali (27/08/2026): o corretor escolhe entre R$ 297/mês, R$ 247/mês
   no semestral e R$ 197/mês no anual em 12x, e vai direto para a tela de
   pagamento. Sem digitação do ConHub no meio.

   O que este teste tranca:

   - o PREÇO continua não vindo do cliente. Ele manda um `plano_id`; o valor
     sai da tabela do servidor. É a mesma trava de 27/08/2026, e ela precisa
     valer também no caminho novo, senão foi só mudar de porta;
   - a IMOBILIÁRIA não tem estes planos. O preço dela é combinado caso a caso;
   - QUANTOS MESES cada pagamento compra. Era um por linha, e o semestral
     quebrava isso: quem pagava seis meses era bloqueado no mês seguinte;
   - DAR BAIXA é de quem recebe. As quatro rotas que mexem no vencimento eram
     do dono da conta — que, num cliente, é o próprio cliente: um clique valia
     um mês de graça, e bloqueado o mesmo clique destravava a conta.

   Rodar:  npm run teste:planos
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-planos.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4626";
process.env.SITE_URL = "https://www.conhubcrm.com.br";
// Chave falsa: as chamadas ao Asaas não acontecem de verdade. O que este teste
// mede é quem pode o quê e quanto vale cada pagamento — tudo antes do Asaas.
process.env.ASAAS_API_KEY = "$aact_test_chave_de_teste";
process.env.ASAAS_SANDBOX = "true";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { situacao, registrarPagamento, recalcularVencimento } = await import("../src/services/assinatura.js");
const { PLANOS, planoPorId, mesesPagos, planosParaTela } = await import("../src/services/planos.js");
await import("../src/server.js");
const BASE = "http://localhost:4626";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

// A casa do master e a conta do autônomo.
const casa = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casa, "Casa do Master", "MST-1", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,'Ali','ali@hub.com',?,'adm',1,?,'ativo',1)`).run("u_" + randomUUID(), casa, senha, Date.now());

const orgAut = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo) VALUES (?,?,?,?,'autonomo')")
  .run(orgAut, "Bruno Imóveis", "BRU-1", Date.now());
const uBruno = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,phone,pass_hash,role,available,created_at,status)
  VALUES (?,?,'Bruno','bruno@ex.com','87999990000',?,'adm',1,?,'ativo')`).run(uBruno, orgAut, senha, Date.now());
db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(uBruno, orgAut);

// E uma imobiliária comum, para provar que ela NÃO vê estes planos.
const orgImob = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,valor_mensal) VALUES (?,?,?,?,?)")
  .run(orgImob, "Horizonte Imóveis", "HOR-1", Date.now(), 890);
const uGestor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,'Marta','marta@horizonte.com',?,'adm',1,?,'ativo')`).run(uGestor, orgImob, senha, Date.now());
db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(uGestor, orgImob);

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const tAli = await entrar("ali@hub.com");
const tBruno = await entrar("bruno@ex.com");
const tMarta = await entrar("marta@horizonte.com");
let r, d;

console.log("1. Os três planos que o Ali vendeu, com os preços que ele vendeu");
const porId = Object.fromEntries(PLANOS.map(p => [p.id, p]));
assert.equal(porId.mensal.mensal, 297);
assert.equal(porId.semestral.mensal, 247);
assert.equal(porId.anual.mensal, 197);
assert.equal(porId.semestral.total, 247 * 6, "o semestral cobra os seis meses de uma vez");
assert.equal(porId.anual.parcelas, 12, "o anual é 12x no cartão");
console.log(`   mensal ${porId.mensal.mensal} · semestral ${porId.semestral.mensal} (${porId.semestral.total} a cada 6) · anual ${porId.anual.mensal} em ${porId.anual.parcelas}x`);

console.log("2. A economia sai do servidor, não da tela");
/* Se o frontend calculasse, no dia em que um preço mudasse a tela mostraria
   uma economia que não bate com o preço ao lado dela. */
const tela = planosParaTela();
assert.equal(tela.find(p => p.id === "anual").economia_ano, (297 - 197) * 12);
assert.equal(tela.find(p => p.id === "mensal").economia_ano, 0);
console.log(`   anual economiza R$ ${tela.find(p => p.id === "anual").economia_ano} por ano`);

console.log("3. O autônomo vê os planos");
r = await chamar(tBruno, "/assinatura/planos");
d = await r.json();
console.log(`   ${r.status} · ${d.planos.length} planos · atual: ${d.atual}`);
assert.equal(r.status, 200);
assert.equal(d.planos.length, 3);
assert.equal(d.atual, null, "ainda não escolheu nenhum");

console.log("4. A IMOBILIÁRIA não vê — o preço dela é outro");
r = await chamar(tMarta, "/assinatura/planos");
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 404);
assert.ok(/combinado com o ConHub/i.test(d.error), "a recusa explica por quê");
r = await chamar(tMarta, "/assinatura/plano", { method: "POST", body: JSON.stringify({ plano_id: "anual", cpfCnpj: "11144477735" }) });
console.log(`   e contratar também: ${r.status}`);
assert.equal(r.status, 404);

console.log("5. Plano que não existe é recusado — o preço NUNCA vem do cliente");
r = await chamar(tBruno, "/assinatura/plano", { method: "POST", body: JSON.stringify({ plano_id: "camarote", cpfCnpj: "11144477735", valor: 1 }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
assert.equal(db.prepare("SELECT valor_mensal FROM orgs WHERE id=?").get(orgAut).valor_mensal, null,
  "nada foi gravado a partir do que o cliente mandou");

console.log("6. CPF com menos de 11 dígitos não passa");
r = await chamar(tBruno, "/assinatura/plano", { method: "POST", body: JSON.stringify({ plano_id: "mensal", cpfCnpj: "1234" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
assert.ok(/11 d/i.test(d.error));

console.log("7. Com plano e CPF válidos, a rota passa das validações e vai ao Asaas");
/* Sem Asaas de verdade a chamada falha (502) — o que importa é que ela falhou
   FALANDO com o Asaas, e não parou numa validação nossa. */
r = await chamar(tBruno, "/assinatura/plano", { method: "POST", body: JSON.stringify({ plano_id: "semestral", cpfCnpj: "111.444.777-35" }) });
d = await r.json();
console.log(`   ${r.status} · ${String(d.error).slice(0, 60)}`);
assert.ok(r.status === 502 || r.status === 200, `parou antes do Asaas com ${r.status}: ${d.error}`);

console.log("8. O CPF é conferido por DÍGITO, não por tamanho do texto");
/* "111.444.777-35" tem 14 caracteres — do tamanho de um CNPJ. Uma conferência
   feita no texto cru aceitaria qualquer coisa pontuada. */
assert.equal("111.444.777-35".length, 14);
assert.equal("111.444.777-35".replace(/\D/g, "").length, 11);
console.log("   14 caracteres, 11 dígitos — e o servidor lê os dígitos");

console.log("9. Quantos MESES cada pagamento compra");
assert.equal(mesesPagos("mensal", 297), 1);
assert.equal(mesesPagos("semestral", 1482), 6, "o semestral compra seis de uma vez");
assert.equal(mesesPagos("anual", 197), 1, "cada parcela do anual compra um mês");
assert.equal(mesesPagos("anual", 2364), 12, "e à vista compra os doze");
assert.equal(mesesPagos(null, 890), 1, "sem plano (imobiliária) continua sendo um");
console.log("   297→1 · 1482→6 · 197→1 · 2364→12 · sem plano→1");

console.log("10. Pagamento a menor ainda vale um mês, nunca zero");
/* Cortesia de R$ 1 ou pagamento parcial não pode creditar zero: o cliente
   pagaria e continuaria bloqueado. */
assert.equal(mesesPagos("semestral", 1), 1);
assert.equal(mesesPagos("anual", 10000), 12, "e nunca mais que o plano inteiro");
console.log("   R$ 1 no semestral → 1 mês · R$ 10.000 no anual → 12 (o teto do plano)");

console.log("11. Na prática: quem paga o semestral ganha SEIS meses de vencimento");
const orgSem = "org_" + randomUUID().slice(0, 8);
const base = new Date("2026-09-10T12:00:00").getTime();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo,plano_id,vence_em,vence_base) VALUES (?,?,?,?,'autonomo','semestral',?,?)")
  .run(orgSem, "Semestral", "SEM-1", Date.now(), base, base);
registrarPagamento(orgSem, { valor: 1482, origem: "asaas", asaasId: "pay_1" });
let venc = db.prepare("SELECT vence_em FROM orgs WHERE id=?").get(orgSem).vence_em;
console.log(`   pagou R$ 1.482 → vence ${new Date(venc).toLocaleDateString("pt-BR")}`);
assert.equal(new Date(venc).getMonth(), 2, "setembro + 6 meses = março");
assert.equal(new Date(venc).getFullYear(), 2027);

console.log("12. E apagar esse pagamento devolve os seis meses de uma vez");
const pg = db.prepare("SELECT id FROM pagamentos WHERE org_id=?").get(orgSem);
db.prepare("DELETE FROM pagamentos WHERE id=?").run(pg.id);
venc = recalcularVencimento(orgSem);
console.log(`   volta para ${new Date(venc).toLocaleDateString("pt-BR")}`);
assert.equal(new Date(venc).getMonth(), 8, "de volta a setembro");

console.log("13. O anual em 12 parcelas fecha os doze meses");
const orgAno = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo,plano_id,vence_em,vence_base) VALUES (?,?,?,?,'autonomo','anual',?,?)")
  .run(orgAno, "Anual", "ANO-1", Date.now(), base, base);
for (let i = 1; i <= 12; i++) registrarPagamento(orgAno, { valor: 197, origem: "asaas", asaasId: "parc_" + i });
venc = db.prepare("SELECT vence_em FROM orgs WHERE id=?").get(orgAno).vence_em;
console.log(`   12 parcelas de R$ 197 → vence ${new Date(venc).toLocaleDateString("pt-BR")}`);
assert.equal(new Date(venc).getFullYear(), 2027);
assert.equal(new Date(venc).getMonth(), 8, "setembro do ano seguinte");

console.log("14. Linha antiga, sem o campo `meses`, continua valendo 1");
/* Migração: os pagamentos que já estavam no banco não têm o campo, e não podem
   passar a valer zero mês da noite para o dia. */
const orgVelho = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,vence_em,vence_base) VALUES (?,?,?,?,?,?)")
  .run(orgVelho, "Antiga", "ANT-1", Date.now(), base, base);
db.prepare(`INSERT INTO pagamentos (id,org_id,valor,pago_em,origem,created_at) VALUES (?,?,?,?,'manual',?)`)
  .run("pg_velho", orgVelho, 890, Date.now(), Date.now());
venc = recalcularVencimento(orgVelho);
console.log(`   um pagamento sem \`meses\` → ${new Date(venc).toLocaleDateString("pt-BR")}`);
assert.equal(new Date(venc).getMonth(), 9, "setembro + 1 mês = outubro");

console.log("15. O CLIENTE não dá baixa em pagamento — nem no dele");
/* Era o furo: a rota é `soDono`, e num cliente o dono é ele mesmo. Um clique
   em "Registrar pagamento" valia um mês de graça, quantas vezes quisesse. */
r = await chamar(tBruno, "/assinatura/pagar", { method: "POST", body: JSON.stringify({}) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 403);
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id=?").get(orgAut).n, 0,
  "nenhum pagamento foi criado");

console.log("16. Nem apaga, nem corrige, nem reorganiza");
for (const [metodo, caminho] of [["DELETE", "/assinatura/pagamentos/pg_velho"],
                                 ["PATCH", "/assinatura/pagamentos/pg_velho"],
                                 ["POST", "/assinatura/reorganizar"]]) {
  r = await chamar(tBruno, caminho, { method: metodo, body: JSON.stringify({}) });
  console.log(`   ${metodo} ${caminho} → ${r.status}`);
  assert.equal(r.status, 403, `${caminho} deixou o cliente mexer no vencimento`);
}

console.log("17. O gestor da IMOBILIÁRIA também não — a trava não é só do autônomo");
r = await chamar(tMarta, "/assinatura/pagar", { method: "POST", body: JSON.stringify({}) });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("18. Mas o MASTER dá baixa normalmente");
r = await chamar(tAli, `/orgs/${orgAut}/entrar`, { method: "POST" });
const tAliNaConta = (await r.json()).token;
r = await chamar(tAliNaConta, "/assinatura/pagar", { method: "POST", body: JSON.stringify({ valor: 297 }) });
d = await r.json();
console.log(`   ${r.status} · ${d.pagamentos.length} pagamento(s) registrado(s)`);
assert.equal(r.status, 200);
assert.equal(d.pagamentos.length, 1);

console.log("19. E o cliente continua VENDO o histórico — é o extrato dele");
r = await chamar(tBruno, "/assinatura/pagamentos");
d = await r.json();
console.log(`   ${r.status} · ${d.pagamentos.length} pagamento(s) à vista`);
assert.equal(r.status, 200);
assert.equal(d.pagamentos.length, 1);

console.log("20. A situação diz qual plano está valendo e se ele renova sozinho");
db.prepare("UPDATE orgs SET plano_id='anual' WHERE id=?").run(orgAut);
const s = situacao(orgAut, { dono: true });
console.log(`   plano: ${s.plano_nome} · renova sozinho: ${s.plano_renova}`);
assert.equal(s.plano_nome, "Anual");
assert.equal(s.plano_renova, false, "o anual é parcelado, não renova sozinho — e a tela precisa dizer isso");
db.prepare("UPDATE orgs SET plano_id='mensal' WHERE id=?").run(orgAut);
assert.equal(situacao(orgAut, { dono: true }).plano_renova, true);

console.log("21. Quem não é dono não recebe o plano na resposta");
/* Mesma régua do valor: o outro gestor da casa não precisa saber o que se
   paga aqui. */
const semDono = situacao(orgAut, { dono: false });
assert.equal(semDono.plano_nome, undefined);
assert.equal(semDono.valor, undefined);
console.log("   só o estado, sem plano nem valor");

console.log("\nTudo certo ✅");
process.exit(0);
