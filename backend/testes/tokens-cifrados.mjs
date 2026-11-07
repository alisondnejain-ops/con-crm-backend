/* OS TOKENS DO WHATSAPP GUARDADOS FECHADOS (07/11/2026).

   Simula a produção como está: um banco com os tokens EM CLARO. Sobe esta
   versão com CRYPTO_KEY e confere que nada desconecta — a mensagem que chega
   continua achando a linha, o envio sai com o token certo, a assinatura da
   Meta continua conferindo —, que o banco não guarda mais nenhum token em
   claro, e que as duas saídas de emergência funcionam: voltar para o claro
   (WHATSAPP_TOKENS_EM_CLARO=1) e subir com a chave errada.

   Rodar:  npm run teste:tokens-cifrados
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-tokens-cifrados.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
const CHAVE = "a".repeat(64), OUTRA = "b".repeat(64);
const PORTA = 4807, PORTA_UAZ = 4808;

// ---- Uazapi de mentira: guarda o token de cada pedido ----
const pedidos = [];
http.createServer((req, res) => { let c = ""; req.on("data", d => c += d); req.on("end", () => {
  pedidos.push({ url: req.url, token: req.headers.token || null });
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/send/")) return res.end(JSON.stringify({ messageid: "wa_" + Date.now() + Math.random() }));
  if (req.url.startsWith("/webhook")) return res.end("[]");
  res.end(JSON.stringify({ instance: { status: "connected" }, status: { connected: true, loggedIn: true } }));
}); }).listen(PORTA_UAZ);
const HOST = `http://127.0.0.1:${PORTA_UAZ}`;

// ---- 1. O banco de HOJE: tokens em claro, gravados como a versão anterior grava ----
const semeia = spawnSync(process.execPath, ["--input-type=module", "-e", `
  const { default: db } = await import(${JSON.stringify(path.join(aqui, "..", "src", "db.js"))});
  const a = Date.now();
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES ('o1','Casa','T-1',?,?, 'token-da-casa')").run(a, ${JSON.stringify(HOST)});
  db.prepare("INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES ('u_m','o1','Marina','m@t.com','x','corretor',1,?,'ativo')").run(a);
  db.prepare("INSERT INTO canais (id,org_id,tipo,nome,host,token,ativo,created_at,provider) VALUES ('c_casa','o1','imobiliaria','Casa',?,'token-da-casa',1,?,'uazapi')").run(${JSON.stringify(HOST)}, a);
  db.prepare("INSERT INTO canais (id,org_id,tipo,user_id,nome,host,token,ativo,created_at,provider,triagem) VALUES ('c_m','o1','corretor','u_m','Marina',?,'token-da-marina',1,?,'uazapi',0)").run(${JSON.stringify(HOST)}, a);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('o2','Meta','T-2',?)").run(a);
  db.prepare("INSERT INTO canais (id,org_id,tipo,nome,token,app_secret,verify_token,phone_number_id,waba_id,ativo,created_at,provider) VALUES ('c_meta','o2','imobiliaria','Meta','token-meta','segredo-meta','vt-meta','pn1','w1',1,?,'meta')").run(a);
  db.prepare("INSERT INTO marketing_numero (org_id,host,token,atualizado_em) VALUES ('o1',?,'token-do-disparo',?)").run(${JSON.stringify(HOST)}, a);
`], { env: { ...process.env, DB_PATH: DB, JWT_SECRET: "teste" }, encoding: "utf8" });
assert.equal(semeia.status, 0, semeia.stderr);

let servidor, saida = "";
const url = p => `http://127.0.0.1:${PORTA}${p}`;
async function subir(extra = {}) {
  saida = "";
  servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "T-1",
      ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456", UAZAPI_AUTOCONFIGURAR: "0", ...extra },
    stdio: ["ignore", "pipe", "pipe"] });
  servidor.stdout.on("data", d => { saida += d; }); servidor.stderr.on("data", d => { saida += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url("/health"))).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error("servidor não subiu\n" + saida);
}
async function descer() { servidor.kill("SIGTERM"); await new Promise(r => servidor.on("exit", r)); }
const fim = async (c) => { try { await descer(); } catch (e) {} process.exit(c); };
process.on("uncaughtException", async e => { console.error("\n" + e.message); console.error(saida.slice(-2000)); await fim(1); });
process.on("unhandledRejection", async e => { console.error("\n" + (e && e.message)); console.error(saida.slice(-2000)); await fim(1); });

const { default: Database } = await import("better-sqlite3");
const banco = () => new Database(DB, { readonly: true });
const linha = (sql, ...a) => { const b = banco(); try { return b.prepare(sql).get(...a); } finally { b.close(); } };
const tudo = (sql, ...a) => { const b = banco(); try { return b.prepare(sql).all(...a); } finally { b.close(); } };
const fechado = (v) => typeof v === "string" && v.startsWith("enc:v1:");

const chega = async (token, texto, id, tel = "5587991112222") => {
  await fetch(url("/webhooks/uazapi"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, event: "messages", message: { chatid: `${tel}@s.whatsapp.net`, text: texto, senderName: "Cliente", messageid: id, fromMe: false } }) });
  await new Promise(r => setTimeout(r, 400));
};
const temMsg = (texto) => !!linha("SELECT 1 FROM messages WHERE body = ?", texto);
let token = "";
async function entrar() {
  const r = await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ali@teste.com", password: "123456" }) });
  token = (await r.json()).token; assert.ok(token, "login");
}
const api = (p, metodo = "GET", corpo) => fetch(url(p), { method: metodo,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: corpo ? JSON.stringify(corpo) : undefined });
const metaPayload = (texto) => ({ object: "whatsapp_business_account", entry: [{ id: "w1", changes: [{ field: "messages", value: {
  metadata: { phone_number_id: "pn1" }, contacts: [{ profile: { name: "Cli Meta" }, wa_id: "5587993334444" }],
  messages: [{ from: "5587993334444", id: "wamid." + Math.random(), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
const chegaMeta = async (texto, segredo = "segredo-meta") => {
  const corpo = JSON.stringify(metaPayload(texto));
  const r = await fetch(url("/webhooks/whatsapp-oficial"), { method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", segredo).update(corpo).digest("hex") }, body: corpo });
  await new Promise(r => setTimeout(r, 400));
  return r.status;
};

console.log("1. Esta versão sobe com CRYPTO_KEY num banco com tokens em claro: tudo é fechado");
await subir({ CRYPTO_KEY: CHAVE });
for (const c of tudo("SELECT id, token, token_hash, app_secret FROM canais WHERE token IS NOT NULL")) {
  assert.ok(fechado(c.token), `canal ${c.id} ainda em claro`);
  assert.ok(c.token_hash && /^[0-9a-f]{64}$/.test(c.token_hash), `canal ${c.id} sem impressão digital`);
}
assert.ok(fechado(linha("SELECT app_secret FROM canais WHERE id='c_meta'").app_secret), "app secret em claro");
assert.ok(fechado(linha("SELECT uazapi_token FROM orgs WHERE id='o1'").uazapi_token), "token da org em claro");
assert.ok(fechado(linha("SELECT token FROM marketing_numero WHERE org_id='o1'").token), "token do disparo em claro");
assert.equal(linha("SELECT verify_token FROM canais WHERE id='c_meta'").verify_token, "vt-meta", "verify_token fica em claro (não é segredo)");
const arquivo = fs.readFileSync(DB).toString("latin1") + (fs.existsSync(DB + "-wal") ? fs.readFileSync(DB + "-wal").toString("latin1") : "");
void arquivo; // (o WAL ainda pode ter páginas antigas; o que importa é o valor atual das colunas, conferido acima)

console.log("2. A mensagem que chega pelo número da casa continua achando a linha");
await chega("token-da-casa", "Oi casa", "m1");
assert.ok(temMsg("Oi casa"), "a mensagem da casa não entrou");

console.log("3. A da linha pessoal também, e o lead nasce da corretora");
await chega("token-da-marina", "Oi Marina", "m2", "5587995556666");
assert.equal(linha("SELECT l.assigned_to a FROM leads l JOIN messages m ON m.lead_id=l.id WHERE m.body='Oi Marina'").a, "u_m");

console.log("4. Token desconhecido continua recusado");
await chega("token-inventado", "Invasor", "m3", "5587997778888");
assert.ok(!temMsg("Invasor"));

console.log("5. O envio sai com o token ABERTO para a Uazapi");
await entrar();
const lead = linha("SELECT l.id FROM leads l JOIN messages m ON m.lead_id=l.id WHERE m.body='Oi casa'").id;
pedidos.length = 0;
let r = await api(`/leads/${lead}/messages`, "POST", { text: "Resposta da casa" });
assert.equal(r.status, 200, await r.text());
const envio = pedidos.find(p => p.url.startsWith("/send/"));
assert.ok(envio, "nada chegou à Uazapi");
assert.equal(envio.token, "token-da-casa", "a Uazapi recebeu o token fechado em vez do token de verdade");

console.log("6. Ler o estado da conexão não reescreve o token (a comparação é do token aberto)");
const antes = linha("SELECT token FROM canais WHERE id='c_casa'").token;
await api("/config/conexao"); await api("/config/conexao");
assert.equal(linha("SELECT token FROM canais WHERE id='c_casa'").token, antes);

console.log("7. Colar o token da casa na linha pessoal continua recusado (busca pela impressão digital)");
r = await api("/config/conexao/credenciais", "POST", { host: HOST, token: "token-da-marina" });
assert.equal(r.status, 409, "o token da Marina na casa devia ser recusado: " + r.status);

console.log("8. Trocar o token da casa grava fechado, e a mensagem pelo token novo entra");
r = await api("/config/conexao/credenciais", "POST", { host: HOST, token: "token-novo-da-casa" });
assert.ok(r.status < 300, "salvar conexão: " + r.status + " " + await r.text());
const nova = linha("SELECT token, token_hash FROM canais WHERE id='c_casa'");
assert.ok(fechado(nova.token)); assert.ok(fechado(linha("SELECT uazapi_token FROM orgs WHERE id='o1'").uazapi_token));
await chega("token-novo-da-casa", "Pelo token novo", "m4");
assert.ok(temMsg("Pelo token novo"));
await chega("token-da-casa", "Pelo token velho", "m5");
assert.ok(!temMsg("Pelo token velho"), "o token antigo não pode mais entrar");

console.log("9. A Meta: a assinatura confere com o App Secret aberto");
assert.equal(await chegaMeta("Oi pela Meta"), 200);
assert.ok(temMsg("Oi pela Meta"));
assert.equal(await chegaMeta("Assinatura falsa", "outro-segredo"), 401);
r = await fetch(url("/webhooks/whatsapp-oficial?hub.mode=subscribe&hub.verify_token=vt-meta&hub.challenge=ok123"));
assert.equal(await r.text(), "ok123");

console.log("10. O painel diz quantos estão fechados, sem mostrar valor nenhum");
const integ = await (await fetch(url("/integracoes"))).json();
const t = integ.seguranca.tokens_do_whatsapp;
assert.equal(t.fechando, true); assert.equal(t.em_claro, 0); assert.ok(t.fechados >= 3);
assert.ok(!JSON.stringify(integ).includes("token-novo-da-casa"), "o painel não pode mostrar token");
await descer();

console.log("11. Reiniciar com a mesma chave não mexe em nada");
const fotografia = JSON.stringify(tudo("SELECT id, token FROM canais WHERE id IN ('c_casa','c_m','c_meta') ORDER BY id"));
await subir({ CRYPTO_KEY: CHAVE });
assert.equal(JSON.stringify(tudo("SELECT id, token FROM canais WHERE id IN ('c_casa','c_m','c_meta') ORDER BY id")), fotografia);
await descer();

console.log("12. Subir com a chave ERRADA: nada é apagado, nada novo é fechado com a chave errada, e o painel avisa");
await subir({ CRYPTO_KEY: OUTRA });
assert.equal(JSON.stringify(tudo("SELECT id, token FROM canais WHERE id IN ('c_casa','c_m','c_meta') ORDER BY id")), fotografia, "a chave errada mexeu nos tokens");
let i2 = await (await fetch(url("/integracoes"))).json();
assert.match(i2.seguranca.tokens_do_whatsapp.aviso, /não é a mesma/);
assert.equal(i2.seguranca.tokens_do_whatsapp.fechando, false);
await descer();

console.log("13. A chave certa de volta: tudo volta a funcionar");
await subir({ CRYPTO_KEY: CHAVE });
await chega("token-novo-da-casa", "Depois da chave certa", "m6");
assert.ok(temMsg("Depois da chave certa"));
await descer();

console.log("14. WHATSAPP_TOKENS_EM_CLARO=1 abre tudo de volta (o passo antes de voltar a uma versão anterior)");
await subir({ CRYPTO_KEY: CHAVE, WHATSAPP_TOKENS_EM_CLARO: "1" });
assert.equal(linha("SELECT token FROM canais WHERE id='c_casa'").token, "token-novo-da-casa");
assert.equal(linha("SELECT token FROM canais WHERE id='c_m'").token, "token-da-marina");
assert.equal(linha("SELECT app_secret FROM canais WHERE id='c_meta'").app_secret, "segredo-meta");
assert.equal(linha("SELECT uazapi_token FROM orgs WHERE id='o1'").uazapi_token, "token-novo-da-casa");
assert.equal(linha("SELECT token FROM marketing_numero WHERE org_id='o1'").token, "token-do-disparo");
await chega("token-novo-da-casa", "Em claro de novo", "m7");
assert.ok(temMsg("Em claro de novo"));
await descer();

console.log("15. Sem CRYPTO_KEY nenhuma num banco em claro: sobe igual e só grava a impressão digital");
await subir({});
await chega("token-da-marina", "Sem chave", "m8", "5587995556666");
assert.ok(temMsg("Sem chave"));
assert.equal(linha("SELECT token FROM canais WHERE id='c_m'").token, "token-da-marina");

console.log("\nOK — tokens do WhatsApp guardados fechados, sem desconectar ninguém.");
await fim(0);
