/* AS FERRAMENTAS DE CADA CONTA (29/09/2026, pedido do Ali: o Autoatendimento
   com IA passa a ser dos planos completos, o master libera ou retira de
   qualquer cliente, e o cliente pode contratar a ferramenta avulsa, com
   cobrança automática).

   Sobe o servidor de verdade e um Asaas de mentira. Confere:
    1. quem vem no plano (básico sem IA, completo com IA, conta antiga sem
       plano mantém a IA, Marketing em plano nenhum);
    2. sem a ferramenta, o robô não fala e não se liga;
    3. o master libera e retira, nos dois sentidos, e só ele;
    4. contratar avulso cria uma assinatura PRÓPRIA no Asaas, e o pagamento
       dela liga a ferramenta SEM virar mês pago da mensalidade;
    5. o eco repetido do Asaas não dá dois meses; cancelar mantém até o fim
       do que foi pago; estorno desliga na hora;
    6. a sessão traz as ferramentas (é o que decide o menu).

   Rodar:  npm run teste:ferramentas
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-ferramentas.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4661";
process.env.ASAAS_API_KEY = "$aact_test_chave_de_teste";
process.env.ASAAS_SANDBOX = "true";
process.env.ASAAS_WEBHOOK_TOKEN = "webhook-ferramentas";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

// ===== O ASAAS DE MENTIRA =====
let contador = 0;
const criadas = [];            // corpo de cada POST /subscriptions
const canceladas = [];         // ids cancelados
const cobrancas = new Map();   // assinatura -> pagamentos
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    const dados = corpo ? JSON.parse(corpo) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/customers") return res.end(JSON.stringify({ id: "cus_" + (++contador) }));
    if (req.method === "POST" && req.url === "/subscriptions") {
      const id = "sub_" + (++contador);
      criadas.push({ id, ...dados });
      cobrancas.set(id, [{ id: "pay_" + contador, status: "PENDING", invoiceUrl: "https://mock.asaas/f/" + id }]);
      return res.end(JSON.stringify({ id }));
    }
    let m = req.url.match(/^\/subscriptions\/([^/]+)\/payments$/);
    if (req.method === "GET" && m) return res.end(JSON.stringify({ data: cobrancas.get(m[1]) || [] }));
    m = req.url.match(/^\/subscriptions\/([^/]+)$/);
    if (req.method === "DELETE" && m) { canceladas.push(m[1]); return res.end(JSON.stringify({ deleted: true })); }
    res.statusCode = 404; res.end(JSON.stringify({ error: "rota não simulada " + req.method + " " + req.url }));
  });
});
await new Promise(r => mock.listen(0, "127.0.0.1", r));
process.env.ASAAS_API_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const bcrypt = (await import("bcryptjs")).default;
const { temRecurso } = await import("../src/services/recursos.js");
const { podeAtender } = await import("../src/services/robo.js");
await import("../src/server.js");
const BASE = "http://localhost:4661";
await new Promise(r => setTimeout(r, 700));

const senha = bcrypt.hashSync("123456", 8);
const casaMaster = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casaMaster, "Casa do ConHub", "CH-1", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo',1)`).run("u_" + randomUUID(), casaMaster, "Ali", "ali@fe.com", senha, Date.now());

// Uma conta por situação: plano básico, plano completo, sem plano (antiga).
function conta(nome, tipo, planoId, email) {
  const org = "org_" + randomUUID().slice(0, 8), dono = "u_" + randomUUID();
  db.prepare(`INSERT INTO orgs (id,name,adm_code,created_at,tipo,plano_id,dono_user_id) VALUES (?,?,?,?,?,?,?)`)
    .run(org, nome, "C-" + org.slice(4), Date.now(), tipo, planoId, dono);
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(dono, org, nome + " Dono", email, senha, tipo === "autonomo" ? "corretor" : "adm", Date.now());
  return org;
}
const basico = conta("Corretor Básico", "autonomo", "basico", "basico@fe.com");
const completo = conta("Corretor Completo", "autonomo", "anual", "completo@fe.com");
const antiga = conta("Imobiliária Antiga", "imobiliaria", null, "antiga@fe.com");
const essencial = conta("Imobiliária Essencial", "imobiliaria", "essencial-semestral", "essencial@fe.com");

const login = async (email) => {
  const d = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) })).json();
  assert.ok(d.token, `login ${email}: ${JSON.stringify(d)}`); return d;
};
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, { ...opts,
  headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });
const webhook = (corpo) => fetch(`${BASE}/webhooks/asaas`, { method: "POST",
  headers: { "content-type": "application/json", "asaas-access-token": "webhook-ferramentas" }, body: JSON.stringify(corpo) });
const espera = (ms) => new Promise(r => setTimeout(r, ms));

console.log("1. Quem vem no plano");
assert.equal(temRecurso(basico, "autoatendimento"), false, "o básico (R$ 97) não traz a IA");
assert.equal(temRecurso(completo, "autoatendimento"), true, "o completo traz, em qualquer ciclo");
assert.equal(temRecurso(essencial, "autoatendimento"), true, "o Essencial traz");
assert.equal(temRecurso(antiga, "autoatendimento"), true, "conta sem plano de prateleira MANTÉM a IA (decisão do Ali)");
for (const o of [basico, completo, antiga, essencial])
  assert.equal(temRecurso(o, "marketing"), false, "Marketing não vem em plano nenhum");
console.log("   básico ✗ · completo ✓ · Essencial ✓ · antiga ✓ · Marketing ✗ em todas");

console.log("2. Sem a ferramenta o robô não fala, e não se liga");
db.prepare("UPDATE orgs SET robo_ativo = 1, robo_sempre = 1 WHERE id = ?").run(basico);
const lead = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,?,?)").run(lead, basico, "Cliente", "5587999990000", "Lead", Date.now());
assert.equal(podeAtender(basico, lead).motivo, "sem_autoatendimento");
const tBasico = (await login("basico@fe.com")).token;
let r = await chamar(tBasico, "/config/robo", { method: "POST", body: JSON.stringify({ ativo: true }) });
console.log(`   ligar sem a ferramenta → ${r.status}`);
assert.equal(r.status, 403);
assert.match((await r.json()).error, /não está no seu plano/);
r = await chamar(tBasico, "/config/robo");
let d = await r.json();
assert.equal(d.incluido, false);
assert.equal(d.ferramenta.origem, "fora_do_plano");

console.log("3. A sessão traz as ferramentas (é o que decide o menu)");
let s = await login("basico@fe.com");
assert.deepEqual(s.org.recursos, { autoatendimento: false, marketing: false });
assert.equal(s.org.marketing_liberado, false);

console.log("4. O master libera e retira, nos dois sentidos — e só ele");
const tMaster = (await login("ali@fe.com")).token;
r = await chamar(tBasico, `/orgs/${basico}/recursos/autoatendimento`, { method: "POST", body: JSON.stringify({ estado: "liberado" }) });
assert.equal(r.status, 403, "o cliente não se libera sozinho");
r = await chamar(tMaster, `/orgs/${basico}/recursos/autoatendimento`, { method: "POST", body: JSON.stringify({ estado: "liberado" }) });
d = await r.json();
assert.equal(r.status, 200);
assert.equal(d.org.recursos.find(x => x.id === "autoatendimento").origem, "liberado");
assert.equal(temRecurso(basico, "autoatendimento"), true, "liberado vale fora do plano");
r = await chamar(tMaster, `/orgs/${completo}/recursos/autoatendimento`, { method: "POST", body: JSON.stringify({ estado: "retirado" }) });
assert.equal(temRecurso(completo, "autoatendimento"), false, "retirado vale mesmo estando no plano");
r = await chamar(tMaster, `/orgs/${completo}/recursos/autoatendimento`, { method: "POST", body: JSON.stringify({ estado: null }) });
assert.equal(temRecurso(completo, "autoatendimento"), true, "'seguir o plano' desfaz a escolha");
r = await chamar(tMaster, `/orgs/${basico}/recursos/nada`, { method: "POST", body: JSON.stringify({ estado: "liberado" }) });
assert.equal(r.status, 404);
r = await chamar(tMaster, `/orgs/${basico}/recursos/autoatendimento`, { method: "POST", body: JSON.stringify({ estado: null }) });
assert.equal(temRecurso(basico, "autoatendimento"), false);
// O botão antigo do Marketing continua funcionando, pelo mesmo caminho.
r = await chamar(tMaster, `/orgs/${antiga}/marketing`, { method: "POST", body: JSON.stringify({ liberado: true }) });
assert.equal(r.status, 200);
assert.equal(temRecurso(antiga, "marketing"), true);
console.log("   liberar/retirar/seguir o plano ok · cliente recebe 403 · botão antigo do Marketing ok");

console.log("5. Contratar avulso: assinatura PRÓPRIA no Asaas, R$ 97, no cartão");
r = await chamar(tBasico, "/assinatura/recursos");
d = await r.json();
assert.equal(r.status, 200);
assert.equal(d.pede_cpf, true);
r = await chamar(tBasico, "/assinatura/recursos/autoatendimento", { method: "POST", body: JSON.stringify({ cpfCnpj: "123" }) });
assert.equal(r.status, 400, "CPF inválido é recusado antes de falar com o Asaas");
r = await chamar(tBasico, "/assinatura/recursos/autoatendimento", { method: "POST", body: JSON.stringify({ cpfCnpj: "111.444.777-35" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.url}`);
assert.equal(r.status, 200);
const sub = criadas.at(-1);
assert.equal(sub.value, 97);
assert.equal(sub.billingType, "CREDIT_CARD");
assert.equal(sub.cycle, "MONTHLY");
assert.match(sub.description, /Autoatendimento com IA \(ferramenta avulsa · R\$\s?97,00\/mês\)/);
assert.equal(temRecurso(basico, "autoatendimento"), false, "ainda não pagou");
assert.equal(d.recurso.avulso.status, "aguardando");
r = await chamar(tBasico, "/assinatura/recursos/autoatendimento", { method: "POST", body: JSON.stringify({ cpfCnpj: "11144477735" }) });
assert.equal(r.status, 200, "tentar de novo sem ter pago cria outra fatura...");
assert.ok(canceladas.includes(sub.id), "...e cancela a tentativa anterior, para não ficarem duas abertas");
const sub2 = criadas.at(-1);
const vencAntes = db.prepare("SELECT vence_em, vence_base FROM orgs WHERE id = ?").get(basico);

console.log("6. O pagamento da ferramenta liga a ferramenta — e NÃO vira mês de mensalidade");
await webhook({ event: "PAYMENT_CONFIRMED", payment: { id: "pay_x1", subscription: sub2.id, value: 97 } });
await espera(200);
assert.equal(temRecurso(basico, "autoatendimento"), true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?").get(basico).n, 0, "nenhum pagamento de mensalidade registrado");
assert.deepEqual(db.prepare("SELECT vence_em, vence_base FROM orgs WHERE id = ?").get(basico), vencAntes, "o vencimento do plano não andou");
const ate1 = db.prepare("SELECT avulso_pago_ate FROM org_recursos WHERE org_id = ? AND recurso = 'autoatendimento'").get(basico).avulso_pago_ate;
await webhook({ event: "PAYMENT_RECEIVED", payment: { id: "pay_x1", subscription: sub2.id, value: 97 } });
await espera(200);
const ate2 = db.prepare("SELECT avulso_pago_ate FROM org_recursos WHERE org_id = ? AND recurso = 'autoatendimento'").get(basico).avulso_pago_ate;
assert.equal(ate2, ate1, "CONFIRMED + RECEIVED da mesma cobrança não dão dois meses");
assert.equal(podeAtender(basico, lead).motivo === "sem_autoatendimento", false, "com a ferramenta paga o robô volta a poder falar");
r = await chamar(tBasico, "/assinatura/recursos/autoatendimento", { method: "POST", body: JSON.stringify({}) });
assert.equal(r.status, 409, "já está ligada: não contrata duas vezes");
s = await login("basico@fe.com");
assert.equal(s.org.recursos.autoatendimento, true);
console.log("   ligada · 0 pagamento de mensalidade · vencimento intacto · evento repetido não soma");

console.log("7. A checagem ao vivo também liga (se o webhook falhar)");
const tEss = (await login("essencial@fe.com")).token;
r = await chamar(tEss, "/assinatura/recursos/marketing", { method: "POST", body: JSON.stringify({ cpfCnpj: "11144477735" }) });
assert.equal(r.status, 200);
const subMkt = criadas.at(-1);
assert.equal(temRecurso(essencial, "marketing"), false);
cobrancas.get(subMkt.id)[0].status = "CONFIRMED";
r = await chamar(tEss, "/assinatura/recursos");
d = await r.json();
assert.equal(d.recursos.find(x => x.id === "marketing").ativo, true);
assert.equal(d.recursos.find(x => x.id === "marketing").origem, "avulso");

console.log("8. Cancelar: vale até o fim do que foi pago; estorno desliga na hora");
r = await chamar(tBasico, "/assinatura/recursos/autoatendimento", { method: "DELETE" });
assert.equal(r.status, 200);
assert.ok(canceladas.includes(sub2.id));
assert.equal(temRecurso(basico, "autoatendimento"), true, "cancelou, mas o mês pago continua valendo");
assert.equal(temRecurso(basico, "autoatendimento", Date.now() + 40 * 86400000), false, "passado o mês pago (e a folga), desliga");
await webhook({ event: "PAYMENT_REFUNDED", payment: { id: "pay_m1", subscription: subMkt.id, value: 97 } });
await espera(200);
assert.equal(temRecurso(essencial, "marketing"), false, "estorno desliga na hora");

console.log("9. O master retira mesmo o que foi pago, e a tela dele sabe que era pago");
db.prepare("UPDATE org_recursos SET avulso_status = 'ativo', avulso_pago_ate = ? WHERE org_id = ? AND recurso = 'autoatendimento'")
  .run(Date.now() + 20 * 86400000, basico);
r = await chamar(tMaster, `/orgs/${basico}/recursos/autoatendimento`, { method: "POST", body: JSON.stringify({ estado: "retirado" }) });
d = await r.json();
const noHub = d.org.recursos.find(x => x.id === "autoatendimento");
assert.equal(noHub.ativo, false);
assert.equal(noHub.avulso.valendo, true, "o hub avisa que havia cobrança avulsa valendo");
r = await chamar(tBasico, "/assinatura/recursos/autoatendimento", { method: "POST", body: JSON.stringify({}) });
assert.equal(r.status, 403, "retirada pelo ConHub não se recontrata sozinha");

console.log("10. Plano: o básico aparece na tela de planos do autônomo, e o site continua com os três de antes");
r = await chamar(tBasico, "/assinatura/planos");
d = await r.json();
assert.deepEqual(d.planos.map(p => p.id), ["basico", "mensal", "semestral", "anual"]);
assert.deepEqual(d.planos.find(p => p.id === "basico").inclui, []);
d = await (await fetch(`${BASE}/publico/planos`)).json();
assert.deepEqual(d.autonomo.map(p => p.id), ["mensal", "semestral", "anual"], "a vitrine publicada não ganha um quarto card sozinha");
assert.deepEqual(d.autonomo_basico.map(p => p.id), ["basico"]);

mock.close();
console.log("\nTudo certo ✅");
process.exit(0);
