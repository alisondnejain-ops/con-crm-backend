/* ASSISTENTE (Claude) E NUVEM DE SUPORTE (05/10/2026).

   Servidor de pé, com uma IA de mentira (respostas roteirizadas, no formato
   da API da Anthropic) e uma Uazapi de mentira. O que mais importa conferir:
   - a IA não tem poder próprio: a ferramenta passa pela rota, com o crachá
     de quem conversa, e a recusa da rota volta para a IA;
   - o histórico volta para a IA EXATAMENTE como veio (bloco de raciocínio
     com assinatura, sem edição);
   - recusa do filtro de segurança não quebra a conversa;
   - o chamado chega ao WhatsApp do suporte e a resposta volta ao cliente
     certo — e o número do suporte nunca vira lead.

   Rodar:  npm run teste:assistente-suporte */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-assistente.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

/* ===== A IA DE MENTIRA ===== */
const roteiro = [];          // respostas na ordem
const pedidosIA = [];        // o que chegou
const ia = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const pedido = JSON.parse(corpo || "{}");
    pedidosIA.push({ headers: req.headers, corpo: pedido });
    let prox = roteiro.shift();
    // Um passo do roteiro pode ser uma função: lê o pedido (ex.: o código de uma prévia) e responde.
    if (typeof prox === "function") prox = prox(pedido);
    res.setHeader("content-type", "application/json");
    if (!prox) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: "roteiro vazio" } })); }
    res.end(JSON.stringify({ id: "msg_" + pedidosIA.length, model: pedido.model, role: "assistant", type: "message",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 }, ...prox }));
  });
});
await new Promise(r => ia.listen(4881, "127.0.0.1", r));
const pensa = { type: "thinking", thinking: "", signature: "assinatura-secreta-123" };
const fala = (texto) => ({ stop_reason: "end_turn", content: [pensa, { type: "text", text: texto }] });
const usa = (id, name, input, texto) => ({ stop_reason: "tool_use",
  content: [pensa, ...(texto ? [{ type: "text", text: texto }] : []), { type: "tool_use", id, name, input }] });

/* ===== A UAZAPI DE MENTIRA ===== */
const enviados = [];
let seq = 0;
const uaz = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const d = JSON.parse(corpo || "{}");
    res.setHeader("content-type", "application/json");
    if (req.url === "/send/text") {
      const id = "3EB0SUP" + (++seq);
      enviados.push({ ...d, id });
      return res.end(JSON.stringify({ messageid: id }));
    }
    res.end(JSON.stringify({}));
  });
});
await new Promise(r => uaz.listen(4882, "127.0.0.1", r));

const PORTA = 4796;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "",
    ANTHROPIC_API_KEY: "chave-de-teste", ANTHROPIC_BASE_URL: "http://127.0.0.1:4881",
    UAZAPI_AUTOCONFIGURAR: "0", MARKETING_AGENDADOR: "0", SITE_DOMINIO_AGENDADOR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (codigo) => { servidor.kill("SIGTERM"); ia.close(); uaz.close(); process.exit(codigo); };
process.on("uncaughtException", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-2500)); fim(1); });
process.on("unhandledRejection", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-2500)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}

const { default: db } = await import("../src/db.js");
const { sign } = await import("../src/auth.js");
const C = await import("../src/services/canais.js");

// A conta do ConHub (do master) empresta a linha do suporte; a do cliente é outra.
const conhub = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET name='ConHub', uazapi_host='http://127.0.0.1:4882', uazapi_token='token-conhub' WHERE id=?").run(conhub);
C.garantirCasa(conhub);
const cliente = "org_cliente";
db.prepare(`INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)`).run(cliente, "Imobiliária Sol", "SOL-1", Date.now());
const novo = (id, org, nome, papel, master = 0) =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,'x',?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@c.com", papel, Date.now(), master);
novo("u_ali", conhub, "Ali", "adm", 1);
novo("u_gestora", cliente, "Gisele", "adm");
novo("u_atendente", cliente, "Vanessa", "sdr");
novo("u_corretor", cliente, "Marina", "corretor");

const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(url(p), { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const doSuporte = (texto, extra = {}) => fetch(url("/webhooks/uazapi"), {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "token-conhub", event: "messages",
    message: { chatid: "5581999353988@s.whatsapp.net", text: texto, senderName: "Ali",
      messageid: "wa_" + Math.random().toString(36).slice(2), ...extra } }),
});
const esperar = (ms = 400) => new Promise(r => setTimeout(r, ms));

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

caso("O assistente é de todos: a gestora configura; corretor e atendente só consultam");
let r = await api("u_corretor", "GET", "/assistente");
assert.equal(r.status, 200);
assert.equal(r.body.modo, "consulta");
assert.equal((await api("u_atendente", "GET", "/assistente")).body.modo, "consulta");
r = await api("u_gestora", "GET", "/assistente");
assert.equal(r.status, 200);
assert.equal(r.body.modo, "config");
assert.equal(r.body.disponivel, true);
assert.deepEqual(r.body.itens, []);

