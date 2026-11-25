/* A FICHA DO IMÓVEL PARA QUALQUER ESTADO (25/11/2026, pedido do Ali: a ficha
   estava presa a Pernambuco — "o Morar Bem só existe em Pernambuco").

   O que este teste confere, com o servidor de pé:
   1. A ficha completa grava e volta: condições de pagamento, programa local,
      características, detalhes, cômodos e áreas novos. Chave fora da lista é
      jogada fora, nunca gravada.
   2. `modalidade` passa a ser o TEXTO montado (site, IA e mensagem leem dele).
   3. Proprietário e telefone só para a gestão, quem cadastrou e quem captou.
   4. A divisão da comissão é da conta (e do imóvel) — sem padrão, não há divisão.
   5. Filtro por condição de pagamento.
   6. A mensagem do imóvel leva os destaques e a descrição, nunca o interno.
   7. O site recebe as características, sem a documentação.
   8. Recusas: ano, link sem https, parte do corretor fora de 0–100.
   9. A cópia das modalidades antigas (Morar Bem PE → programa local).

   Rodar:  npm run teste:ficha-imovel */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-ficha-imovel.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4661";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { textoDoProduto } = await import("../src/routes/messages.routes.js");
const { publico } = await import("../src/services/site.js");
const BASE = "http://localhost:4661";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Sul", "FI-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const mk = (nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, nome, email, senha, role, Date.now()); return id; };
mk("Gestora", "gestora@fi.com", "adm");
const captadora = mk("Marina", "marina@fi.com", "corretor");
mk("Bruno", "bruno@fi.com", "corretor");

const login = async (email) => { const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) }); const { token } = await r.json(); assert.ok(token); return token; };
const comToken = (t) => (p, opts = {}) => fetch(`${BASE}/produtos${p}`, { ...opts,
  headers: { authorization: "Bearer " + t, "content-type": "application/json" } }).then(async r => ({ status: r.status, body: await r.json() }));
const gestora = comToken(await login("gestora@fi.com"));
const bruno = comToken(await login("bruno@fi.com"));

console.log("1. Ficha completa grava e volta; chave fora da lista é descartada");
let r = await gestora("/", { method: "POST", body: JSON.stringify({
  categoria: "apartamento", finalidade: "venda", titulo: "Apartamento Jardins Verona", referencia: "AP01752", cidade: "Vila Velha", uf: "ES",
  bairro: "Praia da Costa", valor: "1.600.000", condominio: 500, iptu: 1200, iptu_periodo: "anual",
  quartos: 3, suites: 1, banheiros: 3, lavabos: 1, salas: 2, vagas: 2, andar: 7, unidade_numero: "701", ano_construcao: 2026,
  area_util: 121.87, area_total: 150,
  pagamentos: ["financiamento", "fgts", "permuta", "inventado"], programa_local: "Entrada Facilitada ES",
  caracteristicas: ["varanda_gourmet", "piscina", "seguranca_24h", "medidor_agua", "nao_existe"],
  detalhes: { ocupacao: "desocupado", posicao: "frente", sol: "manha", documentacao: "registrado", mobilia: "voando" },
  proprietario: "Seu João", proprietario_tel: "(27) 99999-1111", chaves_local: "na imobiliária", exclusividade_ate: "2027-03-01",
  captador_id: captadora, descricao: "Apartamento novo com 3 quartos, varanda gourmet e vista livre, perto da praia.",
  observacoes: "dono aceita 10% abaixo", tour_url: "https://tour.exemplo.com/ap701",
}) });
assert.equal(r.status, 200, JSON.stringify(r.body));
const ap = r.body;
assert.deepEqual(ap.pagamentos, ["financiamento", "fgts", "permuta"]);
assert.deepEqual(ap.caracteristicas, ["varanda_gourmet", "piscina", "seguranca_24h", "medidor_agua"]);
assert.deepEqual(ap.detalhes, { ocupacao: "desocupado", posicao: "frente", sol: "manha", documentacao: "registrado" });
assert.equal(ap.andar, 7); assert.equal(ap.lavabos, 1); assert.equal(ap.area_total, 150); assert.equal(ap.referencia, "AP01752");
assert.equal(ap.valor, 1600000);

console.log("2. modalidade = condições de crédito + programa local (permuta fica de fora)");
assert.equal(ap.modalidade, "Financiamento bancário, FGTS, Entrada Facilitada ES");
assert.equal(ap.morar_bem, false);

console.log("3. Proprietário e telefone: a gestão vê, o corretor que não captou não");
assert.equal(ap.proprietario, "Seu João"); assert.equal(ap.proprietario_tel, "(27)99999-1111".replace(/[^\d+]/g, ""));
r = await bruno(`/${ap.id}`);
assert.equal(r.status, 200);
assert.equal(r.body.proprietario, null); assert.equal(r.body.proprietario_tel, null);
assert.equal(r.body.chaves_local, "na imobiliária", "as chaves continuam para a equipe");
r = await bruno("/");
assert.equal(r.body.find(x => x.id === ap.id).proprietario, null, "nem na lista do catálogo");
const marina = comToken(await login("marina@fi.com"));
r = await marina(`/${ap.id}`);
assert.equal(r.body.proprietario, "Seu João", "quem captou vê");

