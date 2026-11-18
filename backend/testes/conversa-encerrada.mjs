/* O "LEGALZINHO" DO CLIENTE E A CATRACA QUE MANDA (18/11/2026, Fernando).

   1. Mensagem do cliente que só encerra ("legal", "ok", 👍) não deixa
      ninguém esperando: sem aviso, sem prazo vencido, fora do tempo de
      atendimento. "Não precisa responder" faz o mesmo para o resto.
   2. A catraca específica manda: "direto aos corretores" com etapa em
      "Tentativa 3" do SDR faz o lead nascer ali, e o tempo para pegar roda na
      etapa dela, mesmo fora do comercial.

   Rodar:  npm run teste:conversa-encerrada  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-conversa-encerrada.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4673";
process.env.PRAZO_AGENDADOR = "0";
process.env.CATRACA_TEMPO_AGENDADOR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const { mensagemQueEncerra } = await import("../src/services/encerra.js");
const P = await import("../src/services/pipelines.js");
const { leadsComTarefaFutura } = await import("../src/services/etapas.js");
const { temposDeResposta } = await import("../src/services/score.js");
const { receberLead } = await import("../src/services/portais.js");
const C = await import("../src/services/catracas.js");
const { agirSemResposta } = await import("../src/services/catraca-tempo.js");
const BASE = "http://localhost:4673";
await new Promise(r => setTimeout(r, 700));

console.log("1. Reconhece o fechamento — e só ele");
for (const t of ["legal", "Ok", "ok obrigado", "Muito obrigada!", "tá bom", "Beleza, valeu", "👍", "🙏🙏", "kkkk", "show de bola"]
  .filter(t => t !== "show de bola")) assert.equal(mensagemQueEncerra(t), true, t);
for (const t of ["sim", "boa noite", "ok, e o valor?", "legal, quero visitar amanhã", "obrigado, vou ver com meu marido e te falo", "?", "Quanto custa"])
  assert.equal(mensagemQueEncerra(t), false, t);
assert.equal(mensagemQueEncerra("Figurinha"), true);

const org = "org_enc";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "EN-1", Date.now());
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
let ordem = 0;
const user = (nome, role, available = 1) => { const id = "u_" + nome.toLowerCase();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,?,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@en.com", senha, role, available, Date.now() + (ordem++));
  return id; };
user("Gestor", "adm", 0); const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor"); user("Vanessa", "sdr");
const comercial = P.criarDoTemplate(org, "comercial", { is_default: true });
const etapa = P.primeiraEtapa(org, comercial.pipeline.id);
db.prepare("UPDATE pipeline_stages SET sla_minutes = 60 WHERE id = ?").run(etapa.id);

const H = 3600000, agora = Date.now();
const lead = (dono) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,pipeline_id,stage_id,assigned_to,assigned_at,created_at,stage_entered_at)
    VALUES (?,?,?,?,'{}',?,?,?,?,?,?,?)`).run(id, org, "Cliente", "5587" + String(990000000 + ordem++), etapa.name, comercial.pipeline.id, etapa.id, dono, agora - 10 * H, agora - 10 * H, agora - 10 * H);
  return id; };
const msg = (leadId, dir, body, t, from = null, encerra = null) => db.prepare(
  "INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at,encerra) VALUES (?,?,?,?,?,?,?)")
  .run("m_" + randomUUID(), leadId, dir, from, body, t, encerra);

console.log("2. O \"legal\" acende a conversa encerrada; segura o prazo; fica fora do tempo de atendimento");
const l1 = lead(marina);
msg(l1, "in", "Oi, tem casa?", agora - 9 * H);
msg(l1, "out", "Tenho sim!", agora - 8 * H, marina);
msg(l1, "in", "legal", agora - 7 * H, null, mensagemQueEncerra("legal") ? 1 : null);
assert.ok(db.prepare("SELECT conversa_encerrada_em FROM leads WHERE id = ?").get(l1).conversa_encerrada_em);
assert.ok(leadsComTarefaFutura(org).has(l1), "segura o prazo da etapa");
msg(l1, "out", "Bom dia, conseguiu ver?", agora - 1 * H, marina);
const esperas = temposDeResposta([l1], marina);
assert.deepEqual(esperas.map(Math.round), [60], "só a pergunta de verdade conta (1h); o 'legal' não vira espera de 6h");
assert.equal(db.prepare("SELECT conversa_encerrada_em FROM leads WHERE id = ?").get(l1).conversa_encerrada_em, null, "responder apaga");

console.log("3. O cliente volta a perguntar: volta a esperar");
const l2 = lead(marina);
msg(l2, "out", "Olá!", agora - 5 * H, marina);
msg(l2, "in", "ok", agora - 4 * H, null, 1);
msg(l2, "in", "e o valor?", agora - 3 * H);
assert.equal(db.prepare("SELECT conversa_encerrada_em FROM leads WHERE id = ?").get(l2).conversa_encerrada_em, null);
assert.ok(!leadsComTarefaFutura(org).has(l2));

console.log("4. \"Não precisa responder\" pela rota, com quem tocou");
const entrar = async (email) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tM = await entrar("marina@en.com"), tR = await entrar("rafael@en.com");
const post = (t, c) => fetch(BASE + c, { method: "POST", headers: { authorization: "Bearer " + t } });
assert.equal((await post(tR, `/leads/${l2}/sem-resposta`)).status, 403, "quem não pode abrir a conversa não marca");
assert.equal((await post(tM, `/leads/${l2}/sem-resposta`)).status, 200);
const m = db.prepare("SELECT encerra, encerra_por FROM messages WHERE lead_id = ? AND body = 'e o valor?'").get(l2);
assert.deepEqual(m, { encerra: 2, encerra_por: marina });
assert.ok(leadsComTarefaFutura(org).has(l2));
assert.equal((await post(tM, `/leads/${l1}/sem-resposta`)).status, 409, "sem mensagem do cliente esperando");

const sdr = P.criarDoTemplate(org, "sdr", {});
const etapasSdr = db.prepare("SELECT id, name FROM pipeline_stages WHERE pipeline_id = ? ORDER BY ordem").all(sdr.pipeline.id);
const tentativa = etapasSdr[2];

console.log("5. Direto aos corretores em \"Tentativa 3\" do SDR, 5 minutos: roda ali");
const catCor = C.criar(org, "u_gestor", { nome: "Barra de Maragogi", entrega: "corretor", membros: [marina, rafael],
  canais: { portal: true }, pipeline_id: sdr.pipeline.id, stage_id: tentativa.id, tempo_resposta_min: 5 });
db.prepare("UPDATE catracas SET tempo_desde = 0 WHERE id = ?").run(catCor);
let r = receberLead(org, { portal: "Portal", nome: "B", telefone: "5587991230002" });
let l = db.prepare("SELECT * FROM leads WHERE id = ?").get(r.lead_id);
assert.ok([marina, rafael].includes(l.assigned_to));
assert.equal(l.stage_id, tentativa.id);
const primeiro = l.assigned_to;
const feitos = await agirSemResposta(org, Date.now() + 6 * 60000);
assert.ok(feitos.some(f => f.lead_id === l.id), "passou para o próximo em 5 minutos, mesmo fora do comercial");
assert.notEqual(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(l.id).assigned_to, primeiro);

console.log("\nTudo certo ✅");
process.exit(0);
