/* MARKETING — FLUXOS E DISPARO EM MASSA (27/09/2026).

   O motor inteiro, com o relógio na mão do teste (`processarDisparos({agora})`)
   e uma Uazapi de mentira que registra cada envio:
   fluxo com botões e espera de resposta, público vindo do CRM (tag) e de lista,
   limites do número, resposta desviando o fluxo, prazo vencido, "SAIR",
   equipe assumindo, contato da lista que vira lead com o histórico junto,
   número sem WhatsApp e a pausa por falhas seguidas.

   Rodar:  npm run teste:marketing-disparo
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-disparo.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4657";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_ACEITAR_POR_NUMERO = "";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== UAZAPI DE MENTIRA =====
const DONO_DO_TOKEN = { "tok-disparo": "5587988887777", "tok-casa-A": "5587911112222" };
const envios = [];
const SEM_WHATS = new Set(["5587966660000", "558766660000"]);
let falharTudo = false;
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    const tk = req.headers.token;
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (!DONO_DO_TOKEN[tk]) return json(401, { error: "token inválido" });
    if (req.url.startsWith("/send/")) {
      const d = corpo ? JSON.parse(corpo) : {};
      if (falharTudo) return json(500, { error: "instância instável" });
      if (SEM_WHATS.has(d.number)) return json(500, { error: `the number ${d.number}@s.whatsapp.net is not on WhatsApp` });
      // Os botões falham na API não oficial: o fluxo tem que cair no texto numerado.
      if (req.url === "/send/menu") return json(500, { error: "button messages not supported" });
      const id = "wa_" + Math.random().toString(36).slice(2);
      envios.push({ token: tk, rota: req.url, numero: d.number, texto: d.text || "", file: d.file || null, id });
      return json(200, { messageid: id });
    }
    json(200, { instance: { status: "connected", owner: DONO_DO_TOKEN[tk] }, status: { connected: true, loggedIn: true } });
  });
});
await new Promise(r => mock.listen(4658, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarDisparos, RODAPE_SAIR } = await import("../src/services/disparo.js");
const BASE = "http://localhost:4657";
const MOCK = "http://127.0.0.1:4658";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "DS-" + id.slice(4), Date.now(), "");
  return id; };
const pessoa = (org, nome, role, extra = {}) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@ds.com", senha, role, Date.now(), extra.master ? 1 : 0);
  return id; };

const casaConHub = novaOrg("ConHub");
pessoa(casaConHub, "Ali", "adm", { master: true });
const orgA = novaOrg("Imobiliária A");
pessoa(orgA, "Gestora", "adm");
const atendente = pessoa(orgA, "Vanessa", "sdr");
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ?, wa_number = ? WHERE id = ?").run(MOCK, "tok-casa-A", "5587911112222", orgA);
const canalCasa = "c_" + randomUUID();
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,wa_number,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,?,1,?)`)
  .run(canalCasa, orgA, MOCK, "tok-casa-A", "5587911112222", Date.now());
const orgB = novaOrg("Imobiliária B");
pessoa(orgB, "OutroGestor", "adm");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@ds.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login ${nome}: ${JSON.stringify(d)}`); return d.token;
}
const chamar = async (token, caminho, metodo = "GET", corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const tGestora = await entrar("Gestora"), tAli = await entrar("Ali"), tOutro = await entrar("OutroGestor");
const csv = (linhas) => ({ nome: "lista.csv", base64: Buffer.from(linhas.join("\n")).toString("base64") });
const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// Preparação: liberado, termo aceito e número de disparo conectado.
await chamar(tAli, `/orgs/${orgA}/marketing`, "POST", { liberado: true });
await chamar(tAli, `/orgs/${orgB}/marketing`, "POST", { liberado: true });
assert.equal((await chamar(tGestora, "/marketing/termo", "POST", { aceito: true })).status, 200);
assert.equal((await chamar(tOutro, "/marketing/termo", "POST", { aceito: true })).status, 200);
assert.equal((await chamar(tGestora, "/marketing/numero", "PUT", { host: MOCK, token: "tok-disparo" })).status, 200);
const canalDisparo = db.prepare("SELECT canal_id FROM marketing_numero WHERE org_id = ?").get(orgA).canal_id;
assert.ok(canalDisparo, "o número de disparo vira uma linha própria");

// Leads do CRM: dois com a tag Investidor, um sem.
const tag = "t_" + randomUUID();
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tag, orgA, "Investidor", "#0E8F6E", Date.now());
const novoLead = (nome, phone, comTag) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,'Lead',?,?)`)
    .run(id, orgA, nome, phone, atendente, Date.now() - 86400000 * 10);
  if (comTag) db.prepare("INSERT INTO lead_tags (lead_id,tag_id,org_id,marcada_em) VALUES (?,?,?,?)").run(id, tag, orgA, Date.now());
  return id; };
const L1 = novoLead("Lucas Andrade", "5587900000001", true);
const L2 = novoLead("Laura Braga", "5587900000002", true);
const L3 = novoLead("Luan Costa", "5587900000003", false);

// Um dia útil, às 10h, no futuro: o relógio é do teste.
const dia = new Date(); dia.setDate(dia.getDate() + 7); dia.setHours(10, 0, 0, 0);
while (dia.getDay() === 0 || dia.getDay() === 6) dia.setDate(dia.getDate() + 1);
let agora = dia.getTime();
const tique = async (segundos = 0) => { agora += segundos * 1000; await processarDisparos({ agora }); };
const webhook = (tel, texto, extra = {}) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-disparo", message: { chatid: tel + "@s.whatsapp.net", fromMe: false,
    messageid: "in_" + Math.random().toString(36).slice(2), messageType: "conversation", text: texto, senderName: "Cliente", ...extra } }) })
  .then(() => new Promise(r => setTimeout(r, 250)));
const exec = (camp, tel) => db.prepare("SELECT * FROM marketing_execucoes WHERE campanha_id = ? AND telefone = ?").get(camp, tel);

console.log("1. Fluxo: nasce com início + mensagem, salva o grafo e diz o que falta");
let r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Reativação" });
assert.equal(r.status, 201);
const fluxo = r.d.id;
assert.equal(r.d.grafo.nos.length, 2);
const grafo = {
  nos: [
    { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: {} },
    { id: "m1", tipo: "mensagem", x: 200, y: 0, dados: { texto: "Oi, {nome}! Temos novidades." } },
    { id: "b1", tipo: "botoes", x: 400, y: 0, dados: { texto: "Quer ver os imóveis?", escrever_opcoes: true,
      botoes: [{ id: "sim", rotulo: "Sim" }, { id: "nao", rotulo: "Não" }], prazo: { quantidade: 1, unidade: "horas" } } },
    { id: "m2", tipo: "mensagem", x: 600, y: -100, dados: { texto: "Ótimo! Um corretor já te chama." } },
    { id: "m3", tipo: "mensagem", x: 600, y: 0, dados: { texto: "Tudo bem, obrigado!" } },
    { id: "m4", tipo: "mensagem", x: 600, y: 100, dados: { texto: "" } },
  ],
  ligacoes: [
    { de: "inicio", saida: "proximo", para: "m1" }, { de: "m1", saida: "proximo", para: "b1" },
    { de: "b1", saida: "sim", para: "m2" }, { de: "b1", saida: "nao", para: "m3" }, { de: "b1", saida: "sem_resposta", para: "m4" },
    { de: "m4", saida: "proximo", para: "inicio" },   // ligação para o início é descartada
  ],
};
r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo });
assert.equal(r.status, 200);
assert.equal(r.d.grafo.ligacoes.length, 5, "ligação que volta para o início não entra");
assert.ok(r.d.avisos.some(a => /vazio/.test(a)), `o bloco vazio aparece como aviso: ${r.d.avisos}`);
assert.equal((await chamar(tOutro, `/marketing/fluxos/${fluxo}`)).status, 404, "outra imobiliária não abre o fluxo");

console.log("2. Público: tag do CRM + lista, sem repetido e sem quem pediu para sair");
const lista = (await chamar(tGestora, "/marketing/listas", "POST", { nome: "Feira", origem: "conversaram", coletado_em: ontem, declaracao: true,
  arquivo: csv(["nome;telefone", "Carla Dias;87 90000-0010", "Lucas de novo;87 90000-0001", "Célio;87 90000-0011",
    "Sem Zap;87 96666-0000", "Bloqueado;87 90000-0012"]) })).d.lista;
assert.ok(lista?.id, "lista criada");
await chamar(tGestora, "/marketing/bloqueio", "POST", { telefone: "87 90000-0012" });
const publico = { listas: [lista.id], leads: { tags: [tag] } };
r = await chamar(tGestora, "/marketing/publico/previa", "POST", { publico });
console.log(`   ${r.d.total} pessoas — ${JSON.stringify(r.d.resumo)}`);
assert.equal(r.d.total, 5);   // Carla, Célio, Sem Zap (lista) + Lucas, Laura (tag)
assert.equal(r.d.resumo.repetidos, 1); assert.equal(r.d.resumo.bloqueados, 1);
const opcoes = (await chamar(tGestora, "/marketing/publico/opcoes")).d;
assert.equal(opcoes.tags[0].leads, 2); assert.ok(opcoes.listas.some(l => l.id === lista.id));

console.log("3. Disparo só com fluxo pronto e declaração marcada");
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Reativação set", fluxo_id: fluxo, publico, declaracao: true });
assert.equal(r.status, 422, "bloco vazio no caminho segura o disparo");
grafo.nos[5].dados.texto = "Ainda está por aí, {nome}?";
await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo });
assert.equal((await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Reativação set", fluxo_id: fluxo, publico })).status, 400);
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Reativação set", fluxo_id: fluxo, publico, declaracao: true });
assert.equal(r.status, 201, JSON.stringify(r.d));
const camp = r.d.id;
assert.equal(r.d.total, 5);
assert.ok(db.prepare("SELECT declaracao FROM marketing_campanhas WHERE id = ?").get(camp).declaracao.length > 50, "a declaração fica gravada por extenso");
assert.equal((await chamar(tGestora, "/marketing/publico/previa", "POST", { publico })).d.resumo.em_andamento, 5, "quem já está num disparo não entra em outro");

console.log("4. Uma mensagem por vez, com intervalo; rodapé de saída só na primeira");
await chamar(tGestora, "/marketing/numero/limites", "PUT", { intervalo_min: 10, intervalo_max: 10 });
await tique();
assert.equal(envios.length, 1, "no mesmo instante, só uma mensagem sai do número");
await tique(5);
assert.equal(envios.length, 1, "antes do intervalo, nada sai");
for (let i = 0; i < 12; i++) await tique(10);
const doDisparo = envios.filter(e => e.token === "tok-disparo");
console.log(`   ${doDisparo.length} envios: ${doDisparo.map(e => e.numero.slice(-4) + ":" + e.texto.split("\n")[0].slice(0, 18)).join(" | ")}`);
assert.equal(doDisparo.length, 8, "4 pessoas × (mensagem + botões); a sem WhatsApp não recebe nada");
const primeiraDeLucas = doDisparo.find(e => e.numero === "5587900000001");
assert.ok(primeiraDeLucas.texto.startsWith("Oi, Lucas!"), "{nome} vira o primeiro nome");
assert.ok(primeiraDeLucas.texto.includes(RODAPE_SAIR));
const botoesDeLucas = doDisparo.filter(e => e.numero === "5587900000001")[1];
assert.ok(!botoesDeLucas.texto.includes(RODAPE_SAIR), "o rodapé vai uma vez só");
assert.ok(/1 - Sim/.test(botoesDeLucas.texto) && /2 - Não/.test(botoesDeLucas.texto), "botões recusados viram opções escritas");
assert.equal(exec(camp, "5587966660000").estado, "falhou");
assert.match(exec(camp, "5587966660000").fim_motivo, /WhatsApp/);
assert.equal(db.prepare("SELECT status FROM marketing_campanhas WHERE id = ?").get(camp).status, "rodando", "número sem WhatsApp não pausa o disparo");

console.log("5. O envio entra na conversa do lead, sem contar como resposta da equipe");
const naConversa = db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at").all(L1);
assert.equal(naConversa.length, 2);
assert.equal(naConversa[0].from_name, "Disparo · Reativação set");
assert.equal(naConversa[0].from_user_id, null);
assert.equal(naConversa[0].canal_id, canalDisparo);
assert.equal(db.prepare("SELECT first_resp_at FROM leads WHERE id = ?").get(L1).first_resp_at, null);

console.log("6. A resposta desvia o fluxo e a conversa passa para o número de disparo");
await webhook("5587900000001", "1");
assert.equal(exec(camp, "5587900000001").no_atual, "m2");
assert.equal(db.prepare("SELECT canal_id FROM leads WHERE id = ?").get(L1).canal_id, canalDisparo,
  "quem respondeu ao disparo continua a conversa pelo mesmo número");
await tique(10);
assert.equal(envios.at(-1).texto, "Ótimo! Um corretor já te chama.");
assert.equal(exec(camp, "5587900000001").estado, "concluida");

console.log("7. Contato da lista que responde vira lead — com o que o disparo já tinha mandado");
await webhook("5587900000010", "Não, obrigada");
const carla = db.prepare("SELECT * FROM leads WHERE phone = '5587900000010'").get();
assert.ok(carla, "o lead nasce");
assert.equal(carla.origem, "Disparo");
assert.equal(carla.assigned_to, atendente, "vai para a atendente da vez, pela catraca");
assert.equal(carla.canal_id, canalDisparo);
const hist = db.prepare("SELECT direction, from_name, body FROM messages WHERE lead_id = ? ORDER BY created_at").all(carla.id);
console.log(`   conversa: ${hist.map(m => m.direction + ":" + m.body.slice(0, 14)).join(" | ")}`);
assert.equal(hist.filter(m => m.from_name === "Disparo · Reativação set").length, 2, "as duas mensagens do disparo entram antes da resposta");
assert.equal(exec(camp, "5587900000010").no_atual, "m3", "\"não\" casa com o botão Não");
assert.equal(exec(camp, "5587900000010").respondeu, 1);

console.log("8. \"SAIR\" para o fluxo e bloqueia o número");
await webhook("5587900000011", "SAIR");
assert.equal(exec(camp, "5587900000011").estado, "saiu");
assert.ok(db.prepare("SELECT 1 FROM marketing_bloqueio WHERE org_id = ? AND telefone = '5587900000011'").get(orgA));

console.log("9. Sem resposta no prazo, segue pelo caminho do \"não respondeu\"");
await tique(3600);
await tique(10); await tique(10);
const paraLaura = envios.filter(e => e.numero === "5587900000002").at(-1);
assert.equal(paraLaura.texto, "Ainda está por aí, Laura?");
assert.ok(envios.some(e => e.numero === "5587900000010" && e.texto === "Tudo bem, obrigado!"));
await tique(10); await tique(10);
assert.equal(db.prepare("SELECT status FROM marketing_campanhas WHERE id = ?").get(camp).status, "concluida");
r = await chamar(tGestora, `/marketing/campanhas/${camp}`);
console.log(`   relatório: ${JSON.stringify({ enviadas: r.d.mensagens_enviadas, responderam: r.d.responderam, sairam: r.d.sairam, falharam: r.d.falharam })}`);
assert.equal(r.d.responderam, 3); assert.equal(r.d.sairam, 1); assert.equal(r.d.falharam, 1);
assert.equal(r.d.por_bloco.find(b => b.id === "m1").enviados, 4);
assert.equal((await chamar(tOutro, `/marketing/campanhas/${camp}`)).status, 404);

console.log("10. A equipe escreveu para o lead: o fluxo sai da conversa");
r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Com espera" });
const fluxo2 = r.d.id;
await chamar(tGestora, `/marketing/fluxos/${fluxo2}`, "PUT", { grafo: {
  nos: [{ id: "inicio", tipo: "inicio", dados: {} }, { id: "a", tipo: "mensagem", dados: { texto: "Primeira" } },
    { id: "e", tipo: "espera", dados: { quantidade: 1, unidade: "dias" } }, { id: "b", tipo: "mensagem", dados: { texto: "Segunda" } }],
  ligacoes: [{ de: "inicio", saida: "proximo", para: "a" }, { de: "a", saida: "proximo", para: "e" }, { de: "e", saida: "proximo", para: "b" }] } });
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Espera", fluxo_id: fluxo2, publico: { leads: { etapas: [], todos: false, responsaveis: [atendente], tags: [] } }, declaracao: true });
assert.equal(r.status, 201, JSON.stringify(r.d));
const camp2 = r.d.id;
const pessoasCamp2 = r.d.total;
for (let i = 0; i < pessoasCamp2 + 2; i++) await tique(10);
assert.equal(exec(camp2, "5587900000003").no_atual, "b", "depois da primeira, espera um dia no bloco seguinte");
await new Promise(r => setTimeout(r, 20));
const tVanessa = await entrar("Vanessa");
assert.equal((await chamar(tVanessa, `/leads/${L3}/messages`, "POST", { text: "Oi Luan, sou a Vanessa!" })).status, 200);
await tique(86400);
for (let i = 0; i < pessoasCamp2 + 2; i++) await tique(10);
assert.equal(exec(camp2, "5587900000003").estado, "assumida");
assert.ok(!envios.some(e => e.numero === "5587900000003" && e.texto === "Segunda"), "a segunda mensagem não sai no meio da conversa");

console.log("11. Fora do horário não sai nada; o limite do dia empurra para amanhã");
await chamar(tGestora, "/marketing/numero/limites", "PUT", { limite_dia: 1 });
const L4 = novoLead("Lia Duarte", "5587900000004", false);
const L5 = novoLead("Leo Esteves", "5587900000005", false);
const fluxo3 = (await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Simples" })).d.id;
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Limite", fluxo_id: fluxo3,
  publico: { listas: [], leads: { responsaveis: [atendente], tags: [], etapas: [] } }, declaracao: true });
const camp3 = r.d.id;
const noite = new Date(agora); noite.setDate(noite.getDate() + 1); noite.setHours(22, 0, 0, 0);
while (noite.getDay() === 0 || noite.getDay() === 6) noite.setDate(noite.getDate() + 1);
agora = noite.getTime();
const antes = envios.length;
await tique();
assert.equal(envios.length, antes, "22h: nada sai");
const manha = new Date(noite); manha.setDate(manha.getDate() + 1); manha.setHours(8, 0, 0, 0);
assert.ok(exec(camp3, "5587900000004").proxima_em >= manha.getTime(), "fica para a abertura do dia seguinte");
agora = manha.getTime() + 3600000;
await tique(); await tique(30); await tique(30);
assert.equal(envios.length, antes + 1, "com limite 1 por dia, sai uma só");
const pendente = db.prepare(`SELECT MIN(proxima_em) p FROM marketing_execucoes WHERE campanha_id = ? AND estado = 'ativa'`).get(camp3).p;
assert.ok(pendente > manha.getTime() + 86400000 - 1, "o resto vai para o dia seguinte");

console.log("12. Cinco falhas seguidas pausam o disparo sozinhas");
await chamar(tGestora, `/marketing/campanhas/${camp3}/cancelar`, "POST");
await chamar(tGestora, "/marketing/numero/limites", "PUT", { limite_dia: 150 });
const lista2 = (await chamar(tGestora, "/marketing/listas", "POST", { nome: "Evento", origem: "conversaram", coletado_em: ontem, declaracao: true,
  arquivo: csv(["telefone", ...[20, 21, 22, 23, 24, 25].map(n => `87 90000-00${n}`)]) })).d.lista;
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Instável", fluxo_id: fluxo3, publico: { listas: [lista2.id] }, declaracao: true });
const camp4 = r.d.id;
falharTudo = true;
agora += 86400000 * 2;
while (new Date(agora).getDay() === 0 || new Date(agora).getDay() === 6) agora += 86400000;
for (let i = 0; i < 6; i++) await tique(10);
const c4 = db.prepare("SELECT status, motivo FROM marketing_campanhas WHERE id = ?").get(camp4);
console.log(`   ${c4.status}: ${c4.motivo.slice(0, 70)}…`);
assert.equal(c4.status, "pausada"); assert.match(c4.motivo, /5 falhas seguidas/);
falharTudo = false;
assert.equal((await chamar(tGestora, `/marketing/campanhas/${camp4}/retomar`, "POST")).status, 200);
await tique(300);   // quem falhou tenta de novo depois de 5 minutos
for (let i = 0; i < 8; i++) await tique(10);
assert.ok(envios.some(e => e.numero === "5587900000020"), "retomado, volta a enviar");

console.log("13. Tirar o número de contingência pausa tudo e devolve as conversas para a casa");
const lista4 = (await chamar(tGestora, "/marketing/listas", "POST", { nome: "Obra", origem: "conversaram", coletado_em: ontem, declaracao: true,
  arquivo: csv(["telefone", "87 90000-0050"]) })).d.lista;
const camp6 = (await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "No meio", fluxo_id: fluxo3, publico: { listas: [lista4.id] }, declaracao: true })).d.id;
assert.equal((await chamar(tGestora, "/marketing/numero", "DELETE")).status, 200);
assert.equal(db.prepare("SELECT canal_id FROM leads WHERE id = ?").get(L1).canal_id, null);
const c6 = db.prepare("SELECT status, motivo FROM marketing_campanhas WHERE id = ?").get(camp6);
assert.equal(c6.status, "pausada", "não segue sozinho pelo número de atendimento");
assert.match(c6.motivo, /Retome/);
await chamar(tGestora, `/marketing/campanhas/${camp6}/cancelar`, "POST");

console.log("14. Sem número de contingência, o disparo sai pelo WhatsApp que já está conectado");
r = await chamar(tGestora, "/marketing");
assert.equal(r.d.linha.propria, false); assert.equal(r.d.linha.pronta, true);
assert.equal(r.d.limites.limite_dia, 150, "o ritmo é da conta e continua valendo sem o número");
const lista3 = (await chamar(tGestora, "/marketing/listas", "POST", { nome: "Plantão", origem: "conversaram", coletado_em: ontem, declaracao: true,
  arquivo: csv(["nome;telefone", "Olga Prado;87 90000-0040"]) })).d.lista;
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Pela casa", fluxo_id: fluxo, publico: { listas: [lista3.id] }, declaracao: true });
assert.equal(r.status, 201, JSON.stringify(r.d));
const camp5 = r.d.id;
const antesCasa = envios.length;
for (let i = 0; i < 4; i++) await tique(10);
const pelaCasa = envios.slice(antesCasa);
console.log(`   ${pelaCasa.map(e => e.token + ":" + e.texto.split("\n")[0].slice(0, 16)).join(" | ")}`);
assert.equal(pelaCasa.length, 2);
assert.ok(pelaCasa.every(e => e.token === "tok-casa-A"), "sai pela instância da casa");
assert.equal(db.prepare("SELECT COUNT(*) n FROM marketing_envios WHERE campanha_id = ? AND canal_id IS NOT NULL").get(camp5).n, 0);
const { emFluxoDeDisparo } = await import("../src/services/disparo.js");
assert.equal(emFluxoDeDisparo(orgA, "5587900000040"), true, "esperando resposta = no meio do fluxo (o robô fica quieto)");
// A resposta chega pelo webhook da CASA e continua o fluxo.
await fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-casa-A", message: { chatid: "5587900000040@s.whatsapp.net", fromMe: false,
    messageid: "in_casa_1", messageType: "conversation", text: "2", senderName: "Olga" } }) });
await new Promise(r => setTimeout(r, 300));
const olga = db.prepare("SELECT * FROM leads WHERE phone = '5587900000040'").get();
assert.ok(olga); assert.equal(olga.origem, "Disparo", "nasce com origem Disparo mesmo pela linha da casa");
assert.equal(olga.canal_id, null, "a conversa fica no número de atendimento");
assert.equal(exec(camp5, "5587900000040").no_atual, "m3");
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND from_name = 'Disparo · Pela casa'").get(olga.id).n, 2);

console.log("15. Casa na API oficial da Meta: sem número de contingência não dispara");
db.prepare("DELETE FROM canais WHERE org_id = ? AND tipo = 'imobiliaria'").run(orgB);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,wa_number,ativo,created_at,provider,phone_number_id)
  VALUES (?,?,'imobiliaria','',?,?,1,?,'meta','pn_1')`).run("c_" + randomUUID(), orgB, "tok-meta-B", "5587922223333", Date.now());
r = await chamar(tOutro, "/marketing/campanhas", "POST", { nome: "X", declaracao: true });
console.log(`   ${r.status} "${r.d.error}"`);
assert.equal(r.status, 409); assert.match(r.d.error, /API oficial/);

console.log("16. Enviar teste para mim: o começo do fluxo, sem virar disparo");
const antesTeste = envios.length;
r = await chamar(tGestora, `/marketing/fluxos/${fluxo}/teste`, "POST", { telefone: "(87) 90000-0099" });
console.log(`   ${r.status} ${JSON.stringify(r.d)}`);
assert.equal(r.status, 200); assert.equal(r.d.mensagens, 2); assert.equal(r.d.parou, "botões");
const doTeste = envios.slice(antesTeste);
assert.ok(doTeste.every(e => e.numero === "5587900000099"));
assert.ok(doTeste[0].texto.startsWith("Oi, Gestora!") && doTeste[0].texto.includes(RODAPE_SAIR));
assert.equal(db.prepare("SELECT COUNT(*) n FROM marketing_envios WHERE telefone = '5587900000099'").get().n, 0, "teste não entra em relatório nem no limite");
assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxo}/teste`, "POST", { telefone: "12" })).status, 400);
assert.equal((await chamar(tOutro, `/marketing/fluxos/${fluxo}/teste`, "POST", { telefone: "87900000099" })).status, 404);

/* ===== O DISPARO NOS RELATÓRIOS (27/09/2026) ===== */
const hojeISO = new Date().toISOString().slice(0, 10);
const depoisISO = new Date(Date.now() + 86400000 * 60).toISOString().slice(0, 10);
const janela = `de=${hojeISO}&ate=${depoisISO}`;

