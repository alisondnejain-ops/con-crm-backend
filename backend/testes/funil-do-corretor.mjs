/* O FUNIL DO PAINEL, ABERTO AO CORRETOR — E SÓ O DELE (08/09/2026).

   A rosca "onde estão os leads" aparece no painel do gestor e no relatório
   individual. Para as duas telas serem a MESMA tela, o corretor precisa
   chegar na rota do funil — que até aqui era fechada à supervisão inteira.

   O risco de abrir é um só, e é este teste: o filtro `responsavel` chega pela
   query. Se o servidor confiasse nele, qualquer corretor leria o funil do
   colega trocando um parâmetro no endereço. Por isso quem não supervisiona
   tem o filtro SOBRESCRITO pelo próprio id, e o que ele mandar é descartado.

   O resto do painel (equipe, campanhas, visão geral, opções) continua fechado:
   ali estão os números de todo mundo, e abrir transformaria o CRM num ranking
   público entre colegas.

   Rodar:  npm run teste:funil-do-corretor
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-funil-corretor.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4631";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4631";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "FC-1", Date.now());
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);
const funilId = pipelinePadrao(org).id;

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@fc.com", senha, role, Date.now());
  return id; };
const ali = user("Ali", "adm"), marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");

// Marina com 2 leads em aberto, Rafael com 5. Os números precisam ser
// diferentes: se fossem iguais, o teste passaria mesmo com o filtro furado.
const stages = db.prepare("SELECT id,name FROM pipeline_stages WHERE org_id = ? AND is_active = 1 ORDER BY ordem").all(org);
const etapa = (n) => stages.find(s => s.name === n) || stages[0];
const criar = (dono, etapaNome, i) => db.prepare(
  `INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,pipeline_id,stage_id,assigned_to,created_at)
   VALUES (?,?,?,?,'WhatsApp','{}',?,?,?,?,?)`)
  .run("l_" + randomUUID(), org, `Cliente ${i}`, "55879" + String(10000000 + i), etapaNome,
       funilId, etapa(etapaNome).id, dono, Date.now() - 3600000);
criar(marina, "Atendimento", 1); criar(marina, "Pasta", 2);
[3, 4, 5, 6, 7].forEach(i => criar(rafael, "Atendimento", i));

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@fc.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho) => fetch(BASE + caminho, { headers: { authorization: "Bearer " + token } });
const emAberto = (d) => (d.operacional || []).reduce((s, o) => s + o.leads_agora, 0);

const tAli = await entrar("Ali"), tMarina = await entrar("Marina"), tRafael = await entrar("Rafael");

console.log("1. O gestor vê o funil da casa inteira");
let r = await chamar(tAli, `/painel/funil/${funilId}?periodo=ano`);
let d = await r.json();
console.log(`   ${r.status} · ${emAberto(d)} leads em aberto`);
assert.equal(r.status, 200);
assert.equal(emAberto(d), 7);

console.log("2. E filtra por uma pessoa, de verdade");
d = await (await chamar(tAli, `/painel/funil/${funilId}?periodo=ano&responsavel=${marina}`)).json();
console.log(`   Marina: ${emAberto(d)}`);
assert.equal(emAberto(d), 2);

console.log("3. O CORRETOR agora entra — e vê o funil dele");
r = await chamar(tMarina, `/painel/funil/${funilId}?periodo=ano`);
d = await r.json();
console.log(`   ${r.status} · ${emAberto(d)} leads (os dela)`);
assert.equal(r.status, 200);
assert.equal(emAberto(d), 2, "a Marina tem 2 leads em aberto");

console.log("4. E NÃO vê o do colega, mesmo pedindo pelo endereço");
/* É a trava desta mudança. Sem ela, abrir a rota entregaria o funil de
   qualquer pessoa da casa para quem soubesse trocar um parâmetro. */
d = await (await chamar(tMarina, `/painel/funil/${funilId}?periodo=ano&responsavel=${rafael}`)).json();
console.log(`   pediu o do Rafael (5), recebeu: ${emAberto(d)}`);
assert.equal(emAberto(d), 2, "o responsável mandado pelo corretor é descartado");

console.log("5. Nem o da casa inteira, pedindo a fila");
d = await (await chamar(tMarina, `/painel/funil/${funilId}?periodo=ano&responsavel=fila`)).json();
console.log(`   recebeu: ${emAberto(d)}`);
assert.equal(emAberto(d), 2);

console.log("6. O resto do painel continua fechado para o corretor");
for (const caminho of ["/painel?periodo=ano", "/painel/equipe?periodo=ano", "/painel/campanhas?periodo=ano", "/painel/opcoes"]) {
  const resp = await chamar(tRafael, caminho);
  console.log(`   ${caminho.split("?")[0]} → ${resp.status}`);
  assert.equal(resp.status, 403, `${caminho} deveria continuar fechado`);
}

console.log("7. E sem login não abre nem o funil");
r = await fetch(`${BASE}/painel/funil/${funilId}`);
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("8. O que a rosca desenha vem pronto: etapa, cor e tempo parado");
d = await (await chamar(tMarina, `/painel/funil/${funilId}?periodo=ano`)).json();
const comLead = d.operacional.filter(o => o.leads_agora > 0);
console.log(`   ${comLead.map(o => `${o.name}=${o.leads_agora}`).join(" · ")}`);
assert.ok(comLead.length >= 2, "a Marina está em duas etapas diferentes");
assert.ok(comLead.every(o => o.name && o.color), "cada fatia precisa de nome e cor");
assert.ok(comLead.every(o => o.tempo_mediano_dias !== undefined), "e do tempo mediano, que é o detalhe da fatia");

console.log("\nTudo certo ✅");
process.exit(0);
