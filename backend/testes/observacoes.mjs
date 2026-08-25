/* Observações do lead: o quadro de recados do atendimento.

   O caso que motivou (pedido do Ali, 22/08/2026) é o REPASSE. A atendente faz
   o primeiro contato, descobre coisas que não cabem em etapa nem em tarefa —
   "só atende depois das 18h", "quem decide é o marido" — e passa o lead
   adiante. Isso se perdia: o corretor começava do zero ou relia quarenta
   mensagens.

   O que este teste protege:

   - a ATENDENTE escreve num lead que já é do CORRETOR. Sem isso o recurso não
     serve para o caso que o criou;
   - o corretor lê e escreve no lead dele;
   - quem não tem o lead não lê nem escreve nada;
   - o recado que a atendente deixou NÃO é apagável pelo corretor — só quem
     escreveu, e a supervisão;
   - a lista vem da mais nova para a mais antiga, com autor.

   Rodar:  npm run teste:observacoes
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-obs.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4611";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4611";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "OBS-1", Date.now());

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@obs.com", senha, role, Date.now());
  return id; };
const vanessa = user("Vanessa", "sdr"), marina = user("Marina", "corretor"), outro = user("Rafael", "corretor");

const lead = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Atendimento',?,?)`).run(lead, org, "Jhennyfer", "5587911110000", marina, Date.now());

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@obs.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const tVanessa = await entrar("Vanessa"), tMarina = await entrar("Marina"), tRafael = await entrar("Rafael");

console.log("1. A ATENDENTE anota num lead que já é do corretor");
/* É o caso que criou o recurso. Se a permissão fosse "só o dono escreve", a
   Vanessa não conseguiria deixar o aviso antes de repassar — e o recurso não
   serviria para nada do que foi pedido. */
let r = await chamar(tVanessa, `/leads/${lead}/observacoes`, { method: "POST",
  body: JSON.stringify({ texto: "Só atende depois das 18h. Quem decide é o marido." }) });
let d = await r.json();
console.log(`   ${r.status} · ${d.observacoes?.length} observação(ões)`);
assert.equal(r.status, 200);
assert.equal(d.observacoes.length, 1);
assert.equal(d.observacoes[0].autor, "Vanessa", "o recado vem assinado");
const daVanessa = d.observacoes[0].id;

console.log("2. O CORRETOR lê o que ela deixou, ao abrir a conversa");
/* Chega junto com o lead, e não numa segunda requisição: a faixa acima da
   conversa precisa aparecer no mesmo instante em que a conversa abre. */
r = await chamar(tMarina, `/leads/${lead}`);
d = await r.json();
console.log(`   ${d.observacoes.length} na abertura do lead: "${d.observacoes[0].texto.slice(0, 32)}…"`);
assert.equal(d.observacoes.length, 1);
assert.ok(/depois das 18h/.test(d.observacoes[0].texto));

console.log("3. O corretor também anota, e a mais nova vem primeiro");
await chamar(tMarina, `/leads/${lead}/observacoes`, { method: "POST",
  body: JSON.stringify({ texto: "Liguei 14/08, pediu para chamar semana que vem." }) });
d = await (await chamar(tMarina, `/leads/${lead}/observacoes`)).json();
console.log(`   ${d.observacoes.map(o => o.autor).join(" → ")}`);
assert.equal(d.observacoes.length, 2);
assert.equal(d.observacoes[0].autor, "Marina", "a mais recente no topo");
const daMarina = d.observacoes[0].id;

console.log("4. Quem NÃO tem o lead não lê nem escreve");
r = await chamar(tRafael, `/leads/${lead}/observacoes`);
console.log(`   ler: ${r.status}`);
assert.equal(r.status, 403);
r = await chamar(tRafael, `/leads/${lead}/observacoes`, { method: "POST", body: JSON.stringify({ texto: "não devia entrar" }) });
console.log(`   escrever: ${r.status}`);
assert.equal(r.status, 403);
assert.equal((await (await chamar(tMarina, `/leads/${lead}/observacoes`)).json()).observacoes.length, 2, "nada foi criado");

console.log("5. Observação vazia é recusada");
r = await chamar(tMarina, `/leads/${lead}/observacoes`, { method: "POST", body: JSON.stringify({ texto: "   " }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("6. O corretor NÃO apaga o recado que a atendente deixou para ele");
r = await chamar(tMarina, `/leads/${lead}/observacoes/${daVanessa}`, { method: "DELETE" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 403);

console.log("7. Mas apaga a dele");
r = await chamar(tMarina, `/leads/${lead}/observacoes/${daMarina}`, { method: "DELETE" });
d = await r.json();
console.log(`   ${r.status} · sobrou ${d.observacoes.length}: ${d.observacoes[0].autor}`);
assert.equal(r.status, 200);
assert.equal(d.observacoes.length, 1);
assert.equal(d.observacoes[0].autor, "Vanessa");

console.log("8. E a supervisão apaga qualquer uma");
r = await chamar(tVanessa, `/leads/${lead}/observacoes/${daVanessa}`, { method: "DELETE" });
d = await r.json();
console.log(`   ${r.status} · sobrou ${d.observacoes.length}`);
assert.equal(r.status, 200);
assert.equal(d.observacoes.length, 0);

console.log("9. Sem login, nada");
r = await fetch(`${BASE}/leads/${lead}/observacoes`);
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("\nTudo certo ✅");
process.exit(0);
