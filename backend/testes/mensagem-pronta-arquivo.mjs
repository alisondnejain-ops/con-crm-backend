/* MENSAGEM PRONTA COM ARQUIVO (30/10/2026, lista do Fernando).

   1. Gestão e atendente anexam; corretor não; tipo fora da lista é recusado.
   2. A lista traz o arquivo junto da mensagem.
   3. Na conversa, quem pode abrir o lead manda o arquivo: sai pela Uazapi como
      o anexo de sempre e entra na conversa com o autor. Outro corretor não manda.
   4. Tirar o arquivo deixa a mensagem só com o texto.

   Rodar:  npm run teste:mensagem-pronta-arquivo */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-pronta-arquivo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4655";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const enviados = [];
const uaz = http.createServer((req, res) => { let c = ""; req.on("data", d => c += d); req.on("end", () => {
  let j = {}; try { j = JSON.parse(c || "{}"); } catch {}
  if (req.url.startsWith("/send/")) enviados.push({ url: req.url, ...j });
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ messageid: "wa_pr_" + enviados.length })); }); });
await new Promise(r => uaz.listen(4656, r));
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { sign } = await import("../src/auth.js");
await new Promise(r => setTimeout(r, 700));
const org = db.prepare("SELECT id FROM orgs WHERE demo IS NULL OR demo = 0 ORDER BY created_at LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token='tok' WHERE id=?").run("http://127.0.0.1:4656", org);
const user = (id, nome, role) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, id + "@pa.com", role, Date.now());
user("u_g", "Gestora", "adm"); user("u_a", "Vanessa", "sdr"); user("u_m", "Marina", "corretor"); user("u_r", "Rafael", "corretor");
const lead = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to) VALUES (?,?,?,?,'{}','Atendimento',?,?)`)
  .run(lead, org, "Cliente", "5587991230011", Date.now(), "u_m");
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch("http://localhost:4655" + p, { method: metodo, headers: { authorization: "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(quem)), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const PDF = "data:application/pdf;base64," + Buffer.from("%PDF-1.4 teste").toString("base64");
let r = await api("u_g", "POST", "/config/mensagens", { titulo: "Apresentação", corpo: "Oi {nome}, segue a apresentação!" });
const mid = r.body.mensagens.find(m => m.titulo === "Apresentação").id;
r = await api("u_m", "POST", `/config/mensagens/${mid}/midia`, { base64: PDF, mime: "application/pdf", nome: "apresentacao.pdf" });
assert.equal(r.status, 403, "corretor não anexa");
r = await api("u_g", "POST", `/config/mensagens/${mid}/midia`, { base64: PDF, mime: "application/x-msdownload", nome: "virus.exe" });
assert.equal(r.status, 400, "tipo fora da lista");
r = await api("u_a", "POST", `/config/mensagens/${mid}/midia`, { base64: PDF, mime: "application/pdf", nome: "apresentacao.pdf" });
assert.equal(r.status, 200, JSON.stringify(r.body));
let m = r.body.mensagens.find(x => x.id === mid);
assert.equal(m.midia_nome, "apresentacao.pdf"); assert.ok(m.midia_url);
const lista = (await api("u_m", "GET", "/config/mensagens")).body.mensagens;
assert.ok(lista.find(x => x.id === mid).midia_url, "o corretor recebe o arquivo na lista");
r = await api("u_r", "POST", `/leads/${lead}/pronta/${mid}`, {});
assert.equal(r.status, 403, "outro corretor não manda");
r = await api("u_m", "POST", `/leads/${lead}/pronta/${mid}`, {});
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(enviados.length, 1); assert.match(enviados[0].url, /\/send\/media/);
const msg = db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out'").get(lead);
assert.equal(msg.from_user_id, "u_m"); assert.equal(msg.media_name, "apresentacao.pdf");
r = await api("u_g", "DELETE", `/config/mensagens/${mid}/midia`);
assert.equal(r.body.mensagens.find(x => x.id === mid).midia_url, null);
r = await api("u_m", "POST", `/leads/${lead}/pronta/${mid}`, {});
assert.equal(r.status, 400, "sem arquivo não há o que mandar");
console.log("Mensagem pronta com arquivo: tudo certo ✅");
uaz.close(); process.exit(0);
