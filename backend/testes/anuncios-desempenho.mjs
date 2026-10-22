/* DESEMPENHO DOS ANÚNCIOS — os números da conta de anúncios (ads_read) lidos
   ao vivo da Meta e juntados aos leads e vendas do CRM pela campanha.
   Servidor de pé e uma Meta de mentira (META_GRAPH_URL).

   Rodar:  npm run teste:anuncios-desempenho
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-anuncios-desempenho.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4791, PORTA_META = 4792, SEGREDO = "segredo-do-app";

/* ===== A Meta de mentira ===== */
let chamadasInsights = 0, ultimoPeriodo = null, tokenVencido = false, semAdsRead = false;
const meta = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const tok = u.searchParams.get("access_token");
  const ok = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  const erro = (m, code = 100) => { res.statusCode = 400; ok({ error: { message: m, code } }); };
  const p = u.pathname.replace(/^\/v[\d.]+\//, "");
  if (p === "oauth/access_token") {
    if (u.searchParams.get("fb_exchange_token")) return ok({ access_token: "usuario-longo", expires_in: 5184000 });
    return ok({ access_token: "curto" });
  }
  if (p === "me/accounts") return ok({ data: ["P1", "P2"].map(id => ({ id, name: "Página " + id, access_token: "tokpage-" + id })) });
  if (p === "me/permissions") return ok({ data: ["pages_show_list", "leads_retrieval", ...(semAdsRead ? [] : ["ads_read"])]
    .map(permission => ({ permission, status: "granted" })) });
  if (/^\w+\/subscribed_apps$/.test(p)) return ok({ success: true });
  if (p === "P1" || p === "P2") return ok({ id: p });
  if (tok !== "usuario-longo") return erro("token de usuário inválido", 190);
  if (tokenVencido) return erro("Error validating access token: Session has expired", 190);
  if (p === "me/adaccounts") return ok({ data: [
    { id: "act_1", account_id: "1", name: "Conta Imobiliária", account_status: 1, currency: "BRL", business: { name: "Casa A" } },
    { id: "act_2", account_id: "2", name: "Conta Antiga", account_status: 2, currency: "BRL" },
  ] });
  const m = p.match(/^(act_\d+)\/insights$/);
  if (m) {
    if (m[1] !== "act_1") return erro("(#200) Requires ads_read permission", 200);
    chamadasInsights++;
    ultimoPeriodo = JSON.parse(u.searchParams.get("time_range"));
    if (u.searchParams.get("level") === "account") return ok({ data: [{ spend: "300.50", impressions: "12000", reach: "8000",
      clicks: "340", ctr: "2.83", cpm: "25.04", actions: [{ action_type: "lead", value: "9" }, { action_type: "onsite_conversion.lead_grouped", value: "9" }] }] });
    return ok({ data: [
      { campaign_id: "C1", campaign_name: "Casas Centro", spend: "200.50", impressions: "8000", reach: "5000", clicks: "240",
        actions: [{ action_type: "onsite_conversion.lead_grouped", value: "6" }] },
      { campaign_id: "C2", campaign_name: "Aluguel", spend: "100", impressions: "4000", reach: "3000", clicks: "100" },
    ] });
  }
  erro("não existe: " + p);
});
await new Promise((r) => meta.listen(PORTA_META, "127.0.0.1", r));

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "",
    META_APP_ID: "app1", META_APP_SECRET: SEGREDO, META_GRAPH_URL: `http://127.0.0.1:${PORTA_META}`, CRYPTO_KEY: "a".repeat(64) },
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
  usuario(orgA, "gestora@ads.com", "adm");
  usuario(orgA, "sdra@ads.com", "sdr");
  usuario(orgB, "gestorb@ads.com", "adm");
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    const ir = async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) }; };
    return { get: (p) => ir("GET", p), post: (p, b) => ir("POST", p, b || {}), del: (p) => ir("DELETE", p) };
  };
  const A = await como("gestora@ads.com"), B = await como("gestorb@ads.com"), sdr = await como("sdra@ads.com");
  const conectar = async (quem, pagina = "P1") => {
    const ini = await quem.post("/anuncios-meta/iniciar");
    const state = new URL(ini.body.url).searchParams.get("state");
    const r = await fetch(url("/conectar-facebook/retorno?" + new URLSearchParams({ code: "bom", state })), { redirect: "manual" });
    const k = new URL(r.headers.get("location")).searchParams.get("k");
    const e = await quem.post(`/anuncios-meta/escolha/${k}`, { page_ids: [pagina] });
    assert.ok(e.body.resultado?.[0]?.ok, JSON.stringify(e.body));
  };

  // Leads do CRM: dois da campanha C1 (um vendido), um da C2 por NOME (lead antigo sem id), um de fora.
  const lead = (org, campanhaId, campanhaNome, venda) => db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at,campaign_id,campaign_name,sale_value)
    VALUES (?,?,?,?, 'Lead', ?, ?, ?, ?)`).run("l_" + randomUUID(), org, "Cliente", "55879" + Math.floor(Math.random() * 1e8), Date.now() - 3600_000,
      campanhaId, campanhaNome, venda ?? null);
  lead(orgA, "C1", "Casas Centro", 300000);
  lead(orgA, "C1", "Casas Centro");
  lead(orgA, null, "Aluguel");
  lead(orgB, "C1", "Casas Centro");

  caso("Sem o Facebook conectado, a tela diz o que fazer em vez de mostrar zero");
  let r = await A.get("/anuncios-meta/desempenho?periodo=mes");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Conecte o Facebook/);

  caso("Conectar guarda o token do usuário FECHADO, e só com ads_read concedida");
  await conectar(A);
  const linha = db.prepare("SELECT * FROM meta_anuncios WHERE org_id = ?").get(orgA);
  assert.ok(linha && linha.user_token && !linha.user_token.includes("usuario-longo"), "token cifrado");
  assert.ok(linha.token_expira > Date.now() + 50 * 86400_000, "token de ~60 dias");
  r = await A.get("/anuncios-meta");
  assert.equal(r.body.anuncios.conectado, true);
  semAdsRead = true;
  await conectar(B, "P2");
  semAdsRead = false;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM meta_anuncios WHERE org_id = ?").get(orgB).n, 0, "sem ads_read não guarda");

  caso("Lista as contas de anúncios do Facebook conectado; conta que não aparece lá é recusada");
  r = await A.get("/anuncios-meta/contas-anuncio");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.contas.map(c => c.id), ["act_1", "act_2"]);
  assert.equal(r.body.contas[1].status, "desativada");
  assert.equal((await A.post("/anuncios-meta/conta-anuncio", { conta_id: "act_999" })).status, 404);
  r = await A.get("/anuncios-meta/desempenho?periodo=mes");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Escolha a conta de anúncios/);
  r = await A.post("/anuncios-meta/conta-anuncio", { conta_id: "act_1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.conta.nome, "Conta Imobiliária");

  caso("Os números vêm da Meta ao vivo e se juntam aos leads e vendas do CRM pela campanha");
  r = await A.get("/anuncios-meta/desempenho?periodo=mes");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hoje = new Date(); const d = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  assert.deepEqual(ultimoPeriodo, { since: d(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), until: d(hoje) });
  assert.equal(r.body.total.investimento, 300.5);
  assert.equal(r.body.total.alcance, 8000);
  assert.equal(r.body.total.leads_meta, 9, "lead contado uma vez só");
  assert.equal(r.body.total.leads_crm, 3);
  assert.equal(r.body.total.custo_por_lead, 100.17);
  const c1 = r.body.campanhas.find(c => c.campaign_id === "C1");
  assert.equal(c1.leads_crm, 2, "lead de outra imobiliária não entra");
  assert.equal(c1.vendas, 1);
  assert.equal(c1.custo_por_lead, 100.25);
  assert.equal(c1.custo_por_venda, 200.5);
  const c2 = r.body.campanhas.find(c => c.campaign_id === "C2");
  assert.equal(c2.leads_crm, 1, "lead antigo casa pelo nome");
  assert.equal(c2.leads_meta, 0);
  assert.equal(c2.custo_por_venda, null, "sem venda é vazio, não zero");

  caso("Guardado 15 minutos; 'Atualizar da Meta' lê de novo");
  const antes = chamadasInsights;
  await A.get("/anuncios-meta/desempenho?periodo=mes");
  assert.equal(chamadasInsights, antes);
  await A.get("/anuncios-meta/desempenho?periodo=mes&atualizar=1");
  assert.equal(chamadasInsights, antes + 2);

  caso("Só o gestor: a atendente não vê o dinheiro dos anúncios; outra conta não vê os números desta");
  assert.equal((await sdr.get("/anuncios-meta/desempenho?periodo=mes")).status, 403);
  r = await B.get("/anuncios-meta/desempenho?periodo=mes");
  assert.equal(r.status, 409);

  caso("Conexão vencida: a tela manda conectar de novo e o motivo fica anotado");
  tokenVencido = true;
  r = await A.get("/anuncios-meta/desempenho?periodo=semana&atualizar=1");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /venceu/);
  assert.match((await A.get("/anuncios-meta")).body.anuncios.ultimo_erro, /venceu/);
  tokenVencido = false;

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  meta.close();
}