console.log("17. Lead que nasce do disparo entra em Operação → Campanhas, com o disparo e seus números");
const olgaAgora = db.prepare("SELECT * FROM leads WHERE phone = '5587900000040'").get();
assert.equal(olgaAgora.platform, "disparo"); assert.equal(olgaAgora.campaign_name, "Pela casa");
r = await chamar(tGestora, `/painel/campanhas?${janela}`);
const linhaCamp = r.d.campanhas.find(c => c.campanha === "Pela casa");
assert.ok(linhaCamp, "o lead aparece na linha do disparo, como a campanha do anúncio");
assert.equal(linhaCamp.leads, 1); assert.equal(linhaCamp.platform, "disparo");
const linhaDisp = r.d.disparos.find(d => d.nome === "Pela casa");
console.log(`   ${JSON.stringify(linhaDisp)}`);
const doMotor = (await chamar(tGestora, `/marketing/campanhas/${camp5}`)).d;
assert.equal(linhaDisp.alcancados, doMotor.pessoas_alcancadas, "o mesmo número do relatório do disparo");
assert.equal(linhaDisp.responderam, doMotor.responderam);
assert.equal(linhaDisp.leads_novos, 1);
// Filtrado por campanha, só aquele disparo; filtrado por pessoa, disparo é da casa e não entra.
assert.deepEqual((await chamar(tGestora, `/painel/campanhas?${janela}&campanha=${encodeURIComponent("Pela casa")}`)).d.disparos.map(d => d.nome), ["Pela casa"]);
assert.equal((await chamar(tGestora, `/painel/campanhas?${janela}&responsavel=${atendente}`)).d.disparos.length, 0);

