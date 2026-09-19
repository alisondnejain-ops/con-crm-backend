/* "RECEBIDOS" E "VENDAS" NO RELATÓRIO — DOIS DEFEITOS NO MESMO RELATO.
   (18-19/09/2026, relatado pelo Ali: "os relatórios de leads recebidos e
   leads vendidos não estão sendo atualizados automaticamente... quando ele
   recebe 4 leads no dia, aparece que recebeu 2 ou 7".)

   1. VENDA GRAVAVA COM A DATA DE ONTEM. `PATCH /leads/:id/venda` fazia
      `new Date(data).getTime()` com `data` = "AAAA-MM-DD" (o que o
      `<input type="date">` sempre manda) — sem hora, o JavaScript
      interpreta como MEIA-NOITE EM UTC, e Recife é UTC-3: a venda de HOJE
      gravava três horas ANTES da meia-noite local, ou seja, em ONTEM. Os
      relatórios filtram por limites do dia em hora LOCAL, então a venda
      ficava fora de "hoje" bem na tela feita para mostrá-la.

   2. "RECEBIDOS" CONTAVA PELA DATA DE NASCIMENTO DO LEAD, NÃO PELA DATA DO
      REPASSE. Nesta casa todo lead nasce com a atendente e é repassado
      depois — é a regra, não a exceção. Filtrar por `created_at` fazia um
      lead repassado HOJE, criado há três dias, não contar como recebido
      hoje: o corretor recebia 4 de verdade e o relatório mostrava 2.

   Este teste monta os dois casos e trava os dois consertos.

   Rodar:  npm run teste:relatorio-recebidos
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-relatorio-recebidos.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4645";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4645";
await new Promise(r => setTimeout(r, 700));

const DIA = 86400000;
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "AV-6", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const criarUser = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@av6.com", senha, role, Date.now()); return id; };
const gestor = criarUser("Fernanda", "adm");
const camila = criarUser("Camila", "sdr");
const marina = criarUser("Marina", "corretor");

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const { token } = await r.json();
  assert.ok(token, "login falhou para " + email);
  return token;
};
const tokenGestor = await login("fernanda@av6.com");

// Hoje e ontem em hora LOCAL, no formato AAAA-MM-DD que a tela manda.
const hojeStr = (() => { const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();

console.log("1. Lead nasceu há 3 dias com a Camila, e foi repassado para a Marina HOJE");
const leadId = "l_" + randomUUID();
const criadoEm = Date.now() - 3 * DIA;
const agora = Date.now();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,assigned_at,created_at)
  VALUES (?,?,?,?,'WhatsApp','{}','Atendimento',?,?,?)`)
  .run(leadId, org, "Cliente Repassado", "5587900000010", marina, agora, criadoEm);

let resp = await fetch(`${BASE}/reports?de=${hojeStr}&ate=${hojeStr}`, { headers: { authorization: "Bearer " + tokenGestor } });
let d = await resp.json();
const linhaMarina = d.atendentes.find(a => a.id === marina);
console.log(`   recebidos de Marina hoje: ${linhaMarina.recebidos} (esperado: 1 — repassado hoje, mesmo criado há 3 dias)`);
assert.equal(linhaMarina.recebidos, 1, "o repasse de hoje tinha que contar como recebido hoje, não pela data de criação do lead");
assert.ok(linhaMarina.por_dia.length === 1 && linhaMarina.por_dia[0].recebidos === 1,
  "o detalhamento por dia tinha que mostrar o repasse no dia certo (hoje), não no dia em que o lead nasceu");

console.log("2. E ontem ele não aparece pra ela — o lead só ficou com a Marina hoje");
const ontemStr = (() => { const d = new Date(Date.now() - DIA); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();
resp = await fetch(`${BASE}/reports?de=${ontemStr}&ate=${ontemStr}`, { headers: { authorization: "Bearer " + tokenGestor } });
d = await resp.json();
const marinaOntem = d.atendentes.find(a => a.id === marina);
console.log(`   recebidos de Marina ontem: ${marinaOntem.recebidos} (esperado: 0)`);
assert.equal(marinaOntem.recebidos, 0);

console.log("3. Registrar a venda com a data de HOJE (a que o <input type=date> manda, sem hora)");
resp = await fetch(`${BASE}/leads/${leadId}/venda`, { method: "PATCH", headers: { authorization: "Bearer " + tokenGestor, "content-type": "application/json" },
  body: JSON.stringify({ valor: "300000", data: hojeStr, imovel: "Apto 302" }) });
d = await resp.json();
console.log(`   ${resp.status} · ${JSON.stringify(d)}`);
assert.equal(resp.status, 200);

const leadNoBanco = db.prepare("SELECT sale_date FROM leads WHERE id = ?").get(leadId);
const dataGravada = new Date(leadNoBanco.sale_date);
console.log(`   sale_date gravado: ${dataGravada.toString()} (dia local: ${dataGravada.getDate()}, hoje é dia: ${new Date().getDate()})`);
assert.equal(dataGravada.getDate(), new Date().getDate(),
  "a venda de hoje tinha que gravar com o DIA local de hoje, não o de ontem (fuso UTC vs America/Recife)");

console.log("4. E a venda aparece no relatório de HOJE — não só no banco");
resp = await fetch(`${BASE}/reports?de=${hojeStr}&ate=${hojeStr}`, { headers: { authorization: "Bearer " + tokenGestor } });
d = await resp.json();
const marinaComVenda = d.atendentes.find(a => a.id === marina);
console.log(`   vendas de Marina hoje: ${marinaComVenda.vendas} (esperado: 1) · total da casa: ${d.total.vendas}`);
assert.equal(marinaComVenda.vendas, 1, "a venda registrada com a data de hoje tinha que aparecer no relatório de hoje");
assert.equal(d.total.vendas, 1);

console.log("\nTudo certo ✅");
process.exit(0);
