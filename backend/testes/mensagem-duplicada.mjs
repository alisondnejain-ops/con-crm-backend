/* "AS MENSAGENS ESTÃO INDO DUPLICADAS PARA O LEAD DO CLIENTE" (22/09/2026,
   relatado pelo Ali com print — dois balões de áudio idênticos, mesma hora,
   "Enviada pelo WhatsApp"). Confirmado com ele: o CLIENTE recebeu uma vez só
   — a duplicação era só na TELA do CRM.

   A causa é uma corrida (race condition), não repetição do corretor: entre o
   SELECT de eco e o INSERT, mensagem de MÍDIA tem um `await` de verdade (o
   download do arquivo). Se a Uazapi reentrega o MESMO evento em sucessão
   rápida — coisa que provedores baseados em Baileys fazem ao resincronizar
   entre aparelhos —, o segundo webhook roda o próprio SELECT enquanto o
   primeiro ainda está baixando, não acha nada, e também insere. Mensagem de
   TEXTO nunca duplicava porque não tem esse `await` no meio.

   Dois testes:
   1. MIGRAÇÃO SEGURA (processo separado, DB_PATH próprio): se este defeito já
      duplicou mensagem em produção — e já duplicou —, o índice único não pode
      ser criado direto, ou o SERVIDOR NÃO SOBE no próximo deploy. Confere que
      a limpeza roda ANTES do índice, mantendo a linha mais antiga.
   2. A CORRIDA DE VERDADE, pelo webhook real: duas chamadas concorrentes com o
      MESMO wa_id, uma mídia que demora para baixar (servidor HTTP de mentira,
      com atraso de propósito) — só uma mensagem pode sobrar no banco.

   Rodar:  npm run teste:mensagem-duplicada
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "..");

console.log("1. MIGRAÇÃO SEGURA: banco já com wa_id duplicado não pode travar o servidor no próximo deploy");
{
  const dbSujo = path.join(os.tmpdir(), "concrm-teste-msg-dup-sujo.db");
  try { fs.unlinkSync(dbSujo); } catch (e) {}

  // Monta um banco "de antes desta correção": tabela messages básica, sem
  // índice único, com DUAS linhas apontando para o MESMO wa_id — exatamente
  // o estado em que a corrida deixou a base do Ali.
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(dbSujo);
  raw.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    from_user_id TEXT, from_name TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  raw.exec("ALTER TABLE messages ADD COLUMN wa_id TEXT");
  raw.exec("ALTER TABLE messages ADD COLUMN media_url TEXT");
  raw.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at,wa_id,media_url)
    VALUES ('m_velha','l_x','out','Áudio',1000,'DUPLICADO123','https://exemplo/velho.ogg')`).run();
  raw.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at,wa_id,media_url)
    VALUES ('m_nova','l_x','out','Áudio',2000,'DUPLICADO123','https://exemplo/novo.ogg')`).run();
  raw.close();

  // Importa src/db.js num PROCESSO SEPARADO (é módulo ESM com efeito colateral
  // no import — não dá para "reimportar" limpo dentro deste mesmo processo).
  const script = path.join(os.tmpdir(), "concrm-teste-msg-dup-carregar-db.mjs");
  fs.writeFileSync(script, `
    process.env.DB_PATH = ${JSON.stringify(dbSujo)};
    process.env.JWT_SECRET = "teste";
    await import(${JSON.stringify(path.join(RAIZ, "src/db.js"))});
    console.log("SUBIU_SEM_TRAVAR");
  `);
  const saida = execFileSync("node", [script], { encoding: "utf8" });
  console.log(`   ${saida.trim().split("\n").pop()}`);
  assert.match(saida, /SUBIU_SEM_TRAVAR/, "o servidor precisa subir mesmo com wa_id duplicado no banco de antes");
  assert.match(saida, /wa_id duplicado/, "o log precisa dizer que limpou algo, não fazer isso calado");

  const depois = new Database(dbSujo, { readonly: true });
  const linhas = depois.prepare("SELECT id FROM messages WHERE wa_id = 'DUPLICADO123'").all();
  console.log(`   sobrou: ${linhas.map(l => l.id).join(", ")}`);
  assert.equal(linhas.length, 1, "só uma linha pode sobrar por wa_id");
  assert.equal(linhas[0].id, "m_velha", "fica a mais ANTIGA — é a que o cliente viu primeiro");
  const indice = depois.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_wa_id_unico'").get();
  console.log(`   índice único criado: ${!!indice}`);
  assert.ok(indice, "o índice único precisa existir depois da limpeza");
  depois.close();
}

console.log("\n2. A CORRIDA DE VERDADE: duas entregas do mesmo evento, mídia lenta, uma só sobrevive");
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-msg-dup-corrida.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4631";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

// Servidor de mentira que demora para responder — é essa demora que abre a
// fresta da corrida (o mesmo atraso real de baixar um áudio da Uazapi).
const ATRASO_MS = 300;
const mock = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "audio/ogg", "content-length": "9" });
    res.end("audiobyte");
  }, ATRASO_MS);
});
await new Promise(res => mock.listen(4632, res));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4631";
await new Promise(r => setTimeout(r, 700));

const orgId = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)")
  .run(orgId, "Teste Corrida", "COR-1", Date.now());
/* Canal da CASA com host VAZIO de propósito: assim `viaUazapi` (o primeiro
   caminho de download, services/midia.js) desiste NA HORA, sem rede nenhuma,
   e cai direto para `content.URL` — que é o nosso servidor de mentira. Um
   host de verdade aqui faria o teste depender do comportamento de rede do
   ambiente que roda os testes, e não do código que está sendo testado. */
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at)
  VALUES (?,?,'imobiliaria','','token-fake',1,?)`).run("c_" + randomUUID(), orgId, Date.now());
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,?,?)`)
  .run(leadId, orgId, "Cliente Corrida", "5581999887766", "Lead", Date.now());

const webhook = { token: "token-fake", message: {
  chatid: "5581999887766@s.whatsapp.net",
  fromMe: true,
  messageid: "MESMO_ID_REENTREGUE",
  messageType: "audioMessage",
  content: { URL: "http://localhost:4632/audio.ogg", mimetype: "audio/ogg" },
} };

// As duas chamadas saem JUNTAS, sem esperar uma terminar — é isso que faz a
// segunda rodar o SELECT de eco enquanto a primeira ainda está no `await` do
// download. Esperar uma pela outra não provaria nada: reproduziria o caminho
// feliz, não a corrida.
const chamada = () => fetch(`${BASE}/webhooks/uazapi`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(webhook) });
await Promise.all([chamada(), chamada()]);

// O processamento do webhook é assíncrono e sem await na resposta HTTP (de
// propósito — ver mensageria.js); espera o suficiente para as duas tentativas
// de download (300ms cada) terminarem de verdade.
await new Promise(r => setTimeout(r, ATRASO_MS + 900));

const gravadas = db.prepare("SELECT id, media_url FROM messages WHERE lead_id = ? AND wa_id = 'MESMO_ID_REENTREGUE'").all(leadId);
console.log(`   mensagens gravadas para este wa_id: ${gravadas.length}`);
assert.equal(gravadas.length, 1, "as duas entregas do mesmo evento não podem virar duas mensagens");

mock.close();
console.log("\nTudo certo ✅");
process.exit(0);
