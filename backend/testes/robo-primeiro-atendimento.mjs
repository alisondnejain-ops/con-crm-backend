/* O robô que atende fora do expediente.

   Este é o único lugar do CRM em que a IA fala com o CLIENTE. Não tem
   desfazer: o que sai vai para o WhatsApp de uma pessoa de verdade, com o
   nome da Conecta. Então o que este teste protege não é a resposta bonita —
   é QUANDO ELE FICA CALADO:

   - dentro do expediente (às 09:00 a Vanessa assume);
   - em lead que já está com um corretor;
   - em conversa cuja última mensagem NÃO é do cliente;
   - depois que gente entrou na conversa;
   - passado o teto de mensagens;
   - e quando o texto dele traz palavra que faz o funil andar sozinho.

   Mais duas coisas que o relatório do Ali depende:
   - a mensagem do robô NÃO conta como primeira resposta de ninguém;
   - o lead atendido por ele cai numa lista de conferência.

   A Anthropic e a Uazapi são trocadas por respostas de mentira: roda offline.

   Rodar:  npm run teste:robo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
/* O fuso da operação, como o `server.js` faz na segunda linha dele.

   Sem isto o teste roda em UTC e a janela "18:00 às 09:00" fica três horas
   deslocada — o robô pareceria calado às 21h de sábado. Não é detalhe de
   teste: é a mesma linha que faz o horário estar certo em produção. */
process.env.TZ = "America/Recife";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-robo.db");
process.env.JWT_SECRET = "teste";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
process.env.UAZAPI_HOST = "https://uazapi.teste";
process.env.UAZAPI_TOKEN = "token-de-teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

const real = globalThis.fetch;
let respostaDaIA = { texto: "Oi! Que bom que chamou 😊 Me conta, é pra morar ou pra investir?",
  coletado: {}, encerrar: false };
let chamadasIA = 0, enviadas = [], ultimoPedido = "";
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    chamadasIA++;
    ultimoPedido = String(opts && opts.body || "");
    return { ok: true, status: 200, json: async () => ({
      content: [{ type: "text", text: JSON.stringify(respostaDaIA) }],
      usage: { input_tokens: 1200, output_tokens: 90 } }) };
  }
  if (u.includes("uazapi.teste")) {
    enviadas.push(JSON.parse(opts.body || "{}"));
    return { ok: true, status: 200, text: async () => JSON.stringify({ messageid: "wa_" + enviadas.length }) };
  }
  return real(url, opts);
};

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { atender, podeAtender, dentroDaJanela, pararPorGente, paraConferir, conferir,
  palavraProibida, configDoRobo, estadoNoLead, ligarNoLead, orientacoes } = await import("../src/services/robo.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
db.prepare("UPDATE orgs SET robo_ativo=1, robo_inicio='18:00', robo_fim='09:00', robo_teto=12, uazapi_host=?, uazapi_token=? WHERE id=?")
  .run(process.env.UAZAPI_HOST, process.env.UAZAPI_TOKEN, org);

const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome + "@x.com", role, Date.now()); return id; };
const vanessa = user("Vanessa", "sdr"), marina = user("Marina", "corretor"), ali = user("Ali", "adm");

