/* A ESCALA DE PLANTAO: por que ela "nao salvava" e por que o mes anterior sumiu.
   (29/08/2026, defeito relatado pelo Ali)

   A escala salvava. Ia toda para JANEIRO DE 2001, e a tela do mes aberto
   ficava vazia.

   A causa era uma linha de consolo em `lerDia`: quando nenhum formato conhecido
   casava, ela chamava `new Date(texto)` e aceitava o que viesse. So que o
   JavaScript interpreta muita coisa que nao e data de escala — e a mais comum
   de todas era justamente a coluna "01/09", dia e mes sem ano, que numa
   planilha mensal e o normal porque o mes esta no titulo.

     "01/09"      virava 09/01/2001
     "seg 01/09"  virava 09/01/2001
     "Sabado"     virava 01/01/2001
     "46235"      virava o ano 46235 (o numero cru do Excel)

   Nenhum virava erro: viravam dias validos em anos errados, e a importacao
   respondia "30 dias lidos". E como gravar apaga dia+turno antes de inserir,
   dois meses caindo no mesmo janeiro de 2001 faziam o segundo apagar o
   primeiro — o "mes anterior sumiu".

   Este teste tranca as tres coisas: a leitura da data, o silencio da
   importacao e o silencio do "definir turno".

   Rodar:  npm run teste:plantao
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-plantao.db");
process.env.JWT_SECRET = "teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const P = await import("../src/services/plantao.js");

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "C-1", Date.now());
const novo = (id, nome, papel, status = "ativo") =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x',?,1,?,?)`).run(id, org, nome, nome.toLowerCase().replace(/ /g, "") + "@c.com", papel, Date.now(), status);
novo("u_ali", "Ali", "adm");
novo("u_vanessa", "Vanessa", "sdr");
novo("u_marina", "Marina", "corretor");
novo("u_rafael", "Rafael", "corretor");
novo("u_saiu", "Quem Saiu", "corretor", "removido");

// Setembro de 2026 é o mês "aberto na tela" em todos os testes abaixo.
const SETEMBRO = new Date(2026, 8, 1).getTime();
const fmt = (ms) => new Date(ms).toLocaleDateString("pt-BR");

console.log("===== A LEITURA DA DATA =====");

console.log("1. O formato que quebrou tudo: dia/mês SEM ANO");
/* Numa escala mensal é o normal — o mês está no título da planilha, não na
   célula. Antes virava 09/01/2001; agora usa o mês que está aberto na tela. */
let d = P.lerDia("01/09", SETEMBRO);
console.log(`   "01/09" com setembro/2026 na tela → ${fmt(d)}`);
assert.equal(new Date(d).getFullYear(), 2026);
assert.equal(new Date(d).getMonth(), 8);
assert.equal(new Date(d).getDate(), 1);

console.log("2. E o mês de referência MANDA — não o relógio do servidor");
/* A escala do mês que vem é montada no mês anterior. Adivinhar o ano pelo
   relógio erraria justamente nesse caso, que é o caso normal. */
const JANEIRO27 = new Date(2027, 0, 1).getTime();
d = P.lerDia("15/01", JANEIRO27);
console.log(`   "15/01" com janeiro/2027 na tela → ${fmt(d)}`);
assert.equal(new Date(d).getFullYear(), 2027);

console.log("3. Virada de ano: escala de janeiro montada em dezembro");
d = P.lerDia("05/01", new Date(2026, 11, 20).getTime());
console.log(`   "05/01" com dezembro/2026 na tela → ${fmt(d)}`);
assert.equal(new Date(d).getFullYear(), 2027, "janeiro visto de dezembro é o ano que vem");

console.log("4. Os formatos que já funcionavam continuam funcionando");
for (const [entrada, esperado] of [
  ["01/09/2026", "01/09/2026"], ["1/9/2026", "01/09/2026"],
  ["2026-09-01", "01/09/2026"], ["01-09-2026", "01/09/2026"],
  ["01/09/2026 00:00:00", "01/09/2026"], ["  01/09/2026  ", "01/09/2026"],
]) {
  const r = P.lerDia(entrada, SETEMBRO);
  assert.equal(fmt(r), esperado, `${entrada} deu ${isFinite(r) ? fmt(r) : "inválida"}`);
}
console.log("   dd/mm/aaaa, ISO, com hora e com espaço");

