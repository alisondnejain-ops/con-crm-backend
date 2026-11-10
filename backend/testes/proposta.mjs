/* PROPOSTA PERSONALIZADA (10/11/2026): o checkout de um cliente só.

   1. Só o master cria; o cliente não.
   2. A página pública mostra o que foi combinado (12x de R$ 1.200) e nada
      interno; código errado é 404.
   3. O valor do corpo do pagamento é ignorado: o Pagar.me recebe o da
      proposta, parcelado.
   4. Cartão recusado: nenhuma conta nasce, o e-mail não fica preso e a
      proposta continua aceitando pagamento.
   5. Pago: a conta nasce ativa, com 12 meses, 42 acessos não limitam a
      equipe, as ferramentas marcadas são liberadas e o cliente entra logado.
   6. O mesmo link não cobra de novo.
   7. Conta existente: o pagamento credita os meses e cancela a assinatura
      recorrente que ela tinha.
   8. Em análise: a conta nasce com prazo curto e o aviso do Pagar.me credita
      os 12 meses quando a cobrança é paga.
   9. Vencida e cancelada não cobram.
  10. A página /proposta/<código> abre sem login e não vai para o Google.

   Rodar: npm run teste:proposta */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-proposta.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4815";
process.env.PAGARME_SECRET_KEY = "sk_chave_de_producao";
process.env.PAGARME_PUBLIC_KEY = "pk_chave_publica";
process.env.PAGARME_API_URL = "http://127.0.0.1:4816";
process.env.APP_URL = "http://localhost:4815";
process.env.ASAAS_API_KEY = "$aact_prod_teste";
process.env.ASAAS_API_URL = "http://127.0.0.1:4816/asaas";
process.env.ASAAS_WEBHOOK_TOKEN = "tok-asaas";
for (const k of ["AGENDADAS_AGENDADOR", "MARKETING_AGENDADOR", "PRAZO_AGENDADOR", "CATRACA_TEMPO_AGENDADOR", "REDES_AGENDADOR", "FOTOS_AGENDADOR"]) process.env[k] = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

/* O Pagar.me de mentira: o modo da próxima cobrança decide se ela é paga,
   recusada ou fica em análise. */
let modo = "paid";
const pedidos = [], cancelados = [];
const cobrancas = new Map();
const asaasClientes = [], asaasPagamentos = [], asaasPorId = new Map();
let n = 0;
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => (corpo += c));
  req.on("end", () => {
    const j = corpo ? JSON.parse(corpo) : {};
    const ok = (x) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(x)); };
    /* O Asaas de mentira. */
    if (req.url.startsWith("/asaas/")) {
      const u = req.url.slice(6);
      if (req.method === "POST" && u === "/customers") { asaasClientes.push(j); return ok({ id: "cus_as_" + (++n) }); }
      if (req.method === "POST" && u === "/payments") {
        asaasPagamentos.push(j);
        const pg = { id: "pay_" + (++n), installment: j.installmentCount ? "ins_" + n : null, status: "PENDING",
          invoiceUrl: "https://asaas.test/i/" + n, value: j.totalValue || j.value };
        asaasPorId.set(pg.id, pg); return ok(pg);
      }
      if (req.method === "GET" && u.startsWith("/payments/")) return ok(asaasPorId.get(u.split("/")[2]) || {});
      res.writeHead(404); return res.end("{}");
    }
    if (req.method === "POST" && req.url === "/customers") return ok({ id: "cus_" + (++n), ...j });
    if (req.method === "POST" && /\/customers\/[^/]+\/cards$/.test(req.url)) return ok({ id: "card_" + (++n), brand: "visa", last_four_digits: "4242", exp_month: 12, exp_year: 2030 });
    if (req.method === "POST" && req.url === "/orders") {
      pedidos.push(j);
      const status = modo;
      const ch = { id: "ch_" + (++n), status, amount: j.items[0].amount, customer_id: j.customer_id, order_id: "or_" + n,
        last_transaction: status === "failed" ? { acquirer_message: "Saldo insuficiente" } : {} };
      cobrancas.set(ch.id, ch);
      return ok({ id: ch.order_id, status: status === "paid" ? "paid" : status === "failed" ? "failed" : "pending", charges: [ch] });
    }
    if (req.method === "GET" && req.url.startsWith("/charges/")) return ok(cobrancas.get(req.url.split("/")[2]) || {});
    if (req.method === "DELETE" && req.url.startsWith("/subscriptions/")) { cancelados.push(req.url.split("/")[2]); return ok({ status: "canceled" }); }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise(r => mock.listen(4816, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { sign } = await import("../src/auth.js");
const { temRecurso } = await import("../src/services/recursos.js");
const { situacao } = await import("../src/services/assinatura.js");
const { processarAvisoPagarme } = await import("../src/routes/assinatura.routes.js");
const BASE = "http://localhost:4815";
await new Promise(r => setTimeout(r, 700));

const orgMaster = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgMaster, "ConHub", "CH-1", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,created_at,status,master) VALUES ('u_master',?,'Ali','ali@x.com','x','adm',?,'ativo',1)`)
  .run(orgMaster, Date.now());
const orgCli = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,cobranca,pagarme_customer_id,pagarme_subscription_id,vence_em) VALUES (?,?,?,?,'pagarme','cus_velho','sub_velha',?)")
  .run(orgCli, "Casa Antiga", "CA-1", Date.now(), Date.now() + 5 * 86400000);
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,created_at,status) VALUES ('u_cli',?,'Gestora Antiga','gest@antiga.com','x','adm',?,'ativo')`)
  .run(orgCli, Date.now());
