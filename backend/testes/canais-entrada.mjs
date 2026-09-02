/* O QUE ACONTECE COM A MENSAGEM QUE CHEGA NUMA LINHA PESSOAL.

   As regras deste teste moram na ROTA do webhook, não num serviço, e nenhuma
   delas falha com erro — todas falham em silêncio, que é o motivo de existirem:

     - lead que chega no número da Marina indo para a catraca: a Marina veria o
       próprio WhatsApp ser atendido por um colega;
     - responder por uma linha diferente da que o cliente usou: a resposta chega
       no celular dele como mensagem de um número desconhecido, fora da conversa
       que ele estava tendo;
     - mensagem cuja linha não é reconhecida: PARA DE ENTRAR LEAD.

   Por isso o servidor sobe inteiro e a conferência é feita de fora, por HTTP —
   mesma escolha do teste:webhook.

   Rodar:  npm run teste:canais-entrada
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-canais-entrada.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4713;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (codigo) => { servidor.kill("SIGTERM"); process.exit(codigo); };
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1500)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
console.log("Servidor no ar, igual à produção.\n");

const { default: db } = await import("../src/db.js");
const C = await import("../src/services/canais.js");

const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host='https://casa.uazapi.com', uazapi_token='token-da-casa' WHERE id=?").run(org);
const novo = (id, nome, papel) =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@c.com", papel, Date.now());
novo("u_vanessa", "Vanessa", "sdr");
novo("u_marina", "Marina", "corretor");

C.garantirCasa(org);
const criada = C.criarCanalDoCorretor(org, "u_marina");
C.salvarConexao(criada.canal.id, { host: "https://marina.uazapi.com", token: "token-da-marina" });
const daMarina = C.canalDoUsuario(org, "u_marina");

const mandar = (token, phone, texto, extra = {}) => fetch(url("/webhooks/uazapi"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, event: "messages",
    message: { chatid: `${phone}@s.whatsapp.net`, text: texto, senderName: "Cliente Teste",
      messageid: "wa_" + Math.random().toString(36).slice(2), ...extra } }),
});
const esperar = () => new Promise(r => setTimeout(r, 400));
const leadDe = (phone) => db.prepare("SELECT * FROM leads WHERE phone LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${phone.slice(-8)}%`);

console.log("1. Lead que chega no número da CASA vai para a catraca da atendente");
await mandar("token-da-casa", "5587911110001", "oi, vi um anúncio"); await esperar();
let l = leadDe("5587911110001");
console.log(`   ${l.name} → ${db.prepare("SELECT name FROM users WHERE id=?").get(l.assigned_to)?.name || "fila"} · linha: ${l.canal_id ? "pessoal" : "da casa"}`);
assert.equal(l.assigned_to, "u_vanessa", "a catraca das atendentes continua valendo no número da casa");
assert.equal(l.canal_id, null, "a linha da casa é o nulo");

console.log("2. Lead que chega no número PESSOAL já nasce do dono da linha");
/* A catraca reparte o que chega no número da CASA, que é de todo mundo e de
   ninguém. Quem escreveu para a Marina escolheu a Marina — sortear esse lead
   seria o CRM desfazendo uma decisão do cliente. */
await mandar("token-da-marina", "5587911110002", "oi Marina, é sobre a casa"); await esperar();
l = leadDe("5587911110002");
console.log(`   ${l.name} → ${db.prepare("SELECT name FROM users WHERE id=?").get(l.assigned_to)?.name} · linha: ${l.canal_id === daMarina.id ? "da Marina" : "?"}`);
assert.equal(l.assigned_to, "u_marina", "não passa pela catraca");
assert.equal(l.canal_id, daMarina.id);

console.log("3. E ele já entra com `assigned_at`, para subir na caixa dela");
assert.ok(l.assigned_at, "sem isso o lead recém-chegado afundaria atrás dos antigos");
console.log("   carimbado");

console.log("4. A conversa passa a acontecer na LINHA QUE O CLIENTE USOU");
/* O cliente escreve para o número que ele tem salvo. Responder por outro faz a
   resposta chegar como mensagem de um desconhecido — e ninguém de dentro vê. */
await mandar("token-da-marina", "5587911110001", "mudei para o seu número"); await esperar();
l = leadDe("5587911110001");
console.log(`   o lead que era da casa agora fala pela linha ${l.canal_id === daMarina.id ? "da Marina" : "da casa"}`);
assert.equal(l.canal_id, daMarina.id);