console.log("18. Repassado a um corretor, o lead do disparo conta para os dois — e a venda aparece no disparo");
const corretor = pessoa(orgA, "Marcos", "corretor");
const dela = async () => (await chamar(tGestora, `/painel?periodo=mes&responsavel=${atendente}&origem=Disparo`)).d.atendimento.recebidos;
const delaAntes = await dela();
db.prepare("UPDATE users SET available = 1, available_desde = ? WHERE id = ?").run(Date.now(), corretor);   // prontidão marcada agora: o corte das 18h não a desliga
r = await chamar(tGestora, "/distribution/transfer", "POST", { lead_id: olgaAgora.id, user_id: corretor });
assert.equal(r.status, 200, JSON.stringify(r.d));
const rel = (await chamar(tGestora, "/reports?periodo=mes")).d;
const recebidosDo = (id) => (rel.atendentes.find(a => a.id === id) || {}).recebidos;
const operacaoDele = (await chamar(tGestora, `/painel?periodo=mes&responsavel=${corretor}&origem=Disparo`)).d;
console.log(`   relatórios: corretor ${recebidosDo(corretor)} · operação (origem Disparo): ${operacaoDele.atendimento.recebidos}`);
assert.equal(recebidosDo(corretor), 1); assert.equal(operacaoDele.atendimento.recebidos, 1);
assert.ok(delaAntes >= 1);
assert.equal(await dela(), delaAntes, "quem recebeu primeiro continua com o lead no relatório dela");
db.prepare("UPDATE leads SET sale_value = 300000, sale_date = ? WHERE id = ?").run(Date.now(), olgaAgora.id);
const comVenda = (await chamar(tGestora, `/painel/campanhas?${janela}`)).d;
assert.equal(comVenda.disparos.find(d => d.nome === "Pela casa").vendas, 1);
assert.equal(comVenda.disparos.find(d => d.nome === "Pela casa").vgv, 300000);

