/* "ESQUECI MINHA SENHA" — a redefinição por e-mail. (02/09/2026)

   Até aqui recuperar senha era pedir ao gestor, que gerava o link em Equipe e
   repassava no WhatsApp. Com o Resend ligado, o caminho passou a ser o do
   resto do mercado: a pessoa digita o e-mail e o link chega.

   ===== POR QUE ESTE TESTE SOBE O SERVIDOR =====

   Porque é mais uma rota de ESCRITA que a internet chama sem login, e o que
   importa nela não é o serviço funcionar: é ela responder SEMPRE A MESMA
   COISA. Qualquer diferença entre "existe" e "não existe" — a frase, o código
   HTTP, o que vem no corpo — transforma a rota num consultor de e-mails
   cadastrados, e isso não se prova por dentro do serviço.

   Rodar:  npm run teste:esqueci-senha
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-esqueci.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4762;
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
const bcrypt = (await import("bcryptjs")).default;
const { randomUUID } = await import("crypto");

const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
const criar = (nome, email, status, comSenha = true) => {
  const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,'corretor',1,?,?)`)
    .run(id, org, nome, email, comSenha ? bcrypt.hashSync("123456", 8) : "", Date.now(), status);
  return id;
};
const uMarina = criar("Marina", "marina@teste.com", "ativo");
criar("Removido", "removido@teste.com", "removido");
const uNunca = criar("Nunca Entrou", "nunca@teste.com", "pendente", false);

let n = 0;
const pedir = (email, ip) => fetch(url("/auth/esqueci-senha"), {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-forwarded-for": ip || `10.0.1.${++n}` },
  body: JSON.stringify({ email }) });
/* Desde 02/09/2026 o banco guarda a IMPRESSAO DIGITAL do token, nunca o token
   — ver `resumoDeConvite` em auth.js. Em claro, a copia de seguranca diaria
   (que vai para um armazenamento de terceiros) era uma lista de links prontos
   para trocar a senha de qualquer conta pendente.

   Consequencia para este teste: nao da mais para "descobrir" o link olhando a
   tabela. O caso 11 passa a pega-lo de onde uma pessoa de verdade o pega — o
   log do servidor, que e o modo manual documentado quando nao ha provedor de
   e-mail configurado. E melhor assim: testa o caminho que existe. */
const tokenDe = (email) => db.prepare("SELECT invite_hash, invite_token, invite_tipo, invite_expires FROM users WHERE email = ?").get(email);

console.log("===== O CAMINHO FELIZ =====");

console.log("1. Quem tem conta ativa ganha um token de redefinição");
let r = await pedir("marina@teste.com");
let d = await r.json();
console.log(`   ${r.status} · "${d.mensagem.slice(0, 60)}…"`);
assert.equal(r.status, 200);
const t1 = tokenDe("marina@teste.com");
console.log(`   token: ${t1.invite_hash ? "gerado" : "NÃO"} · tipo: ${t1.invite_tipo}`);
assert.ok(t1.invite_hash, "sem token não há como criar senha nova");
assert.equal(t1.invite_token, null, "e o token em claro NÃO pode ficar guardado");
assert.equal(t1.invite_tipo, "redefinicao", "é redefinição, não convite — a conta já existe e continua ativa");

console.log("2. E o token vale 24 horas, não 7 dias");
/* O convite dura uma semana porque a pessoa pode demorar a ver o e-mail. Um
   link que troca a senha de conta ATIVA é outra coisa: quanto mais tempo ele
   fica valendo numa caixa de entrada, maior a janela de quem tiver acesso a
   ela. */
const horas = Math.round((t1.invite_expires - Date.now()) / 3600000);
console.log(`   vale por ~${horas}h`);
assert.ok(horas >= 23 && horas <= 24, `esperava 24h, veio ${horas}h`);

console.log("3. O LINK NÃO VOLTA na resposta");
/* Aqui quem pede só digitou um endereço de e-mail — pode ser qualquer um.
   Devolver o link entregaria a chave da conta a quem sabe o e-mail alheio. Na
   rota do gestor ele volta, porque lá quem pede está logado e é o dono da
   casa. */
console.log(`   campos da resposta: ${Object.keys(d).join(", ")}`);
assert.ok(!JSON.stringify(d).includes(t1.invite_hash), "nem o resumo dele pode aparecer na resposta");
assert.ok(!d.link, "nem o link");

console.log("\n===== O QUE ELA NÃO CONTA =====");

console.log("4. E-mail que não existe responde IGUALZINHO");
/* É a trava principal. Se a resposta mudasse, bastaria ir testando endereços
   para descobrir quais dos seus clientes usam o ConHub. */
r = await pedir("ninguem@lugarnenhum.com");
const dNinguem = await r.json();
console.log(`   ${r.status} · mesma frase: ${dNinguem.mensagem === d.mensagem}`);
assert.equal(r.status, 200);
assert.deepEqual(dNinguem, d, "a resposta tem que ser byte a byte a mesma");

