/* SITE DA IMOBILIÁRIA — portal com o catálogo e página por imóvel.

   O que mais importa aqui é o que NÃO aparece: construtora, comissão,
   captador e observações internas moram no mesmo cadastro que vira página
   pública. Servidor inteiro de pé, lendo o HTML como o visitante lê.

   Rodar:  npm run teste:site
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-site.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4723;
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
  db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run("Conecta Imóveis", org);
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Outra Casa", "OUTRA-1", Date.now());
  const usuario = (o, email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario(org, "gestor@site.com", "adm");
  usuario(org, "corretor@site.com", "corretor");
  usuario(orgB, "gestorb@site.com", "adm");
  const entrar = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
  const como = async (email) => {
    const t = await entrar(email);
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    return {
      get: async (p) => { const r = await fetch(url(p), { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
      send: async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    };
  };
  const gestor = await como("gestor@site.com");
  const corretor = await como("corretor@site.com");
  const gestorB = await como("gestorb@site.com");
  const foto = (pid, nome) => db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,ordem,created_at) VALUES (?,?,?,?,0,?)")
    .run("m_" + randomUUID(), pid, "foto", nome, Date.now());
  const pagina = async (p) => { const r = await fetch(url(p), { redirect: "manual" }); return { status: r.status, local: r.headers.get("location"), html: await r.text() }; };

  caso("Nasce DESLIGADO, com endereço tirado do nome da imobiliária");
  let cfg = (await gestor.get("/site")).body;
  assert.equal(cfg.ligado, false);
  assert.equal(cfg.slug, "conecta-imoveis");
  assert.equal((await pagina("/imoveis/conecta-imoveis")).status, 404, "site desligado não pode estar no ar");

  caso("Corretor não mexe no site");
  assert.equal((await corretor.get("/site")).status, 403);
  assert.equal((await corretor.send("PATCH", "/site", { ligado: true })).status, 403);

  caso("Ligar sem WhatsApp é recusado — vitrine sem porta");
  let r = await gestor.send("PATCH", "/site", { ligado: true, whatsapp: "" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /WhatsApp/);

  caso("Pixel com letras é recusado (só dígitos entram na página)");
  r = await gestor.send("PATCH", "/site", { pixel_id: "123'</script><script>alert(1)" });
  assert.equal(r.status, 400);

  caso("Liga com WhatsApp e Pixel");
  r = await gestor.send("PATCH", "/site", { ligado: true, whatsapp: "(87) 99911-2222", pixel_id: "1234567890123456", frase: "Seu lar em Petrolina" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.whatsapp, "5587999112222");

  caso("Endereço já usado por outra imobiliária é recusado");
  r = await gestorB.send("PATCH", "/site", { slug: "conecta-imoveis" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /em uso/);

  // Catálogo
  const criar = async (b) => { const x = await gestor.send("POST", "/produtos", b); assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };
  const casa = await criar({ tipo: "casa", formato: "solta", titulo: "Casa 3 quartos no Jardim Amazonas", cidade: "Petrolina", uf: "PE",
    bairro: "Jardim Amazonas", endereco: "Rua das Acácias", numero_end: "120", valor: 350000, quartos: 3, banheiros: 2, area_util: 95,
    descricao: "Casa nova com varanda e quintal amplo.", construtor: "Construtora Segredo", comissao_pct: 6,
    observacoes: "DONO ACEITA 10% ABAIXO", maps_url: "https://www.google.com/maps/@-9.39,-40.50,17z" });
  foto(casa.id, "https://cdn.exemplo.com/casa1.jpg");
  const aluguel = await criar({ tipo: "casa", formato: "solta", finalidade: "aluguel", titulo: "Casa para alugar no Centro", cidade: "Juazeiro",
    uf: "BA", bairro: "Centro", valor: 1800, condominio: 250, quartos: 2 });
  const escondido = await criar({ tipo: "terreno", titulo: "Terreno <script>alert(1)</script>", cidade: "Petrolina", valor: 90000 });

  caso("Produto já traz o link do site");
  const p1 = (await gestor.get(`/produtos/${casa.id}`)).body;
  assert.equal(p1.site_path, `/imoveis/conecta-imoveis/${casa.id}/casa-3-quartos-no-jardim-amazonas`);

  caso("Portal lista os ativos, com a marca, a frase e o pixel");
  let pg = await pagina("/imoveis/conecta-imoveis");
  assert.equal(pg.status, 200);
  assert.match(pg.html, /Seu lar em Petrolina/);
  assert.match(pg.html, /Casa 3 quartos no Jardim Amazonas/);
  assert.match(pg.html, /Casa para alugar no Centro/);
  assert.match(pg.html, /fbq\('init','1234567890123456'\)/);
  assert.match(pg.html, /wa\.me\/5587999112222/);

  caso("Título com HTML sai escapado, nunca executado");
  assert.ok(!pg.html.includes("<script>alert(1)</script>"), "texto do cadastro virou código na página");
  assert.match(pg.html, /Terreno &lt;script&gt;/);

  caso("Filtros: alugar mostra só aluguel; cidade filtra");
  pg = await pagina("/imoveis/conecta-imoveis?finalidade=aluguel");
  assert.match(pg.html, /Casa para alugar no Centro/);
  assert.ok(!pg.html.includes("Casa 3 quartos no Jardim Amazonas"));
  pg = await pagina("/imoveis/conecta-imoveis?cidade=Juazeiro");
  assert.ok(!pg.html.includes("Casa 3 quartos no Jardim Amazonas"));

  caso("Página do imóvel: o que o comprador precisa, e NADA do que é da casa");
  pg = await pagina(p1.site_path);
  assert.equal(pg.status, 200);
  assert.match(pg.html, /R\$\s350\.000/);
  for (const deve of ["Casa 3 quartos no Jardim Amazonas", "Casa nova com varanda", "Jardim Amazonas", "og:image", "https://cdn.exemplo.com/casa1.jpg", "ViewContent"])
    assert.ok(pg.html.includes(deve), `faltou: ${deve}`);
  for (const nunca of ["Construtora Segredo", "DONO ACEITA", "comiss", "Comiss", "captador", "Rua das Acácias", "-9.39"])
    assert.ok(!pg.html.includes(nunca), `VAZOU na página pública: ${nunca}`);

  caso("Endereço 'completo' mostra a rua; e o mapa segue a mesma escolha");
  await gestor.send("PATCH", `/produtos/${casa.id}`, { exibir_endereco: "completo" });
  pg = await pagina(p1.site_path);
  assert.ok(pg.html.includes("Rua das Acácias, 120"));
  assert.ok(pg.html.includes("-9.39"), "com endereço completo, o mapa vai ao ponto exato do link do Maps");

  caso("Título trocado: o link antigo leva ao novo (301)");
  await gestor.send("PATCH", `/produtos/${casa.id}`, { titulo: "Casa com piscina no Jardim Amazonas" });
  pg = await pagina(p1.site_path);
  assert.equal(pg.status, 301);
  assert.ok(pg.local.endsWith("/casa-com-piscina-no-jardim-amazonas"));

  caso("Vendido: a página não quebra — avisa e oferece outros");
  await gestor.send("POST", `/produtos/${aluguel.id}/status`, { status: "alugado" });
  pg = await pagina(`/imoveis/conecta-imoveis/${aluguel.id}/x`);
  assert.equal(pg.status, 410);
  assert.match(pg.html, /já foi alugado/);
  assert.match(pg.html, /noindex/);
  assert.ok(!(await pagina("/imoveis/conecta-imoveis")).html.includes("Casa para alugar no Centro"), "alugado saiu da vitrine");

  caso("Aguardando aprovação não existe para o visitante");
  const cadCorretor = await corretor.send("POST", "/produtos", { tipo: "casa", formato: "solta", titulo: "Casa do corretor pendente", cidade: "Petrolina" });
  assert.equal(cadCorretor.body.status, "aguardando_aprovacao");
  pg = await pagina(`/imoveis/conecta-imoveis/${cadCorretor.body.id}/x`);
  assert.equal(pg.status, 404);
  assert.ok(!pg.html.includes("Casa do corretor pendente"));

  caso("Imóvel de OUTRA imobiliária não abre no site desta");
  await gestorB.send("PATCH", "/site", { ligado: true, whatsapp: "87988887777" });
  const deB = (await gestorB.send("POST", "/produtos", { tipo: "casa", formato: "solta", titulo: "Casa da outra imobiliária", cidade: "Recife" })).body;
  pg = await pagina(`/imoveis/conecta-imoveis/${deB.id}/x`);
  assert.equal(pg.status, 404);
  assert.ok(!pg.html.includes("Casa da outra imobiliária"));

  caso("Endereço inexistente: página neutra, sem marca de ninguém");
  pg = await pagina("/imoveis/nao-existe-mesmo");
  assert.equal(pg.status, 404);
  assert.ok(!pg.html.includes("Conecta"));

  caso("Desligar tira o site do ar e o link do produto some");
  await gestor.send("PATCH", "/site", { ligado: false });
  assert.equal((await pagina("/imoveis/conecta-imoveis")).status, 404);
  assert.equal((await gestor.get(`/produtos/${casa.id}`)).body.site_path, null);

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error(saida.slice(-2500));
  throw e;
} finally {
  servidor.kill("SIGKILL");
}
