/* A catraca dos corretores: quem é o próximo, e o número na tela.

   Pedido do Ali (25/08/2026): numerar a catraca e mostrar quem recebe o
   próximo lead. Antes de mostrar, a fila precisou parar de mudar sozinha —
   senão o número seria uma promessa que o botão não cumpre.

   Os dois defeitos que este teste tranca:

   1) a vez era `contador % quantos estão disponíveis`. A lista de disponíveis
      muda o dia inteiro, e o resto da divisão mudava junto: alguém marcar
      prontidão à tarde reordenava a fila de todo mundo, sem ninguém ter
      recebido nada;
   2) `/next` sorteava entre corretores E atendentes, `/handoff` só entre
      corretores, e os dois avançavam o MESMO contador.

   E uma regra nova: escolher um corretor a dedo também manda ele para o fim
   da fila. Sem isso, quem foi escolhido na mão continuava sendo o próximo.

   Rodar:  npm run teste:rodizio
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-rodizio.db");
process.env.JWT_SECRET = "teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { filaDaVez, pegarProximo, marcarQueRecebeu } = await import("../src/services/rodizio.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "ROD-1", Date.now());

let ordem = 0;
const user = (nome, role, disp = 1) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,?,?,'ativo')`).run(id, org, nome, nome + "@r.com", role, disp, Date.now() + (ordem++));
  return id; };

const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"),
      juliana = user("Juliana", "corretor"), diego = user("Diego", "corretor");
user("Vanessa", "sdr");   // a atendente NÃO entra na fila dos corretores

const nomes = (f) => f.fila.filter(x => x.posicao).map(x => `${x.posicao}º ${x.name}`).join(", ");

console.log("1. A fila nasce numerada, na ordem da roda");
let f = filaDaVez(org);
console.log(`   ${nomes(f)} · próximo: ${f.proximo.name}`);
assert.equal(f.disponiveis, 4);
assert.equal(f.proximo.name, "Marina");
assert.deepEqual(f.fila.filter(x => x.posicao).map(x => x.name), ["Marina", "Rafael", "Juliana", "Diego"]);

console.log("2. A atendente não aparece na catraca dos corretores");
assert.ok(!f.fila.some(x => x.name === "Vanessa"), "quem distribui não entra na fila de quem recebe");

console.log("3. Recebeu, foi para o fim");
assert.equal(pegarProximo(org), marina);
f = filaDaVez(org);
console.log(`   ${nomes(f)} · próximo: ${f.proximo.name}`);
assert.equal(f.proximo.name, "Rafael");
assert.equal(f.fila.find(x => x.name === "Marina").posicao, 4, "a Marina foi para o fim");

console.log("4. O DEFEITO ANTIGO: alguém marcar disponibilidade não pode reordenar a fila");
/* Com "contador % disponíveis", entrar alguém na lista mudava o resto da
   divisão e a vez pulava para outra pessoa — sem ninguém ter recebido lead. */
const novato = user("Zeca", "corretor");
f = filaDaVez(org);
console.log(`   entrou o Zeca → próximo: ${f.proximo.name}`);
assert.equal(f.proximo.name, "Rafael", "o próximo continua sendo quem era");

db.prepare("UPDATE users SET available = 0 WHERE id = ?").run(juliana);
f = filaDaVez(org);
console.log(`   Juliana ficou indisponível → ${nomes(f)}`);
assert.equal(f.proximo.name, "Rafael", "e continua");
assert.equal(f.fila.find(x => x.name === "Juliana").posicao, null, "sai da fila, mas segue na lista");
assert.ok(f.fila.some(x => x.name === "Juliana"), "some do número, não da tela");

console.log("5. Quem está indisponível é pulado na vez");
assert.equal(pegarProximo(org), rafael);
const pulou = pegarProximo(org);
console.log(`   depois do Rafael veio: ${db.prepare("SELECT name FROM users WHERE id=?").get(pulou).name}`);
assert.equal(pulou, diego, "a Juliana estava indisponível, então a vez passou dela");

console.log("6. Escolher a dedo também manda para o fim da fila");
/* Sem isto o rodízio não divide nada: a atendente escolhe a Marina, e a
   Marina continua sendo a próxima — leva dois leads seguidos. */
marcarQueRecebeu(org, marina);
f = filaDaVez(org);
console.log(`   escolhi a Marina na mão → ${nomes(f)}`);
assert.equal(f.fila.find(x => x.name === "Marina").posicao, f.disponiveis, "foi para o último lugar");

console.log("7. A roda dá a volta e não repete ninguém antes da hora");
db.prepare("UPDATE users SET available = 1 WHERE org_id = ?").run(org);
db.prepare("UPDATE orgs SET rodizio_ultimo = NULL WHERE id = ?").run(org);
const volta = [];
for (let i = 0; i < 5; i++) volta.push(db.prepare("SELECT name FROM users WHERE id=?").get(pegarProximo(org)).name);
console.log(`   ${volta.join(" → ")}`);
assert.equal(new Set(volta).size, 5, "cinco corretores, cinco pessoas diferentes na volta");
const depoisDaVolta = db.prepare("SELECT name FROM users WHERE id=?").get(pegarProximo(org)).name;
console.log(`   e a sexta entrega volta para: ${depoisDaVolta}`);
assert.equal(depoisDaVolta, volta[0], "a roda recomeçou de onde começou");

console.log("8. Ninguém disponível: a fila diz isso em vez de escolher errado");
db.prepare("UPDATE users SET available = 0 WHERE org_id = ? AND role='corretor'").run(org);
f = filaDaVez(org);
console.log(`   próximo: ${f.proximo} · disponíveis: ${f.disponiveis} · na lista: ${f.fila.length}`);
assert.equal(f.proximo, null);
assert.equal(f.disponiveis, 0);
assert.equal(f.fila.length, 5, "os corretores continuam visíveis, sem número");
assert.equal(pegarProximo(org), null, "e a entrega automática recusa em vez de sortear alguém indisponível");

console.log("\nTudo certo ✅");
