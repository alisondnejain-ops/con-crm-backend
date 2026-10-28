/* MENSAGEM AGENDADA NA CONVERSA E DUPLICAR FLUXO (28/10/2026, lista do Fernando).

   O que este teste protege:
   1. Agendar: horário no passado, texto vazio e lead de outra pessoa são recusados.
   2. Na hora marcada sai pelo MESMO envio do botão Enviar: assinada, gravada na
      conversa com o autor, e uma vez só (dois ciclos não mandam duas vezes).
   3. Antes da hora não sai nada; cancelada não sai.
   4. Lead repassado a outra pessoa antes da hora: não sai, e o motivo fica escrito.
   5. WhatsApp recusou: "falhou" com o motivo, sem tentar de novo.
   6. Duplicar fluxo: cópia com os mesmos blocos, nome "Cópia de …", desligada.

   Servidor de pé (no mesmo processo) e uma Uazapi de mentira.
   Rodar:  npm run teste:mensagem-agendada */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-mensagem-agendada.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4645";
process.env.AGENDADAS_AGENDADOR = "0";
process.env.MARKETING_AGENDADOR = "0";
process.env.PRAZO_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

// Uazapi de mentira: guarda o que foi enviado; `recusar` faz o próximo envio falhar.
const PORTA_UAZ = 4646;
const enviados = [];
let recusar = false;
const uaz = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => (corpo += c));
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(corpo || "{}"); } catch {}
    if (req.url.startsWith("/send/")) {
      if (recusar) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "instância desconectada" })); }
      enviados.push(j);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messageid: "wa_ag_" + enviados.length }));
  });
});
await new Promise(r => uaz.listen(PORTA_UAZ, r));

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const { processarAgendadas } = await import("../src/services/agendadas.js");
const { sign } = await import("../src/auth.js");
const BASE = "http://localhost:4645";
await new Promise(r => setTimeout(r, 700));