console.log("5. Ano de dois dígitos é lido na ordem BRASILEIRA");
/* "01/09/26" era lido como 9 de janeiro — o JavaScript assume mês/dia. */
d = P.lerDia("01/09/26", SETEMBRO);
console.log(`   "01/09/26" → ${fmt(d)}`);
assert.equal(fmt(d), "01/09/2026");

console.log("6. O número cru do Excel vira data, em vez de virar o ano 46235");
/* Chega assim quando o estilo da célula não é reconhecido como data. */
d = P.lerDia("46235", SETEMBRO);
console.log(`   "46235" → ${fmt(d)}`);
assert.ok(new Date(d).getFullYear() >= 2020 && new Date(d).getFullYear() <= 2030);

console.log("7. E o que NÃO é data volta inválido, em vez de virar 2001");
/* É a linha de consolo que saiu. Inventar uma data faz a escala sumir num
   lugar onde ninguém vai procurar — muito pior que recusar a linha. */
for (const lixo of ["Sábado", "Total", "Corretor", "—", "ago/26", "31/02/2026", "01/13/2026", "99999999"]) {
  const r = P.lerDia(lixo, SETEMBRO);
  console.log(`   ${JSON.stringify(lixo).padEnd(14)} → ${isFinite(r) ? "❌ " + fmt(r) : "inválida"}`);
  assert.ok(!isFinite(r), `"${lixo}" virou ${isFinite(r) ? fmt(r) : ""}`);
}

let r;

console.log("\n===== O CASAMENTO DOS NOMES =====");

console.log("7b. Nome de UMA PALAVRA casa — e não casava");
/* O segundo defeito, e provavelmente o principal. A versão anterior fazia nome
   completo e primeiro nome no mesmo laço:

     "Marina" → grava porNome["marina"]
              → primeiro nome também é "marina"
              → já existe no mapa, logo marca "__ambiguo__"

   Ela ficava ambígua consigo mesma. Numa equipe cadastrada por primeiro nome —
   que é como quase toda equipe é cadastrada — a planilha inteira voltava em
   "não identifiquei ninguém", com zero escalas gravadas. */
r = P.importarEscala(org, [{ data: "06/09", manha: ["Marina"], tarde: ["Vanessa"] }], "u_ali", { ref: SETEMBRO });
console.log(`   Marina e Vanessa → ${r.escalados} escala(s) · não encontrados: ${JSON.stringify(r.nao_encontrados)}`);
assert.equal(r.escalados, 2);
assert.deepEqual(r.nao_encontrados, []);

console.log("7c. Maiúscula, minúscula e acento não atrapalham");
r = P.importarEscala(org, [{ data: "07/09", manha: ["MARINA", "rafael"], tarde: [] }], "u_ali", { ref: SETEMBRO });
assert.equal(r.escalados, 2);
console.log("   MARINA e rafael casaram");

console.log("7d. Mas primeiro nome REPETIDO continua ambíguo — e é avisado");
/* Com duas Anas, adivinhar é pior do que dizer que não deu para identificar. */
novo("u_ana1", "Ana Silva", "corretor");
novo("u_ana2", "Ana Costa", "corretor");
r = P.importarEscala(org, [{ data: "08/09", manha: ["Ana"], tarde: ["Ana Silva"] }], "u_ali", { ref: SETEMBRO });
console.log(`   "Ana" sozinha → ${JSON.stringify(r.nao_encontrados)} · "Ana Silva" → ${r.escalados} escala(s)`);
assert.deepEqual(r.nao_encontrados, ["Ana"], "Ana sozinha é ambígua");
assert.equal(r.escalados, 1, "mas o nome completo casa");

console.log("\n===== A IMPORTAÇÃO =====");

console.log("8. A planilha com 'dd/mm' cai no mês certo");
r = P.importarEscala(org, [
  { data: "01/09", manha: ["Marina", "Rafael"], tarde: ["Vanessa"] },
  { data: "02/09", manha: ["Marina"], tarde: ["Rafael"] },
], "u_ali", { ref: SETEMBRO });
console.log(`   ${r.dias} dias · ${r.escalados} escalas · meses: ${r.meses.join(", ")}`);
assert.deepEqual(r.meses, ["09/2026"]);
assert.equal(r.dias, 2);
assert.equal(r.escalados, 5);

