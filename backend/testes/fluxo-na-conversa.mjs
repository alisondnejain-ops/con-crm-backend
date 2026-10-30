/* MANDAR UM FLUXO DE DENTRO DA CONVERSA (30/10/2026, lista do Fernando).

   1. Sem Marketing liberado, a conversa não oferece fluxo nenhum.
   2. A lista traz só os fluxos prontos, com a PRÉVIA do que sai.
   3. Mandar: o lead entra no fluxo, a mensagem sai pela linha da conversa, sem
      o rodapé "Responda SAIR"; e entra como "Automação · nome".
   4. "Parar quando o cliente responder" (padrão): a resposta encerra.
   5. Um fluxo por vez na conversa; parar pela conversa encerra.
   6. Outro corretor não manda; cliente que pediu para sair não recebe.

   Rodar:  npm run teste:fluxo-na-conversa */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-fluxo-conversa.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4815";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const envios = [];
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (req.url.startsWith("/send/")) { const d = corpo ? JSON.parse(corpo) : {}; envios.push({ numero: d.number, texto: d.text || "" });
      return json(200, { messageid: "wa_" + envios.length }); }
    json(200, { instance: { status: "connected" }, status: { connected: true, loggedIn: true } });
  });
});
await new Promise(r => mock.listen(4816, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarDisparos, mensagemRecebida } = await import("../src/services/disparo.js");
const P = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4815";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "FC-" + id.slice(4), Date.now(), "");
  P.garantirPipelinePadrao(id); return id; };
let ordem = 0;
const pessoa = (org, nome, role, master = 0) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@fc.com", senha, role, Date.now() + (++ordem), master);
  return id; };
const casa = novaOrg("ConHub"); pessoa(casa, "Ali", "adm", 1);
const org = novaOrg("Imobiliária");
pessoa(org, "Gestora", "adm"); const marina = pessoa(org, "Marina", "corretor"); pessoa(org, "Rafael", "corretor");
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = 'tk' WHERE id = ?").run("http://127.0.0.1:4816", org);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at) VALUES (?,?,'imobiliaria',?, 'tk',1,?)`).run("c_" + randomUUID(), org, "http://127.0.0.1:4816", Date.now());

