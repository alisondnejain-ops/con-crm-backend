/* A PORTA DE ENTRADA DE QUEM VEM DO SITE. (02/09/2026)

   `POST /publico/comecar` é a ÚNICA rota de escrita da plataforma que qualquer
   pessoa da internet chama sem login e sem código de convite. O
   `/auth/register` é aberto mas exige o ADM_CODE; o `/orgs/autonomos` exige
   master. Esta não exige nada.

   Por isso o teste sobe o servidor inteiro e bate de fora: o que importa aqui
   não é o serviço funcionar, é a rota estar ABERTA para quem deve e FECHADA
   para o resto — e nenhuma dessas duas coisas se prova por dentro.

   Rodar:  npm run teste:porta-do-site
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-porta-site.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4717;
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
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1400)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
console.log("Servidor no ar, igual à produção.\n");

const { default: db } = await import("../src/db.js");

/* Cada pedido finge vir de um IP diferente, senão o freio de cinco por hora
   derruba o próprio teste no sexto caso — que seria o teste medindo a si
   mesmo em vez de medir a regra. */
let n = 0;
const comecar = (corpo, ip) => fetch(url("/publico/comecar"), {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-forwarded-for": ip || `10.0.0.${++n}` },
  body: JSON.stringify(corpo) });

console.log("===== A PORTA ESTÁ ABERTA =====");

console.log("1. Sem login nenhum, o corretor cria a conta de teste");
let r = await comecar({ nome: "Marcos Corretor", email: "marcos@teste.com", telefone: "(87) 9 9111-2222" });
let d = await r.json();
console.log(`   ${r.status} · ${d.nome} · ${d.dias} dias · link: ${d.link ? "sim" : "NÃO"}`);
assert.equal(r.status, 201);
assert.equal(d.dias, 14);
assert.ok(d.link, "o link volta na resposta — sem ele o site não tem para onde mandar a pessoa");

console.log("2. Nasce como conta de AUTÔNOMO, com ele de dono");
const org = db.prepare(`SELECT o.tipo, o.dono_user_id, u.name, u.role, u.status, u.invite_tipo, u.phone
  FROM orgs o JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'marcos@teste.com'`).get();
console.log(`   tipo ${org.tipo} · ${org.name} é ${org.role} (${org.status}, ${org.invite_tipo}) · tel ${org.phone}`);
assert.equal(org.tipo, "autonomo");
/* CORRETOR, e não `adm` (mudou em 02/09/2026). Como `adm` ele ficava fora de
   tudo que o sistema procura por papel — a catraca que entrega o lead, o
   rodízio, o score, o relatório de produtividade — e pagava por um CRM cujo
   relatório principal nunca teria o nome dele. O poder de gestor vem de ser o
   DONO, e está trancado no teste `corretor-autonomo`. */
assert.equal(org.role, "corretor");
assert.equal(org.invite_tipo, "fundador", "fundador entra direto ao definir a senha, sem fila de aprovação");

console.log("3. O telefone é normalizado igual ao do WhatsApp");
assert.equal(org.phone, "5587991112222");
console.log(`   ${org.phone}`);

console.log("4. O TESTE AINDA NÃO COMEÇOU — ele começa ao definir a senha");
/* Quem preenche o formulário às 23h e só abre o e-mail na segunda não pode
   chegar com três dias a menos. */
const trial = db.prepare("SELECT trial_ate FROM orgs WHERE dono_user_id = ?").get(org.dono_user_id).trial_ate;
console.log(`   trial_ate: ${trial === null ? "ainda nulo, como tem que ser" : "JÁ CONTANDO"}`);
assert.equal(trial, null);

console.log("\n===== O QUE ELA RECUSA =====");

console.log("5. E-mail que já tem conta ATIVA não cria outra — manda entrar");
/* Criar a segunda seria o pior desfecho: a pessoa ficaria com duas contas,
   cada uma com metade dos leads, e descobriria semanas depois. */
r = await comecar({ nome: "Ali de novo", email: "ali@teste.com", telefone: "87 99111-3333" });
d = await r.json();
console.log(`   ${r.status} · ${d.error}`);
assert.equal(r.status, 409);
assert.equal(d.ja_tem_conta, true);
assert.ok(d.entrar, "e devolve para onde ir");

console.log("6. Quem começou e NÃO terminou pode tentar de novo");
/* Sem isso, quem fechou a aba antes de criar a senha ficaria preso para
   sempre: o e-mail já existiria e nenhum caminho o levaria de volta. */
