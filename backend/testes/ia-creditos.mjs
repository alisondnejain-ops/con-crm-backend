/* CRÉDITO DE IA POR CONTA E O AGENTE QUE APRENDE (07/11/2026).

   - conta sem a cobrança por crédito: tudo como sempre (nada é debitado);
   - ligada e sem saldo: a IA não responde ("sem_credito"), nem no fluxo;
   - com saldo: cada resposta desconta custo × câmbio × margem, e o saldo
     baixo e o zerado avisam a gestão uma vez cada;
   - a compra: Pagar.me num clique (pago na hora), Asaas por fatura (pago pelo
     webhook), sem creditar duas vezes, estorno tira o crédito, pacote fora da
     lista recusado, corretor não compra;
   - o aprendizado: ao encerrar, a IA grava o que aprendeu (origem 'ia'), o
     dado pessoal é filtrado, entra no próximo pedido abaixo das regras da
     equipe, e desligado não aprende.

   A Anthropic, o Pagar.me e o Asaas são de mentira: roda offline.
   Rodar:  npm run teste:ia-creditos
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.TZ = "America/Recife";
const DB = path.join(os.tmpdir(), "concrm-teste-ia-creditos.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
Object.assign(process.env, { DB_PATH: DB, JWT_SECRET: "teste", PORT: "4809", ANTHROPIC_API_KEY: "chave-de-teste",
  UAZAPI_AUTOCONFIGURAR: "0", MARKETING_AGENDADOR: "0", ROBO_TRAVA_LOOP: "200",
  PAGARME_SECRET_KEY: "sk_test_x", PAGARME_PUBLIC_KEY: "pk_test_x", PAGARME_API_URL: "https://pagarme.teste/core/v5",
  ASAAS_API_KEY: "chave-asaas", ASAAS_API_URL: "https://asaas.teste/v3", ASAAS_WEBHOOK_TOKEN: "tk-asaas" });

const real = globalThis.fetch;
let respostaDaIA = { texto: "Oi! Me conta o que você procura?", coletado: {}, encerrar: false };
let aprendeu = { novas: [] };
let ultimoPedido = "", chamadasIA = 0;
const pedidosPg = [], pedidosAsaas = [];
let statusPagarme = "paid";
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    chamadasIA++;
    ultimoPedido = String(opts.body || "");
    const aprender = ultimoPedido.includes("acabou de encerrar um atendimento");
    return { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(aprender ? aprendeu : respostaDaIA) }],
      usage: { input_tokens: 1200, output_tokens: 90 } }) };
  }
  if (u.includes("uazapi.teste")) return { ok: true, status: 200, text: async () => JSON.stringify({ messageid: "wa_" + Date.now() }), json: async () => ({}) };
  if (u.includes("pagarme.teste")) {
    const corpo = opts.body ? JSON.parse(opts.body) : {};
    pedidosPg.push({ url: u, corpo });
    const resp = u.endsWith("/orders")
      ? { id: "or_" + pedidosPg.length, status: statusPagarme === "paid" ? "paid" : "failed", charges: [{ id: "ch_" + pedidosPg.length, status: statusPagarme }] }
      : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(resp), json: async () => resp };
  }
  if (u.includes("asaas.teste")) {
    const corpo = opts.body ? JSON.parse(opts.body) : {};
    pedidosAsaas.push({ url: u, corpo });
    let resp = {};
    if (u.endsWith("/customers")) resp = { id: "cus_1" };
    else if (u.endsWith("/payments") && opts.method === "POST") resp = { id: "pay_" + pedidosAsaas.length, invoiceUrl: "https://asaas.teste/i/" + pedidosAsaas.length, status: "PENDING" };
    else if (/\/payments\/pay_/.test(u)) resp = { id: u.split("/").pop(), status: "PENDING" };
    return { ok: true, status: 200, text: async () => JSON.stringify(resp), json: async () => resp };
  }
  return real(url, opts);
};

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
await new Promise(r => setTimeout(r, 1500));
const bcrypt = (await import("bcryptjs")).default;
const { atender, podeAtender, configDoRobo, orientacoes } = await import("../src/services/robo.js");
const C = await import("../src/services/ia-creditos.js");

const agora = Date.now();
const senha = bcrypt.hashSync("123456", 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,robo_ativo,robo_sempre,uazapi_host,uazapi_token) VALUES ('o1','Imobiliária Cred','CR-1',?,1,1,'https://uazapi.teste','tk-cred')").run(agora);
const user = (id, nome, role) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, "o1", nome, id + "@t.com", senha, role, agora);
user("u_g", "Gestora", "adm"); user("u_c", "Corretor", "corretor");
db.prepare("UPDATE orgs SET dono_user_id = 'u_g' WHERE id = 'o1'").run();

let n = 0;
const lead = (nome) => { const id = "l_" + (++n);
  db.prepare("INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at) VALUES (?,?,?,?,'{}','Lead',?)")
    .run(id, "o1", nome, "55879900" + String(10000 + n), agora); return id; };
const doCliente = (leadId, texto) => db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in',?,?)")
  .run("m_" + leadId + "_" + (++n), leadId, texto, Date.now() + n);
const saldo = () => db.prepare("SELECT ia_saldo_micro FROM orgs WHERE id='o1'").get().ia_saldo_micro / 1e6;

console.log("1. Conta sem a cobrança por crédito: a IA responde e nada é debitado");
let l = lead("Cliente Um"); doCliente(l, "Oi, quero um apartamento");
let r = await atender("o1", l, { atraso: 0 });
assert.equal(r.atendeu, true, JSON.stringify(r));
assert.equal(saldo(), 0);
assert.equal(db.prepare("SELECT debito_micro FROM ia_uso WHERE lead_id = ?").get(l).debito_micro, null);

console.log("2. Ligada e sem saldo: a IA não responde, e o motivo é o crédito");
C.ajustarPeloMaster("o1", { ligado: true });
l = lead("Cliente Dois"); doCliente(l, "Oi");
assert.equal(podeAtender("o1", l).motivo, "sem_credito");
const antes = chamadasIA;
r = await atender("o1", l, { atraso: 0 });
assert.equal(r.atendeu, false); assert.equal(chamadasIA, antes, "não chamou a IA");

console.log("3. Com saldo, cada resposta desconta custo × câmbio × margem");
C.salvarConfigDosCreditos({ cambio: 5, margem: 2, aviso_baixo: 1, pacotes: [10, 50] });
C.ajustarPeloMaster("o1", { reais: 1.05, motivo: "teste" });
r = await atender("o1", l, { atraso: 0 });
assert.equal(r.atendeu, true, JSON.stringify(r));
const usd = db.prepare("SELECT custo_usd FROM ia_uso WHERE lead_id = ? ORDER BY created_at DESC").get(l).custo_usd;
const esperado = Math.ceil(usd * 5 * 2 * 1e6) / 1e6;
console.log(`   custo US$ ${usd.toFixed(5)} → débito R$ ${esperado.toFixed(4)}`);
assert.ok(Math.abs((1.05 - saldo()) - esperado) < 1e-6, "débito diferente do custo × câmbio × margem");

console.log("4. Saldo abaixo do aviso: a gestão é avisada uma vez");
db.prepare("UPDATE orgs SET ia_saldo_micro = ? WHERE id='o1'").run(Math.round(1.01 * 1e6));
doCliente(l, "E o bairro?"); await atender("o1", l, { atraso: 0 });
const a1 = db.prepare("SELECT ia_aviso_baixo_em, ia_aviso_zero_em FROM orgs WHERE id='o1'").get();
assert.ok(a1.ia_aviso_baixo_em, "aviso de saldo baixo"); assert.ok(!a1.ia_aviso_zero_em);

console.log("5. Zerou: aviso de crédito acabou, e a próxima não sai");
db.prepare("UPDATE orgs SET ia_saldo_micro = 1000 WHERE id='o1'").run();   // R$ 0,001
doCliente(l, "Tem garagem?"); await atender("o1", l, { atraso: 0 });
assert.ok(saldo() <= 0); assert.ok(db.prepare("SELECT ia_aviso_zero_em FROM orgs WHERE id='o1'").get().ia_aviso_zero_em);
doCliente(l, "Alô?");
assert.equal(podeAtender("o1", l).motivo, "sem_credito");

// ===== Pela rota =====
const url = (p) => `http://127.0.0.1:4809${p}`;
const login = async (email) => (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tkG = await login("u_g@t.com"), tkC = await login("u_c@t.com");
const api = (tk, p, metodo = "GET", corpo) => fetch(url(p), { method: metodo,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${tk}` }, body: corpo ? JSON.stringify(corpo) : undefined });

console.log("6. A tela da gestão mostra o saldo e os pacotes; o corretor não vê");
let d = await (await api(tkG, "/assinatura/ia-creditos")).json();
assert.equal(d.ligado, true); assert.deepEqual(d.pacotes, [10, 50]); assert.equal(d.acabou, true);
assert.equal((await api(tkC, "/assinatura/ia-creditos")).status, 403);
assert.equal((await api(tkC, "/assinatura/ia-creditos/comprar", "POST", { valor: 10 })).status, 403);

console.log("7. Pacote fora da lista é recusado");
assert.equal((await api(tkG, "/assinatura/ia-creditos/comprar", "POST", { valor: 7 })).status, 400);

console.log("8. Pagar.me sem cartão guardado: pede o cartão; com cartão, cobra num clique e credita na hora");
db.prepare("UPDATE orgs SET cobranca = 'pagarme', pagarme_customer_id = 'cus_pg' WHERE id='o1'").run();
let x = await api(tkG, "/assinatura/ia-creditos/comprar", "POST", { valor: 10 });
assert.equal(x.status, 400);
db.prepare("UPDATE orgs SET pagarme_card_id = 'card_1', pagarme_card_json = ? WHERE id='o1'").run(JSON.stringify({ bandeira: "visa", final: "4242" }));
d = await (await api(tkG, "/assinatura/ia-creditos")).json();
assert.equal(d.cartao.final, "4242");
const saldoAntes = saldo();
x = await api(tkG, "/assinatura/ia-creditos/comprar", "POST", { valor: 10 });
d = await x.json(); assert.equal(x.status, 200, JSON.stringify(d)); assert.equal(d.pago, true);
assert.ok(Math.abs(saldo() - (saldoAntes + 10)) < 1e-6, "os R$ 10 entraram");
const pedido = pedidosPg.find(p => p.url.endsWith("/orders"));
assert.equal(pedido.corpo.items[0].amount, 1000); assert.equal(pedido.corpo.payments[0].credit_card.card_id, "card_1");

console.log("9. O mesmo pedido avisado pelo webhook não credita de novo; a IA volta a responder");
const mov = db.prepare("SELECT * FROM ia_creditos_mov WHERE tipo='compra' AND status='pago'").get();
assert.equal(C.confirmarCompra(mov), false);
assert.equal(podeAtender("o1", l).pode, true);
assert.equal(db.prepare("SELECT ia_aviso_zero_em FROM orgs WHERE id='o1'").get().ia_aviso_zero_em, null, "a compra rearma os avisos");

console.log("10. Cartão recusado: nada entra");
statusPagarme = "failed";
const s10 = saldo();
x = await api(tkG, "/assinatura/ia-creditos/comprar", "POST", { valor: 50 });
assert.equal(x.status, 402); assert.ok(Math.abs(saldo() - s10) < 1e-9);
statusPagarme = "paid";

console.log("11. Asaas: gera a fatura (Pix/cartão/boleto), credita pelo webhook uma vez só, e o estorno tira");
db.prepare("UPDATE orgs SET cobranca = 'asaas' WHERE id='o1'").run();
x = await api(tkG, "/assinatura/ia-creditos/comprar", "POST", { valor: 50, cpfCnpj: "111.444.777-35" });
d = await x.json(); assert.equal(x.status, 200, JSON.stringify(d)); assert.ok(d.url && d.url.includes("asaas.teste"));
const cobr = pedidosAsaas.find(p => p.url.endsWith("/payments") && p.corpo.value === 50);
assert.equal(cobr.corpo.billingType, "UNDEFINED");
const pay = db.prepare("SELECT cobranca_id FROM ia_creditos_mov WHERE provedor='asaas'").get().cobranca_id;
const s11 = saldo();
const hook = (event) => fetch(url("/webhooks/asaas"), { method: "POST", headers: { "Content-Type": "application/json", "asaas-access-token": "tk-asaas" },
  body: JSON.stringify({ event, payment: { id: pay, value: 50, status: event === "PAYMENT_REFUNDED" ? "REFUNDED" : "RECEIVED" } }) });
await hook("PAYMENT_RECEIVED"); await new Promise(r => setTimeout(r, 300));
assert.ok(Math.abs(saldo() - (s11 + 50)) < 1e-6, "os R$ 50 entraram pelo webhook");
await hook("PAYMENT_RECEIVED"); await new Promise(r => setTimeout(r, 300));
assert.ok(Math.abs(saldo() - (s11 + 50)) < 1e-6, "o aviso repetido não credita de novo");
await hook("PAYMENT_REFUNDED"); await new Promise(r => setTimeout(r, 300));
assert.ok(Math.abs(saldo() - s11) < 1e-6, "o estorno tira os R$ 50");

console.log("12. O master liga/desliga e lança crédito pelo hub; o cliente não");
assert.equal((await api(tkG, "/orgs/o1/ia-creditos", "POST", { reais: 100 })).status, 403);

console.log("13. Sem saldo, temCredito é falso — é a pergunta que o bloco \"Chamar a IA\" do fluxo faz antes de rodar");
db.prepare("UPDATE orgs SET ia_saldo_micro = 0 WHERE id='o1'").run();
const { temCredito } = C;
assert.equal(temCredito("o1"), false);

console.log("14. Aprendizado: ao encerrar, ela grava o que aprendeu (sem dado pessoal), e usa no próximo atendimento");
C.ajustarPeloMaster("o1", { reais: 20 });
db.prepare("INSERT INTO robo_ensino (id,org_id,texto,ordem,ativo,created_at) VALUES ('en_eq','o1','Trate o cliente por você.',1,1,?)").run(agora);
const lA = lead("Joana Prado");
doCliente(lA, "Oi, quero alugar perto da praia"); doCliente(lA, "Aceitam pet?");
aprendeu = { novas: ["Quando perguntarem se aceita pet, diga que o corretor confirma com o proprietário.",
  "Ligue para Joana no 87999998888 amanhã.", "Pergunte logo no início se é para comprar ou alugar."] };
respostaDaIA = { texto: "Vou passar para a equipe, obrigado!", coletado: {}, encerrar: true };
r = await atender("o1", lA, { atraso: 0 });
assert.equal(r.encerrou, true);
await new Promise(res => setTimeout(res, 300));
const ap = db.prepare("SELECT texto FROM robo_ensino WHERE org_id='o1' AND origem='ia'").all().map(x => x.texto);
console.log("   aprendeu:", ap);
assert.equal(ap.length, 2, "o dado pessoal não entra");
assert.ok(!ap.some(t => t.includes("8799")));
assert.ok(db.prepare("SELECT debito_micro FROM ia_uso WHERE recurso='aprendizado'").get()?.debito_micro > 0, "o aprendizado gasta crédito");

console.log("15. O que ela aprendeu entra no próximo pedido, abaixo das regras da equipe");
respostaDaIA = { texto: "Oi! É para comprar ou alugar?", coletado: {}, encerrar: false };
const lB = lead("Outro Cliente"); doCliente(lB, "Oi");
await atender("o1", lB, { atraso: 0 });
const p = JSON.parse(ultimoPedido).messages[0].content[0].text;
const iEq = p.indexOf("Trate o cliente por você"), iAp = p.indexOf("O QUE VOCÊ APRENDEU");
assert.ok(iEq > 0 && iAp > iEq, "as aprendidas vêm depois das da equipe");
assert.ok(p.includes("aceita pet"));

console.log("16. A mesma conversa não ensina duas vezes; repetida não entra; desligado não aprende");
const lC = lead("Mais Um"); doCliente(lC, "Oi"); doCliente(lC, "Aceitam pet?");
respostaDaIA = { texto: "Obrigado!", coletado: {}, encerrar: true };
await atender("o1", lC, { atraso: 0 }); await new Promise(res => setTimeout(res, 300));
assert.equal(db.prepare("SELECT COUNT(*) n FROM robo_ensino WHERE org_id='o1' AND origem='ia'").get().n, 2, "as mesmas frases não entram de novo");
db.prepare("UPDATE orgs SET robo_aprender = 0 WHERE id='o1'").run();
assert.equal(configDoRobo("o1").aprender, false);
aprendeu = { novas: ["Sempre ofereça o tour virtual quando houver."] };
const lD = lead("Cliente Final"); doCliente(lD, "Oi"); doCliente(lD, "Tchau");
await atender("o1", lD, { atraso: 0 }); await new Promise(res => setTimeout(res, 300));
assert.equal(db.prepare("SELECT COUNT(*) n FROM robo_ensino WHERE org_id='o1' AND origem='ia'").get().n, 2);

console.log("17. A equipe continua com o próprio teto de orientações (as aprendidas não contam)");
const lista = await (await api(tkG, "/config/robo/ensino")).json();
assert.equal(lista.linhas.filter(x => x.origem === "ia").length, 2);
assert.equal(lista.linhas[0].texto, "Trate o cliente por você.", "as da equipe primeiro");

console.log("\nOK — crédito de IA por conta e aprendizado do agente.");
process.exit(0);
