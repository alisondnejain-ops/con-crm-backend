/* VÍDEO GRANDE SOBE CRU, POR ROTA PRÓPRIA — 150 MB. (14/09/2026, pedido do
   Ali: "aumenta o limite do vídeo para 150mb", depois de explicado o risco
   de fazer isso pelo caminho antigo em base64.)

   `POST /leads/:id/anexo` (a rota antiga) sobe o arquivo como texto dentro
   de um JSON — para 150 MB isso viraria ~200 MB de TEXTO, obrigando o
   servidor a juntar essa string inteira na memória e rodar `JSON.parse`
   nela ANTES de processar qualquer coisa, travando o processo (Node é de
   uma thread só) tempo bastante para atrasar o webhook da Uazapi, que
   desiste de chamar se demorar.

   `POST /leads/:id/anexo/video` evita isso: o corpo é o arquivo CRU (sem
   base64), lido por `express.raw()` — SÓ NESTA ROTA, como middleware de
   rota e não `app.use()` sem caminho (a armadilha de 13/08/2026 documentada
   em CLAUDE.md). `mime`/`nome`/`legenda` vão na query, porque o corpo é só
   o arquivo.

   Este teste sobe o servidor de verdade e confere de fora:
   1. um vídeo de tamanho normal sobe e é registrado na conversa;
   2. um vídeo passando de 150 MB é recusado pela ROTA, com o motivo escrito
      (não pelo teto global do corpo, que para esta rota nem existe — ela
      não usa Content-Type application/json);
   3. só quem pode ver o lead consegue subir vídeo nele (403);
   4. sem login nem chega a olhar o arquivo (401);
   5. mime que não é vídeo é recusado antes de gastar tempo com o arquivo;
   6. o corpo grande NÃO passa pelos limites globais de JSON — a prova é
      mandar mais que o teto de `jsonNormal`/`jsonGrande` (45 MB) com
      Content-Type de vídeo e confirmar que a rota (não o `server.js`)
      responde, com a mensagem certa.

   Rodar:  npm run teste:anexo-video-binario
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-anexo-video-binario.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4642";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4642";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "AV-3", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const marina = "u_" + randomUUID();
const bruno = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(marina, org, "Marina", "marina@av3.com", senha, "corretor", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(bruno, org, "Bruno", "bruno@av3.com", senha, "corretor", Date.now());

const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?)`).run(leadId, org, "Cliente", "5587900000002", marina, Date.now());

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const { token } = await r.json();
  assert.ok(token, "login falhou para " + email);
  return token;
};
const tokenMarina = await login("marina@av3.com");
const tokenBruno = await login("bruno@av3.com");

const enviar = (leadId, bytes, { mime = "video/mp4", nome = "video.mp4", token = tokenMarina, contentType } = {}) => {
  const params = new URLSearchParams({ mime, nome });
  return fetch(`${BASE}/leads/${leadId}/anexo/video?${params}`, {
    method: "POST",
    headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": contentType || mime },
    body: bytes,
  });
};
const fakeBytes = (mb) => Buffer.alloc(mb * 1024 * 1024, 1);

console.log("1. Vídeo de 8MB (tamanho normal) sobe e fica registrado na conversa");
let resp = await enviar(leadId, fakeBytes(8));
let d = await resp.json();
console.log(`   ${resp.status} · ${JSON.stringify(d)}`);
assert.equal(resp.status, 200);
assert.equal(d.enviados, 1);
const msg = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId);
assert.equal(msg.media_mime, "video/mp4");
assert.ok(msg.media_url, "tem que ter gravado a URL do arquivo salvo");

console.log("2. Vídeo de 151MB — passou do limite de 150MB, recusado pela ROTA com o motivo escrito");
resp = await enviar(leadId, fakeBytes(151));
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 413);
assert.ok(d.error.includes("150 MB"), "a mensagem tem que citar o limite, não ser genérica");

console.log("3. Corretor sem acesso a este lead não consegue subir vídeo nele");
resp = await enviar(leadId, fakeBytes(1), { token: tokenBruno });
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 403);

console.log("4. Sem login, a rota nem chega a olhar o arquivo");
resp = await enviar(leadId, fakeBytes(1), { token: null });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 401);

console.log("5. Mime que não é vídeo é recusado antes de processar qualquer coisa");
resp = await enviar(leadId, fakeBytes(1), { mime: "application/pdf" });
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 400);

console.log("6. O corpo grande NÃO passa pelo teto global de JSON — 60MB de vídeo cru chega até a ROTA");
resp = await enviar(leadId, fakeBytes(60));
d = await resp.json().catch(() => null);
console.log(`   ${resp.status} · ${JSON.stringify(d)}`);
// 60MB > 45MB (jsonGrande) mas < 150MB (limite do vídeo): se o corpo global
// estivesse envolvido, isso teria voltado 413 genérico do server.js. Como
// não está, a rota processa normalmente.
assert.equal(resp.status, 200, "60MB deveria passar — está dentro do limite de vídeo e fora do alcance do teto de JSON");

console.log("\nTudo certo ✅");
process.exit(0);
