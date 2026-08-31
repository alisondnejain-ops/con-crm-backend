/* O CORRETOR FALANDO PELO WHATSAPP DELE, DE DENTRO DO CRM. (31/08/2026)

   O sistema inteiro assumia UM número por imobiliária. Este teste tranca as
   regras que a segunda linha cria — e quase todas existem porque a alternativa
   falha em SILÊNCIO:

     - mandar pela linha errada não dá erro: chega ao cliente de um número
       desconhecido, e ninguém de dentro vê;
     - assinar "*Marina:*" no WhatsApp da própria Marina não dá erro: só fica
       esquisito, e só o cliente lê;
     - não achar a linha de quem mandou não dá erro: PARA DE ENTRAR LEAD;
     - deixar o cliente ligar linhas sem teto não dá erro: chega na fatura.

   Rodar:  npm run teste:canais
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-canais.db");
process.env.JWT_SECRET = "teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const C = await import("../src/services/canais.js");

const org = "org_conecta", org2 = "org_place";
const novaOrg = (id, nome, token) =>
  db.prepare("INSERT INTO orgs (id,name,adm_code,uazapi_host,uazapi_token,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, nome, id.toUpperCase(), token ? "https://" + id + ".uazapi.com" : null, token, Date.now());
novaOrg(org, "Conecta Imóveis", "token-da-casa");
novaOrg(org2, "Place Imóveis", "token-da-place");

const novo = (id, nome, papel) =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase().replace(/ /g, "") + "@c.com", papel, Date.now());
novo("u_ali", "Ali", "adm");
novo("u_vanessa", "Vanessa", "sdr");
novo("u_marina", "Marina", "corretor");
novo("u_rafael", "Rafael", "corretor");

console.log("===== A MIGRAÇÃO É INVISÍVEL =====");

console.log("1. Toda imobiliária ganha a linha da casa com a conexão que já usava");
/* Ninguém reconecta nada. Se a migração exigisse um clique do gestor, o CRM
   pararia de mandar mensagem no minuto em que esta versão subisse. */
C.migrarCanais();
let casa = C.canalDaCasa(org);
console.log(`   ${casa.nome} · conectada: ${!!casa.token}`);
assert.equal(casa.tipo, "imobiliaria");
assert.equal(casa.token, "token-da-casa");

console.log("2. Rodar de novo não cria uma segunda");
C.migrarCanais(); C.migrarCanais();
assert.equal(db.prepare("SELECT COUNT(*) n FROM canais WHERE org_id=? AND tipo='imobiliaria'").get(org).n, 1);
console.log("   continua 1");

console.log("3. Imobiliária criada DEPOIS do start acha a linha na hora");
/* A rede de segurança. Sem ela, uma conta aberta pelo hub entre dois reinícios
   ficaria sem canal — e o sintoma seria o pior deste sistema: para de entrar
   lead, com o servidor de pé e nenhum erro em lugar nenhum. */
novaOrg("org_nova", "Imobiliária Nova", "token-da-nova");
const achado3 = C.canalDoWhatsapp({ token: "token-da-nova" });
console.log(`   ${achado3 ? achado3.nome : "NÃO ACHOU"}`);
assert.ok(achado3, "a linha tem que nascer na hora");
assert.equal(achado3.org_id, "org_nova");

console.log("4. Token de ninguém continua sendo ninguém");
/* O antigo consolo "se só existe uma conectada, é dela" saiu: com várias
   linhas ele acertaria por acaso e erraria em silêncio, pondo a conversa de um
   cliente na caixa de outra pessoa. */
assert.equal(C.canalDoWhatsapp({ token: "token-de-ninguem" }), null);
console.log("   null, como tem que ser");

console.log("\n===== A LINHA DO CORRETOR =====");

console.log("5. Só quem o gestor liberou consegue criar a linha");
// (a trava de permissão está na rota; aqui o serviço já recusa quem não é da casa)
let r = C.criarCanalDoCorretor(org, "u_de_outra_casa");
console.log(`   ${r.erro}`);
assert.ok(/não encontrada/i.test(r.erro));