console.log("9. A resposta diz o INTERVALO e o MÊS — era o que faltava para ver o defeito");
/* Sem isso, uma escala que caiu em 2001 respondia "30 dias importados" e
   parecia sucesso. */
console.log(`   de ${fmt(r.de)} até ${fmt(r.ate)}`);
assert.equal(fmt(r.de), "01/09/2026");
assert.equal(fmt(r.ate), "02/09/2026");

console.log("10. Linha que o sistema não entendeu é CONTADA e devolvida");
/* Antes era pulada em silêncio, e o total contava só as que passaram: dez
   linhas perdidas sem ninguém saber. */
r = P.importarEscala(org, [
  { data: "03/09", manha: ["Marina"], tarde: [] },
  { data: "Sábado", manha: ["Rafael"], tarde: [] },
  { data: "Total do mês", manha: [], tarde: [] },
], "u_ali", { ref: SETEMBRO });
console.log(`   ${r.dias} dia(s) gravado(s) · ignoradas: ${JSON.stringify(r.datas_ignoradas)}`);
assert.equal(r.dias, 1);
assert.deepEqual(r.datas_ignoradas, ["Sábado", "Total do mês"]);

console.log("11. Nome fora da equipe continua sendo avisado");
r = P.importarEscala(org, [{ data: "04/09", manha: ["Marina", "Fulano de Tal"], tarde: [] }], "u_ali", { ref: SETEMBRO });
console.log(`   não encontrados: ${r.nao_encontrados.join(", ")}`);
assert.deepEqual(r.nao_encontrados, ["Fulano de Tal"]);

console.log("12. Quem SAIU da equipe não entra na escala");
r = P.importarEscala(org, [{ data: "05/09", manha: ["Quem Saiu"], tarde: [] }], "u_ali", { ref: SETEMBRO });
assert.equal(r.escalados, 0);
assert.deepEqual(r.nao_encontrados, ["Quem Saiu"]);
console.log("   e o nome dele volta na lista de não encontrados");

console.log("13. Importar SETEMBRO não encosta em AGOSTO");
/* É o "mês anterior sumiu". Antes, duas planilhas caindo no mesmo janeiro de
   2001 faziam a segunda apagar a primeira. */
P.importarEscala(org, [
  { data: "10/08/2026", manha: ["Marina"], tarde: ["Rafael"] },
  { data: "11/08/2026", manha: ["Vanessa"], tarde: [] },
], "u_ali", { ref: SETEMBRO });
const agostoAntes = P.escala(org, { de: new Date(2026, 7, 1).getTime(), ate: new Date(2026, 7, 31).getTime() }).length;
P.importarEscala(org, [
  { data: "10/09", manha: ["Marina"], tarde: ["Rafael"] },
  { data: "11/09", manha: ["Vanessa"], tarde: [] },
], "u_ali", { ref: SETEMBRO });
const agostoDepois = P.escala(org, { de: new Date(2026, 7, 1).getTime(), ate: new Date(2026, 7, 31).getTime() }).length;
console.log(`   agosto tinha ${agostoAntes} escalas, e depois de importar setembro tem ${agostoDepois}`);
assert.equal(agostoDepois, agostoAntes, "importar um mês não pode mexer no outro");

console.log("14. Reimportar o MESMO mês substitui, sem duplicar");
const antes14 = P.escala(org, { de: new Date(2026, 8, 10).getTime(), ate: new Date(2026, 8, 10).getTime() }).length;
P.importarEscala(org, [{ data: "10/09", manha: ["Marina"], tarde: ["Rafael"] }], "u_ali", { ref: SETEMBRO });
const depois14 = P.escala(org, { de: new Date(2026, 8, 10).getTime(), ate: new Date(2026, 8, 10).getTime() }).length;
console.log(`   ${antes14} → ${depois14}`);
assert.equal(depois14, antes14);

console.log("\n===== DEFINIR O TURNO NA MÃO =====");

