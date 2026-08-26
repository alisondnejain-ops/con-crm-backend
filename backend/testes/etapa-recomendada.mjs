/* A palavra dita na conversa RECOMENDA a etapa. Ela não move mais nada.

   Pedido do Ali (26/08/2026). O motivo não é a regra errar muito: é que ela e
   a gestão escreviam no MESMO lugar. O funil andava pela palavra, alguém
   corrigia na mão, a palavra aparecia de novo na mensagem seguinte e empurrava
   outra vez — e no fim ninguém sabia dizer, olhando o relatório, qual etapa
   era leitura de gente e qual era palpite de regra.

   O que este teste tranca:

   - mandar uma mensagem com a palavra NÃO muda a etapa do lead;
   - mas deixa uma recomendação guardada, com a palavra que a disparou;
   - confirmar grava com `motivo='mao'` — é o que faz a etapa contar como
     confirmada por gente no relatório;
   - dispensar apaga a recomendação sem mexer na etapa;
   - recomendação feita sobre OUTRA etapa não é aplicável: se o lead andou no
     meio do caminho, confirmar iria movê-lo para trás sem ninguém pedir;
   - quem não tem o lead não confirma nada.

   Rodar:  npm run teste:etapa-recomendada
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-sugestao.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4615";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { sugerirEtapa } = await import("../src/routes/messages.routes.js");
await import("../src/server.js");
const BASE = "http://localhost:4615";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imobiliária Aurora", "SUG-1", Date.now());

const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@sug.com", senha, role, Date.now());
  return id; };
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"), vanessa = user("Vanessa", "sdr");

let n = 0;
function lead(nome, dono, etapa = "Atendimento") {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
    VALUES (?,?,?,?,'WhatsApp','{}',?,?,?)`).run(id, org, nome, "558791110" + (100 + n++), etapa, dono, Date.now());
  return id;
}
const falar = (leadId, texto, de = "in") => db.prepare(
  "INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)")
  .run("m_" + randomUUID(), leadId, de, texto, Date.now() + n++);
const etapaDe = (id) => db.prepare("SELECT stage FROM leads WHERE id=?").get(id).stage;

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@sug.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho, {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) } });

const tMarina = await entrar("Marina"), tRafael = await entrar("Rafael"), tVanessa = await entrar("Vanessa");

console.log("1. A palavra na conversa NÃO move mais o lead");
/* Era exatamente isto que acontecia antes: bastava alguém escrever
   "documentação" e o lead pulava para Pasta sem ninguém decidir. */
const l1 = lead("Fala em documentos", marina);
falar(l1, "boa tarde! pode me mandar a documentação pra simulação?");
sugerirEtapa(l1);
console.log(`   etapa continua: ${etapaDe(l1)}`);
assert.equal(etapaDe(l1), "Atendimento", "a palavra não pode mover o lead sozinha");

console.log("2. Mas deixa uma recomendação, com a palavra que a disparou");
let d = await (await chamar(tMarina, `/leads/${l1}`)).json();
console.log(`   ${d.sugestao_etapa.de} → ${d.sugestao_etapa.para} · por causa de “${d.sugestao_etapa.palavra}”`);
assert.equal(d.sugestao_etapa.para, "Pasta");
assert.equal(d.sugestao_etapa.de, "Atendimento");
assert.ok(d.sugestao_etapa.palavra, "sem a palavra, a recomendação não dá para conferir");

console.log("3. Confirmar move o lead E grava como decisão de GENTE");
/* `motivo='mao'` não é detalhe: é o que faz a visita contar como confirmada no
   relatório, e o que permite separar depois o funil lido do funil chutado. */
let r = await chamar(tMarina, `/leads/${l1}/sugestao-etapa`, { method: "POST", body: JSON.stringify({ acao: "confirmar" }) });
console.log(`   ${r.status} · etapa agora: ${etapaDe(l1)}`);
assert.equal(r.status, 200);
assert.equal(etapaDe(l1), "Pasta");
const hist = db.prepare("SELECT * FROM lead_etapas WHERE lead_id=? ORDER BY created_at DESC").get(l1);
console.log(`   histórico: ${hist.de} → ${hist.para} · motivo "${hist.motivo}" · por ${hist.user_id === marina ? "Marina" : "?"}`);
assert.equal(hist.motivo, "mao", "confirmada por pessoa conta como decisão de pessoa");
assert.equal(hist.user_id, marina, "e fica no nome de quem confirmou");

