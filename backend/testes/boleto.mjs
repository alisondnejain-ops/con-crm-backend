/* BOLETO SÓ NAS CONTAS QUE O MASTER LIBERA (15/10/2026, pedido do Ali: "a
   conta do Eleandro, que é corretor autônomo, coloca para ele gerar um boleto
   para fazer o pagamento do plano dele… cliente entra em contato com o suporte
   e a gente libera a opção de boleto para ele").

   Sobe o servidor e um Asaas e um Pagar.me de mentira. O que se prova:
    1. Sem a liberação, o cliente não gera boleto (403) e a tela diz que não
       está liberado; só o master liga e desliga — o cliente não se libera.
    2. Asaas: o boleto sai com BOLETO, o valor do PLANO (do servidor, não do
       corpo), o vencimento em 3 dias, a linha digitável e o endereço.
    3. Clicar de novo no mesmo plano devolve o mesmo boleto; outro plano
       cancela o anterior no provedor.
    4. Pago (aviso do Asaas): credita os meses do plano, troca o plano,
       destrava a conta; repetido não credita duas vezes; vai pelo boleto, não
       pelo consolo de "imobiliária única".
    5. Estorno tira o período e o vencimento volta.
    6. Conta com cartão cobrando: o boleto é recusado (seria cobrança dupla).
    7. Pagar.me: pede endereço uma vez, grava no cliente, gera o pedido de
       boleto; o aviso de pago credita (conferindo a cobrança na API).
    8. Preço combinado: um mês da mensalidade combinada.
    9. Apagar a conta cancela o boleto em aberto no provedor.

   Rodar:  npm run teste:boleto
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-boleto.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4693";
process.env.ASAAS_API_KEY = "$aact_test_chave_de_teste";
process.env.ASAAS_SANDBOX = "true";
process.env.ASAAS_WEBHOOK_TOKEN = "webhook-boleto";
process.env.PAGARME_SECRET_KEY = "sk_test_boleto";
process.env.PAGARME_PUBLIC_KEY = "pk_test_boleto";
process.env.MARKETING_AGENDADOR = "0";
process.env.SITE_DOMINIO_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.FOTOS_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const servir = (trata) => http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const responde = (st, x) => { res.statusCode = st; res.end(JSON.stringify(x)); };
    trata(req, corpo ? JSON.parse(corpo) : {}, responde);
  });
});

// ===== O ASAAS DE MENTIRA =====
let n = 0;
const as = { boletos: new Map(), apagados: [], criados: [] };
const asaas = servir((req, dados, responde) => {
  let m;
  if (req.method === "POST" && req.url === "/customers") return responde(200, { id: "cus_" + (++n) });
  if (req.method === "POST" && req.url === "/payments") {
    const p = { id: "pay_" + (++n), status: "PENDING", ...dados,
      bankSlipUrl: `https://asaas.mock/b/${n}.pdf`, invoiceUrl: `https://asaas.mock/i/${n}` };
    as.boletos.set(p.id, p); as.criados.push(p); return responde(200, p);
  }
  if ((m = req.url.match(/^\/payments\/([^/]+)\/identificationField$/)))
    return responde(200, { identificationField: "23790.00000 00000.000000 00000.000000 1 0000000" + m[1].replace(/\D/g, "") });
  if ((m = req.url.match(/^\/payments\/([^/]+)$/))) {
    const p = as.boletos.get(m[1]);
    if (!p) return responde(404, { errors: [{ description: "não encontrado" }] });
    if (req.method === "DELETE") { as.apagados.push(p.id); p.deleted = true; return responde(200, { deleted: true }); }
    return responde(200, p);
  }
  responde(404, { errors: [{ description: "rota não simulada " + req.method + " " + req.url }] });
});
await new Promise(r => asaas.listen(0, "127.0.0.1", r));
process.env.ASAAS_API_URL = `http://127.0.0.1:${asaas.address().port}`;

// ===== O PAGAR.ME DE MENTIRA =====
const pm = { clientes: new Map(), cobrancas: new Map(), pedidos: [], enderecos: [], canceladas: [] };
const pagarmeMock = servir((req, dados, responde) => {
  let m;
  if (req.method === "POST" && req.url === "/customers") { const c = { id: "cus_pm" + (++n), ...dados }; pm.clientes.set(c.id, c); return responde(200, c); }
  if ((m = req.url.match(/^\/customers\/([^/]+)$/)) && req.method === "PUT") { pm.enderecos.push({ id: m[1], ...dados }); return responde(200, { id: m[1], ...dados }); }
  if (req.method === "POST" && req.url === "/orders") {
    pm.pedidos.push(dados);
    const o = { id: "or_" + (++n), status: "pending", ...dados };
    const c = { id: "ch_" + (++n), status: "pending", amount: dados.items[0].amount, customer_id: dados.customer_id, order_id: o.id,
      last_transaction: { url: `https://pagarme.mock/b/${n}`, pdf: `https://pagarme.mock/b/${n}.pdf`, line: "34191.79001 01043.510047 91020.150008 5 000" } };
    pm.cobrancas.set(c.id, c); o.charges = [c]; return responde(200, o);
  }
  if ((m = req.url.match(/^\/charges\/([^/]+)$/))) {
    const c = pm.cobrancas.get(m[1]);
    if (!c) return responde(404, { message: "Charge not found" });
    if (req.method === "DELETE") { c.status = "canceled"; pm.canceladas.push(c.id); return responde(200, c); }
    return responde(200, c);
  }
  responde(404, { message: "rota não simulada " + req.method + " " + req.url });
});
await new Promise(r => pagarmeMock.listen(0, "127.0.0.1", r));
process.env.PAGARME_API_URL = `http://127.0.0.1:${pagarmeMock.address().port}`;

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const bcrypt = (await import("bcryptjs")).default;
const { situacao } = await import("../src/services/assinatura.js");
await import("../src/server.js");
const BASE = "http://localhost:4693";
await new Promise(r => setTimeout(r, 700));

const senha = bcrypt.hashSync("123456", 8);
const casaMaster = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casaMaster, "Casa do ConHub", "CH-B", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo',1)`).run("u_" + randomUUID(), casaMaster, "Ali", "ali@bo.com", senha, Date.now());

function conta(nome, tipo, planoId, email, extra = {}) {
  const org = "org_" + randomUUID().slice(0, 8), dono = "u_" + randomUUID();
  db.prepare(`INSERT INTO orgs (id,name,adm_code,created_at,tipo,plano_id,dono_user_id,cobranca) VALUES (?,?,?,?,?,?,?,?)`)
    .run(org, nome, "C-" + org.slice(-4), Date.now(), tipo, planoId, dono, extra.cobranca || "asaas");
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(dono, org, nome, email, senha, tipo === "autonomo" ? "corretor" : "adm", Date.now());
  return org;
}
// O Eleandro: autônomo, teste acabou, sem pagamento — travado.
const eleandro = conta("Eleandro", "autonomo", "mensal", "eleandro@bo.com");
db.prepare("UPDATE orgs SET trial_ate = ? WHERE id = ?").run(Date.now() - 2 * 86400000, eleandro);

const login = async (email) => {
  const d = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) })).json();
  assert.ok(d.token, `login ${email}: ${JSON.stringify(d)}`); return d.token;
};
const chamar = async (token, metodo, caminho, corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo, headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};
const webhookAsaas = (corpo) => fetch(`${BASE}/webhooks/asaas`, { method: "POST",
  headers: { "content-type": "application/json", "asaas-access-token": "webhook-boleto" }, body: JSON.stringify(corpo) });
const espera = (ms) => new Promise(r => setTimeout(r, ms));
let caso = 0;
const titulo = (t) => console.log(`\n${++caso}. ${t}`);

const tEle = await login("eleandro@bo.com");
const tMaster = await login("ali@bo.com");
assert.equal(situacao(eleandro).status, "bloqueado", "o teste acabou e nada foi pago");

titulo("Sem a liberação não há boleto; só o master liga");
let r = await chamar(tEle, "GET", "/assinatura/boleto");
assert.equal(r.s, 200, "a rota abre mesmo com a conta travada"); assert.equal(r.b.liberado, false);
r = await chamar(tEle, "POST", "/assinatura/boleto", { cpfCnpj: "52998224725" });
assert.equal(r.s, 403); assert.match(r.b.error, /suporte/);
r = await chamar(tEle, "POST", `/orgs/${eleandro}/boleto`, { liberado: true });
assert.equal(r.s, 403, "o cliente não se libera sozinho");
r = await chamar(tMaster, "POST", `/orgs/${eleandro}/boleto`, { liberado: "sim" });
assert.equal(r.s, 400);
r = await chamar(tMaster, "POST", `/orgs/${eleandro}/boleto`, { liberado: true });
assert.equal(r.s, 200, JSON.stringify(r.b)); assert.equal(r.b.org.boleto.liberado, true);
r = await chamar(tEle, "GET", "/assinatura/boleto");
assert.equal(r.b.liberado, true); assert.equal(r.b.provedor, "asaas"); assert.equal(r.b.pede_cpf, true);
assert.deepEqual(r.b.opcoes.map(o => o.id), ["basico", "mensal", "semestral", "anual"]);
assert.equal(r.b.atual, "mensal");

titulo("Asaas: o boleto sai com o valor do plano (do servidor), em 3 dias, com linha e endereço");
r = await chamar(tEle, "POST", "/assinatura/boleto", { plano_id: "mensal", cpfCnpj: "529.982.247-25", valor: 1 });
assert.equal(r.s, 200, JSON.stringify(r.b));
const p1 = as.criados.at(-1);
assert.equal(p1.billingType, "BOLETO");
assert.equal(p1.value, 197, "o valor mandado no corpo é ignorado");
const em3 = new Date(Date.now() + 3 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
assert.equal(p1.dueDate, em3);
assert.match(r.b.boleto.linha, /^23790/); assert.match(r.b.boleto.url, /asaas\.mock/);
assert.equal(r.b.boleto.meses, 1); assert.equal(r.b.boleto.status, "aberto");

titulo("O mesmo plano devolve o mesmo boleto; outro plano cancela o anterior");
const antes = as.criados.length;
r = await chamar(tEle, "POST", "/assinatura/boleto", { plano_id: "mensal" });
assert.equal(r.b.existente, true); assert.equal(as.criados.length, antes, "nenhum boleto novo");
r = await chamar(tEle, "POST", "/assinatura/boleto", { plano_id: "semestral" });
assert.equal(r.s, 200, JSON.stringify(r.b));
assert.ok(as.apagados.includes(p1.id), "o boleto anterior foi cancelado no Asaas");
const p2 = as.criados.at(-1);
assert.equal(p2.value, 167 * 6); assert.equal(r.b.boleto.meses, 6);
assert.equal(db.prepare("SELECT status FROM boletos WHERE cobranca_id = ?").get(p1.id).status, "cancelado");
r = await chamar(tEle, "POST", "/assinatura/boleto", { plano_id: "essencial-mensal" });
assert.equal(r.s, 400, "plano de outra família não serve");

titulo("Pago: credita os 6 meses, troca o plano e destrava; repetido não credita de novo");
await webhookAsaas({ event: "PAYMENT_RECEIVED", payment: { id: p2.id, value: 1002, status: "RECEIVED" } });
await espera(300);
let org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(eleandro);
assert.equal(org.plano_id, "semestral");
assert.notEqual(situacao(eleandro).status, "bloqueado");
let pgs = db.prepare("SELECT * FROM pagamentos WHERE org_id = ?").all(eleandro);
assert.equal(pgs.length, 1); assert.equal(pgs[0].meses, 6); assert.equal(pgs[0].obs, "Boleto");
const venceDepois = org.vence_em;
await webhookAsaas({ event: "PAYMENT_CONFIRMED", payment: { id: p2.id, value: 1002, status: "CONFIRMED" } });
await espera(300);
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(eleandro).n, 1, "não credita duas vezes");
r = await chamar(tEle, "GET", "/assinatura/boleto");
assert.equal(r.b.boletos[0].status, "pago");

titulo("Estorno tira o período e o vencimento volta");
await webhookAsaas({ event: "PAYMENT_REFUNDED", payment: { id: p2.id, value: 1002 } });
await espera(300);
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(eleandro).n, 0);
assert.ok(db.prepare("SELECT vence_em FROM orgs WHERE id = ?").get(eleandro).vence_em < venceDepois);
assert.equal(db.prepare("SELECT status FROM boletos WHERE cobranca_id = ?").get(p2.id).status, "estornado");

titulo("A tela confere o boleto em aberto no provedor (segunda chance além do aviso)");
r = await chamar(tEle, "POST", "/assinatura/boleto", { plano_id: "mensal" });
const p3 = as.criados.at(-1);
as.boletos.get(p3.id).status = "RECEIVED";
r = await chamar(tEle, "GET", "/assinatura/boleto");
assert.equal(r.b.boletos[0].status, "pago");
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(eleandro).n, 1);

titulo("Com o cartão cobrando, o boleto é recusado");
const comCartao = conta("Com Cartão", "autonomo", "mensal", "cartao@bo.com");
db.prepare("UPDATE orgs SET asaas_subscription_id = 'sub_x', boleto_liberado = 1 WHERE id = ?").run(comCartao);
const tCartao = await login("cartao@bo.com");
r = await chamar(tCartao, "POST", "/assinatura/boleto", { cpfCnpj: "52998224725" });
assert.equal(r.s, 409); assert.match(r.b.error, /cancele a assinatura do cartão/);
r = await chamar(tCartao, "GET", "/assinatura/boleto");
assert.equal(r.b.cartao_cobrando, true);

titulo("Pagar.me: endereço pedido uma vez, gravado no cliente; o aviso de pago credita");
const imob = conta("Imobiliária Boleto", "imobiliaria", "essencial-mensal", "imob@bo.com", { cobranca: "pagarme" });
const tImob = await login("imob@bo.com");
await chamar(tMaster, "POST", `/orgs/${imob}/boleto`, { liberado: true });
r = await chamar(tImob, "GET", "/assinatura/boleto");
assert.equal(r.b.provedor, "pagarme"); assert.equal(r.b.pede_endereco, true);
r = await chamar(tImob, "POST", "/assinatura/boleto", { cpfCnpj: "11444777000161", endereco: { cep: "56300", rua: "Rua A", numero: "10", bairro: "Centro", cidade: "Petrolina", uf: "PE" } });
assert.equal(r.s, 400); assert.match(r.b.error, /CEP/);
const endereco = { cep: "56300-000", rua: "Rua A", numero: "10", bairro: "Centro", cidade: "Petrolina", uf: "pe" };
r = await chamar(tImob, "POST", "/assinatura/boleto", { cpfCnpj: "11444777000161", endereco });
assert.equal(r.s, 200, JSON.stringify(r.b));
assert.equal(pm.enderecos.at(-1).address.zip_code, "56300000"); assert.equal(pm.enderecos.at(-1).address.state, "PE");
const ped = pm.pedidos.at(-1);
assert.equal(ped.payments[0].payment_method, "boleto"); assert.equal(ped.items[0].amount, 49700);
assert.match(r.b.boleto.linha, /^34191/);
r = await chamar(tImob, "GET", "/assinatura/boleto");
assert.equal(r.b.pede_endereco, false, "o endereço não é pedido de novo");
const cobPm = [...pm.cobrancas.values()].at(-1);
// Aviso inventado (cobrança ainda pendente na API) não credita.
await fetch(`${BASE}/webhooks/pagarme`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "charge.paid", data: { id: cobPm.id } }) });
await espera(300);
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(imob).n, 0, "a API diz pendente: nada é creditado");
cobPm.status = "paid"; cobPm.paid_amount = 49700;
await fetch(`${BASE}/webhooks/pagarme`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "charge.paid", data: { id: cobPm.id } }) });
await espera(300);
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(imob).n, 1);

titulo("Preço combinado: um mês da mensalidade combinada");
const combinada = conta("Casa Combinada", "imobiliaria", null, "comb@bo.com");
db.prepare("UPDATE orgs SET valor_mensal = 350, boleto_liberado = 1 WHERE id = ?").run(combinada);
const tComb = await login("comb@bo.com");
r = await chamar(tComb, "GET", "/assinatura/boleto");
assert.deepEqual(r.b.opcoes.map(o => [o.id, o.valor, o.meses]), [["combinada", 350, 1]]);
r = await chamar(tComb, "POST", "/assinatura/boleto", { cpfCnpj: "52998224725" });
assert.equal(r.s, 200, JSON.stringify(r.b)); assert.equal(as.criados.at(-1).value, 350);
const pComb = as.criados.at(-1);

titulo("Desligar não cancela o boleto já gerado; apagar a conta cancela");
r = await chamar(tMaster, "POST", `/orgs/${combinada}/boleto`, { liberado: false });
assert.equal(r.b.org.boleto.liberado, false);
assert.ok(!as.apagados.includes(pComb.id));
r = await chamar(tComb, "POST", "/assinatura/boleto", { cpfCnpj: "52998224725" });
assert.equal(r.s, 403);
r = await chamar(tMaster, "DELETE", `/orgs/${combinada}`, { confirmar: "Casa Combinada" });
assert.equal(r.s, 200, JSON.stringify(r.b));
assert.ok(as.apagados.includes(pComb.id), "o boleto em aberto foi cancelado no Asaas");

console.log(`\nOK — ${caso} casos.`);
process.exit(0);
