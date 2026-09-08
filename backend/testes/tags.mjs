/* TAGS DO LEAD (08/09/2026).

   A marcação livre que faltava — e a peça de que o motor de automação vai
   depender depois ("ao entrar nesta etapa, marque X").

   O que este teste tranca:

   1. QUEM CRIA x QUEM MARCA são permissões diferentes de propósito. Criar tag
      é inventar vocabulário da casa e é da supervisão; marcar num lead é de
      quem atende aquele lead, senão o corretor teria que pedir para a gestão
      marcar o que ele acabou de descobrir na ligação;
   2. tag de OUTRA imobiliária não cola num lead daqui, nem conhecendo o id —
      ela apareceria na tela sem existir na lista da casa, e ninguém
      conseguiria tirá-la;
   3. nome repetido é recusado sem olhar maiúscula nem acento, senão
      "Investidor", "investidor" e "investidor " viram três tags;
   4. apagar tag em uso EXIGE confirmação, e a primeira resposta diz em
      quantos leads ela está — apagar em silêncio tiraria a marca de todos;
   5. renomear NÃO desfaz a marcação: o lead aponta para o id, não para o nome;
   6. as tags chegam junto na leitura do lead e na LISTA, porque é o card do
      funil e a ficha que precisam delas.

   Rodar:  npm run teste:tags
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-tags.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4633";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4633";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const criarOrg = (nome, codigo) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, nome, codigo, Date.now());
  return id; };
const criarUser = (org, nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, email, senha, role, Date.now());
  return id; };

const org = criarOrg("Conecta", "TAG-1");
const outraCasa = criarOrg("Place Imóveis", "TAG-2");
const ali = criarUser(org, "Ali", "ali@tag.com", "adm");
const marina = criarUser(org, "Marina", "marina@tag.com", "corretor");
const rafael = criarUser(org, "Rafael", "rafael@tag.com", "corretor");
const vizinho = criarUser(outraCasa, "Vizinho", "vizinho@tag.com", "adm");

const lead = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Atendimento',?,?)`).run(lead, org, "Jhennyfer", "5587911110000", marina, Date.now());

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const tAli = await entrar("ali@tag.com"), tMarina = await entrar("marina@tag.com"),
      tRafael = await entrar("rafael@tag.com"), tVizinho = await entrar("vizinho@tag.com");

console.log("===== A DEFINIÇÃO É DA GESTÃO =====");
console.log("1. O gestor cria uma tag");
let r = await chamar(tAli, "/tags", { method: "POST", body: JSON.stringify({ nome: "Investidor", cor: "#0E8F6E" }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.tag?.nome} (${d.tag?.cor})`);
assert.equal(r.status, 200);
const tagInvestidor = d.tag.id;

console.log("2. O CORRETOR não cria — tag é vocabulário da casa");
r = await chamar(tMarina, "/tags", { method: "POST", body: JSON.stringify({ nome: "Meu jeito", cor: "#2563EB" }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 403);

console.log("3. Mas ele LÊ a lista — precisa dela para marcar e filtrar");
r = await chamar(tMarina, "/tags");
d = await r.json();
console.log(`   ${r.status} · ${d.tags.length} tag(s) · ${d.cores.length} cores na paleta`);
assert.equal(r.status, 200);
assert.equal(d.tags.length, 1);
assert.ok(d.cores.length >= 5, "a tela precisa da paleta para desenhar o seletor");

console.log("4. Nome repetido é recusado — sem olhar maiúscula nem acento");
for (const nome of ["Investidor", "investidor", "  INVESTIDOR  "]) {
  r = await chamar(tAli, "/tags", { method: "POST", body: JSON.stringify({ nome, cor: "#D97706" }) });
  d = await r.json();
  console.log(`   "${nome}" → ${r.status} · ${d.error}`);
  assert.equal(r.status, 400);
  assert.ok(/já existe uma tag/i.test(d.error || ""), "a recusa diz qual tag já existe");
}
r = await chamar(tAli, "/tags", { method: "POST", body: JSON.stringify({ nome: "Indicação", cor: "#D97706" }) });
const tagIndicacao = (await r.json()).tag.id;
r = await chamar(tAli, "/tags", { method: "POST", body: JSON.stringify({ nome: "indicacao", cor: "#7C3AED" }) });
console.log(`   "indicacao" contra "Indicação" → ${r.status}`);
assert.equal(r.status, 400, "sem acento é a mesma palavra");

console.log("5. Cor fora da paleta é recusada");
r = await chamar(tAli, "/tags", { method: "POST", body: JSON.stringify({ nome: "Amarelo claro", cor: "#FFFF00" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
/* A frase TEM que chegar em `error`. O serviço fala português (`erro`) e o
   navegador lê `error`: sem a tradução na rota, toda recusa aparecia na tela
   como "erro ao falar com o servidor" e a mensagem escrita com cuidado morria
   no caminho. Este assert é o que impede isso de voltar calado. */
assert.ok(/cores da lista/i.test(d.error || ""), "a recusa precisa chegar em `error`, legível: " + JSON.stringify(d));

console.log("\n===== A MARCAÇÃO É DE QUEM ATENDE =====");
console.log("6. A corretora dona do lead marca sozinha");
r = await chamar(tMarina, `/leads/${lead}/tags/${tagInvestidor}`, { method: "POST" });
d = await r.json();
console.log(`   ${r.status} · ${d.tags.map(t => t.nome).join(", ")}`);
assert.equal(r.status, 200);
assert.equal(d.tags.length, 1);