console.log("6. A linha nasce VAZIA e não conta como paga");
r = C.criarCanalDoCorretor(org, "u_marina", { quem: "u_marina" });
assert.ok(r.canal);
console.log(`   ligados agora: ${C.ligados(org)} (só a da casa)`);
assert.equal(C.ligados(org), 1, "linha sem token não é linha paga — cobrar por tela aberta seria cobrar por nada");

console.log("7. Conectar torna a linha real");
C.salvarConexao(r.canal.id, { host: "https://marina.uazapi.com", token: "token-da-marina" });
assert.equal(C.ligados(org), 2);
const daMarina = C.canalDoUsuario(org, "u_marina");
console.log(`   ${daMarina.nome}: ${daMarina.token ? "conectada" : "não"}`);

console.log("8. E o webhook passa a reconhecer a linha DELA, não a da casa");
/* É a pergunta que o webhook faz a cada mensagem, e errar aqui põe a conversa
   na caixa errada. */
const achado8 = C.canalDoWhatsapp({ token: "token-da-marina" });
console.log(`   ${achado8.nome} · tipo ${achado8.tipo} · de ${achado8.user_id}`);
assert.equal(achado8.tipo, "corretor");
assert.equal(achado8.user_id, "u_marina");

console.log("9. Conectar a linha da casa NÃO desencontra o par com `orgs`");
/* O preço de manter `orgs.uazapi_*` vivo ao lado de `canais` é o par poder se
   separar — e separado o CRM enviaria por um número e receberia por outro. */
C.salvarConexao(casa.id, { host: "https://novo.uazapi.com", token: "token-novo-da-casa" });
const o9 = db.prepare("SELECT uazapi_host, uazapi_token FROM orgs WHERE id=?").get(org);
console.log(`   orgs: ${o9.uazapi_token} · canal: ${C.canalDaCasa(org).token}`);
assert.equal(o9.uazapi_token, "token-novo-da-casa");
assert.equal(o9.uazapi_host, "https://novo.uazapi.com");
assert.equal(C.canalDaCasa(org).token, o9.uazapi_token);

console.log("\n===== O TETO DO PLANO =====");

console.log("10. O plano vendido hoje são 11 linhas: a da casa e dez pessoais");
let l = C.limites(org);
console.log(`   teto ${l.limite} · ligadas ${l.usados} · restam ${l.restantes}`);
assert.equal(l.limite, 11);

console.log("11. A décima segunda é recusada, com a razão escrita");
db.prepare("UPDATE orgs SET limite_canais = 3 WHERE id = ?").run(org);
r = C.criarCanalDoCorretor(org, "u_rafael");
assert.ok(r.canal, "a terceira ainda cabe");
C.salvarConexao(r.canal.id, { host: "https://rafael.uazapi.com", token: "token-do-rafael" });
r = C.criarCanalDoCorretor(org, "u_vanessa");
console.log(`   ${r.erro}`);
assert.ok(/permite 3/.test(r.erro), "a recusa diz o número do plano, não 'não foi possível'");

console.log("12. O que é COBRADO são as linhas além das incluídas");
/* A linha da casa já vinha com a mensalidade antes disto existir. Cobrá-la
   agora seria aumentar o preço de quem já é cliente sem ninguém combinar. */
db.prepare("UPDATE orgs SET limite_canais = 11, valor_canal = 89 WHERE id = ?").run(org);
l = C.limites(org);
console.log(`   ${l.usados} ligadas · ${l.incluidos} inclusa(s) · cobra ${l.cobrados} · R$ ${l.valor_extra}`);
assert.equal(l.usados, 3);
assert.equal(l.cobrados, 2);
assert.equal(l.valor_extra, 178);

console.log("13. Sem preço definido, o valor é NULO — não zero");
/* Mostrar R$ 0,00 para um preço que o ConHub ainda não combinou seria prometer
   de graça o que vai ser cobrado. */
db.prepare("UPDATE orgs SET valor_canal = NULL WHERE id = ?").run(org);
assert.equal(C.limites(org).valor_extra, null);
console.log("   null");

