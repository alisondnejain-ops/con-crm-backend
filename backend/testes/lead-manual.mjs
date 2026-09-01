/* CADASTRAR UM LEAD NA MÃO. (01/09/2026, pedido do Ali)

   Até aqui o lead só nascia de três jeitos — WhatsApp, formulário do Meta e
   planilha — e faltava o mais comum do dia a dia: alguém ligou, alguém
   indicou, alguém apareceu na porta. Sem lugar no sistema, esse lead ficava no
   papel, que é onde o atendimento deixa de ser medido.

   O servidor sobe inteiro e a conferência é por HTTP porque as regras que
   importam são de PERMISSÃO e de RECUSA — quem pode escolher o dono, o que
   acontece com número repetido — e permissão testada por dentro do serviço não
   prova nada sobre a rota.

   Rodar:  npm run teste:lead-manual
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-lead-manual.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4715;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "T-1",
         ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (c) => { servidor.kill("SIGTERM"); process.exit(c); };
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1200)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
console.log("Servidor no ar, igual à produção.\n");

const { default: db } = await import("../src/db.js");
const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
const senha = db.prepare("SELECT pass_hash FROM users LIMIT 1").get().pass_hash;
const novo = (id, nome, papel) => db.prepare(
  `INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
   VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@t.com", senha, papel, Date.now());
novo("u_vanessa", "Vanessa", "sdr");
novo("u_marina", "Marina", "corretor");
novo("u_rafael", "Rafael", "corretor");

const entrar = async (email) => (await (await fetch(url("/auth/login"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tAli = await entrar("ali@teste.com");
const tVanessa = await entrar("vanessa@t.com");
const tMarina = await entrar("marina@t.com");

const criar = (token, corpo) => fetch(url("/leads"), {
  method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify(corpo) });

console.log("===== O CADASTRO =====");

console.log("1. A atendente cadastra, escolhe o corretor e deixa uma observação");
/* É o caso que motivou o pedido: ela atende a ligação, anota o que descobriu e
   passa adiante — sem isso, o que ela descobriu se perde. */
let r = await criar(tVanessa, { nome: "João da Silva", telefone: "(87) 9 9111-2222",
  assigned_to: "u_marina", observacao: "Só atende depois das 18h. Quem decide é a esposa." });
let d = await r.json();
console.log(`   ${r.status} · ${d.name} → ${d.assigned_name} · etapa "${d.stage}"`);
assert.equal(r.status, 201);
assert.equal(d.assigned_to, "u_marina");

console.log("2. O telefone é normalizado — é o que faz o WhatsApp achar o MESMO lead");
/* Digitado "(87) 9 9111-2222" e gravado "5587991112222", que é o formato do
   webhook. Guardado como veio, o cliente que respondesse criaria um segundo
   lead ao lado do primeiro, cada um com metade da história. */
const salvo = db.prepare("SELECT phone, source, assigned_at, pipeline_id, stage_id FROM leads WHERE id = ?").get(d.id);
console.log(`   ${salvo.phone}`);
assert.equal(salvo.phone, "5587991112222");

console.log("3. Nasce LIGADO ao funil, e com `assigned_at`");
/* Sem `pipeline_id`/`stage_id` o lead fica fora de todas as colunas do
   Kanban; sem `assigned_at` ele afunda atrás dos antigos na caixa de quem
   acabou de recebê-lo. */
console.log(`   funil: ${!!salvo.pipeline_id} · etapa: ${!!salvo.stage_id} · assigned_at: ${!!salvo.assigned_at} · origem: ${salvo.source}`);
assert.ok(salvo.pipeline_id && salvo.stage_id);
assert.ok(salvo.assigned_at);
assert.equal(salvo.source, "manual");

console.log("4. A observação vira OBSERVAÇÃO, e não mensagem da conversa");
/* Escrita na conversa, ela apareceria como se tivesse sido enviada ao cliente.
   Na faixa âmbar acima da conversa, é lida por quem for atender antes de falar. */
const obs = db.prepare("SELECT texto, autor_id FROM observacoes WHERE lead_id = ?").all(d.id);
const msgs = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(d.id).n;
console.log(`   ${obs.length} observação(ões) · ${msgs} mensagem(ns) na conversa`);
assert.equal(obs.length, 1);
assert.equal(msgs, 0, "cadastrar não pode inventar uma conversa que não aconteceu");

console.log("5. E o repasse avisa se o corretor vai mesmo ser chamado");
/* Mesma regra do repasse da catraca: lead entregue a quem não sabe que recebeu
   fica parado exatamente como se não tivesse sido entregue. */
console.log(`   aviso: ${JSON.stringify(d.aviso)}`);
assert.equal(d.aviso.push, false);
assert.ok(/sem_push|sem_notificacao/.test(d.aviso.motivo));

console.log("\n===== O NÚMERO REPETIDO =====");

console.log("6. Cadastrar o mesmo número de novo é RECUSADO");
/* Um cliente com duas fichas quebra tudo que este CRM faz: o histórico se
   parte, o funil conta duas vezes e o relatório do corretor mede metade. */
