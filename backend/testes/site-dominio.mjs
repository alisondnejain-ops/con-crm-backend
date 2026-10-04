/* SITE: DOMÍNIO PRÓPRIO, GOOGLE TAG MANAGER E SEO (04/10/2026).

   Servidor inteiro de pé. O pedido pelo domínio da imobiliária é feito com o
   cabeçalho Host trocado — é exatamente o que chega quando o DNS dela aponta
   para cá. O que se prova:
   - domínio inválido, da plataforma ou repetido em outra conta é recusado;
   - pelo domínio, o site abre na RAIZ, com os links sem "/imoveis/";
   - pelo domínio, o CRM e a API NÃO abrem; e o endereço do ConHub segue igual;
   - Tag Manager e SEO entram na página (e o ID é conferido antes);
   - sitemap e robots;
   - o master anota o destino do DNS e a conferência diz em que passo está;
   - uma imobiliária não mostra imóvel da outra pelo domínio dela.

   Rodar:  npm run teste:site-dominio
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-site-dominio.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4725;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "SITE-DOM-1", APP_URL: "", SITE_DNS_DESTINO: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

// Pedido com outro Host — o fetch do Node não deixa trocar esse cabeçalho.
const peloDominio = (host, p) => new Promise((ok, falha) => {
  const req = http.request({ host: "127.0.0.1", port: PORTA, path: p, method: "GET", headers: { Host: host } }, (res) => {
    let corpo = ""; res.setEncoding("utf8");
    res.on("data", (c) => (corpo += c));
    res.on("end", () => ok({ status: res.statusCode, tipo: res.headers["content-type"] || "", local: res.headers.location, corpo }));
  });
  req.on("error", falha); req.end();
});

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
  db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run("Casa Nova Imóveis", org);
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Outra Casa", "OUTRA-DOM", Date.now());
  const usuario = (o, email, role, master = 0) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master) VALUES (?,?,?,?,?,?,1,?,'ativo',?)`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now(), master);
    return id;
  };
  usuario(org, "gestor@dom.com", "adm");
  usuario(orgB, "gestorb@dom.com", "adm");
  usuario(org, "master@dom.com", "adm", 1);
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    return {
      get: async (p) => { const r = await fetch(url(p), { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
      send: async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    };
  };
  const gestor = await como("gestor@dom.com"), gestorB = await como("gestorb@dom.com"), master = await como("master@dom.com");
  const criar = async (quem, b) => { const x = await quem.send("POST", "/produtos", b); assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };
  const casa = await criar(gestor, { tipo: "casa", formato: "solta", titulo: "Casa com quintal no Centro", cidade: "Petrolina", uf: "PE",
    bairro: "Centro", valor: 320000, quartos: 3, descricao: "Casa ampla </script><b>sem</b> mistério." });
  db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,ordem,created_at) VALUES (?,?,?,?,0,?)")
    .run("m_" + randomUUID(), casa.id, "foto", "https://cdn.exemplo.com/casa.jpg", Date.now());
  const deB = await criar(gestorB, { tipo: "casa", formato: "solta", titulo: "Casa da outra imobiliária", cidade: "Recife" });
  let r = await gestor.send("PATCH", "/site", { ligado: true, whatsapp: "(87) 99911-2233" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await gestorB.send("PATCH", "/site", { ligado: true, whatsapp: "(81) 99911-2233" });
  assert.equal(r.status, 200);

  caso("Domínio inválido, da plataforma ou da hospedagem é recusado");
  for (const ruim of ["não é domínio", "http://", "www.conhubcrm.com.br", "app.conhubcrm.com.br", "abc123.up.railway.app"]) {
    r = await gestor.send("PATCH", "/site", { dominio: ruim });
    assert.equal(r.status, 400, ruim);
  }

  caso("Domínio aceito vira o endereço limpo e espera o ConHub ativar");
  r = await gestor.send("PATCH", "/site", { dominio: "https://WWW.CasaNovaImoveis.test/qualquer/coisa" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dominio, "www.casanovaimoveis.test");
  assert.equal(r.body.dominio_estado, "aguardando_conhub");
  assert.equal(r.body.url_dominio, "https://www.casanovaimoveis.test");

  caso("O mesmo domínio em outra conta é recusado");
  r = await gestorB.send("PATCH", "/site", { dominio: "www.casanovaimoveis.test" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /outra imobiliária/);

  caso("Pelo domínio, o site abre na raiz — com e sem www — e os links não passam por /imoveis/");
  let p = await peloDominio("www.casanovaimoveis.test", "/");
  assert.equal(p.status, 200);
  assert.match(p.corpo, /Casa com quintal no Centro/);
  assert.ok(p.corpo.includes(`href="/${casa.id}/casa-com-quintal-no-centro"`), "link do imóvel na raiz");
  assert.ok(!p.corpo.includes("/imoveis/"), "nenhum link para o endereço do ConHub");
  assert.match(p.corpo, /rel="canonical" href="https:\/\/www\.casanovaimoveis\.test\/"/);
  p = await peloDominio("casanovaimoveis.test", "/");
  assert.equal(p.status, 200);
  p = await peloDominio("www.casanovaimoveis.test", `/${casa.id}/casa-com-quintal-no-centro`);
  assert.equal(p.status, 200);
  assert.match(p.corpo, /Casa com quintal no Centro/);
  p = await peloDominio("www.casanovaimoveis.test", `/${casa.id}`);
  assert.equal(p.status, 301);
  assert.equal(p.local, `/${casa.id}/casa-com-quintal-no-centro`);

  caso("Pelo domínio, o CRM e a API não abrem; o endereço do ConHub continua igual");
  for (const caminho of ["/app", "/leads", "/auth/me", "/integracoes"]) {
    p = await peloDominio("www.casanovaimoveis.test", caminho);
    assert.ok([404, 405].includes(p.status), `${caminho} → ${p.status}`);
    assert.ok(!/ConHub CRM|CON_CRM_API/.test(p.corpo), caminho);
  }
  assert.equal((await fetch(url("/health"))).status, 200);
  assert.equal((await fetch(url("/imoveis/casa-nova-imoveis"))).status, 200);
  assert.equal((await fetch(url("/leads"))).status, 401);

  caso("A marca de conferência responde pelo domínio");
  p = await peloDominio("www.casanovaimoveis.test", "/.well-known/conhub-site");
  assert.equal(p.status, 200);
  assert.match(JSON.parse(p.corpo).site, /^[0-9a-f]{24}$/);

  caso("Uma imobiliária não mostra imóvel da outra pelo domínio dela");
  p = await peloDominio("www.casanovaimoveis.test", `/${deB.id}/casa-da-outra-imobiliaria`);
  assert.equal(p.status, 404);
  assert.ok(!p.corpo.includes("Casa da outra imobiliária"));

  caso("Google Tag Manager: ID conferido antes; entra no topo e no corpo da página");
  r = await gestor.send("PATCH", "/site", { gtm_id: "GTM-'</script>" });
  assert.equal(r.status, 400);
  r = await gestor.send("PATCH", "/site", { gtm_id: "gtm-abc1234" });
  assert.equal(r.status, 200);
  assert.equal(r.body.gtm_id, "GTM-ABC1234");
  p = await peloDominio("www.casanovaimoveis.test", "/");
  assert.ok(p.corpo.includes("googletagmanager.com/gtm.js?id='+i+dl") && p.corpo.includes("'dataLayer','GTM-ABC1234'"));
  assert.ok(p.corpo.includes("googletagmanager.com/ns.html?id=GTM-ABC1234"));

  caso("SEO: título e descrição da página inicial, com teto; dados para o Google em cada página");
  r = await gestor.send("PATCH", "/site", { seo_titulo: "x".repeat(71) });
  assert.equal(r.status, 400);
  r = await gestor.send("PATCH", "/site", { seo_descricao: "x".repeat(161) });
  assert.equal(r.status, 400);
  r = await gestor.send("PATCH", "/site", { seo_titulo: "Casas em Petrolina | Casa Nova", seo_descricao: "Casas e terrenos em Petrolina e Juazeiro." });
  assert.equal(r.status, 200);
  p = await peloDominio("www.casanovaimoveis.test", "/");
  assert.match(p.corpo, /<title>Casas em Petrolina \| Casa Nova<\/title>/);
  assert.match(p.corpo, /<meta name="description" content="Casas e terrenos em Petrolina e Juazeiro.">/);
  assert.match(p.corpo, /"@type":"RealEstateAgent"/);
  p = await peloDominio("www.casanovaimoveis.test", `/${casa.id}/casa-com-quintal-no-centro`);
  const ld = p.corpo.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, "a página do imóvel traz dados estruturados");
  const dados = JSON.parse(ld[1]);
  assert.equal(dados["@type"], "RealEstateListing");
  assert.equal(dados.offers.price, 320000);
  assert.ok(!ld[1].includes("</script"), "o texto do anúncio não fecha a tag");
  // Busca filtrada não entra no Google.
  p = await peloDominio("www.casanovaimoveis.test", "/?tipo=casa");
  assert.match(p.corpo, /<meta name="robots" content="noindex">/);

  caso("Sitemap e robots");
  p = await peloDominio("www.casanovaimoveis.test", "/sitemap.xml");
  assert.equal(p.status, 200);
  assert.match(p.tipo, /xml/);
  assert.ok(p.corpo.includes(`<loc>https://www.casanovaimoveis.test/${casa.id}/casa-com-quintal-no-centro</loc>`));
  p = await peloDominio("www.casanovaimoveis.test", "/robots.txt");
  assert.match(p.corpo, /Sitemap: https:\/\/www\.casanovaimoveis\.test\/sitemap\.xml/);
  const rs = await fetch(url("/imoveis/casa-nova-imoveis/sitemap.xml"));
  assert.equal(rs.status, 200);
  assert.ok((await rs.text()).includes(`/imoveis/casa-nova-imoveis/${casa.id}/`));

  caso("O master vê o domínio esperando, anota o destino, e a conferência diz em que passo está");
  assert.equal((await gestor.get("/orgs/dominios")).status, 403);
  r = await master.get("/orgs/dominios");
  assert.equal(r.status, 200);
  assert.ok(r.body.dominios.some(d => d.dominio === "www.casanovaimoveis.test" && d.dominio_estado === "aguardando_conhub"));
  r = await master.send("PATCH", `/orgs/dominios/${org}`, { destino: "abc123.up.railway.app" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const meu = r.body.dominios.find(d => d.org_id === org);
  assert.equal(meu.dominio_destino, "abc123.up.railway.app");
  assert.equal(meu.dominio_estado, "aguardando_dns");
  assert.match(meu.dominio_detalhe || "", /CNAME|DNS/);
  r = await gestor.send("POST", "/site/dominio/verificar");
  assert.equal(r.status, 200);
  assert.equal(r.body.dominio_estado, "aguardando_dns");
  assert.equal(r.body.dominio_destino, "abc123.up.railway.app");

  caso("Domínio ativo: o link do imóvel já sai com o endereço da imobiliária");
  db.prepare("UPDATE sites SET dominio_estado = 'ativo' WHERE org_id = ?").run(org);
  r = await gestor.get(`/produtos/${casa.id}`);
  assert.equal(r.body.site_path, `https://www.casanovaimoveis.test/${casa.id}/casa-com-quintal-no-centro`);

  caso("Site desligado: o domínio responde 'não encontrado'; tirar o domínio solta o endereço");
  await gestor.send("PATCH", "/site", { ligado: false });
  p = await peloDominio("www.casanovaimoveis.test", "/");
  assert.equal(p.status, 404);
  r = await gestor.send("PATCH", "/site", { dominio: "" });
  assert.equal(r.status, 200);
  assert.equal(r.body.dominio, "");
  r = await gestorB.send("PATCH", "/site", { dominio: "www.casanovaimoveis.test" });
  assert.equal(r.status, 200, "domínio solto pode ser usado por outra conta");

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
