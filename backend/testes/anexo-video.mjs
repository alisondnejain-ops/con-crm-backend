/* VÍDEO PRECISA CABER NO CORPO DA REQUISIÇÃO, NÃO SÓ NO ARMAZENAMENTO
   (09/09/2026, relatado pelo Ali: "os vídeos carregam e não vai").

   O upload de anexo sobe em base64 dentro do JSON (`POST /leads/:id/anexo`),
   que cai em `jsonGrande` — 30 MB (server.js). Base64 infla o arquivo em
   ~33%. O limite de vídeo em `storage.js` dizia 60 MB quando o R2 estava
   ligado — e 60 MB em base64 vira ~80 MB, quase o triplo do teto. A
   requisição nunca chegava a verificar `limiteBytes()`: o Express já tinha
   recusado o corpo antes, com uma resposta em texto puro (não JSON) que o
   navegador não sabia interpretar — o corretor via o vídeo "carregando" e
   nada saía, sem nenhuma mensagem de erro.

   Este teste prova as duas metades do conserto:
   1. O limite de vídeo (20 MB) agora cabe dentro do teto de 30 MB depois do
      base64, então um vídeo de tamanho normal nem chega perto do problema.
   2. Se AINDA ASSIM alguém mandar um corpo grande demais, a resposta é um
      413 em JSON legível — não mais um texto que quebra o front.

   Rodar:  npm run teste:anexo-video
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-anexo-video.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4640";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4640";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "AV-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const marina = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(marina, org, "Marina", "marina@av.com", senha, "corretor", Date.now());
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?)`).run(leadId, org, "Cliente", "5587900000000", marina, Date.now());

const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "marina@av.com", password: "123456" }) });
const { token } = await r.json();
assert.ok(token, "login falhou");

const fakeBase64 = (mb) => Buffer.alloc(mb * 1024 * 1024, 1).toString("base64");
const enviar = (base64, mime = "video/mp4") => fetch(`${BASE}/leads/${leadId}/anexo`, {
  method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ arquivos: [{ mime, nome: "video.mp4", base64 }] }),
});

console.log("1. Vídeo de 15MB (tamanho normal de celular) passa da checagem de tamanho");
let resp = await enviar(fakeBase64(15));
let d = await resp.json();
console.log(`   ${resp.status} · ${JSON.stringify(d).slice(0, 120)}`);
assert.notEqual(resp.status, 413, "15MB está dentro do limite de 20MB — não pode ser recusado por tamanho");

console.log("2. Vídeo de 21MB — passou do limite de 20MB, mas cabe no corpo de 30MB: 413 da ROTA, com o motivo escrito");
resp = await enviar(fakeBase64(21));
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 413);
assert.ok(d.error.includes("20 MB"), "a mensagem tem que citar o limite, não ser genérica");

console.log("3. Vídeo de 60MB — o limite ANTIGO (quando havia R2): estoura o teto de 30MB do corpo inteiro");
resp = await enviar(fakeBase64(60));
d = await resp.json().catch(() => null);
console.log(`   ${resp.status} · ${JSON.stringify(d)}`);
assert.equal(resp.status, 413, "tem que recusar, não travar nem devolver 500");
assert.ok(d && d.error, "e a resposta tem que ser JSON legível — não texto puro que o navegador não consegue interpretar");

console.log("4. Sem login, a rota de anexo nem chega a olhar o arquivo");
resp = await fetch(`${BASE}/leads/${leadId}/anexo`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ arquivos: [{ mime: "video/mp4", nome: "video.mp4", base64: fakeBase64(1) }] }) });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 401);

console.log("\nTudo certo ✅");
process.exit(0);
