/* VÍDEO EM HEVC VIRA H.264 ANTES DE IR PRO WHATSAPP. (14/09/2026, relatado
   pelo Ali: "o vídeo que estão tentando enviar é em formato HEVC e não tá
   carregando; preciso que suporte mais formatos".)

   HEVC é o padrão de gravação do iPhone desde o iOS 11, e o WhatsApp só
   aceita mensagem de vídeo em H.264/AAC — o CRM sempre aceitou o arquivo
   (o filtro só olha "começa com video/"), mas quem recusava era o
   WhatsApp do outro lado, em silêncio. `services/video.js` → `garantirH264`
   resolve isso, chamado dentro de `POST /leads/:id/anexo/video`.

   Este teste sobe o servidor de verdade, gera vídeos H.264 e HEVC de
   propósito (com o próprio `ffmpeg-static` que virou dependência do
   projeto) e confere de fora:
   1. vídeo HEVC é aceito, convertido, e o que fica salvo é H.264 de
      verdade — não só "a rota respondeu 200", mas o ARQUIVO no disco
      tem o codec certo, conferido com o mesmo ffprobe;
   2. vídeo que já é H.264 NÃO é reconvertido — o arquivo salvo é
      BYTE A BYTE igual ao original (o caminho comum tem que ser rápido,
      sem trabalho desnecessário);
   3. arquivo que não é vídeo de verdade (bytes aleatórios com mime de
      vídeo) é recusado com uma mensagem clara, não crash nem pendura;
   4. o diagnóstico em /integracoes diz que a conversão está disponível.

   Rodar:  npm run teste:video-hevc
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-video-hevc.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4643";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { pastaLocal } = await import("../src/services/storage.js");
const ffmpegPath = (await import("ffmpeg-static")).default;
const ffprobeStatic = (await import("ffprobe-static")).default;
await import("../src/server.js");
const BASE = "http://localhost:4643";
await new Promise(r => setTimeout(r, 700));

// Gera vídeos de teste minúsculos (1s, 64x64) com o mesmo ffmpeg que o
// servidor usa — sem depender de um arquivo de exemplo versionado no repo.
const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "concrm-video-teste-"));
function gerar(nome, codec, ext) {
  const destino = path.join(dirTmp, nome + ext);
  const r = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
    "-c:v", codec, "-pix_fmt", "yuv420p", destino]);
  if (r.status !== 0) throw new Error("falha ao gerar vídeo de teste: " + r.stderr.toString().slice(-300));
  return fs.readFileSync(destino);
}
function codecDe(buffer) {
  const arq = path.join(dirTmp, "probe-" + randomUUID());
  fs.writeFileSync(arq, buffer);
  const r = spawnSync(ffprobeStatic.path, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name", "-of", "csv=p=0", arq]);
  fs.unlinkSync(arq);
  return r.stdout.toString().trim();
}
const videoH264 = gerar("h264", "libx264", ".mp4");
const videoHevc = gerar("hevc", "libx265", ".mov");
console.log(`Vídeos de teste gerados: h264=${videoH264.length}B, hevc=${videoHevc.length}B`);

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "AV-4", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const marina = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(marina, org, "Marina", "marina@av4.com", senha, "corretor", Date.now());
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?)`).run(leadId, org, "Cliente", "5587900000003", marina, Date.now());

const r0 = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "marina@av4.com", password: "123456" }) });
const { token } = await r0.json();
assert.ok(token, "login falhou");

const enviar = (bytes, { mime = "video/mp4", nome = "video.mp4" } = {}) => {
  const params = new URLSearchParams({ mime, nome });
  return fetch(`${BASE}/leads/${leadId}/anexo/video?${params}`, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": mime }, body: bytes,
  });
};
// Lê de volta o arquivo salvo no disco a partir da media_url gravada na
// última mensagem — prova o que ficou de verdade, não só o que a rota disse.
const arquivoSalvo = () => {
  const msg = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId);
  const chave = msg.media_url.replace(/^.*\/arquivos\//, "");
  return { msg, bytes: fs.readFileSync(path.join(pastaLocal(), chave)) };
};

console.log("1. Vídeo HEVC (.mov) é aceito, convertido, e o ARQUIVO SALVO já é H.264 de verdade");
let resp = await enviar(videoHevc, { mime: "video/quicktime", nome: "IMG_0001.MOV" });
let d = await resp.json();
console.log(`   ${resp.status} · ${JSON.stringify(d)}`);
assert.equal(resp.status, 200);
assert.equal(d.convertido, true, "tinha que ter convertido — o vídeo de teste é HEVC de propósito");
let { msg, bytes } = arquivoSalvo();
assert.equal(msg.media_mime, "video/mp4");
assert.match(msg.media_name, /\.mp4$/, "o nome tem que virar .mp4 — o conteúdo mudou, o nome não podia continuar .MOV");
const codecSalvo = codecDe(bytes);
console.log(`   codec do arquivo salvo: ${codecSalvo}`);
assert.equal(codecSalvo, "h264", "o arquivo GRAVADO tem que ser h264 de verdade, não só a resposta dizer 'convertido'");

console.log("2. Vídeo que JÁ é H.264 não é reconvertido — arquivo salvo é IGUAL ao original, byte a byte");
resp = await enviar(videoH264, { mime: "video/mp4", nome: "video.mp4" });
d = await resp.json();
console.log(`   ${resp.status} · ${JSON.stringify(d)}`);
assert.equal(resp.status, 200);
assert.equal(d.convertido, false, "vídeo já em h264 não devia passar pela conversão");
({ bytes } = arquivoSalvo());
assert.ok(bytes.equals(videoH264), "o arquivo salvo tinha que ser EXATAMENTE o que foi enviado — sem reencode");

console.log("3. Bytes aleatórios com mime de vídeo — recusado com mensagem clara, não crash");
resp = await enviar(Buffer.from("isto não é um vídeo, são só palavras".repeat(50)), { mime: "video/mp4", nome: "falso.mp4" });
d = await resp.json();
console.log(`   ${resp.status} · ${d.error}`);
assert.equal(resp.status, 422);
assert.ok(d.error && d.error.length > 10, "tem que explicar o motivo, não só falhar");

console.log("4. O diagnóstico em /integracoes diz que a conversão está disponível");
resp = await fetch(`${BASE}/integracoes`);
d = await resp.json();
console.log(`   conversao_video: ${JSON.stringify(d.conversao_video)}`);
assert.equal(d.conversao_video.configurado, true);

fs.rmSync(dirTmp, { recursive: true, force: true });
console.log("\nTudo certo ✅");
process.exit(0);