console.log("4. Divisão da comissão: sem padrão da conta, só o total; com padrão, divide");
r = await gestora(`/${ap.id}`, { method: "PATCH", body: JSON.stringify({ comissao_pct: 5 }) });
assert.equal(r.status, 200);
assert.equal(r.body.comissao.total, 80000);
assert.equal(r.body.comissao.split, null, "conta nova não herda os 45/55 da Conecta");
let c = await gestora("/config/comissao", { method: "PATCH", body: JSON.stringify({ corretor_pct: 50 }) });
assert.equal(c.status, 200);
r = await gestora(`/${ap.id}`);
assert.deepEqual(r.body.comissao.split, { corretor: 50, imobiliaria: 50 });
assert.equal(r.body.comissao.corretor, 40000);
r = await gestora(`/${ap.id}`, { method: "PATCH", body: JSON.stringify({ comissao_corretor_pct: 60 }) });
assert.equal(r.body.comissao.split.corretor, 60, "o imóvel pode ter divisão própria");
c = await bruno("/config/comissao", { method: "PATCH", body: JSON.stringify({ corretor_pct: 90 }) });
assert.equal(c.status, 403, "o corretor não define a divisão");
r = await gestora("/opcoes");
assert.equal(r.body.comissao_corretor_padrao, 50);
// Cadastro novo nasce com o padrão da conta.
r = await gestora("/", { method: "POST", body: JSON.stringify({ categoria: "casa", titulo: "Casa MCMV", cidade: "Cariacica", valor: 200000,
  comissao_pct: 4, pagamentos: ["mcmv"] }) });
assert.equal(r.body.comissao_corretor_pct, 50);
const casa = r.body;

console.log("5. Filtro por condição de pagamento");
r = await gestora("/?pagamento=mcmv");
assert.deepEqual(r.body.map(x => x.id), [casa.id]);
r = await gestora("/?pagamento=fgts");
assert.deepEqual(r.body.map(x => x.id), [ap.id]);
r = await gestora("/?q=AP0175");
assert.deepEqual(r.body.map(x => x.id), [ap.id], "a busca acha pelo código de referência");

console.log("6. A mensagem do imóvel: destaques e descrição, nunca o interno");
const linha = db.prepare("SELECT * FROM produtos WHERE id=?").get(ap.id);
const txt = textoDoProduto(linha);
console.log(txt.split("\n").map(l => "   " + l).join("\n"));
assert.ok(txt.includes("Varanda gourmet") && txt.includes("Piscina"), "destaques");
assert.ok(txt.includes("Aceita: Financiamento bancário"), "condições");
assert.ok(txt.includes("Aceita permuta"), "negociação");
assert.ok(txt.includes("varanda gourmet e vista livre"), "a descrição vai");
for (const nao of ["10% abaixo", "Seu João", "99999", "registro", "imobiliária"])
  assert.ok(!txt.toLowerCase().includes(nao.toLowerCase()), `não pode ir: ${nao}`);

console.log("7. O site recebe as características, sem a documentação");
const pub = publico(linha);
assert.ok(pub.caracteristicas.some(g => g.titulo === "Lazer e condomínio" && g.itens.includes("Piscina")));
assert.ok(pub.detalhes.some(d => d.t === "Posição" && d.v === "Frente"));
assert.ok(!JSON.stringify(pub).includes("Escritura"), "documentação é interna");
assert.ok(!JSON.stringify(pub).includes("Seu João") && !JSON.stringify(pub).includes("imobiliária\""), "nada interno");
assert.equal(pub.tour, "https://tour.exemplo.com/ap701");

console.log("8. Recusas");
for (const [corpo, msg] of [[{ ano_construcao: 1500 }, "Ano"], [{ tour_url: "http://x.com" }, "https"], [{ comissao_corretor_pct: 120 }, "0 a 100"], [{ quartos: -2 }, "Quartos"]]) {
  r = await gestora(`/${ap.id}`, { method: "PATCH", body: JSON.stringify(corpo) });
  console.log(`   ${r.status} · ${r.body.error}`);
  assert.equal(r.status, 400); assert.ok(r.body.error.includes(msg));
}

console.log("9. Cópia das modalidades antigas: Morar Bem PE vira programa local, MCMV e SBPE viram condições");
const dbVelho = path.join(os.tmpdir(), "concrm-teste-ficha-velha.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbVelho + s); } catch (e) {} }
const dbJs = new URL("../src/db.js", import.meta.url).href;
const passo1 = `const { default: db } = await import(${JSON.stringify(dbJs)});
  const ins = db.prepare("INSERT INTO produtos (id,org_id,tipo,titulo,modalidade,morar_bem,created_at) VALUES (?,?,?,?,?,?,?)");
  ins.run("p1","o","casa","A","Morar Bem PE",1,1); ins.run("p2","o","casa","B","Minha Casa Minha Vida",0,1); ins.run("p3","o","casa","C","SBPE",0,1);
  db.exec("ALTER TABLE produtos DROP COLUMN pagamentos"); db.close();`;
const passo2 = `const { default: db } = await import(${JSON.stringify(dbJs)});
  console.log(JSON.stringify(db.prepare("SELECT id,pagamentos,programa_local FROM produtos ORDER BY id").all()));`;
const rodar = (codigo) => spawnSync(process.execPath, ["--input-type=module", "-e", codigo],
  { env: { ...process.env, DB_PATH: dbVelho, PORT: "0" }, encoding: "utf8", cwd: path.dirname(fileURLToPath(import.meta.url)) });
let p1 = rodar(passo1); assert.equal(p1.status, 0, p1.stderr);
let p2 = rodar(passo2); assert.equal(p2.status, 0, p2.stderr);
const linhas = JSON.parse(p2.stdout.trim().split("\n").pop());
console.log("   " + JSON.stringify(linhas));
assert.equal(linhas[0].programa_local, "Morar Bem PE");
assert.equal(linhas[1].pagamentos, '["mcmv"]');
assert.equal(linhas[2].pagamentos, '["financiamento"]');

console.log("\nOK — a ficha do imóvel vale para qualquer estado.");
process.exit(0);
