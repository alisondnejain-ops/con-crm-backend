/* O corretor precisa SABER que recebeu o lead.

   Duas coisas quebravam isso, e a segunda é a que engana:

   1) o lead recém-repassado afundava na lista dele. A ordem usava a data de
      ENTRADA do lead, então um lead de junho passado agora ficava atrás de
      leads antigos — só por ser antigo;
   2) o repasse respondia "ok" tanto para o corretor que recebe push no celular
      quanto para o que não recebe nada. A atendente passava o lead achando que
      alguém tinha sido chamado. Lead entregue a quem não sabe que recebeu fica
      parado exatamente como se não tivesse sido entregue.

   Rodar:  npm run teste:repasse
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-repasse.db");
process.env.JWT_SECRET = "teste";
// Com chave VAPID: é o caso em que o push do servidor está ligado.
process.env.VAPID_PUBLIC_KEY = "BKd0FIS_bkm3ZqL9nQ0EgVW3sOJ3W7v3rtjJ_9F1F0kZ0y3bZ9m4H2eYy2nJ8s4wKJ0YyQ0K4mS8bqK1t0Zx0Ac";
process.env.VAPID_PRIVATE_KEY = "kJ8vQ1nZ2mX3bV4cN5aS6dF7gH8jK9lP0oI1uY2tR3e";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
/* O corte do fim do expediente roda antes de qualquer rota de distribuição e
   desliga quem se prontificou antes das 18:00. Aqui ele já é dado como
   aplicado: o teste é sobre o repasse, não sobre o corte (que tem o teste
   dele). Sem isto a equipe inteira nasce indisponível e nada é repassado. */
db.prepare("UPDATE orgs SET ultimo_corte = ? WHERE id = ?").run(Date.now(), org);

const camila = user("Camila", "sdr");
const comPush = user("Marina", "corretor");     // cadastrou o celular
const semPush = user("Rafael", "corretor");     // nunca ativou

db.prepare(`INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES (?,?,?,?,?)`)
  .run("https://push.exemplo/marina", comPush, "p256", "auth", Date.now());

const novoLead = (nome, dias) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,priority,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, org, nome, "55879" + Math.floor(10000000 + Math.random() * 8e7), "FRIO", "Atendimento",
      camila, Date.now() - dias * 86400000);
  return id; };

const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: distRoutes } = await import("../src/routes/distribution.routes.js");
const { default: leadsRoutes } = await import("../src/routes/leads.routes.js");
const app = express(); app.use(express.json());
app.use("/distribution", distRoutes); app.use("/leads", leadsRoutes);
const srv = app.listen(0); const porta = srv.address().port;
const cracha = (id, role) => jwt.sign({ id, role, org_id: org, name: id }, "teste", { expiresIn: "1h" });
const chamar = (quem, p, m, body) => fetch(`http://127.0.0.1:${porta}${p}`, { method: m || "GET",
  headers: { authorization: "Bearer " + quem, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}) }).then(async x => ({ status: x.status, corpo: await x.json() }));

console.log("1. Repasse para quem TEM notificação: a atendente não recebe alarme falso");
const antigo = novoLead("Lead de junho", 60);
let r = await chamar(cracha(camila, "sdr"), "/distribution/handoff", "POST", { lead_id: antigo, user_id: comPush });
console.log("   aviso:", JSON.stringify(r.corpo.aviso));
assert.equal(r.status, 200);
assert.equal(r.corpo.aviso.push, true);

console.log("2. Repasse para quem NÃO ativou: a resposta diz isso");
const outro = novoLead("Lead sem push", 60);
r = await chamar(cracha(camila, "sdr"), "/distribution/handoff", "POST", { lead_id: outro, user_id: semPush });
console.log("   aviso:", JSON.stringify(r.corpo.aviso));
assert.equal(r.corpo.aviso.push, false);
assert.equal(r.corpo.aviso.motivo, "corretor_sem_notificacao");

console.log("3. O repasse carimba a hora em que o lead caiu na mão do corretor");
const quando = db.prepare("SELECT assigned_at FROM leads WHERE id=?").get(antigo).assigned_at;
console.log("   assigned_at:", new Date(quando).toLocaleString("pt-BR"), "| entrou em: há 60 dias");
assert.ok(quando > Date.now() - 60000, "é a hora do repasse, não a da entrada do lead");

console.log("4. É essa data que tira o lead do fundo da lista");
const recentes = novoLead("Entrou hoje", 0);
await chamar(cracha(camila, "sdr"), "/distribution/handoff", "POST", { lead_id: recentes, user_id: comPush });
const lista = (await chamar(cracha(comPush, "corretor"), "/leads")).corpo;
const doAntigo = lista.find(l => l.id === antigo);
console.log(`   "${doAntigo.name}" entrou há 60 dias e foi repassado agora`);
assert.ok(doAntigo.assigned_at > doAntigo.created_at + 50 * 86400000,
  "a lista tem como saber que o lead é velho MAS chegou agora");

console.log("5. Devolver para a fila limpa o carimbo — não está com ninguém");
r = await chamar(cracha(camila, "sdr"), "/distribution/devolver", "POST", { lead_id: antigo });
assert.equal(db.prepare("SELECT assigned_at FROM leads WHERE id=?").get(antigo).assigned_at, null);

srv.close();
console.log("\nTudo certo ✅");
