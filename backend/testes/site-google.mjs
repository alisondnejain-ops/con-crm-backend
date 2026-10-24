/* SITE NO GOOGLE (16/10/2026) — verificação do Search Console, nome da marca,
   título do imóvel com o lugar e texto das fotos.

   O código do Google entra em TODA página do site, em todo modelo — é com ele
   que a imobiliária prova ao Google que o site é dela. E ele é conferido por
   formato: colar a etiqueta inteira funciona, colar HTML qualquer não.

   Rodar:  npm run teste:site-google
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-site-google.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4741;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);
const CODIGO = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

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
  db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run("Verônica Gomez", org);
  const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, "Gestora", "gestor@google.com", senha, "adm", Date.now());
  const token = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "gestor@google.com", password: "123456" }) })).json()).token;
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const send = async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const pagina = async (p) => { const r = await fetch(url(p), { redirect: "manual" }); return { status: r.status, local: r.headers.get("location"), html: await r.text() }; };

  let r = await send("PATCH", "/site", { ligado: true, whatsapp: "(82) 99911-2222" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const slug = r.body.slug;

  caso("A tela devolve o endereço para cadastrar no Search Console e o mapa do site");
  assert.ok(r.body.google_endereco.endsWith(`/imoveis/${slug}/`), r.body.google_endereco);
  assert.ok(r.body.google_sitemap.endsWith(`/imoveis/${slug}/sitemap.xml`), r.body.google_sitemap);

  caso("Colar a etiqueta inteira do Google guarda só o código");
  r = await send("PATCH", "/site", { google_verificacao: `<meta name="google-site-verification" content="${CODIGO}" />` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.google_verificacao, CODIGO);

  caso("HTML qualquer ou código fora do formato é recusado — nada entra na página");
  r = await send("PATCH", "/site", { google_verificacao: `<script>alert(1)</script>` });
  assert.equal(r.status, 400);
  r = await send("PATCH", "/site", { google_verificacao: `<meta name="google-site-verification" content="abc"><script>x</script>" />` });
  assert.equal(r.status, 400);
  r = await send("PATCH", "/site", { google_verificacao: `curto` });
  assert.equal(r.status, 400);
  assert.equal((await send("GET", "/site")).body.google_verificacao, CODIGO, "a recusa não pode apagar o código salvo");

  caso("O código está na página inicial do site — no endereço exato que o Google confere (com a barra no fim)");
  for (const p of [`/imoveis/${slug}`, `/imoveis/${slug}/`]) {
    const pg = await pagina(p);
    assert.equal(pg.status, 200, p);
    assert.ok(pg.html.includes(`<meta name="google-site-verification" content="${CODIGO}">`), p);
  }

  caso("Sem nome da marca, o site usa o nome da conta");
  assert.match((await pagina(`/imoveis/${slug}`)).html, /<title>Verônica Gomez/);

  caso("Com o nome da marca, o site inteiro diz a marca — título, topo, dados do Google e mensagem do WhatsApp");
  r = await send("PATCH", "/site", { nome_site: "  VJ   Imóveis " });
  assert.equal(r.body.nome_site, "VJ Imóveis");
  let pg = await pagina(`/imoveis/${slug}`);
  assert.match(pg.html, /<title>VJ Imóveis/);
  assert.match(pg.html, /"@type":"RealEstateAgent","name":"VJ Imóveis"/);
  assert.ok(pg.html.includes(encodeURIComponent("Vim pelo site da VJ Imóveis")), "a mensagem pronta do WhatsApp diz a marca");
  assert.ok(!pg.html.includes("Verônica Gomez"), "o nome da conta não aparece mais no site");
  r = await send("PATCH", "/site", { nome_site: "x".repeat(61) });
  assert.equal(r.status, 400);

  caso("Imóvel: o título leva o lugar quando o nome não diz, e a marca no fim");
  const prod = (await send("POST", "/produtos", { tipo: "casa", formato: "solta", titulo: "Studio Pé na Areia", cidade: "Japaratinga", uf: "AL",
    bairro: "Barreiras do Boqueirão", valor: 420000, quartos: 1, descricao: "Studio a poucos passos do mar, mobiliado e pronto para morar ou alugar." })).body;
  assert.ok(prod.id, JSON.stringify(prod));
  db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,ordem,created_at) VALUES (?,?,?,?,0,?)")
    .run("m_" + randomUUID(), prod.id, "foto", "https://cdn.exemplo.com/studio1.jpg", Date.now());
  db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,ordem,created_at) VALUES (?,?,?,?,1,?)")
    .run("m_" + randomUUID(), prod.id, "foto", "https://cdn.exemplo.com/studio2.jpg", Date.now());
  const caminho = `/imoveis/${slug}/${prod.id}/studio-pe-na-areia`;
  pg = await pagina(caminho);
  assert.equal(pg.status, 200, pg.local || "");
  assert.match(pg.html, /<title>Studio Pé na Areia \| Barreiras do Boqueirão, Japaratinga \| VJ Imóveis<\/title>/);
  assert.ok(pg.html.includes(`content="${CODIGO}"`), "o código também está na página do imóvel");

  caso("O nome que já diz o lugar não repete o lugar");
  const outro = (await send("POST", "/produtos", { tipo: "casa", formato: "solta", titulo: "Villa Camboa Japaratinga", cidade: "Japaratinga", uf: "AL", valor: 900000 })).body;
  pg = await pagina(`/imoveis/${slug}/${outro.id}/villa-camboa-japaratinga`);
  assert.match(pg.html, /<title>Villa Camboa Japaratinga \| VJ Imóveis<\/title>/);

  caso("As fotos têm texto para o Google: nome, lugar, tipo e qual foto é");
  pg = await pagina(caminho);
  assert.ok(pg.html.includes('alt="Studio Pé na Areia em Barreiras do Boqueirão, Japaratinga — imóvel à venda, foto 2 de 2"'), "alt da galeria");
  assert.ok((await pagina(`/imoveis/${slug}`)).html.includes('alt="Studio Pé na Areia em Barreiras do Boqueirão, Japaratinga — imóvel à venda"'), "alt do cartão");

  caso("Os dados do imóvel para o Google trazem cidade e estado — e só o que a página já mostra");
  assert.match(pg.html, /"addressLocality":"Japaratinga","addressRegion":"AL","addressCountry":"BR"/);

  caso("Os modelos do Cetrolab também levam o código, a marca e o título novo");
  for (const m of ["institucional", "bairros", "editorial", "lancamento"]) {
    const ini = await pagina(`/imoveis/${slug}?previa=${m}`);
    assert.ok(ini.html.includes(`content="${CODIGO}"`), `código na inicial (${m})`);
    assert.ok(!ini.html.includes("Verônica Gomez"), `marca (${m})`);
    const im = await pagina(`${caminho}?previa=${m}`);
    assert.match(im.html, /<title>Studio Pé na Areia \| Barreiras do Boqueirão, Japaratinga \| VJ Imóveis<\/title>/, m);
    assert.ok(im.html.includes(`content="${CODIGO}"`), `código no imóvel (${m})`);
  }

  caso("O mapa do site lista cada imóvel");
  const mapa = await (await fetch(url(`/imoveis/${slug}/sitemap.xml`))).text();
  assert.ok(mapa.includes(`/imoveis/${slug}/${prod.id}/studio-pe-na-areia`), mapa);

  caso("Apagar o código tira a etiqueta do site");
  await send("PATCH", "/site", { google_verificacao: "" });
  assert.ok(!(await pagina(`/imoveis/${slug}`)).html.includes("google-site-verification"));

  console.log("\nTudo certo.");
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(saida.slice(-3000));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
