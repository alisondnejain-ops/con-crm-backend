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
for (const k of ["AGENDADAS_AGENDADOR", "MARKETING_AGENDADOR", "PRAZO_AGENDADOR", "CATRACA_TEMPO_AGENDADOR", "REDES_AGENDADOR", "FOTOS_AGENDADOR"]) process.env[k] = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

/* O Pagar.me de mentira: o modo da próxima cobrança decide se ela é paga,
   recusada ou fica em análise. */
let modo = "paid";
const pedidos = [], cancelados = [];
const cobrancas = new Map();
let n = 0;
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => (corpo += c));
  req.on("end", () => {
    const j = corpo ? JSON.parse(corpo) : {};
    const ok = (x) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(x)); };
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

console.log(falhas ? `\n${falhas} caso(s) falharam.` : "\nOK — a proposta personalizada.");
process.exit(falhas ? 1 : 0);
