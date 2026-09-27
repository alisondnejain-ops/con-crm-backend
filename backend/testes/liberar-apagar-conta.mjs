/* LIBERAR PELO TEMPO QUE O MASTER QUISER, E APAGAR A CONTA DO CORRETOR
   (27/09/2026, pedido do Ali: "não encontro a opção de apagar a conta de
   corretor, só de travar, ou liberar 30 dias — queria liberar quanto tempo eu
   quisesse, sem interromper nenhum processo ou anular nada no sistema").

   Liberar:
   1. conta em teste: libera N dias e o teste mostra os dias certos;
   2. conta que JÁ PAGOU e está travada por atraso: antes o botão não fazia
      nada (só empurrava o teste, que não vale para quem já pagou). Agora abre
      até a data escolhida — sem tocar em pagamento nem no vencimento;
   3. vencida a liberação, volta à régua de sempre;
   4. conta do site sem cartão também abre;
   5. travar desfaz a liberação;
   6. prazos inválidos são recusados; só o master libera.

   Apagar:
   7. some TUDO que é da conta (inclusive tabelas que a lista antiga esquecia:
      WhatsApp, tags, tarefas, observações), a assinatura do Asaas é
      cancelada, e nada de outra conta — nem o master — é tocado.

   Rodar:  npm run teste:liberar-apagar-conta
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-liberar-apagar.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4653";
process.env.ASAAS_API_KEY = "chave-de-teste";
process.env.ASAAS_API_URL = "http://127.0.0.1:4654";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== O ASAAS DE MENTIRA: só registra o que pediram =====
const pedidosAsaas = [];
const mock = http.createServer((req, res) => {
  pedidosAsaas.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ deleted: true }));
});
await new Promise(r => mock.listen(4654, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { situacao } = await import("../src/services/assinatura.js");
const BASE = "http://localhost:4653";
await new Promise(r => setTimeout(r, 700));

const DIA = 86400000;
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const casaDoMaster = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(casaDoMaster, "ConHub", "LA-0", Date.now());
const master = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo',1)`).run(master, casaDoMaster, "Ali", "ali@la.com", senha, Date.now());

function autonomo(nome, extra = {}) {
  const org = "org_" + randomUUID().slice(0, 8), u = "u_" + randomUUID();
  db.prepare(`INSERT INTO orgs (id,name,adm_code,created_at,tipo,dono_user_id) VALUES (?,?,?,?,'autonomo',?)`)
    .run(org, nome, "LA-" + org.slice(4), Date.now(), u);
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,'corretor',1,?,'ativo')`).run(u, org, nome, nome.toLowerCase() + "@la.com", senha, Date.now());
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE orgs SET ${k} = ? WHERE id = ?`).run(v, org);
  return { org, u, email: nome.toLowerCase() + "@la.com" };
}

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login ${email}: ${JSON.stringify(d)}`); return d.token;
}
const chamar = (token, caminho, metodo = "GET", corpo) => fetch(BASE + caminho, { method: metodo,
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined });
const liberar = (token, org, corpo) => chamar(token, `/orgs/autonomos/${org}/liberar`, "POST", corpo);
const tAli = await entrar("ali@la.com");
const isoDaqui = (dias) => { const d = new Date(Date.now() + dias * DIA);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

console.log("1. Conta em teste: liberar 45 dias, e o teste mostra os 45");
const bruno = autonomo("Bruno", { trial_ate: Date.now() + 3 * DIA });
let r = await liberar(tAli, bruno.org, { dias: 45 });
assert.equal(r.status, 200);
let s = situacao(bruno.org);
console.log(`   ${s.status} · ${s.dias} dia(s)`);
assert.equal(s.status, "teste");
assert.ok(s.dias >= 44 && s.dias <= 45);

console.log("2. Conta que JÁ PAGOU e está travada por atraso: abre até a data escolhida");
const carla = autonomo("Carla", { vence_em: Date.now() - 20 * DIA, vence_base: Date.now() - 50 * DIA, dias_carencia: 5 });
db.prepare("INSERT INTO pagamentos (id,org_id,valor,pago_em,created_at) VALUES (?,?,?,?,?)")
  .run("p_" + randomUUID(), carla.org, 97, Date.now() - 50 * DIA, Date.now() - 50 * DIA);
assert.equal(situacao(carla.org).status, "bloqueado");
const tCarla = await entrar(carla.email);
assert.equal((await chamar(tCarla, "/leads")).status, 402, "antes de liberar, o porteiro barra");
const antes = db.prepare("SELECT vence_em, (SELECT COUNT(*) FROM pagamentos WHERE org_id = orgs.id) n FROM orgs WHERE id = ?").get(carla.org);
r = await liberar(tAli, carla.org, { ate: isoDaqui(20) });
const corpo = await r.json();
assert.equal(r.status, 200, JSON.stringify(corpo));
s = situacao(carla.org);
console.log(`   ${s.status} até ${new Date(s.liberado_ate).toLocaleDateString("pt-BR")} · hub mostra ${corpo.org.assinatura.status}`);
assert.equal(s.status, "liberado");
assert.equal(corpo.org.assinatura.status, "liberado");
assert.equal((await chamar(tCarla, "/leads")).status, 200, "a corretora volta a trabalhar");
const depois = db.prepare("SELECT vence_em, (SELECT COUNT(*) FROM pagamentos WHERE org_id = orgs.id) n FROM orgs WHERE id = ?").get(carla.org);
assert.deepEqual(depois, antes, "vencimento e pagamentos ficam exatamente como estavam");

console.log("3. Passada a data, volta à régua de sempre sozinha");
db.prepare("UPDATE orgs SET liberado_ate = ? WHERE id = ?").run(Date.now() - 2 * DIA, carla.org);
assert.equal(situacao(carla.org).status, "bloqueado");

console.log("4. Conta do site ainda sem cartão também abre");
const dani = autonomo("Dani", { exige_cartao: 1 });
assert.equal(situacao(dani.org).status, "aguardando_cartao");
await liberar(tAli, dani.org, { dias: 10 });
assert.equal(situacao(dani.org).status, "liberado");
assert.equal((await chamar(await entrar(dani.email), "/leads")).status, 200);

console.log("5. Travar desfaz a liberação");
r = await liberar(tAli, dani.org, { dias: -1 });
assert.equal(r.status, 200);
assert.equal(db.prepare("SELECT liberado_ate FROM orgs WHERE id = ?").get(dani.org).liberado_ate, null);
assert.equal(situacao(dani.org).status, "aguardando_cartao");
await liberar(tAli, bruno.org, { dias: -1 });
assert.equal(situacao(bruno.org).status, "bloqueado", "e a conta em teste trava como antes");

console.log("6. Prazos inválidos são recusados, e só o master libera");
for (const [pedido, motivo] of [[{ dias: 0 }, "zero dias"], [{ dias: 5000 }, "mais de 10 anos"],
  [{ ate: isoDaqui(-3) }, "data passada"], [{ ate: "10/10/2026" }, "formato errado"]]) {
  r = await liberar(tAli, bruno.org, pedido);
  const e = await r.json();
  console.log(`   ${motivo}: ${r.status} "${e.error}"`);
  assert.equal(r.status, 400);
}
r = await liberar(tCarla, carla.org, { dias: 999 });
assert.equal(r.status, 403, "a própria corretora não se libera");

console.log("7. Apagar a conta: some tudo dela, o Asaas é cancelado, o resto fica");
const eva = autonomo("Eva", { asaas_subscription_id: "sub_eva", asaas_customer_id: "cus_eva" });
const lead = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Lead',?,?)")
  .run(lead, eva.org, "Cliente da Eva", "5587911112222", Date.now(), eva.u);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','oi',?)").run("m_" + randomUUID(), lead, Date.now());
db.prepare("INSERT INTO canais (id,org_id,tipo,created_at) VALUES (?,?,'imobiliaria',?)").run("c_" + randomUUID(), eva.org, Date.now());
db.prepare("INSERT INTO observacoes (id,org_id,lead_id,texto,created_at) VALUES (?,?,?,?,?)").run("o_" + randomUUID(), eva.org, lead, "só à noite", Date.now());
// Um lead de OUTRA conta, que não pode sumir junto.
const leadDaCarla = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at) VALUES (?,?,?,?,'{}','Lead',?)")
  .run(leadDaCarla, carla.org, "Cliente da Carla", "5587933334444", Date.now());

r = await chamar(tAli, `/orgs/${eva.org}/apagar`);
const previa = await r.json();
console.log(`   prévia: ${previa.leads} lead(s), ${previa.mensagens} mensagem(ns), asaas=${previa.asaas}`);
assert.equal(previa.leads, 1);
assert.equal(previa.asaas, true);
r = await chamar(tAli, `/orgs/${eva.org}`, "DELETE", { confirmar: "Eva errado" });
assert.equal(r.status, 400, "nome errado não apaga");
r = await chamar(tAli, `/orgs/${eva.org}`, "DELETE", { confirmar: "Eva" });
const apagou = await r.json();
console.log(`   ${r.status} ${JSON.stringify(apagou)} · Asaas recebeu: ${pedidosAsaas.join(", ")}`);
assert.equal(r.status, 200);
assert.equal(apagou.asaas_aviso, null);
assert.ok(pedidosAsaas.includes("DELETE /subscriptions/sub_eva"), "a assinatura foi cancelada no Asaas");

const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
for (const t of tabelas) {
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
  if (cols.includes("org_id"))
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE org_id = ?`).get(eva.org).n, 0, `sobrou linha em ${t}`);
  if (cols.includes("lead_id"))
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE lead_id = ?`).get(lead).n, 0, `sobrou linha em ${t}`);
}
assert.equal(db.prepare("SELECT COUNT(*) n FROM orgs WHERE id = ?").get(eva.org).n, 0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id = ?").get(eva.u).n, 0, "o login da Eva deixa de existir");
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE id = ?").get(leadDaCarla).n, 1, "o lead da Carla continua");
assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id = ?").get(master).n, 1, "o master continua");
assert.equal((await chamar(tCarla, "/auth/me")).status, 200, "a Carla continua entrando");
assert.equal((await entrar("ali@la.com")).length > 0, true);

console.log("\nTudo certo ✅");
mock.close();
process.exit(0);