console.log("15. Escolher gente válida grava");
r = P.definirTurno(org, { dia: "2026-09-20", turno: "manha", userIds: ["u_marina", "u_rafael"], autorId: "u_ali" });
console.log(`   ${r.quantos} pessoa(s)`);
assert.equal(r.quantos, 2);
assert.equal(r.recusados.length, 0);

console.log("16. E quem o servidor RECUSA é dito — não descartado calado");
/* Era o outro "não está salvando": só corretor e atendente entram na escala,
   e o gestor era filtrado sem aviso. A tela mandava dois nomes, o servidor
   gravava zero e respondia "ok" — some o que estava lá e nada aparece. */
r = P.definirTurno(org, { dia: "2026-09-21", turno: "manha", userIds: ["u_ali", "u_saiu"], autorId: "u_ali" });
console.log(`   gravou ${r.quantos} · recusou: ${r.recusados.map(x => `${x.nome} (${x.motivo})`).join(" · ")}`);
assert.equal(r.quantos, 0);
assert.equal(r.recusados.length, 2);
assert.ok(r.recusados.find(x => x.nome === "Ali" && /corretor e atendente/.test(x.motivo)));
assert.ok(r.recusados.find(x => x.nome === "Quem Saiu" && /não está mais ativo/.test(x.motivo)));

console.log("17. Data inválida na mão é recusada com a razão");
r = P.definirTurno(org, { dia: "Sábado", turno: "manha", userIds: ["u_marina"], autorId: "u_ali" });
console.log(`   ${r.error}`);
assert.equal(r.ok, false);

console.log("18. Esvaziar um turno de propósito continua funcionando");
/* Mandar lista vazia é como se tira alguém da escala — não pode ser confundido
   com a recusa silenciosa do teste 16. */
r = P.definirTurno(org, { dia: "2026-09-20", turno: "manha", userIds: [], autorId: "u_ali" });
assert.equal(r.quantos, 0);
assert.equal(r.recusados.length, 0, "ninguém foi recusado — a lista veio vazia mesmo");
assert.equal(P.doDia(org, new Date(2026, 8, 20).getTime()).manha.length, 0);
console.log("   turno esvaziado, sem recusa nenhuma");

console.log("\n===== SALVAR A PLANILHA (a prévia antes de gravar) =====");
/* Escolher o arquivo passou a LER e não gravar. Pesa mais aqui do que na
   imagem colada ou no áudio: a importação apaga dia+turno antes de gravar, e
   subir a planilha errada apagava a escala certa em silêncio. */

console.log("19. A prévia devolve os números e NÃO grava nada");
const antes19 = db.prepare("SELECT COUNT(*) n FROM plantoes WHERE org_id=?").get(org).n;
let pv = P.importarEscala(org, [
  { data: "10/09/2026", manha: ["Marina"], tarde: ["Rafael"] },
  { data: "11/09/2026", manha: ["Rafael"], tarde: ["Marina", "Vanessa"] },
], "u_ali", { ref: SETEMBRO, simular: true });
console.log(`   ${pv.dias} dia(s) · ${pv.escalados} escala(s) · simulado: ${pv.simulado}`);
assert.equal(pv.dias, 2);
assert.equal(pv.escalados, 5);
assert.equal(pv.simulado, true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM plantoes WHERE org_id=?").get(org).n, antes19,
  "a prévia não pode ter escrito uma linha sequer");

console.log("20. A prévia mostra os primeiros dias COM OS NOMES");
/* Total sem conteúdo não dá para conferir — e conferir é a única razão de o
   botão Salvar existir. */
console.log(`   ${pv.amostra.map(a => `${fmt(a.dia)} manhã:${a.manha.join("/")} tarde:${a.tarde.join("/")}`).join(" · ")}`);
assert.equal(pv.amostra.length, 2);
assert.deepEqual(pv.amostra[0].manha, ["Marina"]);
assert.deepEqual(pv.amostra[1].tarde.sort(), ["Marina", "Vanessa"]);

console.log("21. Salvar grava exatamente o que a prévia mostrou");
let sv = P.importarEscala(org, [
  { data: "10/09/2026", manha: ["Marina"], tarde: ["Rafael"] },
  { data: "11/09/2026", manha: ["Rafael"], tarde: ["Marina", "Vanessa"] },
], "u_ali", { ref: SETEMBRO });
assert.equal(sv.escalados, pv.escalados);
assert.equal(sv.simulado, false);
assert.equal(P.doDia(org, new Date(2026, 8, 10).getTime()).manha.length, 1);
console.log(`   ${sv.escalados} escala(s) gravadas`);

