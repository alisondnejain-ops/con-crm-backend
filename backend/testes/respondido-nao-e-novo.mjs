/* RESPONDIDO NÃO É "NOVO" (08/10/2026, reclamação da atendente da Conecta:
   "mesmo eu tendo respondido aparece como se fosse mensagem nova").

   Duas causas: (1) a marcação de lida era ignorada para quem supervisiona em
   lead que não é dela — inclusive o lead da FILA, que é justamente a caixa da
   atendente; (2) responder não contava como ler, então a resposta pelo celular
   (ou de outra pessoa da supervisão) deixava a conversa com "não lida" para sempre.

   Rodar:  npm run teste:respondido
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-respondido.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4793;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "",
    UAZAPI_AUTOCONFIGURAR: "0", MARKETING_AGENDADOR: "0", SITE_DOMINIO_AGENDADOR: "0" },
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
  usuario("gestor@resp.com", "adm");
  const sdr = usuario("vanessa@resp.com", "sdr");
  const corretor = usuario("marina@resp.com", "corretor");
  const login = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
  const tSdr = await login("vanessa@resp.com");
  const tCorretor = await login("marina@resp.com");
  const doLead = async (t, id) => (await (await fetch(url("/leads"), { headers: { Authorization: `Bearer ${t}` } })).json()).find((x) => x.id === id);
  const ler = (t, id) => fetch(url(`/leads/${id}/read`), { method: "POST", headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());

  const insLead = db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at,source) VALUES (?,?,?,?,'Lead',?,?,'whatsapp')`);
  const insMsg = db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at) VALUES (?,?,?,?,?,?,?)`);
  const msg = (lead, dir, quando, autor = null, nome = null) => insMsg.run("m_" + randomUUID(), lead, dir, autor, nome, "texto", quando);
  const t0 = Date.now() - 600000;

  caso("Lead da FILA aberto pela atendente: marcar como lida passa a valer");
  const fila = "l_" + randomUUID();
  insLead.run(fila, org, "Cliente da fila", "5587990001111", null, t0);
  msg(fila, "in", t0 + 1000);
  assert.equal((await doLead(tSdr, fila)).unread, 1);
  const r1 = await ler(tSdr, fila);
  assert.ok(!r1.ignorado, "a marcação não pode ser ignorada em lead sem dono");
  assert.equal((await doLead(tSdr, fila)).unread, 0);
  console.log("   ok");

  caso("Lead de um CORRETOR aberto pela atendente: continua sem apagar o aviso dele");
  const doCorretor = "l_" + randomUUID();
  insLead.run(doCorretor, org, "Cliente da Marina", "5587990002222", corretor, t0);
  msg(doCorretor, "in", t0 + 1000);
  const r2 = await ler(tSdr, doCorretor);
  assert.ok(r2.ignorado, "supervisão olhando lead do corretor não marca");
  assert.equal((await doLead(tCorretor, doCorretor)).unread, 1);
  console.log("   ok");

  caso("Respondido pelo CELULAR (eco sem autor): sai das não lidas, mesmo sem abrir no CRM");
  const celular = "l_" + randomUUID();
  insLead.run(celular, org, "Cliente do celular", "5587990003333", sdr, t0);
  msg(celular, "in", t0 + 1000);
  msg(celular, "in", t0 + 2000);
  assert.equal((await doLead(tSdr, celular)).unread, 2);
  msg(celular, "out", t0 + 3000);
  assert.equal((await doLead(tSdr, celular)).unread, 0, "quem respondeu leu");
  console.log("   ok");

  caso("Resposta pelo CRM de outra pessoa da supervisão: o cliente foi atendido, não é mais novo");
  msg(doCorretor, "out", t0 + 4000, sdr, "vanessa");
  assert.equal((await doLead(tCorretor, doCorretor)).unread, 0);
  console.log("   ok");

  caso("O cliente escreve de novo depois da resposta: volta a contar só o que é novo");
  msg(celular, "in", t0 + 5000);
  assert.equal((await doLead(tSdr, celular)).unread, 1);
  console.log("   ok");

  caso("Disparo, automação e robô NÃO contam como resposta de gente");
  const auto = "l_" + randomUUID();
  insLead.run(auto, org, "Cliente automático", "5587990004444", sdr, t0);
  msg(auto, "in", t0 + 1000);
  msg(auto, "out", t0 + 2000, null, "Disparo · Campanha");
  msg(auto, "out", t0 + 3000, null, "Automação · Boas-vindas");
  msg(auto, "out", t0 + 4000, null, "Atendimento automático");
  assert.equal((await doLead(tSdr, auto)).unread, 1, "ninguém da equipe olhou essa conversa");
  console.log("   ok");

  console.log("\nTodos os casos passaram.");
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(saida.slice(-2000));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
