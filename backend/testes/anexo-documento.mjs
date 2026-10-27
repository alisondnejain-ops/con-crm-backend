/* DOCUMENTO PELO CLIPE DA CONVERSA (27/10/2026, relato de cliente: "não consigo
   enviar arquivo pelo chat"). O clipe só tinha foto, vídeo e áudio, e o
   servidor recusava o resto. Uazapi de mentira; o que se confere:
   1. PDF sai como `document`, com o nome do arquivo, e entra na conversa;
   2. Word sem ser PDF também;
   3. tipo fora da lista (executável) é recusado com a frase do que dá;
   4. mais de 5 documentos de uma vez é recusado;
   5. documento acima de 30 MB é recusado (e um de 9 MB, acima do teto de foto, passa);
   6. quem não pode abrir a conversa não envia.

   Rodar:  npm run teste:anexo-documento
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-anexo-documento.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4661";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const envios = [];
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => (corpo += c));
  req.on("end", () => {
    try { envios.push({ caminho: req.url, ...JSON.parse(corpo || "{}") }); } catch { envios.push({ caminho: req.url }); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messageid: "wa_" + envios.length }));
  });
});
await new Promise(r => mock.listen(4662, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4661";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)")
  .run(org, "Casa", "DOC-1", Date.now(), "http://127.0.0.1:4662", "tok");
const usuario = (email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, email.split("@")[0], email, bcrypt.hashSync("123456", 8), role, Date.now()); return id; };
const corretora = usuario("marina@doc.com", "corretor");
usuario("rafael@doc.com", "corretor");
const lead = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Lead',?,?)")
  .run(lead, org, "Cliente", "5587991110000", Date.now(), corretora);

const login = async (email) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const marina = await login("marina@doc.com"), rafael = await login("rafael@doc.com");
const anexar = async (token, arquivos, texto) => {
  const r = await fetch(`${BASE}/leads/${lead}/anexo`, { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ arquivos, texto }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const arquivo = (nome, mime, bytes = 2000) => ({ nome, mime, base64: Buffer.alloc(bytes, 7).toString("base64") });
const PDF = "application/pdf", DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

console.log("1. PDF sai como documento, com o nome, e entra na conversa");
envios.length = 0;
let r = await anexar(marina, [arquivo("Simulação Caixa.pdf", PDF)], "Segue a simulação");
assert.equal(r.status, 200, JSON.stringify(r.body));
const media = envios.find(e => e.caminho === "/send/media");
assert.equal(media.type, "document");
assert.equal(media.docName, "Simulação Caixa.pdf");
assert.match(media.text, /Segue a simulação/);
const msg = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC").get(lead);
assert.equal(msg.media_mime, PDF);
assert.equal(msg.media_name, "Simulação Caixa.pdf");
assert.match(msg.media_url, /\.pdf$/);

console.log("2. Word também");
r = await anexar(marina, [arquivo("Contrato.docx", DOCX)]);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(envios.at(-1).type, "document");

console.log("3. Executável é recusado, dizendo o que dá para mandar");
r = await anexar(marina, [arquivo("virus.exe", "application/x-msdownload")]);
assert.equal(r.status, 400);
assert.match(r.body.error, /PDF, Word, Excel/);

console.log("4. Mais de 5 documentos de uma vez é recusado");
r = await anexar(marina, Array.from({ length: 6 }, (_, i) => arquivo(`d${i}.pdf`, PDF)));
assert.equal(r.status, 400);
assert.match(r.body.error, /Máximo de 5 documentos/);

console.log("5. Documento de 9 MB passa; acima de 30 MB é recusado");
r = await anexar(marina, [arquivo("Grande.pdf", PDF, 9 * 1024 * 1024)]);
assert.equal(r.status, 200, JSON.stringify(r.body));
r = await anexar(marina, [arquivo("Enorme.pdf", PDF, 31 * 1024 * 1024)]);
assert.equal(r.status, 413);
assert.match(r.body.error, /30 MB/);

console.log("6. Quem não pode abrir a conversa não envia");
r = await anexar(rafael, [arquivo("x.pdf", PDF)]);
assert.equal(r.status, 403);

console.log("\nTudo certo ✅");
mock.close();
process.exit(0);