console.log("22. A prévia AVISA quantas escalas ela vai substituir");
/* É o aviso que só existe antes: depois, o que sumiu já sumiu. */
pv = P.importarEscala(org, [{ data: "10/09/2026", manha: ["Rafael"], tarde: [] }],
  "u_ali", { ref: SETEMBRO, simular: true });
console.log(`   substitui ${pv.substitui} escala(s) já existentes`);
assert.equal(pv.substitui, 2, "manhã e tarde do dia 10 já tinham gente");

console.log("\n===== QUEM VEIO AO PLANTÃO =====");
/* A atendente confere depois do turno, e o número vai para o relatório
   individual do corretor. */
const DIA10 = new Date(2026, 8, 10).getTime();
// O "hoje" destes testes é o fim de setembro: a conferência só vale para
// turno que já passou, e a escala montada acima é de setembro de 2026.
const FIM_DE_SETEMBRO = new Date(2026, 8, 30, 12).getTime();

console.log("23. Só dá para conferir plantão que JÁ ACONTECEU");
/* Marcar "veio" no plantão de amanhã é afirmar um fato que ainda não existe —
   e no relatório ele ficaria indistinguível de uma presença de verdade. */
const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
P.definirTurno(org, { dia: amanha, turno: "manha", userIds: ["u_marina"], autorId: "u_ali" });
r = P.marcarPresenca(org, { dia: amanha, turno: "manha", userId: "u_marina", presente: true, autorId: "u_vanessa" });
console.log(`   ${r.error}`);
assert.equal(r.ok, false);
assert.ok(/ainda não aconteceu/.test(r.error));

console.log("24. Presença de quem NÃO está escalado é recusada");
/* Senão "presenças" passaria de "turnos escalados", e número impossível
   derruba a confiança na tela inteira. */
r = P.marcarPresenca(org, { dia: DIA10, turno: "manha", userId: "u_rafael", presente: true, autorId: "u_vanessa", agora: FIM_DE_SETEMBRO });
console.log(`   ${r.error}`);
assert.equal(r.ok, false);
assert.ok(/não está escalada/.test(r.error));

console.log("25. Conferir grava, e volta na escala junto com quem conferiu");
r = P.marcarPresenca(org, { dia: DIA10, turno: "manha", userId: "u_marina",
  presente: true, obs: "chegou 8h10", autorId: "u_vanessa", agora: FIM_DE_SETEMBRO });
assert.equal(r.ok, true);
let linha = P.escala(org, { de: DIA10, ate: DIA10 }).find(l => l.user_id === "u_marina" && l.turno === "manha");
console.log(`   ${linha.nome}: presente=${linha.presente} · "${linha.presenca_obs}" · por ${linha.conferido_por}`);
assert.equal(linha.presente, 1);
assert.equal(linha.presenca_obs, "chegou 8h10");
assert.equal(linha.conferido_por, "Vanessa");

console.log("26. DESMARCAR volta para 'não conferido' — não para 'não veio'");
/* Clique errado precisa ter volta, e voltar não pode significar registrar o
   contrário no relatório de alguém. */
r = P.marcarPresenca(org, { dia: DIA10, turno: "manha", userId: "u_marina", presente: null, autorId: "u_vanessa", agora: FIM_DE_SETEMBRO });
assert.equal(r.ok, true);
linha = P.escala(org, { de: DIA10, ate: DIA10 }).find(l => l.user_id === "u_marina" && l.turno === "manha");
console.log(`   presente agora é ${linha.presente} (nulo = ninguém conferiu)`);
assert.equal(linha.presente, null);

console.log("27. SUBIR A PLANILHA DE NOVO NÃO APAGA A CONFERÊNCIA");
/* O motivo de a presença morar em tabela separada. As linhas de `plantoes`
   são apagadas e recriadas a cada importação — se a conferência morasse lá,
   corrigir um nome na planilha e reenviar apagaria o mês inteiro de
   conferências, sem nada aparecer na tela. */
