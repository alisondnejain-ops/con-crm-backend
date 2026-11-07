/* A SEGUNDA LISTA DO FERNANDO (07/11/2026).

   1. Mensagem agendada com foto: sai como foto, com a legenda, na hora marcada.
   2. Resposta de botão (ButtonsResponseMessage) entra na conversa com o texto
      do botão.
   3. Anúncio de clique-para-WhatsApp: o lead nasce com o anúncio gravado.
   4. Etapa "ao pegar, mover para": a primeira mensagem do dono move o lead.
   5. Catraca com um número específico: o lead que nasce nele vai pela
      catraca, e não para o dono da linha.
   6. Gatilho com número: a palavra no número errado não liga o fluxo.
   7. Ficha do cliente: os campos novos gravam; chave desconhecida é ignorada.

   Rodar: npm run teste:lista-fernando-2 */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-lista-fernando-2.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4813";
for (const k of ["AGENDADAS_AGENDADOR", "MARKETING_AGENDADOR", "PRAZO_AGENDADOR", "CATRACA_TEMPO_AGENDADOR", "REDES_AGENDADOR", "FOTOS_AGENDADOR"]) process.env[k] = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const PORTA_UAZ = 4814;
const enviados = [];
const uaz = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => (corpo += c));
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(corpo || "{}"); } catch {}
    if (req.url.startsWith("/send/")) enviados.push({ url: req.url, ...j });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messageid: "wa_l2_" + enviados.length }));
  });
});
await new Promise(r => uaz.listen(PORTA_UAZ, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { processarAgendadas } = await import("../src/services/agendadas.js");
const { sign } = await import("../src/auth.js");
const P = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4813";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)")
  .run(org, "Casa L2", "L2-1", Date.now(), `http://127.0.0.1:${PORTA_UAZ}`, "tok-casa-l2");
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at) VALUES (?,?,'imobiliaria',?,?,1,?)`)
  .run("cn_casa_l2", org, `http://127.0.0.1:${PORTA_UAZ}`, "tok-casa-l2", Date.now());
P.garantirPipelinePadrao(org);
const funil = P.pipelinePadrao(org);
const etapas = P.etapasDoPipeline(org, funil.id);
const etapaLead = etapas.find(e => e.name === "Lead"), etapaAt = etapas.find(e => e.name === "Atendimento");