caso("Consulta do corretor: nenhuma ferramenta que mude a conta, pesquisa na web, e só os leads DELE");
{
  const insLead = db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)`);
  insLead.run("l_ana_dela", cliente, "Ana Corretor", "5587991110001", "Lead", "u_corretor", Date.now());
  insLead.run("l_ana_outra", cliente, "Ana Gestora", "5587991110002", "Lead", "u_gestora", Date.now());
  const busca = { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "documentos financiamento Caixa" } };
  const achado = { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://www.caixa.gov.br/x", title: "Caixa — documentos", encrypted_content: "zzz" }] };
  roteiro.push(
    usa("tu_c1", "buscar_leads", { texto: "Ana" }),
    { stop_reason: "pause_turn", content: [pensa, busca] },
    { stop_reason: "end_turn", content: [achado, { type: "text", text: "Sua lead é a Ana. A Caixa pede RG, CPF e comprovante de renda.",
      citations: [{ type: "web_search_result_location", url: "https://www.caixa.gov.br/x", title: "Caixa — documentos", cited_text: "RG" }] }] },
  );
  const antes = pedidosIA.length;
  r = await api("u_corretor", "POST", "/assistente/mensagem", { texto: "Quem é a Ana e que documentos a Caixa pede?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(pedidosIA.length - antes, 3);
  const primeiro = pedidosIA[antes].corpo;
  assert.ok(primeiro.tools.some(t => t.type === "web_search_20260209" && t.name === "web_search"), "pesquisa na web disponível");
  assert.ok(!primeiro.tools.some(t => /^(criar|editar|ordenar|definir|adicionar)_/.test(t.name || "")), "nenhuma ferramenta que escreve");
  assert.ok(!primeiro.tools.some(t => /^(mover_leads|migrar_|repassar_|etiquetar_|finalizar_|cadastrar_|registrar_venda|corrigir_)/.test(t.name || "")), "nenhuma ferramenta de lead do gestor na consulta");
  const resultado = pedidosIA[antes + 1].corpo.messages.slice(-1)[0].content[0];
  assert.ok(/Ana Corretor/.test(resultado.content) && !/Ana Gestora/.test(resultado.content), "só o lead dele: " + resultado.content);
  // A continuação da pesquisa pausada volta como a MESMA fala do assistente.
  const terceiro = pedidosIA[antes + 2].corpo.messages;
  assert.equal(terceiro[terceiro.length - 1].role, "assistant", "a fala pausada vai de volta como está");
  const hist = JSON.parse(db.prepare("SELECT mensagens FROM assistente_conversas WHERE user_id = 'u_corretor' AND tipo = 'consulta'").get().mensagens);
  assert.equal(hist[hist.length - 1].role, "assistant");
  assert.equal(hist[hist.length - 2].role, "user", "sem duas falas seguidas do assistente");
  assert.ok(hist[hist.length - 1].content.some(b => b.type === "server_tool_use") && hist[hist.length - 1].content.some(b => b.type === "web_search_tool_result"));
  const resposta = r.body.itens.find(i => i.de === "assistente" && /Caixa pede/.test(i.texto));
  assert.ok(resposta && resposta.fontes && resposta.fontes[0].url === "https://www.caixa.gov.br/x", "a fonte aparece para conferir");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM ia_uso WHERE org_id = ? AND recurso = 'consulta'").get(cliente).n >= 3, "o gasto entra no Uso da IA");
  assert.ok(/NUNCA coloque nome, telefone/.test(primeiro.system[0].text), "a instrução de privacidade vai junto");
}

caso("O corretor reorganiza o PRÓPRIO menu pelo Claude: só a ordem, nunca o nome, e só o dele");
{
  const menu = [{ id: "dashboard", rotulo: "Painel", secao: "Principal" }, { id: "atendimento", rotulo: "Atender", secao: "Principal" },
    { id: "funil", rotulo: "Funil", secao: "Principal" }, { id: "imoveis", rotulo: "Imóveis", secao: "Ferramentas" }];
  // id que não está no menu dela é recusado, e nada é gravado.
  roteiro.push(usa("tu_m0", "organizar_meu_menu", { ordem: ["equipe", "dashboard"] }), fala("Esse item não existe no seu menu."));
  r = await api("u_corretor", "POST", "/assistente/mensagem", { texto: "Põe Equipe no topo", menu });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.menu, undefined, "recusado não muda o menu da tela");
  assert.equal(db.prepare("SELECT menu_ordem FROM users WHERE id='u_corretor'").get().menu_ordem, null);
  // Lista parcial: o que ficou de fora segue depois, na ordem em que estava.
  roteiro.push(usa("tu_m1", "ver_meu_menu", {}), usa("tu_m2", "organizar_meu_menu", { ordem: ["imoveis", "atendimento"] }), fala("Pronto, Imóveis no topo."));
  const antes = pedidosIA.length;
  r = await api("u_corretor", "POST", "/assistente/mensagem", { texto: "Coloque Imóveis no topo do meu menu", menu });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(pedidosIA[antes].corpo.tools.some(t => t.name === "organizar_meu_menu"), "a ferramenta existe na consulta");
  assert.ok(/"Imóveis"/.test(pedidosIA[antes + 1].corpo.messages.slice(-1)[0].content[0].content), "ver_meu_menu devolve o menu que a tela mandou");
  assert.deepEqual(r.body.menu, ["imoveis", "atendimento", "dashboard", "funil"]);
  assert.ok(r.body.itens.some(i => i.de === "acao" && /Reorganizei/.test(i.texto)));
  assert.deepEqual((await api("u_corretor", "GET", "/auth/me")).body.user.menu_ordem, ["imoveis", "atendimento", "dashboard", "funil"], "fica guardado na conta dela");
  assert.equal((await api("u_atendente", "GET", "/auth/me")).body.user.menu_ordem, null, "não mexe no menu de mais ninguém");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assistente_acoes WHERE user_id='u_corretor' AND ferramenta='organizar_meu_menu' AND ok=1").get().n, 1, "fica registrado");
  // A rota só guarda chaves de tela — texto com espaço (um "nome") não passa.
  r = await api("u_corretor", "POST", "/auth/me/menu", { ordem: ["Meus Imóveis", "funil"] });
  assert.deepEqual(r.body.menu_ordem, ["funil"]);
  // Voltar ao padrão.
  roteiro.push(usa("tu_m3", "organizar_meu_menu", { restaurar: true }), fala("Voltei ao padrão."));
  r = await api("u_corretor", "POST", "/assistente/mensagem", { texto: "Volta o menu ao padrão", menu });
  assert.equal(r.body.menu, null);
  assert.equal(db.prepare("SELECT menu_ordem FROM users WHERE id='u_corretor'").get().menu_ordem, null);
}

caso("Pedido de configuração: lê os funis, cria o funil pela ROTA e responde — e o histórico volta sem edição");
roteiro.push(
  usa("tu_1", "ver_funis", {}),
  usa("tu_2", "criar_funil", { nome: "Locação", modelo_id: "locacao" }, "Vou criar o funil."),
  fala("Pronto: criei o funil Locação com as etapas do modelo."),
);
const antes = pedidosIA.length;
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "Cria um funil de locação" });
assert.equal(r.status, 200, JSON.stringify(r.body));
const p = db.prepare("SELECT * FROM pipelines WHERE org_id = ? AND name = 'Locação'").get(cliente);
assert.ok(p, "o funil foi criado na conta da gestora");
assert.ok(db.prepare("SELECT COUNT(*) n FROM pipeline_stages WHERE pipeline_id = ?").get(p.id).n >= 5, "com as etapas do modelo");
assert.ok(r.body.itens.some(i => i.de === "acao" && /Criei o funil/.test(i.texto)), "a tela mostra o que mudou");
assert.ok(r.body.itens.some(i => i.de === "assistente" && /Pronto/.test(i.texto)));
assert.equal(pedidosIA.length - antes, 3, "três idas à IA");
const terceiro = pedidosIA[pedidosIA.length - 1].corpo;
const ecoado = terceiro.messages.find(m => m.role === "assistant");
assert.deepEqual(ecoado.content[0], pensa, "o bloco de raciocínio volta exatamente como veio");
const resultadoFunis = terceiro.messages[2].content[0];
assert.equal(resultadoFunis.type, "tool_result");
assert.ok(/"funis"/.test(resultadoFunis.content), "o resultado de ver_funis chega à IA");
assert.equal(terceiro.model, "claude-opus-5-5", "modelo padrão");
assert.equal(terceiro.fallbacks, "default");
assert.equal(pedidosIA[pedidosIA.length - 1].headers["anthropic-beta"], "server-side-fallback-2026-07-01");
assert.deepEqual(terceiro.output_config, { effort: "medium" });
/* Apagar, só os textos da própria equipe que o Ali pediu (08/10/2026):
   orientação da IA e ficha de produto. Lead, funil, etapa, tag, fluxo e
   catraca continuam sem ferramenta de apagar. */
assert.ok(terceiro.tools.some(t => t.name === "editar_etapa"));
assert.deepEqual(terceiro.tools.filter(t => /apagar/.test(t.name)).map(t => t.name).sort(),
  ["apagar_ficha_de_produto", "apagar_orientacao_da_ia"], "só apaga orientação e ficha");
assert.equal(db.prepare("SELECT COUNT(*) n FROM assistente_acoes WHERE org_id = ? AND ferramenta = 'criar_funil' AND ok = 1").get(cliente).n, 1, "a ação fica registrada");
assert.ok(db.prepare("SELECT COUNT(*) n FROM ia_uso WHERE org_id = ? AND recurso = 'assistente'").get(cliente).n >= 3, "o gasto entra no Uso da IA");

caso("Recusa da rota volta para a IA como erro, e a pessoa vê o motivo");
roteiro.push(
  usa("tu_3", "criar_etapa", { funil_id: "nao-existe", nome: "Visita" }),
  fala("Não encontrei esse funil."),
);
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "Cria a etapa Visita" });
assert.ok(r.body.itens.some(i => i.de === "erro" && /Não deu/.test(i.texto)));
const resultadoErro = pedidosIA[pedidosIA.length - 1].corpo.messages.slice(-1)[0].content[0];
assert.equal(resultadoErro.is_error, true);
assert.ok(/não encontrado/i.test(resultadoErro.content));

caso("Recusa do filtro de segurança: a pergunta sai do histórico e a conversa continua válida");
const tamanho = JSON.parse(db.prepare("SELECT mensagens FROM assistente_conversas WHERE user_id = 'u_gestora' AND tipo = 'config'").get().mensagens).length;
roteiro.push({ stop_reason: "refusal", content: [] });
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "pergunta recusada" });
assert.ok(r.body.itens.some(i => /Não consigo ajudar/.test(i.texto)));
assert.equal(JSON.parse(db.prepare("SELECT mensagens FROM assistente_conversas WHERE user_id = 'u_gestora' AND tipo = 'config'").get().mensagens).length, tamanho);
roteiro.push(fala("Tudo certo."));
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "oi de novo" });
const ultimas = pedidosIA[pedidosIA.length - 1].corpo.messages;
assert.equal(ultimas[ultimas.length - 1].content, "oi de novo");
assert.equal(ultimas[ultimas.length - 2].role, "assistant", "alterna certo depois da recusa");

caso("IA fora do ar: erro na tela, e o histórico não fica com pedido de ferramenta sem resposta");
roteiro.push(usa("tu_4", "ver_tags", {}));  // a segunda chamada não tem roteiro: a IA "cai"
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "lista as tags" });
assert.ok(r.body.itens.some(i => i.de === "erro"));
const hist = JSON.parse(db.prepare("SELECT mensagens FROM assistente_conversas WHERE user_id = 'u_gestora' AND tipo = 'config'").get().mensagens);
const fimHist = hist[hist.length - 1];
assert.equal(fimHist.role, "assistant");
assert.ok(!fimHist.content.some(b => b.type === "tool_use"));

/* ===== O CLAUDE DO GESTOR FAZ O TRABALHO DA GESTÃO (07/10/2026) ===== */
const ultimoResultado = (pedido) => {
  const m = pedido.messages[pedido.messages.length - 1];
  return JSON.parse(m.content.find(b => b.type === "tool_result").content);
};
const locacao = db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND name = 'Locação'").get(cliente).id;
const etapasLoc = db.prepare("SELECT id, name FROM pipeline_stages WHERE pipeline_id = ? ORDER BY ordem").all(locacao);
const [et1, et2, et3] = etapasLoc;

caso("Gestor: as ferramentas de lead e a pesquisa vêm só no modo dele");
roteiro.push(fala("Oi."));
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "oi" });
{
  const tools = pedidosIA[pedidosIA.length - 1].corpo.tools.map(t => t.name);
  for (const t of ["buscar_leads", "mover_leads", "migrar_funil_da_pessoa", "repassar_leads", "etiquetar_leads", "finalizar_leads",
    "criar_tarefa", "adicionar_observacao", "cadastrar_lead", "registrar_venda", "ver_numeros", "web_search"])
    assert.ok(tools.includes(t), "falta " + t);
  // Só orientação e ficha de produto se apagam (08/10/2026); nada fala com o cliente.
  assert.ok(!tools.some(t => /excluir|enviar_mensagem|disparar/.test(t) || (/apagar/.test(t) && !["apagar_ficha_de_produto", "apagar_orientacao_da_ia"].includes(t))),
    "nada de apagar lead/funil/fluxo nem de falar com o cliente");
  assert.ok(/AÇÃO EM MASSA/.test(pedidosIA[pedidosIA.length - 1].corpo.system[0].text));
}

caso("Gestor move poucos leads direto, pela rota de mudar etapa (de funil, inclusive)");
roteiro.push(usa("tu_l1", "mover_leads", { lead_ids: ["l_ana_dela", "l_ana_outra"], etapa_id: et2.id }), fala("Movi os dois."));
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "Põe as duas Anas em " + et2.name });
assert.equal(r.status, 200, JSON.stringify(r.body));
for (const id of ["l_ana_dela", "l_ana_outra"]) {
  const l = db.prepare("SELECT stage_id, pipeline_id FROM leads WHERE id = ?").get(id);
  assert.equal(l.stage_id, et2.id); assert.equal(l.pipeline_id, locacao);
}
assert.ok(r.body.itens.some(i => i.de === "acao" && /2 leads movidos/.test(i.texto)), JSON.stringify(r.body.itens));
assert.ok(db.prepare("SELECT COUNT(*) n FROM lead_etapas WHERE lead_id = 'l_ana_dela' AND para_stage_id = ?").get(et2.id).n >= 1, "fica no histórico de etapas");

caso("Ação em massa: prévia com código, e executar na MESMA pergunta é recusado");
{
  const ins = db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)`);
  for (let i = 0; i < 13; i++) ins.run("l_massa_" + i, cliente, "Massa " + i, "558799900" + String(i).padStart(4, "0"), "Lead", "u_corretor", Date.now());
}
let codigo = null, recusaMesmaPergunta = null;
roteiro.push(
  usa("tu_l2", "mover_leads", { filtro: { texto: "Massa" }, etapa_id: et3.id }),
  (pedido) => { const res = ultimoResultado(pedido); codigo = res.codigo; return usa("tu_l3", "mover_leads", { confirmacao: res.codigo }); },
  (pedido) => { recusaMesmaPergunta = pedido.messages[pedido.messages.length - 1].content[0]; return fala("São 13 leads. Posso mover?"); },
);
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "Move todos os Massa para " + et3.name });
assert.ok(/^cf_/.test(codigo || ""), "a prévia devolve um código");
assert.equal(recusaMesmaPergunta.is_error, true);
assert.ok(/ainda não confirmou/.test(recusaMesmaPergunta.content), recusaMesmaPergunta.content);
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE id LIKE 'l_massa_%' AND stage_id = ?").get(et3.id).n, 0, "nada mudou antes da confirmação");
assert.ok(r.body.itens.some(i => i.de === "aviso" && /mover 13 leads/.test(i.texto)), "a pessoa vê o que espera confirmação");