db.prepare("UPDATE orgs SET dono_user_id = 'u_cli' WHERE id = ?").run(orgCli);

const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(BASE + p, { method: metodo, headers: { ...(quem ? { authorization: cracha(quem) } : {}), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const pagar = (codigo, extra = {}) => api(null, "POST", `/publico/proposta/${codigo}/pagar`, {
  token: "token_abc123", cpfCnpj: "12345678000190", ...extra });
const novoCliente = (email) => ({ nome: "Fernanda Souza", email, telefone: "(87) 99911-2233", pais: "BR", senha: "segredo1", marca: "Imobiliária Horizonte" });
const codigoDe = (link) => link.split("/proposta/")[1];

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); }
}

let P1;
await caso("1. Só o master cria a proposta", async () => {
  const neg = await api("u_cli", "POST", "/orgs/propostas", { cliente: "X", total: "100", parcelas: 1, meses: 1 });
  assert.equal(neg.status, 403);
  const r = await api("u_master", "POST", "/orgs/propostas", { cliente: "Imobiliária Horizonte", total: "14.400", parcelas: 12, meses: 12,
    acessos: 42, itens: ["Implantação e treinamento"], recursos: ["autoatendimento", "marketing", "inventada"], validade_dias: 7 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  P1 = r.body.proposta;
  assert.equal(P1.parcela, 1200);
  assert.deepEqual(P1.recursos, ["autoatendimento", "marketing"]);
  assert.match(P1.link, /^http:\/\/localhost:4815\/proposta\/[A-Za-z0-9_-]{24}$/);
});

await caso("2. A página pública mostra o combinado e nada interno", async () => {
  const r = await api(null, "GET", `/publico/proposta/${codigoDe(P1.link)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 14400); assert.equal(r.body.parcelas, 12); assert.equal(r.body.parcela, 1200);
  assert.equal(r.body.acessos, 42); assert.equal(r.body.estado, "aberta");
  assert.equal(r.body.checkout.chave_publica, "pk_chave_publica");
  for (const k of ["id", "codigo", "criado_por", "pedido_id", "org_id", "link"]) assert.equal(r.body[k], undefined, k);
  assert.equal((await api(null, "GET", "/publico/proposta/naoexisteessecodigo123")).status, 404);
});

await caso("3 e 4. Cartão recusado: nenhuma conta, e-mail livre, proposta continua aberta", async () => {
  modo = "failed";
  const r = await pagar(codigoDe(P1.link), { ...novoCliente("fernanda@horizonte.com"), total: 1, valor: 1 });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.match(r.body.error, /Saldo insuficiente/);
  const ped = pedidos.at(-1);
  assert.equal(ped.items[0].amount, 1440000, "o valor é o da proposta, não o do corpo");
  assert.equal(ped.payments[0].credit_card.installments, 12);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email = 'fernanda@horizonte.com'").get().n, 0);
  assert.equal((await api(null, "GET", `/publico/proposta/${codigoDe(P1.link)}`)).body.estado, "aberta");
});

let orgNova;
await caso("5. Pago: conta ativa, 12 meses, ferramentas liberadas, entra logado", async () => {
  modo = "paid";
  const r = await pagar(codigoDe(P1.link), novoCliente("fernanda@horizonte.com"));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.pago && r.body.token);
  const u = db.prepare("SELECT * FROM users WHERE email = 'fernanda@horizonte.com'").get();
  assert.equal(u.role, "adm"); assert.equal(u.status, "ativo");
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(u.org_id);
  orgNova = org.id;
  assert.equal(org.name, "Imobiliária Horizonte"); assert.equal(org.cobranca, "pagarme"); assert.equal(org.dono_user_id, u.id);
  assert.equal(org.valor_mensal, 1200);
  const dias = (org.vence_em - Date.now()) / 86400000;
  assert.ok(dias > 360 && dias < 370, "vence em ~12 meses: " + dias);
  assert.equal(situacao(org.id).status, "ativo");
  assert.ok(temRecurso(org.id, "autoatendimento") && temRecurso(org.id, "marketing"));
  const me = await fetch(BASE + "/auth/me", { headers: { authorization: "Bearer " + r.body.token } });
  assert.equal(me.status, 200);
  const hub = await api("u_master", "GET", "/orgs/propostas");
  const linha = hub.body.propostas.find(p => p.id === P1.id);
  assert.equal(linha.estado, "paga"); assert.equal(linha.org_criada_nome, "Imobiliária Horizonte");
});

await caso("6. O mesmo link não cobra de novo", async () => {
  const antes = pedidos.length;
  const r = await pagar(codigoDe(P1.link), novoCliente("outra@horizonte.com"));
  assert.equal(r.status, 409); assert.ok(r.body.ja_paga);
  assert.equal(pedidos.length, antes);
  // O aviso repetido do Pagar.me também não dá mais 12 meses.
  const ch = [...cobrancas.values()].find(c => c.status === "paid");
  const vence = db.prepare("SELECT vence_em FROM orgs WHERE id = ?").get(orgNova).vence_em;
  await processarAvisoPagarme({ type: "charge.paid", data: { id: ch.id } });
  assert.equal(db.prepare("SELECT vence_em FROM orgs WHERE id = ?").get(orgNova).vence_em, vence);
});

await caso("7. Conta existente: credita os meses e cancela a assinatura antiga", async () => {
  const r = await api("u_master", "POST", "/orgs/propostas", { cliente: "Casa Antiga", total: "6000", parcelas: 10, meses: 12, org_id: orgCli });
  assert.equal(r.status, 201);
  const pg = await pagar(codigoDe(r.body.proposta.link));
  assert.equal(pg.status, 201, JSON.stringify(pg.body));
  assert.equal(pg.body.token, null, "não loga ninguém na conta existente");
  assert.ok(cancelados.includes("sub_velha"));
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgCli);
  assert.equal(org.pagarme_subscription_id, null);
  const dias = (org.vence_em - Date.now()) / 86400000;
  assert.ok(dias > 365 && dias < 375, "12 meses depois do que já estava pago: " + dias);
  assert.equal(pedidos.at(-1).customer_id, "cus_velho");
});

await caso("8. Em análise: prazo curto, e o aviso do Pagar.me credita os 12 meses", async () => {
  modo = "pending";
  const r = await api("u_master", "POST", "/orgs/propostas", { cliente: "Imobiliária Análise", total: "14400", parcelas: 12, meses: 12 });
  const codigo = codigoDe(r.body.proposta.link);
  const pg = await pagar(codigo, novoCliente("analise@x.com"));
  assert.equal(pg.status, 201); assert.equal(pg.body.processando, true);
  const org = db.prepare("SELECT o.* FROM orgs o JOIN users u ON u.org_id = o.id WHERE u.email = 'analise@x.com'").get();
  assert.ok((org.vence_em - Date.now()) / 86400000 < 4);
  assert.equal((await api(null, "GET", `/publico/proposta/${codigo}`)).body.estado, "processando");
  const ch = cobrancas.get([...cobrancas.keys()].at(-1));
  ch.status = "paid";
  await processarAvisoPagarme({ type: "charge.paid", data: { id: ch.id } });
  const depois = db.prepare("SELECT vence_em FROM orgs WHERE id = ?").get(org.id).vence_em;
  const dias = (depois - Date.now()) / 86400000;
  assert.ok(dias > 360 && dias < 368, "12 meses do dia do pagamento: " + dias);
  assert.equal((await api(null, "GET", `/publico/proposta/${codigo}`)).body.estado, "paga");
  modo = "paid";
});

await caso("9. Vencida e cancelada não cobram", async () => {
  const a = await api("u_master", "POST", "/orgs/propostas", { cliente: "Vence", total: "100", parcelas: 1, meses: 1 });
  db.prepare("UPDATE propostas SET valida_ate = ? WHERE id = ?").run(Date.now() - 1000, a.body.proposta.id);
  const antes = pedidos.length;
  assert.equal((await pagar(codigoDe(a.body.proposta.link), novoCliente("v@x.com"))).status, 410);
  const b = await api("u_master", "POST", "/orgs/propostas", { cliente: "Cancela", total: "100", parcelas: 1, meses: 1 });
  assert.equal((await api("u_master", "POST", `/orgs/propostas/${b.body.proposta.id}/cancelar`)).status, 200);
  assert.equal((await pagar(codigoDe(b.body.proposta.link), novoCliente("c@x.com"))).status, 410);
  assert.equal(pedidos.length, antes);
});

await caso("10. A página abre sem login e fica fora do Google", async () => {
  const r = await fetch(`${BASE}/proposta/${codigoDe(P1.link)}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
  const html = await r.text();
  assert.match(html, /Pagar\.me/);
});

const avisoAsaas = (event, payment) => fetch(BASE + "/webhooks/asaas", { method: "POST",
  headers: { "content-type": "application/json", "asaas-access-token": "tok-asaas" }, body: JSON.stringify({ event, payment }) });
const espera = (ms) => new Promise(r => setTimeout(r, ms));

let PA;
await caso("11. Asaas: a fatura sai com o total, em 12x, no cartão; nenhuma conta nasce antes de pagar", async () => {
  const r = await api("u_master", "POST", "/orgs/propostas", { cliente: "Imobiliária Asaas", total: "14.400", parcelas: 12, meses: 12,
    acessos: 42, recursos: ["marketing"], provedor: "asaas" });
  assert.equal(r.status, 201); PA = r.body.proposta; assert.equal(PA.provedor, "asaas");
  const pag = await api(null, "GET", `/publico/proposta/${codigoDe(PA.link)}`);
  assert.equal(pag.body.checkout.provedor, "asaas"); assert.equal(pag.body.checkout.chave_publica, undefined);
  const cartaoAqui = await pagar(codigoDe(PA.link), novoCliente("asaas@x.com"));
  assert.equal(cartaoAqui.status, 409, "proposta do Asaas não aceita cartão na página");
  const g = await api(null, "POST", `/publico/proposta/${codigoDe(PA.link)}/asaas`, { ...novoCliente("asaas@x.com"), cpfCnpj: "12345678000190", total: 1 });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.match(g.body.fatura, /^https:\/\/asaas\.test\/i\//);
  const ped = asaasPagamentos.at(-1);
  assert.equal(ped.billingType, "CREDIT_CARD"); assert.equal(ped.installmentCount, 12); assert.equal(ped.totalValue, 14400);
  assert.equal(asaasClientes.at(-1).cpfCnpj, "12345678000190");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email = 'asaas@x.com'").get().n, 0);
  const row = db.prepare("SELECT * FROM propostas WHERE id = ?").get(PA.id);
  assert.equal(row.status, "aguardando");
  assert.ok(!row.cadastro_json.includes("segredo1"), "a senha não fica em texto");
  const de_novo = await api(null, "POST", `/publico/proposta/${codigoDe(PA.link)}/asaas`, { ...novoCliente("asaas@x.com"), cpfCnpj: "12345678000190" });
  assert.equal(de_novo.body.fatura, g.body.fatura, "o mesmo link devolve a mesma fatura");
  assert.equal(asaasPagamentos.length, 1);
});

await caso("12. Asaas pago: a conta nasce, 12 meses, ferramentas; as outras parcelas não creditam de novo", async () => {
  const row = db.prepare("SELECT * FROM propostas WHERE id = ?").get(PA.id);
  assert.equal((await avisoAsaas("PAYMENT_CONFIRMED", { id: row.asaas_pagamento_id, installment: row.asaas_parcelamento_id, value: 1200 })).status, 200);
  await espera(400);
  const u = db.prepare("SELECT * FROM users WHERE email = 'asaas@x.com'").get();
  assert.ok(u && u.status === "ativo" && u.role === "adm");
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(u.org_id);
  assert.equal(org.cobranca, "asaas"); assert.ok(org.asaas_customer_id);
  const dias = (org.vence_em - Date.now()) / 86400000;
  assert.ok(dias > 360 && dias < 368, "12 meses: " + dias);
  assert.equal(temRecurso(org.id, "marketing"), true);
  for (let i = 0; i < 3; i++) await avisoAsaas("PAYMENT_CONFIRMED", { id: "pay_outra_" + i, installment: row.asaas_parcelamento_id, value: 1200 });
  await espera(300);
  assert.equal(db.prepare("SELECT vence_em FROM orgs WHERE id = ?").get(org.id).vence_em, org.vence_em);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(org.id).n, 1);
  const pr = db.prepare("SELECT * FROM propostas WHERE id = ?").get(PA.id);
  assert.equal(pr.status, "paga"); assert.equal(pr.cadastro_json, null);
  const login = await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "asaas@x.com", password: "segredo1" }) });
  assert.equal(login.status, 200, "entra com a senha que criou na página");
});

