/* "CONECTAR COM FACEBOOK" — cada imobiliária conecta a própria página, e o
   lead do formulário cai NA CONTA QUE CONECTOU. Servidor de pé e uma Meta de
   mentira (META_GRAPH_URL): o que importa aqui é a porta (quem conecta, quem
   vê a lista, quem desconecta) e o destino do lead — nenhum dos dois se prova
   por dentro do serviço.

   Rodar:  npm run teste:conectar-facebook
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-conectar-facebook.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4781, PORTA_META = 4782, SEGREDO = "segredo-do-app";

/* ===== A Meta de mentira ===== */
const assinadas = new Set();
const leads = {
  L1: { page: "P1", id: "L1", created_time: "2026-10-01T12:00:00+0000", platform: "fb", campaign_name: "Casas Centro", form_id: "F1",
    field_data: [{ name: "full_name", values: ["Ana da Casa A"] }, { name: "phone_number", values: ["+5587991110001"] },
      { name: "qual_a_sua_renda?", values: ["5 mil"] }, { name: "qual_bairro?", values: ["Centro"] }] },
  L2: { page: "P2", id: "L2", field_data: [{ name: "full_name", values: ["Beto da Casa B"] }, { name: "phone_number", values: ["+5587991110002"] }] },
  L3: { page: "P3", id: "L3", field_data: [{ name: "full_name", values: ["Ninguém"] }, { name: "phone_number", values: ["+5587991110003"] }] },
  L4: { page: "PAGE_ANTIGA", id: "L4", field_data: [{ name: "full_name", values: ["Cliente antigo"] }, { name: "phone_number", values: ["+5587991110004"] }] },
  L5: { page: "P1", id: "L5", field_data: [{ name: "full_name", values: ["Depois de desconectar"] }, { name: "phone_number", values: ["+5587991110005"] }] },
};
const tokenDaPagina = (pg) => (pg === "PAGE_ANTIGA" ? "tok-antigo" : "tokpage-" + pg);
const meta = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const tok = u.searchParams.get("access_token");
  const ok = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  const erro = (m) => { res.statusCode = 400; ok({ error: { message: m, code: 190 } }); };
  const p = u.pathname.replace(/^\/v[\d.]+\//, "");
  if (p === "oauth/access_token") {
    if (u.searchParams.get("fb_exchange_token")) return ok({ access_token: "longo" });
    if (u.searchParams.get("code") !== "bom") return erro("código inválido");
    if (u.searchParams.get("client_secret") !== SEGREDO) return erro("segredo errado");
    return ok({ access_token: "curto" });
  }
  if (p === "me/accounts") {
    if (tok !== "longo") return erro("token de usuário inválido");
    return ok({ data: ["P1", "P2", "P3"].map((id) => ({ id, name: "Página " + id, access_token: tokenDaPagina(id) })) });
  }
  if (p === "me") return tok === "tok-antigo" ? ok({ id: "PAGE_ANTIGA", category: "Imobiliária" }) : erro("sem acesso");
  const m = p.match(/^(\w+)\/subscribed_apps$/);
  if (m) {
    if (tok !== tokenDaPagina(m[1])) return erro("token não é desta página");
    if (req.method === "POST") assinadas.add(m[1]); else assinadas.delete(m[1]);
    return ok({ success: true });
  }
  if (p === "F1") return ok({ id: "F1", name: "Formulário Casas" });
  const l = leads[p];
  if (l) {
    if (tok !== tokenDaPagina(l.page)) return erro("este token não lê leads desta página");
    const { page, ...dados } = l;
    return ok(dados);
  }
  erro("não existe: " + p);
});
await new Promise((r) => meta.listen(PORTA_META, "127.0.0.1", r));

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "",
    META_APP_ID: "app1", META_APP_SECRET: SEGREDO, META_GRAPH_URL: `http://127.0.0.1:${PORTA_META}`,
    META_PAGE_ACCESS_TOKEN: "tok-antigo", CRYPTO_KEY: "a".repeat(64) },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await espera(250);
  }
  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const orgA = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get().id;
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Casa B", "CASA-B", Date.now() + 1000);
  const usuario = (o, email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario(orgA, "gestora@fb.com", "adm");
  usuario(orgA, "sdra@fb.com", "sdr");
  usuario(orgA, "corretora@fb.com", "corretor");
  usuario(orgB, "gestorb@fb.com", "adm");
  usuario(orgB, "sdrb@fb.com", "sdr");
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    const ir = async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) }; };
    return { get: (p) => ir("GET", p), post: (p, b) => ir("POST", p, b || {}), del: (p) => ir("DELETE", p) };
  };
  const A = await como("gestora@fb.com"), B = await como("gestorb@fb.com"), corretor = await como("corretora@fb.com");
  const retorno = async (q) => {
    const r = await fetch(url("/conectar-facebook/retorno?" + new URLSearchParams(q)), { redirect: "manual" });
    const destino = new URL(r.headers.get("location"));
    return { status: r.status, path: destino.pathname, q: Object.fromEntries(destino.searchParams) };
  };
  const conectarAte = async (quem) => {
    const ini = await quem.post("/anuncios-meta/iniciar");
    assert.equal(ini.status, 200, JSON.stringify(ini.body));
    const state = new URL(ini.body.url).searchParams.get("state");
    const r = await retorno({ code: "bom", state });
    assert.equal(r.q.meta, "escolher", JSON.stringify(r.q));
    return { k: r.q.k, url: ini.body.url, state };
  };
  const avisar = async (page, leadgen, assinar = true) => {
    const corpo = JSON.stringify({ object: "page", entry: [{ id: page, time: 1, changes: [{ field: "leadgen",
      value: { leadgen_id: leadgen, page_id: page, form_id: "F1" } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", assinar ? SEGREDO : "outro").update(corpo).digest("hex");
    const r = await fetch(url("/webhooks/meta"), { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: corpo });
    await espera(500);
    return r.status;
  };
  const leadPorTel = (tel) => db.prepare("SELECT * FROM leads WHERE phone = ?").all(tel);

  caso("O gestor vê o botão ligado e nenhuma página; o corretor não entra na tela");
  let r = await A.get("/anuncios-meta");
  assert.equal(r.status, 200);
  assert.equal(r.body.configurado, true);
  assert.deepEqual(r.body.paginas, []);
  assert.equal((await corretor.get("/anuncios-meta")).status, 403);

  caso("Conectar abre o Facebook com o aplicativo, o retorno e as permissões de lead");
  const c1 = await conectarAte(A);
  const u1 = new URL(c1.url);
  assert.equal(u1.hostname, "www.facebook.com");
  assert.equal(u1.searchParams.get("client_id"), "app1");
  assert.match(u1.searchParams.get("redirect_uri"), /\/conectar-facebook\/retorno$/);
  assert.match(u1.searchParams.get("scope"), /leads_retrieval/);
  assert.match(u1.searchParams.get("scope"), /pages_manage_metadata/);

  caso("Retorno com state inventado ou cancelado não conecta nada e explica");
  r = await retorno({ code: "bom", state: "inventado" });
  assert.equal(r.q.meta, "erro");
  assert.match(r.q.motivo, /Conectar de novo/);
  r = await retorno({ error: "access_denied", state: c1.state });
  assert.equal(r.q.meta, "cancelado");
  r = await retorno({ code: "ruim", state: c1.state });
  assert.equal(r.q.meta, "erro");

  caso("A lista de páginas é só de quem conectou — outra conta, com a mesma chave, recebe 404");
  assert.equal((await B.get(`/anuncios-meta/escolha/${c1.k}`)).status, 404);
  r = await A.get(`/anuncios-meta/escolha/${c1.k}`);
  assert.deepEqual(r.body.paginas.map((p) => p.id), ["P1", "P2", "P3"]);
  assert.ok(!JSON.stringify(r.body).includes("tokpage"), "o token da página não pode ir para o navegador");

  caso("Escolher a página liga os avisos de lead no Facebook e guarda o token fechado");
  r = await A.post(`/anuncios-meta/escolha/${c1.k}`, { page_ids: ["P1"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resultado[0].ok, true);
  assert.ok(assinadas.has("P1"));
  const linha = db.prepare("SELECT * FROM meta_paginas WHERE page_id = 'P1'").get();
  assert.equal(linha.org_id, orgA);
  assert.match(linha.page_token, /^enc:v1:/, "token de página não fica em claro no banco");

  caso("A mesma página não pode ser conectada em outra conta; outra página pode");
  const c2 = await conectarAte(B);
  r = await B.get(`/anuncios-meta/escolha/${c2.k}`);
  assert.equal(r.body.paginas.find((p) => p.id === "P1").em_outra_conta, true);
  r = await B.post(`/anuncios-meta/escolha/${c2.k}`, { page_ids: ["P1", "P2"] });
  assert.equal(r.body.resultado.find((x) => x.id === "P1").ok, false);
  assert.match(r.body.resultado.find((x) => x.id === "P1").erro, /outra conta/);
  assert.equal(r.body.resultado.find((x) => x.id === "P2").ok, true);
  assert.equal(db.prepare("SELECT org_id FROM meta_paginas WHERE page_id = 'P1'").get().org_id, orgA);

  caso("Lead da página da Casa A cai na Casa A, com respostas e campanha; o da Casa B na Casa B");
  assert.equal(await avisar("P1", "L1"), 200);
  let la = leadPorTel("5587991110001");
  assert.equal(la.length, 1);
  assert.equal(la[0].org_id, orgA);
  assert.equal(la[0].origem, "Meta Ads");
  assert.equal(la[0].campaign_name, "Casas Centro");
  assert.equal(la[0].form_name, "Formulário Casas");
  assert.equal(JSON.parse(la[0].qual_json).renda, "5 mil");
  const obs = db.prepare("SELECT texto FROM observacoes WHERE lead_id = ?").get(la[0].id).texto;
  assert.match(obs, /Qual bairro\?: Centro/);
  assert.ok(db.prepare("SELECT ultimo_lead_em FROM meta_paginas WHERE page_id='P1'").get().ultimo_lead_em);
  await avisar("P2", "L2");
  const lb = leadPorTel("5587991110002");
  assert.equal(lb.length, 1);
  assert.equal(lb[0].org_id, orgB);

  caso("A Meta reenviando o mesmo aviso não cria lead nem observação a mais");
  await avisar("P1", "L1");
  assert.equal(leadPorTel("5587991110001").length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observacoes WHERE lead_id = ?").get(la[0].id).n, 1);

  caso("Página que ninguém conectou não entrega lead a ninguém — nem à imobiliária mais antiga");
  await avisar("P3", "L3");
  assert.equal(leadPorTel("5587991110003").length, 0);

  caso("A página antiga do servidor (antes do botão) continua entrando, e só ela");
  await avisar("PAGE_ANTIGA", "L4");
  const lc = leadPorTel("5587991110004");
  assert.equal(lc.length, 1);
  assert.equal(lc[0].org_id, orgA);

  caso("Aviso com acento escapado (\\u00e3) e barra escapada passa na assinatura — ela é sobre os bytes que chegaram");
  {
    const corpo = '{"object":"page","entry":[{"id":"P2","time":1,"changes":[{"field":"leadgen","value":{"leadgen_id":"L2","page_id":"P2","form_id":"F1","ad_name":"Promo\\u00e7\\u00e3o \\/ teste"}}]}]}';
    assert.notEqual(JSON.stringify(JSON.parse(corpo)), corpo, "o caso só prova algo se o texto não se reconstrói igual");
    const sig = "sha256=" + crypto.createHmac("sha256", SEGREDO).update(corpo).digest("hex");
    const r = await fetch(url("/webhooks/meta"), { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: corpo });
    assert.equal(r.status, 200);
  }

  caso("Aviso com assinatura errada é recusado");
  assert.equal(await avisar("P1", "L1", false), 401);

  caso("Desconectar: só a conta dona desconecta, os avisos são desligados e o lead seguinte não entra");
  assert.equal((await B.del("/anuncios-meta/paginas/P1")).status, 404);
  r = await A.del("/anuncios-meta/paginas/P1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.paginas, []);
  assert.ok(!assinadas.has("P1"));
  await avisar("P1", "L5");
  assert.equal(leadPorTel("5587991110005").length, 0);
  assert.equal(leadPorTel("5587991110001").length, 1, "o lead que já entrou continua");

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  meta.close();
}
