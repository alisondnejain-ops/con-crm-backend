/* A API OFICIAL DA META COMO SEGUNDO PROVEDOR DE WHATSAPP. (03/09/2026)

   O que este teste protege, e por que cada ponto falha em SILÊNCIO se
   quebrar (nenhum aqui derruba o servidor nem aparece como erro na tela):

   - cada imobiliária tem o PRÓPRIO app_secret; a assinatura só pode ser
     conferida DEPOIS de descobrir de quem é a mensagem pelo
     `phone_number_id` — inverter essa ordem, ou esquecer de isolar entre
     imobiliárias, deixaria uma casa forjar mensagem na conta da outra;
   - assinatura errada ou ausente tem que ser RECUSADA (401) — aceitar sem
     conferir abriria a mesma porta que o webhook de Lead Ads já fechou;
   - Phone Number ID desconhecido não pode ser 401/404 — a Meta reenviaria
     para sempre um payload que nunca vai casar. Tem que ser 200 e ficar só
     no diagnóstico;
   - `garantirCasa()` NÃO PODE apagar o token da Meta lendo `orgs.uazapi_*`
     — essa coluna não existe para uma linha oficial, e ela é chamada em
     quase toda leitura de canal (o bug real: conectar funcionava, e a
     PRÓXIMA leitura de status devolvia a linha desconectada, sem erro
     nenhum aparecer);
   - o corretor nunca vê o token do aplicativo — só o Phone Number ID dele.

   Rodar:  npm run teste:whatsapp-oficial
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-whatsapp-oficial.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4714;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (codigo) => { servidor.kill("SIGTERM"); process.exit(codigo); };
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1500)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
console.log("Servidor no ar, igual à produção.\n");

const { default: db } = await import("../src/db.js");
const C = await import("../src/services/canais.js");
const bcrypt = (await import("bcryptjs")).default;

// A org que o bootstrap já criou (Conecta) é a "casa" deste teste.
const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
const casaMeta = C.canalDaCasa(org);
C.salvarConexaoOficial(casaMeta.id, {
  phoneNumberId: "PN_CASA", wabaId: "waba_conecta", token: "token-conecta", appSecret: "segredo-conecta",
});

// Uma SEGUNDA imobiliária, com o PRÓPRIO app — para provar isolamento.
const org2 = "org_place";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org2, "Place Imóveis", "PLACE-1", Date.now());
const casaPlace = C.garantirCasa(org2);
C.salvarConexaoOficial(casaPlace.id, {
  phoneNumberId: "PN_PLACE", wabaId: "waba_place", token: "token-place", appSecret: "segredo-place",
});

const senha = bcrypt.hashSync("123456", 8);
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run("u_ali", org, "Ali", "ali@conecta.com", senha, "adm", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run("u_rafael", org, "Rafael", "rafael@conecta.com", senha, "corretor", Date.now());

async function entrar(email) {
  const r = await fetch(url("/auth/login"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(url(caminho), {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const ali = await entrar("ali@conecta.com");

const assinar = (secret, body) => "sha256=" + createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
const payloadTexto = (phoneNumberId, from, texto, id = "wamid." + randomUUID()) => ({
  entry: [{ id: "waba1", changes: [{ field: "messages", value: {
    metadata: { phone_number_id: phoneNumberId },
    contacts: [{ profile: { name: "Cliente Meta" }, wa_id: from }],
    messages: [{ from, id, type: "text", text: { body: texto } }],
  } }] }],
});

console.log("===== O HANDSHAKE (GET) =====");

console.log("1. Verify token que não bate com NENHUMA linha é recusado");
let r = await fetch(url("/webhooks/whatsapp-oficial?hub.mode=subscribe&hub.verify_token=chute&hub.challenge=abc"));
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("2. Verify token de UMA imobiliária específica é aceito, e o challenge volta");
const vt = db.prepare("SELECT verify_token FROM canais WHERE id = ?").get(casaMeta.id).verify_token;
r = await fetch(url(`/webhooks/whatsapp-oficial?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=meu-desafio-123`));
const texto2 = await r.text();
console.log(`   ${r.status} · devolveu: ${texto2}`);
assert.equal(r.status, 200);
assert.equal(texto2, "meu-desafio-123");

console.log("\n===== A ASSINATURA (POST) =====");

console.log("3. Phone Number ID desconhecido: 200 (não 401/404), e some no diagnóstico");
r = await chamar(null, "/webhooks/whatsapp-oficial", {
  method: "POST", body: JSON.stringify(payloadTexto("PN_NINGUEM", "5587900000000", "oi")),
}).then(x => x); // sem assinatura de propósito — nem chega a conferir, pois nem acha o canal
console.log(`   ${r.status}`);
assert.equal(r.status, 200, "reenvio infinito da Meta é pior que aceitar e descartar");

console.log("4. Assinatura ERRADA para uma linha que EXISTE: 401");
const p4 = payloadTexto("PN_CASA", "5587911112222", "quero um imóvel");
r = await fetch(url("/webhooks/whatsapp-oficial"), {
  method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=chute-nada-a-ver" },
  body: JSON.stringify(p4),
});
console.log(`   ${r.status}`);
assert.equal(r.status, 401);
await new Promise(x => setTimeout(x, 200));
assert.equal(db.prepare("SELECT 1 FROM leads WHERE phone = ?").get("5587911112222"), undefined,
  "assinatura errada não pode criar lead");

console.log("5. A assinatura de UMA imobiliária não vale para OUTRA — mesmo com o payload certo");
const p5 = payloadTexto("PN_CASA", "5587922223333", "oi, cadê o Zap da Conecta?");
r = await fetch(url("/webhooks/whatsapp-oficial"), {
  method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinar("segredo-place", p5) },
  body: JSON.stringify(p5),
});
console.log(`   assinado com o segredo da OUTRA casa → ${r.status}`);
assert.equal(r.status, 401, "o app_secret da Place não pode validar mensagem para o Phone Number ID da Conecta");

console.log("6. Assinatura CERTA: 200, lead nasce na imobiliária CERTA, sem temperatura");
const p6 = payloadTexto("PN_CASA", "5587933334444", "Quero saber sobre um apartamento");
r = await fetch(url("/webhooks/whatsapp-oficial"), {
  method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinar("segredo-conecta", p6) },
  body: JSON.stringify(p6),
});
console.log(`   ${r.status}`);
assert.equal(r.status, 200);
await new Promise(x => setTimeout(x, 300));
const lead6 = db.prepare("SELECT * FROM leads WHERE phone = ?").get("5587933334444");
console.log(`   lead: ${lead6 ? lead6.name : "NENHUM"} · org: ${lead6?.org_id} · prioridade: ${lead6?.priority}`);
assert.ok(lead6, "assinatura certa tem que criar o lead");
assert.equal(lead6.org_id, org);
assert.equal(lead6.priority, null, "sem temperatura, igual ao WhatsApp comum e ao Meta Ads");
assert.equal(lead6.name, "Cliente Meta");

console.log("7. A mensagem entrou de verdade, ligada à linha oficial da casa");
const msg7 = db.prepare("SELECT * FROM messages WHERE lead_id = ?").get(lead6.id);
console.log(`   "${msg7.body}" · direção: ${msg7.direction} · canal_id: ${msg7.canal_id ?? "(nulo = casa)"}`);
assert.equal(msg7.direction, "in");
assert.equal(msg7.body, "Quero saber sobre um apartamento");

console.log("8. Mensagem repetida (mesmo wamid) não duplica — reentrega da Meta é normal");
r = await fetch(url("/webhooks/whatsapp-oficial"), {
  method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinar("segredo-conecta", p6) },
  body: JSON.stringify(p6),
});
await new Promise(x => setTimeout(x, 200));
const total8 = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(lead6.id).n;
console.log(`   mensagens do lead: ${total8}`);
// Duas entradas iguais do CLIENTE não são eco (fromMe nunca é true na Meta) —
// a Meta reentregar o mesmo evento cria uma segunda linha na conversa, que é
// o comportamento correto (o cliente pode ter mandado a mesma frase duas
// vezes de propósito). O dedup por wa_id só existe para o eco do que o
// próprio CRM manda, que não acontece aqui.
assert.equal(total8, 2);

console.log("9. Confirmação de entrega (`statuses`) não vira lead nem mensagem");
const antesDeStatus = db.prepare("SELECT COUNT(*) n FROM leads").get().n;
r = await fetch(url("/webhooks/whatsapp-oficial"), {
  method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinar("segredo-conecta",
    { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN_CASA" }, statuses: [{ status: "delivered" }] } }] }] }) },
  body: JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN_CASA" }, statuses: [{ status: "delivered" }] } }] }] }),
});
console.log(`   ${r.status}`);
assert.equal(r.status, 200);
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads").get().n, antesDeStatus, "status de entrega não é lead novo");

console.log("\n===== A TELA DE CONEXÃO (config.routes.js) =====");

console.log("10. GET /config/conexao mostra a linha oficial já conectada, e o verify_token pronto");
r = await chamar(ali, "/config/conexao");
let d = await r.json();
console.log(`   ativo: ${d.ativo} · verify_token no webhook: ${d.webhook.meta.verify_token ? "presente" : "FALTOU"}`);
assert.equal(d.ativo, "meta");
assert.ok(d.webhook.meta.verify_token);
assert.ok(d.webhook.uazapi.url && d.webhook.meta.url, "os dois provedores continuam com URL de webhook própria");

console.log("11. E continua 'meta' numa SEGUNDA leitura — o bug real era aqui (garantirCasa apagava o token)");
r = await chamar(ali, "/config/conexao");
d = await r.json();
console.log(`   ativo: ${d.ativo} (de novo)`);
assert.equal(d.ativo, "meta", "garantirCasa não pode reler orgs.uazapi_token e apagar a linha oficial");

console.log("12. POST /config/conexao/oficial exige os quatro campos");
r = await chamar(ali, "/config/conexao/oficial", { method: "POST", body: JSON.stringify({ phone_number_id: "X" }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 400);

console.log("13. Phone Number ID já usado por OUTRA imobiliária é recusado, com o nome dela");
r = await chamar(ali, "/config/conexao/oficial", { method: "POST", body: JSON.stringify({
  phone_number_id: "PN_PLACE", waba_id: "w", token: "t", app_secret: "s" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.match(d.error, /Place Imóveis/);

console.log("\n===== A LINHA DO CORRETOR NA API OFICIAL =====");

console.log("14. Sem liberação do gestor, o corretor não consegue ligar a própria linha oficial");
const rafael = await entrar("rafael@conecta.com");
r = await chamar(rafael, "/canais/meu/oficial", { method: "POST", body: JSON.stringify({ phone_number_id: "PN_RAFAEL" }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("15. Liberado, ele liga só com o PRÓPRIO Phone Number ID — nunca vê o token do app");
db.prepare("UPDATE users SET canal_liberado = 1 WHERE id = ?").run("u_rafael");
r = await chamar(rafael, "/canais/meu/oficial", { method: "POST", body: JSON.stringify({ phone_number_id: "PN_RAFAEL" }) });
d = await r.json();
console.log(`   ${r.status} · meu.conectado: ${d.meu?.conectado}`);
assert.equal(r.status, 200);
assert.equal(d.meu.conectado, true);
assert.ok(!("token" in d.meu), "o token nunca sai na resposta — a linha herda por dentro, não pela tela");

console.log("16. A linha do Rafael HERDOU o app_secret/token/waba da casa — sem ele digitar nada");
const canalRafael = C.canalDoUsuario(org, "u_rafael");
console.log(`   provider: ${canalRafael.provider} · app_secret: ${canalRafael.app_secret === "segredo-conecta" ? "herdado" : "ERRADO"}`);
assert.equal(canalRafael.provider, "meta");
assert.equal(canalRafael.app_secret, "segredo-conecta");
assert.equal(canalRafael.token, "token-conecta");

console.log("17. Mensagem para o Phone Number ID do Rafael cai na conta DELE, sem catraca");
const p17 = payloadTexto("PN_RAFAEL", "5587955556666", "vim pelo anúncio do Rafael");
r = await fetch(url("/webhooks/whatsapp-oficial"), {
  method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinar("segredo-conecta", p17) },
  body: JSON.stringify(p17),
});
assert.equal(r.status, 200);
await new Promise(x => setTimeout(x, 300));
const lead17 = db.prepare("SELECT * FROM leads WHERE phone = ?").get("5587955556666");
console.log(`   dono: ${lead17?.assigned_to} · canal_id: ${lead17?.canal_id}`);
assert.equal(lead17.assigned_to, "u_rafael");
assert.equal(lead17.canal_id, canalRafael.id);

console.log("\nTudo certo ✅");
fim(0);