let n = 0;
function lead({ nome, dono = null }) {
  const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,assigned_to,created_at)
    VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?)`).run(id, org, nome, "558790000" + (1000 + n++), dono, Date.now());
  return id;
}
const doCliente = (leadId, texto) => db.prepare(
  "INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in',?,?)")
  .run("m_" + randomUUID(), leadId, texto, Date.now() + n++);
const daGente = (leadId, quem, texto) => db.prepare(
  "INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at) VALUES (?,?,'out',?,?,?)")
  .run("m_" + randomUUID(), leadId, quem, texto, Date.now() + n++);

// Sábado 21:00 e segunda 10:00, no fuso da operação.
const NOITE = new Date("2026-08-15T21:00:00-03:00").getTime();
const MANHA = new Date("2026-08-17T10:00:00-03:00").getTime();

console.log("1. Em dia de expediente, a janela 18:00→09:00 atravessa a meia-noite");
const cfg = configDoRobo(org);
for (const [q, esperado] of [["2026-08-18T21:00:00-03:00", true], ["2026-08-19T03:00:00-03:00", true],
  ["2026-08-19T08:59:00-03:00", true], ["2026-08-19T09:00:00-03:00", false],
  ["2026-08-19T13:00:00-03:00", false], ["2026-08-19T17:59:00-03:00", false],
  ["2026-08-19T18:00:00-03:00", true]]) {
  const dentro = dentroDaJanela(cfg, new Date(q).getTime());
  console.log(`   ${q.slice(11, 16)} → ${dentro ? "robô atende" : "atendente assume"}`);
  assert.equal(dentro, esperado, `janela errada às ${q}`);
}

console.log("1b. Sábado e domingo ele atende O DIA INTEIRO");
/* No fim de semana não existe "fora do expediente" — existe "não tem
   expediente". A hora não é olhada; o dia é. Sexta 18h até segunda 9h vira um
   bloco contínuo sem nenhum caso especial no código. */
for (const [q, esperado, porque] of [
  ["2026-08-14T14:00:00-03:00", false, "sexta 14h, expediente"],
  ["2026-08-14T18:30:00-03:00", true,  "sexta à noite"],
  ["2026-08-15T10:00:00-03:00", true,  "SÁBADO de manhã"],
  ["2026-08-15T14:00:00-03:00", true,  "SÁBADO à tarde"],
  ["2026-08-16T12:00:00-03:00", true,  "DOMINGO ao meio-dia"],
  ["2026-08-16T23:30:00-03:00", true,  "domingo à noite"],
  ["2026-08-17T08:00:00-03:00", true,  "segunda antes das 9"],
  ["2026-08-17T09:30:00-03:00", false, "segunda, a Vanessa assumiu"],
]) {
  const dentro = dentroDaJanela(cfg, new Date(q).getTime());
  console.log(`   ${porque}: ${dentro ? "robô atende" : "equipe assume"}`);
  assert.equal(dentro, esperado, `errou em ${porque}`);
}

console.log("2. Fila e lead da atendente: o robô atende");
const naFila = lead({ nome: "Chegou sábado" });
doCliente(naFila, "oi, vi o anúncio das casas");
assert.equal(podeAtender(org, naFila, NOITE).pode, true);
const daVanessa = lead({ nome: "Com a Vanessa", dono: vanessa });
doCliente(daVanessa, "boa noite, tenho interesse");
assert.equal(podeAtender(org, daVanessa, NOITE).pode, true);

console.log("2b. Lead que o GESTOR assumiu: o robô atende também");
const doAli = lead({ nome: "O Ali assumiu", dono: ali });
doCliente(doAli, "oi, quero saber dos imóveis");
const t2b = podeAtender(org, doAli, NOITE);
console.log(`   ${t2b.pode ? "atende" : "não atende: " + t2b.motivo}`);
assert.equal(t2b.pode, true, "supervisão não é corretor: quem está com o gestor ainda não tem dono de verdade");

console.log("3. Lead que já está com CORRETOR: nunca");
const doCorretor = lead({ nome: "Com a Marina", dono: marina });
doCliente(doCorretor, "oi Marina, e aí?");
const t3 = podeAtender(org, doCorretor, NOITE);
console.log(`   motivo: ${t3.motivo}`);
assert.equal(t3.pode, false);
assert.equal(t3.motivo, "ja_com_corretor");

console.log("4. Dentro do expediente: nunca — é a hora da Vanessa");
const t4 = podeAtender(org, naFila, MANHA);
console.log(`   motivo às 10h: ${t4.motivo}`);
assert.equal(t4.motivo, "dentro_do_expediente");

console.log("5. Conversa cuja última mensagem NÃO é do cliente: nunca");
const respondido = lead({ nome: "Já respondido", dono: vanessa });
doCliente(respondido, "oi");
daGente(respondido, vanessa, "oi! já te respondo");
const t5 = podeAtender(org, respondido, NOITE);
console.log(`   motivo: ${t5.motivo}`);
assert.equal(t5.motivo, "nao_esta_esperando");

console.log("6. Atendendo de verdade: manda pelo WhatsApp e grava na conversa");
const r6 = await atender(org, naFila, { agora: NOITE, atraso: 0 });
console.log(`   enviou: "${enviadas[0]?.text?.slice(0, 50)}…" para ${enviadas[0]?.number}`);
assert.equal(r6.atendeu, true);
assert.equal(enviadas.length, 1, "uma mensagem no WhatsApp");
assert.ok(!/^\*/.test(enviadas[0].text), "sem assinatura de corretor: não tem corretor");
const m6 = db.prepare("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at DESC LIMIT 1").get(naFila);
assert.equal(m6.direction, "out");
assert.equal(m6.from_user_id, null, "não é mensagem de pessoa nenhuma");
assert.equal(m6.from_name, "Atendimento automático", "a tela precisa dizer quem falou");

console.log("7. NÃO conta como primeira resposta — o relógio é da equipe");
const l7 = db.prepare("SELECT first_resp_at, robo_msgs FROM leads WHERE id=?").get(naFila);
console.log(`   first_resp_at: ${l7.first_resp_at} · mensagens do robô: ${l7.robo_msgs}`);
assert.equal(l7.first_resp_at, null, "senão o lead apareceria como atendido por gente que não atendeu");
assert.equal(l7.robo_msgs, 1);

console.log("8. Não fala duas vezes seguidas: agora a última mensagem é dele");
const r8 = await atender(org, naFila, { agora: NOITE, atraso: 0 });
console.log(`   motivo: ${r8.motivo}`);
assert.equal(r8.atendeu, false);
assert.equal(r8.motivo, "nao_esta_esperando");

console.log("9. O que ele apurou fica guardado, e vai somando");
respostaDaIA = { texto: "Boa! E qual a renda que vocês somam por mês?",
  coletado: { situacao: "primeiro imóvel, para morar" }, encerrar: false };
doCliente(naFila, "é pra morar, primeiro imóvel");
await atender(org, naFila, { agora: NOITE, atraso: 0 });
respostaDaIA = { texto: "Anotado! Tem quanto separado de entrada?",
  coletado: { renda: "3 mil" }, encerrar: false };
doCliente(naFila, "uns 3 mil");
await atender(org, naFila, { agora: NOITE, atraso: 0 });
const guardado = JSON.parse(db.prepare("SELECT robo_json FROM leads WHERE id=?").get(naFila).robo_json);
console.log(`   ${Object.entries(guardado).map(([k, v]) => k + "=" + v).join(" · ")}`);
assert.deepEqual(guardado, { situacao: "primeiro imóvel, para morar", renda: "3 mil" },
  "o que ele colheu antes não some quando ele colhe mais");

console.log("10. Gente entrou na conversa: o robô sai e não volta");
// Pelo CELULAR, que é o caso difícil: a mensagem não tem autor, e mesmo assim
// não pode ser confundida com a do robô.
db.prepare("INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at) VALUES (?,?,'out',NULL,NULL,?,?)")
  .run("m_" + randomUUID(), naFila, "oi! aqui é a Vanessa, já te ajudo", Date.now() + n++);
pararPorGente(naFila);
doCliente(naFila, "oi, ainda tá aí?");
const t10 = podeAtender(org, naFila, NOITE);
console.log(`   motivo: ${t10.motivo}`);
assert.equal(t10.motivo, "robo_encerrado");
assert.equal(estadoNoLead(org, naFila, NOITE).motivo, "gente_assumiu", "e a ficha diz QUEM: uma pessoa entrou");

console.log("11. Palavra que move o funil é barrada ANTES de sair");
for (const frase of ["Podemos agendar sua visita amanhã!", "Me manda os documentos por aqui",
  "Vou passar pro atendimento", "Fechamos o contrato assim"]) {
  const achou = palavraProibida(frase);
  console.log(`   "${frase.slice(0, 34)}…" → barrada (${achou})`);
  assert.ok(achou, "essa frase moveria o lead de etapa sozinha");
}
assert.equal(palavraProibida("Oi! Que bom que chamou. É pra morar ou investir?"), null,
  "conversa normal passa");

const barrado = lead({ nome: "Frase perigosa", dono: vanessa });
doCliente(barrado, "quero ver as casas");
respostaDaIA = { texto: "Claro! Posso agendar uma visita pra você.", coletado: {}, encerrar: false };
const antesDoBarrado = enviadas.length;
const r11 = await atender(org, barrado, { agora: NOITE, atraso: 0 });
console.log(`   resultado: ${r11.motivo}`);
assert.equal(r11.atendeu, false);
assert.equal(enviadas.length, antesDoBarrado, "nada saiu no WhatsApp do cliente");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(barrado).stage, "Lead", "e o funil não andou");

console.log("12. O teto de mensagens segura a conversa (e a conta)");
const semFim = lead({ nome: "Conversa sem fim", dono: vanessa });
respostaDaIA = { texto: "Certo! E em quanto tempo pretende comprar?", coletado: {}, encerrar: false };
for (let i = 0; i < 15; i++) { doCliente(semFim, "sei lá " + i); await atender(org, semFim, { agora: NOITE, atraso: 0 }); }
const l12 = db.prepare("SELECT robo_msgs FROM leads WHERE id=?").get(semFim);
console.log(`   parou em ${l12.robo_msgs} mensagens (teto 12)`);
assert.equal(l12.robo_msgs, 12);
assert.equal(estadoNoLead(org, semFim, NOITE).motivo, "teto_de_mensagens");

console.log("13. Encerrar fecha a conversa do robô de vez");
const despedida = lead({ nome: "Terminou bem", dono: vanessa });
doCliente(despedida, "só isso mesmo, obrigado");
respostaDaIA = { texto: "Show! Anotei tudo. Amanhã nossa atendente confere e te encaminha pro corretor 😊",
  coletado: { prazo: "3 meses" }, encerrar: true };
await atender(org, despedida, { agora: NOITE, atraso: 0 });
doCliente(despedida, "beleza");
assert.equal(podeAtender(org, despedida, NOITE).motivo, "robo_encerrado", "encerrou é encerrou");
assert.equal(estadoNoLead(org, despedida, NOITE).motivo, "ele_se_despediu",
  "na ficha, o motivo é preciso: ninguém respondeu, ele mesmo fechou a conversa");

console.log("14. A lista de segunda-feira mostra quem ele atendeu");
const lista = paraConferir(org);
console.log(`   ${lista.length} lead(s): ${lista.map(l => `${l.nome} (${l.completos}/${l.total_campos})`).join(", ")}`);
assert.ok(lista.some(l => l.id === naFila), "quem o robô atendeu aparece para conferência");
assert.ok(!lista.some(l => l.id === doCorretor), "quem ele não tocou, não");
const oNaFila = lista.find(l => l.id === naFila);
assert.equal(oNaFila.completos, 2, "dois dos cinco campos");

console.log("15. Conferir tira da lista e leva o que ele apurou para a ficha");
conferir(org, naFila, { userId: vanessa });
const ficha = JSON.parse(db.prepare("SELECT qual_json FROM leads WHERE id=?").get(naFila).qual_json);
console.log(`   ficha: ${Object.keys(ficha).join(", ")}`);
assert.equal(ficha.renda, "3 mil", "o corretor não precisa ler a conversa inteira");
assert.ok(!paraConferir(org).some(l => l.id === naFila), "saiu da lista");

console.log("16. Desligado é desligado");
db.prepare("UPDATE orgs SET robo_ativo=0 WHERE id=?").run(org);
const desligado = lead({ nome: "Depois de desligar", dono: vanessa });
doCliente(desligado, "oi");
const antes16 = enviadas.length;
const r16 = await atender(org, desligado, { agora: NOITE, atraso: 0 });
console.log(`   motivo: ${r16.motivo}`);
assert.equal(r16.motivo, "desligado");
assert.equal(enviadas.length, antes16, "nenhuma mensagem saiu");

console.log("17. O gasto entrou no Uso da IA");
const { resumoDeUso } = await import("../src/services/iauso.js");
const uso = resumoDeUso(org, 30);
const atendimento = uso.por_recurso.find(x => x.recurso === "atendimento");
console.log(`   ${atendimento.rotulo}: ${atendimento.usos} uso(s) · US$ ${atendimento.custo}`);
assert.ok(atendimento.usos > 0, "atendimento automático precisa aparecer na conta como os outros");

console.log("18. Duas mensagens seguidas do cliente NÃO viram duas respostas");
db.prepare("UPDATE orgs SET robo_ativo=1 WHERE id=?").run(org);
const apressado = lead({ nome: "Mandou tudo junto", dono: vanessa });
doCliente(apressado, "oi");
doCliente(apressado, "tenho interesse nas casas");
respostaDaIA = { texto: "Oi! Me conta, é pra morar ou investir?", coletado: {}, encerrar: false };
const antes18 = enviadas.length;
// Os dois webhooks chegando ao mesmo tempo, como acontece de verdade.
const [a, b2] = await Promise.all([
  atender(org, apressado, { agora: NOITE, atraso: 30 }),
  atender(org, apressado, { agora: NOITE, atraso: 30 }),
]);
const saiu = enviadas.length - antes18;
console.log(`   ${[a, b2].map(x => x.atendeu ? "respondeu" : x.motivo).join(" + ")} → ${saiu} mensagem(ns) no WhatsApp`);
assert.equal(saiu, 1, "o cliente não pode receber duas respostas quase iguais");
assert.ok([a, b2].some(x => x.motivo === "ja_respondendo"), "a segunda foi segurada pela trava");

console.log("19. Gente respondendo durante a espera cancela a resposta do robô");
const atropelado = lead({ nome: "A Vanessa chegou junto", dono: vanessa });
doCliente(atropelado, "boa noite");
const antes19 = enviadas.length;
const vaiResponder = atender(org, atropelado, { agora: NOITE, atraso: 120 });
// A Vanessa responde pelo celular enquanto o robô "pensa".
await new Promise(r => setTimeout(r, 40));
daGente(atropelado, vanessa, "oi! tô aqui sim");
pararPorGente(atropelado);
const r19 = await vaiResponder;
console.log(`   resultado: ${r19.motivo} · mensagens novas: ${enviadas.length - antes19}`);
assert.equal(r19.atendeu, false, "quem estava trabalhando não pode ser atropelado por um robô");
assert.equal(enviadas.length, antes19);

console.log("20. A supervisão religa a IA num lead específico");
db.prepare("UPDATE orgs SET robo_ativo=1 WHERE id=?").run(org);
const religado = lead({ nome: "A Vanessa respondeu e saiu", dono: vanessa });
doCliente(religado, "boa noite");
await atender(org, religado, { agora: NOITE, atraso: 0 });
daGente(religado, vanessa, "oi! já te ajudo");
pararPorGente(religado);
doCliente(religado, "ainda tá aí?");

const parado = estadoNoLead(org, religado, NOITE);
console.log(`   antes: ${parado.ligado ? "ligado" : "desligado"} · responderia? ${parado.responderia} (${parado.motivo})`);
assert.equal(parado.ligado, false);
assert.equal(parado.motivo, "gente_assumiu");

ligarNoLead(org, religado, true);
const out20 = { estado: estadoNoLead(org, religado, NOITE) };
console.log(`   depois: ${out20.estado.ligado ? "ligado" : "desligado"} · mensagens zeradas: ${out20.estado.mensagens}`);
assert.equal(out20.estado.ligado, true);
assert.equal(out20.estado.mensagens, 0, "religar tem que devolver a conversa, não um robô mudo no teto");
assert.equal(podeAtender(org, religado, NOITE).pode, true, "e agora ele volta a responder");

console.log("21. Religar não fura as regras gerais");
const doCorretorReligado = lead({ nome: "Religado mas é do corretor", dono: marina });
doCliente(doCorretorReligado, "oi");
ligarNoLead(org, doCorretorReligado, true);
const e21 = estadoNoLead(org, doCorretorReligado, NOITE);
console.log(`   ligado no lead: ${e21.ligado} · mas responderia? ${e21.responderia} (${e21.motivo})`);
assert.equal(e21.ligado, true, "o botão fez o que prometeu");
assert.equal(e21.responderia, false, "e mesmo assim ele não fala em lead de corretor");
assert.equal(e21.motivo, "ja_com_corretor", "a tela precisa dizer isso, senão o clique parece quebrado");

console.log("22. E dá para desligar a IA só neste lead");
ligarNoLead(org, religado, false);
assert.equal(estadoNoLead(org, religado, NOITE).motivo, "gente_assumiu");

console.log("23. Lead de ALUGUEL: os campos são outros, e a conta também");
db.prepare("UPDATE orgs SET robo_ativo=1 WHERE id=?").run(org);
const alugar = lead({ nome: "Quer alugar", dono: vanessa });
doCliente(alugar, "oi, procuro uma casa pra alugar no Antônio Cassimiro");
respostaDaIA = { texto: "Oi! Casa pra alugar por lá, anotei 😊 Quantas pessoas vão morar?",
  coletado: { finalidade: "alugar", situacao: "casa para alugar no Antônio Cassimiro",
    orcamento: "até 1.200", garantia: "não sabe ainda" }, encerrar: false };
await atender(org, alugar, { agora: NOITE, atraso: 0 });

const naLista = paraConferir(org).find(l => l.id === alugar);
console.log(`   finalidade: ${naLista.finalidade} · ${naLista.completos}/${naLista.total_campos} campos`);
assert.equal(naLista.finalidade, "alugar");
assert.equal(naLista.completos, 3, "situação, orçamento e garantia — contados pela lista do ALUGUEL");
assert.equal(naLista.total_campos, 5);

console.log("24. Conferir leva os dados de aluguel para a ficha, na situação");
conferir(org, alugar, { userId: vanessa });
const fichaAluguel = JSON.parse(db.prepare("SELECT qual_json FROM leads WHERE id=?").get(alugar).qual_json);
console.log(`   situação: ${fichaAluguel.situacao}`);
assert.ok(/ALUGUEL/.test(fichaAluguel.situacao), "o corretor precisa ver na hora que não é compra");
assert.ok(/1\.200/.test(fichaAluguel.situacao), "o orçamento não pode sumir");
assert.ok(!fichaAluguel.entrada, "e não pode virar 'entrada', que seria mentira num campo com nome");

console.log("25. Chegando no teto, ele avisa a IA e a última vira despedida");
/* Antes ele simplesmente emudecia no teto — o cliente ficava falando sozinho
   depois de "e qual a sua renda?". Uma conversa que acaba sem despedida é
   pior do que uma que nunca começou. */
db.prepare("UPDATE orgs SET robo_ativo=1, robo_teto=4 WHERE id=?").run(org);
const ateOFim = lead({ nome: "Conversou até o teto", dono: vanessa });
respostaDaIA = { texto: "Legal! E pra quando você precisa?", coletado: {}, encerrar: false };

const avisos = [];
for (let i = 1; i <= 4; i++) {
  doCliente(ateOFim, "mensagem " + i);
  await atender(org, ateOFim, { agora: NOITE, atraso: 0 });
  avisos.push(/ÚLTIMA MENSAGEM/.test(ultimoPedido) ? "última"
    : /Comece a fechar/.test(ultimoPedido) ? "começar a fechar" : "—");
}
console.log(`   mensagem 1→4: ${avisos.join(" · ")}`);
assert.equal(avisos[0], "—", "no começo não tem por que apressar");
assert.equal(avisos[2], "começar a fechar", "faltando 2, ele começa a fechar");
assert.equal(avisos[3], "última", "na última, o aviso é explícito");

const fim = db.prepare("SELECT robo_msgs, robo_parado FROM leads WHERE id=?").get(ateOFim);
console.log(`   parou em ${fim.robo_msgs} mensagens · encerrado: ${!!fim.robo_parado}`);
assert.equal(fim.robo_msgs, 4);
assert.equal(!!fim.robo_parado, true, "a última encerra a conversa, a IA tendo dito isso ou não");

console.log("26. E a ficha explica o teto em vez de culpar o relógio");
const eTeto = estadoNoLead(org, ateOFim, MANHA);
console.log(`   às 10h da manhã, o motivo mostrado é: ${eTeto.motivo}`);
assert.equal(eTeto.motivo, "teto_de_mensagens", "o motivo é o teto, não o relógio nem uma pessoa");
db.prepare("UPDATE orgs SET robo_teto=12 WHERE id=?").run(org);

console.log("27. O que a equipe ensina entra no pedido à IA");
db.prepare("UPDATE orgs SET robo_ativo=1, robo_teto=12 WHERE id=?").run(org);
const ensinar = (texto, ativo = 1) => db.prepare(
  `INSERT INTO robo_ensino (id,org_id,texto,ordem,ativo,criado_por,created_at) VALUES (?,?,?,?,?,?,?)`)
  .run("en_" + randomUUID(), org, texto, n++, ativo, vanessa, Date.now());

ensinar("Chame a pessoa de 'você', nunca de 'senhor' ou 'senhora'.");
ensinar("Quando falarem do Morar Bem PE, diga que é o programa do governo de PE.");
ensinar("Esta orientação está desligada e não pode aparecer.", 0);

const ensinado = lead({ nome: "Vai ouvir a Vanessa", dono: vanessa });
doCliente(ensinado, "oi, boa noite");
respostaDaIA = { texto: "Oi! Tudo bem? Me conta o que você procura 😊", coletado: {}, encerrar: false };
await atender(org, ensinado, { agora: NOITE, atraso: 0 });

console.log(`   orientações ligadas: ${orientacoes(org).length} de ${orientacoes(org, true).length}`);
assert.equal(orientacoes(org).length, 2, "a desligada fica guardada, mas fora do pedido");
assert.ok(/nunca de 'senhor'/.test(ultimoPedido), "o que a Vanessa escreveu chegou na IA");
assert.ok(/Morar Bem PE/.test(ultimoPedido));
assert.ok(!/está desligada/.test(ultimoPedido), "orientação desligada NÃO pode ir junto");

console.log("28. E o ensino vem DEPOIS das proibições, sem poder derrubá-las");
const posProibicoes = ultimoPedido.indexOf("NUNCA diga valor de parcela");
const posEnsino = ultimoPedido.indexOf("COMO A EQUIPE DA CONECTA FALA");
console.log(`   proibições na posição ${posProibicoes}, ensino em ${posEnsino}`);
assert.ok(posProibicoes > 0 && posEnsino > posProibicoes,
  "campo que qualquer pessoa preenche não pode vir antes da trava");
assert.ok(/nunca valem mais que as proibições/.test(ultimoPedido),
  "e está escrito que uma não derruba a outra");

console.log("\nTudo certo ✅");