r = await comecar({ nome: "Marcos Corretor", email: "marcos@teste.com", telefone: "87 99111-2222" });
console.log(`   ${r.status}`);
assert.equal(r.status, 201);

console.log("7. E-mail torto é recusado com frase de gente");
r = await comecar({ nome: "Sem arroba", email: "naoehemail", telefone: "87 99111-4444" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("8. Telefone inválido é recusado");
/* Corretor sem WhatsApp válido é corretor com quem ninguém consegue falar —
   nem nós, para vender, nem o suporte depois. */
r = await comecar({ nome: "Sem zap", email: "semzap@teste.com", telefone: "123" });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("9. Nome vazio é recusado");
r = await comecar({ nome: " ", email: "vazio@teste.com", telefone: "87 99111-5555" });
console.log(`   ${r.status}`);
assert.equal(r.status, 400);

console.log("\n===== O FREIO =====");

console.log("10. Cinco cadastros do mesmo computador passam; o sexto não");
/* Sem freio, um laço de dez linhas cria dez mil imobiliárias numa madrugada e
   a limpeza é manual. */
const IP = "200.1.2.3";
let ultimos = [];
for (let i = 0; i < 6; i++) {
  const resp = await comecar({ nome: `Teste ${i}`, email: `robo${i}@teste.com`, telefone: "87 98888-100" + i }, IP);
  ultimos.push(resp.status);
}
console.log(`   respostas: ${ultimos.join(", ")}`);
assert.deepEqual(ultimos.slice(0, 5), [201, 201, 201, 201, 201]);
assert.equal(ultimos[5], 429, "o sexto do mesmo IP leva 429");

console.log("11. E o freio é por IP — outro computador continua passando");
/* Um escritório inteiro testando não pode ser barrado por causa de um vizinho. */
r = await comecar({ nome: "Outro lugar", email: "outro@teste.com", telefone: "87 97777-1111" }, "200.9.9.9");
console.log(`   ${r.status}`);
assert.equal(r.status, 201);

console.log("\n===== A VITRINE DE PREÇOS =====");

console.log("12. O site lê os planos DO SERVIDOR, sem login");
/* Copiados no Lovable, seriam uma segunda verdade sobre dinheiro — divergindo
   no primeiro reajuste e sendo descoberta pelo cliente. */
r = await fetch(url("/publico/planos"));
d = await r.json();
console.log(`   ${r.status} · ${d.planos.map(p => `${p.nome} R$ ${p.mensal}`).join(" · ")}`);
assert.equal(r.status, 200);
assert.ok(d.planos.length >= 3);
assert.equal(d.trial_dias, 14);

console.log("13. E o resto do sistema continua fechado");
/* A rota nova é aberta; montá-la no lugar errado abriria as vizinhas junto —
   é a armadilha de ordem que já custou os leads deste CRM uma vez. */
const fechadas = [];
for (const caminho of ["/leads", "/reports/score", "/config/conexao", "/canais", "/orgs"]) {
  const resp = await fetch(url(caminho));
  fechadas.push(`${caminho}=${resp.status}`);
  assert.ok(resp.status === 401 || resp.status === 402,
    `${caminho} respondeu ${resp.status} — deveria exigir login`);
}
console.log(`   ${fechadas.join(" · ")}`);

console.log("\n===== O QUE VEIO DO POPUP DO SITE (02/09/2026) =====");

console.log("14. Quem diz 'tenho imobiliária' recebe uma conta de IMOBILIÁRIA");
/* O `tipo` não é preferência de tela: conta de autônomo recusa cadastro de
   corretor e limita a um atendente. Uma imobiliária que caísse como autônomo só
   descobriria isso ao cadastrar o segundo corretor, com a equipe olhando. */
r = await comecar({ nome: "Marta Gestora", email: "marta@imob.com", telefone: "87 99222-0001",
  tipo: "imobiliaria", plano: "essencial-anual" });
d = await r.json();
const oImob = db.prepare(`SELECT o.tipo, o.plano_escolhido, o.plano_id FROM orgs o
  JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'marta@imob.com'`).get();
console.log(`   ${r.status} · tipo ${oImob.tipo} · escolheu ${oImob.plano_escolhido}`);
assert.equal(r.status, 201);
assert.equal(oImob.tipo, "imobiliaria");
assert.equal(oImob.plano_escolhido, "essencial-anual");
assert.equal(d.tipo, "imobiliaria");
assert.equal(d.plano.mensal, 377, "o preço volta do servidor, não do que o site mandou");

console.log("15. A intenção NÃO vira plano contratado");
/* `plano_id` é o plano contratado — gravado quando o Asaas confirma a cobrança,
   e é ele que manda no vencimento. Gravar a intenção lá diria que a conta tem
   contrato durante os 14 dias de teste. */
console.log(`   plano_escolhido: ${oImob.plano_escolhido} · plano_id: ${oImob.plano_id}`);
assert.equal(oImob.plano_id, null);

console.log("16. Corretor escolhendo plano de corretor");
r = await comecar({ nome: "Caio Corretor", email: "caio@ex.com", telefone: "87 99222-0002",
  tipo: "corretor", plano: "anual" });
d = await r.json();
const oAut = db.prepare(`SELECT o.tipo, o.plano_escolhido FROM orgs o
  JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'caio@ex.com'`).get();
console.log(`   ${r.status} · tipo ${oAut.tipo} · escolheu ${oAut.plano_escolhido} · R$ ${d.plano.mensal}`);
assert.equal(oAut.tipo, "autonomo");
assert.equal(oAut.plano_escolhido, "anual");
assert.equal(d.plano.mensal, 147);

console.log("17. Plano da FAMÍLIA ERRADA não vale — mas não derruba o cadastro");
/* É deliberado, e é o contrário do que este projeto costuma fazer com entrada
   inválida. O site e o servidor moram em repositórios e hospedagens diferentes
   e sobem em momentos diferentes: recusar faria a ÚNICA porta de entrada de
   cliente novo fechar em silêncio no dia em que um id mudasse aqui. Ninguém
   descobre uma porta que não toca campainha. */
r = await comecar({ nome: "Trocado", email: "trocado@ex.com", telefone: "87 99222-0003",
  tipo: "corretor", plano: "essencial-anual" });
d = await r.json();
const oTroc = db.prepare(`SELECT o.plano_escolhido FROM orgs o
  JOIN users u ON u.id = o.dono_user_id WHERE u.email = 'trocado@ex.com'`).get();
console.log(`   ${r.status} · gravado: ${oTroc.plano_escolhido} · plano_reconhecido: ${d.plano_reconhecido}`);
assert.equal(r.status, 201, "a conta é criada assim mesmo");
assert.equal(oTroc.plano_escolhido, null, "e nada errado é gravado");
assert.equal(d.plano_reconhecido, false, "mas a resposta AVISA que não anotou");

console.log("18. Sem escolha nenhuma, `plano_reconhecido` é nulo — não é `false`");
/* São coisas diferentes: `false` é "você mandou algo e eu não entendi", nulo é
   "não havia nada para entender". A tela pergunta de novo só no primeiro caso. */
r = await comecar({ nome: "Sem Popup", email: "sempopup@ex.com", telefone: "87 99222-0004" });
d = await r.json();
console.log(`   ${r.status} · tipo ${d.tipo} · plano ${d.plano} · reconhecido: ${d.plano_reconhecido}`);
assert.equal(d.tipo, "autonomo", "sem informar, continua sendo o padrão de sempre");
assert.equal(d.plano, null);
assert.equal(d.plano_reconhecido, null);

console.log("19. A vitrine serve as DUAS famílias, e mantém o campo antigo");
/* `planos` continua sendo o do autônomo sozinho: era isso que o campo
   significava quando o site começou a ler daqui, e os dois lados são publicados
   por caminhos diferentes — renomear quebraria a vitrine no ar sem aviso. */
r = await fetch(url("/publico/planos"));
d = await r.json();
console.log(`   autônomo: ${d.autonomo.map(p => p.mensal).join("/")} · imobiliária: ${d.imobiliaria.map(p => p.id).join(", ")}`);
assert.deepEqual(d.planos.map(p => p.id), d.autonomo.map(p => p.id), "o campo antigo continua sendo o do autônomo");
assert.equal(d.autonomo.length, 3);
assert.equal(d.imobiliaria.length, 6);
assert.ok(d.imobiliaria.every(p => p.plano && p.ciclo_nome), "cada um diz o plano e o ciclo, para a tela montar o rótulo");

console.log("\nTudo certo ✅");
fim(0);