console.log("5. Conta REMOVIDA também — e não gera token");
r = await pedir("removido@teste.com");
assert.deepEqual(await r.json(), d);
console.log(`   token gerado? ${tokenDe("removido@teste.com").invite_hash ? "SIM ✘" : "não ✔"}`);
assert.equal(tokenDe("removido@teste.com").invite_hash, null);

console.log("6. Quem NUNCA definiu senha também — o caminho dela é o convite");
/* Gerar uma "redefinição" aqui derrubaria o convite original que a pessoa
   ainda tem na caixa de entrada, trocando um link válido por outro sem que
   ninguém tivesse pedido. */
const antes = tokenDe("nunca@teste.com").invite_hash;
r = await pedir("nunca@teste.com");
assert.deepEqual(await r.json(), d);
console.log(`   convite preservado: ${tokenDe("nunca@teste.com").invite_hash === antes}`);
assert.equal(tokenDe("nunca@teste.com").invite_hash, antes);

console.log("7. E-mail sem formato de e-mail é recusado com frase de gente");
/* Este é o único 400 da rota, e ele não conta nada sobre contas: "abc" não é
   endereço nenhum, existindo ou não. */
r = await pedir("nao-e-email");
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("\n===== OS FREIOS =====");

console.log("8. Três pedidos por E-MAIL por hora; o quarto não manda mais nada");
/* Sem isto, um laço usa o ConHub para encher a caixa de entrada de alguém em
   nome da nossa marca — e quem paga com a reputação do domínio somos nós. */
const alvo = "marina@teste.com";
db.prepare("UPDATE users SET invite_hash = NULL WHERE email = ?").run(alvo);
const respostas = [];
for (let i = 0; i < 4; i++) {
  const resp = await pedir(alvo, `10.9.9.${i}`);   // IPs diferentes: o freio testado é o do e-mail
  respostas.push(resp.status);
  if (i === 2) db.prepare("UPDATE users SET invite_hash = NULL WHERE email = ?").run(alvo);
}
console.log(`   respostas: ${respostas.join(", ")} (todas 200, como tem que ser)`);
assert.deepEqual(respostas, [200, 200, 200, 200], "o freio NÃO pode aparecer no código HTTP");
console.log(`   quarto pedido gerou token? ${tokenDe(alvo).invite_hash ? "SIM ✘" : "não ✔"}`);
assert.equal(tokenDe(alvo).invite_hash, null, "passado o teto, nada é gerado nem enviado");

console.log("9. E o freio responde a MESMA frase — senão ele mesmo entrega o e-mail");
r = await pedir(alvo, "10.9.9.9");
assert.deepEqual(await r.json(), d, "'muitas tentativas para este e-mail' já contaria que ele existe");
console.log("   mesma frase de sempre ✔");

console.log("\n===== E O RESTO CONTINUA FECHADO =====");

console.log("10. A rota do GESTOR continua exigindo login");
r = await fetch(url("/auth/users/u_qualquer/redefinir-senha"), { method: "POST" });
console.log(`   ${r.status}`);
assert.equal(r.status, 401);

console.log("11. O token de redefinição CRIA a senha nova e some depois de usado");
/* Pessoa NOVA de propósito: a Marina já gastou o teto de três pedidos por hora
   no caso 8, e reaproveitá-la aqui faria este teste falhar por causa do freio —
   medindo a trava anterior em vez do fluxo de criar senha. */
criar("Rafael", "rafael@teste.com", "ativo");
await pedir("rafael@teste.com", "10.5.5.5");
// O servidor imprime o link inteiro SÓ quando o e-mail não sai — e aqui não há
// Resend configurado, que é o modo manual documentado. É de lá que ele vem.
await new Promise(x => setTimeout(x, 120));
/* O e-mail sai MASCARADO no log (r***l@teste.com), então não dá para casar
   pelo nome — e é assim que tem que ser. Pego o ÚLTIMO link impresso, que é o
   do pedido que acabou de acontecer. */
const links = [...saida.matchAll(/definir-senha\?token=([a-f0-9]+)/g)].map(m => m[1]);
const bom = links[links.length - 1];
assert.ok(bom, "sem token não há o que testar (o link deveria estar no log)");
assert.ok(tokenDe("rafael@teste.com").invite_hash, "e o banco guarda só o resumo dele");
r = await fetch(url("/auth/set-password"), { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: bom, password: "senhanova9" }) });
console.log(`   set-password: ${r.status}`);
assert.equal(r.status, 200);
console.log(`   token queimado: ${tokenDe("rafael@teste.com").invite_hash === null}`);
assert.equal(tokenDe("rafael@teste.com").invite_hash, null, "link usado não pode servir duas vezes");

r = await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "rafael@teste.com", password: "senhanova9" }) });
console.log(`   e ele entra com a senha nova: ${r.status}`);
assert.equal(r.status, 200);

console.log("\nTudo certo ✅");
fim(0);