console.log("\n===== DESLIGAR SEM DEIXAR CONVERSA SEM SAÍDA =====");

const lead = (nome, canal) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,canal_id,created_at)
    VALUES (?,?,?,?,'Lead','u_marina',?,?)`).run(id, org, nome, "8799" + Math.random().toString().slice(2, 8), canal, Date.now());
  return id; };

console.log("14. Desligar a linha devolve as conversas para o número da casa");
/* Sem isso os leads apontariam para uma linha sem credencial: o envio falharia
   e a tela diria "falha ao enviar" sem dizer por quê. */
const l1 = lead("Cliente da Marina", daMarina.id);
const l2 = lead("Outro da Marina", daMarina.id);
const out = C.desligarCanal(daMarina.id);
console.log(`   ${out.devolvidos} conversa(s) devolvidas`);
assert.equal(out.devolvidos, 2);
assert.equal(db.prepare("SELECT canal_id FROM leads WHERE id=?").get(l1).canal_id, null);

console.log("15. E a linha desligada para de ser cobrada");
assert.equal(C.limites(org).usados, 2);
console.log(`   ${C.limites(org).usados} ligadas`);

console.log("16. O histórico NÃO some junto");
/* Desligar e apagar são coisas diferentes: apagada, o CRM não saberia mais por
   onde aquele atendimento aconteceu. */
assert.ok(C.canalPorId(daMarina.id), "a linha continua existindo, desativada");
console.log("   a linha continua no banco, com ativo = 0");

console.log("17. A linha da casa não se desliga por aqui");
r = C.desligarCanal(C.canalDaCasa(org).id);
console.log(`   ${r.erro}`);
assert.ok(/Configurações/.test(r.erro));

console.log("\n===== POR QUAL LINHA A CONVERSA SAI =====");

console.log("18. Lead sem canal é a linha da casa");
const l18 = lead("Cliente da casa", null);
const c18 = C.canalDoLead(db.prepare("SELECT * FROM leads WHERE id=?").get(l18));
console.log(`   ${c18.tipo}`);
assert.equal(c18.tipo, "imobiliaria");

console.log("19. Lead apontando para linha DESLIGADA também cai na casa");
/* É isso ou uma mensagem que não sai. A conversa continua pelo número que a
   imobiliária sempre teve. */
db.prepare("UPDATE leads SET canal_id = ? WHERE id = ?").run(daMarina.id, l18);
const c19 = C.canalDoLead(db.prepare("SELECT * FROM leads WHERE id=?").get(l18));
console.log(`   ${c19.tipo}`);
assert.equal(c19.tipo, "imobiliaria");

console.log("20. Lead na linha ligada do Rafael sai pela linha dele");
const doRafael = C.canalDoUsuario(org, "u_rafael");
db.prepare("UPDATE leads SET canal_id = ? WHERE id = ?").run(doRafael.id, l18);
const c20 = C.canalDoLead(db.prepare("SELECT * FROM leads WHERE id=?").get(l18));
console.log(`   ${c20.tipo} de ${c20.nome}`);
assert.equal(c20.tipo, "corretor");
assert.equal(c20.user_id, "u_rafael");

console.log("\n===== A ASSINATURA SÓ VALE NO NÚMERO DA CASA =====");
const U = await import("../src/services/uazapi.js");

console.log("21. As credenciais de uma linha pessoal são as DELA");
const cred = U.credenciais(org, doRafael.id);
console.log(`   ${cred.host}`);
assert.equal(cred.token, "token-do-rafael");

console.log("22. Sem canal, continua sendo a casa — nenhum chamador antigo quebra");
/* É o que faz esta mudança não exigir tocar em todo ponto de envio de uma vez. */
const credCasa = U.credenciais(org);
console.log(`   ${credCasa.token}`);
assert.equal(credCasa.token, "token-novo-da-casa");

console.log("23. Uma linha de OUTRA imobiliária não vaza para esta");
assert.notEqual(U.credenciais(org2).token, U.credenciais(org).token);
console.log("   a Place continua com o token dela");

console.log("\nTudo certo ✅");
process.exit(0);
