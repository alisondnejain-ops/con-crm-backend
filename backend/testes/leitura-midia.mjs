/* A LEITURA DOS ÁUDIOS E DAS FOTOS DO CLIENTE (11/11/2026,
   services/leitura-midia.js).

   Tudo com servidores de mentira: um que serve o áudio e a foto (como a
   Uazapi), um de transcrição no formato da OpenAI e uma IA no formato da
   Anthropic. Os arquivos são de verdade (gerados pelo ffmpeg e pelo sharp),
   porque o áudio passa pelo ffmpeg antes de sair e a foto pelo sharp.

   1. Áudio do cliente que chega pelo webhook é transcrito sozinho, e a
      transcrição fica na mensagem.
   2. O que vai ao serviço de transcrição é MP3, com o modelo e o vocabulário.
   3. Foto do cliente é descrita pela IA, com a imagem no pedido.
   4. A leitura chega à IA no lugar do rótulo (resumo da conversa).
   5. A ficha devolve a leitura; a gestão desliga a leitura automática.
   6. Desligada, nada é lido sozinho; "Transcrever" na conversa lê na hora.
   7. Quem não pode abrir a conversa não pede a leitura (403).
   8. Falha do serviço fica escrita, e tentar de novo funciona.
   9. Falar com o Claude por áudio: /assistente/transcrever devolve o texto.
   10. Sem a chave de transcrição, o áudio não é lido e a sessão diz isso.

   Rodar:  npm run teste:leitura-midia */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";

process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-leitura-midia.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4841";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
process.env.ANTHROPIC_BASE_URL = "http://localhost:4842";
process.env.TRANSCRICAO_API_KEY = "chave-transcricao-teste";
process.env.TRANSCRICAO_URL = "http://localhost:4842/v1/audio/transcriptions";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// Arquivos de verdade.
const ffmpeg = (await import("ffmpeg-static")).default;
const sharp = (await import("sharp")).default;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leitura-midia-"));
const ogg = path.join(tmp, "a.ogg");
execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", ogg]);
const AUDIO = fs.readFileSync(ogg);
const FOTO = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3a7" } }).png().toBuffer();

let transcricoes = [], perguntas = [], falharTranscricao = false;
const mock = http.createServer((req, res) => {
  const pedacos = [];
  req.on("data", c => pedacos.push(c));
  req.on("end", () => {
    const corpo = Buffer.concat(pedacos);
    if (req.method === "GET" && req.url.startsWith("/audio")) { res.writeHead(200, { "content-type": "audio/ogg" }); return res.end(AUDIO); }
    if (req.method === "GET" && req.url.startsWith("/foto")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(FOTO); }
    if (req.url === "/v1/audio/transcriptions") {
      transcricoes.push({ auth: req.headers.authorization, tipo: req.headers["content-type"], corpo: corpo.toString("latin1") });
      if (falharTranscricao) { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "fora do ar" } })); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: "Oi, quero visitar o apartamento no sábado de manhã, tenho FGTS." }));
    }
    if (req.url === "/v1/messages") {
      const p = JSON.parse(corpo.toString("utf8"));
      perguntas.push(p);
      const temImagem = JSON.stringify(p.messages).includes('"type":"image"');
      const texto = temImagem ? "Fachada de uma casa térrea verde, com portão de garagem." : JSON.stringify({ situacao: "Cliente quer visitar no sábado." });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ content: [{ type: "text", text: texto }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => mock.listen(4842, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4841";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_leitura";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Lua", "LUA-1", Date.now());
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at) VALUES (?,?,'imobiliaria','','token-lua',1,?)`).run("c_lua", org, Date.now());
let n = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, nome, nome.toLowerCase() + "@lua.com", senha, role, Date.now() + (++n));
  return id; };
pessoa("Gestora", "adm"); const marina = pessoa("Marina", "corretor"); const rafael = pessoa("Rafael", "corretor");
const lead = db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at,assigned_to,assigned_at,qual_json) VALUES (?,?,?,?,?,?,?,?,'{}')`);
const L = "l_" + randomUUID(); lead.run(L, org, "Cliente Lua", "5587991110000", "Lead", Date.now() - 60000, marina, Date.now() - 60000);

const entrar = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("gestora@lua.com"), tM = await entrar("marina@lua.com"), tR = await entrar("rafael@lua.com");

const entregar = (msg) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "token-lua", message: { chatid: "5587991110000@s.whatsapp.net", sender: "5587991110000@s.whatsapp.net",
    fromMe: false, senderName: "Cliente Lua", ...msg } }) });
