/* ANÚNCIOS DE FORMULÁRIO DA META PELA PONTE DO ZAPIER/MAKE — o lead chega no
   endereço de leads da imobiliária com `?portal=meta`, e as respostas do
   formulário precisam virar ficha, observação e campanha. Servidor de pé: o
   formato que chega é o que a pessoa montou no Zapier, e a rota é a porta.

   Rodar:  npm run teste:meta-formulario
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-meta-formulario.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4641;
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
  usuario(org, "gestor@meta.com", "adm");
  const sdr = usuario(org, "vanessa@meta.com", "sdr");
  usuario(orgB, "gestorb@meta.com", "adm");
  const tokenDe = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const cfg = await (await fetch(url("/portais"), { headers: { Authorization: `Bearer ${t}` } })).json();
    return cfg.leads_url.split("/webhooks")[1];
  };
  const endA = await tokenDe("gestor@meta.com");
  const endB = await tokenDe("gestorb@meta.com");
  const postar = async (end, corpo, tipo = "json") => {
    const r = await fetch(url("/webhooks" + end), { method: "POST",
      headers: { "Content-Type": tipo === "json" ? "application/json" : "application/x-www-form-urlencoded" },
      body: tipo === "json" ? JSON.stringify(corpo) : new URLSearchParams(corpo).toString() });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const leadPorTel = (o, tel) => db.prepare("SELECT * FROM leads WHERE org_id = ? AND phone = ?").get(o, tel);
  const obs = (id) => db.prepare("SELECT texto FROM observacoes WHERE lead_id = ? ORDER BY created_at").all(id).map((x) => x.texto);

  caso("Zapier com o 'Data' vazio: tudo o que o Facebook mandou vira lead, ficha, campanha e observação");
  const zap = {
    id: "1200000001", created_time: "2026-10-01T12:00:00+0000", page_id: "998877", form_id: "55", form_name: "Casas Centro — out",
    ad_id: "77", ad_name: "Carrossel 1", adset_name: "Petrolina 25-45", campaign_id: "66", campaign_name: "Casas Centro",
    platform: "ig", is_organic: "false",
    full_name: "Ana Souza", phone_number: "+5587991112222", email: "ana@exemplo.com",
    "qual_a_sua_renda_mensal?": "R$ 5.000", "tem_valor_de_entrada?": "R$ 20.000",
    "qual_bairro_procura?": "Centro",
  };
  let r = await postar(endA + "?portal=meta", zap);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.novo, true);
  let l = leadPorTel(org, "5587991112222");
  assert.ok(l, "o lead tem que existir com o telefone normalizado");
  assert.equal(l.name, "Ana Souza");
  assert.equal(l.origem, "Meta Ads");
  assert.equal(l.source, "meta");
  assert.equal(l.campaign_name, "Casas Centro");
  assert.equal(l.form_name, "Casas Centro — out");
  assert.equal(l.adset_name, "Petrolina 25-45");
  assert.equal(l.platform, "ig");
  assert.equal(l.meta_lead_id, "1200000001");
  assert.equal(l.assigned_to, sdr, "vai para a atendente da vez, como todo lead novo");
  const q = JSON.parse(l.qual_json);
  assert.equal(q.renda, "R$ 5.000");
  assert.equal(q.entrada, "R$ 20.000");
  const o = obs(l.id).join("\n");
  console.log("   " + o.replace(/\n/g, "\n   "));
  assert.match(o, /Instagram/);
  assert.match(o, /Qual bairro procura\?: Centro/, "pergunta fora dos campos da ficha não pode se perder");
  assert.match(o, /Qual a sua renda mensal\?: R\$ 5\.000/);
  for (const tecnico of ["998877", "is organic", "is_organic", "page id", "Carrossel"])
    assert.ok(!o.toLowerCase().includes(tecnico.toLowerCase()), `dado técnico do anúncio não é resposta: ${tecnico}`);

  caso("O Zapier reenviando o mesmo lead não cria outro");
  r = await postar(endA + "?portal=meta", zap);
  assert.equal(r.status, 200);
  assert.equal(r.body.repetido, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND phone = ?").get(org, "5587991112222").n, 1);

  caso("A mesma pessoa preenche outro formulário: um lead só, a ficha completa o que faltava e não apaga o que existia");
  db.prepare("UPDATE leads SET qual_json = ? WHERE id = ?").run(JSON.stringify({ ...q, renda: "R$ 6.000 (corrigido)" }), l.id);
  r = await postar(endA + "?portal=meta", { ...zap, id: "1200000002", "em_quanto_tempo_quer_comprar?": "3 meses",
    "qual_a_sua_renda_mensal?": "R$ 4.000" });
  assert.equal(r.body.novo, false);
  l = leadPorTel(org, "5587991112222");
  const q2 = JSON.parse(l.qual_json);
  assert.equal(q2.prazo, "3 meses", "o que estava vazio é preenchido");
  assert.equal(q2.renda, "R$ 6.000 (corrigido)", "o que alguém corrigiu não é sobrescrito");
  assert.equal(obs(l.id).length, 2, "a segunda resposta vira outra observação");

  caso("Make em formulário (urlencoded), com o nome da pergunta escrito por gente");
  r = await postar(endA + "?portal=meta", { full_name: "Bruno Lima", phone_number: "87 98888-7777",
    campaign_name: "Lançamento", "Qual a sua renda": "3 mil", "Situação profissional": "CLT" }, "form");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  l = leadPorTel(org, "5587988887777");
  assert.ok(l);
  assert.equal(l.campaign_name, "Lançamento");
  assert.equal(JSON.parse(l.qual_json).situacao, "CLT");
  assert.match(obs(l.id)[0], /Qual a sua renda: 3 mil/);

  caso("Formato cru da Meta (field_data) também é entendido");
  r = await postar(endA + "?portal=facebook", { id: "1200000003", field_data: [
    { name: "full_name", values: ["Carla Dias"] }, { name: "phone_number", values: ["+55 87 99777-6666"] },
    { name: "renda_familiar", values: ["8 mil"] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  l = leadPorTel(org, "5587997776666");
  assert.equal(l.name, "Carla Dias");
  assert.equal(l.origem, "Meta Ads");
  assert.equal(JSON.parse(l.qual_json).renda, "8 mil");

  caso("Formulário em português (numero_de_telefone, endereço_de_email) é lido — telefone e e-mail não se perdem por causa do nome do campo");
  r = await postar(endA + "?portal=meta", { id: "1200000010", field_data: [
    { name: "nome_completo", values: ["Joana Lima"] }, { name: "número_de_telefone", values: ["+55 87 99111-3333"] },
    { name: "endereço_de_email", values: ["joana@exemplo.com"] }, { name: "qual_a_sua_renda?", values: ["3 mil"] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  l = leadPorTel(org, "5587991113333");
  assert.equal(l.name, "Joana Lima");
  assert.equal(l.email, "joana@exemplo.com");
  assert.ok(!obs(l.id)[0].includes("número_de_telefone"), "o telefone não é repetido como resposta");

  caso("O lead de TESTE da Meta (\"<test lead: dummy data…>\") entra, com nome de teste, mesmo sem telefone");
  r = await postar(endA + "?portal=meta", { id: "1200000011", field_data: [
    { name: "full_name", values: ["<test lead: dummy data for full_name>"] },
    { name: "phone_number", values: ["<test lead: dummy data for phone_number>"] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.novo, true);
  assert.equal(db.prepare("SELECT name FROM leads WHERE meta_lead_id = ?").get("1200000011").name, "Lead de teste da Meta");

  caso("Sem telefone e sem e-mail é recusado com a razão escrita");
  r = await postar(endA + "?portal=meta", { full_name: "Ninguém", "qual_a_sua_renda?": "2 mil" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /sem telefone e sem e-mail/);

  caso("Cada imobiliária recebe só pelo próprio endereço; endereço inventado é 404");
  r = await postar(endB + "?portal=meta", { ...zap, id: "9", phone_number: "+5587991112222" });
  assert.equal(r.body.novo, true, "na outra casa é outro lead, mesmo com o mesmo telefone");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone = ?").get("5587991112222").n, 2);
  assert.equal(leadPorTel(orgB, "5587991112222").org_id, orgB);
  r = await postar("/portais/" + "0".repeat(48) + "?portal=meta", zap);
  assert.equal(r.status, 404);

  caso("Lead de portal de imóveis continua igual (não vira lead de formulário)");
  r = await postar(endA, { name: "Dani Portal", phoneNumber: "87996665555", leadOrigin: "ZAP", message: "Tenho interesse", originLeadId: "z1" });
  l = leadPorTel(org, "5587996665555");
  assert.equal(l.origem, "ZAP Imóveis");
  assert.equal(l.source, "portal");
  assert.equal(l.campaign_name, null);
  assert.match(obs(l.id)[0], /Mensagem do cliente: "Tenho interesse"/);

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
