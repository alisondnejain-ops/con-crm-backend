/* EM QUE FUNIL O LEAD NOVO ENTRA. (01/09/2026, relatado pelo Ali)

   "Os leads da Vanessa precisam cair no funil de SDR; os antigos eu transferi,
   mas os novos ainda não."

   A causa: a entrada olhava só o funil PADRÃO da imobiliária. Ela não tinha
   como saber de quem era o lead, então o funil de SDR só existia para quem
   fosse movido para lá na mão — e a cada lead novo o trabalho recomeçava.

   Este teste tranca as duas metades da regra:

     1. o lead NASCE no funil de quem o recebe;
     2. e TROCA de funil quando é repassado para alguém com funil próprio —
        senão o lead ficaria no pré-atendimento depois de entregue ao corretor,
        e o kanban dele não mostraria o lead que acabou de chegar.

   E a trava que impede a mudança de vazar para quem não pediu nada: só move
   quem tem funil ESCRITO.

   Rodar:  npm run teste:funil-entrada
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-funil-entrada.db");
process.env.JWT_SECRET = "teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const P = await import("../src/services/pipelines.js");
const M = await import("../src/services/movimento.js");

const org = "org_conecta";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "C-1", Date.now());
const novo = (id, nome, papel) => db.prepare(
  `INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
   VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@c.com", papel, Date.now());
novo("u_ali", "Ali", "adm");
novo("u_vanessa", "Vanessa", "sdr");
novo("u_marina", "Marina", "corretor");
novo("u_rafael", "Rafael", "corretor");

// O comercial é o funil padrão da casa; o de SDR é o novo.
const comercial = P.criarDoTemplate(org, "comercial", { is_default: true });
const sdr = P.criarDoTemplate(org, "sdr", {});
console.log(`Funis: "${comercial.pipeline.name}" (padrão) e "${sdr.pipeline.name}"\n`);

console.log("===== ONDE O LEAD NASCE =====");

console.log("1. Sem ninguém configurado, tudo cai no funil padrão da casa");
/* É o comportamento de sempre, e ele precisa continuar valendo: quem nunca
   abriu esta configuração não pode ver o CRM mudar sozinho. */
let e = P.entradaDe(org, "u_vanessa");
console.log(`   Vanessa → ${e.pipeline_id === comercial.pipeline.id ? "Comercial" : "?"} · próprio: ${e.proprio}`);
assert.equal(e.pipeline_id, comercial.pipeline.id);
assert.equal(e.proprio, false);

console.log("2. Com o funil da Vanessa escolhido, o lead dela nasce no SDR");
db.prepare("UPDATE users SET pipeline_entrada = ? WHERE id = 'u_vanessa'").run(sdr.pipeline.id);
e = P.entradaDe(org, "u_vanessa");
console.log(`   Vanessa → ${sdr.pipeline.name}, em "${e.nome}" · próprio: ${e.proprio}`);
assert.equal(e.pipeline_id, sdr.pipeline.id);
assert.equal(e.nome, sdr.etapas[0].name, "entra na primeira etapa do funil dela");
assert.equal(e.proprio, true);

console.log("3. E o de quem NÃO configurou continua no padrão");
/* A mudança é por pessoa. Sem isto, configurar a atendente mexeria no funil de
   entrada de todo mundo. */
assert.equal(P.entradaDe(org, "u_marina").pipeline_id, comercial.pipeline.id);
console.log("   Marina → Comercial");

console.log("4. Lead sem dono (fila) usa o padrão da casa");
assert.equal(P.entradaDe(org, null).pipeline_id, comercial.pipeline.id);
console.log("   fila → Comercial");

console.log("5. Funil apagado depois de configurado cai no padrão, não no vazio");
/* Lead sem funil nenhum é lead que some de todas as colunas do kanban — pior
   do que estar no funil errado. */
db.prepare("UPDATE users SET pipeline_entrada = 'pl_que_nao_existe' WHERE id = 'u_rafael'").run();
e = P.entradaDe(org, "u_rafael");
console.log(`   Rafael → ${e.pipeline_id === comercial.pipeline.id ? "Comercial" : "NADA"}`);
assert.equal(e.pipeline_id, comercial.pipeline.id);
db.prepare("UPDATE users SET pipeline_entrada = NULL WHERE id = 'u_rafael'").run();

console.log("\n===== O FUNIL SEGUE QUEM ESTÁ COM O LEAD =====");

const lead = (nome, dono) => {
  const id = "l_" + randomUUID();
  const ent = P.entradaDe(org, dono);
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at,
              pipeline_id,stage_id,stage_entered_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, org, nome, "8799" + Math.random().toString().slice(2, 8), ent.nome, dono, Date.now(),
         ent.pipeline_id, ent.stage_id, Date.now());
  return id;
};
const funilDe = (id) => db.prepare("SELECT pipeline_id, stage FROM leads WHERE id = ?").get(id);