await caso("13. Asaas: a própria página confere o pagamento (sem webhook)", async () => {
  const r = await api("u_master", "POST", "/orgs/propostas", { cliente: "Casa Antiga", total: "6000", parcelas: 6, meses: 12, org_id: orgCli, provedor: "asaas" });
  const codigo = codigoDe(r.body.proposta.link);
  const g = await api(null, "POST", `/publico/proposta/${codigo}/asaas`, { cpfCnpj: "12345678909" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const row = db.prepare("SELECT * FROM propostas WHERE id = ?").get(r.body.proposta.id);
  asaasPorId.get(row.asaas_pagamento_id).status = "CONFIRMED";
  const antes = db.prepare("SELECT vence_em FROM orgs WHERE id = ?").get(orgCli).vence_em;
  const p = await api(null, "GET", `/publico/proposta/${codigo}`);
  assert.equal(p.body.estado, "paga");
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgCli);
  assert.equal(org.cobranca, "asaas");
  assert.ok(org.vence_em > antes + 300 * 86400000);
});

await caso("14. Asaas: fatura apagada volta a aceitar; estorno tira os meses", async () => {
  const r = await api("u_master", "POST", "/orgs/propostas", { cliente: "Apaga", total: "1200", parcelas: 1, meses: 1, provedor: "asaas" });
  const codigo = codigoDe(r.body.proposta.link);
  await api(null, "POST", `/publico/proposta/${codigo}/asaas`, { ...novoCliente("apaga@x.com"), cpfCnpj: "12345678909" });
  const row = db.prepare("SELECT * FROM propostas WHERE id = ?").get(r.body.proposta.id);
  assert.equal(asaasPagamentos.at(-1).value, 1200, "à vista vai como value");
  await avisoAsaas("PAYMENT_DELETED", { id: row.asaas_pagamento_id });
  await espera(300);
  assert.equal(db.prepare("SELECT status FROM propostas WHERE id = ?").get(row.id).status, "aberta");
  const pa = db.prepare("SELECT * FROM propostas WHERE id = ?").get(PA.id);
  await avisoAsaas("PAYMENT_REFUNDED", { id: pa.asaas_pagamento_id, installment: pa.asaas_parcelamento_id });
  await espera(300);
  assert.equal(db.prepare("SELECT status FROM propostas WHERE id = ?").get(PA.id).status, "estornada");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(pa.org_criada_id).n, 0);
});

console.log(falhas ? `\n${falhas} caso(s) falharam.` : "\nOK — a proposta personalizada.");
process.exit(falhas ? 1 : 0);