caso("Confirmada na mensagem seguinte, executa EXATAMENTE a prévia — mesmo que venha outra etapa junto");
roteiro.push(() => usa("tu_l4", "mover_leads", { confirmacao: codigo, etapa_id: et1.id }), fala("Pronto."));
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "pode" });
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE id LIKE 'l_massa_%' AND stage_id = ?").get(et3.id).n, 13, "foram para a etapa da prévia");
assert.ok(r.body.itens.some(i => i.de === "acao" && /13 leads movidos/.test(i.texto)));
// O código vale uma vez só.
roteiro.push(() => usa("tu_l5", "mover_leads", { confirmacao: codigo }), fala("Já foi."));
await api("u_gestora", "POST", "/assistente/mensagem", { texto: "de novo" });
assert.ok(/não existe ou venceu/.test(pedidosIA[pedidosIA.length - 1].corpo.messages.slice(-1)[0].content[0].content));
assert.ok(db.prepare("SELECT COUNT(*) n FROM assistente_acoes WHERE user_id='u_gestora' AND ferramenta='mover_leads' AND ok=1").get().n >= 2, "fica registrado");

caso("Repassar, tag, tarefa e observação passam pelas rotas de sempre");
{
  const cor = (await api("u_gestora", "GET", "/tags")).body.cores[0];
  assert.equal((await api("u_gestora", "POST", "/tags", { nome: "Investidor", cor })).status, 200);
  const tagId = db.prepare("SELECT id FROM tags WHERE org_id = ? AND nome = 'Investidor'").get(cliente).id;
  roteiro.push(
    usa("tu_l6", "repassar_leads", { lead_ids: ["l_ana_dela"], para: "fila" }),
    usa("tu_l7", "repassar_leads", { lead_ids: ["l_ana_outra"], para: "u_atendente" }),
    usa("tu_l8", "etiquetar_leads", { lead_ids: ["l_ana_outra"], tag_id: tagId, acao: "colocar" }),
    usa("tu_l9", "criar_tarefa", { lead_id: "l_ana_outra", titulo: "Ligar para a Ana", quando: "2026-12-01T10:00" }),
    usa("tu_l10", "adicionar_observacao", { lead_id: "l_ana_outra", texto: "Quem decide é o marido." }),
    fala("Feito."),
  );
  r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "Organiza as Anas" });
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id='l_ana_dela'").get().assigned_to, null, "voltou para a fila");
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id='l_ana_outra'").get().assigned_to, "u_atendente");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lead_tags WHERE lead_id='l_ana_outra' AND tag_id=?").get(tagId).n, 1);
  const t = db.prepare("SELECT * FROM tarefas WHERE lead_id='l_ana_outra'").get();
  assert.ok(t && t.titulo === "Ligar para a Ana" && t.user_id === "u_atendente", "tarefa no nome de quem está com o lead");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observacoes WHERE lead_id='l_ana_outra' AND texto LIKE 'Quem decide%'").get().n, 1);
  assert.equal(r.body.itens.filter(i => i.de === "acao").length, 5, JSON.stringify(r.body.itens));
}

