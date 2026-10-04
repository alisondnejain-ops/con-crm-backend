/* COBRANÇA PELO PAGAR.ME (04/10/2026).

   Sobe o servidor de verdade e um Pagar.me de mentira, com o formato da API
   core v5. O Pagar.me de verdade não é alcançável deste ambiente — o que se
   prova aqui é o NOSSO lado: o que é pedido, com que dados, e o que a conta
   vira com cada resposta.

    1. Conta com cobrança no Asaas (a VJ) continua no Asaas; ter só o
       cadastro lá não prende; o resto vai para o Pagar.me — só com chaves de
       produção; o master troca conta por conta, e só ele.
    2. O cartão chega como TOKEN (o número nunca passa pelo servidor), cria o
       cliente com o CPF e começa o teste de 14 dias das contas do site.
    3. Mensal em teste: assinatura com a primeira cobrança no fim do teste.
    4. Anual: um pedido no valor cheio em 12x, pago na hora, credita 12 meses
       contados do fim do teste; a assinatura anterior é cancelada.
    5. Ferramenta em um clique no cartão guardado, paga na hora, sem virar
       mês de mensalidade.
    6. Webhook: confere a cobrança na API antes de creditar; repetido não
       credita duas vezes; aviso inventado não faz nada; cobrança de outra
       conta não credita aqui; estorno desliga a ferramenta na hora.
    7. Trocar o cartão leva as assinaturas para o cartão novo.
    8. Cancelar a ferramenta e apagar a conta cancelam no Pagar.me.
    9. Só o dono mexe na cobrança.
   10. Preço combinado (a Conecta): guardar o cartão não cobra; a mensalidade
       liga com a primeira cobrança no próximo vencimento.
   11. Trocar de plano no meio do período pago começa no vencimento; o Marketing
       vem no Essencial semestral/anual e no Plus, não no Essencial mensal.
   12. O cliente cancela: nada mais é cobrado, o acesso vai até o que foi pago,
       o aviso de cancelamento do Pagar.me não trava antes da hora, e passado
       o prazo a conta trava.

   Rodar:  npm run teste:pagarme
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-pagarme.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4667";
// Chaves com cara de PRODUÇÃO: é com elas que o Pagar.me vira o padrão.
process.env.PAGARME_SECRET_KEY = "sk_chave_de_producao";
process.env.PAGARME_PUBLIC_KEY = "pk_chave_publica";
delete process.env.COBRANCA_PADRAO;
process.env.MARKETING_AGENDADOR = "0";
process.env.SITE_DOMINIO_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== O PAGAR.ME DE MENTIRA =====
let seq = 0;
const pm = { pedidos: [], clientes: new Map(), cartoes: new Map(), assinaturas: new Map(), cobrancas: new Map(),
  faturas: new Map(), canceladas: [], cartoesApagados: [], trocasDeCartao: [], recusarCartao: false };
const AUTH = "Basic " + Buffer.from("sk_chave_de_producao:").toString("base64");
const novaCobranca = (dados) => { const c = { id: "ch_" + (++seq), status: "paid", ...dados }; pm.cobrancas.set(c.id, c); return c; };
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    const dados = corpo ? JSON.parse(corpo) : {};
    pm.pedidos.push({ metodo: req.method, url: req.url, corpo: dados });
    res.setHeader("Content-Type", "application/json");
    const responde = (st, x) => { res.statusCode = st; res.end(JSON.stringify(x)); };
    if (req.headers.authorization !== AUTH) return responde(401, { message: "Authorization has been denied" });
    let m;
    if (req.method === "POST" && req.url === "/customers") {
      const c = { id: "cus_" + (++seq), ...dados }; pm.clientes.set(c.id, c); return responde(200, c);
    }
    if ((m = req.url.match(/^\/customers\/([^/]+)\/cards$/)) && req.method === "POST") {
      if (pm.recusarCartao) return responde(422, { message: "The request is invalid.", errors: { card: ["Cartão recusado pelo emissor"] } });
      if (!/^token_/.test(dados.token || "")) return responde(422, { message: "token inválido" });
      const c = { id: "card_" + (++seq), brand: "Visa", last_four_digits: String(4240 + seq).slice(-4), exp_month: 12, exp_year: 2030, customer_id: m[1] };
      pm.cartoes.set(c.id, c); return responde(200, c);
    }
    if ((m = req.url.match(/^\/customers\/([^/]+)\/cards\/([^/]+)$/)) && req.method === "DELETE") {
      pm.cartoesApagados.push(m[2]); return responde(200, { id: m[2], status: "deleted" });
    }
    if (req.method === "POST" && req.url === "/subscriptions") {
      const s = { id: "sub_" + (++seq), status: "active", ...dados };
      pm.assinaturas.set(s.id, s);
      // Sem start_at, a primeira fatura sai paga na hora (cartão aprovado).
      const lista = [];
      if (!dados.start_at) {
        const preco = dados.items[0].pricing_scheme.price;
        const c = novaCobranca({ amount: preco, customer_id: dados.customer_id, invoice: { id: "in_" + seq, subscription_id: s.id } });
        lista.push({ id: "in_" + seq, status: "paid", amount: preco, charge: { id: c.id, amount: preco } });
      }
      pm.faturas.set(s.id, lista);
      return responde(200, s);
    }
    if ((m = req.url.match(/^\/invoices\?subscription_id=([^&]+)/)) && req.method === "GET")
      return responde(200, { data: pm.faturas.get(decodeURIComponent(m[1])) || [] });
    if ((m = req.url.match(/^\/subscriptions\/([^/]+)\/card$/)) && req.method === "PATCH") {
      pm.trocasDeCartao.push({ sub: m[1], card: dados.card_id }); return responde(200, { id: m[1] });
    }
    if ((m = req.url.match(/^\/subscriptions\/([^/]+)$/))) {
      const s = pm.assinaturas.get(m[1]);
      if (!s) return responde(404, { message: "Subscription not found" });
      if (req.method === "DELETE") { s.status = "canceled"; pm.canceladas.push(s.id); return responde(200, s); }
      return responde(200, s);
    }
    if (req.method === "POST" && req.url === "/orders") {
      const o = { id: "or_" + (++seq), status: "paid", ...dados };
      const c = novaCobranca({ amount: dados.items[0].amount, customer_id: dados.customer_id, order_id: o.id });
      o.charges = [c];
      return responde(200, o);
    }
    if ((m = req.url.match(/^\/charges\/([^/]+)$/)) && req.method === "GET") {
      const c = pm.cobrancas.get(m[1]);
      return c ? responde(200, c) : responde(404, { message: "Charge not found" });
    }
    responde(404, { message: "rota não simulada " + req.method + " " + req.url });
  });
});
await new Promise(r => mock.listen(0, "127.0.0.1", r));
process.env.PAGARME_API_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const bcrypt = (await import("bcryptjs")).default;
const { temRecurso } = await import("../src/services/recursos.js");
await import("../src/server.js");
const BASE = "http://localhost:4667";
await new Promise(r => setTimeout(r, 700));

const senha = bcrypt.hashSync("123456", 8);
const casaMaster = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casaMaster, "Casa do ConHub", "CH-PM", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo',1)`).run("u_" + randomUUID(), casaMaster, "Ali", "ali@pm.com", senha, Date.now());

function conta(nome, tipo, email, extra = {}) {
  const org = "org_" + randomUUID().slice(0, 8), dono = "u_" + randomUUID();
  db.prepare(`INSERT INTO orgs (id,name,adm_code,created_at,tipo,dono_user_id,exige_cartao,asaas_customer_id,asaas_subscription_id,valor_mensal,vence_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(org, nome, "C-" + org.slice(4), Date.now(), tipo, dono, extra.exige ? 1 : 0, extra.asaas || null,
      extra.asaasSub || null, extra.valor || null, extra.vence || null);
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,phone)
    VALUES (?,?,?,?,?,?,1,?,'ativo','87991112222')`).run(dono, org, nome + " Dono", email, senha, tipo === "autonomo" ? "corretor" : "adm", Date.now());
  return { org, dono };
}
const site = conta("Corretor do Site", "autonomo", "site@pm.com", { exige: true });
const vj = conta("VJ Imóveis", "imobiliaria", "vj@pm.com", { asaas: "cus_asaas_vj", asaasSub: "sub_asaas_vj" });
// Só o CADASTRO no Asaas (um CPF digitado num teste), sem cobrança nenhuma.
const soCadastro = conta("Só Cadastro", "imobiliaria", "socadastro@pm.com", { asaas: "cus_asaas_teste" });
// Pagou pelo Asaas no plano anual (parcelado: sem assinatura) — fica no Asaas.
const anualAsaas = conta("Anual no Asaas", "autonomo", "anualasaas@pm.com", { asaas: "cus_asaas_anual" });
db.prepare("INSERT INTO pagamentos (id,org_id,valor,pago_em,origem,created_at) VALUES (?,?,?,?,'asaas',?)")
  .run("pg_" + randomUUID(), anualAsaas.org, 147, Date.now(), Date.now());
// Preço COMBINADO (a Conecta): sem plano da tabela, pago até daqui a 10 dias.
const VENCE_CONECTA = Date.now() + 10 * 86400000;
const conecta = conta("Conecta Teste", "imobiliaria", "conecta@pm.com", { valor: 1500, vence: VENCE_CONECTA });
const atrasada = conta("Atrasada", "imobiliaria", "atrasada@pm.com", { valor: 800, vence: Date.now() - 5 * 86400000 });
const outra = conta("Outra Conta", "autonomo", "outra@pm.com");
const atendente = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,'sdr',1,?,'ativo')`).run(atendente, outra.org, "Atendente", "atendente@pm.com", senha, Date.now());

const login = async (email) => {
  const d = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) })).json();
  assert.ok(d.token, `login ${email}: ${JSON.stringify(d)}`); return d.token;
};
const chamar = async (token, caminho, metodo = "GET", corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const aviso = async (corpo) => {
  const r = await fetch(`${BASE}/webhooks/pagarme`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  await new Promise(x => setTimeout(x, 150));
  return r.status;
};
const linhaOrg = (id) => db.prepare("SELECT * FROM orgs WHERE id = ?").get(id);
const pagamentos = (id) => db.prepare("SELECT * FROM pagamentos WHERE org_id = ? ORDER BY pago_em").all(id);
const DIA = 86400000;
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

try {
  const tMaster = await login("ali@pm.com");
  const tSite = await login("site@pm.com");
  const tVj = await login("vj@pm.com");
  const tOutra = await login("outra@pm.com");

  caso("Quem tem cobrança no Asaas fica no Asaas; o resto vai para o Pagar.me; o master troca, e só ele");
  let r = await chamar(tVj, "/assinatura");
  assert.equal(r.body.provedor, "asaas", "a VJ tem assinatura no Asaas e continua lá");
  r = await chamar(await login("anualasaas@pm.com"), "/assinatura");
  assert.equal(r.body.provedor, "asaas", "pagou pelo Asaas (anual, sem assinatura) — continua lá");
  r = await chamar(await login("socadastro@pm.com"), "/assinatura");
  assert.equal(r.body.provedor, "pagarme", "só o cadastro no Asaas, sem cobrança, não prende ninguém lá");
  r = await chamar(tSite, "/assinatura");
  assert.equal(r.body.provedor, "pagarme");
  assert.equal(r.body.status, "aguardando_cartao");
  assert.equal(r.body.pagarme.chave_publica, "pk_chave_publica", "a tela recebe a chave PÚBLICA");
  assert.ok(!JSON.stringify(r.body).includes("sk_chave"), "a chave secreta nunca sai do servidor");
  {
    // Com chaves de TESTE o padrão não muda — cartão de verdade seria recusado.
    const { provedorDe } = await import("../src/services/cobranca.js");
    const [s0, p0] = [process.env.PAGARME_SECRET_KEY, process.env.PAGARME_PUBLIC_KEY];
    process.env.PAGARME_SECRET_KEY = "sk_test_x"; process.env.PAGARME_PUBLIC_KEY = "pk_test_x";
    assert.equal(provedorDe(linhaOrg(conecta.org)), "asaas", "chave de teste não leva cliente nenhum ao Pagar.me sozinho");
    assert.equal(provedorDe({ ...linhaOrg(conecta.org), cobranca: "pagarme" }), "pagarme", "a conta posta pelo master, sim");
    process.env.COBRANCA_PADRAO = "asaas"; process.env.PAGARME_SECRET_KEY = s0; process.env.PAGARME_PUBLIC_KEY = p0;
    assert.equal(provedorDe(linhaOrg(conecta.org)), "asaas", "COBRANCA_PADRAO=asaas desliga o padrão");
    delete process.env.COBRANCA_PADRAO;
    assert.equal(provedorDe(linhaOrg(conecta.org)), "pagarme");
  }
  r = await chamar(tVj, `/orgs/${vj.org}/cobranca`, "POST", { provedor: "pagarme" });
  assert.equal(r.status, 403, "o cliente não troca o próprio provedor");
  r = await chamar(tMaster, `/orgs/${vj.org}/cobranca`, "POST", { provedor: "stripe" });
  assert.equal(r.status, 400);
  r = await chamar(tMaster, `/orgs/${vj.org}/cobranca`, "POST", { provedor: "pagarme" });
  assert.equal(r.status, 200);
  assert.equal(r.body.org.cobranca.provedor, "pagarme");
  assert.equal(r.body.org.cobranca.tem_asaas, true, "o hub mostra que ela ainda tem cobrança no Asaas");
  console.log("   VJ: asaas → pagarme pelo master · conta do site: pagarme pelo padrão");

  caso("O cartão chega como token, cria o cliente e começa o teste");
  r = await chamar(tSite, "/assinatura/cartao", "POST", { token: "token_abc123" });
  assert.equal(r.status, 400, "sem CPF na primeira vez");
  assert.match(r.body.error, /CPF/);
  r = await chamar(tSite, "/assinatura/cartao", "POST", { token: "4111111111111111", cpfCnpj: "111.444.777-35" });
  assert.equal(r.status, 400, "número de cartão no lugar do token é recusado antes de sair daqui");
  pm.recusarCartao = true;
  r = await chamar(tSite, "/assinatura/cartao", "POST", { token: "token_abc123", cpfCnpj: "111.444.777-35" });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Cartão recusado pelo emissor/, "a recusa do Pagar.me chega escrita");
  assert.equal(linhaOrg(site.org).cartao_confirmado_em, null, "cartão recusado não começa o teste");
  pm.recusarCartao = false;
  r = await chamar(tSite, "/assinatura/cartao", "POST", { token: "token_abc123", cpfCnpj: "111.444.777-35" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cartao.bandeira, "Visa");
  assert.equal(r.body.status, "teste");
  const cli = [...pm.clientes.values()].at(-1);
  assert.equal(cli.document, "11144477735");
  assert.equal(cli.document_type, "CPF");
  assert.equal(cli.phones.mobile_phone.area_code, "87");
  const pedidosDeCartao = pm.pedidos.filter(p => /\/cards$/.test(p.url));
  assert.ok(pedidosDeCartao.every(p => Object.keys(p.corpo).join() === "token"), "ao Pagar.me vai só o token");
  let o = linhaOrg(site.org);
  assert.ok(o.cartao_confirmado_em && Math.abs(o.trial_ate - (Date.now() + 7 * DIA)) < 60000, "o teste de 7 dias começa com o cartão");
  console.log(`   cliente ${o.pagarme_customer_id}, cartão final ${r.body.cartao.final}, teste até ${new Date(o.trial_ate).toLocaleDateString("pt-BR")}`);

  caso("Mensal em teste: a primeira cobrança fica para o fim do teste");
  r = await chamar(tSite, "/assinatura/plano", "POST", { plano_id: "mensal" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pago, false);
  let sub = [...pm.assinaturas.values()].at(-1);
  assert.equal(sub.items[0].pricing_scheme.price, 19700, "R$ 197 em centavos");
  assert.equal(sub.interval, "month");
  assert.equal(sub.interval_count, 1);
  assert.equal(sub.card_id, linhaOrg(site.org).pagarme_card_id, "no cartão guardado");
  o = linhaOrg(site.org);
  const fimDoTeste = new Date(o.trial_ate - new Date(o.trial_ate).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  assert.equal(sub.start_at, fimDoTeste, "começa no fim do teste");
  assert.equal(pagamentos(site.org).length, 0, "nada pago ainda");
  assert.equal(r.body.status, "teste");
  const mensalId = sub.id;
  console.log(`   assinatura ${sub.id} começa em ${sub.start_at}`);

  caso("Anual: um pedido no valor cheio em 12x, pago na hora, 12 meses a partir do fim do teste");
  r = await chamar(tSite, "/assinatura/plano", "POST", { plano_id: "anual" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pago, true);
  const pedido = pm.pedidos.filter(p => p.url === "/orders").at(-1).corpo;
  assert.equal(pedido.items[0].amount, 176400, "R$ 147 × 12 = R$ 1.764");
  assert.equal(pedido.payments[0].credit_card.installments, 12);
  assert.ok(pm.canceladas.includes(mensalId), "a assinatura mensal anterior foi cancelada");
  const pg = pagamentos(site.org);
  assert.equal(pg.length, 1);
  assert.equal(pg[0].meses, 12);
  assert.equal(pg[0].origem, "pagarme");
  o = linhaOrg(site.org);
  const esperado = new Date(o.vence_base); esperado.setMonth(esperado.getMonth() + 12);
  assert.equal(o.vence_em, esperado.getTime());
  assert.ok(Math.abs(o.vence_base - o.trial_ate) < 1000, "os 12 meses contam do fim do teste");
  assert.equal(r.body.status, "ativo");
  const cobrancaAnual = pg[0].asaas_payment_id;
  const pedidosAntes = pm.pedidos.filter(p => p.url === "/orders").length;
  r = await chamar(tSite, "/assinatura/plano", "POST", { plano_id: "anual" });
  assert.equal(r.status, 409, "o mesmo anual de novo, com o ano longe de acabar, não cobra outra vez");
  assert.equal(pm.pedidos.filter(p => p.url === "/orders").length, pedidosAntes);
  console.log(`   pago — vence em ${new Date(o.vence_em).toLocaleDateString("pt-BR")}`);

  caso("Webhook: confere na API; repetido não credita de novo; inventado não faz nada");
  assert.equal(await aviso({ type: "charge.paid", data: { id: cobrancaAnual } }), 200);
  assert.equal(pagamentos(site.org).length, 1, "o mesmo pagamento avisado de novo não dá mais 12 meses");
  assert.equal(await aviso({ type: "charge.paid", data: { id: "ch_inventada", status: "paid", amount: 99999, customer_id: linhaOrg(site.org).pagarme_customer_id } }), 200);
  assert.equal(pagamentos(site.org).length, 1, "cobrança que a API não conhece não credita nada");
  // Cobrança de verdade, mas de outro cliente: não pode creditar aqui.
  const alheia = novaCobranca({ amount: 19700, customer_id: "cus_de_ninguem", order_id: "or_x" });
  await aviso({ type: "charge.paid", data: { id: alheia.id } });
  assert.equal(pagamentos(site.org).length, 1);
  // Cobrança paga de um pedido que não é o do plano da conta: ignorada.
  const solta = novaCobranca({ amount: 19700, customer_id: linhaOrg(site.org).pagarme_customer_id, order_id: "or_outro" });
  await aviso({ type: "charge.paid", data: { id: solta.id } });
  assert.equal(pagamentos(site.org).length, 1, "cobrança do cliente que não é do plano nem de ferramenta não vira mês");
  console.log("   repetido, inventado, de outra conta e solto: nenhum crédito a mais");

  caso("Ferramenta em um clique, paga na hora, sem virar mês da mensalidade");
  r = await chamar(tSite, "/assinatura/recursos");
  assert.equal(r.body.provedor, "pagarme");
  assert.equal(r.body.pagarme.cartao.bandeira, "Visa", "a tela já sabe o cartão para o botão de um clique");
  r = await chamar(tSite, "/assinatura/recursos/marketing", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pago, true);
  assert.equal(r.body.recurso.ativo, true);
  assert.equal(temRecurso(site.org, "marketing"), true);
  sub = [...pm.assinaturas.values()].at(-1);
  assert.equal(sub.items[0].pricing_scheme.price, 9700);
  assert.ok(!sub.start_at, "cobrada hoje");
  assert.equal(pagamentos(site.org).length, 1, "os R$ 97 não viraram mês de mensalidade");
  const ferramentaSub = sub.id;
  const ferramentaCobranca = pm.faturas.get(sub.id)[0].charge.id;
  await aviso({ type: "charge.paid", data: { id: ferramentaCobranca } });
  const linhaF = db.prepare("SELECT * FROM org_recursos WHERE org_id = ? AND recurso = 'marketing'").get(site.org);
  assert.equal(linhaF.avulso_provedor, "pagarme");
  const pagoAte = linhaF.avulso_pago_ate;
  assert.ok(pagoAte > Date.now() + 25 * DIA && pagoAte < Date.now() + 40 * DIA, "um mês, e o aviso repetido não somou outro");
  console.log("   Marketing ligado, um mês pago");

  caso("Renovação: a próxima cobrança da ferramenta chega pelo webhook e soma um mês");
  const renov = novaCobranca({ amount: 9700, customer_id: linhaOrg(site.org).pagarme_customer_id, invoice: { subscription_id: ferramentaSub } });
  await aviso({ type: "charge.paid", data: { id: renov.id } });
  const depois = db.prepare("SELECT avulso_pago_ate FROM org_recursos WHERE org_id = ? AND recurso = 'marketing'").get(site.org).avulso_pago_ate;
  assert.ok(depois > pagoAte + 25 * DIA, "mais um mês");

  caso("Trocar o cartão leva a assinatura da ferramenta para o cartão novo");
  const cartaoVelho = linhaOrg(site.org).pagarme_card_id;
  r = await chamar(tSite, "/assinatura/cartao", "POST", { token: "token_novo456" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cartaoNovo = linhaOrg(site.org).pagarme_card_id;
  assert.notEqual(cartaoNovo, cartaoVelho);
  assert.ok(pm.trocasDeCartao.some(t => t.sub === ferramentaSub && t.card === cartaoNovo));
  assert.ok(pm.cartoesApagados.includes(cartaoVelho), "o cartão velho sai depois que tudo passou para o novo");
  assert.equal([...pm.clientes.values()].length, 1, "o cliente não é criado de novo");

  caso("Estorno da ferramenta desliga na hora");
  const est = pm.cobrancas.get(renov.id); est.status = "refunded";
  await aviso({ type: "charge.refunded", data: { id: renov.id } });
  assert.equal(temRecurso(site.org, "marketing"), false);
  assert.equal(db.prepare("SELECT avulso_status FROM org_recursos WHERE org_id = ? AND recurso = 'marketing'").get(site.org).avulso_status, "estornado");

  caso("Cancelar a ferramenta avulsa cancela no Pagar.me");
  r = await chamar(tSite, "/assinatura/recursos/autoatendimento", "POST", {});
  assert.equal(r.status, 409, "o anual completo já traz o Autoatendimento");
  r = await chamar(tOutra, "/assinatura/cartao", "POST", { token: "token_outra", cpfCnpj: "52998224725" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await chamar(tOutra, "/assinatura/recursos/marketing", "POST", {});
  assert.equal(r.status, 200);
  const subOutra = [...pm.assinaturas.values()].at(-1).id;
  r = await chamar(tOutra, "/assinatura/recursos/marketing", "DELETE");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(pm.canceladas.includes(subOutra));
  assert.equal(temRecurso(outra.org, "marketing"), true, "cancelar mantém até o fim do mês pago");

  caso("Só o dono mexe na cobrança");
  const tAtendente = await login("atendente@pm.com");
  r = await chamar(tAtendente, "/assinatura/cartao", "POST", { token: "token_x", cpfCnpj: "52998224725" });
  assert.equal(r.status, 403);
  r = await chamar(tAtendente, "/assinatura");
  assert.equal(r.body.pagarme, undefined, "quem não é dono não recebe nada de cobrança");

  caso("Conta no Asaas não aceita cartão por aqui; apagar a conta cancela no Pagar.me");
  r = await chamar(tMaster, `/orgs/${vj.org}/cobranca`, "POST", { provedor: "asaas" });
  assert.equal(r.status, 200);
  r = await chamar(tVj, "/assinatura/cartao", "POST", { token: "token_vj", cpfCnpj: "52998224725" });
  assert.equal(r.status, 409);
  const subAtiva = linhaOrg(outra.org).pagarme_subscription_id;
  r = await chamar(tOutra, "/assinatura/plano", "POST", { plano_id: "mensal" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pago, true, "sem teste em curso, cobra hoje");
  const subPlano = linhaOrg(outra.org).pagarme_subscription_id;
  r = await chamar(tOutra, "/assinatura/plano", "POST", { plano_id: "mensal" });
  assert.equal(r.status, 409, "clicar de novo no plano que já está valendo não cria outra assinatura");
  assert.equal(linhaOrg(outra.org).pagarme_subscription_id, subPlano);
  assert.ok(subPlano && subPlano !== subAtiva);
  r = await chamar(tMaster, `/orgs/${outra.org}`, "DELETE", { confirmar: "Outra Conta" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(pm.canceladas.includes(subPlano), "a mensalidade no Pagar.me foi cancelada antes de apagar");

  caso("Preço combinado (a Conecta): cartão sem cobrar; a mensalidade liga no próximo vencimento");
  const tConecta = await login("conecta@pm.com");
  r = await chamar(tConecta, "/assinatura");
  assert.equal(r.body.provedor, "pagarme");
  assert.deepEqual(r.body.pagarme.combinada, { valor: 1500, ligada: false, primeira_cobranca: VENCE_CONECTA });
  r = await chamar(tConecta, "/assinatura/combinada", "POST", {});
  assert.equal(r.status, 400, "sem cartão não liga");
  const assinaturasAntes = pm.assinaturas.size, pedidosAntes2 = pm.pedidos.filter(p => p.url === "/orders").length;
  r = await chamar(tConecta, "/assinatura/cartao", "POST", { token: "token_conecta", cpfCnpj: "11.222.333/0001-81" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(pm.assinaturas.size, assinaturasAntes, "cadastrar o cartão não cria cobrança nenhuma");
  assert.equal(pm.pedidos.filter(p => p.url === "/orders").length, pedidosAntes2);
  assert.equal(pagamentos(conecta.org).length, 0);
  assert.equal([...pm.clientes.values()].at(-1).document_type, "CNPJ");
  r = await chamar(tConecta, "/assinatura/combinada", "POST", { valor: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sub = [...pm.assinaturas.values()].at(-1);
  assert.equal(sub.items[0].pricing_scheme.price, 150000, "o valor é o combinado, não o que veio no corpo");
  const venceIso = new Date(VENCE_CONECTA - new Date(VENCE_CONECTA).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  assert.equal(sub.start_at, venceIso, "a primeira cobrança cai no próximo vencimento, não hoje");
  assert.equal(r.body.pago, false);
  assert.equal(r.body.cobra_em, VENCE_CONECTA);
  assert.equal(linhaOrg(conecta.org).vence_em, VENCE_CONECTA, "o vencimento não é tocado");
  r = await chamar(tConecta, "/assinatura/combinada", "POST", {});
  assert.equal(r.status, 409, "ligar de novo não cria outra assinatura");
  const cobrancaConecta = novaCobranca({ amount: 150000, customer_id: linhaOrg(conecta.org).pagarme_customer_id, invoice: { subscription_id: sub.id } });
  await aviso({ type: "charge.paid", data: { id: cobrancaConecta.id } });
  assert.equal(pagamentos(conecta.org).length, 1, "a cobrança do vencimento credita um mês");
  assert.equal(pagamentos(conecta.org)[0].meses, 1);
  {
    const d = new Date(VENCE_CONECTA); d.setMonth(d.getMonth() + 1);
    assert.equal(linhaOrg(conecta.org).vence_em, d.getTime(), "o mês pago conta a partir do vencimento combinado");
  }
  r = await chamar(tConecta, "/assinatura");
  assert.equal(r.body.pagarme.combinada.ligada, true);

  caso("Preço combinado em atraso: a cobrança sai hoje, e a tela sabe disso antes");
  const tAtrasada = await login("atrasada@pm.com");
  r = await chamar(tAtrasada, "/assinatura");
  assert.equal(r.body.pagarme.combinada.primeira_cobranca, null, "sem vencimento futuro, a tela diz 'hoje'");
  await chamar(tAtrasada, "/assinatura/cartao", "POST", { token: "token_atrasada", cpfCnpj: "52998224725" });
  r = await chamar(tAtrasada, "/assinatura/combinada", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pago, true);
  assert.equal(pagamentos(atrasada.org).length, 1);
  r = await chamar(tSite, "/assinatura/combinada", "POST", {});
  assert.equal(r.status, 409, "conta com plano da tabela não usa a mensalidade combinada");

  caso("Trocar de plano no meio do período pago começa no vencimento, e o Marketing vem com o plano");
  const { temRecurso: tem } = await import("../src/services/recursos.js");
  const { planoPorId } = await import("../src/services/planos.js");
  assert.equal(planoPorId("essencial-mensal").inclui.includes("marketing"), false, "o Essencial mensal não traz Marketing");
  for (const id of ["essencial-semestral", "essencial-anual", "plus-mensal", "plus-semestral", "plus-anual"])
    assert.ok(planoPorId(id).inclui.includes("marketing"), `${id} traz Marketing`);
  assert.ok(!planoPorId("mensal").inclui.includes("marketing"), "o corretor autônomo continua sem");
  assert.equal(tem(conecta.org, "marketing"), false);
  const pagoAteConecta = linhaOrg(conecta.org).vence_em;
  const subCombinada = linhaOrg(conecta.org).pagarme_subscription_id;
  r = await chamar(tConecta, "/assinatura/plano", "POST", { plano_id: "essencial-semestral" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pago, false, "o período já pago não é cobrado de novo");
  sub = [...pm.assinaturas.values()].at(-1);
  const isoPagoAte = new Date(pagoAteConecta - new Date(pagoAteConecta).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  assert.equal(sub.start_at, isoPagoAte, "a assinatura nova começa no vencimento");
  assert.equal(sub.interval_count, 6);
  assert.ok(pm.canceladas.includes(subCombinada), "a mensalidade combinada sai");
  assert.equal(linhaOrg(conecta.org).vence_em, pagoAteConecta, "o vencimento não anda para trás nem para frente");
  assert.equal(tem(conecta.org, "marketing"), true, "Essencial semestral traz o Marketing");
  const semestral = novaCobranca({ amount: 256200, customer_id: linhaOrg(conecta.org).pagarme_customer_id, invoice: { subscription_id: sub.id } });
  await aviso({ type: "charge.paid", data: { id: semestral.id } });
  {
    const d = new Date(pagoAteConecta); d.setMonth(d.getMonth() + 6);
    assert.equal(linhaOrg(conecta.org).vence_em, d.getTime(), "seis meses a partir do vencimento, sem somar os meses antigos de novo");
  }

  caso("O cliente cancela: nada mais é cobrado e o acesso vai até o que foi pago");
  r = await chamar(tConecta, "/assinatura");
  assert.equal(r.body.cancelamento.pode, true);
  const subParaCancelar = linhaOrg(conecta.org).pagarme_subscription_id;
  r = await chamar(tConecta, "/assinatura/cancelar", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(pm.canceladas.includes(subParaCancelar), "cancelado no Pagar.me");
  assert.notEqual(r.body.status, "bloqueado", "o acesso continua até o vencimento");
  assert.equal(r.body.acesso_ate, linhaOrg(conecta.org).vence_em);
  assert.ok(r.body.cancelada_em);
  await aviso({ type: "subscription.canceled", data: { id: subParaCancelar } });
  r = await chamar(tConecta, "/assinatura");
  assert.notEqual(r.body.status, "bloqueado", "o aviso de cancelamento do Pagar.me não trava antes da hora");
  assert.equal(r.body.cancelamento.pode, false);
  r = await chamar(tConecta, "/assinatura/cancelar", "POST", {});
  assert.equal(r.status, 409);
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,'sdr',1,?,'ativo')`).run("u_" + randomUUID(), conecta.org, "Atendente Conecta", "at-conecta@pm.com", senha, Date.now());
  r = await chamar(await login("at-conecta@pm.com"), "/assinatura/cancelar", "POST", {});
  assert.equal(r.status, 403, "só o titular cancela");
  // Passado o que foi pago, a conta trava, sem carência.
  db.prepare("UPDATE orgs SET vence_em = ?, vence_base = NULL WHERE id = ?").run(Date.now() - 2 * DIA, conecta.org);
  db.prepare("DELETE FROM pagamentos WHERE org_id = ?").run(conecta.org);
  r = await chamar(tConecta, "/assinatura");
  assert.equal(r.body.status, "bloqueado");
  assert.match(r.body.motivo, /cancelada/);
  // Escolher um plano de novo volta.
  r = await chamar(tConecta, "/assinatura/plano", "POST", { plano_id: "essencial-mensal" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(linhaOrg(conecta.org).cancelado_em, null);
  assert.equal(r.body.pago, true, "sem período pago pela frente, cobra hoje");
  // O anual do Pagar.me não tem cobrança futura para cancelar.
  r = await chamar(tSite, "/assinatura");
  assert.equal(r.body.cancelamento.motivo, "anual");
  r = await chamar(tSite, "/assinatura/cancelar", "POST", {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /anual/);

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error("\n❌", e.message);
  process.exitCode = 1;
} finally {
  mock.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