const entrar = async (n) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: n.toLowerCase() + "@fc.com", password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("Gestora"), tM = await entrar("Marina"), tR = await entrar("Rafael"), tAli = await entrar("Ali");
const lead = "l_" + randomUUID(), fone = "5587991230055";
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Atendimento',?,?)`)
  .run(lead, org, "Joana Lima", fone, Date.now(), marina);

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }
let fluxo;
console.log("Fluxo mandado da conversa");
await caso("1. Sem Marketing, nada", async () => {
  const r = await chamar(tM, `/leads/${lead}/fluxos`);
  assert.equal(r.status, 200); assert.equal(r.d.liberado, false);
});
await caso("2. Só fluxo pronto aparece, com a prévia", async () => {
  await chamar(tAli, `/orgs/${org}/marketing`, "POST", { liberado: true });
  assert.equal((await chamar(tG, "/marketing/termo", "POST", { aceito: true })).status, 200);
  let r = await chamar(tG, "/marketing/fluxos", "POST", { nome: "Follow-up" }); fluxo = r.d.id;
  const q = await chamar(tG, "/marketing/fluxos", "POST", { nome: "Quebrado" });
  const gq = q.d.grafo; gq.nos.find(n => n.tipo === "mensagem").dados.texto = "";
  await chamar(tG, "/marketing/fluxos/" + q.d.id, "PUT", { nome: "Quebrado", grafo: gq });
  const vazio = await chamar(tM, `/leads/${lead}/fluxos`);
  assert.ok(!vazio.d.fluxos.some(x => x.id === q.d.id), "fluxo com mensagem vazia não está pronto");
  const g = r.d.grafo; g.nos = g.nos.filter(n => n.tipo === "inicio"); const ini = g.nos.find(n => n.tipo === "inicio");
  g.nos.push({ id: "m1", tipo: "mensagem", x: 300, y: 100, dados: { texto: "Oi {nome}, conseguiu ver a proposta?" } });
  g.nos.push({ id: "e1", tipo: "espera", x: 500, y: 100, dados: { quantidade: 1, unidade: "dias" } });
  g.nos.push({ id: "m2", tipo: "mensagem", x: 700, y: 100, dados: { texto: "Segue de pé!" } });
  g.ligacoes = [{ de: ini.id, saida: "proximo", para: "m1" }, { de: "m1", saida: "proximo", para: "e1" }, { de: "e1", saida: "proximo", para: "m2" }];
  r = await chamar(tG, "/marketing/fluxos/" + fluxo, "PUT", { nome: "Follow-up", grafo: g });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  r = await chamar(tM, `/leads/${lead}/fluxos`);
  const f = r.d.fluxos.find(x => x.id === fluxo);
  assert.ok(f, JSON.stringify(r.d)); assert.equal(f.previa.mensagens.length, 1); assert.match(f.previa.mensagens[0].texto, /proposta/);
  assert.equal(f.previa.parou, "uma espera");
});
await caso("3. Mandar: sai pela conversa, sem rodapé de saída, entra como automação", async () => {
  let r = await chamar(tR, `/leads/${lead}/fluxos`, "POST", { fluxo_id: fluxo });
  assert.equal(r.status, 403, "outro corretor não manda");
  r = await chamar(tM, `/leads/${lead}/fluxos`, "POST", { fluxo_id: fluxo });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.em_andamento.length, 1); assert.equal(r.d.em_andamento[0].para_se_responder, true);
  await processarDisparos({ agora: Date.now() + 1000 });
  assert.equal(envios.length, 1); assert.match(envios[0].texto, /Joana/); assert.doesNotMatch(envios[0].texto, /SAIR/);
  const m = db.prepare("SELECT from_name FROM messages WHERE lead_id = ? AND direction = 'out'").get(lead);
  assert.match(m.from_name, /^Automação/);
});
await caso("4. Um por vez; a resposta do cliente encerra", async () => {
  let r = await chamar(tM, `/leads/${lead}/fluxos`, "POST", { fluxo_id: fluxo });
  assert.equal(r.status, 409);
  mensagemRecebida({ orgId: org, lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead), texto: "vi sim", fromMe: false });
  r = await chamar(tM, `/leads/${lead}/fluxos`);
  assert.equal(r.d.em_andamento.length, 0, "parou quando o cliente respondeu");
  await processarDisparos({ agora: Date.now() + 2 * 86400000 });
  assert.equal(envios.length, 1, "a segunda mensagem não sai");
});
await caso("5. Sem parar ao responder: segue; e parar pela conversa encerra", async () => {
  let r = await chamar(tM, `/leads/${lead}/fluxos`, "POST", { fluxo_id: fluxo, parar_ao_responder: false });
  assert.equal(r.status, 200);
  await processarDisparos({ agora: Date.now() + 1000 });
  mensagemRecebida({ orgId: org, lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead), texto: "ok", fromMe: false });
  r = await chamar(tM, `/leads/${lead}/fluxos`);
  assert.equal(r.d.em_andamento.length, 1, "continua");
  r = await chamar(tG, `/leads/${lead}/fluxos/${r.d.em_andamento[0].id}`, "DELETE");
  assert.equal(r.status, 200); assert.equal(r.d.em_andamento.length, 0);
});
await caso("6. Quem pediu para sair não recebe", async () => {
  db.prepare("INSERT INTO marketing_bloqueio (org_id, telefone, motivo, criado_em) VALUES (?,?,?,?)").run(org, fone, "pediu", Date.now());
  const r = await chamar(tM, `/leads/${lead}/fluxos`, "POST", { fluxo_id: fluxo });
  assert.equal(r.status, 409); assert.match(r.d.error, /não receber/);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
mock.close(); process.exit(falhas ? 1 : 0);