console.log("5. E VOLTA quando ele escreve para a casa de novo");
/* Vale nos dois sentidos: quem manda é a última linha usada, não a última
   escolha feita numa tela. */
await mandar("token-da-casa", "5587911110001", "voltei pro número antigo"); await esperar();
l = leadDe("5587911110001");
console.log(`   voltou para a linha ${l.canal_id ? "pessoal" : "da casa"}`);
assert.equal(l.canal_id, null);

console.log("6. É o MESMO lead — a conversa não se parte em duas");
/* Dois leads para o mesmo cliente partiriam o histórico, o relatório e o
   repasse, que é exatamente o que este CRM existe para não deixar acontecer. */
const quantos = db.prepare("SELECT COUNT(*) n FROM leads WHERE phone LIKE ?").get("%11110001").n;
const msgs = db.prepare("SELECT canal_id FROM messages WHERE lead_id=? ORDER BY created_at").all(l.id);
console.log(`   ${quantos} lead · ${msgs.length} mensagens, em ${new Set(msgs.map(m => m.canal_id)).size} linha(s)`);
assert.equal(quantos, 1);
assert.equal(msgs.length, 3);

console.log("7. Cada mensagem guarda POR ONDE passou");
/* O lead aponta para o presente; a mensagem guarda o passado. Sem isso, uma
   conversa que migrou ficaria toda marcada como se tivesse saído da linha
   atual — e "por onde isso foi combinado" é a pergunta que duas linhas criam. */
console.log(`   ${msgs.map(m => m.canal_id ? "Marina" : "casa").join(" → ")}`);
assert.deepEqual(msgs.map(m => m.canal_id), [null, daMarina.id, null]);

console.log("8. Mensagem de uma linha DESCONHECIDA não entra em ninguém");
/* Lead na casa errada é pior que lead perdido. E o diagnóstico diz o que
   chegou, para acertar a configuração em vez de adivinhar.

   A FRASE MUDOU EM 02/09/2026, na auditoria de segurança, e a mudança é o
   ponto: passaram a existir dois motivos diferentes para a mensagem ser
   recusada — "veio um token e ele não bate" e "não veio token nenhum" —, e
   eles pedem remédios opostos. O primeiro se resolve conferindo o token na
   tela de Conexão; o segundo, ligando o modo de emergência
   (UAZAPI_ACEITAR_POR_NUMERO=1) ou acertando a Uazapi. Uma frase só para os
   dois mandaria metade das pessoas consertar o que não está quebrado. */
const antes = db.prepare("SELECT COUNT(*) n FROM leads").get().n;
await mandar("token-de-ninguem", "5587911110003", "oi"); await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads").get().n, antes, "não pode nascer lead sem dono de linha");
const diag = await (await fetch(url("/integracoes/webhooks"))).json();
const ultimo = (diag.eventos || diag.webhooks || [])[0] || {};
console.log(`   ${ultimo.resultado || "(sem registro)"}`);
assert.ok(/RECUSADO/.test(ultimo.resultado || ""), "e o diagnóstico explica o que aconteceu");
assert.ok(/não corresponde a nenhuma linha/i.test(ultimo.resultado || ""),
  "dizendo QUAL das duas coisas falhou — aqui, token que não bate");

console.log("8b. E sem token nenhum ela também não entra — nem sabendo o número");
/* Era o furo mais sério da auditoria: a identificação caía para os últimos
   oito dígitos do WhatsApp da imobiliária, que é informação PÚBLICA. Sabendo
   o número do anúncio, qualquer pessoa criava lead falso, escrevia na conversa
   de um cliente real e fazia a IA da casa mandar WhatsApp para quem quisesse. */
const numeroDaCasa = db.prepare("SELECT wa_number FROM canais WHERE tipo='imobiliaria' LIMIT 1").get()?.wa_number;
await fetch(url("/webhooks/uazapi"), { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ owner: numeroDaCasa || "5587999990000",
    message: { chatid: "5587911110004@s.whatsapp.net", text: "invadindo", messageid: "wa_falso" } }) });
await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads").get().n, antes,
  "o número da imobiliária é público — sozinho ele não pode abrir a porta");
const diag2 = await (await fetch(url("/integracoes/webhooks"))).json();
const ultimo2 = (diag2.eventos || diag2.webhooks || [])[0] || {};
console.log(`   ${ultimo2.resultado}`);
assert.ok(/SEM o token/i.test(ultimo2.resultado || ""), "e a recusa diz que faltou o token, não que a linha é desconhecida");

console.log("\nTudo certo ✅");
fim(0);
