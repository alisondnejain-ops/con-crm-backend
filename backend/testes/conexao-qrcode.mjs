/* "CLICO EM DESCONECTAR E NÃO DESCONECTA, NÃO APARECE O QR CODE" (24/09/2026,
   conta do Alberto). Eram dois defeitos juntos:

   1. O selo "WhatsApp conectado" olhava só se a Uazapi RESPONDEU, não o que
      ela respondeu. Desconectado de verdade, a tela continuava verde.
   2. O CRM não tinha QR Code nenhum — parear só pelo painel da Uazapi. Quem
      desconectava por aqui ficava sem caminho de volta.

   Uma Uazapi de mentira, com estado (conectado → desconectado → QR →
   lido → conectado), e o caso da sessão travada que recusa desconectar.

   Rodar:  npm run teste:conexao-qrcode
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-conexao-qrcode.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4715, PORTA_UAZAPI = 4716;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Estado da instância falsa. `travada` imita a sessão "not reconnectable".
const inst = { status: "connected", travada: false, qr: "" };
const chamadas = [];
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    chamadas.push(`${req.method} ${req.url}`);
    const json = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/instance/status")
      return json(200, { instance: { status: inst.status, qrcode: inst.qr, owner: "5587999990000" },
        status: { connected: inst.status === "connected", loggedIn: inst.status === "connected" } });
    if (req.url === "/instance/disconnect") {
      if (inst.travada) return json(500, { message: "WhatsApp disconnected: session is not reconnectable" });
      inst.status = "disconnected"; inst.qr = ""; return json(200, { response: "Disconnected" });
    }
    if (req.url === "/instance/connect") {
      inst.travada = false; inst.status = "connecting"; inst.qr = PNG; // sem prefixo, de propósito
      return json(200, { connected: false, loggedIn: false, instance: { status: "connecting", qrcode: PNG } });
    }
    json(404, { message: "not found" });
  });
});

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;

try {
  await new Promise((r) => mock.listen(PORTA_UAZAPI, r));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await new Promise((x) => setTimeout(x, 250));
  }

  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get();
  const host = `http://127.0.0.1:${PORTA_UAZAPI}`;
  db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token=? WHERE id=?").run(host, "tok-qr", org.id);
  db.prepare("UPDATE canais SET host=?, token=?, ativo=1 WHERE org_id=? AND tipo='imobiliaria'").run(host, "tok-qr", org.id);
  const senha = bcrypt.hashSync("123456", 8);
  for (const [email, role] of [["gestor@qr.com", "adm"], ["corretor@qr.com", "corretor"]])
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
      VALUES (?,?,?,?,?,?,1,?,'ativo')`).run("u_" + randomUUID(), org.id, email, email, senha, role, Date.now());
  const entrar = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
  const auth = { Authorization: `Bearer ${await entrar("gestor@qr.com")}`, "Content-Type": "application/json" };
  const conexao = async () => (await (await fetch(url("/config/conexao"), { headers: auth })).json()).whatsapp;
  const post = (p, body) => fetch(url(p), { method: "POST", headers: auth, body: JSON.stringify(body || {}) });

  console.log("1. Conectado de verdade → a tela diz conectado");
  let w = await conexao();
  console.log("  ", JSON.stringify({ ok: w.ok, conectado: w.conectado, status: w.status }));
  assert.equal(w.conectado, true);

  console.log("2. Depois de desconectar, a tela diz DESCONECTADO (antes continuava verde)");
  let r = await post("/config/conexao/desconectar", { confirmar: "DESCONECTAR" });
  assert.equal(r.status, 200);
  w = await conexao();
  console.log("  ", JSON.stringify({ ok: w.ok, conectado: w.conectado, status: w.status }));
  assert.equal(w.ok, true, "a Uazapi respondeu");
  assert.equal(w.conectado, false, "…mas o WhatsApp NÃO está conectado — era isto que a tela escondia");

  console.log("3. O QR Code sai pelo CRM, já pronto para virar imagem");
  r = await post("/config/conexao/conectar");
  let q = await r.json();
  console.log("  ", r.status, q.qrcode.slice(0, 40) + "…");
  assert.equal(r.status, 200);
  assert.equal(q.conectado, false);
  assert.ok(q.qrcode.startsWith("data:image/png;base64,"), "sem o prefixo a <img> não desenha");

  console.log("4. Enquanto espera a leitura, o status também traz o QR (a tela o atualiza sozinha)");
  w = await conexao();
  assert.equal(w.conectado, false);
  assert.ok(w.qrcode.startsWith("data:image/png;base64,"));

  console.log("5. O celular leu → conectado, e o QR some");
  inst.status = "connected"; inst.qr = "";
  w = await conexao();
  assert.equal(w.conectado, true);
  assert.equal(w.qrcode, "");

  console.log("6. SESSÃO TRAVADA (o caso do Alberto): desconectar falha…");
  inst.travada = true;
  r = await post("/config/conexao/desconectar", { confirmar: "DESCONECTAR" });
  const d6 = await r.json();
  console.log("  ", r.status, d6.detail);
  assert.equal(r.status, 502);

  console.log("7. …e mesmo assim o 'forçar' derruba o que sobrou e entrega o QR novo");
  chamadas.length = 0;
  r = await post("/config/conexao/conectar", { forcar: true });
  q = await r.json();
  console.log("  ", r.status, "chamadas:", chamadas.join(", "));
  assert.equal(r.status, 200, "a falha da derrubada não pode impedir a única saída");
  assert.ok(q.qrcode.startsWith("data:image/png;base64,"));
  assert.ok(chamadas.includes("POST /instance/disconnect") && chamadas.includes("POST /instance/connect"));

  console.log("8. Corretor não gera QR (parear decide o WhatsApp da casa inteira)");
  const authC = { Authorization: `Bearer ${await entrar("corretor@qr.com")}`, "Content-Type": "application/json" };
  r = await fetch(url("/config/conexao/conectar"), { method: "POST", headers: authC, body: "{}" });
  console.log("  ", r.status);
  assert.equal(r.status, 403);

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error(saida.slice(-2000));
  throw e;
} finally {
  servidor.kill("SIGKILL");
  mock.close();
}