caso("Migrar o funil de uma pessoa: sempre com prévia; cadastrar lead e registrar venda");
{
  const novoFunil = (await api("u_gestora", "POST", "/pipelines", { name: "Comercial 2", template: "recaptacao" })).body;
  const funil2 = db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND name = 'Comercial 2'").get(cliente).id;
  assert.ok(novoFunil && funil2);
  let cod = null;
  roteiro.push(usa("tu_m1x", "migrar_funil_da_pessoa", { pessoa_id: "u_corretor", funil_id: funil2 }),
    (pedido) => { cod = ultimoResultado(pedido).codigo; return fala("Vou levar os leads da Marina. Confirma?"); });
  r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "Leva os leads da Marina para o Comercial 2" });
  assert.ok(/^cf_/.test(cod || ""));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE assigned_to='u_corretor' AND pipeline_id=?").get(funil2).n, 0, "nada antes de confirmar");
  assert.ok(r.body.itens.some(i => i.de === "aviso" && /Marina/.test(i.texto)));
  roteiro.push(() => usa("tu_m2x", "migrar_funil_da_pessoa", { pessoa_id: "u_corretor", funil_id: funil2, confirmacao: cod }), fala("Feito."));
  r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "confirmo" });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE assigned_to='u_corretor' AND pipeline_id <> ?").get(funil2).n, 0, "todos os da Marina no funil novo");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE id LIKE 'l_massa_%' AND assigned_to='u_corretor'").get().n, 13, "o responsável não muda");

  roteiro.push(usa("tu_c1x", "cadastrar_lead", { nome: "Bruno Lima", telefone: "(87) 99876-5432", responsavel_id: "u_corretor" }), fala("Cadastrei."));
  r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "cadastra o Bruno" });
  const bruno = db.prepare("SELECT * FROM leads WHERE org_id = ? AND name = 'Bruno Lima'").get(cliente);
  assert.ok(bruno && bruno.phone === "5587998765432" && bruno.assigned_to === "u_corretor", "mesma normalização do cadastro na mão");
  roteiro.push(usa("tu_v1x", "registrar_venda", { lead_id: bruno.id, valor: 250000, data: "2026-10-07" }), fala("Venda registrada."));
  await api("u_gestora", "POST", "/assistente/mensagem", { texto: "o Bruno comprou por 250 mil" });
  assert.equal(db.prepare("SELECT sale_value FROM leads WHERE id = ?").get(bruno.id).sale_value, 250000);
}