const org = db.prepare("SELECT id FROM orgs WHERE demo IS NULL OR demo = 0 ORDER BY created_at LIMIT 1").get().id;
db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token='token-casa' WHERE id=?").run(`http://127.0.0.1:${PORTA_UAZ}`, org);
const novo = (id, nome, papel) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x',?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@ag.com", papel, Date.now());
novo("u_gestor_ag", "Gestora", "adm"); novo("u_marina_ag", "Marina Lopes", "corretor"); novo("u_bruno_ag", "Bruno", "corretor");
const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(BASE + p, { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const lead = (id, dono) => db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to)
  VALUES (?,?,?,?,'{}','Lead',?,?)`).run(id, org, "Cliente " + id, "55879912" + String(30000 + Math.floor(Math.random() * 60000)), Date.now(), dono);
lead("l_ag1", "u_marina_ag"); lead("l_ag2", "u_marina_ag"); lead("l_ag3", "u_marina_ag");
const vencer = (id) => db.prepare("UPDATE mensagens_agendadas SET quando = ? WHERE id = ?").run(Date.now() - 1000, id);
const linha = (id) => db.prepare("SELECT * FROM mensagens_agendadas WHERE id = ?").get(id);

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); }
}
const daqui = (min) => Date.now() + min * 60000;

console.log("Mensagem agendada e duplicar fluxo");
await caso("1. Recusas: passado, vazio, lead de outra pessoa", async () => {
  let r = await api("u_marina_ag", "POST", "/leads/l_ag1/agendadas", { texto: "Oi", quando: Date.now() - 60000 });
  assert.equal(r.status, 400); assert.match(r.body.error, /1 minuto/);
  r = await api("u_marina_ag", "POST", "/leads/l_ag1/agendadas", { texto: "  ", quando: daqui(60) });
  assert.equal(r.status, 400);
  r = await api("u_bruno_ag", "POST", "/leads/l_ag1/agendadas", { texto: "Oi", quando: daqui(60) });
  assert.equal(r.status, 403);
});

let ag1;
await caso("2. Antes da hora não sai; na hora sai assinada, gravada e uma vez só", async () => {
  const r = await api("u_marina_ag", "POST", "/leads/l_ag1/agendadas", { texto: "Bom dia! Conseguiu ver a simulação?", quando: daqui(60) });
  assert.equal(r.status, 200, JSON.stringify(r.body)); ag1 = r.body.agendada.id;
  assert.equal(r.body.agendadas.length, 1);
  await processarAgendadas();
  assert.equal(enviados.length, 0, "não sai antes da hora");
  vencer(ag1);
  await Promise.all([processarAgendadas(), processarAgendadas()]);
  await processarAgendadas();
  assert.equal(enviados.length, 1, "uma vez só");
  assert.match(enviados[0].text, /^\*Marina:\*/, "assinada como no botão Enviar");
  assert.match(enviados[0].text, /simulação/);
  assert.equal(linha(ag1).status, "enviada");
  const m = db.prepare("SELECT * FROM messages WHERE lead_id='l_ag1' AND direction='out'").all();
  assert.equal(m.length, 1); assert.equal(m[0].from_user_id, "u_marina_ag");
  const lista = await api("u_marina_ag", "GET", "/leads/l_ag1/agendadas");
  assert.equal(lista.body.agendadas.length, 0, "a enviada sai da faixa (está na conversa)");
});

await caso("3. Cancelada não sai; e não cancela de novo depois", async () => {
  const r = await api("u_marina_ag", "POST", "/leads/l_ag2/agendadas", { texto: "Vou cancelar", quando: daqui(30) });
  const id = r.body.agendada.id;
  const c = await api("u_marina_ag", "DELETE", "/leads/l_ag2/agendadas/" + id);
  assert.equal(c.status, 200);
  vencer(id); await processarAgendadas();
  assert.equal(linha(id).status, "cancelada");
  assert.equal(enviados.length, 1);
  const de2 = await api("u_marina_ag", "DELETE", "/leads/l_ag2/agendadas/" + id);
  assert.equal(de2.status, 409);
});

await caso("4. Lead repassado antes da hora: não sai, motivo escrito", async () => {
  const r = await api("u_marina_ag", "POST", "/leads/l_ag3/agendadas", { texto: "Oi de novo", quando: daqui(30) });
  const id = r.body.agendada.id;
  db.prepare("UPDATE leads SET assigned_to='u_bruno_ag' WHERE id='l_ag3'").run();
  vencer(id); await processarAgendadas();
  assert.equal(linha(id).status, "cancelada");
  assert.match(linha(id).motivo, /não está mais com quem agendou/);
  assert.equal(enviados.length, 1);
  db.prepare("UPDATE leads SET assigned_to='u_marina_ag' WHERE id='l_ag3'").run();
});

await caso("5. WhatsApp recusou: falhou com o motivo, sem tentar de novo", async () => {
  const r = await api("u_gestor_ag", "POST", "/leads/l_ag3/agendadas", { texto: "Pela gestão", quando: daqui(30) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.agendada.id;
  recusar = true; vencer(id); await processarAgendadas(); recusar = false;
  assert.equal(linha(id).status, "falhou");
  assert.match(linha(id).motivo, /WhatsApp não aceitou/);
  await processarAgendadas();
  assert.equal(enviados.length, 1, "não tenta de novo");
  const lista = await api("u_marina_ag", "GET", "/leads/l_ag3/agendadas");
  assert.ok(lista.body.agendadas.some(a => a.id === id && a.status === "falhou"), "a falha aparece na faixa");
});

await caso("6. Duplicar fluxo: mesmos blocos, nome 'Cópia de', desligado", async () => {
  db.prepare("INSERT OR REPLACE INTO org_recursos (org_id, recurso, master) VALUES (?, 'marketing', 'liberado')").run(org);
  const t = await api("u_gestor_ag", "POST", "/marketing/termo", { aceito: true });
  assert.ok(t.status < 300, "termo: " + JSON.stringify(t.body));
  const f = await api("u_gestor_ag", "POST", "/marketing/fluxos", { nome: "Boas-vindas" });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  const grafo = f.body.grafo;
  grafo.nos.push({ id: "n_msg", tipo: "mensagem", x: 300, y: 100, dados: { texto: "Olá {nome}!" } });
  const ini = grafo.nos.find(n => n.tipo === "inicio");
  grafo.ligacoes = [...(grafo.ligacoes || []), { de: ini.id, saida: "depois", para: "n_msg" }];
  const salvo = await api("u_gestor_ag", "PUT", "/marketing/fluxos/" + f.body.id, { nome: "Boas-vindas", grafo });
  assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
  const d = await api("u_gestor_ag", "POST", `/marketing/fluxos/${f.body.id}/duplicar`);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.nome, "Cópia de Boas-vindas");
  assert.notEqual(d.body.id, f.body.id);
  assert.equal(d.body.ativo, false);
  assert.equal(d.body.grafo.nos.length, salvo.body.grafo.nos.length);
  assert.ok(d.body.grafo.nos.some(n => n.tipo === "mensagem" && n.dados.texto === "Olá {nome}!"));
  const outra = await api("u_marina_ag", "POST", `/marketing/fluxos/${f.body.id}/duplicar`);
  assert.equal(outra.status, 403, "corretor não duplica");
});

console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
uaz.close();
process.exit(falhas ? 1 : 0);
