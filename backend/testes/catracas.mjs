/* CATRACAS POR PRODUTO (03/10/2026, pedido do Ali: "várias catracas de
   atendimento para vários produtos… cada formulário vinculado a uma catraca…
   cuidado para não desorganizar o que já tem em cada cliente").

   Servidor de pé e uma Meta de mentira. O que se prova, nesta ordem:
   - sem catraca criada, NADA muda (é o caso de todo cliente hoje);
   - cada catraca tem a própria vez, e a principal não anda com ela;
   - entrega 'corretor' vai direto ao corretor; 'atendente' passa pela
     atendente e o repasse usa a catraca do produto;
   - disponibilidade é uma só; ninguém disponível na catraca → a principal,
     e a resposta diz isso;
   - desativar/apagar volta à regra de sempre; contas não se misturam.

   Rodar:  npm run teste:catracas
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
const DB = path.join(os.tmpdir(), "concrm-teste-catracas.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4803, PORTA_META = 4804, SEGREDO = "segredo-do-app";

/* ===== A Meta de mentira ===== */
const leads = {};
let seq = 0;
const novoLead = (form, tel, nome) => {
  const id = "LD" + (++seq);
  leads[id] = { id, form_id: form, platform: "fb", campaign_name: "Campanha " + form,
    field_data: [{ name: "full_name", values: [nome] }, { name: "phone_number", values: [tel] }] };
  return id;
};
const meta = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const ok = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  const p = u.pathname.replace(/^\/v[\d.]+\//, "");
  if (/^\w+\/leadgen_forms$/.test(p)) return ok({ data: [] });
  if (/^F\d$/.test(p)) return ok({ id: p, name: "Formulário " + p });
  if (leads[p]) return ok(leads[p]);
  res.statusCode = 400; ok({ error: { message: "não existe: " + p } });
});
await new Promise((r) => meta.listen(PORTA_META, "127.0.0.1", r));

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CAT-2026", APP_URL: "",
    META_APP_ID: "app1", META_APP_SECRET: SEGREDO, META_GRAPH_URL: `http://127.0.0.1:${PORTA_META}`,
    META_PAGE_ACCESS_TOKEN: "", CRYPTO_KEY: "c".repeat(64), UAZAPI_AUTOCONFIGURAR: "0" },
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
  let ordem = 0;
  const usuario = (o, email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now() + (++ordem));
    return id;
  };
  usuario(orgA, "gestora@ct.com", "adm");
  const sdr = usuario(orgA, "sdr@ct.com", "sdr");
  const c1 = usuario(orgA, "c1@ct.com", "corretor");
  const c2 = usuario(orgA, "c2@ct.com", "corretor");
  const c3 = usuario(orgA, "c3@ct.com", "corretor");
  usuario(orgB, "gestorb@ct.com", "adm");
  const cB = usuario(orgB, "cb@ct.com", "corretor");
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    const ir = async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) }; };
    return { get: (p) => ir("GET", p), post: (p, b) => ir("POST", p, b || {}), patch: (p, b) => ir("PATCH", p, b || {}),
      del: (p) => ir("DELETE", p) };
  };
  const A = await como("gestora@ct.com"), B = await como("gestorb@ct.com");
  const atendente = await como("sdr@ct.com"), corretor = await como("c1@ct.com");

  db.prepare(`INSERT INTO meta_paginas (page_id,org_id,nome,page_token,conectado_em) VALUES (?,?,?,?,?)`)
    .run("P1", orgA, "Página P1", fechar("tokpage-P1"), Date.now());
  const avisar = async (leadgen) => {
    const corpo = JSON.stringify({ object: "page", entry: [{ id: "P1", time: 1, changes: [{ field: "leadgen",
      value: { leadgen_id: leadgen, page_id: "P1", form_id: leads[leadgen].form_id } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", SEGREDO).update(corpo).digest("hex");
    const r = await fetch(url("/webhooks/meta"), { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: corpo });
    assert.equal(r.status, 200);
    await espera(400);
  };
  let tel = 0;
  const chegar = async (form) => {
    const t = "+55879900" + String(++tel).padStart(5, "0");
    await avisar(novoLead(form, t, "Cliente " + tel));
    return db.prepare("SELECT * FROM leads WHERE phone = ?").get(t.replace("+", ""));
  };
  const vezPrincipal = () => db.prepare("SELECT rodizio_ultimo FROM orgs WHERE id = ?").get(orgA).rodizio_ultimo;
  const disponivel = (id, v) => db.prepare("UPDATE users SET available = ? WHERE id = ?").run(v ? 1 : 0, id);

  caso("Sem catraca criada nada muda: fila principal, lead do formulário com a atendente, sem catraca");
  let r = await A.get("/distribution/rodizio");
  assert.equal(r.status, 200);
  assert.equal(r.body.catraca, null);
  assert.equal(r.body.proximo.id, c1);
  const semCatraca = await chegar("F9");
  assert.equal(semCatraca.assigned_to, sdr);
  assert.equal(semCatraca.catraca_id, null);
  r = await A.get(`/distribution/rodizio?lead_id=${semCatraca.id}`);
  assert.equal(r.body.catraca, null);
  assert.equal(r.body.reserva, false);
  assert.equal(r.body.proximo.id, c1);
  r = await A.get("/distribution/catracas");
  assert.deepEqual(r.body.catracas, []);
  assert.equal(r.body.principal.proximo.id, c1);

  caso("Criar é do gestor; a atendente vê; o corretor não entra");
  assert.equal((await atendente.post("/distribution/catracas", { nome: "X" })).status, 403);
  assert.equal((await atendente.get("/distribution/catracas")).status, 200);
  assert.equal((await corretor.get("/distribution/catracas")).status, 403);

  caso("Nome vazio, “Catraca principal”, nome repetido e corretor de outra conta são recusados");
  assert.equal((await A.post("/distribution/catracas", { nome: "  " })).status, 400);
  assert.equal((await A.post("/distribution/catracas", { nome: "catraca principal" })).status, 400);
  assert.equal((await A.post("/distribution/catracas", { nome: "Lançamento", membros: [c1, cB] })).status, 400);
  assert.equal((await A.post("/distribution/catracas", { nome: "Lançamento", membros: [c1, sdr] })).status, 400);
  assert.equal((await A.post("/distribution/catracas", { nome: "Lançamento", entrega: "robo" })).status, 400);

  caso("Duas catracas, com o mesmo corretor nas duas (C2)");
  r = await A.post("/distribution/catracas", { nome: "Lançamento", entrega: "corretor", membros: [c1, c2] });
  assert.equal(r.status, 200);
  const lanc = r.body.id;
  assert.equal((await A.post("/distribution/catracas", { nome: "lancamento" })).status, 409);
  r = await A.post("/distribution/catracas", { nome: "Aluguel", entrega: "atendente", membros: [c2, c3] });
  const alug = r.body.id;
  r = await A.get("/distribution/catracas");
  assert.equal(r.body.catracas.length, 2);
  assert.deepEqual(r.body.catracas.find((c) => c.id === alug).membros.sort(), [c2, c3].sort());
  assert.equal(r.body.catracas.find((c) => c.id === alug).fila.proximo.id, c2);

  caso("Formulário ligado a catraca: só gestor, só catraca desta conta");
  assert.equal((await atendente.post("/anuncios-meta/formularios/F1/catraca", { catraca_id: lanc })).status, 403);
  assert.equal((await B.post("/anuncios-meta/formularios/F1/catraca", { catraca_id: lanc })).status, 400);
  assert.equal((await A.post("/anuncios-meta/formularios/F1/catraca", { catraca_id: lanc, nome: "Lançamento Jardins" })).status, 200);
  assert.equal((await A.post("/anuncios-meta/formularios/F2/catraca", { catraca_id: alug })).status, 200);
  r = await A.get("/anuncios-meta/formularios");
  assert.deepEqual(r.body.formularios.find((f) => f.id === "F1").catraca_ids, [lanc]);
  // Escolher a catraca não mexe no funil (e vice-versa).
  assert.equal(r.body.formularios.find((f) => f.id === "F1").pipeline_id, null);

  caso("Entrega 'corretor': vai direto ao corretor da catraca, com a vez DELA; a principal não anda");
  const l1 = await chegar("F1");
  assert.equal(l1.assigned_to, c1);
  assert.equal(l1.catraca_id, lanc);
  assert.equal(l1.pipeline_id, P.funilComercial(orgA).id);
  const l2 = await chegar("F1");
  assert.equal(l2.assigned_to, c2);
  assert.equal(vezPrincipal(), null);

  caso("Entrega 'atendente': a atendente recebe; o repasse usa a catraca do produto");
  const a1 = await chegar("F2");
  assert.equal(a1.assigned_to, sdr);
  assert.equal(a1.catraca_id, alug);
  r = await atendente.get(`/distribution/rodizio?lead_id=${a1.id}`);
  assert.equal(r.body.catraca.id, alug);
  assert.equal(r.body.proximo.id, c2);
  r = await atendente.post("/distribution/handoff", { lead_id: a1.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.assigned_to, c2);
  assert.equal(r.body.catraca.nome, "Aluguel");
  const a2 = await chegar("F2");
  r = await atendente.post("/distribution/handoff", { lead_id: a2.id });
  assert.equal(r.body.assigned_to, c3);
  assert.equal(vezPrincipal(), null);

  caso("Disponibilidade é UMA só: quem está indisponível sai de todas as catracas");
  disponivel(c2, false);
  const a3 = await chegar("F2");
  r = await atendente.get(`/distribution/rodizio?lead_id=${a3.id}`);
  assert.equal(r.body.proximo.id, c3);
  r = await A.get("/distribution/catracas");
  assert.equal(r.body.catracas.find((c) => c.id === lanc).fila.proximo.id, c1);

  caso("Ninguém disponível na catraca: o repasse vai pela principal e a resposta diz isso");
  disponivel(c3, false);
  r = await atendente.get(`/distribution/rodizio?lead_id=${a3.id}`);
  assert.equal(r.body.reserva, true);
  assert.equal(r.body.catraca, null);
  assert.equal(r.body.catraca_do_lead.id, alug);
  assert.equal(r.body.proximo.id, c1);
  r = await atendente.post("/distribution/handoff", { lead_id: a3.id });
  assert.equal(r.body.assigned_to, c1);
  assert.equal(r.body.reserva, true);
  assert.equal(vezPrincipal(), c1);

  caso("Entrega 'corretor' sem ninguém disponível: o lead vai à atendente da vez, lembrando a catraca");
  disponivel(c1, false);
  const l3 = await chegar("F1");
  assert.equal(l3.assigned_to, sdr);
  assert.equal(l3.catraca_id, lanc);
  disponivel(c1, true); disponivel(c2, true); disponivel(c3, true);

  caso("Escolher a dedo: membro move a vez da catraca; quem não é membro move a principal");
  const a4 = await chegar("F2");     // vez do Aluguel: último foi c3 → próximo c2
  r = await atendente.post("/distribution/handoff", { lead_id: a4.id, user_id: c3 });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT ultimo_user_id FROM catracas WHERE id = ?").get(alug).ultimo_user_id, c3);
  const a5 = await chegar("F2");
  r = await atendente.post("/distribution/handoff", { lead_id: a5.id, user_id: c1 });
  assert.equal(vezPrincipal(), c1);
  assert.equal(db.prepare("SELECT ultimo_user_id FROM catracas WHERE id = ?").get(alug).ultimo_user_id, c3);

  caso("“Próximo” da fila e a automação da etapa também usam a catraca do lead");
  const a6 = await chegar("F2");
  r = await atendente.post("/distribution/devolver", { lead_id: a6.id });
  assert.equal(r.status, 200);
  r = await atendente.post("/distribution/next", { lead_id: a6.id });
  assert.equal(r.body.assigned_to, c2);          // depois de c3, na roda do Aluguel
  const a7 = await chegar("F2");
  const comercial = P.funilComercial(orgA);
  const etapas = P.etapasDoPipeline(orgA, comercial.id);
  const alvo = etapas[2];
  db.prepare("UPDATE pipeline_stages SET automation_config = ? WHERE id = ?").run(JSON.stringify({ distribuir: "rodizio" }), alvo.id);
  r = await A.patch(`/leads/${a7.id}/stage`, { stage: alvo.name, stage_id: alvo.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(a7.id).assigned_to, c3);
  db.prepare("UPDATE pipeline_stages SET automation_config = '{}' WHERE id = ?").run(alvo.id);

  caso("A catraca de um lead do WhatsApp se escolhe na ficha (atendente sim, corretor não, outra conta não)");
  r = await A.post("/leads", { nome: "Do WhatsApp", telefone: "87 99123-4567", assigned_to: "fila" });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  const wpp = r.body.id;
  assert.equal((await corretor.post("/distribution/catraca-do-lead", { lead_id: wpp, catraca_id: alug })).status, 403);
  assert.equal((await B.post("/distribution/catraca-do-lead", { lead_id: wpp, catraca_id: alug })).status, 404);
  assert.equal((await atendente.post("/distribution/catraca-do-lead", { lead_id: wpp, catraca_id: alug })).status, 200);
  r = await atendente.get(`/distribution/rodizio?lead_id=${wpp}`);
  assert.equal(r.body.catraca.id, alug);
  assert.equal((await atendente.post("/distribution/catraca-do-lead", { lead_id: wpp, catraca_id: null })).status, 200);
  r = await atendente.get(`/distribution/rodizio?lead_id=${wpp}`);
  assert.equal(r.body.catraca, null);

  caso("Outra conta não mexe nem lê a catraca desta");
  assert.equal((await B.patch(`/distribution/catracas/${alug}`, { nome: "Roubada" })).status, 404);
  assert.equal((await B.del(`/distribution/catracas/${alug}`)).status, 404);
  assert.equal((await B.get("/distribution/catracas")).body.catracas.length, 0);
  assert.equal((await B.get(`/distribution/rodizio?catraca=${alug}`)).status, 404);

  caso("Desativar: o formulário volta à regra de sempre");
  assert.equal((await A.patch(`/distribution/catracas/${lanc}`, { ativa: false })).status, 200);
  const l4 = await chegar("F1");
  assert.equal(l4.assigned_to, sdr);
  assert.equal(l4.catraca_id, null);
  r = await atendente.get(`/distribution/rodizio?lead_id=${l1.id}`);   // lead antigo da catraca desativada
  assert.equal(r.body.catraca, null);
  assert.equal(r.body.reserva, false);
  assert.equal((await A.post("/anuncios-meta/formularios/F1/catraca", { catraca_id: lanc })).status, 400);

  caso("Apagar: com lead ligado, só desativa; sem lead, apaga e solta o formulário");
  r = await A.del(`/distribution/catracas/${alug}`);
  assert.equal(r.body.desativada, true);
  assert.ok(db.prepare("SELECT 1 FROM catracas WHERE id = ?").get(alug));
  r = await A.post("/distribution/catracas", { nome: "Vazia", membros: [c1] });
  const vazia = r.body.id;
  await A.post("/anuncios-meta/formularios/F3/catraca", { catraca_id: vazia });
  r = await A.del(`/distribution/catracas/${vazia}`);
  assert.equal(r.body.apagada, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM catraca_canais WHERE catraca_id = ?").get(vazia).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM catraca_membros WHERE catraca_id = ?").get(vazia).n, 0);

  caso("Canais e etapa: só funil/etapa desta conta; a catraca guarda o que foi marcado");
  const { nascerLeadDoWhatsapp } = await import("../src/services/lead-whatsapp.js");
  const { receberLead } = await import("../src/services/portais.js");
  const etapasCom = P.etapasDoPipeline(orgA, P.funilComercial(orgA).id);
  const qualificado = etapasCom[1], entradaCom = etapasCom[0];
  const etapaDeB = P.etapasDoPipeline(orgB, P.pipelinePadrao(orgB).id)[1];
  assert.equal((await A.post("/distribution/catracas", { nome: "Errada", stage_id: etapaDeB.id })).status, 400);
  const outroFunil = db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND id <> ? LIMIT 1").get(orgA, P.funilComercial(orgA).id);
  if (outroFunil) assert.equal((await A.post("/distribution/catracas", { nome: "Errada", pipeline_id: outroFunil.id, stage_id: qualificado.id })).status, 400);
  disponivel(c1, true); disponivel(c2, true); disponivel(c3, true);
  r = await A.post("/distribution/catracas", { nome: "Site e portal", entrega: "atendente", membros: [c3],
    pipeline_id: P.funilComercial(orgA).id, stage_id: qualificado.id, canais: { site: true, portal: true, formularios: ["F5"] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sp = r.body.id;
  r = await A.get("/distribution/catracas");
  let cSp = r.body.catracas.find((c) => c.id === sp);
  assert.deepEqual(cSp.canais, { whatsapp: false, portal: true, site: true, formularios: ["F5"] });
  assert.equal(cSp.etapa.nome, qualificado.name);
  assert.equal(cSp.etapa.ok, true);

  caso("WhatsApp do site: a primeira mensagem do botão do site marca o canal; o lead lembra a catraca e fica com a atendente");
  const casa = { org_id: orgA, tipo: "imobiliaria", id: "casa", nome: "Casa" };
  const doSite = nascerLeadDoWhatsapp({ canal: casa, phone: "5587911110001", nome: "Visitante",
    texto: "Olá! Tenho interesse no imóvel \"Casa\" (cód. 12) que vi no site: https://x/imoveis/casa/1/casa" });
  assert.equal(doSite.origem, "Site");
  assert.equal(doSite.catraca_id, sp);
  assert.equal(doSite.assigned_to, sdr);
  const doWpp = nascerLeadDoWhatsapp({ canal: casa, phone: "5587911110002", nome: "Comum", texto: "oi, quero saber de casas" });
  assert.equal(doWpp.origem, "WhatsApp");
  assert.equal(doWpp.catraca_id, null);
  const pessoal = nascerLeadDoWhatsapp({ canal: { org_id: orgA, tipo: "corretor", id: "linha-c1", user_id: c1, nome: "c1" },
    phone: "5587911110003", nome: "Do c1", texto: "vim pelo site" });
  assert.equal(pessoal.assigned_to, c1);
  assert.equal(pessoal.catraca_id, null);

  caso("A etapa ACIONA a catraca: a atendente move para a etapa e o lead vai ao próximo corretor dela");
  r = await atendente.patch(`/leads/${doSite.id}/stage`, { stage: qualificado.name, stage_id: qualificado.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let agora = db.prepare("SELECT assigned_to, catraca_id FROM leads WHERE id = ?").get(doSite.id);
  assert.equal(agora.assigned_to, c3);
  assert.equal(r.body.responsavel_nome, "c3");
  // Lead de canal que a catraca não recebe: entra na etapa e nada muda.
  r = await atendente.patch(`/leads/${doWpp.id}/stage`, { stage: qualificado.name, stage_id: qualificado.id });
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(doWpp.id).assigned_to, sdr);
  // Lead já com corretor: a etapa não tira o lead dele.
  const dePortal = await receberLead(orgA, { portal: "Zap", nome: "Do portal", telefone: "5587911110004" });
  let lp = db.prepare("SELECT * FROM leads WHERE id = ?").get(dePortal.lead_id);
  assert.equal(lp.catraca_id, sp);
  db.prepare("UPDATE leads SET assigned_to = ? WHERE id = ?").run(c1, lp.id);
  r = await A.patch(`/leads/${lp.id}/stage`, { stage: qualificado.name, stage_id: qualificado.id });
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(lp.id).assigned_to, c1);
  // Ninguém disponível: o lead entra na etapa, continua com quem estava, e a resposta avisa.
  disponivel(c3, false);
  const dePortal2 = await receberLead(orgA, { portal: "Zap", nome: "Do portal 2", telefone: "5587911110005" });
  r = await atendente.patch(`/leads/${dePortal2.lead_id}/stage`, { stage: qualificado.name, stage_id: qualificado.id });
  assert.equal(r.status, 200);
  assert.match(r.body.aviso || "", /Ninguém da catraca Site e portal/);
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(dePortal2.lead_id).assigned_to, sdr);
  disponivel(c3, true);

  caso("Um canal em várias catracas: 'direto ao corretor' nasce na etapa da catraca e as catracas se revezam");
  r = await A.post("/distribution/catracas", { nome: "Dolphin A", entrega: "corretor", membros: [c1],
    pipeline_id: P.funilComercial(orgA).id, stage_id: qualificado.id, canais: { formularios: ["F6"] } });
  const dA = r.body.id;
  r = await A.post("/distribution/catracas", { nome: "Dolphin B", entrega: "corretor", membros: [c2], canais: { formularios: ["F6"] } });
  const dB = r.body.id;
  r = await A.get("/anuncios-meta/formularios");
  assert.deepEqual(r.body.formularios.find((f) => f.id === "F6").catraca_ids.sort(), [dA, dB].sort());
  const d1 = await chegar("F6"), d2 = await chegar("F6"), d3 = await chegar("F6");
  assert.deepEqual([d1.catraca_id, d2.catraca_id, d3.catraca_id], [dA, dB, dA]);
  assert.deepEqual([d1.assigned_to, d2.assigned_to, d3.assigned_to], [c1, c2, c1]);
  assert.equal(d1.stage_id, qualificado.id);   // nasce na etapa da catraca
  assert.notEqual(d2.stage_id, qualificado.id); // a B não tem etapa: funil de quem recebe
  assert.equal(d2.stage_id, entradaCom.id);
  // Editar sem mandar os canais não apaga os canais.
  assert.equal((await A.patch(`/distribution/catracas/${dA}`, { nome: "Dolphin A1" })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM catraca_canais WHERE catraca_id = ?").get(dA).n, 1);
  // Tirar a etapa.
  assert.equal((await A.patch(`/distribution/catracas/${dA}`, { stage_id: null })).status, 200);
  assert.equal(db.prepare("SELECT stage_id FROM catracas WHERE id = ?").get(dA).stage_id, null);

  caso("Conta de corretor autônomo não tem catraca");
  db.prepare("UPDATE orgs SET tipo = 'autonomo' WHERE id = ?").run(orgB);
  assert.equal((await B.post("/distribution/catracas", { nome: "Minha" })).status, 403);

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  meta.close();
}