console.log("6. O lead que entra com a Vanessa já nasce no funil de SDR");
const l1 = lead("Cliente do WhatsApp", "u_vanessa");
console.log(`   ${funilDe(l1).pipeline_id === sdr.pipeline.id ? sdr.pipeline.name : "?"} · etapa "${funilDe(l1).stage}"`);
assert.equal(funilDe(l1).pipeline_id, sdr.pipeline.id);

console.log("7. Repassar para quem NÃO configurou funil não mexe no funil");
/* A trava que impede a mudança de vazar. Vazio significa "uso o padrão da
   casa", e mover por causa disso puxaria de volta para o padrão um lead que
   alguém pôs de propósito num funil especial. */
M.trocarResponsavel(l1, "u_marina", "u_vanessa");
console.log(`   continua em ${funilDe(l1).pipeline_id === sdr.pipeline.id ? sdr.pipeline.name : "outro"}`);
assert.equal(funilDe(l1).pipeline_id, sdr.pipeline.id);

console.log("8. Com o funil da Marina escolhido, o repasse LEVA o lead junto");
/* É a outra metade da regra. Sem ela, o lead entregue ao corretor ficava no
   funil de pré-atendimento e não aparecia em coluna nenhuma do kanban dele. */
db.prepare("UPDATE users SET pipeline_entrada = ? WHERE id = 'u_marina'").run(comercial.pipeline.id);
const l2 = lead("Outro cliente", "u_vanessa");
assert.equal(funilDe(l2).pipeline_id, sdr.pipeline.id, "nasceu no SDR");
const r8 = M.trocarResponsavel(l2, "u_marina", "u_vanessa");
console.log(`   ${sdr.pipeline.name} → ${r8.funil.pipeline}, em "${r8.funil.etapa}"`);
assert.equal(funilDe(l2).pipeline_id, comercial.pipeline.id);
assert.equal(r8.funil.pipeline, comercial.pipeline.name);

console.log("9. E a mudança fica no HISTÓRICO do lead");
/* "Por onde este atendimento passou" é justamente a pergunta que dois funis
   criam. Um UPDATE em massa não deixaria rastro nenhum. */
const hist = db.prepare("SELECT de, para, motivo FROM lead_etapas WHERE lead_id = ? ORDER BY created_at").all(l2);
const transf = db.prepare("SELECT from_user_id, to_user_id FROM lead_transfers WHERE lead_id = ?").all(l2);
/* DUAS transferências, e é o certo: são dois fatos diferentes no mesmo gesto —
   trocou de dono, e trocou de funil. Uma linha só teria que escolher qual dos
   dois contar, e "por onde este atendimento passou" ficaria pela metade. */
console.log(`   ${hist.length} linha(s) de etapa · ${transf.length} transferência(s) (dono + funil)`);
assert.ok(hist.length >= 1);
assert.equal(transf.length, 2);

console.log("10. Repassar de volta para a Vanessa devolve o lead ao SDR");
/* A regra vale nos dois sentidos: o funil é de quem está com o lead, não uma
   viagem de mão única. */
M.trocarResponsavel(l2, "u_vanessa", "u_ali");
console.log(`   voltou para ${funilDe(l2).pipeline_id === sdr.pipeline.id ? sdr.pipeline.name : "?"}`);
assert.equal(funilDe(l2).pipeline_id, sdr.pipeline.id);

console.log("11. Devolver para a FILA não mexe no funil");
/* A fila não é uma pessoa e não tem funil de entrada. Mandar o lead para o
   padrão aqui apagaria em silêncio o lugar em que ele estava. */
const antes11 = funilDe(l2).pipeline_id;
M.trocarResponsavel(l2, null, "u_ali");
console.log(`   continua em ${funilDe(l2).pipeline_id === antes11 ? "onde estava" : "OUTRO"}`);
assert.equal(funilDe(l2).pipeline_id, antes11);

console.log("12. Repassar para alguém que JÁ está no funil dele não move nada");
/* Sem esta conferência, cada repasse gravaria uma linha de histórico dizendo
   que o lead mudou de etapa quando ele não mudou. */
const l3 = lead("Já no comercial", "u_marina");
const antes12 = db.prepare("SELECT COUNT(*) n FROM lead_etapas WHERE lead_id = ?").get(l3).n;
const r12 = M.trocarResponsavel(l3, "u_rafael", "u_ali");
M.trocarResponsavel(l3, "u_marina", "u_ali");
const depois12 = db.prepare("SELECT COUNT(*) n FROM lead_etapas WHERE lead_id = ?").get(l3).n;
console.log(`   ${antes12} → ${depois12} linha(s) de etapa · funil: ${r12.funil ? "moveu" : "não moveu"}`);
assert.equal(r12.funil, null);
assert.equal(antes12, depois12);

console.log("\nTudo certo ✅");
process.exit(0);
