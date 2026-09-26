/* "FALHA AO ENVIAR PELO WHATSAPP — the number 5587996695813@s.whatsapp.net
   is not on WhatsApp" (26/09/2026, print da Vanessa).

   O CRM grava todo celular COM o 9 (55 87 99669-5813), mas quem tem WhatsApp
   desde antes da mudança do nono dígito continua registrado SEM ele
   (55 87 9669-5813). Quando o cliente escreve primeiro a Uazapi acha o
   contato; quando a imobiliária fala primeiro com um lead digitado na mão, o
   envio falhava.

   Este teste sobe uma Uazapi de MENTIRA que só aceita a forma sem o 9 e
   confere:
   1. o envio passa (tenta com o 9, recusou "not on WhatsApp", tenta sem);
   2. o segundo envio para o mesmo número vai direto na forma que funcionou;
   3. número que não existe em nenhuma das formas volta com erro em
      português, citando as duas;
   4. outro tipo de erro NÃO dispara a segunda tentativa (não pode virar
      mensagem duplicada para o cliente);
   5. o telefone do lead agora se corrige pela ficha (PATCH /leads/:id/telefone),
      com as mesmas regras do cadastro manual.

   Rodar:  npm run teste:nono-digito
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-nono-digito.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4651";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== A UAZAPI DE MENTIRA =====
const recebidos = [];
const SO_SEM_9 = "558796695813";          // o cliente da Vanessa: registrado sem o 9
const INEXISTENTE = ["5587911112222", "558711112222"];
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => (corpo += c));
  req.on("end", () => {
    const b = JSON.parse(corpo || "{}");
    recebidos.push(b.number);
    const responder = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (b.number === "5587933334444") return responder(400, { error: "instance busy" });
    if (b.number === SO_SEM_9) return responder(200, { messageid: "wa_" + recebidos.length });
    return responder(500, { error: `the number ${b.number}@s.whatsapp.net is not on WhatsApp` });
  });
});
await new Promise(r => mock.listen(4652, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4651";
await new Promise(r => setTimeout(r, 700));
const { sendText } = await import("../src/services/uazapi.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)")
  .run(org, "Casa", "ND-1", Date.now(), "http://127.0.0.1:4652", "tok");

console.log("1. Número gravado COM o 9, WhatsApp registrado SEM: o envio passa");
recebidos.length = 0;
const r1 = await sendText({ orgId: org, toPhone: "5587996695813", text: "oi" });
console.log(`   tentativas: ${recebidos.join(" → ")}`);
assert.ok(r1.ok);
assert.deepEqual(recebidos, ["5587996695813", SO_SEM_9]);

console.log("2. O segundo envio vai direto na forma que funcionou");
recebidos.length = 0;
await sendText({ orgId: org, toPhone: "5587996695813", text: "de novo" });
console.log(`   tentativas: ${recebidos.join(" → ")}`);
assert.deepEqual(recebidos, [SO_SEM_9]);

console.log("3. Número que não existe em forma nenhuma: erro em português, citando as duas");
recebidos.length = 0;
let erro = "";
try { await sendText({ orgId: org, toPhone: INEXISTENTE[0], text: "oi" }); } catch (e) { erro = e.message; }
console.log(`   "${erro}"`);
assert.deepEqual(recebidos, INEXISTENTE);
assert.match(erro, /não está no WhatsApp/);
assert.match(erro, /\(87\) 91111-2222/);
assert.match(erro, /\(87\) 1111-2222/);

console.log("4. Outro erro NÃO tenta de novo (senão o cliente poderia receber duas vezes)");
recebidos.length = 0;
erro = "";
try { await sendText({ orgId: org, toPhone: "5587933334444", text: "oi" }); } catch (e) { erro = e.message; }
console.log(`   tentativas: ${recebidos.join(" → ")} · "${erro}"`);
assert.deepEqual(recebidos, ["5587933334444"]);
assert.match(erro, /instance busy/);

console.log("5. O telefone se corrige pela ficha, com as regras do cadastro manual");
const bcrypt = (await import("bcryptjs")).default;
const gestor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo')`).run(gestor, org, "Ali", "ali@nd.com", bcrypt.hashSync("123456", 8), Date.now());
const lead = (tel) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at) VALUES (?,?,?,?,'{}','Lead',?)")
    .run(id, org, "Cliente " + tel.slice(-4), tel, Date.now()); return id; };
const a = lead("5587911110000"), b = lead("5587922220000");
const token = (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "ali@nd.com", password: "123456" }) })).json()).token;
const corrigir = (id, telefone) => fetch(`${BASE}/leads/${id}/telefone`, { method: "PATCH",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ telefone }) });
let r = await corrigir(a, "(87) 9 9669-5813");
console.log(`   corrigido → ${r.status} ${JSON.stringify(await r.json())}`);
assert.equal(r.status, 200);
assert.equal(db.prepare("SELECT phone FROM leads WHERE id=?").get(a).phone, "5587996695813", "grava no formato do WhatsApp");
r = await corrigir(a, "123");
assert.equal(r.status, 400, "número sem DDD é recusado");
r = await corrigir(b, "87 99669-5813");
const dup = await r.json();
console.log(`   repetido → ${r.status} "${dup.error}"`);
assert.equal(r.status, 409, "número de outro lead é recusado");
assert.equal(dup.lead_id, a);

console.log("\nTudo certo ✅");
mock.close();
process.exit(0);
