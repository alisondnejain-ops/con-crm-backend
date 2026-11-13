/* IMÓVEIS DO CETRO (capítulo 12, 13/11/2026): tipo de cadastro, estágio,
   moeda, situação "reservado", filtros do catálogo e as UNIDADES com fluxo de
   pagamento — percentuais que fecham em 100%, parcelas com quantidade ≥ 1 e
   valores calculados no servidor. A página pública mostra só as unidades
   disponíveis, sem o fluxo.

   Rodar:  npm run teste:imoveis-cetro
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-imoveis-cetro.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4661";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4661";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome, email, role = "adm") => {
  const org = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, nome, "IC-" + org, Date.now());
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run("u_" + randomUUID(), org, nome + " gestor", email, senha, role, Date.now());
  return org;
};
const orgA = novaOrg("Imob A", "a@ic.com");
novaOrg("Imob B", "b@ic.com");
const login = async (email) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const cli = (token) => (p, opts = {}) => fetch(`${BASE}${p}`, { ...opts, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const A = cli(await login("a@ic.com")), B = cli(await login("b@ic.com"));

console.log("1. Empreendimento em lançamento, preço em dólar: tipo/formato derivados");
let r = await A("/produtos", { method: "POST", body: { categoria: "empreendimento", estagio: "lancamento", moeda: "USD", titulo: "Residencial Mar", cidade: "Maragogi", valor: 150000, area_min: 45, area_max: 120, entrega: "Dez/2027" } });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.categoria, "empreendimento"); assert.equal(r.body.tipo, "casa"); assert.equal(r.body.formato, "empreendimento");
assert.equal(r.body.moeda, "USD"); assert.equal(r.body.estagio, "lancamento"); assert.equal(r.body.area_max, 120);
const emp = r.body.id;

console.log("2. Loteamento vira terreno; apartamento vira casa solta; cadastro antigo (tipo) continua valendo");
r = await A("/produtos", { method: "POST", body: { categoria: "loteamento", titulo: "Loteamento Sol", cidade: "Petrolina" } });
assert.equal(r.body.tipo, "terreno"); const lot = r.body.id;
r = await A("/produtos", { method: "POST", body: { categoria: "apartamento", titulo: "Apto Centro", cidade: "Petrolina", valor: 300000, proprietario: "Seu João" } });
assert.equal(r.body.tipo, "casa"); assert.equal(r.body.formato, "solta"); assert.equal(r.body.proprietario, "Seu João"); const apto = r.body.id;
r = await A("/produtos", { method: "POST", body: { tipo: "terreno", titulo: "Terreno antigo", cidade: "Petrolina" } });
assert.equal(r.body.categoria, "terreno");
r = await A("/produtos", { method: "POST", body: { categoria: "castelo", titulo: "X", cidade: "Y" } });
assert.equal(r.status, 400);
r = await A("/produtos", { method: "POST", body: { categoria: "casa", titulo: "X", cidade: "Y", moeda: "EUR" } });
assert.equal(r.status, 400);

console.log("3. Filtros: categoria, estágio, moeda, área");
const ids = (b) => b.map(p => p.id).sort();
r = await A("/produtos?categoria=empreendimento"); assert.deepEqual(ids(r.body), [emp]);
r = await A("/produtos?estagio=lancamento"); assert.deepEqual(ids(r.body), [emp]);
r = await A("/produtos?moeda=USD"); assert.deepEqual(ids(r.body), [emp]);
r = await A("/produtos?categoria=terreno"); assert.equal(r.body.length, 1, "o terreno antigo entra pela categoria derivada");
r = await A("/produtos?area_min=100"); assert.ok(ids(r.body).includes(emp));

console.log("4. Fluxo que não fecha 100% é recusado; parcela sem quantidade também");
r = await A(`/produtos/${emp}/unidades`, { method: "PUT", body: { unidades: [{ identificacao: "Apto 101", preco: 200000, moeda: "USD", fluxo: { sinal_pct: 10, sinal_qtd: 2, financiar_pct: 80 } }] } });
assert.equal(r.status, 400); assert.match(r.body.error, /90%/);
r = await A(`/produtos/${emp}/unidades`, { method: "PUT", body: { unidades: [{ identificacao: "Apto 101", preco: 200000, fluxo: { mensais_pct: 100 } }] } });
assert.equal(r.status, 400); assert.match(r.body.error, /quantidade/);

console.log("5. Duas unidades salvas, valores calculados pelo servidor");
r = await A(`/produtos/${emp}/unidades`, { method: "PUT", body: { unidades: [
  { identificacao: "Apto 101", bloco: "A", tipologia: "2 quartos", area: 62, preco: 200000, moeda: "USD", fluxo: { sinal_pct: 10, sinal_qtd: 2, mensais_pct: 30, mensais_qtd: 36, chaves_pct: 10, financiar_pct: 50 } },
  { identificacao: "Apto 102", bloco: "A", tipologia: "3 quartos", area: 90, preco: 280000, moeda: "USD", status: "vendido" }] } });
assert.equal(r.status, 200, JSON.stringify(r.body));
const u1 = r.body.unidades[0];
assert.equal(u1.fluxo.sinal.valor, 20000); assert.equal(u1.fluxo.sinal.parcela, 10000);
assert.equal(u1.fluxo.mensais.parcela, 1666.67); assert.equal(u1.fluxo.financiar.valor, 100000);
assert.deepEqual(r.body.resumo, { total: 2, disponiveis: 1, desde: { USD: 200000 } });

console.log("6. Adicionar a próxima mantém o id e o fluxo da anterior");
const atuais = r.body.unidades;
r = await A(`/produtos/${emp}/unidades`, { method: "PUT", body: { unidades: [...atuais, { identificacao: "Apto 103", preco: 210000, moeda: "USD" }] } });
assert.equal(r.body.unidades.length, 3); assert.equal(r.body.unidades[0].id, u1.id); assert.equal(r.body.unidades[0].fluxo.sinal.pct, 10);

console.log("7. Unidade repetida no mesmo bloco é recusada; imóvel comum não tem unidades");
r = await A(`/produtos/${emp}/unidades`, { method: "PUT", body: { unidades: [{ identificacao: "Apto 1", bloco: "A" }, { identificacao: "apto 1", bloco: "a" }] } });
assert.equal(r.status, 400);
r = await A(`/produtos/${apto}/unidades`, { method: "PUT", body: { unidades: [{ identificacao: "X" }] } });
assert.equal(r.status, 409);
r = await A(`/produtos/${lot}/unidades`, { method: "PUT", body: { unidades: [{ identificacao: "Lote 12", bloco: "Quadra 3", area: 300, preco: 90000 }] } });
assert.equal(r.status, 200);

console.log("8. Outra imobiliária não lê nem grava as unidades");
r = await B(`/produtos/${emp}/unidades`); assert.equal(r.status, 404);
r = await B(`/produtos/${emp}/unidades`, { method: "PUT", body: { unidades: [] } }); assert.equal(r.status, 404);

console.log("9. Reservado: situação da supervisão, sai de 'só disponíveis'");
r = await A(`/produtos/${apto}/status`, { method: "POST", body: { status: "reservado" } }); assert.equal(r.status, 200);
r = await A("/produtos?disponivel=1"); assert.ok(!ids(r.body).includes(apto));

console.log("10. Página pública: unidades disponíveis em dólar, sem o fluxo nem o proprietário");
db.prepare(`INSERT INTO sites (org_id, slug, ligado, whatsapp, created_at) VALUES (?,?,1,?,?)`).run(orgA, "imob-a", "5587999990000", Date.now());
const { caminhoDoImovel } = await import("../src/services/site.js");
const pAtual = db.prepare("SELECT * FROM produtos WHERE id=?").get(emp);
const html = await (await fetch(BASE + caminhoDoImovel(orgA, pAtual))).text();
assert.match(html, /Unidades disponíveis/); assert.match(html, /Apto 101/); assert.match(html, /US\$/);
assert.doesNotMatch(html, /Apto 102/, "a vendida não aparece");
assert.doesNotMatch(html, /Sinal|financiar/i, "o fluxo não vai ao site");
const htmlApto = await (await fetch(BASE + caminhoDoImovel(orgA, db.prepare("SELECT * FROM produtos WHERE id=?").get(apto)))).text();
assert.doesNotMatch(htmlApto, /Seu João/);

console.log("\nOK — imóveis do CETRO.");
process.exit(0);
