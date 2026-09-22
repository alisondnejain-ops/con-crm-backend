/* CARTÃO OBRIGATÓRIO NO TESTE DE 14 DIAS (22/09/2026, pedido do Ali:
   "sim temos um teste de 14 dias mas precisa SIM cadastrar o cartão de
   crédito").

   Até aqui o teste começava sozinho — no `set-password` — e ninguém pedia
   nada além de nome, e-mail e WhatsApp. Isso deixou de valer para quem entra
   pelas portas públicas do site: `orgs.exige_cartao` marca a conta, e o teste
   só começa (`trial_ate` só é gravado) quando o Asaas confirma que um cartão
   foi anexado à assinatura — nunca no cadastro, nunca no `set-password`.

   Este teste sobe o servidor de verdade e um Asaas DE MENTIRA (um servidor
   HTTP local, apontado por `ASAAS_API_URL`) para poder confirmar as duas
   pontas: o que o CRM manda para o Asaas (billingType, sempre CREDIT_CARD —
   22/09/2026) e o que o CRM faz com o que o Asaas responde (a conta trava até
   o cartão aparecer, e destrava sozinha quando ele aparece — tanto pelo
   webhook quanto pela checagem ao vivo de `GET /assinatura`).

   Rodar:  npm run teste:cartao-obrigatorio
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-cartao.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4629";
process.env.SITE_URL = "https://www.conhubcrm.com.br";
process.env.ASAAS_API_KEY = "$aact_test_chave_de_teste";
process.env.ASAAS_SANDBOX = "true";
process.env.ASAAS_WEBHOOK_TOKEN = "webhook-secreto-de-teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

/* ===== O ASAAS DE MENTIRA =====

   Só os quatro caminhos que este fluxo usa de verdade. `cobrancas` é o que
   decide o teste: por padrão a assinatura nasce SEM cartão (nenhum campo de
   cartão no primeiro pagamento), e o teste muda esse mapa na mão para
   simular o momento em que a pessoa termina de preencher o cartão na fatura
   hospedada — sem isso não dá para testar "antes" e "depois" sem uma conta
   real no Asaas. */
let contador = 0;
const cobrancas = new Map(); // assinaturaId -> array de "pagamentos" (formato do Asaas)
const billingTypes = []; // toda chamada de criar assinatura/parcelado, na ordem — para conferir CREDIT_CARD

const mockAsaas = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    const dados = corpo ? JSON.parse(corpo) : {};
    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && req.url === "/customers")
      return res.end(JSON.stringify({ id: "cus_" + (++contador) }));

    if (req.method === "POST" && req.url === "/subscriptions") {
      billingTypes.push({ tipo: "assinatura", billingType: dados.billingType });
      const id = "sub_" + (++contador);
      cobrancas.set(id, [{ id: "cob_" + contador, invoiceUrl: "https://mock.asaas/fatura/" + id }]);
      return res.end(JSON.stringify({ id }));
    }

    if (req.method === "POST" && req.url === "/payments") {
      billingTypes.push({ tipo: "parcelado", billingType: dados.billingType });
      const id = "pay_" + (++contador);
      return res.end(JSON.stringify({ id, invoiceUrl: "https://mock.asaas/fatura/" + id }));
    }

    const m = req.url.match(/^\/subscriptions\/([^/]+)\/payments$/);
    if (req.method === "GET" && m)
      return res.end(JSON.stringify({ data: cobrancas.get(m[1]) || [] }));

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "rota não simulada: " + req.method + " " + req.url }));
  });
});
await new Promise(r => mockAsaas.listen(0, "127.0.0.1", r));
process.env.ASAAS_API_URL = `http://127.0.0.1:${mockAsaas.address().port}`;

// "Anexa o cartão" na assinatura simulada — é o que o teste chama para virar a chave.
function anexarCartao(assinaturaId) {
  const lista = cobrancas.get(assinaturaId);
  lista[0].creditCard = { creditCardBrand: "VISA", creditCardNumber: "1234" };
}

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const BASE = "http://localhost:4629";
await new Promise(r => setTimeout(r, 700));

