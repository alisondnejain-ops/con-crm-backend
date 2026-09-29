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
  // E a mesma mensagem RECEBIDA três vezes, uma com o número na frente (29/09/2026).
  for (const [id, t, wa] of [["m_in_1", 1000, "3EB0IN"], ["m_in_2", 1500, "3EB0IN"], ["m_in_3", 1800, "5587999:3EB0IN"]])
    raw.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at,wa_id) VALUES (?,'l_y','in','oi',?,?)`).run(id, t, wa);
  // O eco de uma mensagem que o CRM enviou, gravado de novo sem autor (29/09/2026).
  const t0 = Date.parse("2026-09-29T12:00:00-03:00");
  const eco = (id, dono, nome, corpo, t) => raw.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,'l_z','out',?,?,?,?)`).run(id, dono, nome, corpo, t);
  eco("m_crm", "u_marina", "Marina", "Olá, tudo bem?", t0 + 1000);
  eco("m_eco", null, null, "*Marina:*\nOlá, tudo bem?", t0 + 500);
  eco("m_celular", null, null, "Bom dia, digitei no celular", t0 + 2000);
  eco("m_antiga", null, null, "Olá, tudo bem?", Date.parse("2026-09-20T12:00:00-03:00"));
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
  const recebidas = depois.prepare("SELECT id FROM messages WHERE lead_id = 'l_y'").all().map(l => l.id);
  assert.deepEqual(recebidas, ["m_in_1"], "da recebida repetida fica só a mais antiga, nos dois formatos de id");
  assert.ok(depois.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_messages_wa_id_recebida'").get());
  const daConversa = depois.prepare("SELECT id FROM messages WHERE lead_id = 'l_z' ORDER BY created_at").all().map(l => l.id);
  console.log(`   conversa com eco: ${daConversa.join(", ")}`);
  assert.deepEqual(daConversa, ["m_antiga", "m_crm", "m_celular"],
    "sai só o eco da mensagem do CRM; o que foi digitado no celular e o que é de antes de 28/09 ficam");
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

/* A MESMA MENSAGEM DO CLIENTE ENTREGUE DUAS VEZES (29/09/2026): o webhook
   geral da Uazapi e o do número entregando o mesmo evento. */
const entregar = (msg) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "token-fake", message: msg }) });
const doCliente = (extra) => ({ chatid: "5581977776666@s.whatsapp.net", sender: "5581977776666@s.whatsapp.net",
  fromMe: false, senderName: "Cliente Novo", ...extra });

console.log("\n3. Texto do cliente entregue duas vezes: uma mensagem, um lead");
await entregar(doCliente({ messageid: "3EB0TEXTO1", text: "Oi, quero ver a casa" }));
await entregar(doCliente({ messageid: "3EB0TEXTO1", text: "Oi, quero ver a casa" }));
await new Promise(r => setTimeout(r, 300));
const leadsNovos = db.prepare("SELECT id FROM leads WHERE org_id = ? AND phone = '5581977776666'").all(orgId);
assert.equal(leadsNovos.length, 1, "um lead só");
const doLead = (id) => db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'in'").get(id).n;
assert.equal(doLead(leadsNovos[0].id), 1, "uma mensagem só");

console.log("4. O mesmo id nos dois formatos da uazapiGO (com e sem o número na frente)");
await entregar(doCliente({ messageid: "558199990000:3EB0TEXTO1", text: "Oi, quero ver a casa" }));
await new Promise(r => setTimeout(r, 300));
assert.equal(doLead(leadsNovos[0].id), 1, "\"5581…:3EB0…\" é a mesma mensagem que \"3EB0…\"");

console.log("5. Mensagem nova (outro id) com o mesmo texto entra — é o cliente mandando de novo");
await entregar(doCliente({ messageid: "3EB0TEXTO2", text: "Oi, quero ver a casa" }));
await new Promise(r => setTimeout(r, 300));
assert.equal(doLead(leadsNovos[0].id), 2);

console.log("6. Áudio de um cliente NOVO entregue duas vezes AO MESMO TEMPO: um lead, uma mensagem");
const audioNovo = { chatid: "5581966665555@s.whatsapp.net", sender: "5581966665555@s.whatsapp.net", fromMe: false,
  senderName: "Cliente Áudio", messageid: "3EB0AUDIO1", messageType: "audioMessage",
  content: { URL: "http://localhost:4632/audio.ogg", mimetype: "audio/ogg" } };
await Promise.all([entregar(audioNovo), entregar(audioNovo)]);
await new Promise(r => setTimeout(r, ATRASO_MS + 900));
const doAudio = db.prepare("SELECT id FROM leads WHERE org_id = ? AND phone = '5581966665555'").all(orgId);
assert.equal(doAudio.length, 1, "a entrega irmã, chegando durante o download, não cria um segundo lead");
assert.equal(doLead(doAudio[0].id), 1);

