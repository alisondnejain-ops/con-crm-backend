/* PORTAIS DE IMÓVEIS — feed (ZAP/VivaReal/OLX e Chaves na Mão) e lead que
   chega do portal. Servidor inteiro de pé: as regras que mais importam aqui
   são de PORTA (token certo, token trocado, quem pode ligar o anúncio), e
   porta testada por dentro do serviço não prova nada sobre a rota.

   Rodar:  npm run teste:portais
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-portais.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4721;
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
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Outra Casa", "OUTRA-1", Date.now());
  const usuario = (o, email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario(org, "gestor@portais.com", "adm");
  const sdr = usuario(org, "vanessa@portais.com", "sdr");
  usuario(org, "corretor@portais.com", "corretor");
  usuario(orgB, "gestorb@portais.com", "adm");
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
  const gestor = await como("gestor@portais.com");
  const corretor = await como("corretor@portais.com");
  const gestorB = await como("gestorb@portais.com");
  const foto = (pid, nome) => db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,ordem,created_at) VALUES (?,?,?,?,0,?)")
    .run("m_" + randomUUID(), pid, "foto", nome, Date.now());
  const texto = async (p) => { const r = await fetch(url(p)); return { status: r.status, tipo: r.headers.get("content-type"), xml: await r.text() }; };

  caso("O gestor vê os endereços do feed e dos leads — com tokens DIFERENTES");
  let cfg = (await gestor.get("/portais")).body;
  console.log("  ", cfg.feeds.grupo_olx);
  const tokFeed = cfg.feeds.grupo_olx.split("/feeds/")[1].split("/")[0];
  const tokLeads = cfg.leads_url.split("/portais/")[1];
  assert.match(tokFeed, /^[a-f0-9]{48}$/);
  assert.notEqual(tokFeed, tokLeads, "um token só daria a quem viu o feed a porta de escrever leads");

  caso("Corretor não abre a tela de Portais");
  assert.equal((await corretor.get("/portais")).status, 403);

  caso("Imóvel marcado mas incompleto: fica FORA do feed, e a tela diz o que falta");
  let r = await gestor.send("POST", "/produtos", { tipo: "casa", formato: "solta", titulo: "Casa no Centro", cidade: "Petrolina",
    valor: "350.000", publicar_portais: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const casa = r.body.id;
  cfg = (await gestor.get("/portais")).body;
  const m = cfg.situacao.marcados.find(x => x.id === casa);
  console.log("   falta:", m.bloqueia.join(" · "));
  assert.equal(m.pronto, false);
  assert.ok(m.bloqueia.some(b => b.includes("descrição")) && m.bloqueia.some(b => b.includes("foto")));
  let f = await texto(`/feeds/${tokFeed}/zap.xml`);
  assert.equal(f.status, 200);
  assert.match(f.tipo, /xml/);
  assert.ok(!f.xml.includes("<Listing>"), "anúncio incompleto não pode sair");

  caso("Completo: entra no feed do Grupo OLX com preço, estado e foto com endereço absoluto");
  r = await gestor.send("PATCH", `/produtos/${casa}`, { titulo: "Casa 3 quartos no Centro de Petrolina", uf: "pe", bairro: "Centro",
    cep: "56300-000", descricao: "Casa ampla com 3 quartos, sala, cozinha planejada, quintal e garagem para dois carros. Documentação em dia.",
    area_util: "120", metragem: "200", quartos: 3, banheiros: 2, suites: 1, vagas: 2, condominio: "", iptu: "900",
    maps_url: "https://www.google.com/maps/place/x/@-9.3891,-40.5030,17z", publicar_portais: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  foto(casa, "/arquivos/produtos/capa.jpg");
  f = await texto(`/feeds/${tokFeed}/zap.xml`);
  assert.ok(f.xml.includes(`<ListingID>${casa}</ListingID>`));
  assert.ok(f.xml.includes('<ListPrice currency="BRL">350000</ListPrice>'), "valor com ponto de milhar tem que virar 350000");
  assert.ok(f.xml.includes('<State abbreviation="PE">Pernambuco</State>'));
  assert.ok(f.xml.includes(`<Item medium="image" primary="true">http://127.0.0.1:${PORTA}/arquivos/produtos/capa.jpg</Item>`));
  assert.ok(f.xml.includes("<Latitude>-9.3891</Latitude>"), "coordenada tirada do link do Maps");
  assert.ok(f.xml.includes("<YearlyTax") && !f.xml.includes("<PropertyAdministrationFee"), "condomínio vazio não sai");
  assert.equal((f.xml.match(/<Listing>/g) || []).length, (f.xml.match(/<\/Listing>/g) || []).length);

  caso("O mesmo imóvel no feed do Chaves na Mão: as 53 tags, na ordem, e transação V");
  f = await texto(`/feeds/${tokFeed}/chavesnamao.xml`);
  const bloco = f.xml.split("<imovel>")[1].split("</imovel>")[0];
  const tags = [...bloco.matchAll(/^\s{6}<([a-z_0-9]+)>/gm)].map(x => x[1]);
  console.log("  ", tags.length, "tags");
  assert.equal(tags.length, 53);
  assert.equal(tags[0], "referencia"); assert.equal(tags[52], "periodo_locacao");
  assert.ok(bloco.includes("<transacao>V</transacao>") && bloco.includes("<valor>350000</valor>"));
  assert.ok(bloco.includes("<esconder_endereco_imovel>1</esconder_endereco_imovel>"), "padrão é mostrar só o bairro");

  caso("Aluguel: preço mensal no VRSync e transação L no Chaves na Mão");
  r = await gestor.send("POST", "/produtos", { tipo: "casa", finalidade: "aluguel", formato: "solta", titulo: "Casa para alugar na Areia Branca",
    cidade: "Petrolina", bairro: "Areia Branca", uf: "PE", valor: "1500", area_util: 80, quartos: 2, banheiros: 1,
    descricao: "Casa arejada com dois quartos, varanda e área de serviço. Perto de escola e mercado.", publicar_portais: true });
  const aluguel = r.body.id;
  foto(aluguel, "/arquivos/produtos/aluguel.jpg");
  f = await texto(`/feeds/${tokFeed}/zap.xml`);
  assert.ok(f.xml.includes('<RentalPrice currency="BRL" period="Monthly">1500</RentalPrice>'));
  f = await texto(`/feeds/${tokFeed}/chavesnamao.xml`);
  assert.ok(f.xml.includes("<transacao>L</transacao>") && f.xml.includes("<valor_locacao>1500</valor_locacao>"));

  caso("Foto PNG sai do Chaves na Mão (o portal não aceita), mas continua no Grupo OLX");
  foto(aluguel, "/arquivos/produtos/planta.png");
  assert.ok(!(await texto(`/feeds/${tokFeed}/chavesnamao.xml`)).xml.includes("planta.png"));
  assert.ok((await texto(`/feeds/${tokFeed}/zap.xml`)).xml.includes("planta.png"));

  caso("Imóvel inativo ou não marcado não sai");
  db.prepare("UPDATE produtos SET status='inativo' WHERE id=?").run(aluguel);
  assert.ok(!(await texto(`/feeds/${tokFeed}/zap.xml`)).xml.includes(aluguel));
  db.prepare("UPDATE produtos SET status='ativo' WHERE id=?").run(aluguel);

  caso("Corretor que edita o próprio imóvel NÃO liga a publicação (é decisão da gestão)");
  r = await corretor.send("POST", "/produtos", { tipo: "terreno", titulo: "Terreno do corretor", cidade: "Juazeiro", publicar_portais: true });
  const doCorretor = r.body.id;
  db.prepare("UPDATE produtos SET status='ativo' WHERE id=?").run(doCorretor);
  await corretor.send("PATCH", `/produtos/${doCorretor}`, { publicar_portais: true });
  assert.equal(db.prepare("SELECT publicar_portais FROM produtos WHERE id=?").get(doCorretor).publicar_portais, 0);

  caso("Token errado, e token de LEADS no lugar do feed: 404");
  assert.equal((await texto(`/feeds/${"0".repeat(48)}/zap.xml`)).status, 404);
  assert.equal((await texto(`/feeds/${tokLeads}/zap.xml`)).status, 404);

  caso("Lead do ZAP (formato do Grupo OLX): nasce com a atendente, e a observação diz o imóvel");
  const leadOlx = { leadOrigin: "ZAP", originLeadId: "olx-1", clientListingId: casa, name: "Mariana Souza",
    email: "mariana@email.com", ddd: "87", phone: "991234567", message: "Ainda está disponível?" };
  r = await fetch(url(`/webhooks/portais/${tokLeads}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(leadOlx) });
  let b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.novo, true);
  const lead = db.prepare("SELECT * FROM leads WHERE phone = '5587991234567'").get();
  console.log("  ", lead.name, "·", lead.origem, "· dono é a atendente:", lead.assigned_to === sdr);
  assert.equal(lead.origem, "ZAP Imóveis");
  assert.equal(lead.assigned_to, sdr);
  let obs = db.prepare("SELECT texto FROM observacoes WHERE lead_id=?").all(lead.id);
  assert.equal(obs.length, 1);
  assert.ok(obs[0].texto.includes("Casa 3 quartos no Centro") && obs[0].texto.includes("Ainda está disponível?"));

  caso("O portal reenvia o MESMO lead: nada duplica");
  r = await fetch(url(`/webhooks/portais/${tokLeads}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(leadOlx) });
  assert.equal((await r.json()).repetido, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observacoes WHERE lead_id=?").get(lead.id).n, 1);

  caso("Mesma pessoa, outro anúncio: o lead é UM só, com mais uma observação");
  r = await fetch(url(`/webhooks/portais/${tokLeads}`), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...leadOlx, originLeadId: "olx-2", leadOrigin: "VivaReal", clientListingId: aluguel }) });
  assert.equal((await r.json()).novo, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone = '5587991234567'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observacoes WHERE lead_id=?").get(lead.id).n, 2);

  caso("Formulário em português (Chaves na Mão), identificado pelo ?portal= do endereço");
  r = await fetch(url(`/webhooks/portais/${tokLeads}?portal=chavesnamao`), { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nome: "Carlos Lima", telefone: "(87) 98888-7777", mensagem: "Quero visitar" }).toString() });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT origem FROM leads WHERE phone = '5587988887777'").get().origem, "Chaves na Mão");

  caso("Sem telefone e sem e-mail: recusado com o motivo");
  r = await fetch(url(`/webhooks/portais/${tokLeads}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Anônimo" }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /telefone/);

  caso("Token do FEED não abre a porta dos leads");
  r = await fetch(url(`/webhooks/portais/${tokFeed}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(leadOlx) });
  assert.equal(r.status, 404);

  caso("Isolamento: o código de anúncio de OUTRA imobiliária não vira interesse aqui");
  const cfgB = (await gestorB.get("/portais")).body;
  assert.notEqual(cfgB.leads_url, cfg.leads_url);
  r = await fetch(url(`/webhooks/portais/${tokLeads}`), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Teste", phone: "87977776666", originLeadId: "x-9",
      clientListingId: db.prepare("SELECT id FROM produtos WHERE org_id=? LIMIT 1").get(org).id.replace(/.$/, "Z") }) });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT org_id FROM leads WHERE phone='5587977776666'").get().org_id, org);

  caso("Trocar o token do feed: o endereço antigo morre, o novo funciona");
  cfg = (await gestor.send("POST", "/portais/token", { qual: "feed" })).body;
  const tokNovo = cfg.feeds.grupo_olx.split("/feeds/")[1].split("/")[0];
  assert.notEqual(tokNovo, tokFeed);
  assert.equal((await texto(`/feeds/${tokFeed}/zap.xml`)).status, 404);
  assert.equal((await texto(`/feeds/${tokNovo}/zap.xml`)).status, 200);
  assert.equal(cfg.leads_url.split("/portais/")[1], tokLeads, "trocar o do feed não pode derrubar o dos leads");

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error(saida.slice(-2500));
  throw e;
} finally {
  servidor.kill("SIGKILL");
}