const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...(opts.headers || {}) } });

let n = 0;
const comecar = (corpo) => fetch(BASE + "/publico/comecar", {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++n}` },
  body: JSON.stringify(corpo) });

const tokenDoLink = (link) => new URL(link).searchParams.get("token");

async function definirSenha(link) {
  const r = await fetch(BASE + "/auth/set-password", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokenDoLink(link), password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `set-password falhou: ${JSON.stringify(d)}`);
  return d;
}

let r, d;

console.log("===== A CONTA NASCE MARCADA, NÃO EM TESTE =====");

console.log("1. /publico/comecar (autônomo) grava exige_cartao=1 e NÃO inicia o teste");
r = await comecar({ nome: "Bruno Corretor", email: "bruno@teste.com", telefone: "87 99111-1001" });
d = await r.json();
assert.equal(r.status, 201);
let org = db.prepare(`SELECT o.id, o.exige_cartao, o.trial_ate FROM orgs o
  JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'bruno@teste.com'`).get();
console.log(`   exige_cartao=${org.exige_cartao} · trial_ate=${org.trial_ate}`);
assert.equal(org.exige_cartao, 1);
assert.equal(org.trial_ate, null);

console.log("2. /publico/comecar (imobiliária) também");
r = await comecar({ nome: "Marta Gestora", email: "marta@teste.com", telefone: "87 99111-1002", tipo: "imobiliaria" });
d = await r.json();
assert.equal(r.status, 201);
const orgImob = db.prepare(`SELECT o.exige_cartao FROM orgs o
  JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'marta@teste.com'`).get();
assert.equal(orgImob.exige_cartao, 1);
console.log(`   exige_cartao=${orgImob.exige_cartao}`);

console.log("3. /auth/criar-imobiliaria — a porta MAIS ANTIGA — também marca");
/* Achado ao revisar a linkagem: comecar.html manda quem tem equipe para cá, e
   esta rota nunca tinha sido tocada pelo cartão obrigatório. Sem isto, a
   trava valeria por onde a pessoa entrou, e não pelo destino. */
r = await fetch(BASE + "/auth/criar-imobiliaria", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ imobiliaria: "Horizonte Imóveis", name: "Marta Horizonte", email: "horizonte@teste.com", phone: "87 99111-1003" }) });
d = await r.json();
assert.equal(r.status, 200);
const orgHorizonte = db.prepare(`SELECT o.exige_cartao FROM orgs o
  JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'horizonte@teste.com'`).get();
assert.equal(orgHorizonte.exige_cartao, 1);
console.log(`   exige_cartao=${orgHorizonte.exige_cartao}`);

console.log("\n===== SET-PASSWORD NÃO LIGA O RELÓGIO =====");

console.log("4. Criar a senha NÃO grava trial_ate para conta com exige_cartao");
r = await comecar({ nome: "Bruno Corretor", email: "bruno2@teste.com", telefone: "87 99111-1004" });
d = await r.json();
const login1 = await definirSenha(d.link);
const orgBruno2 = db.prepare(`SELECT o.id, o.trial_ate FROM orgs o WHERE o.dono_user_id = ?`).get(login1.user.id);
console.log(`   trial_ate após set-password: ${orgBruno2.trial_ate}`);
assert.equal(orgBruno2.trial_ate, null, "o teste não começa aqui — só quando o cartão for confirmado");

console.log("5. GET /assinatura devolve aguardando_cartao, com o link de plano");
r = await chamar(login1.token, "/assinatura");
d = await r.json();
console.log(`   status=${d.status} · motivo="${d.motivo}"`);
assert.equal(d.status, "aguardando_cartao");
assert.ok(/cart/i.test(d.motivo || ""));

console.log("6. E o porteiro bloqueia rota protegida com 402 (mesma trava do 'bloqueado')");
r = await chamar(login1.token, "/leads");
d = await r.json();
console.log(`   ${r.status} · bloqueado=${d.bloqueado}`);
assert.equal(r.status, 402);
assert.equal(d.bloqueado, true);

console.log("\n===== O ASAAS FORÇA CARTÃO — E O CRM CONFIA NO QUE ELE DIZ =====");

console.log("7. Escolher o plano (mesmo travado) manda billingType=CREDIT_CARD");
/* As rotas de plano ficam FORA do porteiro de propósito: é dali que a pessoa
   sai do aguardando_cartao. */
r = await chamar(login1.token, "/assinatura/plano", {
  method: "POST", body: JSON.stringify({ plano_id: "mensal", cpfCnpj: "11144477735" }) });
d = await r.json();
console.log(`   ${r.status} · ${JSON.stringify(billingTypes.at(-1))}`);
assert.equal(r.status, 200);
assert.equal(billingTypes.at(-1).billingType, "CREDIT_CARD");

const orgBrunoRow = db.prepare("SELECT asaas_subscription_id, asaas_customer_id FROM orgs WHERE id = ?").get(orgBruno2.id);
assert.ok(orgBrunoRow.asaas_subscription_id, "a assinatura foi criada no Asaas (de mentira)");

console.log("8. Sem cartão anexado ainda, GET /assinatura continua aguardando_cartao");
r = await chamar(login1.token, "/assinatura");
d = await r.json();
console.log(`   status=${d.status}`);
assert.equal(d.status, "aguardando_cartao");

console.log("9. Cartão anexado — a CHECAGEM AO VIVO de GET /assinatura destrava sozinha");
anexarCartao(orgBrunoRow.asaas_subscription_id);
r = await chamar(login1.token, "/assinatura");
d = await r.json();
console.log(`   status=${d.status} · dias=${d.dias}`);
assert.equal(d.status, "teste");
assert.equal(d.dias, 14);
const orgBrunoConfirmado = db.prepare("SELECT cartao_confirmado_em, trial_ate FROM orgs WHERE id = ?").get(orgBruno2.id);
assert.ok(orgBrunoConfirmado.cartao_confirmado_em, "cartao_confirmado_em foi gravado");
assert.ok(orgBrunoConfirmado.trial_ate, "e SÓ AGORA o teste começou a contar");

console.log("10. E a rota antes bloqueada agora responde normalmente");
r = await chamar(login1.token, "/leads");
console.log(`   ${r.status}`);
assert.notEqual(r.status, 402);

console.log("\n===== O MESMO CAMINHO, PELO WEBHOOK =====");

console.log("11. Uma segunda conta chega no mesmo ponto — mas confirma pelo WEBHOOK, não pelo GET");
r = await comecar({ nome: "Marta Imobiliária", email: "marta2@teste.com", telefone: "87 99111-1005", tipo: "imobiliaria" });
d = await r.json();
const login2 = await definirSenha(d.link);
r = await chamar(login2.token, "/assinatura/plano", {
  method: "POST", body: JSON.stringify({ plano_id: "essencial-mensal", cpfCnpj: "11144477735" }) });
d = await r.json();
assert.equal(r.status, 200);
const orgMarta2 = db.prepare("SELECT id, asaas_subscription_id FROM orgs WHERE dono_user_id = ?").get(login2.user.id);
anexarCartao(orgMarta2.asaas_subscription_id);

console.log("12. Webhook SEM o token correto é recusado");
r = await fetch(BASE + "/webhooks/asaas", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ event: "SUBSCRIPTION_UPDATED", subscription: { id: orgMarta2.asaas_subscription_id, subscription: orgMarta2.asaas_subscription_id } }) });
console.log(`   sem token: ${r.status}`);
assert.equal(r.status, 401);

console.log("13. Com o token certo, o webhook confirma o cartão de forma OPORTUNISTA");
/* `SUBSCRIPTION_UPDATED` não é um dos eventos que o sistema processa como
   pago/atrasado/cancelado — mas `interpretarEvento` devolve `acao:"ignorar"`
   com o `assinatura` mesmo assim (22/09/2026), e é exatamente esse caminho
   que `tentarConfirmarCartao` usa: qualquer evento da assinatura é uma
   chance de checar se o cartão já apareceu. */
r = await fetch(BASE + "/webhooks/asaas", {
  method: "POST", headers: { "content-type": "application/json", "asaas-access-token": process.env.ASAAS_WEBHOOK_TOKEN },
  body: JSON.stringify({ event: "SUBSCRIPTION_UPDATED", subscription: { id: "evt_1", subscription: orgMarta2.asaas_subscription_id } }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 200);

// O webhook responde 200 antes de processar (para a Uazapi... digo, o Asaas
// não reenviar por demora) — o processamento real acontece depois, async.
await new Promise(res => setTimeout(res, 300));
const orgMarta2Depois = db.prepare("SELECT cartao_confirmado_em, trial_ate FROM orgs WHERE id = ?").get(orgMarta2.id);
console.log(`   cartao_confirmado_em=${!!orgMarta2Depois.cartao_confirmado_em} · trial_ate=${!!orgMarta2Depois.trial_ate}`);
assert.ok(orgMarta2Depois.cartao_confirmado_em, "o webhook confirmou o cartão sem precisar de um GET /assinatura");
assert.ok(orgMarta2Depois.trial_ate);

console.log("\n===== A REDE DE SEGURANÇA =====");

console.log("14. Conta com pagamento já registrado nunca fica presa em aguardando_cartao");
/* Mesmo sem o Asaas ter confirmado cartão nenhum: se já existe pagamento, ele
   obviamente existe — pagamento nenhum acontece sem cartão. */
r = await comecar({ nome: "Caio Corretor", email: "caio@teste.com", telefone: "87 99111-1006" });
d = await r.json();
const login3 = await definirSenha(d.link);
const orgCaio = db.prepare("SELECT id FROM orgs WHERE dono_user_id = ?").get(login3.user.id);
db.prepare("INSERT INTO pagamentos (id,org_id,valor,pago_em,origem,created_at) VALUES (?,?,?,?,?,?)")
  .run("pg_teste_1", orgCaio.id, 297, Date.now(), "manual", Date.now());
r = await chamar(login3.token, "/assinatura");
d = await r.json();
console.log(`   status=${d.status}`);
assert.notEqual(d.status, "aguardando_cartao");

console.log("\n===== O PLANO ANUAL (PARCELADO) NÃO ESCAPA DO PAINEL =====");

console.log("15. Anual não grava asaas_subscription_id — mas asaas_ligado ainda assim fica true");
/* `criarParcelado` usa /payments, não /subscriptions, e por isso nunca grava
   asaas_subscription_id. O sinal certo é asaas_customer_id, que os dois
   caminhos gravam — é o que faz o painel manual de mensalidade (22/09/2026)
   sumir também para quem escolheu o anual. */
r = await comecar({ nome: "Rafa Anual", email: "rafa@teste.com", telefone: "87 99111-1007" });
d = await r.json();
const login4 = await definirSenha(d.link);
r = await chamar(login4.token, "/assinatura/plano", {
  method: "POST", body: JSON.stringify({ plano_id: "anual", cpfCnpj: "11144477735" }) });
d = await r.json();
console.log(`   escolheu anual: ${r.status} · ${JSON.stringify(billingTypes.at(-1))}`);
assert.equal(r.status, 200);
assert.equal(billingTypes.at(-1).tipo, "parcelado");
assert.equal(billingTypes.at(-1).billingType, "CREDIT_CARD");
const orgRafa = db.prepare("SELECT asaas_subscription_id, asaas_customer_id FROM orgs WHERE dono_user_id = ?").get(login4.user.id);
assert.equal(orgRafa.asaas_subscription_id, null, "o anual nunca grava assinatura — é parcelado");
assert.ok(orgRafa.asaas_customer_id, "mas o CLIENTE existe, e é o sinal que o painel usa");
r = await chamar(login4.token, "/assinatura");
d = await r.json();
console.log(`   asaas_ligado=${d.asaas_ligado}`);
assert.equal(d.asaas_ligado, true);

console.log("\nTudo certo ✅");
mockAsaas.close();
process.exit(0);
