/* VÍDEO PRECISA CABER NO CORPO DA REQUISIÇÃO, NÃO SÓ NO ARMAZENAMENTO
   (09/09/2026, relatado pelo Ali: "os vídeos carregam e não vai"; limite
   AUMENTADO em 14/09/2026, pedido do Ali depois de continuar ouvindo a
   mesma reclamação mesmo com o conserto de 09/09 no ar).

   O upload de anexo sobe em base64 dentro do JSON (`POST /leads/:id/anexo`),
   que cai em `jsonGrande` — 45 MB (server.js). Base64 infla o arquivo em
   ~33%. O limite de vídeo em `storage.js` é 30 MB — em base64 vira ~40 MB,
   dentro do teto de 45 MB com folga para o resto do JSON. Os dois números
   (limite do ARQUIVO em `storage.js`, limite do CORPO em `server.js`)
   precisam andar sempre juntos: sem isso, a requisição nunca chega a
   verificar `limiteBytes()` — o Express recusa o corpo antes, com uma
   resposta em texto puro (não JSON) que o navegador não sabe interpretar —
   e o corretor vê o vídeo "carregando" com nada saindo, sem erro nenhum.

   Este teste prova as duas metades do conserto:
   1. O limite de vídeo (30 MB) cabe dentro do teto do corpo (45 MB) depois
      do base64, então um vídeo de tamanho normal nem chega perto do problema.
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

console.log("1. Vídeo de 25MB (tamanho de celular, perto do novo limite) passa da checagem de tamanho");
let resp = await enviar(fakeBase64(25));
let d = await resp.json();
console.log(`   ${resp.status} · ${JSON.stringify(d).slice(0, 120)}`);
assert.notEqual(resp.status, 413, "25MB está dentro do limite de 30MB — não pode ser recusado por tamanho");

console.log("2. Vídeo de 31MB — passou do limite de 30MB, mas cabe no corpo de 45MB: 413 da ROTA, com o motivo escrito");
resp = await enviar(fakeBase64(31));
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 413);
assert.ok(d.error.includes("30 MB"), "a mensagem tem que citar o limite, não ser genérica");

console.log("3. Vídeo de 40MB — estoura o teto de 45MB do corpo inteiro depois do base64 (~53MB)");
resp = await enviar(fakeBase64(40));
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
