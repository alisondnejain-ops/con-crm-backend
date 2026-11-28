/* PERMISSÕES: QUEM VÊ QUAIS LEADS (28/11/2026, services/acesso.js).
   Rodar:  npm run teste:escopo-acesso */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-escopo.db");
process.env.JWT_SECRET = "teste"; process.env.PORT = "4671";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4671";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (n) => { const id = "org_" + randomUUID().slice(0, 8); db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, n, "S-" + id, Date.now()); return id; };
const org = novaOrg("Imob S"), outra = novaOrg("Outra");
const novo = (o, nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, o, nome, email, senha, role, Date.now()); return id; };
const ges = novo(org, "Dona", "g@s.com", "adm");
const ger = novo(org, "Gerente", "ger@s.com", "adm");
const ana = novo(org, "Ana", "a@s.com", "corretor");
const bia = novo(org, "Bia", "b@s.com", "corretor");
const caio = novo(org, "Caio", "c@s.com", "corretor");
novo(outra, "X", "x@s.com", "adm");
const lead = (dono, nome) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,assigned_to,stage,created_at,assigned_at) VALUES (?,?,?,?,?,?,?,?)").run(id, org, nome, "55879" + Math.floor(Math.random() * 1e8), dono, "Lead", Date.now(), Date.now()); return id; };
const lAna = lead(ana, "Lead Ana"), lBia = lead(bia, "Lead Bia"), lCaio = lead(caio, "Lead Caio"), lFila = lead(null, "Lead Fila");
const login = async (e) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "123456" }) })).json()).token;
const cli = (t) => (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const G = cli(await login("g@s.com")), GER = cli(await login("ger@s.com")), A = cli(await login("a@s.com")), X = cli(await login("x@s.com"));
const nomes = (b) => (Array.isArray(b) ? b : b.leads).map(l => l.name).sort();
const esperar = () => new Promise(r => setTimeout(r, 15100)); // o alcance fica guardado 15s, mas salvar regra limpa
let falhas = 0;
const caso = async (n, f) => { try { await f(); console.log("  ✓ " + n); } catch (e) { falhas++; console.log("  ✗ " + n + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } };
let r, time;

await caso("1. Sem regra, nada muda: gestor vê tudo, corretora só a dela", async () => {
  r = await GER("/leads"); assert.deepEqual(nomes(r.body), ["Lead Ana", "Lead Bia", "Lead Caio", "Lead Fila"]);
  r = await A("/leads"); assert.deepEqual(nomes(r.body), ["Lead Ana"]);
  r = await A(`/leads/${lBia}`); assert.equal(r.status, 403);
});
await caso("2. Nível com responsável e integrantes", async () => {
  r = await G("/estrutura/niveis", { method: "POST", body: { nome: "Time Alpha", tipo: "equipe", responsavel_id: ger, integrantes: [ana, bia] } });
  assert.equal(r.status, 200); time = r.body.id;
  const n = r.body.niveis.find(x => x.id === time);
  assert.equal(n.responsavel_id, ger); assert.deepEqual(n.membros.sort(), [ana, bia].sort());
  // Editar sem mandar responsável não apaga o responsável.
  r = await G(`/estrutura/niveis/${time}`, { method: "PATCH", body: { nome: "Time Alpha", tipo: "equipe" } });
  assert.equal(r.body.niveis.find(x => x.id === time).responsavel_id, ger);
});
await caso("3. Regra de grupo: o responsável vê só os leads da equipe dele", async () => {
  r = await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "nivel", alvo_id: time, quem: "responsavel", escopo: "equipe" } });
  assert.equal(r.status, 200);
  r = await GER("/leads"); assert.deepEqual(nomes(r.body), ["Lead Ana", "Lead Bia"]);
  r = await GER(`/leads/${lCaio}`); assert.equal(r.status, 403);
  r = await GER(`/leads/${lAna}`); assert.equal(r.status, 200);
  r = await GER("/reports/score?periodo=este_mes"); assert.ok(r.body.equipe.every(m => [ana, bia, ger].includes(m.id)));
  r = await GER(`/painel/geral?periodo=este_mes&responsavel=${caio}`); assert.equal(r.status, 200);
});
await caso("4. Regra da pessoa: corretora com 'leads da operação' vê tudo, mas a caixa continua dela", async () => {
  r = await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "pessoa", alvo_id: ana, escopo: "operacao" } });
  r = await A("/leads"); assert.deepEqual(nomes(r.body), ["Lead Ana", "Lead Bia", "Lead Caio", "Lead Fila"]);
  r = await A(`/leads/${lCaio}`); assert.equal(r.status, 200);
  // A regra da pessoa vale mais que a do grupo.
  r = await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "nivel", alvo_id: time, quem: "corretor", escopo: "proprio" } });
  r = await A("/leads"); assert.equal(nomes(r.body).length, 4);
});
await caso("5. Grupo por função: corretores do time com 'equipe' veem o time", async () => {
  const lista = (await G("/estrutura/permissoes")).body.regras;
  const daAna = lista.find(x => x.alvo_tipo === "pessoa" && x.alvo_id === ana);
  await G(`/estrutura/permissoes/${daAna.id}`, { method: "DELETE" });
  await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "nivel", alvo_id: time, quem: "corretor", escopo: "equipe" } });
  r = await A("/leads"); assert.deepEqual(nomes(r.body), ["Lead Ana", "Lead Bia"]);
  r = await A(`/leads/${lCaio}`); assert.equal(r.status, 403);
});
await caso("6. Equipes autorizadas escolhidas à mão", async () => {
  r = await G("/estrutura/niveis", { method: "POST", body: { nome: "Time Beta", tipo: "equipe", integrantes: [caio] } });
  const beta = r.body.id;
  await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "nivel", alvo_id: time, quem: "responsavel", escopo: "equipe", equipes: [beta] } });
  r = await GER("/leads"); assert.deepEqual(nomes(r.body), ["Lead Caio"]);
});
await caso("7. Só o gestor grava; outra conta não mexe; escopo inválido recusado", async () => {
  r = await A("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "pessoa", alvo_id: ana, escopo: "operacao" } }); assert.equal(r.status, 403);
  r = await X("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "pessoa", alvo_id: ana, escopo: "operacao" } }); assert.equal(r.status, 404);
  r = await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "pessoa", alvo_id: ana, escopo: "tudo" } }); assert.equal(r.status, 400);
});
await caso("8. Apagar o nível apaga as regras dele, e tudo volta ao de sempre", async () => {
  const beta = (await G("/estrutura")).body.niveis.find(n => n.nome === "Time Beta").id;
  await G(`/estrutura/pessoas/${caio}`, { method: "PATCH", body: { nivel_id: null } });
  await G(`/estrutura/niveis/${beta}`, { method: "DELETE" });
  for (const p of [ana, bia]) await G(`/estrutura/pessoas/${p}`, { method: "PATCH", body: { nivel_id: null } });
  await G(`/estrutura/niveis/${time}`, { method: "DELETE" });
  assert.equal((await G("/estrutura/permissoes")).body.regras.length, 0);
  r = await GER("/leads"); assert.equal(nomes(r.body).length, 4);
  r = await A("/leads"); assert.deepEqual(nomes(r.body), ["Lead Ana"]);
});
await caso("9. Tabela vazia continua sendo o padrão da função", async () => {
  r = await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "pessoa", alvo_id: ana, escopo: null, ferramentas: {} } });
  assert.equal(r.status, 200);
  r = await A("/produtos"); assert.equal(r.status, 200);
  r = await A("/estrutura/meu-alcance"); assert.equal(r.body.ferramentas, null);
});
await caso("10. Tabela salva: o desmarcado é recusado, o marcado passa por cima do papel", async () => {
  const pad = (await G("/estrutura/permissoes")).body.padroes.corretor;
  const t = JSON.parse(JSON.stringify(pad));
  t.imoveis = { consultar: false, criar: false, editar: false, excluir: false };
  t.funil.criar = false;
  t.configuracoes = { consultar: true, editar: true };
  r = await G("/estrutura/permissoes", { method: "PUT", body: { alvo_tipo: "pessoa", alvo_id: ana, ferramentas: t } });
  assert.equal(r.status, 200);
  r = await A("/produtos"); assert.equal(r.status, 403); assert.match(r.body.error, /Imóveis/);
  r = await A("/leads", { method: "POST", body: { name: "Novo", phone: "87999990000" } }); assert.equal(r.status, 403);
  r = await A("/leads"); assert.equal(r.status, 200);
  r = await A("/config/mensagens", { method: "POST", body: { titulo: "Oi", texto: "Olá {nome}" } }); assert.notEqual(r.status, 403);
  r = await A("/estrutura/meu-alcance"); assert.equal(r.body.ferramentas.imoveis.consultar, false);
  // Bia, sem regra, continua igual.
  const B = cli(await login("b@s.com"));
  r = await B("/produtos"); assert.equal(r.status, 200);
  r = await B("/config/mensagens", { method: "POST", body: { titulo: "Oi", texto: "Olá" } }); assert.equal(r.status, 403);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nOK — permissões por escopo.");
process.exit(falhas ? 1 : 0);
