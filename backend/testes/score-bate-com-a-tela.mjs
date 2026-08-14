/* O score tem que dar o MESMO número que a tela de Relatórios.

   Este teste existe por um motivo específico: os dois estavam certos e mesmo
   assim não batiam, porque mediam coisas diferentes com o mesmo nome. Venda
   pela data de fechamento de um lado e pela etapa do outro; conversão sobre
   recebidos de um lado e sobre resolvidos do outro; período escolhido pelo
   gestor de um lado e 90 dias fixos do outro.

   Relatório de reunião não sobrevive a isso: basta um corretor conferir.

   Rodar:  npm run teste:score
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-score.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { ranking } = await import("../src/services/score.js");

const DIA = 86400000;
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");
const adm = user("Ali", "adm");

let n = 0;
function lead({ dono, entrouHa, etapa = "Atendimento", venda, respondeuEm }) {
  const id = "l_" + randomUUID();
  const criado = Date.now() - entrouHa * DIA;
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at,first_resp_at,sale_value,sale_date)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, org, "Cliente " + (++n), "558790000" + String(1000 + n),
      etapa, dono, criado, respondeuEm != null ? criado + respondeuEm * 60000 : null,
      venda ? venda.valor : null, venda ? Date.now() - venda.haDias * DIA : null);
  return id;
}

/* O caso que quebrava tudo: venda fechada ESTA SEMANA de um lead que entrou há
   dois meses. Para a tela é venda do período; para o score antigo não existia,
   porque o lead não entrou no período. */
lead({ dono: marina, entrouHa: 60, etapa: "Venda", venda: { valor: 250000, haDias: 2 } });
// Leads da semana, atendidos
lead({ dono: marina, entrouHa: 5, etapa: "Atendimento", respondeuEm: 3 });
lead({ dono: marina, entrouHa: 4, etapa: "Agendamento", respondeuEm: 7 });
lead({ dono: marina, entrouHa: 3, etapa: "Perdido", respondeuEm: 4 });
lead({ dono: rafael, entrouHa: 6, etapa: "Atendimento", respondeuEm: 90 });
lead({ dono: rafael, entrouHa: 2, etapa: "Lead" });
// Lead que entrou na semana E fechou na semana: conta nos dois lugares
lead({ dono: rafael, entrouHa: 3, etapa: "Venda", venda: { valor: 180000, haDias: 1 } });

const de = Date.now() - 7 * DIA, ate = Date.now();

// A tela: mesma rota que o gestor abre.
const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: reportsRoutes } = await import("../src/routes/reports.routes.js");
const token = jwt.sign({ id: adm, role: "adm", org_id: org, name: "Ali" }, "teste", { expiresIn: "1h" });
const app = express(); app.use(express.json()); app.use("/reports", reportsRoutes);
const srv = app.listen(0); const porta = srv.address().port;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const chamar = (p) => fetch(`http://127.0.0.1:${porta}${p}`,
  { headers: { authorization: "Bearer " + token } }).then(x => x.json());

const tela = await chamar(`/reports?de=${iso(de)}&ate=${iso(ate)}`);
const score = await chamar(`/reports/score?de=${iso(de)}&ate=${iso(ate)}`);

console.log("1. Cada corretor tem os mesmos números nos dois lugares");
for (const linha of tela.atendentes) {
  const s = score.equipe.find(x => x.id === linha.id);
  console.log(`   ${linha.nome.padEnd(8)} recebidos ${linha.recebidos}/${s.recebidos} · vendas ${linha.vendas}/${s.vendas}` +
    ` · conversão ${linha.conversao}%/${s.conversao}% · 1ª resposta ${linha.primeira_resposta_mediana_min}/${s.resposta_min ?? 0} min`);
  assert.equal(s.recebidos, linha.recebidos, `${linha.nome}: recebidos`);
  assert.equal(s.vendas, linha.vendas, `${linha.nome}: vendas`);
  assert.equal(s.conversao, linha.conversao, `${linha.nome}: conversão`);
  assert.equal(s.valor_vendido, linha.valor_vendido, `${linha.nome}: valor vendido`);
  assert.equal(s.resposta_min ?? 0, linha.primeira_resposta_mediana_min, `${linha.nome}: 1ª resposta`);
  assert.equal(s.visitas, linha.agendamentos, `${linha.nome}: visitas/agendamentos`);
  assert.equal(s.visitas_confirmadas, linha.agendamentos_confirmados, `${linha.nome}: confirmados por pessoa`);
  assert.equal(s.respondidos, linha.atendidos, `${linha.nome}: quantos ele respondeu`);
}

console.log("2. A venda de um lead ANTIGO fechada no período conta para os dois");
const mTela = tela.atendentes.find(x => x.id === marina);
const mScore = score.equipe.find(x => x.id === marina);
assert.equal(mTela.vendas, 1, "a tela conta pela data da venda");
assert.equal(mScore.vendas, 1, "o score também");
assert.equal(mScore.recebidos, 3, "e o lead antigo NÃO entra em recebidos");

console.log("3. A nota vem aberta: valor, régua e peso de cada parte");
const partes = mScore.partes;
console.log("   ", partes.map(p => `${p.rotulo} ${p.valor_texto} → ${p.nota}/100 (peso ${p.peso})`).join("\n    "));
assert.equal(partes.length, 6);
assert.ok(partes.every(p => p.como && p.regua), "toda parte explica de onde veio");
const soma = partes.reduce((s, p) => s + p.nota * p.peso, 0) / partes.reduce((s, p) => s + p.peso, 0);
assert.equal(Math.round(soma), mScore.score, "a nota final é a soma ponderada das partes mostradas");
console.log(`    nota final: ${mScore.score}`);

console.log("4. O período do score é o mesmo que o gestor escolheu");
assert.equal(score.periodo.de, tela.periodo.de);
assert.equal(score.periodo.ate, tela.periodo.ate);

console.log("5. Quem não recebeu lead mas fechou venda continua no ranking");
const soVenda = user("Bruno", "corretor");
lead({ dono: soVenda, entrouHa: 90, etapa: "Venda", venda: { valor: 300000, haDias: 3 } });
const r2 = ranking(org, { de, ate });
const b = r2.find(x => x.id === soVenda);
console.log(`   Bruno: ${b.recebidos} recebidos, ${b.vendas} venda, nota ${b.score}`);
assert.equal(b.sem_dados, false, "vendeu no período — não pode sumir do ranking");
assert.equal(b.vendas, 1);

srv.close();
console.log("\nTudo certo ✅");
