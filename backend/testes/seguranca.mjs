/* AS TRAVAS DE SEGURANÇA — auditoria de 02/09/2026.

   Este teste existe porque as falhas que ele cobre têm todas o mesmo modo de
   falhar: NENHUMA delas dá erro quando volta a existir. O CRM continua de pé,
   a tela abre, os leads entram — e a porta está destrancada. Foi assim que
   cada uma delas nasceu, e é assim que voltariam.

   Ele sobe o servidor inteiro, como o `teste:webhook`, porque o que se testa
   aqui é o COMPORTAMENTO DA PORTA e não o miolo de uma função. Trava conferida
   por dentro do serviço não prova nada sobre a rota — foi a lição do
   `teste:lead-manual`.

   Rodar:  npm run teste:seguranca
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-seguranca.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4771;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "SEG-1",
         ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (c) => { servidor.kill("SIGTERM"); process.exit(c); };
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1800)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
console.log("Servidor no ar, igual à produção.\n");

const { default: db } = await import("../src/db.js");
const bcrypt = (await import("bcryptjs")).default;
const jwt = (await import("jsonwebtoken")).default;
const { randomUUID } = await import("crypto");

const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
const criar = (nome, email, role = "corretor", status = "ativo") => {
  const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,?)`).run(id, org, nome, email, bcrypt.hashSync("123456", 8), role, Date.now(), status);
  return id;
};
const entrar = async (email, senha = "123456") => {
  const r = await fetch(url("/auth/login"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: senha }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`);
  return d.token;
};
const com = (t, caminho, opts = {}) => fetch(url(caminho), {
  ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + t, ...(opts.headers || {}) } });

const marina = criar("Marina", "marina@teste.com");
const gestor = criar("Gestora", "gestora@teste.com", "adm");

console.log("===== 1. O CRACHÁ DEIXA DE VALER QUANDO A PESSOA SAI =====");
/* O furo mais provável de acontecer numa imobiliária de verdade: o crachá dura
   30 DIAS e `authRequired` só conferia a assinatura. O gestor clicava em
   "Remover da equipe", a pessoa sumia da tela — e continuava entrando, lendo
   conversa de cliente e mandando mensagem pelo WhatsApp da casa por um mês.
   Quem sai brigado saía com a base de clientes na mão. */

console.log("1. A corretora entra normalmente");
let tMarina = await entrar("marina@teste.com");
let r = await com(tMarina, "/leads");
console.log(`   GET /leads → ${r.status}`);
assert.equal(r.status, 200);

console.log("2. O gestor a remove da equipe — e o acesso cai NO MESMO INSTANTE");
const tGestor = await entrar("gestora@teste.com");
r = await com(tGestor, `/auth/users/${marina}/remover`, { method: "POST", body: "{}" });
console.log(`   remover → ${r.status}`);
assert.equal(r.status, 200);
r = await com(tMarina, "/leads");
console.log(`   o crachá dela agora responde: ${r.status} · "${(await r.json()).error}"`);
assert.equal(r.status, 401, "removida da equipe é removida do sistema, não só da tela");

console.log("3. E trocar a senha derruba os OUTROS aparelhos, não o atual");
/* Quem troca a senha porque desconfia que alguém a descobriu continuava com o
   intruso lá dentro: o gesto universal de "me tira daqui" não fazia nada. */
const bruno = criar("Bruno", "bruno@teste.com");
const celular = await entrar("bruno@teste.com");
const notebook = await entrar("bruno@teste.com");
r = await com(notebook, "/auth/me/senha", { method: "POST",
  body: JSON.stringify({ atual: "123456", nova: "senhanova9" }) });
const trocou = await r.json();
console.log(`   troca → ${r.status} · veio crachá novo? ${!!trocou.token}`);
assert.equal(r.status, 200);
assert.ok(trocou.token, "quem trocou a senha não pode ser deslogado pelo próprio ato");

r = await com(celular, "/leads");
console.log(`   o OUTRO aparelho: ${r.status}`);
assert.equal(r.status, 401, "o aparelho que ficou com a senha antiga tem que cair");
r = await com(trocou.token, "/leads");
console.log(`   o aparelho onde ela trocou: ${r.status}`);
assert.equal(r.status, 200, "e quem trocou continua trabalhando");

