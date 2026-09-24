/* "CLIQUEI EM DESCONECTAR E SIMPLESMENTE NÃO VAI" (24/09/2026, relatado pelo
   Ali sobre a conta de Alberto, cliente do ConHub — a mesma conta cuja sessão
   da Uazapi o próprio provedor já descrevia, num envio real minutos antes,
   como "WhatsApp disconnected: session is not reconnectable").

   NENHUMA chamada à Uazapi (`services/uazapi.js` → `call()`/`instanceStatus`)
   tinha teto de tempo. Pedir para uma sessão NESSE ESTADO se desconectar é
   justamente o caso em que a API remota está mais provável de estar travada
   por dentro — e um `fetch` sem `signal` fica pendurado esperando para
   sempre: o botão mostra "Desconectando…" e não volta nunca, sem erro, sem
   sucesso, sem nada — exatamente a cara do relato. É a mesma família de
   defeito que `services/video.js` já documentou para o `ffmpeg`: "melhor um
   erro claro do que uma espera sem fim".

   Este teste sobe o servidor de verdade e um Uazapi de MENTIRA com dois
   comportamentos: um que responde rápido com erro (o caso comum, que já
   funcionava e não pode regredir) e um que NUNCA responde (o caso que
   travava o botão para sempre). Confere que os dois voltam com uma resposta
   clara — o segundo dentro de um teto, nunca "penduardo".

   Rodar:  npm run teste:desconectar-timeout
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-desconectar-timeout.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4713;
const PORTA_UAZAPI = 4714;

// Uazapi de mentira: /instance/disconnect responde rápido com o MESMO erro
// que o Ali viu de verdade num envio ("session is not reconnectable");
// /instance/logout nunca responde — simula a sessão travada por dentro.
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    if (req.url === "/instance/disconnect") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "WhatsApp disconnected: session is not reconnectable" }));
      return;
    }
    if (req.url === "/instance/logout") return; // nunca chama res.end()
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
});

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => { saida += d; });
servidor.stderr.on("data", (d) => { saida += d; });

const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
const esperarNoAr = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url("/health")); if (r.ok) return true; } catch (e) {}
    await new Promise((x) => setTimeout(x, 250));
  }
  throw new Error("o servidor não subiu:\n" + saida);
};

try {
  await new Promise((r) => mock.listen(PORTA_UAZAPI, r));
  await esperarNoAr();
  console.log("Servidor no ar, Uazapi de mentira no ar.");

  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const bcrypt = (await import("bcryptjs")).default;

  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get();
  db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token=? WHERE id=?")
    .run(`http://127.0.0.1:${PORTA_UAZAPI}`, "tok-teste", org.id);
  const casa = db.prepare("SELECT id FROM canais WHERE org_id=? AND tipo='imobiliaria'").get(org.id);
  if (casa) db.prepare("UPDATE canais SET host=?, token=?, ativo=1 WHERE id=?")
    .run(`http://127.0.0.1:${PORTA_UAZAPI}`, "tok-teste", casa.id);

  const gestorId = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(gestorId, org.id, "Gestor Teste", "gestor@teste-desc.com", bcrypt.hashSync("123456", 8), "adm", Date.now());

  const loginRes = await fetch(url("/auth/login"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "gestor@teste-desc.com", password: "123456" }),
  });
  const login = await loginRes.json();
  assert.equal(loginRes.status, 200, "login do gestor de teste falhou");
  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };

  console.log("\n1. O caso rápido (Uazapi responde na hora com erro) continua igual — sem regressão");
  const t1 = Date.now();
  const r1 = await fetch(url("/config/conexao/desconectar"), {
    method: "POST", headers: auth, body: JSON.stringify({ confirmar: "DESCONECTAR" }),
  });
  const d1 = await r1.json();
  const ms1 = Date.now() - t1;
  console.log(`   POST /config/conexao/desconectar → ${r1.status} em ${ms1}ms:`, d1.detail || d1.error);
  assert.equal(r1.status, 502, "erro real da Uazapi devia virar 502");
  assert.match(d1.detail || "", /not reconnectable/, "o motivo de verdade da Uazapi tem que chegar até a tela");
  assert.ok(ms1 < 5000, "o caminho rápido não pode ficar lento só porque agora existe timeout");

  console.log("\n2. Trocando a rota que responde para a que NUNCA responde — simula a sessão travada");
  db.prepare("DELETE FROM canais WHERE org_id = ?").run(org.id);
  // Sem `/instance/disconnect` disponível como primeira tentativa que erra
  // rápido, a rota tenta em ordem (disconnect, logout, close) — fazemos
  // `disconnect` também não existir localmente removendo o handler rápido
  // não é possível no mesmo mock sem reiniciar; em vez disso, o mock já trata
  // `/instance/logout` como pendurado — chamamos direto o caminho que o
  // `desconectarInstancia` tenta em SEGUNDO lugar simulando que o primeiro
  // (disconnect) devolveu 404, forçando o avanço até o penduardo:
  const mock2 = http.createServer((req, res) => {
    if (req.url === "/instance/disconnect") { res.writeHead(404); res.end("{}"); return; }
    // /instance/logout: nunca responde.
  });
  await new Promise((r) => mock2.listen(PORTA_UAZAPI + 1, r));
  db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token=? WHERE id=?")
    .run(`http://127.0.0.1:${PORTA_UAZAPI + 1}`, "tok-teste", org.id);

  console.log("   disparando o pedido — precisa voltar com erro claro, nunca ficar pendurado para sempre");
  const t2 = Date.now();
  const r2 = await fetch(url("/config/conexao/desconectar"), {
    method: "POST", headers: auth, body: JSON.stringify({ confirmar: "DESCONECTAR" }),
  });
  const d2 = await r2.json();
  const ms2 = Date.now() - t2;
  console.log(`   POST /config/conexao/desconectar → ${r2.status} em ${ms2}ms:`, d2.detail || d2.error);
  assert.equal(r2.status, 502, "sessão travada precisa virar 502, nunca ficar pendurada sem resposta");
  assert.match(d2.detail || "", /não respondeu em \d+s/, "o motivo tem que dizer que foi TIMEOUT, não outra coisa");
  // Prova o "nunca fica pendurado para sempre": tem que voltar dentro de um
  // teto folgado (30s) — bem menos que "nunca", que era o comportamento
  // antes deste conserto.
  assert.ok(ms2 < 30000, `o pedido ficou pendurado por ${ms2}ms — o timeout não está funcionando`);
  assert.ok(ms2 > 15000, `voltou rápido demais (${ms2}ms) para ter passado pelo timeout de 20s de verdade`);

  mock2.close();

  console.log("\nTudo certo ✅ (o segundo caso levou de propósito ~20s — é o teto funcionando, não travando)");
} finally {
  servidor.kill("SIGKILL");
  mock.close();
}
