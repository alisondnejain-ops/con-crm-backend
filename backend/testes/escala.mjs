/* IMOBILIÁRIA GRANDE: O QUE NÃO PODE QUEBRAR COM A BASE CRESCENDO (28/09/2026).

   Pedido do Ali ao entrar uma imobiliária maior que a Conecta. O teste de
   carga (30 mil leads, 500 mil mensagens, 76 pessoas) achou:

   - a lista de leads ia INTEIRA a cada 10 segundos em cada aparelho (39 MB);
     agora vai inteira na entrada e depois só o que mudou (`?desde=`), com a
     VERSÃO de cada lead subida por gatilho no banco;
   - consultas com um marcador por lead quebravam acima de ~32 mil ("too many
     SQL variables") — `emLotes`;
   - as recomendações do Painel refaziam o ranking da equipe 200 vezes
     (163 segundos com o servidor parado);
   - respostas grandes iam sem compactação.

   Este teste prova as regras, não o tempo (tempo depende da máquina):
   1. o que mexe num lead sobe a versão (mensagem, tag, tarefa, dono), e
      apagar deixa rastro;
   2. `?desde=` devolve só o que mudou, e diz o que sair da tela;
   3. o corretor não recebe ids de leads que nunca foram dele;
   4. lista com mais de 32 mil ids não quebra;
   5. recomendações de muitos leads calculam o ranking uma vez só;
   6. resposta grande sai compactada.

   Rodar:  npm run teste:escala
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-escala.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4663";
process.env.MARKETING_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db, emLotes } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4663";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa Grande", "ES-1", Date.now());
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);
const funilId = pipelinePadrao(org).id;
const { trocarResponsavel } = await import("../src/services/movimento.js");

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,available_desde)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@es.com", senha, role, Date.now(), Date.now());
  return id; };
const gestor = user("Gestor", "adm"), marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");

let n = 0;
const criarLead = (dono) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,pipeline_id,assigned_to,assigned_at,created_at)
    VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?,?,?)`)
    .run(id, org, `Cliente ${++n}`, "55879" + String(40000000 + n), funilId, dono, Date.now(), Date.now());
  return id; };
const versao = (id) => db.prepare("SELECT versao FROM leads WHERE id = ?").get(id).versao;

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@es.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login de ${nome}: ${JSON.stringify(d)}`); return d.token;
}
const get = async (token, caminho) => {
  const r = await fetch(BASE + caminho, { headers: { authorization: "Bearer " + token } });
  const d = await r.json(); assert.equal(r.status, 200, `${caminho}: ${JSON.stringify(d)}`); return d;
};
const tGestor = await entrar("Gestor"), tMarina = await entrar("Marina");

console.log("1. O que mexe num lead sobe a versão; apagar deixa rastro");
const a = criarLead(marina), b = criarLead(marina), c = criarLead(rafael);
assert.ok(versao(a) > 0, "lead novo já nasce com versão");
let v = versao(a);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','oi',?)").run("m_" + randomUUID(), a, Date.now());
assert.ok(versao(a) > v, "mensagem nova"); v = versao(a);
const tag = "t_" + randomUUID();
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tag, org, "Investidor", "#0E8F6E", Date.now());
db.prepare("INSERT INTO lead_tags (lead_id,tag_id,org_id,marcada_em) VALUES (?,?,?,?)").run(a, tag, org, Date.now());
assert.ok(versao(a) > v, "tag marcada"); v = versao(a);
db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,titulo,quando,created_at) VALUES (?,?,?,?,?,?,?)")
  .run("ta_" + randomUUID(), org, a, marina, "Ligar", Date.now() + 86400000, Date.now());
assert.ok(versao(a) > v, "tarefa criada"); v = versao(a);
db.prepare("UPDATE leads SET priority = 'QUENTE' WHERE id = ?").run(a);
assert.ok(versao(a) > v, "campo do lead");

console.log("2. ?desde= devolve só o que mudou e diz o que sai da tela");
const cheia = await get(tGestor, "/leads?finalizados=1&versao=1");
assert.ok(Number.isFinite(cheia.versao) && Array.isArray(cheia.leads));
assert.equal(cheia.leads.length, 3);
assert.ok(!("resumo_json" in cheia.leads[0]) && !("qual_json" in cheia.leads[0]), "a lista vai enxuta");
assert.ok("qual" in cheia.leads[0] && "assigned_at" in cheia.leads[0], "com o que a tela lê");
let d = await get(tGestor, `/leads?finalizados=1&desde=${cheia.versao}`);
assert.deepEqual([d.leads.length, d.fora.length], [0, 0], "nada mudou, nada vem");
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','tem casa?',?)").run("m_" + randomUUID(), b, Date.now());
d = await get(tGestor, `/leads?finalizados=1&desde=${cheia.versao}`);
assert.deepEqual(d.leads.map(l => l.id), [b]);
assert.equal(d.leads[0].unread, 1, "já com a mensagem contada");
db.prepare("DELETE FROM leads WHERE id = ?").run(c);
d = await get(tGestor, `/leads?finalizados=1&desde=${d.versao}`);
assert.ok(d.fora.includes(c), "apagado sai da tela");
const semFiltro = await get(tGestor, "/leads");
assert.ok(Array.isArray(semFiltro), "sem ?versao/?desde a resposta continua sendo a lista pura de sempre");

console.log("3. Repassado sai da caixa do corretor; lead que nunca foi dele não aparece nem como id");
const daMarina = await get(tMarina, "/leads?finalizados=1&versao=1");
assert.deepEqual(daMarina.leads.map(l => l.id).sort(), [a, b].sort());
const x = criarLead(rafael);   // nunca foi da Marina
trocarResponsavel(b, rafael, gestor, "mao");
d = await get(tMarina, `/leads?finalizados=1&desde=${daMarina.versao}`);
assert.deepEqual(d.fora, [b], "o que era dela e foi repassado sai");
assert.ok(!d.fora.includes(x) && !d.leads.some(l => l.id === x), "o do colega não aparece de jeito nenhum");

console.log("4. Mais de 32 mil ids numa consulta não quebra");
const ids = Array.from({ length: 40000 }, (_, i) => "l_nao_existe_" + i).concat([a]);
const { tagsDeLeads } = await import("../src/services/tags.js");
assert.equal(tagsDeLeads(ids).get(a)[0].nome, "Investidor");
assert.equal(emLotes(ids, (m, lote) => db.prepare(`SELECT id FROM leads WHERE id IN (${m})`).all(...lote)).length, 1);
const { temposDeResposta } = await import("../src/services/score.js");
assert.ok(Array.isArray(temposDeResposta(ids)));

console.log("5. Recomendações de muitos leads calculam o ranking uma vez só");
for (let i = 0; i < 40; i++) criarLead(null);
const score = await import("../src/services/score.js");
let rodadas = 0;
const prep = db.prepare.bind(db);
db.prepare = (sql) => { if (/FROM ligacoes g\s+JOIN users u/.test(sql)) rodadas++; return prep(sql); };
score.recomendacoes(org, 8);
db.prepare = prep;
console.log(`   ranking calculado ${rodadas} vez(es) para ${db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=?").get(org).n} leads`);
assert.ok(rodadas <= 2, "no máximo o de 90 dias e o da semana");

console.log("6. Resposta grande sai compactada; a pequena, não");
for (let i = 0; i < 60; i++) criarLead(marina);
let r = await fetch(BASE + "/leads?finalizados=1&versao=1", { headers: { authorization: "Bearer " + tGestor, "accept-encoding": "gzip" } });
assert.equal(r.headers.get("content-encoding"), "gzip");
assert.ok((await r.json()).leads.length > 60, "e o conteúdo chega inteiro");
r = await fetch(BASE + `/leads?finalizados=1&desde=${(await get(tGestor, "/leads?finalizados=1&versao=1")).versao}`,
  { headers: { authorization: "Bearer " + tGestor, "accept-encoding": "gzip" } });
assert.equal(r.headers.get("content-encoding"), null);
r = await fetch(BASE + "/app", { headers: { "accept-encoding": "gzip" } });
if (r.status === 200) assert.equal(r.headers.get("content-encoding"), "gzip", "a página do CRM também");

console.log("\nTudo certo ✅");
process.exit(0);
