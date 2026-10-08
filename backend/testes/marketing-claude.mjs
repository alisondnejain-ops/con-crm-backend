/* O ACESSO COMPLETO DO CLAUDE DO GESTOR AO MARKETING (08/10/2026).

   Servidor de pé, Uazapi de mentira e a IA de mentira (só para o
   Autoatendimento). As ferramentas do Claude são chamadas pelo próprio
   executor, com o crachá de quem conversa — passam pelas mesmas rotas da
   tela. O que se prova:
   - a regra da etapa entrega pela catraca escolhida, põe e tira etiquetas e
     cria a etiqueta com o nome do corretor; recusa catraca de outra conta;
   - editar a regra pelo Claude MESCLA (pedir uma etiqueta não apaga a roleta);
   - gatilho "campo preenchido com valor", condição de campo e "respondeu";
   - "parar o fluxo quando o cliente responder";
   - modelo da Meta numa linha da Uazapi sai como texto já preenchido;
   - Autoatendimento: fora do escopo não fala; com ficha de produto, campos,
     resumo e etapa final, a IA preenche, escreve e move;
   - o corretor não consegue usar as ferramentas (a rota recusa).

   Rodar:  npm run teste:marketing-claude
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-marketing-claude.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4811";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
process.env.META_GRAPH_URL = "http://127.0.0.1:4812/meta";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// A IA do Autoatendimento, de mentira.
const real = globalThis.fetch;
let respostaDaIA = { texto: "Oi!", coletado: {}, encerrar: false };
let ultimoPedidoIA = "";
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.anthropic.com")) {
    ultimoPedidoIA = String(opts?.body || "");
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(respostaDaIA) }], usage: { input_tokens: 10, output_tokens: 5 } }) };
  }
  return real(url, opts);
};

const envios = [], enviosMeta = [];
const mock = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (req.url.startsWith("/meta/")) {
      if (req.url.includes("/message_templates")) return json(200, { data: [
        { name: "boas_vindas", language: "pt_BR", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Olá {{1}}, tudo bem?" }] },
        { name: "rascunho", language: "pt_BR", status: "PENDING", components: [] }] });
      if (req.url.endsWith("/messages")) { enviosMeta.push(JSON.parse(corpo)); return json(200, { messages: [{ id: "wamid.1" }] }); }
      return json(404, {});
    }
    if (req.url.startsWith("/send/")) {
      const d = corpo ? JSON.parse(corpo) : {};
      envios.push({ numero: d.number, texto: d.text || "" });
      return json(200, { messageid: "wa_" + Math.random().toString(36).slice(2) });
    }
    json(200, { instance: { status: "connected" }, status: { connected: true } });
  });
});
await new Promise(r => mock.listen(4812, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarDisparos, mensagemRecebida } = await import("../src/services/disparo.js");
const P = await import("../src/services/pipelines.js");
const C = await import("../src/services/catracas.js");
const { atender, podeAtender } = await import("../src/services/robo.js");
const { executorDeConfig, FERRAMENTAS_CONSULTA } = await import("../src/services/assistente.js");
const BASE = "http://localhost:4811", MOCK = "http://127.0.0.1:4812";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const novaOrg = (nome) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(id, nome, "MC-" + id.slice(4), Date.now(), "");
  P.garantirPipelinePadrao(id); return id; };
let ordem = 0;
const pessoa = (org, nome, role, extra = {}) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,?,?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@mc.com", senha, role, Date.now() + (++ordem), extra.master ? 1 : 0);
  return id; };

const casaConHub = novaOrg("ConHub");
pessoa(casaConHub, "Ali", "adm", { master: true });
const orgA = novaOrg("Imobiliária A");
const gestora = pessoa(orgA, "Gestora", "adm");
pessoa(orgA, "Vanessa", "sdr");
const marina = pessoa(orgA, "Marina Souza", "corretor");
const rafael = pessoa(orgA, "Rafael", "corretor");
db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ?, wa_number = ? WHERE id = ?").run(MOCK, "tok-A", "5587911112222", orgA);
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,wa_number,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,?,1,?)`)
  .run("c_" + randomUUID(), orgA, MOCK, "tok-A", "5587911112222", Date.now());
const orgB = novaOrg("Imobiliária B");
pessoa(orgB, "OutroGestor", "adm");

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login ${email}: ${JSON.stringify(d)}`); return d.token;
}
const chamar = async (token, caminho, metodo = "GET", corpo) => {
  const r = await fetch(BASE + caminho, { method: metodo, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const tGestora = await entrar("gestora@mc.com"), tAli = await entrar("ali@mc.com"), tMarina = await entrar("marina souza@mc.com").catch(() => null);
await chamar(tAli, `/orgs/${orgA}/marketing`, "POST", { liberado: true });
assert.equal((await chamar(tGestora, "/marketing/termo", "POST", { aceito: true })).status, 200);

const userGestora = db.prepare("SELECT * FROM users WHERE id = ?").get(gestora);
const claude = executorDeConfig({ autorizacao: "Bearer " + tGestora, user: userGestora, conversaId: null, menu: [] });
const usar = async (nome, entrada) => { const r = await claude(nome, entrada, {}); return r; };

const novaTag = (org, nome) => { const id = "t_" + randomUUID();
  db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(id, org, nome, "#0E8F6E", Date.now()); return id; };
const tagNovo = novaTag(orgA, "Novo"), tagVip = novaTag(orgA, "VIP"), tagA = novaTag(orgA, "Gatilho A"), tagB = novaTag(orgA, "Gatilho B"), tagC = novaTag(orgA, "Gatilho C");
const tagRespondeu = novaTag(orgA, "Respondeu");
const comercial = P.funilComercial(orgA);
const etapas = P.etapasDoPipeline(orgA, comercial.id);
const catAluguel = C.criar(orgA, gestora, { nome: "Aluguel", entrega: "atendente", membros: [marina, rafael] });
const catDeB = C.criar(orgB, null, { nome: "Outra", entrega: "atendente", membros: [] });

let n = 0;
const lead = (extra = {}) => { const id = "l_" + randomUUID(); n++;
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,pipeline_id,stage_id,created_at,assigned_to,form_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, orgA, extra.nome || `Cliente ${n}`, "55879" + String(80000000 + n).padStart(8, "0"),
    (extra.etapa || etapas[0]).name, comercial.id, (extra.etapa || etapas[0]).id, Date.now(), extra.dono || null, extra.form_id || null);
  return id; };
const tagsDe = (leadId) => db.prepare("SELECT t.nome FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = ?").all(leadId).map(t => t.nome);
let agora = Date.now();
const tique = async (seg = 0) => { agora += seg * 1000; await processarDisparos({ agora }); };
let passou = 0;
const caso = async (titulo, fn) => { await fn(); passou++; console.log("✓", titulo); };

// ===== 1. A REGRA DA ETAPA =====
const etapaAluguel = etapas[2];
await caso("1. etapa entrega pela catraca escolhida, põe/tira etiquetas e cria a do corretor", async () => {
  const r = await chamar(tGestora, `/pipelines/etapas/${etapaAluguel.id}`, "PATCH", { automation_config:
    { distribuir: "catraca", catraca_id: catAluguel, adicionar_tags: [tagVip], remover_tags: [tagNovo], tag_do_corretor: true } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const l = lead();
  db.prepare("INSERT INTO lead_tags (lead_id,tag_id,org_id,marcada_em) VALUES (?,?,?,?)").run(l, tagNovo, orgA, Date.now());
  const m = await chamar(tGestora, `/leads/${l}/stage`, "PATCH", { stage_id: etapaAluguel.id });
  assert.equal(m.status, 200, JSON.stringify(m.d));
  const dep = db.prepare("SELECT assigned_to, catraca_id FROM leads WHERE id = ?").get(l);
  assert.ok([marina, rafael].includes(dep.assigned_to), "foi para alguém da catraca");
  assert.equal(dep.catraca_id, catAluguel);
  const nomeDono = db.prepare("SELECT name FROM users WHERE id = ?").get(dep.assigned_to).name;
  const t = tagsDe(l);
  assert.ok(t.includes("VIP") && !t.includes("Novo") && t.includes(nomeDono), JSON.stringify(t));
});
await caso("1b. catraca de outra conta e a mesma etiqueta nas duas listas são recusadas", async () => {
  const a = await chamar(tGestora, `/pipelines/etapas/${etapaAluguel.id}`, "PATCH", { automation_config: { distribuir: "catraca", catraca_id: catDeB } });
  assert.equal(a.status, 400);
  const b = await chamar(tGestora, `/pipelines/etapas/${etapaAluguel.id}`, "PATCH", { automation_config: { adicionar_tags: [tagVip], remover_tags: [tagVip] } });
  assert.equal(b.status, 400);
});
await caso("1c. editar a regra pelo Claude mescla: pedir etiqueta não apaga a catraca", async () => {
  const r = await usar("editar_etapa", { etapa_id: etapaAluguel.id, ao_chegar: { colocar_etiquetas: [tagVip, tagRespondeu] } });
  assert.ok(!r.erro, r.erro);
  const cfg = JSON.parse(db.prepare("SELECT automation_config FROM pipeline_stages WHERE id = ?").get(etapaAluguel.id).automation_config);
  assert.equal(cfg.distribuir, "catraca"); assert.equal(cfg.catraca_id, catAluguel);
  assert.deepEqual(cfg.adicionar_tags, [tagVip, tagRespondeu]); assert.ok(cfg.tag_do_corretor);
});

// ===== 2. CAMPO PREENCHIDO =====
assert.equal((await chamar(tGestora, "/pipelines/campos", "POST", { name: "Produto", type: "select", options: ["Jardins", "Vila Nova"] })).status < 300, true);
const chaveProduto = db.prepare("SELECT key FROM custom_fields WHERE org_id = ? AND name = 'Produto'").get(orgA).key;
let fluxoCampo;
await caso("2. Claude cria fluxo com gatilho de campo e condição de campo, e liga", async () => {
  const r = await usar("salvar_fluxo", { nome: "Jardins", gatilho: { tipo: "campo", campo: chaveProduto, valor: "jardins" },
    blocos: [{ id: "b1", tipo: "mensagem", dados: { texto: "Oi {nome}, sobre o Jardins" } },
      { id: "b2", tipo: "condicao", dados: { regra: "campo", campo: chaveProduto, valor: "Jardins" } },
      { id: "b3", tipo: "add_tag", dados: { tag_id: tagVip } }],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "b1" }, { de: "b1", saida: "proximo", para: "b2" }, { de: "b2", saida: "sim", para: "b3" }] });
  assert.ok(!r.erro, r.erro);
  fluxoCampo = r.dados.fluxo_id;
  assert.deepEqual(r.dados.falta_para_ligar, []);
  const l = await usar("ligar_fluxo", { fluxo_id: fluxoCampo, ativo: true });
  assert.ok(!l.erro, l.erro);
  const v = await usar("ver_fluxos", {});
  assert.ok(v.dados.fluxos.some(f => f.id === fluxoCampo && f.ligado && f.gatilho.tipo === "campo"));
});
await caso("2b. outro valor não entra; o valor do gatilho entra, manda e a condição dá sim", async () => {
  const l = lead({ nome: "Joana Prado" });
  assert.equal((await chamar(tGestora, `/leads/${l}/campos`, "PATCH", { [chaveProduto]: "Vila Nova" })).status, 200);
  const camp = db.prepare("SELECT automacao_id FROM marketing_fluxos WHERE id = ?").get(fluxoCampo).automacao_id;
  const execs = () => db.prepare("SELECT * FROM marketing_execucoes WHERE campanha_id = ? AND lead_id = ?").all(camp, l);
  assert.equal(execs().length, 0);
  assert.equal((await chamar(tGestora, `/leads/${l}/campos`, "PATCH", { [chaveProduto]: "Jardins" })).status, 200);
  assert.equal(execs().length, 1);
  const antes = envios.length;
  await tique(1);
  assert.ok(envios.slice(antes).some(x => x.texto.includes("Oi Joana, sobre o Jardins")), JSON.stringify(envios.slice(antes)));
  assert.ok(tagsDe(l).includes("VIP"));
});

// ===== 3. PARAR QUANDO RESPONDER, E A CONDIÇÃO "RESPONDEU" =====
await caso("3. parar ao responder: a segunda mensagem não sai depois que o cliente responde", async () => {
  const r = await usar("salvar_fluxo", { nome: "Follow-up", gatilho: { tipo: "etiqueta", tag_id: tagA, parar_ao_responder: true },
    blocos: [{ id: "b1", tipo: "mensagem", dados: { texto: "primeira mensagem" } }, { id: "b2", tipo: "espera", dados: { quantidade: 1, unidade: "horas" } },
      { id: "b3", tipo: "mensagem", dados: { texto: "segunda mensagem" } }],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "b1" }, { de: "b1", saida: "proximo", para: "b2" }, { de: "b2", saida: "proximo", para: "b3" }] });
  assert.ok(!r.erro, r.erro);
  assert.ok(!(await usar("ligar_fluxo", { fluxo_id: r.dados.fluxo_id, ativo: true })).erro);
  const l = lead();
  assert.equal((await chamar(tGestora, `/leads/${l}/tags/${tagA}`, "POST")).status, 200);
  await tique(1);
  assert.ok(envios.some(x => x.texto === "primeira mensagem"));
  const ld = db.prepare("SELECT * FROM leads WHERE id = ?").get(l);
  mensagemRecebida({ orgId: orgA, lead: ld, texto: "oi, pode me ligar?" });
  const camp = db.prepare("SELECT automacao_id FROM marketing_fluxos WHERE id = ?").get(r.dados.fluxo_id).automacao_id;
  const e = db.prepare("SELECT estado, fim_motivo FROM marketing_execucoes WHERE campanha_id = ? AND lead_id = ?").get(camp, l);
  assert.equal(e.estado, "concluida"); assert.equal(e.fim_motivo, "o cliente respondeu");
  await tique(7200);
  assert.ok(!envios.some(x => x.texto === "segunda mensagem"));
});
await caso("3b. condição \"o cliente respondeu\"", async () => {
  const r = await usar("salvar_fluxo", { nome: "Respondeu?", gatilho: { tipo: "etiqueta", tag_id: tagB },
    blocos: [{ id: "b1", tipo: "mensagem", dados: { texto: "tudo bem?" } }, { id: "b2", tipo: "espera", dados: { quantidade: 1, unidade: "horas" } },
      { id: "b3", tipo: "condicao", dados: { regra: "respondeu" } }, { id: "b4", tipo: "add_tag", dados: { tag_id: tagRespondeu } }],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "b1" }, { de: "b1", saida: "proximo", para: "b2" },
      { de: "b2", saida: "proximo", para: "b3" }, { de: "b3", saida: "sim", para: "b4" }] });
  assert.ok(!r.erro, r.erro);
  assert.ok(!(await usar("ligar_fluxo", { fluxo_id: r.dados.fluxo_id, ativo: true })).erro);
  const quieto = lead(), falou = lead();
  for (const l of [quieto, falou]) assert.equal((await chamar(tGestora, `/leads/${l}/tags/${tagB}`, "POST")).status, 200);
  await tique(1);
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','sim!',?)").run("m_" + randomUUID(), falou, agora + 1000);
  await tique(3700);
  assert.ok(tagsDe(falou).includes("Respondeu")); assert.ok(!tagsDe(quieto).includes("Respondeu"));
});

// ===== 4. MODELO DA META =====
await caso("4. modelo da Meta numa linha da Uazapi sai como texto preenchido; sem API oficial a lista vem com o motivo", async () => {
  const m = await usar("ver_modelos_meta", {});
  assert.deepEqual(m.dados.modelos, []); assert.ok(/API oficial/.test(m.dados.aviso));
  const r = await usar("salvar_fluxo", { nome: "Modelo", gatilho: { tipo: "etiqueta", tag_id: tagC },
    blocos: [{ id: "b1", tipo: "mensagem", dados: { modelo: { nome: "boas_vindas", idioma: "pt_BR", texto: "Olá {{1}}, tudo bem?", variaveis: ["{nome}"] } } }],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "b1" }] });
  assert.ok(!r.erro, r.erro);
  assert.ok(!(await usar("ligar_fluxo", { fluxo_id: r.dados.fluxo_id, ativo: true })).erro);
  const l = lead({ nome: "Carla Mendes" });
  await chamar(tGestora, `/leads/${l}/tags/${tagC}`, "POST");
  await tique(1);
  assert.ok(envios.some(x => x.texto === "Olá Carla, tudo bem?"), JSON.stringify(envios.slice(-3)));
});

await caso("4b. pela API oficial: a lista traz só os aprovados e o modelo sai como template", async () => {
  const canalMeta = "c_meta";
  db.prepare(`INSERT INTO canais (id,org_id,tipo,provider,token,phone_number_id,waba_id,wa_number,ativo,created_at,user_id)
    VALUES (?,?,'corretor','meta','tok-meta','pn_1','waba_1','5587933334444',1,?,?)`).run(canalMeta, orgA, Date.now(), marina);
  const m = await usar("ver_modelos_meta", {});
  assert.deepEqual(m.dados.modelos.map(x => x.nome), ["boas_vindas"]);
  assert.equal(m.dados.modelos[0].variaveis, 1);
  const l = lead({ nome: "Diego Alves" });
  db.prepare("UPDATE leads SET canal_id = ? WHERE id = ?").run(canalMeta, l);
  await chamar(tGestora, `/leads/${l}/tags/${tagC}`, "POST");
  await tique(1);
  const t = enviosMeta.find(x => x.type === "template");
  assert.ok(t, JSON.stringify(enviosMeta));
  assert.equal(t.template.name, "boas_vindas");
  assert.equal(t.template.components[0].parameters[0].text, "Diego");
  db.prepare("DELETE FROM canais WHERE id = ?").run(canalMeta);
});

// ===== 5. CATRACA, FORMULÁRIO, FICHA E AUTOATENDIMENTO PELO CLAUDE =====
let ficha;
await caso("5. ficha de produto, catraca e formulário configurados pelo Claude", async () => {
  db.prepare(`INSERT INTO produtos (id,org_id,tipo,finalidade,titulo,bairro,cidade,quartos,valor,observacoes,construtor,status,created_at,descricao)
    VALUES (?,?,'casa','venda','Residencial Jardins','Jardins','Petrolina',2,250000,'dono aceita 10% abaixo','Construtora X','ativo',?,?)`)
    .run("p_jard", orgA, Date.now(), "Casas com quintal e área de lazer.");
  const im = await usar("ver_imoveis", { busca: "Jardins" });
  assert.equal(im.dados.imoveis[0].id, "p_jard");
  const f = await usar("salvar_ficha_de_produto", { nome: "Residencial Jardins", texto: "Entrega em 2027, condomínio fechado.", imovel_id: "p_jard" });
  assert.ok(!f.erro, f.erro); ficha = f.dados.ficha_id;
  const c = await usar("salvar_catraca", { nome: "Jardins", membros: [marina], entrega: "corretor", ficha_id: ficha });
  assert.ok(!c.erro, c.erro);
  const v = await usar("ver_catracas", {});
  const nova = v.dados.catracas.find(x => x.nome === "Jardins");
  assert.equal(nova.ficha_id, ficha); assert.deepEqual(nova.membros, [marina]);
  const fm = await usar("configurar_formulario", { form_id: "form_jardins", ficha_id: ficha });
  assert.ok(!fm.erro, fm.erro);
  assert.equal(db.prepare("SELECT ia_produto_id FROM meta_formularios WHERE org_id = ? AND form_id = 'form_jardins'").get(orgA).ia_produto_id, ficha);
});
const etapaFinal = etapas[3];
await caso("5b. Claude configura o Autoatendimento: escopo, campos, resumo, etapa final; orientação editada e apagada", async () => {
  const r = await usar("configurar_autoatendimento", { ativo: true, a_qualquer_hora: true, escopo: { etapas: [etapas[0].id] },
    campos: [chaveProduto], escrever_resumo: true, etapa_final_id: etapaFinal.id });
  assert.ok(!r.erro, r.erro);
  const v = await usar("ver_autoatendimento", {});
  assert.equal(v.dados.ligado, true); assert.deepEqual(v.dados.escopo.etapas, [etapas[0].id]);
  assert.deepEqual(v.dados.campos, [chaveProduto]); assert.equal(v.dados.etapa_final_id, etapaFinal.id);
  // Só mudar o horário não desliga a IA.
  assert.ok(!(await usar("configurar_autoatendimento", { max_mensagens: 8 })).erro);
  assert.equal((await usar("ver_autoatendimento", {})).dados.ligado, true);
  await usar("adicionar_orientacao_da_ia", { texto: "Chame de você." });
  const o = (await usar("ver_orientacoes_da_ia", {})).dados.orientacoes[0];
  assert.ok(o.id);
  assert.ok(!(await usar("editar_orientacao_da_ia", { id: o.id, texto: "Chame a pessoa de você." })).erro);
  assert.equal((await usar("ver_orientacoes_da_ia", {})).dados.orientacoes[0].texto, "Chame a pessoa de você.");
  assert.ok(!(await usar("apagar_orientacao_da_ia", { id: o.id })).erro);
  assert.equal((await usar("ver_orientacoes_da_ia", {})).dados.orientacoes.length, 0);
});
await caso("5c. fora do escopo a IA não fala; dentro, usa a ficha, preenche o campo, escreve o resumo e move", async () => {
  const fora = lead({ etapa: etapas[1], form_id: "form_jardins" });
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','oi',?)").run("m_" + randomUUID(), fora, Date.now());
  assert.equal(podeAtender(orgA, fora).motivo, "fora_do_escopo");

  const dentro = lead({ etapa: etapas[0], form_id: "form_jardins", nome: "Paulo Lima" });
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','quero saber do Jardins',?)").run("m_" + randomUUID(), dentro, Date.now());
  respostaDaIA = { texto: "Anotei tudo, obrigado! A equipe segue com você em breve.", coletado: { finalidade: "comprar" }, encerrar: true,
    campos: { [chaveProduto]: "Jardins", inventado: "x" }, resumo: "Quer casa no Jardins para morar.", interessado: true };
  const r = await atender(orgA, dentro, { atraso: 0 });
  assert.equal(r.atendeu, true, JSON.stringify(r));
  assert.ok(ultimoPedidoIA.includes("Entrega em 2027") && ultimoPedidoIA.includes("Residencial Jardins"), "a ficha foi no pedido");
  assert.ok(!ultimoPedidoIA.includes("dono aceita") && !ultimoPedidoIA.includes("Construtora X") && !ultimoPedidoIA.includes("250000"), "nada interno nem preço");
  const ld = db.prepare("SELECT custom_fields, stage_id FROM leads WHERE id = ?").get(dentro);
  assert.equal(JSON.parse(ld.custom_fields)[chaveProduto], "Jardins");
  assert.equal(JSON.parse(ld.custom_fields).inventado, undefined);
  assert.equal(ld.stage_id, etapaFinal.id);
  const obs = db.prepare("SELECT texto FROM observacoes WHERE lead_id = ?").all(dentro).map(o => o.texto).join("\n");
  assert.ok(obs.includes("Quer casa no Jardins"), obs);
});

// ===== 6. PERMISSÃO =====
await caso("6. o corretor não usa as ferramentas (a rota recusa) e o modo consulta não as tem", async () => {
  const tCor = await entrar(db.prepare("SELECT email FROM users WHERE id = ?").get(rafael).email);
  const rafaelU = db.prepare("SELECT * FROM users WHERE id = ?").get(rafael);
  const dele = executorDeConfig({ autorizacao: "Bearer " + tCor, user: rafaelU, conversaId: null, menu: [] });
  const a = await dele("salvar_fluxo", { nome: "x", gatilho: { tipo: "manual" }, blocos: [], ligacoes: [] });
  assert.ok(a.erro);
  const b = await dele("configurar_autoatendimento", { ativo: false });
  assert.ok(b.erro);
  const nomes = FERRAMENTAS_CONSULTA().map(f => f.name);
  for (const t of ["salvar_fluxo", "salvar_catraca", "configurar_autoatendimento", "configurar_formulario"]) assert.ok(!nomes.includes(t));
});

console.log(`\n${passou} casos passaram.`);
mock.close();
process.exit(0);