console.log("\n===== 2. NINGUÉM ENTRA NA CASA DOS OUTROS =====");

console.log("4. Crachá apontando para OUTRA imobiliária é recusado");
/* O `org_id` vem do crachá de propósito: para o master ele é a casa em que ele
   escolheu trabalhar. Sem esta conferência, um crachá emitido quando alguém
   era master (ou forjado a partir de um vazamento antigo) seria passe livre
   para a casa alheia — e o `org_id` manda em TODA consulta do sistema. */
const outra = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(outra, "Casa Alheia", "OUT-1", Date.now());
const crachaFalso = jwt.sign({ id: gestor, role: "adm", org_id: outra, name: "Gestora" }, "teste", { expiresIn: "1h" });
r = await com(crachaFalso, "/leads");
console.log(`   gestora de uma casa, crachá da outra: ${r.status}`);
assert.equal(r.status, 403, "quem não é master não trabalha em duas casas");

console.log("5. Crachá assinado com OUTRA chave não abre nada");
const forjado = jwt.sign({ id: gestor, role: "adm", org_id: org, name: "Gestora" }, "dev-secret", { expiresIn: "1h" });
r = await com(forjado, "/leads");
console.log(`   assinado com "dev-secret": ${r.status}`);
assert.equal(r.status, 401, "a chave de desenvolvimento não pode abrir a produção");

console.log("\n===== 3. A PORTA DE ENTRADA TEM FREIO =====");

console.log("6. Vinte senhas erradas e a porta fecha, dizendo quanto tempo falta");
/* Sem freio, uma senha de seis dígitos cai em minutos — e como o bcrypt PARA o
   servidor enquanto calcula, o mesmo laço derruba o CRM da imobiliária junto.
   A mesma porta servia de martelo. */
let bloqueou = null;
for (let i = 0; i < 25 && !bloqueou; i++) {
  const resp = await fetch(url("/auth/login"), { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.7" },
    body: JSON.stringify({ email: "gestora@teste.com", password: "chute" + i }) });
  if (resp.status === 429) bloqueou = { tentativa: i + 1, corpo: await resp.json() };
}
console.log(`   fechou na tentativa ${bloqueou?.tentativa} · "${bloqueou?.corpo.error}"`);
assert.ok(bloqueou, "tem que existir um teto");
assert.ok(/minuto/.test(bloqueou.corpo.error),
  "e o recado precisa dizer QUANTO falta — 'tente mais tarde' faz a pessoa tentar de novo agora e renovar o próprio bloqueio");

console.log("7. Mas quem sabe a senha continua entrando, de outro acesso");
/* O freio de trabalho é o de IP. O de e-mail é MUITO mais largo de propósito:
   apertado, ele viraria uma arma melhor que a doença — quem soubesse o e-mail
   de um corretor trancaria o colega fora do trabalho a manhã inteira só
   errando a senha dez vezes. Ver o comentário dos tetos em auth.routes.js. */
const t2 = await entrar("gestora@teste.com");
assert.ok(t2);
console.log("   de outro acesso, o login funciona normalmente ✔");

console.log("7b. E o e-mail tem freio próprio, para o ataque vindo de MUITAS máquinas");
/* Sem ele, o freio de IP não protege nada contra quem tem mil endereços: cada
   um faz dezenove tentativas e vai embora sem nunca ser barrado. */