const novo = (id, nome, papel) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, id + "@l2.com", papel, Date.now());
novo("u_g_l2", "Gestora", "adm"); novo("u_m_l2", "Marina", "corretor"); novo("u_b_l2", "Bruno", "corretor");
db.prepare("INSERT INTO org_recursos (org_id, recurso, master) VALUES (?, 'marketing', 'liberado')").run(org);
const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(BASE + p, { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const lead = (dono, stageId = etapaLead.id) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,stage_id,pipeline_id,created_at,assigned_to,assigned_at,source)
    VALUES (?,?,?,?,'{}','Lead',?,?,?,?,?,'whatsapp')`).run(id, org, "Cliente " + (++n), "5587991" + String(200000 + n), stageId, funil.id, Date.now(), dono, Date.now());
  return id; };
const entregar = (token, msg) => fetch(`${BASE}/webhooks/uazapi`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ token, message: msg }) });
const espera = (ms) => new Promise(r => setTimeout(r, ms));

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); }
}

await caso("1. Agendada com foto sai como foto, com legenda", async () => {
  const L = lead("u_m_l2");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const r = await api("u_m_l2", "POST", `/leads/${L}/agendadas`, { texto: "Olha essa", quando: Date.now() + 120000,
    arquivo: { base64: png, mime: "image/png", nome: "casa.png" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.agendada.midia_mime, "image/png");
  db.prepare("UPDATE mensagens_agendadas SET quando = ? WHERE id = ?").run(Date.now() - 1000, r.body.agendada.id);
  const antes = enviados.length;
  await processarAgendadas();
  const e = enviados.slice(antes);
  assert.equal(e.length, 1, JSON.stringify(e));
  assert.match(e[0].url, /media/);
  const m = db.prepare("SELECT body, media_mime FROM messages WHERE lead_id = ? AND direction = 'out'").get(L);
  assert.equal(m.media_mime, "image/png");
  assert.match(m.body, /Olha essa/);
});

await caso("2. Resposta de botão entra com o texto do botão", async () => {
  const L = lead("u_m_l2");
  const tel = db.prepare("SELECT phone FROM leads WHERE id = ?").get(L).phone;
  await entregar("tok-casa-l2", { chatid: tel + "@s.whatsapp.net", fromMe: false, messageid: "3EBBOTAO1",
    messageType: "ButtonsResponseMessage", content: { selectedDisplayText: "Sim, quero visitar", selectedButtonID: "b1" } });
  await espera(300);
  const m = db.prepare("SELECT body FROM messages WHERE lead_id = ? AND direction = 'in'").get(L);
  assert.equal(m && m.body, "Sim, quero visitar");
});

await caso("3. Anúncio de clique-para-WhatsApp fica no lead", async () => {
  await entregar("tok-casa-l2", { chatid: "5587999990001@s.whatsapp.net", fromMe: false, messageid: "3EBANUNCIO1", text: "Olá, vi o anúncio",
    content: { text: "Olá, vi o anúncio", contextInfo: { externalAdReply: { sourceId: "120210000000001", sourceType: "ad", title: "Casa no Jardins" } } } });
  await espera(300);
  const l = db.prepare("SELECT ad_id, ad_name, origem FROM leads WHERE phone = '5587999990001' AND org_id = ?").get(org);
  assert.ok(l, "o lead nasceu");
  assert.equal(l.ad_id, "120210000000001");
  assert.equal(l.ad_name, "Casa no Jardins");
  assert.equal(l.origem, "Anúncio (WhatsApp)");
});

await caso("4. Ao pegar o lead na etapa, ele vai para a etapa escolhida", async () => {
  const r = P.editarEtapa(org, etapaLead.id, { automation_config: { ao_pegar_mover_para: etapaAt.id } });
  assert.ok(!r.erro, r.erro);
  const L = lead("u_m_l2");
  const x = await api("u_m_l2", "POST", `/leads/${L}/messages`, { text: "Oi, tudo bem?" });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal(db.prepare("SELECT stage_id FROM leads WHERE id = ?").get(L).stage_id, etapaAt.id);
  // Outra pessoa (a gestão) escrevendo não move.
  const L2 = lead("u_m_l2");
  await api("u_g_l2", "POST", `/leads/${L2}/messages`, { text: "Oi" });
  assert.equal(db.prepare("SELECT stage_id FROM leads WHERE id = ?").get(L2).stage_id, etapaLead.id);
  P.editarEtapa(org, etapaLead.id, { automation_config: {} });
});

await caso("5. Número da catraca: o lead vai pela catraca, não para o dono da linha", async () => {
  db.prepare(`INSERT INTO canais (id,org_id,tipo,user_id,nome,host,token,ativo,created_at) VALUES (?,?,'corretor',?,?,?,?,1,?)`)
    .run("cn_m_l2", org, "u_m_l2", "Marina", `http://127.0.0.1:${PORTA_UAZ}`, "tok-marina-l2", Date.now());
  const r = await api("u_g_l2", "POST", "/distribution/catracas", { nome: "Anúncio Marina", entrega: "corretor", membros: ["u_b_l2"],
    canais: { linhas: ["cn_m_l2"] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // O corte do expediente pode ter desmarcado a prontidão no start do servidor.
  db.prepare("UPDATE users SET available = 1 WHERE id = 'u_b_l2'").run();
  await entregar("tok-marina-l2", { chatid: "5587999990002@s.whatsapp.net", fromMe: false, messageid: "3EBLINHA1", text: "Oi" });
  await espera(300);
  const l = db.prepare("SELECT assigned_to, catraca_id FROM leads WHERE phone = '5587999990002'").get();
  assert.equal(l.assigned_to, "u_b_l2");
  assert.equal(l.catraca_id, r.body.id);
});

await caso("6. Gatilho com número: só o que chega por ele liga o fluxo", async () => {
  const { gatilhoLimpo } = await import("../src/services/automacoes.js");
  assert.equal(gatilhoLimpo({ tipo: "palavra", palavras: ["valor"], linha: "casa" }).linha, "casa");
  assert.equal(gatilhoLimpo({ tipo: "palavra", palavras: ["valor"], linha: "x y" }).linha, "");
  assert.equal(gatilhoLimpo({ tipo: "etapa", linha: "casa" }).linha, undefined);
});

await caso("7. Ficha do cliente grava os campos novos", async () => {
  const L = lead("u_m_l2");
  const r = await api("u_m_l2", "PATCH", `/leads/${L}/qualificacao`, { motivacao: "Casar em março", quartos: "3", parcela: "R$ 2.500", inventado: "x" });
  assert.equal(r.status, 200);
  assert.equal(r.body.qual.motivacao, "Casar em março");
  assert.equal(r.body.qual.parcela, "R$ 2.500");
  assert.equal(r.body.qual.inventado, undefined);
});

console.log(falhas ? `\n${falhas} caso(s) falharam.` : "\nOK — a segunda lista do Fernando.");
process.exit(falhas ? 1 : 0);