P.marcarPresenca(org, { dia: DIA10, turno: "tarde", userId: "u_rafael", presente: false,
  obs: "não avisou", autorId: "u_vanessa", agora: FIM_DE_SETEMBRO });
P.importarEscala(org, [{ data: "10/09/2026", manha: ["Marina"], tarde: ["Rafael"] }],
  "u_ali", { ref: SETEMBRO });
linha = P.escala(org, { de: DIA10, ate: DIA10 }).find(l => l.user_id === "u_rafael" && l.turno === "tarde");
console.log(`   depois de reimportar: presente=${linha.presente} · "${linha.presenca_obs}"`);
assert.equal(linha.presente, 0);
assert.equal(linha.presenca_obs, "não avisou");

console.log("\n===== O QUE VAI PARA O RELATÓRIO DO CORRETOR =====");

console.log("28. Conta TURNOS, e o não conferido é um número PRÓPRIO");
/* Contar quem ninguém conferiu como falta faria o relatório inventar faltas
   no mês em que a atendente esqueceu de marcar. */
let res = P.resumoPresenca(org, { de: new Date(2026, 8, 1).getTime(), ate: new Date(2026, 8, 30).getTime() },
  new Date(2026, 8, 30).getTime());
const rafael = res.get("u_rafael");
console.log(`   Rafael: ${rafael.turnos_passados} turno(s) · ${rafael.presencas} veio · ${rafael.faltas} faltou · ${rafael.nao_conferidos} não conferido`);
assert.equal(rafael.faltas, 1);
assert.equal(rafael.presencas, 0);
assert.ok(rafael.nao_conferidos >= 1, "os turnos que ninguém marcou ficam no terceiro número");
assert.equal(rafael.presencas + rafael.faltas + rafael.nao_conferidos, rafael.turnos_passados,
  "as três parcelas têm que fechar com o total");

console.log("29. Turno que ainda não aconteceu NÃO é 'não conferido'");
/* Ele ainda não é nada. Sem esse corte, abrir o relatório do mês corrente
   mostraria uma pilha de pendências que é só o resto do mês. */
res = P.resumoPresenca(org, { de: new Date(2026, 8, 1).getTime(), ate: new Date(2026, 8, 30).getTime() },
  new Date(2026, 8, 10).getTime());
const r29 = res.get("u_rafael");
console.log(`   olhando de dentro do dia 10: ${r29.turnos_escalado} escalado(s), ${r29.turnos_passados} já aconteceram`);
assert.ok(r29.turnos_escalado > r29.turnos_passados, "o futuro conta como escalado, não como pendente");

console.log("\n===== O RELATÓRIO DE PLANTÕES (02/09/2026) =====");

const SET = new Date(2026, 8, 1).getTime(), SET_FIM = new Date(2026, 8, 30).getTime();
const FIM_DO_MES = new Date(2026, 8, 30).getTime();

console.log("30. Sai por pessoa, por turno e por dia — e as parcelas fecham");
const rel = P.relatorio(org, { de: SET, ate: SET_FIM }, FIM_DO_MES);
console.log(`   ${rel.pessoas.length} pessoa(s) · turnos: ${rel.por_turno.map(t => `${t.rotulo} ${t.turnos_escalado}`).join(", ")} · ${rel.por_dia.length} dia(s)`);
assert.ok(rel.pessoas.length >= 1);
assert.equal(rel.totais.presencas + rel.totais.faltas + rel.totais.nao_conferidos, rel.totais.turnos_passados,
  "as três parcelas têm que fechar com o total, igual no individual");
/* O total tem que ser a soma das pessoas: se divergir, uma das duas contas
   está errada e não há como saber qual olhando a tela. */
const somaPessoas = rel.pessoas.reduce((s, p) => s + p.turnos_escalado, 0);
assert.equal(somaPessoas, rel.totais.turnos_escalado, "o total é a soma das pessoas");
assert.equal(rel.por_turno.reduce((s, t) => s + t.turnos_escalado, 0), rel.totais.turnos_escalado,
  "e a soma dos turnos também");

