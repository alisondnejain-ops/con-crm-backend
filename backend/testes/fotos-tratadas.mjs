/* TRATAMENTO AUTOMÁTICO DAS FOTOS DOS IMÓVEIS (12/10/2026).

   Confere, com o servidor de pé e imagens geradas aqui mesmo:
   1. a foto enviada é girada conforme o celular gravou e regravada SEM os
      metadados (a localização do celular sai junto);
   2. nascem as versões leves (WebP) e a miniatura vai para a tela;
   3. os avisos — pequena, escura, desfocada, em pé — aparecem quando devem,
      e uma foto boa não ganha aviso nenhum;
   4. o foco do recorte segue o assunto da foto;
   5. a capa sugerida e o "usar como capa";
   6. o site monta <img> com srcset e o foco;
   7. as fotos ANTIGAS são tratadas pelo batimento, o arquivo antigo some, e
      foto que não abre fica anotada e não é tentada de novo;
   8. apagar a foto apaga as versões junto.

   Rodar:  npm run teste:fotos-tratadas
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "concrm-fotos-"));
process.env.DB_PATH = path.join(DIR, "teste.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4671";
process.env.FOTOS_AGENDADOR = "0";

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const sharp = (await import("sharp")).default;
await import("../src/server.js");
const { tratarFotosPendentes } = await import("../src/services/fotos-imovel.js");
const BASE = "http://localhost:4671";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Foto", "FT-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run("u_" + randomUUID(), org, "Gestora", "g@ft1.com", bcrypt.hashSync("123456", 8), "adm", Date.now());
const { token } = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "g@ft1.com", password: "123456" }) })).json();
const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = (p, opts = {}) => fetch(`${BASE}${p}`, { ...opts, headers: auth }).then(async r => ({ status: r.status, body: await r.json() }));

/* Uma "foto" com bastante detalhe (para não parecer desfocada) e um objeto
   vermelho em destaque em (ox, oy). */
