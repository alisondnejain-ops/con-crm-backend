/* GATILHOS DOS FLUXOS (03/10/2026) — services/automacoes.js + o motor de
   services/disparo.js.

   Servidor no mesmo processo, relógio na mão do teste (`processarDisparos`)
   e uma Uazapi de mentira. O que se prova, nesta ordem:
   - o fluxo antigo continua "disparo em massa" e não liga sozinho;
   - o gatilho de formulário grava funil e catraca NO FORMULÁRIO (uma verdade
     só), e um formulário liga uma automação só;
   - o lead do formulário entra, recebe a mensagem pela linha dele, sem o
     rodapé do disparo, e os blocos de CRM (etiqueta, etapa, condição,
     tarefa) mexem nele de verdade;
   - a mensagem da automação não conta como contato de gente;
   - entra uma vez só; equipe assumindo para o fluxo; desligar fecha a porta;
   - lead novo (por origem), etapa e etiqueta disparam; mudança em massa não;
   - automação não aparece nem conta como disparo; contas não se misturam.

   Rodar:  npm run teste:gatilhos
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-gatilhos.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4805";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.UAZAPI_ACEITAR_POR_NUMERO = "";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// ===== UAZAPI DE MENTIRA =====
const DONO_DO_TOKEN = { "tok-casa-A": "5587911112222" };
const envios = [];
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => corpo += c);
  req.on("end", () => {
    const tk = req.headers.token;
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (!DONO_DO_TOKEN[tk]) return json(401, { error: "token inválido" });
    if (req.url.startsWith("/send/")) {
      const d = corpo ? JSON.parse(corpo) : {};
      const id = "wa_" + Math.random().toString(36).slice(2);
      envios.push({ token: tk, rota: req.url, numero: d.number, texto: d.text || "", id });
      return json(200, { messageid: id });
    }
    json(200, { instance: { status: "connected", owner: DONO_DO_TOKEN[tk] }, status: { connected: true, loggedIn: true } });
  });
});
await new Promise(r => mock.listen(4806, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarDisparos } = await import("../src/services/disparo.js");
const { receberLead } = await import("../src/services/portais.js");
const { moverEtapa } = await import("../src/services/etapas.js");
const P = await import("../src/services/pipelines.js");
const C = await import("../src/services/catracas.js");
const BASE = "http://localhost:4805";
const MOCK = "http://127.0.0.1:4806";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "GT-" + id.slice(4), Date.now(), "");
  P.garantirPipelinePadrao(id);
  return id; };
let ordem = 0;
const pessoa = (org, nome, role, extra = {}) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@gt.com", senha, role, Date.now() + (++ordem), extra.master ? 1 : 0);
  return id; };

const casaConHub = novaOrg("ConHub");
pessoa(casaConHub, "Ali", "adm", { master: true });
const orgA = novaOrg("Imobiliária A");
const gestora = pessoa(orgA, "Gestora", "adm");
const atendente = pessoa(orgA, "Vanessa", "sdr");
const marina = pessoa(orgA, "Marina", "corretor");
const rafael = pessoa(orgA, "Rafael", "corretor");
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ?, wa_number = ? WHERE id = ?").run(MOCK, "tok-casa-A", "5587911112222", orgA);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,wa_number,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,?,1,?)`)
  .run("c_" + randomUUID(), orgA, MOCK, "tok-casa-A", "5587911112222", Date.now());
const orgB = novaOrg("Imobiliária B");
pessoa(orgB, "OutroGestor", "adm");

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@gt.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login ${nome}: ${JSON.stringify(d)}`); return d.token;
}
const chamar = async (token, caminho, metodo = "GET", corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const tGestora = await entrar("Gestora"), tAli = await entrar("Ali"), tOutro = await entrar("OutroGestor");
await chamar(tAli, `/orgs/${orgA}/marketing`, "POST", { liberado: true });
await chamar(tAli, `/orgs/${orgB}/marketing`, "POST", { liberado: true });
assert.equal((await chamar(tGestora, "/marketing/termo", "POST", { aceito: true })).status, 200);
assert.equal((await chamar(tOutro, "/marketing/termo", "POST", { aceito: true })).status, 200);

const tag = "t_" + randomUUID(), tagVip = "t_" + randomUUID();
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tag, orgA, "Formulário", "#0E8F6E", Date.now());
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tagVip, orgA, "VIP", "#2F80C4", Date.now());
const comercial = P.funilComercial(orgA);
const etapas = P.etapasDoPipeline(orgA, comercial.id);
const loc = P.criarDoTemplate(orgA, "locacao", { name: "Locação" }).pipeline;
const etapasLoc = P.etapasDoPipeline(orgA, loc.id);
const catAluguel = C.criar(orgA, gestora, { nome: "Aluguel", entrega: "atendente", membros: [marina, rafael] });

let agora = Date.now();
const tique = async (segundos = 0) => { agora += segundos * 1000; await processarDisparos({ agora }); };
const execsDe = (fluxoId) => {
  const camp = db.prepare("SELECT automacao_id FROM marketing_fluxos WHERE id = ?").get(fluxoId).automacao_id;
  return camp ? db.prepare("SELECT * FROM marketing_execucoes WHERE campanha_id = ? ORDER BY criado_em").all(camp) : [];
};
let tel = 0;
const chegaFormulario = (formId, nome = "Cliente") => {
  const t = "55879910" + String(++tel).padStart(5, "0");
  const r = receberLead(orgA, { portal: "Meta Ads", externo: "LD" + tel, nome, telefone: t, formulario: true,
    respostas: {}, qual: {}, anuncio: { platform: "fb", form_id: formId, form_name: "Aluguel Centro", campaign_name: "C1" } });
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(r.lead_id);
};
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

try {
  caso("Fluxo novo é “disparo em massa”: não liga sozinho e diz por quê");
  let r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Boas-vindas aluguel" });
  assert.equal(r.status, 201);
  const fluxo = r.d.id;
  r = await chamar(tGestora, "/marketing/fluxos");
  assert.equal(r.d.fluxos.find(f => f.id === fluxo).gatilho.tipo, "manual");
  assert.equal(r.d.fluxos.find(f => f.id === fluxo).ativo, false);
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}/ativar`, "POST", { ativo: true });
  assert.equal(r.status, 422);
  assert.match(r.d.error, /gatilho/i);

  caso("Gatilho de formulário: funil e catraca vão para o FORMULÁRIO, e o fluxo guarda só qual é");
  const grafo = {
    nos: [
      { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho: { tipo: "formulario", form_id: "F1", form_nome: "Aluguel Centro",
        pipeline_id: loc.id, stage_id: etapasLoc[1].id, catraca_id: catAluguel } } },
      { id: "m1", tipo: "mensagem", x: 300, y: 0, dados: { texto: "Oi, {nome}! Recebemos seu pedido." } },
      { id: "a1", tipo: "add_tag", x: 600, y: 0, dados: { tag_id: tag } },
      { id: "a2", tipo: "mover_etapa", x: 900, y: 0, dados: { etapa_id: etapasLoc[2].id } },
      { id: "c1", tipo: "condicao", x: 1200, y: 0, dados: { regra: "tag", valor: tag } },
      { id: "a3", tipo: "tarefa", x: 1500, y: -80, dados: { titulo: "Ligar para o cliente do aluguel", em_horas: 2 } },
      { id: "a4", tipo: "add_tag", x: 1500, y: 80, dados: { tag_id: tagVip } },
    ],
    ligacoes: [
      { de: "inicio", saida: "proximo", para: "m1" }, { de: "m1", saida: "proximo", para: "a1" },
      { de: "a1", saida: "proximo", para: "a2" }, { de: "a2", saida: "proximo", para: "c1" },
      { de: "c1", saida: "sim", para: "a3" }, { de: "c1", saida: "nao", para: "a4" },
    ],
  };
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const fm = db.prepare("SELECT pipeline_id, stage_id FROM meta_formularios WHERE org_id = ? AND form_id = 'F1'").get(orgA);
  assert.deepEqual(fm, { pipeline_id: loc.id, stage_id: etapasLoc[1].id });
  // A catraca vai para a própria catraca (canais de aquisição), aceitando o formato antigo de uma só.
  assert.deepEqual(C.catracasDoFormulario(orgA, "F1"), [catAluguel]);
  const salvo = JSON.parse(db.prepare("SELECT grafo FROM marketing_fluxos WHERE id = ?").get(fluxo).grafo);
  assert.equal(salvo.nos[0].dados.carona, undefined);
  assert.equal(salvo.nos[0].dados.gatilho.pipeline_id, undefined);
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`);
  assert.deepEqual(r.d.grafo.nos[0].dados.gatilho.catraca_ids, [catAluguel], "a leitura traz o funil e as catracas do formulário");
  assert.deepEqual(r.d.avisos, []);
  // Várias catracas por formulário: a lista que a tela manda substitui a de antes.
  const comLista = (ids) => ({ ...r.d.grafo, nos: r.d.grafo.nos.map(x => x.id === "inicio"
    ? { ...x, dados: { gatilho: { ...x.dados.gatilho, catraca_ids: ids } } } : x) });
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo: comLista([]) })).status, 200);
  assert.deepEqual(C.catracasDoFormulario(orgA, "F1"), []);
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo: comLista([catAluguel]) })).status, 200);
  assert.deepEqual(C.catracasDoFormulario(orgA, "F1"), [catAluguel]);

  caso("Ligar; um segundo fluxo no mesmo formulário é recusado");
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}/ativar`, "POST", { ativo: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.ativo, true);
  r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Outro do F1" });
  const fluxo2 = r.d.id;
  await chamar(tGestora, `/marketing/fluxos/${fluxo2}`, "PUT", { grafo: { ...grafo, nos: grafo.nos.map(x => x.id === "inicio"
    ? { ...x, dados: { gatilho: { tipo: "formulario", form_id: "F1" } } } : x) } });
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo2}/ativar`, "POST", { ativo: true });
  assert.equal(r.status, 409);

  caso("O lead do formulário nasce no funil e na catraca escolhidos e entra na automação");
  envios.length = 0;
  const l1 = chegaFormulario("F1", "Ana Paula");
  assert.equal(l1.pipeline_id, loc.id);
  assert.equal(l1.catraca_id, catAluguel);
  assert.equal(execsDe(fluxo).length, 1);
  chegaFormulario("F9", "Outra campanha");
  assert.equal(execsDe(fluxo).length, 1, "outro formulário não entra");

  caso("A mensagem sai pela linha do lead, sem o rodapé do disparo; os blocos de CRM mexem no lead");
  await tique(1);
  assert.equal(envios.length, 1);
  assert.equal(envios[0].token, "tok-casa-A");
  assert.match(envios[0].texto, /Oi, Ana! Recebemos/);
  assert.doesNotMatch(envios[0].texto, /SAIR/);
  const depois = db.prepare("SELECT * FROM leads WHERE id = ?").get(l1.id);
  assert.equal(depois.stage_id, etapasLoc[2].id, "moveu de etapa");
  assert.ok(db.prepare("SELECT 1 FROM lead_tags WHERE lead_id = ? AND tag_id = ?").get(l1.id, tag), "colocou a etiqueta");
  assert.ok(!db.prepare("SELECT 1 FROM lead_tags WHERE lead_id = ? AND tag_id = ?").get(l1.id, tagVip), "a condição foi pelo sim");
  const tarefa = db.prepare("SELECT * FROM tarefas WHERE lead_id = ?").get(l1.id);
  assert.equal(tarefa.titulo, "Ligar para o cliente do aluguel");
  assert.equal(tarefa.user_id, depois.assigned_to, "a tarefa é de quem está com o lead");
  assert.equal(execsDe(fluxo)[0].estado, "concluida");

  caso("A mensagem entra na conversa como “Automação ·” e não tira o lead de “pediu contato”");
  const msg = db.prepare("SELECT from_name, from_user_id FROM messages WHERE lead_id = ? AND direction = 'out'").get(l1.id);
  assert.equal(msg.from_name, "Automação · Boas-vindas aluguel");
  assert.equal(msg.from_user_id, null);
  r = await chamar(tGestora, `/leads/${l1.id}`);
  assert.equal(r.d.aguarda_contato, 1);
  assert.equal(db.prepare("SELECT first_resp_at FROM leads WHERE id = ?").get(l1.id).first_resp_at, null);

  caso("Os números e o histórico aparecem no fluxo");
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`);
  assert.equal(r.d.automacao.entraram, 1);
  assert.equal(r.d.automacao.concluidas, 1);
  assert.equal(r.d.automacao.por_bloco.a2.enviados, 1);
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}/logs`);
  assert.equal(r.d.execucoes[0].nome, "Ana Paula");
  assert.ok(r.d.execucoes[0].passos.some(p => /movido para/.test(p.texto)));

  caso("O mesmo lead preenche de novo: não entra outra vez (padrão)");
  receberLead(orgA, { portal: "Meta Ads", externo: "LD-repete", nome: "Ana Paula", telefone: l1.phone, formulario: true,
    respostas: {}, qual: {}, anuncio: { form_id: "F1" } });
  assert.equal(execsDe(fluxo).length, 1);

  caso("Automação não aparece entre os disparos nem conta no limite do dia");
  r = await chamar(tGestora, "/marketing/campanhas");
  assert.equal(r.d.campanhas.length, 0);

  caso("Salvar com algo faltando não derruba a automação: ela segue na versão completa");
  const quebrado = { ...grafo, nos: grafo.nos.map(x => x.id === "m1" ? { ...x, dados: { texto: "" } } : x) };
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo: quebrado });
  assert.equal(r.status, 200);
  assert.equal(r.d.automacao_desatualizada, true);
  const versao = JSON.parse(db.prepare("SELECT c.grafo FROM marketing_campanhas c JOIN marketing_fluxos f ON f.automacao_id = c.id WHERE f.id = ?").get(fluxo).grafo);
  assert.match(versao.nos.find(x => x.id === "m1").dados.texto, /Recebemos/);
  r = await chamar(tGestora, `/marketing/fluxos/${fluxo}`, "PUT", { grafo });
  assert.equal(r.d.automacao_desatualizada, false);

  caso("A equipe escreveu antes da mensagem: o fluxo para");
  const espera = { nos: [
    { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho: { tipo: "lead_novo", origens: ["manual"] } } },
    { id: "e1", tipo: "espera", x: 300, y: 0, dados: { quantidade: 10, unidade: "minutos" } },
    { id: "m1", tipo: "mensagem", x: 600, y: 0, dados: { texto: "Ainda tem interesse, {nome}?" } },
  ], ligacoes: [{ de: "inicio", saida: "proximo", para: "e1" }, { de: "e1", saida: "proximo", para: "m1" }] };
  r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Lead manual" });
  const fluxoManual = r.d.id;
  await chamar(tGestora, `/marketing/fluxos/${fluxoManual}`, "PUT", { grafo: espera });
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxoManual}/ativar`, "POST", {})).status, 200);
  r = await chamar(tGestora, "/leads", "POST", { nome: "Carlos Lima", telefone: "87 99123-0001", assigned_to: marina });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.d));
  const lManual = r.d.id;
  assert.equal(execsDe(fluxoManual).length, 1, "lead cadastrado na mão entrou");
  await tique(1);
  db.prepare("INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at) VALUES (?,?,'out',?,?,?,?)")
    .run("m_" + randomUUID(), lManual, marina, "Marina", "Oi Carlos!", agora + 1000);
  envios.length = 0;
  await tique(11 * 60);
  assert.equal(envios.length, 0);
  assert.equal(execsDe(fluxoManual)[0].estado, "assumida");

  caso("Lead novo filtra pela origem: o do formulário não entra no fluxo de “cadastro na mão”");
  chegaFormulario("F9", "Bruno");
  assert.equal(execsDe(fluxoManual).length, 1);

  caso("Gatilho de etapa: mover pela tela dispara; mudança em massa não");
  r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Entrou em Visita" });
  const fluxoEtapa = r.d.id;
  const visita = etapas.find(e => /visita/i.test(e.name)) || etapas[3];
  await chamar(tGestora, `/marketing/fluxos/${fluxoEtapa}`, "PUT", { grafo: { nos: [
    { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho: { tipo: "etapa", etapa_id: visita.id } } },
    { id: "m1", tipo: "mensagem", x: 300, y: 0, dados: { texto: "Confirmando sua visita, {nome}!" } },
  ], ligacoes: [{ de: "inicio", saida: "proximo", para: "m1" }] } });
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxoEtapa}/ativar`, "POST", {})).status, 200);
  r = await chamar(tGestora, `/leads/${lManual}/stage`, "PATCH", { stage: visita.name, stage_id: visita.id });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(execsDe(fluxoEtapa).length, 1);
  const outro = chegaFormulario("F9", "Daniel");
  moverEtapa({ leadId: outro.id, paraEtapaId: visita.id, motivo: "mao", gatilhos: false });
  assert.equal(execsDe(fluxoEtapa).length, 1, "mudança em massa não dispara");

  caso("Gatilho de etiqueta: marcar dispara; marcar de novo não");
  r = await chamar(tGestora, "/marketing/fluxos", "POST", { nome: "Virou VIP" });
  const fluxoTag = r.d.id;
  await chamar(tGestora, `/marketing/fluxos/${fluxoTag}`, "PUT", { grafo: { nos: [
    { id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho: { tipo: "etiqueta", tag_id: tagVip } } },
    { id: "a1", tipo: "atribuir", x: 300, y: 0, dados: { modo: "pessoa", user_id: rafael } },
  ], ligacoes: [{ de: "inicio", saida: "proximo", para: "a1" }] } });
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxoTag}/ativar`, "POST", {})).status, 200);
  r = await chamar(tGestora, `/leads/${outro.id}/tags/${tagVip}`, "POST");
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.d));
  await chamar(tGestora, `/leads/${outro.id}/tags/${tagVip}`, "POST");
  assert.equal(execsDe(fluxoTag).length, 1);
  await tique(1);
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(outro.id).assigned_to, rafael, "o bloco Atribuir entregou ao Rafael");

  caso("Desligar fecha a porta: lead novo não entra");
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxo}/ativar`, "POST", { ativo: false })).status, 200);
  chegaFormulario("F1", "Elisa");
  assert.equal(execsDe(fluxo).length, 1);
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxo}/ativar`, "POST", { ativo: true })).status, 200);

  caso("Quem pediu para sair não entra");
  const bloqueado = "5587990009999";
  db.prepare("INSERT INTO marketing_bloqueio (org_id,telefone,motivo,criado_em) VALUES (?,?,?,?)").run(orgA, bloqueado, "SAIR", Date.now());
  receberLead(orgA, { portal: "Meta Ads", externo: "LD-bloq", nome: "Bloqueado", telefone: bloqueado, formulario: true,
    respostas: {}, qual: {}, anuncio: { form_id: "F1" } });
  assert.equal(execsDe(fluxo).length, 1);

  caso("Outra imobiliária não lê nem liga o fluxo desta");
  assert.equal((await chamar(tOutro, `/marketing/fluxos/${fluxo}`)).status, 404);
  assert.equal((await chamar(tOutro, `/marketing/fluxos/${fluxo}/ativar`, "POST", {})).status, 404);
  assert.equal((await chamar(tOutro, `/marketing/fluxos/${fluxo}/logs`)).status, 404);

  caso("Apagar o fluxo para quem estava no meio");
  r = await chamar(tGestora, "/leads", "POST", { nome: "Fernanda Reis", telefone: "87 99123-0002", assigned_to: marina });
  assert.equal(execsDe(fluxoManual).filter(e => e.estado === "ativa").length, 1);
  assert.equal((await chamar(tGestora, `/marketing/fluxos/${fluxoManual}`, "DELETE")).status, 200);
  assert.equal(execsDe(fluxoManual).filter(e => e.estado === "ativa").length, 0);

  console.log(`\nOK — ${n} casos.`);
  process.exit(0);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  process.exit(1);
}