console.log("19. Eco do disparo pela casa antes do registro: não é gente respondendo");
const { marcarEnvio, desmarcarEnvio } = await import("../src/services/marca-disparo.js");
const antesL3 = db.prepare("SELECT first_resp_at, last_interaction_at FROM leads WHERE id = ?").get(L3);
marcarEnvio(orgA, "5587900000003", "Pela casa");
await fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-casa-A", message: { chatid: "5587900000003@s.whatsapp.net", fromMe: true,
    messageid: "eco_antes_1", messageType: "conversation", text: "Oi, Luan! Temos novidades." } }) });
await new Promise(r => setTimeout(r, 250));
desmarcarEnvio(orgA, "5587900000003");
const eco = db.prepare("SELECT from_name FROM messages WHERE wa_id = 'eco_antes_1'").get();
assert.equal(eco.from_name, "Disparo · Pela casa");
const depoisL3 = db.prepare("SELECT first_resp_at, last_interaction_at FROM leads WHERE id = ?").get(L3);
assert.equal(depoisL3.first_resp_at, antesL3.first_resp_at, "não carimba a primeira resposta");
assert.equal(depoisL3.last_interaction_at, antesL3.last_interaction_at, "não conta como interação no prazo da etapa");

console.log("20. A campanha não apaga a espera do cliente nem o prazo da etapa");
const LIA = novoLead("Lia Dantas", "5587900000077", false);
const perguntou = Date.now() - 3600000;
db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','Tem apartamento no centro?',?)`).run("m_" + randomUUID(), LIA, perguntou);
const esperando = async () => (await chamar(tGestora, "/painel/equipe?periodo=mes")).d.equipe.find(p => p.id === atendente).aguardando_resposta;
const antesEspera = await esperando();
db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at) VALUES (?,?,'out',NULL,'Disparo · Pela casa','Oi, Lia!',?)`)
  .run("m_" + randomUUID(), LIA, Date.now());
assert.equal(await esperando(), antesEspera, "ela continua esperando resposta de gente");
assert.equal(db.prepare("SELECT last_interaction_at FROM leads WHERE id = ?").get(LIA).last_interaction_at, perguntou);
const { temposDeResposta } = await import("../src/services/score.js");
assert.equal(temposDeResposta([LIA]).length, 0, "a campanha não conta como resposta à pergunta dela");

console.log("21. Quem escreve antes de receber qualquer coisa do disparo não conta como \"respondeu\"");
const lista5 = (await chamar(tGestora, "/marketing/listas", "POST", { nome: "Domingo", origem: "conversaram", coletado_em: ontem, declaracao: true,
  arquivo: csv(["nome;telefone", "Rui Lopes;87 90000-0060"]) })).d.lista;
r = await chamar(tGestora, "/marketing/campanhas", "POST", { nome: "Ainda não saiu", fluxo_id: fluxo, publico: { listas: [lista5.id] }, declaracao: true });
assert.equal(r.status, 201, JSON.stringify(r.d));
const camp7 = r.d.id;
await fetch(`${BASE}/webhooks/uazapi`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "tok-casa-A", message: { chatid: "5587900000060@s.whatsapp.net", fromMe: false,
    messageid: "in_antes_1", messageType: "conversation", text: "Oi, bom dia", senderName: "Rui" } }) });
await new Promise(r => setTimeout(r, 300));
const rel7 = (await chamar(tGestora, `/marketing/campanhas/${camp7}`)).d;
console.log(`   alcançados ${rel7.pessoas_alcancadas} · responderam ${rel7.responderam}`);
assert.equal(rel7.pessoas_alcancadas, 0); assert.equal(rel7.responderam, 0);
await chamar(tGestora, `/marketing/campanhas/${camp7}/cancelar`, "POST");

console.log("\nTudo certo ✅");
mock.close();
process.exit(0);