caso("Texto longo e arquivos: o gestor manda; o corretor e a atendente não");
r = await api("u_corretor", "POST", "/assistente/mensagem", { texto: "x".repeat(4001) });
assert.equal(r.status, 400); assert.ok(/máximo é 4\.000/.test(r.body.error), r.body.error);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
r = await api("u_corretor", "POST", "/assistente/mensagem", { texto: "olha", anexos: [{ nome: "p.png", tipo: "image/png", dados: PNG }] });
assert.equal(r.status, 403);
assert.equal((await api("u_atendente", "POST", "/assistente/mensagem", { texto: "olha", anexos: [{ nome: "p.png", tipo: "image/png", dados: PNG }] })).status, 403);
assert.equal((await api("u_gestora", "GET", "/assistente")).body.anexos, true);
assert.equal((await api("u_corretor", "GET", "/assistente")).body.anexos, false);
await api("u_gestora", "POST", "/assistente/nova");  // conversa nova: a anterior passou de 60 mensagens e recomeçaria no meio do caso
roteiro.push(fala("Li tudo."));
const longo = "Monte assim: " + "etapa ".repeat(4000);
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: longo, anexos: [
  { nome: "print.png", tipo: "image/png", dados: PNG },
  { nome: "tabela.pdf", tipo: "application/pdf", dados: Buffer.from("%PDF-1.4 teste").toString("base64") },
  { nome: "leads.csv", tipo: "text/csv", dados: Buffer.from("nome;telefone\nAna;87999\n").toString("base64") },
  { nome: "visita.mp4", tipo: "video/mp4", duracao: 12, quadros: [{ em: 2, dados: PNG }, { em: 8, dados: PNG }] },
] });
assert.equal(r.status, 200, JSON.stringify(r.body));
{
  const msg = pedidosIA[pedidosIA.length - 1].corpo.messages.slice(-1)[0];
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content[msg.content.length - 1].text, longo.trim(), "o texto longo chega inteiro, depois dos arquivos");
  assert.equal(msg.content.filter(b => b.type === "image").length, 3, "o print e as duas cenas do vídeo");
  assert.ok(msg.content.some(b => b.type === "document" && b.source.media_type === "application/pdf" && b.title === "tabela.pdf"));
  const csv = msg.content.find(b => b.type === "document" && b.title === "leads.csv");
  assert.ok(csv && csv.source.type === "text" && /Ana\t87999/.test(csv.source.data), "a planilha vira texto");
  assert.ok(msg.content.some(b => b.type === "text" && /NÃO assiste ao vídeo/.test(b.text)), "a IA sabe que só viu cenas");
  const eu = r.body.itens.find(i => i.de === "voce");
  assert.deepEqual(eu.anexos.map(a => a.nome), ["print.png", "tabela.pdf", "leads.csv", "visita.mp4"], "a tela guarda só os nomes");
}
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "ouve", anexos: [{ nome: "a.ogg", tipo: "audio/ogg", dados: PNG }] });
assert.equal(r.status, 400); assert.ok(/não consigo ouvir/i.test(r.body.error));
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "lê", anexos: [{ nome: "c.docx", tipo: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", dados: PNG }] });
assert.equal(r.status, 400); assert.ok(/PDF/.test(r.body.error));
assert.equal((await api("u_gestora", "POST", "/assistente/mensagem", { texto: "x".repeat(30001) })).status, 400);

caso("O histórico não carrega arquivo para sempre: só as duas últimas perguntas com arquivo");
roteiro.push(fala("Ok 2."), fala("Ok 3."));
await api("u_gestora", "POST", "/assistente/mensagem", { texto: "segunda", anexos: [{ nome: "b.png", tipo: "image/png", dados: PNG }] });
await api("u_gestora", "POST", "/assistente/mensagem", { texto: "terceira", anexos: [{ nome: "c.png", tipo: "image/png", dados: PNG }] });
{
  const msgs = pedidosIA[pedidosIA.length - 1].corpo.messages;
  const comArquivo = msgs.filter(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "image" || b.type === "document"));
  assert.equal(comArquivo.length, 2, "ficam as duas últimas");
  const primeira = msgs.find(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "text" && /print\.png/.test(b.text)));
  assert.ok(primeira && primeira.content.some(b => /não está mais guardado/.test(b.text || "")), "a antiga vira aviso com o nome");
  assert.ok(msgs.filter(m => m.role === "assistant").every(m => m.content[0].signature === "assinatura-secreta-123"), "as falas da IA não são mexidas");
}

