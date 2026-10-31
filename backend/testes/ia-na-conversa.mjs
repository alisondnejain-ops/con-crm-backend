/* A IA NA CONVERSA E NOS FLUXOS (31/10/2026, lista do Fernando).

   1. "Sugerir mensagem": a IA escreve um RASCUNHO — nada sai para o cliente e
      nada entra na conversa; as orientações da casa vão no pedido; outro
      corretor não pede sugestão de lead que não é dele.
   2. Bloco "Chamar a IA" no fluxo: sem a instrução, o fluxo não fica pronto.
   3. A mensagem que a IA escreveu sai para o cliente e entra na conversa como
      "Automação · nome", com a conversa e as orientações no pedido.
   4. Sem o Autoatendimento no plano, o fluxo com o bloco não fica pronto.

   Rodar:  npm run teste:ia-na-conversa */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-ia-conversa.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4817";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4818";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const envios = [], pedidosIA = [];
let respostaIA = { mensagem: "Oi Joana! Conseguiu ver a proposta que te mandei?", porque: "A proposta ficou sem resposta." };
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (req.url === "/v1/messages") {
      pedidosIA.push(JSON.parse(corpo || "{}"));
      return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(respostaIA) }], usage: { input_tokens: 500, output_tokens: 40 } });
    }
    if (req.url.startsWith("/send/")) { const d = corpo ? JSON.parse(corpo) : {}; envios.push({ numero: d.number, texto: d.text || "" });
      return json(200, { messageid: "wa_" + envios.length }); }
    json(200, { instance: { status: "connected" }, status: { connected: true, loggedIn: true } });
  });
});
await new Promise(r => mock.listen(4818, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarDisparos } = await import("../src/services/disparo.js");
const P = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4817";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "IA-" + id.slice(4), Date.now(), "");
  P.garantirPipelinePadrao(id); return id; };
let ordem = 0;
const pessoa = (org, nome, role, master = 0) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@ia.com", senha, role, Date.now() + (++ordem), master);
  return id; };
const casa = novaOrg("ConHub"); pessoa(casa, "Ali", "adm", 1);
const org = novaOrg("Imobiliária Sol");
pessoa(org, "Gestora", "adm"); const marina = pessoa(org, "Marina", "corretor"); pessoa(org, "Rafael", "corretor");
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = 'tk' WHERE id = ?").run("http://127.0.0.1:4818", org);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at) VALUES (?,?,'imobiliaria',?, 'tk',1,?)`).run("c_" + randomUUID(), org, "http://127.0.0.1:4818", Date.now());
db.prepare("INSERT INTO robo_ensino (id,org_id,texto,ordem,ativo,created_at) VALUES (?,?,?,1,1,?)").run("en_1", org, "Trate o cliente pelo primeiro nome.", Date.now());

const entrar = async (n) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: n.toLowerCase() + "@ia.com", password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("Gestora"), tM = await entrar("Marina"), tR = await entrar("Rafael"), tAli = await entrar("Ali");
const lead = "l_" + randomUUID(), fone = "5587991230077";
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Atendimento',?,?)`)
  .run(lead, org, "Joana Lima", fone, Date.now(), marina);
db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)`).run("m_a", lead, "out", "Te mandei a proposta da casa no Centro.", Date.now() - 86400000);
db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)`).run("m_b", lead, "in", "Vou olhar com calma", Date.now() - 86000000);

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }
const texto = (p) => p.messages[0].content[0].text;

