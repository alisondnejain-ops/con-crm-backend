/* A marca da imobiliária: logo e cor da barra (white-label).

   O que este teste protege:

   - a marca chega JUNTO com a imobiliária no login. Buscá-la depois faria a
     barra nascer verde e trocar de cor um instante depois, em todo login;
   - COR CLARA É RECUSADA, e a recusa vem com a versão escura da mesma cor. A
     barra escreve em branco: cor clara não deixa a barra feia, deixa o menu
     ilegível — e quem escolheu só descobre quando um corretor reclamar;
   - quem escolhe é o GESTOR. A atendente vê a marca (a tela inteira vê), mas
     não troca a identidade visual da imobiliária;
   - uma imobiliária não enxerga nem herda a marca da outra. É a razão de o
     recurso existir.

   Rodar:  npm run teste:marca
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-marca.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4613";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { contrasteComBranco, escurecerAte, validarCor, COR_PADRAO } = await import("../src/services/marca.js");
await import("../src/server.js");
const BASE = "http://localhost:4613";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);

function casa(nome, codigo) {
  const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, nome, codigo, Date.now());
  return id;
}
function pessoa(orgId, nome, role) {
  const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, orgId, nome, nome.toLowerCase() + "@marca.com", senha, role, Date.now());
  return id;
}

const orgA = casa("Imobiliária Alfa", "ALFA-1");
const orgB = casa("Imobiliária Beta", "BETA-1");
pessoa(orgA, "Gestor", "adm");
pessoa(orgA, "Atendente", "sdr");
pessoa(orgB, "Outro", "adm");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@marca.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou: ${JSON.stringify(d)}`);
  return d;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const gestor = await entrar("Gestor"), atendente = await entrar("Atendente"), outro = await entrar("Outro");

console.log("1. Sem escolha nenhuma, a marca é o padrão — e já vem no login");
console.log(`   cor: ${gestor.org.cor} · logo: ${gestor.org.logo}`);
assert.equal(gestor.org.cor, COR_PADRAO, "a cor vem resolvida, não nula");
assert.equal(gestor.org.logo, null);

console.log("2. O gestor escolhe uma cor escura e ela é aceita");
let r = await chamar(gestor.token, "/config/marca", { method: "PATCH", body: JSON.stringify({ cor: "#1B3A6B" }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.cor}`);
assert.equal(r.status, 200);
assert.equal(d.cor, "#1B3A6B");

console.log("3. COR CLARA É RECUSADA, com a versão escura da MESMA cor junto");
/* O menu é escrito em branco. Amarelo não deixa a barra feia — deixa o menu
   invisível, e quem escolheu não descobre na hora. Recusar sem oferecer saída
   faria o gestor desistir da cor da marca dele. */
r = await chamar(gestor.token, "/config/marca", { method: "PATCH", body: JSON.stringify({ cor: "#FFD700" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
console.log(`   sugestão: ${d.sugestao} (contraste ${contrasteComBranco(d.sugestao).toFixed(1)}:1)`);
assert.equal(r.status, 400);
assert.ok(d.sugestao, "a recusa precisa vir com uma saída");
assert.ok(contrasteComBranco(d.sugestao) >= 4.5, "a sugestão tem que passar no contraste");
assert.equal((await (await chamar(gestor.token, "/config/marca")).json()).cor, "#1B3A6B", "a cor recusada não foi gravada");

console.log("4. A sugestão mantém o TOM da cor escolhida");
/* Escurecer não pode virar preto: a marca amarela continua amarela, só mais
   escura. Se o vermelho e o azul saíssem iguais, seria só um preto disfarçado. */
const escura = escurecerAte("#FFD700");
const [rr, gg, bb] = [1, 3, 5].map(i => parseInt(escura.slice(i, i + 2), 16));
console.log(`   #FFD700 → ${escura} (R${rr} G${gg} B${bb})`);
assert.ok(rr > bb && gg > bb, "amarelo escurecido continua amarelo, não vira cinza");

console.log("5. A ATENDENTE vê a marca, mas não troca");
r = await chamar(atendente.token, "/config/marca");
console.log(`   ler: ${r.status} · ${(await r.json()).cor}`);
assert.equal(r.status, 200);
r = await chamar(atendente.token, "/config/marca", { method: "PATCH", body: JSON.stringify({ cor: "#000000" }) });
console.log(`   trocar: ${r.status}`);
assert.equal(r.status, 403, "identidade visual é decisão do gestor");

console.log("6. Uma imobiliária NÃO herda a marca da outra");
/* É a razão de o recurso existir: quem assina o sistema não pode ver a marca
   de outra imobiliária na tela da própria equipe. */
d = await (await chamar(outro.token, "/config/marca")).json();
console.log(`   Beta continua em ${d.cor}`);
assert.equal(d.cor, COR_PADRAO, "a cor da Alfa não vazou para a Beta");

console.log("7. Cor vazia volta ao padrão");
r = await chamar(gestor.token, "/config/marca", { method: "PATCH", body: JSON.stringify({ cor: "" }) });
d = await r.json();
console.log(`   ${r.status} · ${d.cor}`);
assert.equal(d.cor, COR_PADRAO);

console.log("8. Texto que não é cor é recusado");
r = await chamar(gestor.token, "/config/marca", { method: "PATCH", body: JSON.stringify({ cor: "verde" }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("9. A logo entra, e o /auth/me passa a devolvê-la");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
r = await chamar(gestor.token, "/config/marca/logo", { method: "POST",
  body: JSON.stringify({ mime: "image/png", base64: png.toString("base64") }) });
d = await r.json();
console.log(`   ${r.status} · ${d.logo ? "logo guardada" : d.error}`);
assert.equal(r.status, 200);
assert.ok(d.logo, "a logo precisa voltar já com a URL");
const me = await (await chamar(gestor.token, "/auth/me")).json();
assert.ok(me.org.logo, "e chegar junto com a imobiliária, não numa segunda requisição");

console.log("10. Vídeo não é logo");
r = await chamar(gestor.token, "/config/marca/logo", { method: "POST",
  body: JSON.stringify({ mime: "video/mp4", base64: png.toString("base64") }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("11. A atendente não apaga a logo da imobiliária");
r = await chamar(atendente.token, "/config/marca/logo", { method: "DELETE" });
console.log(`   ${r.status}`);
assert.equal(r.status, 403);

console.log("12. O gestor apaga, e a marca volta ao padrão");
d = await (await chamar(gestor.token, "/config/marca/logo", { method: "DELETE" })).json();
console.log(`   logo: ${d.logo} · cor: ${d.cor}`);
assert.equal(d.logo, null);

console.log("13. Sem login, nada");
r = await fetch(`${BASE}/config/marca`);
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("\nTudo certo ✅");
process.exit(0);