const esperarAte = async (fn, ms = 8000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return fn(); };
const msgDe = (wa) => db.prepare("SELECT * FROM messages WHERE wa_id = ?").get(wa);

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }

console.log("Leitura de áudios e fotos");
await caso("1. Áudio do cliente pelo webhook é transcrito sozinho", async () => {
  await entregar({ messageid: "3EB0AUDIO1", messageType: "audioMessage", content: { URL: "http://localhost:4842/audio.ogg", mimetype: "audio/ogg; codecs=opus" } });
  const m = await esperarAte(() => { const x = msgDe("3EB0AUDIO1"); return x && x.leitura ? x : null; });
  assert.ok(m, "a mensagem tem a transcrição");
  assert.match(m.leitura, /visitar o apartamento/);
});

await caso("2. O que vai à transcrição é MP3, com o modelo e o vocabulário", async () => {
  const t = transcricoes[0];
  assert.ok(t, "chamou o serviço");
  assert.equal(t.auth, "Bearer chave-transcricao-teste");
  assert.match(t.tipo, /multipart\/form-data/);
  assert.match(t.corpo, /filename="audio.mp3"/);
  assert.match(t.corpo, /audio\/mpeg/);
  assert.match(t.corpo, /gpt-4o-transcribe/);
  assert.match(t.corpo, /financiamento/);
});

await caso("3. Foto do cliente é descrita pela IA, com a imagem no pedido", async () => {
  await entregar({ messageid: "3EB0FOTO1", messageType: "imageMessage", content: { URL: "http://localhost:4842/foto.png", mimetype: "image/png", caption: "essa aqui" } });
  const m = await esperarAte(() => { const x = msgDe("3EB0FOTO1"); return x && x.leitura ? x : null; });
  assert.ok(m, "a foto tem leitura");
  assert.match(m.leitura, /casa térrea/);
  const p = perguntas.find(x => JSON.stringify(x.messages).includes('"type":"image"'));
  assert.ok(p, "a imagem foi no pedido");
  const img = p.messages[0].content.find(c => c.type === "image");
  assert.equal(img.source.media_type, "image/jpeg", "a foto vai em JPEG");
  assert.ok(JSON.stringify(p.messages).includes("essa aqui"), "a legenda vai junto");
});

await caso("4. A leitura chega à IA no lugar do rótulo (resumo da conversa)", async () => {
  perguntas = [];
  const r = await chamar(tM, `/leads/${L}/resumo`, "POST");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const pedido = JSON.stringify(perguntas.at(-1));
  assert.ok(pedido.includes("(áudio transcrito) Oi, quero visitar"), "a transcrição vai no lugar de \"Áudio\"");
  assert.ok(pedido.includes("(foto: Fachada de uma casa"), "a descrição vai no lugar de \"Foto\"");
});

await caso("5. A ficha devolve a leitura; só a gestão mexe na leitura automática", async () => {
  const f = await chamar(tM, `/leads/${L}`);
  const m = f.d.messages.find(x => x.leitura && /visitar/.test(x.leitura));
  assert.ok(m, "a conversa traz a transcrição");
  const me = await chamar(tM, "/auth/me");
  assert.deepEqual(me.d.org.leitura_midia, { audio: true, imagem: true });
  assert.equal((await chamar(tM, "/distribution/leitura", "PATCH", { automatico: false })).status, 403);
  const g = await chamar(tG, "/distribution/leitura", "PATCH", { automatico: false });
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.equal(g.d.automatico, false);
});

