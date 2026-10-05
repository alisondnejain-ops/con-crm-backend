/* "AGORA PRECISA BAIXAR O ÁUDIO PARA OUVIR" (05/10/2026, relato do Ali).

   Com a chave do R2 corrigida, os arquivos da conversa passaram a ir para o
   R2 — e o endereço que vai na mensagem é o de R2_PUBLIC_URL. Se esse
   endereço não abre para quem está de fora, o áudio não toca, a foto aparece
   quebrada e o WhatsApp não consegue buscar o que o corretor mandou.

   Este teste sobe um R2 de MENTIRA (a API S3 que grava e lê) e um "endereço
   público" que pode estar quebrado ou não, e confere:
   1. endereço público quebrado → o arquivo vai para o DISCO (/arquivos), abre,
      e o /integracoes diz o motivo;
   2. o teste de armazenamento não diz "tudo certo" nesse caso;
   3. o arquivo continua podendo ser baixado e apagado;
   4. arrumado o endereço público, a próxima conferência volta para o R2;
   5. o arquivo do R2 abre pelo endereço público.

   Rodar:  npm run teste:r2-publico
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const PASTA = path.join(os.tmpdir(), "concrm-teste-r2-publico");
fs.rmSync(PASTA, { recursive: true, force: true });
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-r2-publico.db");
process.env.UPLOAD_DIR = path.join(PASTA, "uploads");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4681";
process.env.APP_URL = "http://127.0.0.1:4681";
process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "fedcba9876543210fedcba9876543210";
process.env.R2_SECRET_ACCESS_KEY = "a".repeat(64);
process.env.R2_BUCKET = "conhub";
process.env.R2_PUBLIC_URL = "http://127.0.0.1:4683";
process.env.R2_ENDPOINT = "http://127.0.0.1:4682";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== O R2 DE MENTIRA: a API (grava/lê/apaga) e o endereço público =====
const guardados = new Map();
const api = http.createServer((req, res) => {
  const chave = decodeURIComponent(req.url.split("?")[0].replace(/^\/conhub\//, ""));
  const pedacos = [];
  req.on("data", c => pedacos.push(c));
  req.on("end", () => {
    if (req.method === "PUT") { guardados.set(chave, { corpo: Buffer.concat(pedacos), tipo: req.headers["content-type"] }); res.writeHead(200, { ETag: '"x"' }); return res.end(); }
    if (req.method === "DELETE") { guardados.delete(chave); res.writeHead(204); return res.end(); }
    if (req.method === "GET" && guardados.has(chave)) { const g = guardados.get(chave); res.writeHead(200, { "Content-Type": g.tipo }); return res.end(g.corpo); }
    res.writeHead(404); res.end();
  });
});
let publicoAberto = false;
const publico = http.createServer((req, res) => {
  const chave = decodeURIComponent(req.url.slice(1));
  if (!publicoAberto) { res.writeHead(401); return res.end("not authorized"); }
  const g = guardados.get(chave);
  if (!g) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": g.tipo }); res.end(g.corpo);
});
await new Promise(r => api.listen(4682, r));
await new Promise(r => publico.listen(4683, r));

const storage = await import("../src/services/storage.js");
await import("../src/server.js");
await new Promise(r => setTimeout(r, 900));
const BASE = "http://127.0.0.1:4681";
const audio = Buffer.from("OggS-de-mentira-" + "x".repeat(500));

console.log("1. Endereço público do R2 quebrado: o áudio vai para o disco e abre");
await storage.conferirPublicoR2();
assert.equal(storage.publicoR2().ok, false);
assert.match(storage.publicoR2().erro, /HTTP 401/);
const r1 = await storage.salvar({ buffer: audio, mime: "audio/ogg", prefixo: "conversas" });
console.log(`   ${r1.url}`);
assert.ok(r1.url.startsWith(`${BASE}/arquivos/conversas/`), "foi para o disco");
assert.ok(![...guardados.keys()].some(k => k.startsWith("conversas/")), "não foi para o R2");
const aberto = await fetch(r1.url);
assert.equal(aberto.status, 200);
assert.deepEqual(Buffer.from(await aberto.arrayBuffer()), audio);
const diag = await (await fetch(`${BASE}/integracoes`)).json();
console.log(`   /integracoes: ${diag.arquivos.modo}`);
assert.match(diag.arquivos.modo, /endereço público/);
assert.equal(diag.arquivos.endereco_publico_r2.ok, false);

console.log("2. O teste de armazenamento não diz \"tudo certo\"");
const teste = await (await fetch(`${BASE}/integracoes/armazenamento/teste`)).json();
console.log(`   ${teste.passos[0].passo}: ${teste.passos[0].erro}`);
assert.equal(teste.tudo_certo, false);
assert.match(teste.passos[0].dica, /R2_PUBLIC_URL/);

console.log("3. O arquivo do disco se lê de volta e se apaga, mesmo com o R2 ligado");
assert.deepEqual(await storage.bytesParaBaixar(r1.url), audio);
await storage.apagar(r1.chave);
assert.equal((await fetch(r1.url)).status, 404);

console.log("4. Arrumado o endereço público, a próxima conferência volta para o R2");
publicoAberto = true;
await storage.conferirPublicoR2();
assert.equal(storage.publicoR2().ok, true);
const r2 = await storage.salvar({ buffer: audio, mime: "audio/ogg", prefixo: "conversas" });
console.log(`   ${r2.url}`);
assert.ok(r2.url.startsWith("http://127.0.0.1:4683/conversas/"), "foi para o R2");
assert.ok(![...guardados.keys()].some(k => k.startsWith("teste/")), "o arquivinho da conferência foi apagado");

console.log("5. O arquivo do R2 abre pelo endereço público, com o tipo certo");
const doR2 = await fetch(r2.url);
assert.equal(doR2.status, 200);
assert.equal(doR2.headers.get("content-type"), "audio/ogg");

console.log("\nOK — 5 casos.");
process.exit(0);
