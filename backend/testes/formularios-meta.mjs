/* ATENDER → FORMULÁRIOS (03/10/2026, pedido do Ali: "uma subseção dentro do
   Atender onde aparecem todos os formulários criados naquela página, e a opção
   de aplicar um determinado formulário a um funil").

   Servidor de pé e uma Meta de mentira. O que se prova: a lista junta o que a
   Meta diz e o que os leads já trouxeram; a escolha do funil vale para o lead
   NOVO daquele formulário (e só daquela conta); o responsável continua vindo
   da catraca; funil desativado depois volta à regra de sempre; e quem não é
   gestor não entra.

   Rodar:  npm run teste:formularios-meta
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
const DB = path.join(os.tmpdir(), "concrm-teste-formularios-meta.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4799, PORTA_META = 4800, SEGREDO = "segredo-do-app";

/* ===== A Meta de mentira ===== */
const formsDaPagina = {
  P1: [{ id: "F1", name: "Aluguel Centro", status: "ACTIVE", leads_count: 12, created_time: "2026-09-01T10:00:00+0000" },
       { id: "F2", name: "Compra MCMV", status: "ACTIVE", leads_count: 40, created_time: "2026-08-01T10:00:00+0000" },
       { id: "F3", name: "Lançamento antigo", status: "ARCHIVED", leads_count: 3, created_time: "2026-05-01T10:00:00+0000" }],
};
const leads = {};
let seq = 0;
const novoLead = (page, form, tel, nome) => {
  const id = "LD" + (++seq);
  leads[id] = { page, id, form_id: form, platform: "fb", campaign_name: "Campanha " + form,
    field_data: [{ name: "full_name", values: [nome] }, { name: "phone_number", values: [tel] }] };
  return id;
};
const tokenDaPagina = (pg) => "tokpage-" + pg;
const meta = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const tok = u.searchParams.get("access_token");
  const ok = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  const erro = (m) => { res.statusCode = 400; ok({ error: { message: m, code: 200 } }); };
  const p = u.pathname.replace(/^\/v[\d.]+\//, "");
  const f = p.match(/^(\w+)\/leadgen_forms$/);
  if (f) {
    if (tok !== tokenDaPagina(f[1])) return erro("token não é desta página");
    if (!formsDaPagina[f[1]]) return erro("(#200) Requires pages_manage_ads permission");
    return ok({ data: formsDaPagina[f[1]] });
  }
  const nomes = { F1: "Aluguel Centro", F2: "Compra MCMV", F3: "Lançamento antigo" };
  if (nomes[p]) return ok({ id: p, name: nomes[p] });
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
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "FORM-2026", APP_URL: "",
    META_APP_ID: "app1", META_APP_SECRET: SEGREDO, META_GRAPH_URL: `http://127.0.0.1:${PORTA_META}`,
    META_PAGE_ACCESS_TOKEN: "", CRYPTO_KEY: "b".repeat(64), UAZAPI_AUTOCONFIGURAR: "0" },
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
  const { fechar } = await import("../src/services/cofre.js");
  const P = await import("../src/services/pipelines.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const orgA = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get().id;
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Casa B", "CASA-B", Date.now() + 1000);
  P.garantirPipelinePadrao(orgB);
  const usuario = (o, email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario(orgA, "gestora@fm.com", "adm");
  const sdrA = usuario(orgA, "sdra@fm.com", "sdr");
  usuario(orgA, "corretora@fm.com", "corretor");
  usuario(orgB, "gestorb@fm.com", "adm");
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    const ir = async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) }; };
    return { get: (p) => ir("GET", p), post: (p, b) => ir("POST", p, b || {}) };
  };
  const A = await como("gestora@fm.com"), B = await como("gestorb@fm.com"), corretor = await como("corretora@fm.com");
  const atendente = await como("sdra@fm.com");

  // As páginas conectadas: P1 na Casa A (lê formulários), P2 na Casa B (a Meta recusa a lista).
  const conectar = (page, org) => db.prepare(`INSERT INTO meta_paginas (page_id,org_id,nome,page_token,conectado_em) VALUES (?,?,?,?,?)`)
    .run(page, org, "Página " + page, fechar(tokenDaPagina(page)), Date.now());
  conectar("P1", orgA);
  conectar("P2", orgB);

  // Um funil de Locação na Casa A (pelo modelo), e um funil qualquer na Casa B.
  const loc = P.criarDoTemplate(orgA, "locacao", { name: "Locação" }).pipeline;
  const etapasLoc = P.etapasDoPipeline(orgA, loc.id);
  const funilB = P.pipelinePadrao(orgB);

  const avisar = async (page, leadgen) => {
    const corpo = JSON.stringify({ object: "page", entry: [{ id: page, time: 1, changes: [{ field: "leadgen",
      value: { leadgen_id: leadgen, page_id: page, form_id: leads[leadgen].form_id } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", SEGREDO).update(corpo).digest("hex");
    const r = await fetch(url("/webhooks/meta"), { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: corpo });
    await espera(500);
    return r.status;
  };
  const leadPorTel = (tel) => db.prepare("SELECT * FROM leads WHERE phone = ?").get(tel);

  caso("Só o gestor entra: corretor e atendente recebem 403");
  assert.equal((await corretor.get("/anuncios-meta/formularios")).status, 403);
  assert.equal((await atendente.get("/anuncios-meta/formularios")).status, 403);
  assert.equal((await corretor.post("/anuncios-meta/formularios/F1", { pipeline_id: loc.id })).status, 403);

  caso("Lead do formulário SEM funil escolhido segue a regra de sempre (funil de quem recebe)");
  assert.equal(await avisar("P1", novoLead("P1", "F2", "+5587990000001", "Antes da escolha")), 200);
  const antes = leadPorTel("5587990000001");
  assert.ok(antes, saida.slice(-800));
  assert.equal(antes.assigned_to, sdrA, "a catraca entrega à atendente ativa");
  assert.notEqual(antes.pipeline_id, loc.id);

  caso("A lista junta os formulários da página (com os arquivados por último) e quantos leads cada um trouxe");
  let r = await A.get("/anuncios-meta/formularios");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.formularios.map((f) => f.id);
  assert.deepEqual(ids.slice(0, 2).sort(), ["F1", "F2"]);
  assert.equal(ids[ids.length - 1], "F3", "o arquivado vai para o fim");
  const f2 = r.body.formularios.find((f) => f.id === "F2");
  assert.equal(f2.nome, "Compra MCMV");
  assert.equal(f2.leads_crm, 1);
  assert.equal(f2.leads_meta, 40);
  assert.equal(f2.pagina, "Página P1");
  assert.equal(f2.pipeline_id, null);
  assert.deepEqual(r.body.erros, []);
  assert.ok(!JSON.stringify(r.body).includes("tokpage"), "o token da página não vai para o navegador");

  caso("Formulário que só aparece nos leads (página que não lista) entra na lista assim mesmo");
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at,source,form_id,form_name,qual_json)
    VALUES (?,?,?,?,?,?,?,?,?,'{}')`).run("l_x", orgA, "Lead antigo", "5587990000099", "Lead", Date.now() - 86400000, "meta", "FX", "Formulário de uma página antiga");
  r = await A.get("/anuncios-meta/formularios");
  const fx = r.body.formularios.find((f) => f.id === "FX");
  assert.ok(fx);
  assert.equal(fx.nome, "Formulário de uma página antiga");
  assert.equal(fx.leads_crm, 1);

  caso("Quando a Meta recusa a lista, a tela recebe o motivo — e a outra conta não vê os formulários da A");
  r = await B.get("/anuncios-meta/formularios");
  assert.equal(r.status, 200);
  assert.equal(r.body.erros.length, 1);
  assert.match(r.body.erros[0].erro, /pages_manage_ads/);
  assert.ok(!r.body.formularios.some((f) => ["F1", "F2", "F3", "FX"].includes(f.id)), "formulários da Casa A não podem aparecer na B");

  caso("Funil de outra conta ou etapa de outro funil são recusados");
  r = await A.post("/anuncios-meta/formularios/F1", { pipeline_id: funilB.id });
  assert.equal(r.status, 400);
  r = await A.post("/anuncios-meta/formularios/F1", { pipeline_id: loc.id, stage_id: antes.stage_id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /etapa/);
  r = await A.post("/anuncios-meta/formularios/<script>", { pipeline_id: loc.id });
  assert.equal(r.status, 400);

  caso("O gestor aplica o formulário de aluguel ao funil de Locação, na segunda etapa");
  r = await A.post("/anuncios-meta/formularios/F1", { pipeline_id: loc.id, stage_id: etapasLoc[1].id, nome: "Aluguel Centro", page_id: "P1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.entrada.stage_id, etapasLoc[1].id);
  r = await A.get("/anuncios-meta/formularios");
  const f1 = r.body.formularios.find((f) => f.id === "F1");
  assert.equal(f1.pipeline_id, loc.id);
  assert.equal(f1.entrada.funil, "Locação");

  caso("O lead novo desse formulário nasce no funil e na etapa escolhidos — e o responsável continua vindo da catraca");
  await avisar("P1", novoLead("P1", "F1", "+5587990000002", "Quer alugar"));
  const aluga = leadPorTel("5587990000002");
  assert.equal(aluga.pipeline_id, loc.id);
  assert.equal(aluga.stage_id, etapasLoc[1].id);
  assert.equal(aluga.stage, etapasLoc[1].name);
  assert.equal(aluga.assigned_to, sdrA);

  caso("Outro formulário da mesma página continua na regra de sempre");
  await avisar("P1", novoLead("P1", "F2", "+5587990000003", "Quer comprar"));
  assert.equal(leadPorTel("5587990000003").pipeline_id, antes.pipeline_id);

  caso("A escolha da Casa A não vale para a Casa B, nem o contrário");
  r = await B.post("/anuncios-meta/formularios/F1", { pipeline_id: funilB.id });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT pipeline_id FROM meta_formularios WHERE org_id = ? AND form_id = 'F1'").get(orgA).pipeline_id, loc.id);

  caso("Funil desativado depois: a tela avisa e o lead volta à regra de sempre, em vez de nascer fora das colunas");
  db.prepare("UPDATE pipelines SET is_active = 0 WHERE id = ?").run(loc.id);
  r = await A.get("/anuncios-meta/formularios");
  assert.equal(r.body.formularios.find((f) => f.id === "F1").funil_invalido, true);
  await avisar("P1", novoLead("P1", "F1", "+5587990000004", "Funil desligado"));
  const desl = leadPorTel("5587990000004");
  assert.equal(desl.pipeline_id, antes.pipeline_id);
  assert.ok(desl.stage_id);
  db.prepare("UPDATE pipelines SET is_active = 1 WHERE id = ?").run(loc.id);

  caso("Tirar a escolha (sem funil) volta à regra de sempre");
  r = await A.post("/anuncios-meta/formularios/F1", { pipeline_id: null });
  assert.equal(r.status, 200);
  await avisar("P1", novoLead("P1", "F1", "+5587990000005", "Depois de tirar"));
  assert.equal(leadPorTel("5587990000005").pipeline_id, antes.pipeline_id);

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  meta.close();
}
