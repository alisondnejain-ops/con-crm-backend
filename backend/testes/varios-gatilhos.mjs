/* VÁRIOS GATILHOS NUM FLUXO (16/10/2026) — services/automacoes.js +
   services/disparo.js. Copia a montagem de testes/gatilhos.mjs.

   O que se prova: cada gatilho segue o PRÓPRIO caminho; um lead anda por
   um caminho de cada vez; "uma vez só" vale por gatilho; gatilhos que pegam
   a mesma ação são recusados; gatilho sem seta é recusado; um formulário
   continua ligando uma automação só; o disparo em massa começa no gatilho
   "Disparo em massa"; o fluxo de um gatilho só não muda.

   Rodar:  npm run teste:varios-gatilhos
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-varios-gatilhos.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4815";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.UAZAPI_ACEITAR_POR_NUMERO = "";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== UAZAPI DE MENTIRA =====
const DONO_DO_TOKEN = { "tok-casa-A": "5587911112222" };
const envios = [];
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    const tk = req.headers.token;
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (!DONO_DO_TOKEN[tk]) return json(401, { error: "token inválido" });
    if (req.url.startsWith("/send/")) {
      const d = corpo ? JSON.parse(corpo) : {};
      const id = "wa_" + Math.random().toString(36).slice(2);
      envios.push({ token: tk, rota: req.url, numero: d.number, texto: d.text || "", id });
      return json(200, { messageid: id });
    }
    json(200, { instance: { status: "connected", owner: DONO_DO_TOKEN[tk] }, status: { connected: true, loggedIn: true } });
  });
});
await new Promise(r => mock.listen(4816, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarDisparos } = await import("../src/services/disparo.js");
const { receberLead } = await import("../src/services/portais.js");
const { moverEtapa } = await import("../src/services/etapas.js");
const P = await import("../src/services/pipelines.js");
const C = await import("../src/services/catracas.js");
const BASE = "http://localhost:4815";
const MOCK = "http://127.0.0.1:4816";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "GT-" + id.slice(4), Date.now(), "");
  P.garantirPipelinePadrao(id);
  return id; };
let ordem = 0;
const pessoa = (org, nome, role, extra = {}) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@gt.com", senha, role, Date.now() + (++ordem), extra.master ? 1 : 0);
  return id; };

const casaConHub = novaOrg("ConHub");
pessoa(casaConHub, "Ali", "adm", { master: true });
const orgA = novaOrg("Imobiliária A");
const gestora = pessoa(orgA, "Gestora", "adm");
const atendente = pessoa(orgA, "Vanessa", "sdr");
const marina = pessoa(orgA, "Marina", "corretor");
const rafael = pessoa(orgA, "Rafael", "corretor");
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ?, wa_number = ? WHERE id = ?").run(MOCK, "tok-casa-A", "5587911112222", orgA);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,wa_number,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,?,1,?)`)
  .run("c_" + randomUUID(), orgA, MOCK, "tok-casa-A", "5587911112222", Date.now());
const orgB = novaOrg("Imobiliária B");
pessoa(orgB, "OutroGestor", "adm");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@gt.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login ${nome}: ${JSON.stringify(d)}`); return d.token;
}
const chamar = async (token, caminho, metodo = "GET", corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const tGestora = await entrar("Gestora"), tAli = await entrar("Ali"), tOutro = await entrar("OutroGestor");
await chamar(tAli, `/orgs/${orgA}/marketing`, "POST", { liberado: true });
await chamar(tAli, `/orgs/${orgB}/marketing`, "POST", { liberado: true });
assert.equal((await chamar(tGestora, "/marketing/termo", "POST", { aceito: true })).status, 200);
assert.equal((await chamar(tOutro, "/marketing/termo", "POST", { aceito: true })).status, 200);


const { marcarTag, desmarcarTag } = await import("../src/services/tags.js");
const { inicioDoDisparo } = await import("../src/services/disparo.js");
const tagVip = "t_" + randomUUID(), tagOutra = "t_" + randomUUID();
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tagVip, orgA, "VIP", "#2F80C4", Date.now());
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tagOutra, orgA, "Outra", "#0E8F6E", Date.now());
let agora = Date.now();
const tique = async (segundos = 0) => { agora += segundos * 1000; await processarDisparos({ agora }); };
const execsDe = (fluxoId) => {
  const camp = db.prepare("SELECT automacao_id FROM marketing_fluxos WHERE id = ?").get(fluxoId).automacao_id;
  return camp ? db.prepare("SELECT * FROM marketing_execucoes WHERE campanha_id = ? ORDER BY criado_em").all(camp) : [];
};
let tel = 0;
const chegaFormulario = (formId, nome = "Cliente") => {
  const t = "55879920" + String(++tel).padStart(5, "0");
  const r = receberLead(orgA, { portal: "Meta Ads", externo: "LV" + tel, nome, telefone: t, formulario: true,
    respostas: {}, qual: {}, anuncio: { platform: "fb", form_id: formId, form_name: "Form " + formId, campaign_name: "C1" } });
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(r.lead_id);
};
const leadSolto = (nome) => {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, orgA, nome, "55879930" + String(++tel).padStart(5, "0"), "Lead", Date.now());
  return id;
};
const textosPara = (telefone) => envios.filter(e => String(e.numero || "").includes(telefone.slice(-8))).map(e => e.texto);
const msg = (id, texto, x = 300, y = 0) => ({ id, tipo: "mensagem", x, y, dados: { texto } });
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

try {
  caso("Fluxo com dois gatilhos, cada um com o seu caminho, salva e liga");
  let r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Dois caminhos" });
  const fluxo = r.d.id;
  const grafo = { nos: [
    { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho: { tipo: "formulario", formularios: [{ id: "F1", nome: "Form F1" }] } } },
    { id: "g2", tipo: "inicio", x: 0, y: 300, dados: { gatilho: { tipo: "etiqueta", tag_id: tagVip } } },
    msg("a1", "Caminho do formulário"), { id: "esp", tipo: "espera", x: 600, y: 0, dados: { quantidade: 1, unidade: "dias" } },
    msg("a2", "Formulário, um dia depois", 900), msg("b1", "Caminho da etiqueta VIP", 300, 300) ],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "a1" }, { de: "a1", saida: "proximo", para: "esp" },
      { de: "esp", saida: "proximo", para: "a2" }, { de: "g2", saida: "proximo", para: "b1" }] };
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.avisos, []);
  assert.deepEqual(r.d.gatilho_avisos, []);
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}/ativar`, "POST", { ativo: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const row = db.prepare("SELECT gatilho_tipo, gatilho_ref FROM marketing_fluxos WHERE id = ?").get(fluxo);
  assert.equal(row.gatilho_tipo, ",formulario,etiqueta,");
  assert.equal(row.gatilho_ref, ",F1,");
  r = await chamar(tGestora, "/marketing/fluxos");
  assert.equal(r.d.fluxos.find(f => f.id === fluxo).gatilhos.length, 2);

  caso("Quem preenche o formulário entra pelo gatilho 1 e só recebe o caminho dele");
  const l1 = chegaFormulario("F1", "Ana");
  let ex = execsDe(fluxo);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].gatilho_no, "inicio");
  await tique(5);
  assert.deepEqual(textosPara(l1.phone), ["Caminho do formulário"]);

  caso("Quem ganha a etiqueta VIP entra pelo gatilho 2 e segue o caminho dele");
  const l2 = leadSolto("Bruno");
  marcarTag(orgA, l2, tagVip, gestora);
  ex = execsDe(fluxo);
  assert.equal(ex.length, 2);
  assert.equal(ex[1].gatilho_no, "g2");
  await tique(5);
  const tel2 = db.prepare("SELECT phone FROM leads WHERE id = ?").get(l2).phone;
  assert.deepEqual(textosPara(tel2), ["Caminho da etiqueta VIP"]);

  caso("Um caminho de cada vez: o lead no meio do caminho 1 não entra pelo gatilho 2");
  marcarTag(orgA, l1.id, tagVip, gestora);
  assert.equal(execsDe(fluxo).length, 2, "não nasceu outra execução");

  caso("Terminado o caminho 1, a ação do gatilho 2 coloca o lead no caminho 2 (uma vez só vale por gatilho)");
  await tique(86400 + 5);
  assert.deepEqual(textosPara(l1.phone), ["Caminho do formulário", "Formulário, um dia depois"]);
  desmarcarTag(orgA, l1.id, tagVip);
  marcarTag(orgA, l1.id, tagVip, gestora);
  ex = execsDe(fluxo).filter(e => e.lead_id === l1.id);
  assert.equal(ex.length, 2);
  assert.equal(ex[1].gatilho_no, "g2");
  await tique(5);
  assert.equal(textosPara(l1.phone).at(-1), "Caminho da etiqueta VIP");

  caso("E não entra de novo pelo mesmo gatilho sem “pode entrar de novo”");
  desmarcarTag(orgA, l1.id, tagVip);
  marcarTag(orgA, l1.id, tagVip, gestora);
  assert.equal(execsDe(fluxo).filter(e => e.lead_id === l1.id).length, 2);

  caso("Os números contam quantos entraram por cada gatilho, e o histórico diz por qual");
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`);
  assert.deepEqual(r.d.automacao.por_gatilho, { inicio: 1, g2: 2 });
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}/logs`);
  assert.deepEqual(r.d.execucoes.map(e => e.gatilho_no).sort(), ["g2", "g2", "inicio"]);

  caso("Gatilhos que pegam a mesma ação são recusados ao ligar");
  r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Sobreposto" });
  const sob = r.d.id;
  const doisIguais = { nos: [
    { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho: { tipo: "etiqueta", tag_id: tagOutra } } },
    { id: "g2", tipo: "inicio", x: 0, y: 300, dados: { gatilho: { tipo: "etiqueta", tag_id: tagOutra } } },
    msg("m1", "Um"), msg("m2", "Dois", 300, 300) ],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "m1" }, { de: "g2", saida: "proximo", para: "m2" }] };
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: doisIguais });
  assert.equal(r.status, 200, "rascunho com sobreposição salva");
  assert.ok(r.d.gatilho_avisos.some(a => /se sobrepõem/.test(a)), JSON.stringify(r.d.gatilho_avisos));
  r = await chamar(tGestora, `/marketing/fluxos/${sob}/ativar`, "POST", { ativo: true });
  assert.equal(r.status, 422);
  assert.match(r.d.error, /se sobrepõem/);

  caso("Lead novo de formulário junto com “formulário preenchido” também se sobrepõe");
  const comLeadNovo = JSON.parse(JSON.stringify(doisIguais));
  comLeadNovo.nos[0].dados.gatilho = { tipo: "lead_novo", origens: [] };
  comLeadNovo.nos[1].dados.gatilho = { tipo: "formulario", formularios: [{ id: "F9" }] };
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: comLeadNovo });
  assert.ok(r.d.gatilho_avisos.some(a => /lead novo de formulário/.test(a)), JSON.stringify(r.d.gatilho_avisos));
  comLeadNovo.nos[0].dados.gatilho = { tipo: "lead_novo", origens: ["whatsapp"] };
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: comLeadNovo });
  assert.deepEqual(r.d.gatilho_avisos, [], "lead novo só do WhatsApp não pega o formulário");

  caso("Gatilho sem seta é recusado");
  const solto = JSON.parse(JSON.stringify(comLeadNovo));
  solto.ligacoes = solto.ligacoes.filter(l => l.de !== "g2");
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: solto });
  assert.ok(r.d.avisos.some(a => /gatilho 2 .* não está ligado/i.test(a)), JSON.stringify(r.d.avisos));

  caso("Um formulário, uma automação — também no segundo gatilho de outro fluxo");
  const outroComF1 = JSON.parse(JSON.stringify(comLeadNovo));
  outroComF1.nos[1].dados.gatilho = { tipo: "formulario", formularios: [{ id: "F1", nome: "Form F1" }] };
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: outroComF1 });
  r = await chamar(tGestora, `/marketing/fluxos/${sob}/ativar`, "POST", { ativo: true });
  assert.equal(r.status, 409, JSON.stringify(r.d));
  assert.match(r.d.error, /Form F1/);

  caso("O disparo em massa começa no gatilho “Disparo em massa”");
  assert.equal(inicioDoDisparo({ nos: [
    { id: "inicio", tipo: "inicio", dados: { gatilho: { tipo: "etiqueta", tag_id: "x" } } },
    { id: "g2", tipo: "inicio", dados: { gatilho: { tipo: "manual" } } } ] }), "g2");
  assert.equal(inicioDoDisparo({ nos: [{ id: "inicio", tipo: "inicio", dados: {} }] }), "inicio");

  caso("Dez gatilhos no máximo, e o último não sai");
  const onze = { nos: Array.from({ length: 11 }, (_, i) => ({ id: i ? "g" + i : "inicio", tipo: "inicio", x: 0, y: i * 200, dados: {} })), ligacoes: [] };
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: onze });
  assert.equal(r.status, 400);
  r = await chamar(tGestora, `/marketing/fluxos/${sob}`, "PUT", { grafo: { nos: [msg("m1", "x")], ligacoes: [] } });
  assert.equal(r.status, 400);
  assert.match(r.d.error, /pelo menos um gatilho/);

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.message);
  process.exitCode = 1;
} finally {
  mock.close();
  process.exit(process.exitCode || 0);
}
