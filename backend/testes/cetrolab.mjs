/* CETROLAB — a ferramenta de sites (12/10/2026).

   O que este teste prova, com o servidor inteiro de pé e o HTML lido como o
   visitante lê:
     1. o Clássico é de todo mundo; o modelo Bairros pede a ferramenta;
     2. sem plano cadastrado pelo master, a ferramenta não se vende;
     3. o master cadastra o preço (um só ativo para clientes) e libera a conta;
     4. o site no modelo Bairros: os bairros do catálogo com o menor preço,
        e a mesma lista branca do imóvel (nada interno vaza);
     5. a prévia mostra outro modelo sem trocar o site no ar, e não entra no Google;
     6. sem a ferramenta, o site não cai: volta ao Clássico sozinho;
     7. os planos de quem não é cliente saem em /publico/cetrolab/planos.

   Rodar:  npm run teste:cetrolab
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-cetrolab.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4761;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CETRO-1", APP_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await new Promise((x) => setTimeout(x, 250));
  }
  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
  db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run("Rota Imóveis", org);
  const usuario = (email, role, master = 0) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master) VALUES (?,?,?,?,?,?,1,?,'ativo',?)`)
      .run(id, org, email.split("@")[0], email, senha, role, Date.now(), master);
    return id;
  };
  usuario("gestor@cetro.com", "adm");
  usuario("master@cetro.com", "adm", 1);
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    return {
      get: async (p) => { const r = await fetch(url(p), { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
      send: async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    };
  };
  const gestor = await como("gestor@cetro.com");
  const master = await como("master@cetro.com");
  const pagina = async (p) => { const r = await fetch(url(p)); return { status: r.status, html: await r.text() }; };
  const imovel = (dados) => {
    const id = "p_" + randomUUID();
    db.prepare(`INSERT INTO produtos (id,org_id,tipo,finalidade,titulo,cidade,bairro,valor,quartos,construtor,comissao_pct,observacoes,status,created_by,created_at)
      VALUES (@id,@org,'casa',@finalidade,@titulo,'Petrolina',@bairro,@valor,2,'Construtora Segredo',6,'dono aceita 10% abaixo','ativo','x',@agora)`)
      .run({ id, org, agora: Date.now(), finalidade: "venda", ...dados });
    return id;
  };
  imovel({ titulo: "Apartamento na Orla", bairro: "Orla", valor: 320000 });
  imovel({ titulo: "Cobertura na Orla", bairro: "Orla", valor: 590000 });
  imovel({ titulo: "Studio na Orla", bairro: "Orla", valor: 1800, finalidade: "aluguel" });
  const casaCentro = imovel({ titulo: "Casa no Centro", bairro: "Centro", valor: 410000 });
  await gestor.send("PATCH", "/site", { ligado: true, whatsapp: "(87) 99999-0000" });

  caso("Os dois modelos aparecem; o Clássico está no ar e o Bairros pede o Cetrolab");
  let s = (await gestor.get("/site")).body;
  assert.equal(s.modelo_no_ar, "classico");
  assert.deepEqual(s.modelos.map(m => [m.id, m.disponivel]), [["classico", true], ["bairros", false]]);
  assert.equal(s.cetrolab.ativo, false);
  assert.equal(s.cetrolab_plano, null);

  caso("Escolher o Bairros sem a ferramenta é recusado, com o motivo");
  let r = await gestor.send("POST", "/site/modelo", { modelo: "bairros" });
  console.log(`   ${r.status} · ${r.body.error}`);
  assert.equal(r.status, 402);
  assert.match(r.body.error, /Cetrolab/);

  caso("Sem plano cadastrado, a ferramenta não se vende");
  r = await gestor.send("POST", "/assinatura/recursos/cetrolab", {});
  console.log(`   ${r.status} · ${r.body.error}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /não está à venda/);

  caso("Planos: só o master cadastra, e o preço para clientes é um só ativo");
  assert.equal((await gestor.send("POST", "/orgs/cetrolab/planos", { nome: "X", valor_mensal: 10, para: "conhub" })).status, 403);
  r = await master.send("POST", "/orgs/cetrolab/planos", { nome: "Cetrolab", valor_mensal: "79,90", para: "conhub" });
  assert.equal(r.status, 200);
  assert.equal(r.body.valor_mensal, 79.9);
  r = await master.send("POST", "/orgs/cetrolab/planos", { nome: "Outro", valor_mensal: 99, para: "conhub" });
  assert.equal(r.status, 409, "dois preços ativos para clientes seriam uma escolha que ninguém faz");
  r = await master.send("POST", "/orgs/cetrolab/planos", { nome: "Só o site", valor_mensal: 129, para: "fora", resumo: "Site com domínio" });
  assert.equal(r.status, 200);
  assert.equal((await master.send("POST", "/orgs/cetrolab/planos", { nome: "Sem valor", para: "fora" })).status, 400);
  s = (await gestor.get("/site")).body;
  assert.equal(s.cetrolab_plano.valor_mensal, 79.9);
  assert.equal(s.cetrolab.preco_avulso, 79.9);

  caso("Os planos de quem não é cliente saem na rota pública (sem os de clientes)");
  r = await fetch(url("/publico/cetrolab/planos")).then(x => x.json());
  assert.deepEqual(r.planos.map(p => [p.nome, p.valor_mensal]), [["Só o site", 129]]);

  caso("Prévia: o Bairros aparece sem trocar o site, com a faixa e sem entrar no Google");
  let p = await pagina("/imoveis/rota-imoveis?previa=bairros");
  assert.equal(p.status, 200);
  assert.match(p.html, /PRÉVIA DO MODELO/);
  assert.match(p.html, /noindex/);
  assert.match(p.html, /EXPLORE POR BAIRRO/);
  p = await pagina("/imoveis/rota-imoveis");
  assert.doesNotMatch(p.html, /EXPLORE POR BAIRRO/, "o site no ar continua no Clássico");

  caso("O master libera o Cetrolab; o gestor escolhe o Bairros e ele vai ao ar");
  assert.equal((await master.send("POST", `/orgs/${org}/recursos/cetrolab`, { estado: "liberado" })).status, 200);
  r = await gestor.send("POST", "/site/modelo", { modelo: "bairros" });
  assert.equal(r.status, 200);
  assert.equal(r.body.modelo_no_ar, "bairros");
  p = await pagina("/imoveis/rota-imoveis");
  assert.match(p.html, /EXPLORE POR BAIRRO/);
  assert.doesNotMatch(p.html, /PRÉVIA DO MODELO/);
  assert.match(p.html, /Site por Cetrolab/);

  caso("Os bairros vêm do catálogo, com quantos e o menor preço de cada um");
  assert.match(p.html, /Orla<b>3<\/b>/);
  assert.match(p.html, /Centro<b>1<\/b>/);
  p = await pagina("/imoveis/rota-imoveis?bairro=Orla");
  assert.match(p.html, /R\$\s?320\.000/, "compra desde: o menor preço de venda da Orla");
  assert.match(p.html, /R\$\s?1\.800/, "aluguel desde");
  assert.doesNotMatch(p.html, /Casa no Centro/, "o bairro escolhido filtra a lista");

  caso("A página do imóvel no Bairros não vaza nada interno");
  p = await pagina(`/imoveis/rota-imoveis/${casaCentro}/casa-no-centro`);
  assert.equal(p.status, 200);
  assert.match(p.html, /Casa no Centro/);
  assert.match(p.html, /wa\.me\/5587999990000/);
  for (const proibido of ["Construtora Segredo", "dono aceita", "comissao", "captador"])
    assert.ok(!p.html.includes(proibido), `"${proibido}" não pode aparecer no site`);

  caso("Título com HTML sai escapado no modelo Bairros");
  imovel({ titulo: "<script>alert(1)</script>", bairro: "Orla", valor: 100000 });
  p = await pagina("/imoveis/rota-imoveis?bairro=Orla");
  assert.ok(!p.html.includes("<script>alert(1)"), "título não pode virar código na página");

  caso("Sem a ferramenta, o site NÃO cai: volta ao Clássico, e a escolha fica guardada");
  assert.equal((await master.send("POST", `/orgs/${org}/recursos/cetrolab`, { estado: "retirado" })).status, 200);
  p = await pagina("/imoveis/rota-imoveis");
  assert.equal(p.status, 200);
  assert.doesNotMatch(p.html, /EXPLORE POR BAIRRO/);
  s = (await gestor.get("/site")).body;
  assert.equal(s.modelo, "bairros");
  assert.equal(s.modelo_no_ar, "classico");
  await master.send("POST", `/orgs/${org}/recursos/cetrolab`, { estado: null });

  caso("Voltar ao Clássico é sempre permitido");
  r = await gestor.send("POST", "/site/modelo", { modelo: "classico" });
  assert.equal(r.status, 200);
  assert.equal(r.body.modelo, "classico");
  assert.equal((await gestor.send("POST", "/site/modelo", { modelo: "inexistente" })).status, 400);

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
