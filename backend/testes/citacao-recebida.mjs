/* A RESPOSTA A UMA MENSAGEM ESPECÍFICA TEM QUE CHEGAR LIGADA A ELA. (17/09/2026,
   relatado pela SDR via Ali: "o cliente marca a mensagem que respondeu mas no
   CRM não mostra, só aparece a mensagem solta, e não dá pra saber referente a
   qual mensagem ele tá respondendo".)

   O caminho é: o cliente responde uma mensagem no WhatsApp → a Uazapi manda o
   id DELA (do WhatsApp) no webhook, num campo que muda de nome conforme a
   versão da conta (`citada`, em uazapi.webhook.js) → esse id é procurado entre
   os `wa_id` já guardados NESTA conversa (mensageria.js) → achando, vira
   `reply_to` (id LOCAL) → `GET /leads/:id` devolve a citação já resolvida
   (leads.routes.js, join com a própria tabela).

   Este teste prova o caminho FELIZ inteiro (nunca tinha teste automático) e as
   DUAS causas prováveis do relato, cada uma com o próprio diagnóstico em
   `/integracoes`:

   1. o caminho feliz: mensagem enviada pelo CRM ganha `wa_id`, o cliente
      responde a ELA, e a citação chega resolvida em `GET /leads/:id`;
   2. a Uazapi respondeu ao ENVIO sem nenhum id reconhecido — a mensagem nunca
      ganha `wa_id`, então nunca poderá ser citada depois. Isso não trava nada
      e não aparecia em lugar nenhum antes deste teste — agora fica em
      `/integracoes` → `envio_sem_id`, e a resposta ao cliente que citou essa
      mensagem específica registra o aviso em `/integracoes/webhooks`;
   3. o payload do webhook TEM uma referência de resposta, mas com um nome de
      campo que a lista de apelidos conhecidos não cobre — a mensagem entra
      "solta" (do jeito que a SDR relatou), mas agora fica uma PISTA em
      `/integracoes/webhooks` com o nome real do campo, pronta pra virar
      o próximo apelido da lista sem precisar adivinhar de novo.

   Rodar:  npm run teste:citacao-recebida
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-citacao.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4644";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const real = globalThis.fetch;
let proximoEnvioSemId = false;
let contadorEnvios = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("uazapi.teste")) {
    contadorEnvios++;
    if (proximoEnvioSemId) {
      proximoEnvioSemId = false;
      // Resposta 200, sem NENHUM campo que `idDaMensagem` reconheça — é
      // exatamente o "a Uazapi respondeu e não deu pra saber o id".
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "sent" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ messageid: "wa_env_" + contadorEnvios }) };
  }
  return real(url, opts);
};

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4644";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare(`INSERT INTO orgs (id,name,adm_code,uazapi_host,uazapi_token,created_at)
  VALUES (?,?,?,?,?,?)`).run(org, "Conecta", "AV-5", "https://uazapi.teste", "tok-cit", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const marina = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(marina, org, "Marina", "marina@av5.com", senha, "corretor", Date.now());
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?)`).run(leadId, org, "Thassio", "5587900000009", marina, Date.now());

const r0 = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "marina@av5.com", password: "123456" }) });
const { token } = await r0.json();
assert.ok(token, "login falhou");
const auth = { authorization: "Bearer " + token, "content-type": "application/json" };

const webhook = (msg) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-cit", event: "messages", message: msg }) });
const ultimosEventos = async () => (await (await fetch(`${BASE}/integracoes/webhooks`)).json()).eventos;

console.log("1. Caminho feliz: mensagem enviada pelo CRM ganha wa_id, e o cliente responde a ELA");
let resp = await fetch(`${BASE}/leads/${leadId}/messages`, { method: "POST", headers: auth,
  body: JSON.stringify({ text: "Quantos quartos você precisa?" }) });
assert.equal(resp.status, 200, await resp.text());
const enviada = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId);
console.log(`   mensagem enviada, wa_id=${enviada.wa_id}`);
assert.ok(enviada.wa_id, "a mensagem enviada tinha que ter ganhado um wa_id — sem ele, ninguém consegue citá-la depois");

resp = await webhook({ messageid: "wa_cliente_1", fromMe: false, sender: "5587900000009@s.whatsapp.net",
  senderName: "Thassio", text: "Dom Avelar, vou ter a partir de 210 mil",
  quoted: { id: enviada.wa_id } });
assert.equal(resp.status, 200);
await new Promise(r => setTimeout(r, 300));

resp = await fetch(`${BASE}/leads/${leadId}`, { headers: { authorization: "Bearer " + token } });
let d = await resp.json();
const citante = d.messages.find(m => m.body === "Dom Avelar, vou ter a partir de 210 mil");
console.log(`   reply_to=${citante?.reply_to} · reply_body="${citante?.reply_body}"`);
assert.ok(citante, "a mensagem do cliente não chegou");
assert.equal(citante.reply_to, enviada.id, "reply_to tinha que apontar para a mensagem local que ele respondeu");
assert.equal(citante.reply_body, "Quantos quartos você precisa?", "a citação já vem resolvida com o texto da mensagem original");

console.log("2. A Uazapi respondeu ao ENVIO sem nenhum id — a mensagem nunca ganha wa_id, e fica registrado em /integracoes");
proximoEnvioSemId = true;
resp = await fetch(`${BASE}/leads/${leadId}/messages`, { method: "POST", headers: auth,
  body: JSON.stringify({ text: "SEM_ID_TESTE: qual o seu orçamento?" }) });
assert.equal(resp.status, 200);
const semId = db.prepare("SELECT * FROM messages WHERE lead_id = ? AND body LIKE 'SEM_ID_TESTE%'").get(leadId);
assert.equal(semId.wa_id, null, "sem id reconhecido na resposta, wa_id tem que ficar vazio");
let integ = await (await fetch(`${BASE}/integracoes`)).json();
console.log(`   envio_sem_id: ${JSON.stringify(integ.envio_sem_id)}`);
assert.notEqual(integ.envio_sem_id, "nenhum envio sem id desde que o servidor subiu");
assert.equal(integ.envio_sem_id.path, "/send/text");

console.log("   e quem cita essa mensagem específica não acha — o aviso aparece em /integracoes/webhooks");
resp = await webhook({ messageid: "wa_cliente_2", fromMe: false, sender: "5587900000009@s.whatsapp.net",
  senderName: "Thassio", text: "R$ 210 mil", quoted: { id: "wa_que_nunca_existiu" } });
assert.equal(resp.status, 200);
await new Promise(r => setTimeout(r, 300));
let eventos = await ultimosEventos();
const avisoSemMatch = eventos.find(e => /nenhuma mensagem desta conversa tem esse id/.test(e.resultado || ""));
console.log(`   ${avisoSemMatch ? "achou o aviso" : "NÃO achou"}: ${avisoSemMatch?.resultado}`);
assert.ok(avisoSemMatch, "tinha que registrar que o id citado não bateu com nenhuma mensagem local");

console.log("3. Payload com referência de resposta em campo DESCONHECIDO — a mensagem entra solta, mas fica a PISTA");
resp = await webhook({ messageid: "wa_cliente_3", fromMe: false, sender: "5587900000009@s.whatsapp.net",
  senderName: "Thassio", text: "Isso mesmo", xReplyStanza: "algum-id-aqui" });
assert.equal(resp.status, 200);
await new Promise(r => setTimeout(r, 300));
eventos = await ultimosEventos();
const pista = eventos.find(e => /nenhum campo conhecido trouxe o id/.test(e.resultado || ""));
console.log(`   ${pista ? "achou a pista" : "NÃO achou"}: ${pista?.resultado}`);
assert.ok(pista, "tinha que apontar a pista de um campo de resposta não reconhecido");
assert.ok(pista.resultado.includes("xReplyStanza"), "a pista tem que citar o NOME do campo real, não só dizer que existe");
// E a mensagem, mesmo sem citação resolvida, tem que ter entrado normal —
// não é para travar nada, só para não ficar invisível.
const solta = db.prepare("SELECT * FROM messages WHERE lead_id = ? AND body = 'Isso mesmo'").get(leadId);
assert.ok(solta, "a mensagem tinha que ter entrado mesmo sem citação reconhecida");
assert.equal(solta.reply_to, null);

console.log("\nTudo certo ✅");
process.exit(0);
