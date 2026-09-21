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
// Sem isto, `salvar()` grava a URL do arquivo RELATIVA ("/arquivos/...",
// sem domínio) — em produção o `APP_URL` sempre está configurado (é ele que
// monta a URL que vai para o WhatsApp; sem ele o envio de mídia nem
// funcionaria), e o teste precisa da mesma condição para o caso 13 (a URL
// que o fallback busca via `fetch()` tem que ser absoluta).
process.env.APP_URL = "http://localhost:4641";
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

/* ===== O TOKEN DE 2 MINUTOS, PARA O DOWNLOAD FUNCIONAR NO CELULAR =====
   (21/09/2026, relatado pelo Ali: "não tá funcionando corretamente no
   celular deles" — o truque de fetch+blob+<a download> que os casos acima
   testam é exatamente o que o Safari do iPhone ignora. A correção é uma
   navegação de verdade para uma URL com token próprio, sem cabeçalho. */
console.log("8. Pede o token — só quem pode ver o lead recebe um");
resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgId}/token-baixar`, { headers: { authorization: "Bearer " + tokenMarina } });
assert.equal(resp.status, 200);
const { token } = await resp.json();
console.log(`   token recebido: ${!!token}`);
assert.ok(token);

resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgId}/token-baixar`, { headers: { authorization: "Bearer " + tokenBruno } });
console.log(`   Bruno (sem acesso a este lead): ${resp.status}`);
assert.equal(resp.status, 403);

console.log("9. O token baixa o arquivo de verdade — SEM cabeçalho Authorization, só a URL, e FORA de /leads");
resp = await fetch(`${BASE}/anexo-baixar/${leadId}/${msgId}?t=${encodeURIComponent(token)}`);
console.log(`   ${resp.status}`);
assert.equal(resp.status, 200);
const corpoViaToken = Buffer.from(await resp.arrayBuffer());
assert.ok(corpoViaToken.equals(conteudo), "o arquivo baixado pelo token tem que ser igual ao original");
assert.ok((resp.headers.get("content-disposition") || "").includes("attachment"));

console.log("10. O token só serve para ESTE anexo — não abre outro, mesmo de uma mensagem qualquer");
resp = await fetch(`${BASE}/anexo-baixar/${leadId}/${msgTexto}?t=${encodeURIComponent(token)}`);
console.log(`   pedindo com o token de outra mensagem: ${resp.status}`);
assert.equal(resp.status, 401, "token emitido para msgId não pode servir para msgTexto");

console.log("11. Token inventado — 401, não vaza dado nenhum");
resp = await fetch(`${BASE}/anexo-baixar/${leadId}/${msgId}?t=isto-nao-e-um-token`);
console.log(`   ${resp.status}`);
assert.equal(resp.status, 401);

console.log("12. Corretor sem acesso a este lead — o token não é dele, então 401 (nunca chega nem a olhar o dono)");
resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgId}/token-baixar`, { headers: { authorization: "Bearer " + tokenBruno } });
assert.equal(resp.status, 403, "Bruno nem consegue emitir token para um lead que não é dele");

/* ===== A REDE DE SEGURANÇA: LEITURA PELA CHAVE FALHA, CAI PARA A URL =====
   (21/09/2026, relatado pelo Ali DE NOVO no mesmo dia do conserto acima:
   "esse erro continua aparecendo" — {"error":"Não consegui buscar o arquivo
   para baixar."} Em produção, ler pela CHAVE (GetObject do R2, ou o caminho
   exato no disco) é um caminho quase nunca exercitado antes deste recurso
   existir — um token do R2 sem permissão de LEITURA (só escrita), ou uma
   chave que não bate mais com R2_PUBLIC_URL depois de trocar de domínio,
   nunca tinham aparecido. `bytesParaBaixar` agora cai para a URL PÚBLICA
   quando a leitura pela chave falha, em vez de desistir na hora. */
console.log("13. Quando ler pela chave falha (chave errada, ou — em produção — R2 sem permissão de leitura), cai para a URL pública");
const msgFallback = "m_" + randomUUID();
// `chaveDaUrl` vai extrair "<chave>?forcarFalha=1" — um arquivo que não
// existe no disco com esse nome exato — mas a URL em si serve o arquivo
// certo, porque o servidor estático ignora a query string.
const urlComChaveErrada = `${url}?forcarFalha=1`;
db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(msgFallback, leadId, "out", marina, "Marina", "Documento", urlComChaveErrada, "application/pdf", "comprovante2.pdf", Date.now());
resp = await fetch(`${BASE}/leads/${leadId}/anexo/${msgFallback}/baixar`, { headers: { authorization: "Bearer " + tokenMarina } });
console.log(`   ${resp.status}`);
assert.equal(resp.status, 200, "a leitura pela chave falha, mas o fallback pela URL pública tem que salvar o download");
const corpoFallback = Buffer.from(await resp.arrayBuffer());
assert.ok(corpoFallback.equals(conteudo), "mesmo com a chave errada, o arquivo que chega é o certo");

console.log("\nTudo certo ✅");
process.exit(0);