caso("Teto do mês: passado o limite, o assistente recusa com a frase certa");
const ins = db.prepare("INSERT INTO assistente_turnos (id,org_id,user_id,tipo,created_at) VALUES (?,?,?,?,?)");
for (let i = 0; i < 200; i++) ins.run("x" + i, cliente, "u_gestora", "config", Date.now());
r = await api("u_gestora", "POST", "/assistente/mensagem", { texto: "mais uma" });
assert.equal(r.status, 409);
assert.ok(/limite/.test(r.body.error));
db.prepare("DELETE FROM assistente_turnos WHERE id LIKE 'x%'").run();

caso("Nuvem de suporte: a IA responde e, sem solução, oferece a pessoa com o resumo");
roteiro.push(
  usa("tu_5", "encaminhar_para_suporte", { resumo: "Cobrança duplicada no cartão em outubro." }),
  fala("Isso é com o nosso suporte. Toque em Falar com o suporte."),
);
r = await api("u_corretor", "POST", "/suporte/mensagem", { texto: "Me cobraram duas vezes" });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.humano.resumo, "Cobrança duplicada no cartão em outubro.");
assert.equal(r.body.chamado, null, "ainda não abriu chamado — a pessoa decide");
const reqSup = pedidosIA[pedidosIA.length - 1].corpo;
assert.deepEqual(reqSup.output_config, { effort: "low" });
assert.ok(/Quem pergunta: Marina/.test(reqSup.system[1].text));

