/* BAIXAR ANEXO DA CONVERSA — PELO SERVIDOR, NÃO PELA URL DA MÍDIA.
   (14/09/2026, relatado pelo Ali: o botão de baixar abria o arquivo numa aba
   em vez de baixar, para foto, áudio e documento.)

   A causa era `fetch()` direto na URL pública do arquivo. No disco funciona
   (mesma origem do CRM); no Cloudflare R2 é outro domínio, sem cabeçalho de
   CORS, e o navegador bloqueia o fetch antes do JS conseguir ler a resposta
   — caindo sempre no `window.open`. O conserto é uma rota própria,
   `GET /leads/:id/anexo/:messageId/baixar`, sempre na MESMA origem do CRM: o
   navegador fala com o servidor, e é o servidor (imune a CORS) quem busca o
   arquivo de onde ele estiver.

   Este teste sobe o servidor de verdade, em modo disco (sem variáveis R2 no
   ambiente de teste — é o mesmo caminho que `bytesDoArquivo` usa para R2,
   só troca o transporte), e confere a rota de fora:
   1. baixa de verdade — o corpo devolvido é IGUAL ao arquivo original;
   2. os cabeçalhos dizem "baixe" (attachment) e não "abra" (inline);
   3. só quem pode ver o lead baixa (403 para quem não pode);
   4. sem login nem chega a olhar o arquivo (401);
   5. mensagem sem mídia ou id inexistente devolve 404, nunca 500;
   6. `chaveDaUrl` também sabe voltar de uma URL no formato do R2 (mesmo sem
      credencial real — é só a parte de interpretar o endereço).

   Rodar:  npm run teste:baixar-anexo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-baixar-anexo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4641";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { salvar, chaveDaUrl } = await import("../src/services/storage.js");
await import("../src/server.js");
const BASE = "http://localhost:4641";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "AV-2", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const marina = "u_" + randomUUID();
const bruno = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(marina, org, "Marina", "marina@av2.com", senha, "corretor", Date.now());
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(bruno, org, "Bruno", "bruno@av2.com", senha, "corretor", Date.now());

const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?)`).run(leadId, org, "Cliente", "5587900000001", marina, Date.now());

// Um "documento" de verdade gravado no disco de teste, como o WhatsApp manda.
const conteudo = Buffer.from("comprovante de renda — conteúdo de teste 12345");
const { url, chave } = await salvar({ buffer: conteudo, mime: "application/pdf", prefixo: "conversas" });
const msgId = "m_" + randomUUID();
db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(msgId, leadId, "out", marina, "Marina", "Documento", url, "application/pdf", "comprovante.pdf", Date.now());

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const { token } = await r.json();
  assert.ok(token, "login falhou para " + email);
  return token;
};
const tokenMarina = await login("marina@av2.com");
const tokenBruno = await login("bruno@av2.com");

console.log("1. Corretor dono do lead baixa o arquivo — corpo idêntico ao original");
let resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgId}/baixar`, { headers: { authorization: "Bearer " + tokenMarina } });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 200);
const corpo = Buffer.from(await resp.arrayBuffer());
assert.ok(corpo.equals(conteudo), "o arquivo baixado tem que ser byte a byte igual ao que foi enviado");

console.log("2. Os cabeçalhos mandam BAIXAR, não abrir — Content-Disposition: attachment, com o nome");
const disposicao = resp.headers.get("content-disposition") || "";
console.log(`   Content-Disposition: ${disposicao}`);
assert.ok(disposicao.includes("attachment"), "sem attachment o navegador pode abrir em vez de baixar");
assert.ok(disposicao.includes("comprovante.pdf"), "o nome do arquivo tem que estar no cabeçalho");
assert.equal(resp.headers.get("content-type"), "application/pdf");
assert.equal(resp.headers.get("x-content-type-options"), "nosniff");

console.log("3. Corretor sem acesso a este lead recebe 403 — não baixa o documento de outro");
resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgId}/baixar`, { headers: { authorization: "Bearer " + tokenBruno } });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 403);

console.log("4. Sem login, nem chega a olhar o arquivo");
resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgId}/baixar`);
console.log(`   ${resp.status}`);
assert.equal(resp.status, 401);

console.log("5. Mensagem inexistente — 404, nunca 500");
resp = await fetch(`${BASE}/leads/${leadId}/anexo/m_nao_existe/baixar`, { headers: { authorization: "Bearer " + tokenMarina } });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 404);

console.log("6. Mensagem sem mídia (só texto) — 404, não tenta baixar nada");
const msgTexto = "m_" + randomUUID();
db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
  VALUES (?,?,?,?,?,?,?)`).run(msgTexto, leadId, "out", marina, "Marina", "oi", Date.now());
resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgTexto}/baixar`, { headers: { authorization: "Bearer " + tokenMarina } });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 404);

console.log("7. chaveDaUrl reconhece o formato do disco (/arquivos/...) e o formato do R2 (URL pública + prefixo)");
assert.equal(chaveDaUrl(`https://exemplo.com/arquivos/${chave}`), chave);
assert.equal(chaveDaUrl(`https://pub-teste.r2.dev/${chave}`), null, "sem R2_PUBLIC_URL configurado neste teste, não deveria reconhecer nenhum domínio como sendo do R2");
assert.equal(chaveDaUrl(null), null);
assert.equal(chaveDaUrl(""), null);

console.log("\nTudo certo ✅");
process.exit(0);