/* O ECO DO QUE O CRM ENVIOU (29/09/2026, "as mensagens ainda aparecem
   duplicadas"). Uma Uazapi de mentira que, ao receber o envio, dispara o eco
   pelo webhook ANTES de responder — e responde com o id no outro formato. */
const bcrypt = (await import("bcryptjs")).default;
const org2 = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)")
  .run(org2, "Teste Eco", "ECO-1", Date.now(), "http://127.0.0.1:4634", "tok-eco");
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at)
  VALUES (?,?,'imobiliaria','http://127.0.0.1:4634','tok-eco',1,?)`).run("c_" + randomUUID(), org2, Date.now());
const corretora = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,'adm',1,?,'ativo')`).run(corretora, org2, "Marina Lopes", "marina@eco.com", bcrypt.hashSync("123456", 8), Date.now());
const leadEco = (tel) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at) VALUES (?,?,?,?,'{}','Lead',?)")
    .run(id, org2, "Cliente " + tel.slice(-4), tel, Date.now()); return id; };
const ecoDe = (numero, extra) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-eco", message: { chatid: `${numero}@s.whatsapp.net`, fromMe: true, ...extra } }) });
let seq = 0;
const uazapi = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", async () => {
    const b = JSON.parse(corpo || "{}");
    const id = `3EB0ENV${++seq}`;
    if (req.url === "/send/text") {
      await ecoDe(b.number, { messageid: id, text: b.text, wasSentByApi: true });
      await new Promise(r => setTimeout(r, 300));   // o eco é processado antes da resposta
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ messageid: `${b.number}:${id}` }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");   // localização: a resposta não traz id nenhum
  });
});
await new Promise(res => uazapi.listen(4634, res));
const tokenEco = (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "marina@eco.com", password: "123456" }) })).json()).token;
const comoMarina = (url, body) => fetch(`${BASE}${url}`, { method: "POST",
  headers: { authorization: "Bearer " + tokenEco, "content-type": "application/json" }, body: JSON.stringify(body) });
const saidas = (id) => db.prepare("SELECT body, from_user_id, wa_id FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY created_at").all(id);

console.log("\n7. Eco chegando ANTES de o envio terminar, com o id no outro formato: uma mensagem, com o autor certo");
const l7 = leadEco("5581955554444");
let r = await comoMarina(`/leads/${l7}/messages`, { text: "Olá! Vi que você se interessou pela casa." });
assert.equal(r.status, 200, "o envio não pode falhar por causa do eco");
await new Promise(r => setTimeout(r, 300));
let s7 = saidas(l7);
console.log(`   ${s7.length} mensagem(ns): ${s7.map(m => `${m.from_user_id ? "Marina" : "sem autor"} · ${m.wa_id}`).join(" | ")}`);
assert.equal(s7.length, 1, "o eco não vira segunda cópia");
assert.equal(s7[0].from_user_id, corretora, "a que fica é a do CRM, com autor");
assert.match(String(s7[0].wa_id), /3EB0ENV1$/, "e com o id do WhatsApp, para o cliente poder citá-la");

console.log("8. Mesmo eco entregue de novo depois (webhook geral + do número): continua uma");
await ecoDe("5581955554444", { messageid: "3EB0ENV1", text: "*Marina:*\nOlá! Vi que você se interessou pela casa.", wasSentByApi: true });
await new Promise(r => setTimeout(r, 300));
assert.equal(saidas(l7).length, 1);

console.log("9. Envio cuja resposta NÃO traz id (localização): o eco que chega depois não duplica");
const l9 = leadEco("5581944443333");
r = await comoMarina(`/leads/${l9}/localizacao`, { latitude: -9.39, longitude: -40.5 });
assert.equal(r.status, 200);
await ecoDe("5581944443333", { messageid: "3EB0LOC1", messageType: "locationMessage", wasSentByApi: true });
await new Promise(r => setTimeout(r, 300));
assert.equal(saidas(l9).length, 1, "o eco da localização não entra como \"Enviada pelo WhatsApp\"");

console.log("10. O corretor digitando no celular logo depois CONTINUA entrando");
await ecoDe("5581944443333", { messageid: "3EB0CEL1", text: "Te espero lá às 15h", wasSentByApi: false });
await new Promise(r => setTimeout(r, 300));
const s10 = saidas(l9);
assert.equal(s10.length, 2);
assert.equal(s10[1].body, "Te espero lá às 15h");
assert.equal(s10[1].from_user_id, null, "entra como enviada pelo WhatsApp");

console.log("11. Conta antiga, sem o campo wasSentByApi, sem envio recente do CRM: entra");
const l11 = leadEco("5581933332222");
await ecoDe("5581933332222", { messageid: "3EB0CEL2", text: "Oi, é o corretor" });
await new Promise(r => setTimeout(r, 300));
assert.equal(saidas(l11).length, 1);

uazapi.close();
mock.close();
console.log("\nTudo certo ✅");
process.exit(0);