async function cena({ w = 1600, h = 1066, fundo = "#9bb", ox = 0.5, oy = 0.5, escura = false } = {}) {
  const blocos = Array.from({ length: 70 }, (_, i) =>
    `<rect x='${(i * 97) % w}' y='${(i * 53) % h}' width='${30 + (i % 7) * 18}' height='${25 + (i % 5) * 22}' fill='hsl(${i * 37},45%,${35 + (i % 4) * 12}%)' opacity='.55'/>`).join("");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='${fundo}'/>${blocos}
    <circle cx='${w * ox}' cy='${h * oy}' r='${Math.min(w, h) * 0.12}' fill='#e11'/><text x='40' y='${h - 40}' font-size='${Math.round(h / 14)}' fill='#111'>Sala ampla com varanda</text></svg>`;
  let img = sharp(Buffer.from(svg));
  if (escura) img = img.linear(0.18, 0);
  return img.jpeg({ quality: 90 }).toBuffer();
}
const b64 = (buf) => "data:image/jpeg;base64," + buf.toString("base64");
const arquivo = (url) => path.join(process.env.UPLOAD_DIR, decodeURIComponent(url.replace(/^.*\/arquivos\//, "")));

let r = await api("/produtos", { method: "POST", body: JSON.stringify({ tipo: "casa", formato: "solta", titulo: "Casa com varanda", cidade: "Petrolina", bairro: "Centro", valor: 350000 }) });
assert.equal(r.status, 200);
const pid = r.body.id;
const subir = (buf) => api(`/produtos/${pid}/midias`, { method: "POST", body: JSON.stringify({ mime: "image/jpeg", base64: b64(buf) }) });

console.log("1. Foto girada pelo celular e com localização: sai em pé do jeito certo e sem metadados");
// 1600x1066 com orientação 6 = o celular segurou em pé: a foto certa tem 1066 de largura.
const comGps = await sharp(await cena({ ox: 0.8, oy: 0.3 }))
  .withExif({ IFD3: { GPSLatitudeRef: "S", GPSLatitude: "9/1 23/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "40/1 30/1 0/1" } })
  .withMetadata({ orientation: 6 })
  .jpeg().toBuffer();
{ const m = await sharp(comGps).metadata();
  assert.ok(m.exif && m.orientation === 6, "a foto de teste precisa entrar COM metadados e girada"); }
r = await subir(comGps);
assert.equal(r.status, 200, JSON.stringify(r.body));
const m1 = r.body.midia;
const salvo = fs.readFileSync(arquivo(m1.url));
const meta = await sharp(salvo).metadata();
console.log(`   guardada ${meta.width}×${meta.height} ${meta.format}, exif: ${meta.exif ? "SIM" : "não"}`);
assert.equal(meta.format, "jpeg");
assert.equal(meta.width, 1066); assert.equal(meta.height, 1600);
assert.ok(!meta.exif, "a localização do celular (EXIF) não pode ficar no arquivo");
assert.ok(m1.miniatura && /\.webp$/.test(m1.miniatura), "a miniatura leve vai para a tela");
assert.ok(m1.avisos.some(a => a.tipo === "em_pe"), "foto em pé ganha o aviso");

console.log("2. As versões leves existem, são WebP e menores que o original");
const linha1 = db.prepare("SELECT * FROM produto_midias WHERE id = ?").get(m1.id);
const variantes = JSON.parse(linha1.variantes);
console.log(`   ${variantes.map(v => v.l).join(", ")}px`);
assert.deepEqual(variantes.map(v => v.l), [480, 960, 1066], "não aumenta além da largura da foto");
for (const v of variantes) {
  const b = fs.readFileSync(arquivo(v.url));
  assert.equal((await sharp(b).metadata()).format, "webp");
}
assert.ok(fs.statSync(arquivo(variantes[0].url)).size < salvo.length / 3, "a miniatura é bem mais leve que a foto inteira");

console.log("3. Foto boa e deitada não ganha aviso; o foco segue o objeto à direita");
r = await subir(await cena({ ox: 0.85, oy: 0.5 }));
const boa = r.body.midia;
const linhaBoa = db.prepare("SELECT * FROM produto_midias WHERE id = ?").get(boa.id);
console.log(`   avisos: ${JSON.stringify(boa.avisos)} · foco ${linhaBoa.foco_x}% ${linhaBoa.foco_y}% · nota ${linhaBoa.nota} · nitidez ${linhaBoa.nitidez ?? "-"}`);
assert.deepEqual(boa.avisos, []);
assert.ok(linhaBoa.foco_x > 60, "o recorte anda para a direita, onde está o objeto");

console.log("4. Escura, pequena e desfocada ganham o aviso certo");
r = await subir(await cena({ escura: true }));
assert.deepEqual(r.body.midia.avisos.map(a => a.tipo), ["escura"], "escura, e só: pouco contraste não pode virar 'desfocada'");
r = await subir(await cena({ w: 600, h: 400 }));
assert.ok(r.body.midia.avisos.some(a => a.tipo === "pequena"), JSON.stringify(r.body.midia.avisos));
r = await subir(await sharp(await cena()).blur(9).jpeg().toBuffer());
assert.ok(r.body.midia.avisos.some(a => a.tipo === "desfocada"), JSON.stringify(r.body.midia.avisos));

console.log("5. A capa (foto em pé) perde para a foto boa: sugestão e 'usar como capa'");
r = await api(`/produtos/${pid}`);
console.log(`   capa sugerida: ${r.body.capa_sugerida === boa.id ? "a foto boa" : r.body.capa_sugerida}`);
assert.equal(r.body.capa_sugerida, boa.id);
r = await api(`/produtos/${pid}/midias/${boa.id}/capa`, { method: "POST" });
assert.equal(r.status, 200);
assert.equal(r.body.midias.filter(m => m.tipo === "foto")[0].id, boa.id, "a foto escolhida vira a primeira");
assert.equal(r.body.capa_sugerida, null, "com a melhor na capa, não sobra sugestão");
assert.equal(r.body.midias.filter(m => m.tipo === "foto")[1].id, m1.id, "as outras descem uma posição, na ordem em que estavam");

console.log("6. O site monta a foto com as versões leves e o foco");
r = await api("/site", { method: "PATCH", body: JSON.stringify({ ligado: true, whatsapp: "(87) 99999-0000" }) });
assert.equal(r.status, 200, JSON.stringify(r.body));
const slug = (await api("/site")).body.slug;
const html = await (await fetch(`${BASE}/imoveis/${slug}`)).text();
assert.ok(/srcset="[^"]+\.webp 480w/.test(html), "a vitrine usa srcset com as versões WebP");
assert.ok(new RegExp(`object-position:${linhaBoa.foco_x}% `).test(html), "o card centra no foco da foto");
const pagina = await (await fetch(`${BASE}/imoveis/${slug}/${pid}/casa`)).text();
assert.ok(/srcset=/.test(pagina) && /sizes="/.test(pagina), "a página do imóvel também");

console.log("7. Fotos antigas: o batimento trata, troca o arquivo e apaga o velho; a que não abre fica anotada");
const velhoChave = `produtos/${pid}/antiga-com-gps.jpg`;
fs.mkdirSync(path.dirname(path.join(process.env.UPLOAD_DIR, velhoChave)), { recursive: true });
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, velhoChave), comGps);
const quebradaChave = `produtos/${pid}/quebrada.jpg`;
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, quebradaChave), Buffer.from("isto não é uma imagem"));
db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,chave,ordem,created_at) VALUES (?,?,?,?,?,?,?)")
  .run("m_velha", pid, "foto", `/arquivos/${velhoChave}`, velhoChave, 9, Date.now() - 1000);
db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,chave,ordem,created_at) VALUES (?,?,?,?,?,?,?)")
  .run("m_quebrada", pid, "foto", `/arquivos/${quebradaChave}`, quebradaChave, 10, Date.now() - 2000);
const res = await tratarFotosPendentes(5);
console.log(`   ${JSON.stringify(res)}`);
assert.deepEqual(res, { tratadas: 1, falhas: 1 });
const velha = db.prepare("SELECT * FROM produto_midias WHERE id = 'm_velha'").get();
assert.notEqual(velha.chave, velhoChave);
assert.ok(!fs.existsSync(path.join(process.env.UPLOAD_DIR, velhoChave)), "o arquivo antigo, com a localização, é apagado");
assert.ok(!(await sharp(fs.readFileSync(arquivo(velha.url))).metadata()).exif);
const quebrada = db.prepare("SELECT * FROM produto_midias WHERE id = 'm_quebrada'").get();
assert.ok(quebrada.tratamento_erro, "a que não abre fica com o motivo");
assert.deepEqual(await tratarFotosPendentes(5), { tratadas: 0, falhas: 0 }, "e não é tentada de novo");

console.log("8. Apagar a foto apaga as versões junto");
const arquivos = [m1.url, ...variantes.map(v => v.url)].map(arquivo);
assert.ok(arquivos.every(a => fs.existsSync(a)));
r = await api(`/produtos/${pid}/midias/${m1.id}`, { method: "DELETE" });
assert.equal(r.status, 200);
await new Promise(res => setTimeout(res, 200));
assert.ok(arquivos.every(a => !fs.existsSync(a)), "nenhum arquivo da foto sobra no armazenamento");

console.log("\nTudo certo ✅");
process.exit(0);