caso("Falar com o suporte: chamado #1 chega ao WhatsApp do suporte com conta, pessoa e resumo");
// O formulário da nuvem: sem resumo, não abre; com nome, o nome escrito vai para o suporte.
assert.equal((await api("u_corretor", "POST", "/suporte/humano", { nome: "Marina", resumo: "" })).status, 400);
r = await api("u_corretor", "POST", "/suporte/humano", { nome: "Marina Lopes", resumo: "Cobrança duplicada no cartão em outubro." });
assert.equal(r.body.chamado.numero, 1);
assert.equal(r.body.entregue, true);
let env = enviados[enviados.length - 1];
assert.equal(env.number, "5581999353988");
assert.ok(/Suporte #1/.test(env.text) && /Imobiliária Sol/.test(env.text) && /Marina Lopes \(login de Marina\)/.test(env.text) && /Cobrança duplicada/.test(env.text), env.text);
const idDoAviso = env.id;

caso("O cliente escreve na nuvem: a mensagem sai para o suporte com #1, e não passa pela IA");
const iaAntes = pedidosIA.length;
r = await api("u_corretor", "POST", "/suporte/mensagem", { texto: "Foi no dia 3" });
assert.equal(pedidosIA.length, iaAntes);
env = enviados[enviados.length - 1];
assert.ok(/^\*#1\* · Marina: Foi no dia 3$/.test(env.text), env.text);

caso("O suporte responde citando a mensagem: volta para a nuvem da Marina, e o número do suporte não vira lead");
await doSuporte("Já estornei, aparece em 2 dias", { quoted: idDoAviso });
await esperar();
r = await api("u_corretor", "GET", "/suporte");
assert.equal(r.body.nao_lidas, 1);
assert.ok(r.body.chamado.mensagens.some(m => m.de === "suporte" && m.texto === "Já estornei, aparece em 2 dias"));
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone LIKE '%81999353988' OR phone LIKE '%8199353988'").get().n, 0);
r = await api("u_corretor", "GET", "/suporte?ler=1");
assert.equal((await api("u_corretor", "GET", "/suporte/nao-lidas")).body.nao_lidas, 0, "abrir marca como lida");

caso("Eco do que saiu para o suporte (fromMe) não vira lead nem mensagem");
await doSuporte("eco", { fromMe: true });
await esperar();
assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone LIKE '%81999353988'").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM suporte_mensagens WHERE texto = 'eco'").get().n, 0);