console.log("7. A gestão também marca, num lead que já é do corretor");
r = await chamar(tAli, `/leads/${lead}/tags/${tagIndicacao}`, { method: "POST" });
d = await r.json();
console.log(`   ${r.status} · ${d.tags.map(t => t.nome).join(", ")}`);
assert.equal(d.tags.length, 2);

console.log("8. Marcar duas vezes a mesma tag não duplica");
await chamar(tMarina, `/leads/${lead}/tags/${tagInvestidor}`, { method: "POST" });
d = await (await chamar(tMarina, `/leads/${lead}/tags/${tagInvestidor}`, { method: "POST" })).json();
console.log(`   continua com ${d.tags.length}`);
assert.equal(d.tags.length, 2);

console.log("9. Quem NÃO tem o lead não marca nada nele");
r = await chamar(tRafael, `/leads/${lead}/tags/${tagInvestidor}`, { method: "POST" });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("10. Tag de OUTRA imobiliária não cola aqui, nem sabendo o id");
r = await chamar(tVizinho, "/tags", { method: "POST", body: JSON.stringify({ nome: "Da outra casa", cor: "#0891B2" }) });
const tagAlheia = (await r.json()).tag.id;
r = await chamar(tAli, `/leads/${lead}/tags/${tagAlheia}`, { method: "POST" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);
assert.ok(/não é desta imobiliária/i.test(d.error || ""), "e diz por quê");

console.log("11. E a lista de uma casa não mostra a tag da outra");
d = await (await chamar(tVizinho, "/tags")).json();
console.log(`   a vizinha vê ${d.tags.length}: ${d.tags.map(t => t.nome).join(", ")}`);
assert.equal(d.tags.length, 1);

console.log("\n===== A LEITURA DO LEAD =====");
console.log("12. As tags chegam JUNTO na ficha do lead");
d = await (await chamar(tMarina, `/leads/${lead}`)).json();
console.log(`   ${d.tags.map(t => `${t.nome}(${t.cor})`).join(" · ")}`);
assert.equal(d.tags.length, 2);
assert.ok(d.tags.every(t => t.nome && t.cor), "o card precisa de nome e cor");

console.log("13. E na LISTA, que é o que o card do funil desenha");
d = await (await chamar(tMarina, "/leads")).json();
const naLista = d.find(l => l.id === lead);
console.log(`   o lead na lista veio com ${naLista.tags.length} tag(s)`);
assert.equal(naLista.tags.length, 2);

console.log("\n===== RENOMEAR E APAGAR =====");
console.log("14. Renomear NÃO desfaz a marcação — o lead aponta para o id");
r = await chamar(tAli, `/tags/${tagInvestidor}`, { method: "PATCH", body: JSON.stringify({ nome: "Investidor PJ" }) });
assert.equal(r.status, 200);
d = await (await chamar(tMarina, `/leads/${lead}`)).json();
console.log(`   ${d.tags.map(t => t.nome).join(", ")}`);
assert.ok(d.tags.some(t => t.nome === "Investidor PJ"), "o nome novo aparece no lead, sem varredura");
assert.equal(d.tags.length, 2);

console.log("15. Apagar tag EM USO pede confirmação, e diz em quantos leads está");
r = await chamar(tAli, `/tags/${tagInvestidor}`, { method: "DELETE" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.equal(d.leads, 1);
assert.ok(/est[áa] em 1 lead/i.test(d.error || ""), "a tela precisa do número na frase: " + JSON.stringify(d));
d = await (await chamar(tMarina, `/leads/${lead}`)).json();
assert.equal(d.tags.length, 2, "nada foi apagado no pedido sem confirmação");

console.log("16. Confirmando, some da lista e sai dos leads");
r = await chamar(tAli, `/tags/${tagInvestidor}?confirmar=1`, { method: "DELETE" });
console.log(`   ${r.status} · apagada: ${(await r.json()).apagada}`);
assert.equal(r.status, 200);
d = await (await chamar(tMarina, `/leads/${lead}`)).json();
console.log(`   sobrou no lead: ${d.tags.map(t => t.nome).join(", ") || "nada"}`);
assert.equal(d.tags.length, 1);

console.log("17. O corretor não apaga tag");
r = await chamar(tMarina, `/tags/${tagIndicacao}?confirmar=1`, { method: "DELETE" });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("18. Desmarcar tira só daquele lead, a tag continua existindo");
r = await chamar(tMarina, `/leads/${lead}/tags/${tagIndicacao}`, { method: "DELETE" });
d = await r.json();
console.log(`   lead ficou com ${d.tags.length}`);
assert.equal(d.tags.length, 0);
d = await (await chamar(tAli, "/tags")).json();
assert.ok(d.tags.some(t => t.id === tagIndicacao), "a tag continua na lista da casa");

console.log("19. Sem login não passa nada");
for (const [caminho, opts] of [["/tags", {}], ["/tags", { method: "POST" }], [`/leads/${lead}/tags/${tagIndicacao}`, { method: "POST" }]]) {
  const resp = await fetch(BASE + caminho, opts);
  console.log(`   ${opts.method || "GET"} ${caminho.split("/").slice(0, 3).join("/")} → ${resp.status}`);
  assert.equal(resp.status, 401);
}

console.log("\nTudo certo ✅");
process.exit(0);