console.log("A IA na conversa e nos fluxos");
await caso("1. Sugerir mensagem: rascunho, nada sai, orientações no pedido", async () => {
  const antesMsgs = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(lead).n;
  let r = await chamar(tR, `/leads/${lead}/proxima-mensagem`, "POST", {});
  assert.equal(r.status, 403, "outro corretor não pede");
  r = await chamar(tM, `/leads/${lead}/proxima-mensagem`, "POST", { pedido: "retomar a proposta" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.match(r.d.mensagem, /proposta/);
  assert.ok(r.d.porque);
  assert.equal(envios.length, 0, "nada sai para o cliente");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(lead).n, antesMsgs, "nada entra na conversa");
  const t = texto(pedidosIA[pedidosIA.length - 1]);
  assert.ok(t.includes("Trate o cliente pelo primeiro nome"), "as orientações vão no pedido");
  assert.ok(t.includes("Vou olhar com calma"), "a conversa vai no pedido");
  assert.ok(t.includes("retomar a proposta"), "o que a pessoa pediu vai junto");
  assert.ok(db.prepare("SELECT 1 FROM ia_uso WHERE lead_id = ? AND recurso = 'proxima_mensagem'").get(lead), "o gasto fica registrado");
});

let fluxo;
await caso("2. Bloco 'Chamar a IA' sem instrução não fica pronto", async () => {
  await chamar(tAli, `/orgs/${org}/marketing`, "POST", { liberado: true });
  assert.equal((await chamar(tG, "/marketing/termo", "POST", { aceito: true })).status, 200);
  const r = await chamar(tG, "/marketing/fluxos", "POST", { nome: "Retomar com IA" }); fluxo = r.d.id;
  const g = r.d.grafo; g.nos = g.nos.filter(n => n.tipo === "inicio"); const ini = g.nos.find(n => n.tipo === "inicio");
  g.nos.push({ id: "ia1", tipo: "ia", x: 300, y: 100, dados: { instrucao: "" } });
  g.ligacoes = [{ de: ini.id, saida: "proximo", para: "ia1" }];
  assert.equal((await chamar(tG, "/marketing/fluxos/" + fluxo, "PUT", { nome: "Retomar com IA", grafo: g })).status, 200);
  let l = await chamar(tM, `/leads/${lead}/fluxos`);
  assert.ok(!l.d.fluxos.some(x => x.id === fluxo), "sem instrução, não está pronto");
  g.nos.find(n => n.id === "ia1").dados.instrucao = "Pergunte se a pessoa conseguiu ver a proposta";
  assert.equal((await chamar(tG, "/marketing/fluxos/" + fluxo, "PUT", { nome: "Retomar com IA", grafo: g })).status, 200);
  l = await chamar(tM, `/leads/${lead}/fluxos`);
  const f = l.d.fluxos.find(x => x.id === fluxo);
  assert.ok(f, JSON.stringify(l.d));
  assert.match(f.previa.mensagens[0].texto, /a IA escreve/, "a prévia diz que é a IA quem escreve");
});

await caso("3. A IA escreve e a mensagem sai, como automação", async () => {
  respostaIA = { mensagem: "Oi Joana! Conseguiu dar uma olhada na proposta?" };
  const antes = pedidosIA.length;
  const r = await chamar(tM, `/leads/${lead}/fluxos`, "POST", { fluxo_id: fluxo });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  await processarDisparos({ agora: Date.now() + 1000 });
  assert.equal(pedidosIA.length, antes + 1, "a IA foi chamada uma vez");
  const t = texto(pedidosIA[pedidosIA.length - 1]);
  assert.ok(t.includes("Pergunte se a pessoa conseguiu ver a proposta"), "a instrução do bloco vai no pedido");
  assert.ok(t.includes("Trate o cliente pelo primeiro nome"), "as orientações também");
  assert.equal(envios.length, 1); assert.equal(envios[0].texto, "Oi Joana! Conseguiu dar uma olhada na proposta?");
  const m = db.prepare("SELECT from_name, body FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY created_at DESC").get(lead);
  assert.match(m.from_name, /^Automação/); assert.match(m.body, /proposta/);
  assert.ok(db.prepare("SELECT 1 FROM ia_uso WHERE lead_id = ? AND recurso = 'fluxo_ia'").get(lead));
});

await caso("4. Sem o Autoatendimento no plano, o fluxo não fica pronto", async () => {
  db.prepare(`INSERT INTO org_recursos (org_id, recurso, master) VALUES (?, 'autoatendimento', 'retirado')
    ON CONFLICT(org_id, recurso) DO UPDATE SET master = 'retirado'`).run(org);
  const l = await chamar(tM, `/leads/${lead}/fluxos`);
  assert.ok(!l.d.fluxos.some(x => x.id === fluxo), "o bloco depende do Autoatendimento");
});

console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
mock.close(); process.exit(falhas ? 1 : 0);
