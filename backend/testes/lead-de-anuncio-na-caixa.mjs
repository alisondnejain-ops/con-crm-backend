/* O LEAD DO ANÚNCIO TEM QUE APARECER NA CAIXA (01/10/2026). O lead do
   formulário da Meta e do portal nasce sem mensagem nenhuma, então nunca tinha
   "não lida" — e a caixa punha primeiro quem tem mensagem por ler. Na Conecta,
   com centenas delas, o lead do anúncio ficava enterrado. Agora a lista traz
   `aguarda_contato` até a primeira mensagem enviada ou ligação.

   Rodar:  npm run teste:lead-de-anuncio
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-lead-de-anuncio.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4791;
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
  const usuario = (email, role) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, org, email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario("gestor@anuncio.com", "adm");
  const sdr = usuario("vanessa@anuncio.com", "sdr");
  const login = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
  const tGestor = await login("gestor@anuncio.com");
  const tSdr = await login("vanessa@anuncio.com");
  const lista = async (t) => (await fetch(url("/leads"), { headers: { Authorization: `Bearer ${t}` } })).json();
  const cfg = await (await fetch(url("/portais"), { headers: { Authorization: `Bearer ${tGestor}` } })).json();
  const endLeads = cfg.leads_url.split("/webhooks")[1];

  /* A caixa de antes: duzentas conversas com mensagem do cliente por ler, todas
     mais antigas que o lead do anúncio. */
  const antes = Date.now() - 3600000;
  const insLead = db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at,source) VALUES (?,?,?,?,?,?,?,?)`);
  const insMsg = db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)`);
  for (let i = 0; i < 200; i++) {
    const id = "l_" + randomUUID();
    insLead.run(id, org, "Cliente " + i, "55879900" + String(i).padStart(5, "0"), "Lead", sdr, antes - i * 1000, "whatsapp");
    insMsg.run("m_" + randomUUID(), id, "in", "oi", antes - i * 1000);
  }

  caso("O lead do formulário chega e vem marcado como esperando contato");
  const r = await fetch(url("/webhooks" + endLeads + "?portal=meta"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "9001", full_name: "Ana do Anúncio", phone_number: "+5587991113333", campaign_name: "Casas" }) });
  assert.equal(r.status, 200);
  const lead = db.prepare("SELECT * FROM leads WHERE phone = ?").get("5587991113333");
  assert.ok(lead, "o lead tem que existir");
  let l = (await lista(tGestor)).find((x) => x.id === lead.id);
  assert.ok(l, "o lead tem que vir na lista do gestor");
  assert.equal(l.aguarda_contato, 1);
  assert.equal(l.unread, 0, "não tem mensagem — o sinal é outro, não a contagem de não lidas");
  console.log("   ok");

  caso("Na ordem da caixa (esperando primeiro, depois o mais recente), ele fica em PRIMEIRO, não abaixo das 200 não lidas");
  const esperando = (x) => x.unread > 0 || !!x.aguarda_contato;
  const ultima = (x) => x.last_at || x.created_at;
  const ordenada = (await lista(tGestor)).sort((a, b) => esperando(b) - esperando(a) || ultima(b) - ultima(a));
  assert.equal(ordenada[0].id, lead.id, "o lead do anúncio tem que abrir a caixa");
  // Pela regra antiga (só não lidas), ele caía para depois das duzentas.
  const antiga = [...ordenada].sort((a, b) => (b.unread > 0) - (a.unread > 0) || ultima(b) - ultima(a));
  assert.ok(antiga.findIndex((x) => x.id === lead.id) >= 200, "a regra antiga enterrava o lead — se não enterra, o teste não prova nada");
  console.log("   ok");

  caso("A atendente que recebeu também o vê marcado");
  l = (await lista(tSdr)).find((x) => x.id === lead.id);
  assert.ok(l && l.aguarda_contato === 1);
  console.log("   ok");

  caso("A primeira mensagem enviada tira a marca");
  insMsg.run("m_" + randomUUID(), lead.id, "out", "Olá, Ana!", Date.now());
  l = (await lista(tGestor)).find((x) => x.id === lead.id);
  assert.equal(l.aguarda_contato, 0);
  console.log("   ok");

  caso("Ligar também conta como contato");
  await fetch(url("/webhooks" + endLeads + "?portal=meta"), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "9002", full_name: "Bia Liga", phone_number: "+5587991114444" }) });
  const bia = db.prepare("SELECT id FROM leads WHERE phone = ?").get("5587991114444").id;
  assert.equal((await lista(tGestor)).find((x) => x.id === bia).aguarda_contato, 1);
  const lig = await fetch(url(`/leads/${bia}/ligacao`), { method: "POST", headers: { Authorization: `Bearer ${tGestor}`, "Content-Type": "application/json" }, body: "{}" });
  assert.ok(lig.ok, "registrar a ligação: " + lig.status);
  assert.equal((await lista(tGestor)).find((x) => x.id === bia).aguarda_contato, 0);
  console.log("   ok");

  caso("Lead do WhatsApp sem mensagem enviada não ganha a marca (o sinal dele é a não lida), nem lead de anúncio antigo");
  const velho = "l_" + randomUUID();
  insLead.run(velho, org, "Anúncio de agosto", "5587991115555", "Lead", sdr, Date.now() - 30 * 86400000, "meta");
  const todos = await lista(tGestor);
  assert.ok(todos.filter((x) => x.name.startsWith("Cliente ")).every((x) => x.aguarda_contato === 0));
  assert.equal(todos.find((x) => x.id === velho).aguarda_contato, 0, "anúncio de um mês atrás é assunto da Base de leads, não do topo da caixa");
  console.log("   ok");

  console.log(`\nTodos os ${n} casos passaram.`);
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
}
