/* O RELATÓRIO DAS CATRACAS (12/10/2026, pedido do Ali: "um relatório individual
   de uma catraca que foi desativada… com os números completos dela, até pra
   comparação em relação ao autoatendimento").

   Servidor de pé. O que se prova:
   - a comparação traz a principal, a ativa e a DESATIVADA, cada uma com os
     próprios leads, vendas, VGV e conversão;
   - a conversão com IA e sem IA é separada dentro da catraca;
   - o período filtra pela entrada do lead ("desde o início" pega tudo);
   - sem lead, a conversão é nula, nunca 0%;
   - o detalhe de uma catraca traz por corretor, origem e etapa;
   - corretor não abre; outra imobiliária não vê.

   Rodar:  npm run teste:relatorio-catracas
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-relatorio-catracas.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";
const PORTA = 4851;

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "RC-2026", APP_URL: "",
    UAZAPI_AUTOCONFIGURAR: "0", MARKETING_AGENDADOR: "0", FOTOS_AGENDADOR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await espera(250);
  }
  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const orgA = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get().id;
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Casa B", "RC-B", Date.now() + 1000);
  const usuario = (o, email, role, nome) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, o, nome || email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario(orgA, "gestora@rc.com", "adm");
  usuario(orgA, "sdr@rc.com", "sdr");
  const marina = usuario(orgA, "marina@rc.com", "corretor", "Marina");
  const rafa = usuario(orgA, "rafa@rc.com", "corretor", "Rafael");
  usuario(orgB, "gestorb@rc.com", "adm");
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    return async (p) => { const r = await fetch(url(p), { headers: { Authorization: `Bearer ${t}` } });
      return { status: r.status, body: await r.json().catch(() => ({})) }; };
  };
  const A = await como("gestora@rc.com"), atendente = await como("sdr@rc.com"),
        corretor = await como("marina@rc.com"), B = await como("gestorb@rc.com");

  const agora = Date.now(), DIA = 86400000, antigo = agora - 400 * DIA;
  const cat = (nome, ativa) => {
    const id = "cat_" + randomUUID();
    db.prepare("INSERT INTO catracas (id,org_id,nome,entrega,ativa,criada_por,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, orgA, nome, "corretor", ativa ? 1 : 0, null, antigo);
    return id;
  };
  const horizon = cat("Horizon", true), velha = cat("Campanha Nova", false);
  let k = 0;
  const lead = ({ catraca = null, dono = null, ia = 0, venda = 0, criado = agora - DIA, resp = null, origem = "WhatsApp" }) => {
    const id = "l_" + (++k);
    db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,stage,assigned_to,created_at,catraca_id,robo_msgs,sale_date,sale_value,first_resp_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, orgA, "Cliente " + k, "55879900" + String(k).padStart(5, "0"), origem, "Lead",
      dono, criado, catraca, ia, venda ? agora : null, venda || null, resp ? criado + resp * 60000 : null);
    return id;
  };
  // Campanha desativada: 4 leads, 2 com IA (1 vendeu), 2 sem IA (nenhuma venda). Um deles entrou há mais de um ano.
  lead({ catraca: velha, dono: marina, ia: 3, venda: 300000, resp: 10, origem: "Meta Ads" });
  lead({ catraca: velha, dono: marina, ia: 2, resp: 30 });
  lead({ catraca: velha, dono: rafa, resp: 20 });
  lead({ catraca: velha, dono: rafa, criado: antigo });
  // Horizon: 2 leads, sem IA, 1 venda.
  lead({ catraca: horizon, dono: rafa, venda: 500000 });
  lead({ catraca: horizon, dono: marina });
  // Principal: 1 lead na fila.
  lead({});
  // Outra imobiliária: não pode aparecer.
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at,catraca_id) VALUES (?,?,?,?,?,?,?)`)
    .run("l_b", orgB, "Da casa B", "5587000000000", "Lead", agora, velha);

  caso("A comparação traz a principal, a ativa e a desativada, desde o início");
  let r = await A("/distribution/catracas/relatorio?periodo=tudo");
  assert.equal(r.status, 200);
  const linha = (id) => r.body.linhas.find((l) => l.id === id);
  assert.deepEqual(r.body.linhas.map((l) => l.nome), ["Catraca principal", "Horizon", "Campanha Nova"]);
  assert.equal(linha(velha).ativa, false);
  assert.equal(linha(velha).leads, 4);
  assert.equal(linha(velha).vendas, 1);
  assert.equal(linha(velha).vgv, 300000);
  assert.equal(linha(velha).conversao, 25);
  assert.equal(linha(horizon).leads, 2);
  assert.equal(linha("principal").leads, 1);
  assert.equal(r.body.total.leads, 7, "o lead da outra imobiliária não entra");

  caso("Com IA × sem IA, dentro da mesma catraca");
  assert.deepEqual(linha(velha).ia, { leads: 2, vendas: 1, conversao: 50 });
  assert.deepEqual(linha(velha).sem_ia, { leads: 2, vendas: 0, conversao: 0 });
  assert.equal(linha(horizon).ia.conversao, null, "sem lead com IA a conversão é nula, não 0%");
  assert.equal(linha(horizon).sem_ia.conversao, 50);

  caso("O período conta pela entrada do lead");
  r = await A("/distribution/catracas/relatorio?periodo=90dias");
  assert.equal(r.body.linhas.find((l) => l.id === velha).leads, 3, "o lead de mais de um ano fica fora");
  assert.equal(r.body.periodo.rotulo, "últimos 90 dias");

  caso("O detalhe da catraca desativada: números, por corretor, origem e etapa");
  r = await A(`/distribution/catracas/${velha}/relatorio?periodo=tudo`);
  assert.equal(r.status, 200);
  assert.equal(r.body.catraca.nome, "Campanha Nova");
  assert.equal(r.body.catraca.ativa, false);
  assert.equal(r.body.leads, 4);
  assert.equal(r.body.primeira_resposta_mediana_min, 20);
  assert.equal(r.body.sem_resposta, 1);
  const m = r.body.por_corretor.find((x) => x.nome === "Marina");
  assert.equal(m.leads, 2); assert.equal(m.vendas, 1);
  assert.ok(r.body.por_origem.some((x) => x.nome === "Meta Ads" && x.leads === 1));
  assert.ok(r.body.por_etapa.some((x) => x.nome === "Lead" && x.leads === 4));

  caso("A principal também abre por dentro");
  r = await A("/distribution/catracas/principal/relatorio?periodo=tudo");
  assert.equal(r.status, 200);
  assert.equal(r.body.leads, 1);
  assert.equal(r.body.por_corretor[0].nome, "Na fila, sem dono");

  caso("A atendente vê; o corretor não; outra imobiliária não acha a catraca");
  assert.equal((await atendente("/distribution/catracas/relatorio")).status, 200);
  assert.equal((await corretor("/distribution/catracas/relatorio")).status, 403);
  assert.equal((await B(`/distribution/catracas/${velha}/relatorio`)).status, 404);
  r = await B("/distribution/catracas/relatorio?periodo=tudo");
  assert.deepEqual(r.body.linhas.map((l) => l.nome), ["Catraca principal"]);

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
