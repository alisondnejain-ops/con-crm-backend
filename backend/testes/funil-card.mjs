/* O que o card do funil precisa saber: desde quando o lead está na etapa, e o
   que está marcado com ele.

   As duas coisas são novas no banco, e a primeira tem uma armadilha: é
   tentador preencher "nesta etapa desde" com a data de criação do lead quando
   não há histórico. Seria mentira — o lead pode estar em Aprovação há uma
   semana e ter entrado há três meses. Este teste trava o `null`.

   Rodar:  npm run teste:funil-card
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-funil-card.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { moverEtapa, historicoDoLead } = await import("../src/services/etapas.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
const marina = user("Marina", "corretor"), ali = user("Ali", "adm");

const novoLead = (nome, etapa) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, org, nome, "55879" + Math.floor(10000000 + Math.random() * 8e7), etapa, marina, Date.now() - 90 * 86400000);
  return id; };

const semHistorico = novoLead("Antigo", "Aprovação");
const comHistorico = novoLead("Joana", "Lead");

console.log("1. Mudar de etapa deixa rastro: de onde, para onde, por quê e quem");
moverEtapa({ leadId: comHistorico, para: "Atendimento", motivo: "palavra" });
moverEtapa({ leadId: comHistorico, para: "Pasta", motivo: "ia", userId: marina });
const h = historicoDoLead(comHistorico);
console.log("   ", h.map(x => `${x.de}→${x.para} (${x.motivo}${x.quem ? ", " + x.quem : ""})`).join(" · "));
assert.equal(h.length, 2);
assert.equal(h[1].para, "Pasta");
assert.equal(h[1].motivo, "ia");
assert.equal(h[1].quem, "Marina");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(comHistorico).stage, "Pasta",
  "a etapa do lead anda junto com o histórico");

console.log("2. Mover para a etapa em que já está não gera linha repetida");
assert.equal(moverEtapa({ leadId: comHistorico, para: "Pasta", motivo: "mao", userId: ali }), false);
assert.equal(historicoDoLead(comHistorico).length, 2);

console.log("3. Lead sem histórico devolve null — nunca a data de criação");
const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: leadsRoutes } = await import("../src/routes/leads.routes.js");
const { default: tarefasRoutes } = await import("../src/routes/tarefas.routes.js");
const token = jwt.sign({ id: ali, role: "adm", org_id: org, name: "Ali" }, "teste", { expiresIn: "1h" });
const app = express(); app.use(express.json()); app.use("/leads", leadsRoutes); app.use(tarefasRoutes);
const srv = app.listen(0); const porta = srv.address().port;
const chamar = (p, m, body) => fetch(`http://127.0.0.1:${porta}${p}`, {
  method: m || "GET", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}) }).then(async x => ({ status: x.status, corpo: await x.json() }));

let lista = (await chamar("/leads")).corpo;
const antigo = lista.find(l => l.id === semHistorico);
const joana = lista.find(l => l.id === comHistorico);
console.log(`   Antigo: ${antigo.etapa_desde} · Joana: ${new Date(joana.etapa_desde).toLocaleString("pt-BR")}`);
assert.equal(antigo.etapa_desde, null, "sem histórico é null, não a data de criação");
assert.ok(joana.etapa_desde > Date.now() - 60000, "com histórico, a data da última mudança");

console.log("4. Tarefa precisa de texto e de data — sem data não dá para cobrar");
assert.equal((await chamar(`/leads/${comHistorico}/tarefas`, "POST", { titulo: "", quando: new Date().toISOString() })).status, 400);
assert.equal((await chamar(`/leads/${comHistorico}/tarefas`, "POST", { titulo: "Ligar" })).status, 400);

console.log("5. A tarefa nasce no nome de quem está com o lead, não de quem escreveu");
const ontem = new Date(Date.now() - 86400000).toISOString();
const amanha = new Date(Date.now() + 86400000).toISOString();
await chamar(`/leads/${comHistorico}/tarefas`, "POST", { titulo: "Levar a pasta na Caixa", quando: ontem });
let r = await chamar(`/leads/${comHistorico}/tarefas`, "POST", { titulo: "Confirmar a visita", quando: amanha });
console.log("   ", r.corpo.tarefas.map(t => `${t.titulo} (${t.de_quem})`).join(" · "));
assert.equal(r.corpo.tarefas.length, 2);
assert.ok(r.corpo.tarefas.every(t => t.de_quem === "Marina"), "o gestor marcou, mas a tarefa é da Marina");

console.log("6. A lista do funil traz a PRÓXIMA tarefa e avisa quando venceu");
lista = (await chamar("/leads")).corpo;
const t = lista.find(l => l.id === comHistorico).tarefas;
console.log(`   ${t.abertas} aberta(s) · próxima: "${t.titulo}" · atrasada: ${t.atrasada}`);
assert.equal(t.abertas, 2);
assert.equal(t.titulo, "Levar a pasta na Caixa", "a próxima é a mais antiga em aberto");
assert.equal(t.atrasada, true, "venceu ontem");

console.log("7. Marcada como feita, sai da conta do card");
const feita = r.corpo.tarefas.find(x => x.titulo === "Levar a pasta na Caixa");
await chamar(`/tarefas/${feita.id}`, "PATCH", { feito: true });
lista = (await chamar("/leads")).corpo;
const t2 = lista.find(l => l.id === comHistorico).tarefas;
console.log(`   agora: ${t2.abertas} aberta(s) · "${t2.titulo}" · atrasada: ${t2.atrasada}`);
assert.equal(t2.abertas, 1);
assert.equal(t2.atrasada, false);

console.log("8. Lead sem tarefa não inventa objeto — o card não desenha a linha");
assert.equal(lista.find(l => l.id === semHistorico).tarefas, null);

srv.close();
console.log("\nTudo certo ✅");
