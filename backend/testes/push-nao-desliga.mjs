/* A notificação do corretor não pode desligar sozinha.

   Sintoma que o Ali relatou em 17/08/2026: os corretores paravam de receber
   aviso de lead sem terem desligado nada. Eram três buracos, e o primeiro era
   nosso:

   1) o botão "Atualizar agora" DESREGISTRAVA o service worker, e isso destrói
      a inscrição de push junto. Como o aviso de versão nova aparece a cada
      publicação, a equipe apertava aquilo com frequência — e cada aperto
      desligava o aviso de lead. (Conserto no frontend; aqui não dá para
      testar, mas a linha saiu.)
   2) o navegador TROCA a inscrição de tempos em tempos e avisa o service
      worker. Sem alguém se reinscrever, o endereço antigo passa a devolver
      410, o servidor apaga a inscrição e ninguém fica sabendo. É o que este
      teste cobre;
   3) não havia rede de segurança: com a permissão do navegador ainda
      concedida, dava para refazer a inscrição em silêncio.

   Rodar:  npm run teste:push
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-push.db");
process.env.JWT_SECRET = "teste";
process.env.VAPID_PUBLIC_KEY = "BIGFYERit03mvova3LcAQM6xlTvz5b7nZ5pm20xEVBx_BCqKFPkKq68O51ZvRfZrXeayUzixemquz8We20ZAub4";
process.env.VAPID_PRIVATE_KEY = "vonJ8_zOWBzqJU-6wCfIRxUiJ-voY7yVY22EQKxNhOw";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { inscrever, trocar, cancelar, inscricoesDe, configurado } = await import("../src/services/push.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");

const assinatura = (n) => ({
  endpoint: "https://fcm.googleapis.com/fcm/send/aparelho-" + n,
  keys: { p256dh: "chave-publica-" + n, auth: "segredo-" + n },
});

console.log("0. As chaves VAPID estão configuradas neste teste");
assert.equal(configurado(), true);

console.log("1. A Marina ativa a notificação no celular dela");
inscrever(marina, assinatura(1));
console.log(`   aparelhos da Marina: ${inscricoesDe(marina)}`);
assert.equal(inscricoesDe(marina), 1);

console.log("2. O navegador troca a inscrição sozinho — e ela NÃO se perde");
/* É o caso que quebrava em silêncio: o endereço muda, o servidor continua
   mandando para o antigo, recebe 410 e apaga. O corretor descobre dias depois
   que parou de receber aviso de lead. */
const nova = assinatura(2);
const out = trocar(assinatura(1).endpoint, nova);
console.log(`   trocada: ${out.trocada} · aparelhos: ${inscricoesDe(marina)}`);
assert.equal(out.trocada, true);
assert.equal(inscricoesDe(marina), 1, "continua um aparelho: foi troca, não duplicata");

const guardada = db.prepare("SELECT user_id, endpoint FROM push_subs WHERE user_id = ?").get(marina);
console.log(`   endereço novo guardado no nome da Marina: ${guardada.endpoint.slice(-10)}`);
assert.equal(guardada.endpoint, nova.endpoint);
assert.equal(guardada.user_id, marina, "a inscrição continua sendo DELA");

console.log("3. O endereço antigo sai do banco (senão viraria 410 para sempre)");
assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subs WHERE endpoint = ?").get(assinatura(1).endpoint).n, 0);

console.log("4. Trocar um endereço DESCONHECIDO não inscreve ninguém");
/* A rota roda sem login — o service worker não tem o token da pessoa. Então a
   única prova de posse é conhecer o endereço antigo. Se essa checagem cair,
   qualquer um inscreve o próprio aparelho no nome de outro corretor. */
const antes = db.prepare("SELECT COUNT(*) n FROM push_subs").get().n;
const invasor = trocar("https://fcm.googleapis.com/fcm/send/nunca-existiu", assinatura(9));
console.log(`   resultado: ${invasor.trocada} · linhas no banco: ${db.prepare("SELECT COUNT(*) n FROM push_subs").get().n}`);
assert.equal(invasor.trocada, false);
assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subs").get().n, antes, "nada foi criado");

console.log("5. Troca sem os dados completos é recusada, sem quebrar");
assert.equal(trocar(null, nova).trocada, false);
assert.equal(trocar(nova.endpoint, { endpoint: "só o endereço" }).trocada, false);
assert.equal(inscricoesDe(marina), 1, "e a inscrição boa continua de pé");

console.log("6. Dois corretores, dois aparelhos: a troca não embaralha");
inscrever(rafael, assinatura(3));
trocar(assinatura(3).endpoint, assinatura(4));
console.log(`   Marina: ${inscricoesDe(marina)} · Rafael: ${inscricoesDe(rafael)}`);
assert.equal(inscricoesDe(marina), 1);
assert.equal(inscricoesDe(rafael), 1);
assert.equal(db.prepare("SELECT user_id FROM push_subs WHERE endpoint = ?").get(assinatura(4).endpoint).user_id, rafael);

console.log("7. Desligar de propósito continua desligando");
cancelar(assinatura(2).endpoint);
console.log(`   aparelhos da Marina: ${inscricoesDe(marina)}`);
assert.equal(inscricoesDe(marina), 0);

console.log("\nTudo certo ✅");