/* Uma casa montada só para estas duas contas, porque a diferença entre elas só
   aparece com um arranjo específico: alguém com presença E com turno não
   conferido no mesmo período. Na Conecta do teste ninguém tem isso — e um caso
   em que as duas fórmulas dão o mesmo número não prova nada sobre qual delas
   está sendo usada. */
const orgConta = "org_relatorio_conta";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)")
  .run(orgConta, "Casa da conta", "CONTA-1", Date.now());
for (const [id, nome] of [["u_ana", "Ana"], ["u_pedro", "Pedro"]])
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`).run(id, orgConta, nome, id + "@conta.com", Date.now());

// Ana: veio no dia 2, faltou no 3, e o dia 4 ninguém conferiu.
const d2 = new Date(2026, 8, 2).getTime(), d3 = new Date(2026, 8, 3).getTime(), d4 = new Date(2026, 8, 4).getTime();
for (const d of [d2, d3, d4])
  P.definirTurno(orgConta, { dia: d, turno: "manha", userIds: ["u_ana"], autorId: null });
P.marcarPresenca(orgConta, { dia: d2, turno: "manha", userId: "u_ana", presente: true, agora: FIM_DO_MES });
P.marcarPresenca(orgConta, { dia: d3, turno: "manha", userId: "u_ana", presente: false, agora: FIM_DO_MES });
// Pedro: um turno só, e ninguém conferiu.
P.definirTurno(orgConta, { dia: d2, turno: "tarde", userIds: ["u_pedro"], autorId: null });

const relConta = P.relatorio(orgConta, { de: SET, ate: SET_FIM }, FIM_DO_MES);
const ana = relConta.pessoas.find(p => p.user_id === "u_ana");
const pedro = relConta.pessoas.find(p => p.user_id === "u_pedro");

console.log("31. APROVEITAMENTO divide pelo que foi CONFERIDO, não pelos turnos passados");
/* É a trava mais importante deste relatório. Dividir pelos turnos passados
   transformaria o esquecimento da atendente na nota do corretor: num mês de
   conferência fraca, a equipe inteira apareceria reprovada por um trabalho que
   ela fez. */
console.log(`   Ana: ${ana.presencas} veio / ${ana.faltas} faltou / ${ana.nao_conferidos} não conferido → ${ana.aproveitamento}%`);
assert.equal(ana.conferidos, 2);
assert.equal(ana.aproveitamento, 50, "1 presença em 2 conferidos = 50%");
assert.ok(ana.nao_conferidos > 0, "e ela TEM turno não conferido — senão este teste não prova nada");
assert.notEqual(ana.aproveitamento, Math.round((ana.presencas / ana.turnos_passados) * 100),
  "dividindo pelos turnos passados daria 33% — as duas contas TÊM que dar diferente");

console.log("32. Ninguém conferiu = aproveitamento NULO, nunca 0%");
/* Zero por cento lê-se como "não apareceu nenhuma vez", que é a acusação mais
   grave que esta tela pode fazer — e estaria sendo feita onde não se sabe de
   nada. */
console.log(`   Pedro: ${pedro.turnos_passados} turno(s) passado(s), ${pedro.conferidos} conferido(s) → aproveitamento ${pedro.aproveitamento}`);
assert.equal(pedro.aproveitamento, null, "sem conferência nenhuma, é NULO — não é zero");
assert.equal(pedro.nao_conferidos, 1);

console.log("33. Turno que ainda não aconteceu não entra como pendente aqui também");
const relCedo = P.relatorio(org, { de: SET, ate: SET_FIM }, new Date(2026, 8, 10).getTime());
console.log(`   olhando de dentro do dia 10: ${relCedo.totais.turnos_escalado} escalado(s), ${relCedo.totais.turnos_passados} já aconteceram`);
assert.ok(relCedo.totais.turnos_escalado > relCedo.totais.turnos_passados);

console.log("34. A lista começa por quem MAIS faltou");
/* Quem abre este relatório está procurando problema. Ordenar pelo melhor faria
   a gestão rolar a lista até o fim para achar o que veio ver. */
const faltas = rel.pessoas.map(p => p.faltas);
console.log(`   faltas na ordem: ${faltas.join(", ")}`);
assert.deepEqual(faltas, [...faltas].sort((a, b) => b - a), "está em ordem decrescente de falta");

console.log("\nTudo certo ✅");
process.exit(0);
