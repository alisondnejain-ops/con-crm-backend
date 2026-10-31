/* GRUPOS DO WHATSAPP NUMA PASTILHA PRÓPRIA (31/10/2026).

   1. Linha com os grupos desligados (o padrão): grupo é ignorado, como sempre.
   2. Só o gestor liga os grupos do número da casa; ligar ajusta o webhook
      da instância para deixar de filtrar grupo.
   3. Ligado: a mensagem do grupo é gravada, sem virar lead; a supervisão vê;
      o corretor não.
   4. No WhatsApp pessoal, só o dono vê os grupos dele — nem a gestão.
   5. Responder ao grupo sai para o grupo, e o eco não duplica.

   Rodar:  npm run teste:grupos */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-grupos.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4823";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.APP_URL = "http://127.0.0.1:4823";
process.env.CONHUB_WEBHOOK_PERMITE_LOCAL = "1";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const envios = [], webhooksPedidos = [];
const webhookDaInstancia = [{ id: "wh1", enabled: true, url: "http://127.0.0.1:4823/webhooks/uazapi", events: ["messages"], excludeMessages: ["isGroupYes"] }];
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (req.url === "/webhook" && req.method === "GET") return json(200, webhookDaInstancia);
    if (req.url === "/webhook" && req.method === "POST") {
      const d = JSON.parse(corpo || "{}"); webhooksPedidos.push(d);
      if (d.id === "wh1") Object.assign(webhookDaInstancia[0], { excludeMessages: d.excludeMessages });
      return json(200, webhookDaInstancia);
    }
    if (req.url.startsWith("/send/")) { const d = JSON.parse(corpo || "{}"); envios.push(d); return json(200, { messageid: "wa_env_" + envios.length }); }
    json(200, { instance: { status: "connected" }, status: { connected: true, loggedIn: true } });
  });
});
await new Promise(r => mock.listen(4824, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const P = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4823";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_grp1";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?,?)")
  .run(org, "Imobiliária Mar", "MAR-1", Date.now(), "", "http://127.0.0.1:4824", "tk-casa");
P.garantirPipelinePadrao(org);
let ordem = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, nome, nome.toLowerCase() + "@mar.com", senha, role, Date.now() + (++ordem));
  return id; };
pessoa("Gestora", "adm"); pessoa("Vanessa", "sdr"); const marina = pessoa("Marina", "corretor");
const casa = "c_casa_grp", pessoal = "c_marina_grp";
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,1,?)`).run(casa, org, "http://127.0.0.1:4824", "tk-casa", Date.now());
db.prepare(`INSERT INTO canais (id,org_id,tipo,user_id,nome,host,token,ativo,created_at) VALUES (?,?,'corretor',?,?,?,?,1,?)`).run(pessoal, org, marina, "Marina", "http://127.0.0.1:4824", "tk-marina", Date.now());

const entrar = async (n) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: n.toLowerCase() + "@mar.com", password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("Gestora"), tV = await entrar("Vanessa"), tM = await entrar("Marina");
const doGrupo = (token, jid, texto, extra = {}) => fetch(BASE + "/webhooks/uazapi", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, event: "messages", message: { chatid: jid, sender: "5587991110000@s.whatsapp.net", senderName: "Seu João",
    groupName: "Vizinhos do Centro", text: texto, messageid: "wa_g_" + Math.random().toString(36).slice(2), ...extra } }) });
const esperar = () => new Promise(r => setTimeout(r, 350));
const leads = () => db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ?").get(org).n;

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }

console.log("Grupos do WhatsApp");
await caso("1. Desligado (o padrão): grupo é ignorado", async () => {
  await doGrupo("tk-casa", "120363000001@g.us", "bom dia grupo"); await esperar();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wa_grupo_mensagens").get().n, 0);
  assert.equal(leads(), 0, "grupo não vira lead");
  const g = await chamar(tG, "/grupos"); assert.equal(g.d.ligado, false);
});
await caso("2. Só o gestor liga; o webhook deixa de filtrar grupo", async () => {
  assert.equal((await chamar(tV, `/grupos/linhas/${casa}`, "POST", { ligado: true })).status, 403, "a atendente não liga");
  const r = await chamar(tG, `/grupos/linhas/${casa}`, "POST", { ligado: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const upd = webhooksPedidos.find(p => p.id === "wh1");
  assert.ok(upd, "o webhook do CRM foi atualizado"); assert.deepEqual(upd.excludeMessages, []);
  assert.equal(r.d.recebimento.estado, "ok");
});
await caso("3. Ligado: grava sem virar lead; supervisão vê, corretor não", async () => {
  await doGrupo("tk-casa", "120363000001@g.us", "alguém tem casa pra alugar?"); await esperar();
  assert.equal(leads(), 0);
  const g = await chamar(tV, "/grupos");
  assert.equal(g.d.ligado, true); assert.equal(g.d.grupos.length, 1);
  assert.equal(g.d.grupos[0].nome, "Vizinhos do Centro"); assert.equal(g.d.grupos[0].nao_lidas, 1);
  const m = await chamar(tG, `/grupos/${g.d.grupos[0].id}`);
  assert.equal(m.d.mensagens.length, 1); assert.equal(m.d.mensagens[0].autor_nome, "Seu João");
  const c = await chamar(tM, "/grupos"); assert.equal(c.d.ligado, false, "o corretor não vê o grupo da casa");
  assert.equal((await chamar(tM, `/grupos/${g.d.grupos[0].id}`)).status, 404);
});
await caso("4. WhatsApp pessoal: só o dono vê", async () => {
  assert.equal((await chamar(tG, `/grupos/linhas/${pessoal}`, "POST", { ligado: true })).status, 403, "a gestão não liga o pessoal");
  assert.equal((await chamar(tM, `/grupos/linhas/${pessoal}`, "POST", { ligado: true })).status, 200);
  await doGrupo("tk-marina", "120363000999@g.us", "festa sábado", { groupName: "Família" }); await esperar();
  const m = await chamar(tM, "/grupos");
  assert.equal(m.d.grupos.length, 1); assert.equal(m.d.grupos[0].nome, "Família");
  const g = await chamar(tG, "/grupos");
  assert.ok(!g.d.grupos.some(x => x.nome === "Família"), "a gestão não vê o grupo pessoal da corretora");
});
await caso("5. Responder ao grupo; o eco não duplica", async () => {
  const g = (await chamar(tG, "/grupos")).d.grupos[0];
  const r = await chamar(tG, `/grupos/${g.id}/mensagens`, "POST", { texto: "Temos sim, chama no privado!" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const env = envios[envios.length - 1];
  assert.equal(env.number, "120363000001@g.us"); assert.match(env.text, /Gestora/, "sai assinada no número da casa");
  await doGrupo("tk-casa", "120363000001@g.us", env.text, { fromMe: true, messageid: "wa_env_" + envios.length }); await esperar();
  const m = await chamar(tG, `/grupos/${g.id}`);
  assert.equal(m.d.mensagens.filter(x => x.direction === "out").length, 1, "uma vez só");
  assert.equal(leads(), 0);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
mock.close(); process.exit(falhas ? 1 : 0);