caso("Dois chamados abertos: resposta sem citar vai para o mais recente com confirmação; '#1' vai para o #1");
r = await api("u_atendente", "POST", "/suporte/humano", { resumo: "Não consigo conectar o WhatsApp" });
assert.equal(r.body.chamado.numero, 2);
await doSuporte("Qual aparelho você usa?");
await esperar();
assert.ok((await api("u_atendente", "GET", "/suporte")).body.chamado.mensagens.some(m => m.texto === "Qual aparelho você usa?"));
assert.ok(/Foi para o \*#2\*/.test(enviados[enviados.length - 1].text), "o suporte é avisado de para qual foi");
await doSuporte("#1 Confirmado o estorno");
await esperar();
assert.ok((await api("u_corretor", "GET", "/suporte")).body.chamado.mensagens.some(m => m.texto === "Confirmado o estorno"));

caso("'/fechar' citando o chamado encerra só ele");
await doSuporte("#2 /fechar");
await esperar();
assert.equal(db.prepare("SELECT status FROM suporte_chamados WHERE numero = 2").get().status, "fechado");
assert.equal(db.prepare("SELECT status FROM suporte_chamados WHERE numero = 1").get().status, "aberto");

caso("Hub: só o master; muda o número do suporte e responde pelo painel");
assert.equal((await api("u_gestora", "GET", "/suporte/hub")).status, 403);
r = await api("u_ali", "GET", "/suporte/hub");
assert.equal(r.status, 200);
assert.equal(r.body.config.destino, "5581999353988");
assert.equal(r.body.config.org.id, conhub);
assert.equal(r.body.config.linha_ligada, true);
assert.equal(r.body.chamados.length, 2);
const ch1 = r.body.chamados.find(c => c.numero === 1);
r = await api("u_ali", "POST", `/suporte/hub/chamados/${ch1.id}/responder`, { texto: "Pelo painel" });
assert.equal(r.status, 200);
assert.ok((await api("u_corretor", "GET", "/suporte")).body.chamado.mensagens.some(m => m.texto === "Pelo painel"));
r = await api("u_ali", "PATCH", "/suporte/hub/config", { destino: "(81) 98888-7777" });
assert.equal(r.body.config.destino, "5581988887777");
r = await api("u_ali", "PATCH", "/suporte/hub/config", { destino: "123" });
assert.equal(r.status, 400);

caso("O cliente encerra a conversa; a próxima mensagem volta para a IA");
r = await api("u_corretor", "POST", "/suporte/fechar");
assert.equal(r.body.chamado.status, "fechado");
roteiro.push(fala("Claro, em Minha conta → Notificações."));
r = await api("u_corretor", "POST", "/suporte/mensagem", { texto: "Como ativo notificação?" });
assert.ok(r.body.ia.itens.some(i => /Minha conta/.test(i.texto)));

caso("Sem IA disponível (teto do mês), a dúvida vai direto para uma pessoa");
for (let i = 0; i < 300; i++) ins.run("s" + i, cliente, "u_gestora", "suporte", Date.now());
r = await api("u_gestora", "POST", "/suporte/mensagem", { texto: "Preciso de ajuda com o site" });
assert.equal(r.body.chamado.status, "aberto");
assert.ok(/Preciso de ajuda com o site/.test(enviados[enviados.length - 1].text));

caso("A nuvem abre mesmo com a conta travada por pagamento (fica fora do porteiro)");
db.prepare("UPDATE orgs SET vence_em = ? WHERE id = ?").run(Date.now() - 40 * 86400000, cliente);
assert.equal((await api("u_gestora", "GET", "/leads")).status, 402, "a conta está travada");
assert.equal((await api("u_gestora", "GET", "/suporte")).status, 200);

console.log("\nTudo certo ✅");
fim(0);