console.log("4. Confirmada, a recomendação some da ficha");
d = await (await chamar(tMarina, `/leads/${l1}`)).json();
console.log(`   sugestao_etapa: ${d.sugestao_etapa}`);
assert.equal(d.sugestao_etapa, null);

console.log("5. Dispensar apaga a recomendação sem mexer na etapa");
/* Não é "depois eu vejo": é dizer que a leitura estava errada. Sem isso, a
   mesma recomendação ficaria piscando para sempre num lead já recusado. */
const l2 = lead("Falou por engano", marina);
falar(l2, "meu contrato de aluguel do apartamento antigo vence em março");
sugerirEtapa(l2);
assert.equal((await (await chamar(tMarina, `/leads/${l2}`)).json()).sugestao_etapa.para, "Venda");
r = await chamar(tMarina, `/leads/${l2}/sugestao-etapa`, { method: "POST", body: JSON.stringify({ acao: "dispensar" }) });
d = await (await chamar(tMarina, `/leads/${l2}`)).json();
console.log(`   ${r.status} · etapa: ${etapaDe(l2)} · recomendação: ${d.sugestao_etapa}`);
assert.equal(etapaDe(l2), "Atendimento", "dispensar não mexe na etapa");
assert.equal(d.sugestao_etapa, null);

console.log("6. Recomendação velha não é aplicada — nem mostrada");
/* A leitura foi feita quando o lead estava em Atendimento. Se ele já foi para
   Proposta na mão, confirmar "Pasta" o jogaria para trás. */
const l3 = lead("Andou no meio do caminho", marina);
falar(l3, "vou juntar a documentação");
sugerirEtapa(l3);
db.prepare("UPDATE leads SET stage='Proposta' WHERE id=?").run(l3);
d = await (await chamar(tMarina, `/leads/${l3}`)).json();
console.log(`   na ficha: ${d.sugestao_etapa}`);
assert.equal(d.sugestao_etapa, null, "recomendação sobre outro estado não aparece");
r = await chamar(tMarina, `/leads/${l3}/sugestao-etapa`, { method: "POST", body: JSON.stringify({ acao: "confirmar" }) });
console.log(`   confirmar assim mesmo: ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 409);
assert.equal(etapaDe(l3), "Proposta", "e o lead não voltou");

console.log("7. Vale a palavra MAIS ADIANTADA da conversa");
const l4 = lead("Conversa inteira", marina);
falar(l4, "me manda a documentação");
falar(l4, "podemos agendar a visita quinta?", "out");
falar(l4, "quero fechar, me manda a proposta");
sugerirEtapa(l4);
d = await (await chamar(tMarina, `/leads/${l4}`)).json();
console.log(`   ${d.sugestao_etapa.de} → ${d.sugestao_etapa.para}`);
assert.equal(d.sugestao_etapa.para, "Proposta", "a mais adiantada, não a primeira");

console.log("8. Quem não tem o lead não confirma nada");
r = await chamar(tRafael, `/leads/${l4}/sugestao-etapa`, { method: "POST", body: JSON.stringify({ acao: "confirmar" }) });
console.log(`   corretor de fora: ${r.status}`);
assert.equal(r.status, 403);
assert.equal(etapaDe(l4), "Atendimento", "nada foi movido");

console.log("9. A supervisão confirma no lead de qualquer corretor");
r = await chamar(tVanessa, `/leads/${l4}/sugestao-etapa`, { method: "POST", body: JSON.stringify({ acao: "confirmar" }) });
console.log(`   atendente: ${r.status} · etapa: ${etapaDe(l4)}`);
assert.equal(r.status, 200);
assert.equal(etapaDe(l4), "Proposta");

console.log("10. Lead sem palavra nenhuma não gera recomendação");
const l5 = lead("Conversa comum", marina);
falar(l5, "oi, tudo bem? vi o anúncio");
sugerirEtapa(l5);
d = await (await chamar(tMarina, `/leads/${l5}`)).json();
console.log(`   sugestao_etapa: ${d.sugestao_etapa}`);
assert.equal(d.sugestao_etapa, null);

console.log("11. Etapa marcada na mão (Perdido) não recebe recomendação");
const l6 = lead("Foi perdido", marina, "Perdido");
falar(l6, "me manda a documentação");
sugerirEtapa(l6);
d = await (await chamar(tMarina, `/leads/${l6}`)).json();
console.log(`   etapa: ${etapaDe(l6)} · recomendação: ${d.sugestao_etapa}`);
assert.equal(etapaDe(l6), "Perdido");
assert.equal(d.sugestao_etapa, null, "etapa manual fica fora da regra de palavra");

console.log("\nTudo certo ✅");
process.exit(0);