await caso("6. Desligada, nada é lido sozinho; \"Transcrever\" lê na hora", async () => {
  const antes = transcricoes.length;
  await entregar({ messageid: "3EB0AUDIO2", messageType: "audioMessage", content: { URL: "http://localhost:4842/audio2.ogg", mimetype: "audio/ogg" } });
  const m = await esperarAte(() => msgDe("3EB0AUDIO2"));
  await new Promise(r => setTimeout(r, 800));
  assert.equal(transcricoes.length, antes, "não chamou a transcrição");
  assert.equal(msgDe("3EB0AUDIO2").leitura, null);
  const r = await chamar(tM, `/leads/${L}/messages/${m.id}/ler`, "POST");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.match(r.d.leitura, /visitar/);
});

await caso("7. Quem não pode abrir a conversa não pede a leitura", async () => {
  const m = msgDe("3EB0AUDIO2");
  const r = await chamar(tR, `/leads/${L}/messages/${m.id}/ler`, "POST");
  assert.equal(r.status, 403, JSON.stringify(r.d));
});

await caso("8. Falha do serviço fica escrita, e tentar de novo funciona", async () => {
  await entregar({ messageid: "3EB0AUDIO3", messageType: "audioMessage", content: { URL: "http://localhost:4842/audio3.ogg", mimetype: "audio/ogg" } });
  const m = await esperarAte(() => msgDe("3EB0AUDIO3"));
  falharTranscricao = true;
  const r1 = await chamar(tM, `/leads/${L}/messages/${m.id}/ler`, "POST");
  assert.equal(r1.status, 422, JSON.stringify(r1.d));
  assert.match(msgDe("3EB0AUDIO3").leitura_erro, /transcrição falhou/);
  falharTranscricao = false;
  const r2 = await chamar(tM, `/leads/${L}/messages/${m.id}/ler`, "POST");
  assert.equal(r2.status, 200, JSON.stringify(r2.d));
  assert.equal(msgDe("3EB0AUDIO3").leitura_erro, null);
});

await caso("9. Falar com o Claude por áudio: /assistente/transcrever devolve o texto", async () => {
  const r = await fetch(BASE + "/assistente/transcrever", { method: "POST", headers: { authorization: "Bearer " + tG, "content-type": "audio/ogg" }, body: AUDIO });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.match(d.texto, /visitar/);
  const vazio = await fetch(BASE + "/assistente/transcrever", { method: "POST", headers: { authorization: "Bearer " + tG, "content-type": "audio/ogg" }, body: Buffer.alloc(10) });
  assert.equal(vazio.status, 400);
  const semLogin = await fetch(BASE + "/assistente/transcrever", { method: "POST", headers: { "content-type": "audio/ogg" }, body: AUDIO });
  assert.equal(semLogin.status, 401);
});

await caso("10. Sem a chave de transcrição, o áudio não é lido e a sessão diz isso", async () => {
  delete process.env.TRANSCRICAO_API_KEY;
  const me = await chamar(tM, "/auth/me");
  assert.equal(me.d.org.leitura_midia.audio, false);
  const m = msgDe("3EB0AUDIO2");
  db.prepare("UPDATE messages SET leitura = NULL WHERE id = ?").run(m.id);
  const r = await chamar(tM, `/leads/${L}/messages/${m.id}/ler`, "POST");
  assert.equal(r.status, 422);
  assert.match(r.d.error, /não está ligada/);
  const v = await fetch(BASE + "/assistente/transcrever", { method: "POST", headers: { authorization: "Bearer " + tG, "content-type": "audio/ogg" }, body: AUDIO });
  assert.equal(v.status, 503);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s)` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