r = await criar(tAli, { nome: "João outra vez", telefone: "5587991112222" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);

console.log("7. E a recusa diz QUAL lead já existe, para a tela abrir a conversa dele");
/* Sem o id, o caminho fácil vira cadastrar com o número trocado — e aí a
   duplicata acontece do mesmo jeito, só que sem ninguém perceber. */
console.log(`   lead_id: ${d.lead_id} · ${d.lead_nome}`);
assert.ok(d.lead_id);
assert.ok(/Marina/.test(d.error), "e diz com quem ele está");

console.log("8. Vale mesmo digitando o número em outro formato");
r = await criar(tAli, { nome: "João de novo", telefone: "87 99111-2222" });
console.log(`   ${r.status}`);
assert.equal(r.status, 409, "a normalização acontece ANTES da conferência, senão ela não serve para nada");

console.log("\n===== QUEM PODE O QUÊ =====");

console.log("9. O corretor cadastra, e o lead nasce DELE");
r = await criar(tMarina, { nome: "Cliente da Marina", telefone: "87 98888-1111" });
d = await r.json();
console.log(`   ${r.status} · dono: ${d.assigned_name}`);
assert.equal(r.status, 201);
assert.equal(d.assigned_to, "u_marina");

console.log("10. E ele NÃO consegue empurrar o lead para o colega");
/* Mandar `assigned_to` no corpo da requisição não pode virar um jeito de
   passar trabalho adiante por fora da catraca. */
r = await criar(tMarina, { nome: "Tentativa", telefone: "87 98888-2222", assigned_to: "u_rafael" });
d = await r.json();
console.log(`   pediu Rafael, ficou com ${d.assigned_name}`);
assert.equal(d.assigned_to, "u_marina");

console.log("11. Não escolher ninguém deixa o lead com QUEM CADASTROU");
/* A atendente que acabou de atender a ligação é a dona natural daquele
   atendimento. E esta casa tem regra própria: lead novo nasce com dono, senão
   fica parado esperando alguém reparar nele. */
r = await criar(tVanessa, { nome: "Sem escolher", telefone: "87 97777-1111" });
d = await r.json();
console.log(`   dono: ${d.assigned_name}`);
assert.equal(d.assigned_to, "u_vanessa");

console.log("11b. Para deixar SEM DONO é preciso dizer — escolhendo a fila");
/* Vazio poderia significar as duas coisas, e a diferença é grande demais para
   ficar num campo em branco: lead sem dono é lead que ninguém sabe que existe. */
r = await criar(tVanessa, { nome: "Na fila", telefone: "87 97777-3333", assigned_to: "fila" });
d = await r.json();
console.log(`   dono: ${d.assigned_to === null ? "fila" : d.assigned_name}`);
assert.equal(d.assigned_to, null);

console.log("12. Escolher alguém de fora da equipe é recusado");
r = await criar(tVanessa, { nome: "De fora", telefone: "87 97777-2222", assigned_to: "u_de_outra_casa" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("\n===== A ETAPA =====");

console.log("13. Dá para escolher em que etapa ele entra");
/* "Etapa que ele se encontra" é campo do pedido do Ali: quem cadastra na mão
   quase sempre já falou com a pessoa, e mandar todo mundo para "Lead novo"
   diria no relatório que ninguém conversou com ninguém. */
const etapas = await (await fetch(url("/pipelines"), { headers: { authorization: "Bearer " + tAli } })).json();
const funil = etapas.pipelines[0];
const terceira = funil.stages[2];
r = await criar(tVanessa, { nome: "Já adiantado", telefone: "87 96666-1111", stage_id: terceira.id });
d = await r.json();
console.log(`   entrou em "${d.stage}"`);
assert.equal(d.stage, terceira.name);
assert.equal(db.prepare("SELECT stage_id FROM leads WHERE id=?").get(d.id).stage_id, terceira.id);

console.log("14. Sem escolher, cai na entrada do funil padrão");
r = await criar(tVanessa, { nome: "Sem etapa", telefone: "87 96666-2222" });
d = await r.json();
console.log(`   "${d.stage}"`);
assert.equal(d.stage, funil.stages[0].name);

console.log("15. Etapa que não é desta imobiliária é recusada");
/* O id chega do navegador e não pode ser a única coisa que decide onde o lead
   entra: o lead ficaria com o funil de uma casa e a etapa de outra. */
r = await criar(tVanessa, { nome: "Etapa de fora", telefone: "87 96666-3333", stage_id: "st_inventado" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("\n===== O QUE NÃO PASSA =====");

console.log("16. Sem nome, não cadastra");
r = await criar(tVanessa, { nome: "   ", telefone: "87 95555-1111" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("17. Sem telefone válido, não cadastra");
/* Lead sem telefone é lead com quem ninguém consegue falar — e ele entraria no
   funil e no relatório contando como atendimento. */
r = await criar(tVanessa, { nome: "Sem telefone", telefone: "123" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("18. E sem login não cadastra nada");
r = await fetch(url("/leads"), { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nome: "Anônimo", telefone: "87 94444-1111" }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("\nTudo certo ✅");
fim(0);
