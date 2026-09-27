/* MARKETING — A ESTRUTURA DO DISPARO EM MASSA (27/09/2026).

   Antes de existir envio, o que protege o ConHub: liberação por conta, termo
   com aceite registrado, número de disparo separado, lista com declaração de
   origem (comprada é recusada) e arquivo original guardado, e a lista de
   bloqueio de quem pediu para sair.

   Rodar:  npm run teste:marketing-estrutura
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-marketing.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4655";
process.env.UAZAPI_ACEITAR_POR_NUMERO = "";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== UAZAPI DE MENTIRA: cada token é uma instância com um número =====
const DONO_DO_TOKEN = { "tok-disparo": "5587988887777", "tok-mesmo-numero": "5587911112222" };
const mock = http.createServer((req, res) => {
  const tk = req.headers.token;
  res.writeHead(DONO_DO_TOKEN[tk] ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(DONO_DO_TOKEN[tk]
    ? { instance: { status: "connected", owner: DONO_DO_TOKEN[tk] }, status: { connected: true, loggedIn: true } }
    : { error: "token inválido" }));
});
await new Promise(r => mock.listen(4656, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { TERMO_HASH, TERMO_VERSAO } = await import("../src/services/marketing.js");
const BASE = "http://localhost:4655";
const MOCK = "http://127.0.0.1:4656";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome, extra = {}) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "MK-" + id.slice(4), Date.now(), extra.wa || "");
  return id; };
const pessoa = (org, nome, role, extra = {}) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@mk.com", senha, role, Date.now(), extra.master ? 1 : 0);
  return id; };

const casaConHub = novaOrg("ConHub");
const ali = pessoa(casaConHub, "Ali", "adm", { master: true });
const orgA = novaOrg("Imobiliária A", { wa: "5587911112222" });
const gestora = pessoa(orgA, "Gestora", "adm");
pessoa(orgA, "Corretor", "corretor");
// A linha da casa, que recebe os leads — o token mora em par nas duas tabelas,
// como no sistema de verdade (services/canais.js → garantirCasa).
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ? WHERE id = ?").run(MOCK, "tok-casa-A", orgA);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,wa_number,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,?,1,?)`)
  .run("c_" + randomUUID(), orgA, MOCK, "tok-casa-A", "5587911112222", Date.now());
const orgB = novaOrg("Imobiliária B");
pessoa(orgB, "OutroGestor", "adm");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@mk.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login ${nome}: ${JSON.stringify(d)}`); return d.token;
}
const chamar = async (token, caminho, metodo = "GET", corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const tGestora = await entrar("Gestora"), tCorretor = await entrar("Corretor"), tAli = await entrar("Ali");
const tOutro = await entrar("OutroGestor");
const csv = (linhas) => ({ nome: "lista.csv", base64: Buffer.from(linhas.join("\n")).toString("base64") });
const ontem = (() => { const d = new Date(Date.now() - 86400000); return d.toISOString().slice(0, 10); })();
const listaBoa = (arquivo, extra = {}) => ({ nome: "Clientes antigos", origem: "conversaram", coletado_em: ontem,
  declaracao: true, arquivo, ...extra });

console.log("1. Desligado por padrão: nada funciona e o menu não mostra");
let r = await chamar(tGestora, "/marketing");
assert.equal(r.status, 200); assert.equal(r.d.liberado, false);
assert.equal((await chamar(tGestora, "/marketing/listas")).status, 403);
assert.equal((await chamar(tGestora, "/auth/me")).d.org.marketing_liberado, false);

console.log("2. Só o master libera, e a liberação aparece na conta");
assert.equal((await chamar(tGestora, `/orgs/${orgA}/marketing`, "POST", { liberado: true })).status, 403);
r = await chamar(tAli, `/orgs/${orgA}/marketing`, "POST", { liberado: true });
assert.equal(r.status, 200); assert.equal(r.d.org.marketing_liberado, true);
assert.equal((await chamar(tGestora, "/auth/me")).d.org.marketing_liberado, true);

console.log("3. Corretor não entra no Marketing");
assert.equal((await chamar(tCorretor, "/marketing")).status, 403);

console.log("4. Sem termo aceito, lista e número são recusados");
assert.equal((await chamar(tGestora, "/marketing/listas", "POST", listaBoa(csv(["telefone", "87999990001"])))).status, 409);
assert.equal((await chamar(tGestora, "/marketing/numero", "PUT", { host: MOCK, token: "tok-disparo" })).status, 409);

console.log("5. O master, de dentro da conta do cliente, NÃO aceita pelo cliente");
const tAliNaA = (await chamar(tAli, `/orgs/${orgA}/entrar`, "POST")).d.token;
r = await chamar(tAliNaA, "/marketing/termo", "POST", { aceito: true });
console.log(`   ${r.status} "${r.d.error}"`);
assert.equal(r.status, 403);
assert.equal((await chamar(tAliNaA, "/marketing")).d.termo.pode_aceitar, false);

console.log("6. A gestora aceita: fica registrado quem, quando, de onde e qual texto");
assert.equal((await chamar(tGestora, "/marketing/termo", "POST", {})).status, 400, "sem marcar, não aceita");
r = await chamar(tGestora, "/marketing/termo", "POST", { aceito: true });
assert.equal(r.status, 200);
assert.equal(r.d.termo.aceite.por, "Gestora");
const aceite = db.prepare("SELECT * FROM marketing_termos WHERE org_id = ?").get(orgA);
assert.equal(aceite.texto_hash, TERMO_HASH); assert.equal(aceite.versao, TERMO_VERSAO);
assert.ok(aceite.ip, "o endereço de internet fica gravado");
assert.equal(aceite.user_email, "gestora@mk.com");

console.log("7. Número de disparo: o da casa é recusado, o separado é aceito");
r = await chamar(tGestora, "/marketing/numero", "PUT", { host: MOCK, token: "tok-casa-A" });
console.log(`   mesmo token da casa → ${r.status}`); assert.equal(r.status, 409);
r = await chamar(tGestora, "/marketing/numero", "PUT", { host: MOCK, token: "tok-mesmo-numero" });
console.log(`   outra instância, mas no número da casa → ${r.status}`); assert.equal(r.status, 409);
r = await chamar(tGestora, "/marketing/numero", "PUT", { host: MOCK, token: "tok-disparo" });
console.log(`   número separado → ${r.status} ${JSON.stringify(r.d.numero)}`);
assert.equal(r.status, 200); assert.equal(r.d.numero.conectado, true);
assert.ok(!JSON.stringify(r.d).includes("tok-disparo"), "o token volta mascarado, nunca inteiro");

console.log("8. Lista sem origem honesta é recusada");
const arq = csv(["nome;telefone", "Ana;(87) 99999-0001"]);
r = await chamar(tGestora, "/marketing/listas", "POST", listaBoa(arq, { origem: "comprada" }));
console.log(`   comprada → ${r.status} "${r.d.error.slice(0, 60)}…"`); assert.equal(r.status, 422);
assert.equal((await chamar(tGestora, "/marketing/listas", "POST", listaBoa(arq, { declaracao: false }))).status, 400);
assert.equal((await chamar(tGestora, "/marketing/listas", "POST", listaBoa(arq, { origem: "outra" }))).status, 400, "outra origem exige descrição");
assert.equal((await chamar(tGestora, "/marketing/listas", "POST", listaBoa(arq, { coletado_em: "2099-01-01" }))).status, 400);
assert.equal(db.prepare("SELECT COUNT(*) n FROM marketing_listas").get().n, 0, "nenhuma recusa deixou lista para trás");

console.log("9. Lista válida: conta o que entrou e guarda o original byte a byte");
const linhas = ["nome;telefone", "Ana;(87) 99999-0001", "Bia;87 9999-0002", "Caio;123", "Ana de novo;5587999990001",
  "Duda;87999990004"];
const arquivoOk = csv(linhas);
r = await chamar(tGestora, "/marketing/listas", "POST", listaBoa(arquivoOk));
console.log(`   ${r.status} ${JSON.stringify({ validos: r.d.lista?.validos, invalidos: r.d.lista?.invalidos, repetidos: r.d.lista?.repetidos })}`);
assert.equal(r.status, 201);
assert.equal(r.d.lista.validos, 3); assert.equal(r.d.lista.invalidos, 1); assert.equal(r.d.lista.repetidos, 1);
const listaId = r.d.lista.id;
const original = Buffer.from(arquivoOk.base64, "base64");
r = await chamar(tGestora, `/marketing/listas/${listaId}/arquivo`);
assert.equal(Buffer.from(r.d.base64, "base64").toString(), original.toString());
assert.equal(r.d.hash, createHash("sha256").update(original).digest("hex"));
assert.equal((await chamar(tOutro, `/marketing/listas/${listaId}/arquivo`)).status, 403, "outra imobiliária sem marketing liberado nem chega");
await chamar(tAli, `/orgs/${orgB}/marketing`, "POST", { liberado: true });
assert.equal((await chamar(tOutro, `/marketing/listas/${listaId}/arquivo`)).status, 404, "e liberada, não enxerga a lista de outra conta");

console.log("10. \"SAIR\" de quem está na lista bloqueia; conversa comum não");
const webhook = (tel, texto, id) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-casa-A", message: { chatid: tel + "@s.whatsapp.net", fromMe: false, messageid: id,
    messageType: "conversation", text: texto, senderName: "Cliente" } }) });
await webhook("5587999990001", "vou sair do trabalho às 18h", "w1");
await webhook("5587999990001", "SAIR", "w2");
await webhook("5587955554444", "sair", "w3");   // não está em lista nenhuma
await new Promise(r => setTimeout(r, 600));
const bloqueio = (await chamar(tGestora, "/marketing/bloqueio")).d;
console.log(`   bloqueados: ${bloqueio.itens.map(i => `${i.telefone} (${i.motivo})`).join(", ")}`);
assert.equal(bloqueio.total, 1);
assert.equal(bloqueio.itens[0].telefone, "5587999990001");
assert.ok(db.prepare("SELECT COUNT(*) n FROM messages WHERE wa_id = 'w2'").get().n === 1, "a mensagem SAIR continua entrando na conversa");

console.log("11. Quem pediu para sair fica de fora da próxima lista — mesmo sem o nono dígito");
r = await chamar(tGestora, "/marketing/listas", "POST", listaBoa(csv(["telefone", "87 9999-0001", "87999990009"]), { nome: "Nova" }));
assert.equal(r.status, 201); assert.equal(r.d.lista.bloqueados, 1); assert.equal(r.d.lista.validos, 1);

console.log("12. Bloqueio na mão; número inválido é recusado");
assert.equal((await chamar(tGestora, "/marketing/bloqueio", "POST", { telefone: "12" })).status, 400);
r = await chamar(tGestora, "/marketing/bloqueio", "POST", { telefone: "(87) 99999-0004" });
assert.equal(r.d.total, 2);

console.log("13. Arquivar tira os contatos de uso e mantém a prova");
r = await chamar(tGestora, `/marketing/listas/${listaId}/arquivar`, "POST");
assert.equal(r.status, 200);
assert.equal(db.prepare("SELECT COUNT(*) n FROM marketing_contatos WHERE lista_id = ?").get(listaId).n, 0);
assert.equal((await chamar(tGestora, `/marketing/listas/${listaId}/arquivo`)).status, 200, "o original continua baixável");

console.log("14. Termo com versão nova exige novo aceite");
db.prepare("UPDATE marketing_termos SET versao = '0 — antiga' WHERE org_id = ?").run(orgA);
r = await chamar(tGestora, "/marketing");
assert.equal(r.d.termo.aceite, null); assert.equal(r.d.termo.versao_anterior, "0 — antiga");
assert.equal((await chamar(tGestora, "/marketing/listas")).status, 409);
await chamar(tGestora, "/marketing/termo", "POST", { aceito: true });
assert.equal(db.prepare("SELECT COUNT(*) n FROM marketing_termos WHERE org_id = ?").get(orgA).n, 2, "o aceite antigo nunca é apagado");

console.log("15. Desligar esconde e trava, mas não apaga nada");
await chamar(tAli, `/orgs/${orgA}/marketing`, "POST", { liberado: false });
assert.equal((await chamar(tGestora, "/marketing")).d.liberado, false);
assert.equal((await chamar(tGestora, "/marketing/listas")).status, 403);
assert.ok(db.prepare("SELECT COUNT(*) n FROM marketing_listas WHERE org_id = ?").get(orgA).n === 2);
assert.ok(db.prepare("SELECT COUNT(*) n FROM marketing_bloqueio WHERE org_id = ?").get(orgA).n === 2);

console.log("\nTudo certo ✅");
mock.close();
process.exit(0);
