/* TAREFAS WORKFLOW — CADÊNCIA POR ETAPA (CETRO 10, 13/11/2026).

   O que este teste protege:
   1. Só a supervisão configura; os passos são conferidos (dia, ação, critério).
   2. Importar lê o texto/arquivo e DEVOLVE os passos — não grava nada.
   3. Entrar na etapa cria as tarefas uma vez só (idempotente); sair tira as
      em aberto; reentrar cria de novo, sem duplicar.
   4. A ligação conclui a tarefa "ligação" de janela aberta — nunca a de amanhã.
   5. Mensagem enviada pelo CRM conclui "mensagem"; texto unilateral NÃO conclui
      "conversa"; a resposta do cliente depois dela conclui.
   6. Ligação atendida ("falou") conclui "conversa".
   7. A tarefa da cadência não segura o prazo da etapa; repassar leva as
      tarefas para o novo dono; concluir à mão fica registrado como tal.

   Servidor no mesmo processo e uma Uazapi de mentira.
   Rodar:  npm run teste:cadencias */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-cadencias.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4647";
for (const k of ["AGENDADAS_AGENDADOR", "MARKETING_AGENDADOR", "PRAZO_AGENDADOR", "UAZAPI_AUTOCONFIGURAR", "CATRACA_TEMPO_AGENDADOR"]) process.env[k] = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const PORTA_UAZ = 4648;
let n = 0;
const uaz = http.createServer((req, res) => {
  let c = ""; req.on("data", d => (c += d));
  req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ messageid: "wa_cad_" + (++n) })); });
});
await new Promise(r => uaz.listen(PORTA_UAZ, r));

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const { sign } = await import("../src/auth.js");
const { processarMensagemRecebida } = await import("../src/services/mensageria.js");
const { canalDaCasa, garantirCasa } = await import("../src/services/canais.js");
const { slaDoLead, leadsComTarefaFutura } = await import("../src/services/etapas.js");
const BASE = "http://localhost:4647";
await new Promise(r => setTimeout(r, 700));

