/* VÍDEO DE IMÓVEL, PELA ROTA PRÓPRIA — 150 MB, com conversão HEVC→H.264.
   (23/09/2026, relatado pelo Ali: "vídeo não tá carregando na sessão de
   imóveis", achado numa reauditoria completa do sistema.)

   `POST /produtos/:id/midias` (a rota antiga, ainda usada por foto) tratava
   vídeo do mesmo jeito que foto: base64 dentro do JSON, preso ao teto de
   `limiteBytes()` — 30 MB, pensado para foto/áudio, nunca atualizado quando
   o upload de vídeo de CONVERSA ganhou rota binária de 150 MB com conversão
   de HEVC (09/09, 14/09×2). Vídeo de imóvel ficou para trás: o navegador
   lia e codificava o arquivo inteiro em base64 ANTES de mandar — minutos em
   4G — só para levar um 413 no fim. Do lado do corretor isso é indistinguível
   de "carrega e não vai".

   `POST /produtos/:id/midias/video` é o mesmo desenho já provado em
   `POST /leads/:id/anexo/video` (messages.routes.js, ver teste:anexo-video-
   binario e teste:video-hevc): corpo CRU via `express.raw()` só nesta rota
   (nunca `app.use()` sem caminho — a armadilha de 13/08/2026), sem base64,
   sem `JSON.parse` de string gigante travando o processo; HEVC vira H.264
   antes de salvar, porque quem recusa em silêncio vídeo HEVC é o WhatsApp do
   outro lado, quando o corretor manda o imóvel pro cliente.

   Este teste sobe o servidor de verdade e confere de fora:
   1. um vídeo H.264 de verdade sobe, fica registrado no produto, e o
      restante de mídia é contado certo;
   2. um vídeo HEVC de verdade é convertido para H.264 antes de salvar —
      confirmado lendo o ARQUIVO DE VOLTA com `ffprobe`, não só a resposta
      da rota;
   3. vídeo passando de 150 MB é recusado pela ROTA, com o limite escrito;
   4. o limite de 1 vídeo por imóvel (LIMITES.casa.video) é respeitado —
      um segundo vídeo no mesmo produto é recusado com 409;
   5. quem não pode editar o produto (não é o captador nem supervisiona) não
      consegue subir vídeo nele;
   6. sem login, a rota nem chega a olhar o arquivo;
   7. mime que não é vídeo é recusado antes de processar;
   8. produto inexistente devolve 404 com a mensagem certa (não "sem
      permissão", que manda procurar o erro no lugar errado).

   Rodar:  npm run teste:produto-video
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-produto-video.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4648";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const ffmpegPath = (await import("ffmpeg-static")).default;
const ffprobePath = (await import("ffprobe-static")).default.path;
await import("../src/server.js");
const BASE = "http://localhost:4648";
await new Promise(r => setTimeout(r, 700));

const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "concrm-produto-video-teste-"));

function gerarVideo(nome, codec) {
  const arq = path.join(dirTmp, nome);
  const args = ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5"];
  if (codec === "hevc") args.push("-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", arq);
  else args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", arq);
  const r = spawnSync(ffmpegPath, args);
  if (r.status !== 0) throw new Error(`falha ao gerar vídeo ${codec}: ` + r.stderr.toString().slice(-400));
  return arq;
}
function codecDoArquivo(arq) {
  const r = spawnSync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", arq]);
  return r.stdout.toString().trim();
}

const arqH264 = gerarVideo("normal.mp4", "h264");
const arqHevc = gerarVideo("iphone.mov", "hevc");
assert.equal(codecDoArquivo(arqH264), "h264", "o gerador de teste tem que produzir h264 de verdade");
assert.equal(codecDoArquivo(arqHevc), "hevc", "o gerador de teste tem que produzir hevc de verdade");
const videoH264 = fs.readFileSync(arqH264);
const videoHevc = fs.readFileSync(arqHevc);

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "PV-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const gestor = "u_" + randomUUID();
const corretor = "u_" + randomUUID();
const outroCorretor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(gestor, org, "Fernanda", "fernanda@pv1.com", senha, "adm", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(corretor, org, "Bruno", "bruno@pv1.com", senha, "corretor", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(outroCorretor, org, "Marina", "marina@pv1.com", senha, "corretor", Date.now());

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const { token } = await r.json();
  assert.ok(token, "login falhou para " + email);
  return token;
};
const tokenGestor = await login("fernanda@pv1.com");
const tokenCorretor = await login("bruno@pv1.com");
const tokenOutro = await login("marina@pv1.com");
const authGestor = { authorization: "Bearer " + tokenGestor, "content-type": "application/json" };

// Produto cadastrado pelo próprio corretor (é ele quem tem permissão de
// editar/subir mídia, junto do gestor) — mesma régua de `podeEditar`.
let r = await fetch(`${BASE}/produtos`, { method: "POST", headers: { authorization: "Bearer " + tokenCorretor, "content-type": "application/json" },
  body: JSON.stringify({ tipo: "casa", formato: "solta", titulo: "Casa 3 quartos no Jardim Amazonas", cidade: "Petrolina", valor: 300000 }) });
let produto = await r.json();
assert.equal(r.status, 200);
const produtoId = produto.id;

const enviar = (id, bytes, { mime = "video/mp4", token = tokenCorretor } = {}) => {
  const params = new URLSearchParams({ mime });
  return fetch(`${BASE}/produtos/${id}/midias/video?${params}`, {
    method: "POST",
    headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": mime },
    body: bytes,
  });
};
const fakeBytes = (mb) => Buffer.alloc(mb * 1024 * 1024, 1);

console.log("1. Vídeo H.264 de verdade sobe, fica registrado no produto, e o restante é contado certo");
r = await enviar(produtoId, videoH264);
let d = await r.json();
console.log(`   ${r.status} · ${JSON.stringify(d)}`);
assert.equal(r.status, 200);
assert.equal(d.midia.tipo, "video");
assert.equal(d.restantes, 0, "casa aceita 1 vídeo — depois deste, zero restam");
const midiaSalva = db.prepare("SELECT * FROM produto_midias WHERE produto_id=? AND tipo='video'").get(produtoId);
assert.ok(midiaSalva, "tem que ter gravado a linha de mídia");
assert.ok(midiaSalva.chave, "tem que ter guardado a chave do armazenamento");

console.log("2. HEVC (padrão do iPhone) é convertido para H.264 antes de salvar — confirmado lendo o arquivo de volta");
// Apaga o vídeo do teste 1 para abrir vaga (limite de 1 vídeo por casa).
await fetch(`${BASE}/produtos/${produtoId}/midias/${midiaSalva.id}`, { method: "DELETE", headers: authGestor });
r = await enviar(produtoId, videoHevc, { mime: "video/quicktime" });
d = await r.json();
console.log(`   ${r.status} · ${JSON.stringify(d)}`);
assert.equal(r.status, 200);
const midiaHevc = db.prepare("SELECT * FROM produto_midias WHERE id=?").get(d.midia.id);
assert.ok(midiaHevc.url.endsWith(".mp4"), "o nome do arquivo salvo tem que ter virado .mp4, não .mov");

// Sem UPLOAD_DIR/R2 configurados, salvar() usa disco ao lado do DB_PATH — o
// mesmo caminho que storage.js calcula sozinho (PASTA).
const pastaUploads = path.join(path.dirname(process.env.DB_PATH), "uploads");
const arqBaixado = path.join(pastaUploads, midiaHevc.chave);
assert.ok(fs.existsSync(arqBaixado), `o arquivo tem que existir em disco: ${arqBaixado}`);
const codecFinal = codecDoArquivo(arqBaixado);
console.log(`   codec salvo em disco: ${codecFinal}`);
assert.equal(codecFinal, "h264", "o arquivo que ficou salvo tem que ser H.264 de verdade, não HEVC");

console.log("3. Vídeo de 151MB é recusado pela ROTA, citando o limite de 150MB");
r = await enviar(produtoId, fakeBytes(151));
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 413);
assert.ok(d.error.includes("150 MB"));

console.log("4. Limite de 1 vídeo por casa: um segundo vídeo no mesmo produto é recusado com 409");
r = await enviar(produtoId, videoH264);
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.ok(d.error.includes("Limite"));

console.log("5. Corretor que não captou nem supervisiona não sobe vídeo neste produto");
r = await enviar(produtoId, videoH264, { token: tokenOutro });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 403);

console.log("6. Sem login, a rota nem chega a olhar o arquivo");
r = await enviar(produtoId, videoH264, { token: null });
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("7. Mime que não é vídeo é recusado antes de processar");
r = await enviar(produtoId, videoH264, { mime: "application/pdf" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 400);

console.log("8. Produto inexistente devolve 404 com mensagem própria (não \"sem permissão\")");
r = await enviar("p_inexistente", videoH264);
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 404);
assert.ok(/não encontrado/i.test(d.error));

fs.rmSync(dirTmp, { recursive: true, force: true });
console.log("\nTudo certo ✅");
process.exit(0);
