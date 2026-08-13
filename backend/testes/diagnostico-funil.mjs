/* Por que o funil não anda — o diagnóstico separa as três causas.

   "Avanço por palavra-chave não está funcionando" pode ser a palavra que
   ninguém diz, a conversa que acontece por áudio, ou o gatilho que não casa.
   Este teste monta uma base com as três e confere que cada uma cai no balde
   certo — porque é esse número que vai decidir onde a gente mexe.

   Rodar:  npm run teste:funil
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-funil.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { inferStage, gatilhosNaConversa } = await import("../src/services/stages.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());

let n = 0;
/* `msgs` é [direcao, texto, ehMidia]. O texto vai cru, com acento e maiúscula,
   porque é assim que chega do WhatsApp — normalizar aqui esconderia justamente
   o tipo de erro que a gente quer pegar. */
function lead(nome, etapa, msgs) {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, org, nome, "5587900000" + (10 + n++), etapa, Date.now());
  msgs.forEach(([dir, body, midia], i) =>
    db.prepare(`INSERT INTO messages (id,lead_id,direction,body,media_url,created_at) VALUES (?,?,?,?,?,?)`)
      .run("m_" + randomUUID(), id, dir, body, midia ? "https://x/y.ogg" : null, Date.now() + i));
  return id;
}

console.log("1. A palavra dita na conversa move o lead — pelo corretor OU pelo cliente");
const casos = [
  ["Oi! Vou dar continuidade ao seu atendimento", "Atendimento"],
  ["me manda a documentação por favor", "Pasta"],
  ["saiu a aprovação do seu crédito", "Aprovação"],
  ["podemos agendar uma visita?", "Agendamento"],
  ["e aí, o que achou do imóvel?", "Visita"],
  ["vamos fechar então", "Proposta"],
  ["assinatura do contrato na sexta", "Venda"],
];
for (const [texto, esperado] of casos) {
  const r = inferStage("Lead", [{ direction: "out", body: texto }]);
  console.log(`   «${texto}» → ${r}`);
  assert.equal(r, esperado, `esperava ${esperado}`);
}

console.log("2. Vale a palavra MAIS ADIANTADA, e nunca volta para trás");
assert.equal(inferStage("Lead", [
  { direction: "out", body: "me manda a documentação" },
  { direction: "in", body: "já saiu a aprovação!" },
  { direction: "out", body: "vamos agendar a visita" },
]), "Agendamento", "a mais adiantada manda");
assert.equal(inferStage("Proposta", [{ direction: "out", body: "me manda a documentação" }]), "Proposta",
  "palavra de etapa anterior não faz o lead descer");
assert.equal(inferStage("Perdido", [{ direction: "out", body: "vamos fechar" }]), "Perdido",
  "etapa marcada na mão não é mexida pela conversa");

console.log("3. Áudio e foto não têm texto — nenhuma palavra pode bater ali");
assert.equal(gatilhosNaConversa([{ direction: "in", body: "Áudio" }, { direction: "out", body: "Foto" }]).length, 0,
  "o rótulo do anexo não pode virar gatilho");

console.log("4. O diagnóstico separa as três causas");
// (a) conversa normal, com palavra
lead("Joana", "Lead", [["in", "oi, vi o anúncio"], ["out", "vou dar continuidade ao seu atendimento"]]);
lead("Marcos", "Lead", [["out", "me manda a documentação"], ["in", "mandei"]]);
// (b) conversa sem nenhuma das palavras
lead("Luana", "Lead", [["in", "bom dia"], ["out", "bom dia, tudo bem?"], ["in", "quanto custa?"]]);
lead("Pedro", "Lead", [["in", "oi"], ["out", "oi! como posso ajudar?"]]);
// (c) conversa só de áudio/foto
lead("Cíntia", "Lead", [["in", "Áudio", 1], ["out", "Áudio", 1], ["in", "Foto", 1]]);
// (d) sem conversa nenhuma — a base importada
lead("Rogério", "Lead", []);

const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: leadsRoutes } = await import("../src/routes/leads.routes.js");
const adm = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x','adm',0,?,'ativo')`).run(adm, org, "Ali", "ali@x.com", Date.now());
const token = jwt.sign({ id: adm, role: "adm", org_id: org, name: "Ali" }, "teste", { expiresIn: "1h" });

const app = express(); app.use(express.json()); app.use("/leads", leadsRoutes);
const srv = app.listen(0);
const porta = srv.address().port;
const r = await (await fetch(`http://127.0.0.1:${porta}/leads/reanalise`,
  { headers: { authorization: "Bearer " + token } })).json();
srv.close();

const g = r.diagnostico;
console.log(`   ${r.com_conversa} com conversa · ${r.fora.sem_conversa} sem conversa`);
console.log(`   sem palavra nenhuma: ${g.sem_gatilho} · só áudio/foto: ${g.so_midia}`);
console.log(`   mensagens sem texto: ${g.mensagens_sem_texto} de ${g.mensagens}`);
assert.equal(r.fora.sem_conversa, 1, "o lead importado sem conversa fica de fora");
assert.equal(r.com_conversa, 5);
assert.equal(g.sem_gatilho, 3, "Luana, Pedro e Cíntia não batem em palavra nenhuma");
assert.equal(g.so_midia, 1, "só a Cíntia é conversa de áudio pura");
assert.equal(g.com_gatilho, 2);
assert.equal(g.mensagens_sem_texto, 3, "os três anexos da Cíntia");

console.log("5. O quadro diz qual palavra aparece e qual nunca apareceu");
const porPalavra = Object.fromEntries(g.gatilhos.map(x => [x.etapa, x.leads]));
console.log("   ", g.gatilhos.map(x => `${x.palavra}:${x.leads}`).join(" · "));
assert.equal(porPalavra["Atendimento"], 1);
assert.equal(porPalavra["Pasta"], 1);
assert.equal(porPalavra["Venda"], 0, "“contrato” nunca apareceu nesta base");

console.log("\nTudo certo ✅");