const org = db.prepare("SELECT id FROM orgs WHERE demo IS NULL OR demo = 0 ORDER BY created_at LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token='token-cad' WHERE id=?").run(`http://127.0.0.1:${PORTA_UAZ}`, org);
garantirCasa(org);
const novo = (id, nome, papel) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@cad.com", papel, Date.now());
novo("u_g_cad", "Gestora", "adm"); novo("u_m_cad", "Marina", "corretor"); novo("u_b_cad", "Bruno", "corretor");
const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(BASE + p, { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pl = db.prepare("SELECT id FROM pipelines WHERE org_id = ? AND is_default = 1").get(org).id;
const etapas = db.prepare("SELECT id, name FROM pipeline_stages WHERE pipeline_id = ? ORDER BY ordem").all(pl);
const [eLead, eAtend, ePasta] = etapas;
const lead = (id, dono) => db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,stage_id,pipeline_id,created_at,assigned_to,assigned_at)
  VALUES (?,?,?,?,'{}',?,?,?,?,?,?)`).run(id, org, "Cliente " + id, "55879913" + String(10000 + Math.floor(Math.random() * 80000)),
  eLead.name, eLead.id, pl, Date.now(), dono, Date.now());
const tarefas = (id) => db.prepare("SELECT * FROM tarefas WHERE lead_id = ? AND cadencia_passo_id IS NOT NULL ORDER BY quando").all(id);
const mover = (quem, id, etapa) => api(quem, "PATCH", `/leads/${id}/stage`, { stage: etapa.name, stage_id: etapa.id });

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); }
}
const PASSOS = [
  { dia: 1, hora: null, acao: "Ligar para o cliente", criterio: "ligacao" },
  { dia: 1, hora: null, acao: "Mandar a apresentação", criterio: "mensagem" },
  { dia: 1, hora: null, acao: "Ter uma conversa de verdade", criterio: "conversa" },
  { dia: 2, hora: "10:00", acao: "Ligar de novo", criterio: "ligacao" },
];

console.log("Cadência por etapa");
await caso("1. Só a supervisão configura; passos conferidos", async () => {
  let r = await api("u_m_cad", "PUT", `/pipelines/etapas/${eAtend.id}/cadencia`, { passos: PASSOS });
  assert.equal(r.status, 403);
  r = await api("u_g_cad", "PUT", `/pipelines/etapas/${eAtend.id}/cadencia`, { passos: [{ dia: 0, acao: "x", criterio: "ligacao" }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /dia/);
  r = await api("u_g_cad", "PUT", `/pipelines/etapas/${eAtend.id}/cadencia`, { passos: [{ dia: 1, acao: "x", criterio: "inventado" }] });
  assert.equal(r.status, 400);
  r = await api("u_g_cad", "PUT", `/pipelines/etapas/${eAtend.id}/cadencia`, { passos: PASSOS });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.passos.length, 4);
  r = await api("u_g_cad", "GET", `/pipelines/etapas/${eAtend.id}/cadencia`);
  assert.equal(r.body.passos[3].hora, "10:00");
});

await caso("2. Importar lê e devolve — não grava", async () => {
  const texto = "Cadência\nDia 1 - Ligar às 9h\nConfirme o interesse.\nDia 2: Enviar a apresentação\nDia 3 - Retomar a conversa";
  let r = await api("u_g_cad", "POST", `/pipelines/etapas/${ePasta.id}/cadencia/extrair`, { texto });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.passos.map(p => [p.dia, p.criterio]), [[1, "ligacao"], [2, "mensagem"], [3, "conversa"]]);
  assert.equal(r.body.passos[0].hora, "09:00"); assert.match(r.body.passos[0].instrucao, /Confirme/);
  const csv = Buffer.from("Dia;Ação;Instrução\n1;Ligar;Primeiro contato\n2;Mandar vídeo;").toString("base64");
  r = await api("u_g_cad", "POST", `/pipelines/etapas/${ePasta.id}/cadencia/extrair`, { arquivo: csv, nome: "cad.csv" });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.passos.length, 2);
  r = await api("u_g_cad", "POST", `/pipelines/etapas/${ePasta.id}/cadencia/extrair`, { arquivo: csv, nome: "cad.pdf" });
  assert.equal(r.status, 415);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cadencia_passos WHERE stage_id = ?").get(ePasta.id).n, 0);
});

await caso("3. Entrar cria uma vez; sair tira as abertas; reentrar recria sem duplicar", async () => {
  lead("l_c1", "u_m_cad");
  let r = await mover("u_m_cad", "l_c1", eAtend); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(tarefas("l_c1").length, 4);
  assert.ok(tarefas("l_c1").every(t => t.user_id === "u_m_cad"));
  r = await mover("u_m_cad", "l_c1", ePasta);
  assert.equal(tarefas("l_c1").length, 0, "saiu da etapa e as tarefas em aberto ficaram");
  r = await mover("u_m_cad", "l_c1", eAtend);
  assert.equal(tarefas("l_c1").length, 4, "reentrada duplicou ou não recriou");
});

await caso("4. A ligação conclui a de hoje, nunca a de amanhã", async () => {
  const r = await api("u_m_cad", "POST", "/leads/l_c1/ligacao");
  assert.equal(r.status, 200);
  const t = tarefas("l_c1");
  const lig = t.filter(x => x.criterio === "ligacao");
  assert.ok(lig.find(x => x.acao === undefined || x.titulo === "Ligar para o cliente").feito_em, "a ligação de hoje não concluiu");
  assert.equal(lig.find(x => x.titulo === "Ligar de novo").feito_em, null, "a ligação de hoje concluiu a de amanhã");
  assert.equal(lig.find(x => x.titulo === "Ligar para o cliente").concluida_por, "ligacao");
  // A tentativa sem resposta não é conversa.
  assert.equal(t.find(x => x.criterio === "conversa").feito_em, null);
});

await caso("5. Mensagem conclui 'mensagem'; só a resposta do cliente conclui 'conversa'", async () => {
  const r = await api("u_m_cad", "POST", "/leads/l_c1/messages", { text: "Oi! Segue a apresentação." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let t = tarefas("l_c1");
  assert.ok(t.find(x => x.criterio === "mensagem").feito_em, "mensagem enviada não concluiu");
  assert.equal(t.find(x => x.criterio === "conversa").feito_em, null, "texto unilateral contou como conversa");
  const l = db.prepare("SELECT * FROM leads WHERE id = 'l_c1'").get();
  await processarMensagemRecebida({ canal: canalDaCasa(org), evento: "messages", phone: l.phone, texto: "Recebi, obrigado!",
    tipo: "text", content: {}, temMidia: false, fromMe: false, messageid: "in_cad_1", nome: l.name });
  t = tarefas("l_c1");
  assert.ok(t.find(x => x.criterio === "conversa").feito_em, "a resposta do cliente não concluiu a conversa");
});

await caso("6. Ligação atendida conclui 'conversa'", async () => {
  lead("l_c2", "u_m_cad"); await mover("u_m_cad", "l_c2", eAtend);
  const r = await api("u_m_cad", "POST", "/leads/l_c2/ligacao");
  let t = tarefas("l_c2");
  assert.equal(t.find(x => x.criterio === "conversa").feito_em, null);
  await api("u_m_cad", "PATCH", `/leads/l_c2/ligacao/${r.body.ligacao_id}`, { resultado: "nao_atendeu" });
  assert.equal(tarefas("l_c2").find(x => x.criterio === "conversa").feito_em, null, "ligação não atendida contou como conversa");
  const r2 = await api("u_m_cad", "POST", "/leads/l_c2/ligacao");
  await api("u_m_cad", "PATCH", `/leads/l_c2/ligacao/${r2.body.ligacao_id}`, { resultado: "falou" });
  assert.ok(tarefas("l_c2").find(x => x.criterio === "conversa").feito_em);
});

await caso("7. Não segura o prazo; vai com o lead no repasse; à mão fica registrado", async () => {
  lead("l_c3", "u_m_cad"); await mover("u_m_cad", "l_c3", eAtend);
  assert.ok(!leadsComTarefaFutura(org).has("l_c3"), "tarefa da cadência segurou o prazo da etapa");
  let r = await api("u_g_cad", "POST", "/distribution/transfer", { lead_id: "l_c3", user_id: "u_b_cad" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(tarefas("l_c3").filter(t => !t.feito_em).every(t => t.user_id === "u_b_cad"));
  const t = tarefas("l_c3")[0];
  r = await api("u_b_cad", "PATCH", `/tarefas/${t.id}`, { feito: true });
  assert.equal(r.status, 200);
  const depois = db.prepare("SELECT concluida_por, concluida_user FROM tarefas WHERE id = ?").get(t.id);
  assert.equal(depois.concluida_por, "manual"); assert.equal(depois.concluida_user, "u_b_cad");
  r = await api("u_b_cad", "GET", "/leads/l_c3/tarefas");
  assert.ok(r.body.tarefas.some(x => x.da_cadencia && x.criterio));
});

await caso("8. Novo lead: nasce na etapa com a cadência, pela catraca, e o e-mail é conferido", async () => {
  let r = await api("u_g_cad", "POST", "/leads", { nome: "Pela Catraca", telefone: "87 99777-1234", email: "nao-e-email" });
  assert.equal(r.status, 400); assert.match(r.body.error, /e-mail/);
  r = await api("u_g_cad", "POST", "/leads", { nome: "Pela Catraca", telefone: "87 99777-1234", email: "cli@ex.com",
    stage_id: eAtend.id, assigned_to: "catraca:principal" });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  const l = db.prepare("SELECT * FROM leads WHERE phone = '5587997771234'").get();
  assert.ok(["u_m_cad", "u_b_cad"].includes(l.assigned_to), "não foi para um corretor da catraca");
  assert.equal(l.email, "cli@ex.com");
  assert.equal(tarefas(l.id).length, 4, "nasceu na etapa e não ganhou a cadência");
  r = await api("u_g_cad", "POST", "/leads", { nome: "X", telefone: "87 99777-1299", assigned_to: "catraca:nao-existe" });
  assert.equal(r.status, 400);
});

console.log(falhas ? `\n${falhas} caso(s) falharam ❌` : "\nTudo certo ✅");
uaz.close();
process.exit(falhas ? 1 : 0);
