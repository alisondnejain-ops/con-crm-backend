/* GOOGLE AGENDA E MEET (31/10/2026, lista do Fernando) — com um Google de mentira.

   1. Sem as chaves do Google no servidor: nada muda (a tarefa nasce igual).
   2. Conectar: o endereço leva o escopo da agenda e um state assinado; state
      inválido não conecta; o token guardado vai FECHADO pelo cofre.
   3. Tarefa de quem ligou o Google vira evento, com Meet quando pedido; só o
      nome do cliente vai para o Google (nada de telefone).
   4. Tarefa de quem não ligou não vai para lugar nenhum.
   5. Apagar a tarefa tira o evento da agenda.
   6. Google com erro: a tarefa existe mesmo assim, com o motivo escrito.

   Rodar:  npm run teste:google-agenda */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-google.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4825";
process.env.APP_URL = "http://127.0.0.1:4825";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.CRYPTO_KEY = "a".repeat(64);
process.env.GOOGLE_OAUTH_URL = process.env.GOOGLE_API_URL = process.env.GOOGLE_AUTH_URL = "http://127.0.0.1:4826";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const pedidos = []; let falharAgenda = false;
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    pedidos.push({ metodo: req.method, url: req.url, corpo });
    if (req.url === "/token") {
      const q = new URLSearchParams(corpo);
      if (q.get("grant_type") === "authorization_code") return json(200, { access_token: "at1", refresh_token: "rt-segredo-123" });
      return json(200, { access_token: "at2" });
    }
    if (req.url.startsWith("/calendar/v3/calendars/primary/events")) {
      if (falharAgenda) return json(403, { error: { message: "Calendar API has not been used in project" } });
      if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
      const d = JSON.parse(corpo || "{}");
      return json(200, { id: "ev_" + pedidos.length, ...(d.conferenceData ? { hangoutLink: "https://meet.google.com/abc-defg-hij" } : {}) });
    }
    json(404, {});
  });
});
await new Promise(r => mock.listen(4826, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const P = await import("../src/services/pipelines.js");
const { emitirTokenCurto } = await import("../src/auth.js");
const BASE = "http://127.0.0.1:4825";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_ggl1";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(org, "Imobiliária Sol", "SOL-G", Date.now(), "");
P.garantirPipelinePadrao(org);
let ordem = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, nome, nome.toLowerCase() + "@sol.com", senha, role, Date.now() + (++ordem));
  return id; };
pessoa("Gestora", "adm"); const marina = pessoa("Marina", "corretor"); const rafael = pessoa("Rafael", "corretor");
const entrar = async (n) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: n.toLowerCase() + "@sol.com", password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tM = await entrar("Marina"), tR = await entrar("Rafael");
const lead = (dono) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Lead',?,?)`)
    .run(id, org, "Joana Lima", "5587991234567", Date.now(), dono); return id; };
const lM = lead(marina), lR = lead(rafael);
const amanha = new Date(Date.now() + 86400000).toISOString();

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }

console.log("Google Agenda e Meet");
await caso("1. Sem as chaves: nada muda", async () => {
  const e = await chamar(tM, "/google/estado"); assert.equal(e.d.configurado, false);
  assert.equal((await chamar(tM, "/google/conectar")).status, 503);
  const r = await chamar(tM, `/leads/${lM}/tarefas`, "POST", { titulo: "Ligar", quando: amanha, meet: true });
  assert.equal(r.status, 200); assert.equal(r.d.agenda.criado, false);
  assert.equal(pedidos.length, 0, "nada saiu para o Google");
});
process.env.GOOGLE_CLIENT_ID = "cliente-teste"; process.env.GOOGLE_CLIENT_SECRET = "segredo-teste";
await caso("2. Conectar: escopo, state assinado e token fechado", async () => {
  const c = await chamar(tM, "/google/conectar");
  assert.equal(c.status, 200);
  const u = new URL(c.d.url);
  assert.match(u.searchParams.get("scope"), /calendar\.events/);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("redirect_uri"), BASE + "/conectar-google/retorno");
  let r = await fetch(BASE + "/conectar-google/retorno?code=x&state=inventado", { redirect: "manual" });
  assert.match(r.headers.get("location"), /google=erro/);
  assert.ok(!db.prepare("SELECT 1 FROM google_contas WHERE user_id = ?").get(marina));
  r = await fetch(BASE + `/conectar-google/retorno?code=abc&state=${encodeURIComponent(u.searchParams.get("state"))}`, { redirect: "manual" });
  assert.match(r.headers.get("location"), /google=ok/);
  const g = db.prepare("SELECT refresh_token FROM google_contas WHERE user_id = ?").get(marina);
  assert.ok(g, "conectado"); assert.ok(!g.refresh_token.includes("rt-segredo-123"), "o token vai fechado pelo cofre");
  assert.equal((await chamar(tM, "/google/estado")).d.conectado, true);
});
let tarefaMeet;
await caso("3. Tarefa vira evento, com Meet, sem telefone", async () => {
  const antes = pedidos.length;
  const r = await chamar(tM, `/leads/${lM}/tarefas`, "POST", { titulo: "Visita no Centro", quando: amanha, meet: true });
  assert.equal(r.status, 200); assert.equal(r.d.agenda.criado, true); assert.match(r.d.agenda.meet, /meet\.google\.com/);
  const ev = pedidos.slice(antes).find(p => p.url.startsWith("/calendar") && p.metodo === "POST");
  assert.ok(ev.url.includes("conferenceDataVersion=1"));
  const corpo = JSON.parse(ev.corpo);
  assert.match(corpo.summary, /Visita no Centro · Joana Lima/);
  assert.ok(!ev.corpo.includes("991234567"), "o telefone não vai para o Google");
  tarefaMeet = r.d.tarefas.find(t => t.titulo === "Visita no Centro");
  assert.ok(tarefaMeet.na_agenda); assert.match(tarefaMeet.meet, /meet/);
});
await caso("4. Quem não ligou o Google: nada vai", async () => {
  const antes = pedidos.length;
  const r = await chamar(tR, `/leads/${lR}/tarefas`, "POST", { titulo: "Ligar", quando: amanha });
  assert.equal(r.d.agenda.criado, false); assert.equal(pedidos.length, antes);
});
await caso("5. Apagar a tarefa tira o evento", async () => {
  const antes = pedidos.length;
  assert.equal((await chamar(tM, `/tarefas/${tarefaMeet.id}`, "DELETE")).status, 200);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(pedidos.slice(antes).some(p => p.metodo === "DELETE" && p.url.includes("/events/")), "o evento foi apagado");
});
await caso("6. Google com erro: a tarefa existe, com o motivo", async () => {
  falharAgenda = true;
  const r = await chamar(tM, `/leads/${lM}/tarefas`, "POST", { titulo: "Levar a pasta", quando: amanha });
  falharAgenda = false;
  assert.equal(r.status, 200); assert.equal(r.d.agenda.criado, false); assert.match(r.d.agenda.erro, /Calendar API/);
  const t = r.d.tarefas.find(x => x.titulo === "Levar a pasta");
  assert.ok(t, "a tarefa existe"); assert.match(t.agenda_erro, /Calendar API/);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
mock.close(); process.exit(falhas ? 1 : 0);