let barrouPorEmail = false;
for (let i = 0; i < 60 && !barrouPorEmail; i++) {
  const resp = await fetch(url("/auth/login"), { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${i}.1` },
    body: JSON.stringify({ email: "gestora@teste.com", password: "chute" }) });
  if (resp.status === 429) barrouPorEmail = i + 1;
}
console.log(`   cada tentativa de um IP diferente — barrado na ${barrouPorEmail}ª`);
assert.ok(barrouPorEmail, "trocar de IP não pode ser a saída para martelar uma conta");

console.log("\n===== 4. OS WEBHOOKS SÓ ACEITAM QUEM PROVA QUEM É =====");

console.log("8. O webhook do Asaas RECUSA quando não há token configurado");
/* Estava `if (TOKEN_WEBHOOK && ...)`: sem a variável, a conferência era
   PULADA. Qualquer pessoa mandava "pagamento recebido" e ganhava mês de
   mensalidade, na própria conta ou na de qualquer cliente. Trava que falha
   ABERTA é a pior de todas, porque nada quebra. */
r = await fetch(url("/webhooks/asaas"), { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ event: "PAYMENT_RECEIVED", payment: { value: 297 } }) });
console.log(`   sem ASAAS_WEBHOOK_TOKEN no servidor: ${r.status}`);
assert.equal(r.status, 503, "sem token configurado ele tem que recusar, não liberar");

console.log("9. O do WhatsApp não aceita ser identificado pelo NÚMERO");
/* O número de uma imobiliária é PÚBLICO — site, anúncio, fachada. Aceitá-lo
   como identificação deixava qualquer pessoa criar lead falso, escrever na
   conversa de um cliente real e fazer a IA da casa mandar WhatsApp para um
   número escolhido por ela. */
const antes = db.prepare("SELECT COUNT(*) n FROM leads").get().n;
await fetch(url("/webhooks/uazapi"), { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ owner: "5587996546848",
    message: { chatid: "5587900001111@s.whatsapp.net", text: "lead falso", messageid: "wa_x" } }) });
await new Promise(x => setTimeout(x, 350));
console.log(`   leads antes: ${antes} · depois: ${db.prepare("SELECT COUNT(*) n FROM leads").get().n}`);
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads").get().n, antes, "não pode nascer lead sem o token da instância");

console.log("\n===== 5. O QUE A INTERNET PODE SABER SOBRE A PLATAFORMA =====");

console.log("10. /integracoes continua abrindo sem login — é o diagnóstico");
r = await fetch(url("/integracoes"));
const pub = await r.json();
console.log(`   ${r.status} · ainda responde "há quantos minutos entrou o último lead"? ${!!pub.ultima_entrada}`);
assert.equal(r.status, 200, "é o primeiro passo de 'parou de chegar lead' — não pode exigir login");
assert.ok(pub.ultima_entrada, "e o que ela existe para responder tem que continuar lá");

console.log("11. Mas ela não conta mais o tamanho nem os nomes da plataforma");
console.log(`   nome da imobiliária: ${JSON.stringify(pub.org)} · usuários: ${JSON.stringify(pub.banco.usuarios)}`);
assert.notEqual(pub.org, "Conecta Imóveis", "o nome do cliente é informação comercial");
assert.equal(pub.imobiliarias, undefined, "quantas contas existem também");
assert.equal(pub.banco.usuarios, undefined, "e quantas pessoas usam");
assert.equal(pub.email.ultimos, undefined, "nem o registro de e-mails, que confirma endereço cadastrado");

console.log("12. E o master, entrando, vê tudo");
const admToken = await entrar("ali@teste.com");
db.prepare("UPDATE users SET master = 1 WHERE email = 'ali@teste.com'").run();
const tMaster = await entrar("ali@teste.com");
const priv = await (await com(tMaster, "/integracoes")).json();
console.log(`   como master: ${priv.imobiliarias} imobiliária(s) · ${priv.banco.usuarios} usuário(s)`);
assert.ok(priv.imobiliarias >= 1, "quem administra a plataforma precisa dos números");
assert.ok(priv.banco.usuarios >= 1);

console.log("\n===== 6. OS CABEÇALHOS QUE O NAVEGADOR OBEDECE =====");

console.log("13. Toda resposta sai com as travas do navegador");
r = await fetch(url("/health"));
const h = Object.fromEntries(r.headers);
console.log(`   nosniff: ${h["x-content-type-options"]} · frame: ${h["x-frame-options"]}`);
assert.equal(h["x-content-type-options"], "nosniff",
  "sem isto, arquivo de cliente com HTML dentro roda como página no endereço do CRM");
assert.equal(h["x-frame-options"], "DENY", "e ninguém abre o CRM dentro de um site falso para roubar clique");
assert.ok(h["referrer-policy"], "o endereço do CRM leva id de lead — ele não pode viajar para outros sites");

console.log("\n===== 7. O SEGREDO GUARDADO NÃO É O SEGREDO DO LINK =====");

console.log("14. O token do link de senha fica no banco como impressão digital");
/* Em claro, a cópia de segurança diária — que sobe para um armazenamento de
   terceiros — era uma lista de links prontos para tomar contas pendentes. */
r = await com(tGestor, `/auth/users/${bruno}/redefinir-senha`, { method: "POST", body: "{}" });
const nova = await r.json();
const guardado = db.prepare("SELECT invite_token, invite_hash FROM users WHERE id = ?").get(bruno);
const doLink = String(nova.link || "").split("token=")[1];
console.log(`   no link: ${doLink?.slice(0, 12)}… · no banco: ${String(guardado.invite_hash).slice(0, 12)}…`);
assert.ok(doLink, "a gestão continua recebendo o link para repassar");
assert.equal(guardado.invite_token, null, "o token em claro não fica guardado");
assert.ok(guardado.invite_hash && guardado.invite_hash !== doLink, "o que está no banco não abre o link");

console.log("15. E o link ainda funciona — a trava não pode custar o recurso");
r = await fetch(url("/auth/set-password"), { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: doLink, password: "outrasenha7" }) });
console.log(`   set-password: ${r.status}`);
assert.equal(r.status, 200);

console.log("\n===== 8. O COFRE =====");

console.log("16. Fechar e abrir devolve o mesmo texto; sem a chave, não abre");
const cofre = await import("../src/services/cofre.js");
cofre._usarChaveDeTeste("a".repeat(64));
const fechado = cofre.fechar("token-da-uazapi-da-conecta");
console.log(`   guardado como: ${fechado.slice(0, 22)}…`);
assert.ok(fechado.startsWith("enc:v1:"), "o formato se identifica sozinho");
assert.equal(cofre.abrir(fechado), "token-da-uazapi-da-conecta");
assert.equal(cofre.fechar(fechado), fechado, "fechar duas vezes não empilha camada");

console.log("17. Valor GRAVADO EM CLARO continua sendo lido — é o que faz a migração ser invisível");
assert.equal(cofre.abrir("token-antigo-em-claro"), "token-antigo-em-claro");

console.log("18. Um byte trocado NÃO devolve lixo — devolve nada");
/* AES-GCM autentica além de cifrar. Numa cópia de segurança isso é a diferença
   entre "o backup está corrompido" e "restauramos um banco embaralhado sem
   ninguém perceber". */
const adulterado = fechado.slice(0, -6) + "AAAAAA";
console.log(`   adulterado → ${JSON.stringify(cofre.abrir(adulterado))}`);
assert.equal(cofre.abrir(adulterado), null);

console.log("19. E o arquivo da cópia se identifica e volta inteiro");
const conteudo = Buffer.from("SQLite format 3\0isto é o banco inteiro");
const arq = cofre.fecharArquivo(conteudo);
assert.equal(arq.criptografado, true);
assert.ok(cofre.arquivoFechado(arq.buffer), "quem for restaurar daqui a um ano precisa saber, olhando o arquivo");
assert.ok(cofre.abrirArquivo(arq.buffer).equals(conteudo));
console.log("   fechou, reconheceu e abriu igual ✔");
cofre._usarChaveDeTeste(null);
assert.ok(cofre.fecharArquivo(conteudo).criptografado === false, "sem chave, o backup acontece em claro — e a tela avisa");

console.log("\n===== 9. OS DIREITOS DO TITULAR (LGPD, art. 18) =====");

/* O "titular" é o CLIENTE da imobiliária. Até 02/09/2026 o CRM não tinha
   resposta para as duas perguntas que a lei garante a ele: o que vocês têm
   sobre mim, e apaguem. Atender um pedido desses exigiria abrir o banco na
   mão — e "apagar" levaria junto o relatório de quem atendeu. */
const leadId = "l_" + randomUUID();
db.prepare(`INSERT INTO leads (id,org_id,name,phone,email,origem,qual_json,stage,assigned_to,created_at)
  VALUES (?,?,?,?,?,'WhatsApp','{"renda":"3500"}','Atendimento',?,?)`)
  .run(leadId, org, "Carlos Cliente", "5587991110000", "carlos@cliente.com", gestor, Date.now());
db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at)
  VALUES (?,?,'in','meu CPF é 111.444.777-35 e ganho 3500',?)`).run("m_" + randomUUID(), leadId, Date.now());
db.prepare(`INSERT INTO observacoes (id,org_id,lead_id,autor_id,texto,created_at)
  VALUES (?,?,?,?,'quem decide é a esposa',?)`).run("o_" + randomUUID(), org, leadId, gestor, Date.now());

console.log("20. A gestão exporta tudo que existe sobre a pessoa");
r = await com(t2, `/leads/${leadId}/lgpd`);
const dossie = await r.json();
console.log(`   ${r.status} · ${dossie.conversas?.length} conversa(s) · ${dossie.observacoes?.length} observação(ões)`);
assert.equal(r.status, 200);
assert.equal(dossie.cadastro.nome, "Carlos Cliente");
assert.equal(dossie.cadastro.telefone, "5587991110000");
assert.ok(dossie.conversas.length >= 1, "o conteúdo da conversa é justamente o que ele tem direito de ver");
assert.ok(dossie.observacoes.length >= 1, "e o que a equipe anotou sobre ele também");

console.log("21. Anonimizar exige confirmação escrita — não tem desfazer");
r = await com(t2, `/leads/${leadId}/lgpd/anonimizar`, { method: "POST", body: JSON.stringify({ confirmar: "sim" }) });
console.log(`   sem escrever ANONIMIZAR: ${r.status}`);
assert.equal(r.status, 400);

console.log("22. Feito o pedido, some a PESSOA e fica o ATENDIMENTO");
/* As duas metades importam. Só apagar seria fácil e quebraria o relatório de
   quem atendeu — a comissão de uma pessoa passaria a depender do pedido de
   outra. Só manter seria não atender a lei. */
const msgsAntes = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(leadId).n;
r = await com(t2, `/leads/${leadId}/lgpd/anonimizar`, { method: "POST", body: JSON.stringify({ confirmar: "ANONIMIZAR" }) });
console.log(`   ${r.status}`);
assert.equal(r.status, 200);
const depois = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
const msg = db.prepare("SELECT body FROM messages WHERE lead_id = ? LIMIT 1").get(leadId);
console.log(`   nome: "${depois.name}" · telefone: "${depois.phone}" · conversa: "${msg.body}"`);
assert.equal(depois.name, "Titular anonimizado");
assert.ok(!depois.phone.includes("991110000"), "o telefone não pode continuar discável");
assert.equal(depois.email, null);
assert.ok(!/111\.444\.777/.test(msg.body), "o CPF que ele mandou na conversa some junto");
assert.equal(db.prepare("SELECT COUNT(*) n FROM observacoes WHERE lead_id = ?").get(leadId).n, 0);

console.log("   e o esqueleto do atendimento continua de pé:");
console.log(`   etapa: ${depois.stage} · responsável: ${depois.assigned_to === gestor} · mensagens: ${msgsAntes} → ${db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(leadId).n}`);
assert.equal(depois.stage, "Atendimento", "a etapa fica — é o relatório de quem atendeu");
assert.equal(depois.assigned_to, gestor, "e quem atendeu também");
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(leadId).n, msgsAntes,
  "a CONTAGEM de mensagens fica (é o tempo de resposta no relatório); o TEXTO é que sai");

console.log("23. E pedir duas vezes não é erro do sistema — é aviso");
r = await com(t2, `/leads/${leadId}/lgpd/anonimizar`, { method: "POST", body: JSON.stringify({ confirmar: "ANONIMIZAR" }) });
console.log(`   ${r.status} · ${(await r.json()).error}`);
assert.equal(r.status, 400);

console.log("\nTudo certo ✅");
fim(0);
