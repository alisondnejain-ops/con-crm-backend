/* UNIR LEADS DUPLICADOS (03/11/2026, leads da VJ em dobro).

   Confere: a leitura do número argentino escrito do jeito local; a prévia
   acha os pares pelo MESMO celular (e não por final de número parecido nem
   pelo par marcado "não é a mesma pessoa"); só o gestor usa o lote; a junção
   leva conversa, observação, tarefa e etiqueta para o lead que fica, completa
   o que falta, mantém a origem de quem entrou primeiro, guarda a cópia
   apagada e deixa o telefone do WhatsApp — a próxima mensagem cai no lead
   certo; e o "unir" da ficha.

   Rodar:  npm run teste:unir-leads
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-unir-leads.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

console.log("1. O número argentino escrito do jeito local vira o do WhatsApp");
const { normalizePhone } = await import("../src/services/stages.js");
const { normalizarPeloPadrao, leadPorTelefone } = await import("../src/services/telefone.js");
const casos = [["0381 15 477-9714", "AR"], ["381 15 4779714", "AR"], ["+54 381 15 4779714", "BR"],
  ["+54 0381 4779714", "BR"], ["11 15 2345-6789", "AR"], ["3814779714", "AR"]];
for (const [x, p] of casos) {
  const esperado = x.includes("11 15") ? "5491123456789" : "5493814779714";
  assert.equal(normalizePhone(x, { pais: p }), esperado, x);
}
assert.equal(normalizarPeloPadrao("0381 15 477-9714", "AR"), "5493814779714");
// O que chega do WhatsApp continua como veio.
assert.equal(normalizePhone("54381154779714", { comCodigo: true }), "54381154779714");
// Brasileiro igual a sempre.
assert.equal(normalizePhone("(87) 9 9111-2222"), "5587991112222");
console.log("   ok");

const PORTA = 4797;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "T-1",
         ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456", UAZAPI_AUTOCONFIGURAR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (c) => { servidor.kill("SIGTERM"); process.exit(c); };
process.on("uncaughtException", e => { console.error("\n" + e.message); console.error(saida.slice(-1500)); fim(1); });
process.on("unhandledRejection", e => { console.error("\n" + (e && e.message)); console.error(saida.slice(-1500)); fim(1); });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}
const { default: db } = await import("../src/db.js");
const bcrypt = (await import("bcryptjs")).default;
const org = db.prepare("SELECT id FROM orgs WHERE adm_code = 'T-1'").get().id;
const senha = bcrypt.hashSync("123456", 8);
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@teste.com", senha, role, Date.now());
  return id; };
const marina = pessoa("Marina", "corretor");
pessoa("Vanessa", "sdr");
const entrar = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tG = await entrar("ali@teste.com"), tM = await entrar("marina@teste.com"), tV = await entrar("vanessa@teste.com");
const pedir = async (t, metodo, p, corpo) => { const r = await fetch(url(p), { method: metodo,
  headers: { "Content-Type": "application/json", authorization: "Bearer " + t }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };

const H = 3600000;
const lead = (dados) => { const id = "l_" + randomUUID();
  const d = { name: "Cliente", phone: null, source: null, campaign_name: null, assigned_to: null, assigned_at: null,
    created_at: Date.now() - H, qual_json: "{}", stage: "Lead", email: null, ...dados };
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at,source,campaign_name,email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, org, d.name, d.phone, d.qual_json, d.stage, d.created_at, d.assigned_to,
    d.assigned_at, d.source, d.campaign_name, d.email);
  return id; };
const msg = (leadId, dir, quando, body) => db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at)
  VALUES (?,?,?,?,?)`).run("m_" + randomUUID(), leadId, dir, body, quando);

// O caso da VJ: o formulário gravou o número local; o WhatsApp criou outro.
const form = lead({ name: "Ale Abraham", phone: "54381154779714", source: "meta", campaign_name: "Campanha Março",
  assigned_to: marina, assigned_at: Date.now() - 30 * H, created_at: Date.now() - 30 * H,
  qual_json: JSON.stringify({ renda: "8000" }), email: "ale@exemplo.com" });
const zap = lead({ name: "5493814779714", phone: "5493814779714", source: "whatsapp", created_at: Date.now() - 20 * H,
  qual_json: JSON.stringify({ prazo: "3 meses" }) });
msg(zap, "in", Date.now() - 20 * H, "Hola, quiero información");
msg(zap, "out", Date.now() - 19 * H, "Hola Ale!");
db.prepare("INSERT INTO observacoes (id,org_id,lead_id,texto,autor_id,created_at) VALUES (?,?,?,?,?,?)")
  .run(randomUUID(), org, form, "Respostas do formulário: quer 2 quartos", null, Date.now() - 30 * H);
db.prepare("INSERT INTO tarefas (id,org_id,lead_id,user_id,titulo,quando,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(randomUUID(), org, form, marina, "Ligar", Date.now() + H, Date.now());
const tag = randomUUID();
db.prepare("INSERT INTO tags (id,org_id,nome,cor,created_at) VALUES (?,?,?,?,?)").run(tag, org, "Argentina", "#2563EB", Date.now());
for (const l of [form, zap]) db.prepare("INSERT INTO lead_tags (lead_id,tag_id,org_id,marcada_em) VALUES (?,?,?,?)").run(l, tag, org, Date.now());

// Brasileiro com e sem o nono dígito.
const br1 = lead({ name: "Paulo Lima", phone: "5587991112222", created_at: Date.now() - 10 * H });
const br2 = lead({ name: "Paulo", phone: "558791112222", created_at: Date.now() - 5 * H });
msg(br2, "in", Date.now() - 4 * H, "oi");
// Mesmo final, números diferentes: NÃO é par.
lead({ name: "Fulano", phone: "5521977779999" });
lead({ name: "Beltrano", phone: "5511977779999" });
// Par marcado "não é a mesma pessoa".
const x1 = lead({ name: "Ana", phone: "5581988887777" });
const x2 = lead({ name: "Ana Souza", phone: "5581988887777" });
db.prepare("INSERT INTO leads_nao_duplicados (org_id,lead_a,lead_b,por,em) VALUES (?,?,?,?,?)")
  .run(org, x1 < x2 ? x1 : x2, x1 < x2 ? x2 : x1, null, Date.now());

console.log("2. Só o gestor usa o lote");
let r = await pedir(tM, "GET", "/leads/lote/duplicados");
assert.equal(r.status, 403);
r = await pedir(tV, "POST", "/leads/lote/duplicados/unir", { grupos: [{ principal: zap, outros: [form] }] });
assert.equal(r.status, 403);
assert.ok(db.prepare("SELECT id FROM leads WHERE id = ?").get(form), "a atendente uniu em lote");
console.log("   ok");

console.log("3. A prévia acha os pares certos e escolhe quem fica");
r = await pedir(tG, "GET", "/leads/lote/duplicados");
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.equal(r.d.grupos.length, 2, JSON.stringify(r.d.grupos.map(g => g.leads.map(l => l.telefone))));
const gAr = r.d.grupos.find(g => g.leads.some(l => l.id === form));
assert.equal(gAr.principal_id, zap, "deveria ficar o lead em que o cliente escreve");
assert.equal(gAr.telefone_final, "5493814779714");
assert.equal(gAr.nome_final, "Ale Abraham");
const gBr = r.d.grupos.find(g => g.leads.some(l => l.id === br1));
assert.equal(gBr.principal_id, br2);
assert.equal(r.d.leads_em_dobro, 2);
r = await pedir(tG, "GET", "/leads/lote/duplicados?dias=0.1");
assert.equal(r.d.grupos.length, 0, "filtro por dias");
console.log("   ok");

console.log("4. Unir leva tudo para o lead que fica e guarda a cópia");
r = await pedir(tG, "POST", "/leads/lote/duplicados/unir", { grupos: [{ principal: zap, outros: [form] }, { principal: br2, outros: [br1] }] });
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.deepEqual([r.d.grupos, r.d.unidos, r.d.falhas.length], [2, 2, 0]);
assert.equal(db.prepare("SELECT id FROM leads WHERE id = ?").get(form), undefined, "a cópia continua lá");
const L = db.prepare("SELECT * FROM leads WHERE id = ?").get(zap);
assert.equal(L.name, "Ale Abraham", "nome de número deveria virar o nome de verdade");
assert.equal(L.phone, "5493814779714");
assert.equal(L.assigned_to, marina, "perdeu o corretor");
assert.equal(L.email, "ale@exemplo.com");
assert.equal(L.source, "meta", "a origem deveria ser a de quem entrou primeiro");
assert.equal(L.campaign_name, "Campanha Março");
assert.ok(Math.abs(L.created_at - (Date.now() - 30 * H)) < 60000, "a data de entrada deveria ser a mais antiga");
assert.deepEqual(JSON.parse(L.qual_json), { prazo: "3 meses", renda: "8000" });
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(zap).n, 2);
assert.equal(db.prepare("SELECT COUNT(*) n FROM tarefas WHERE lead_id = ?").get(zap).n, 1, "a tarefa não veio");
assert.equal(db.prepare("SELECT COUNT(*) n FROM lead_tags WHERE lead_id = ?").get(zap).n, 1, "etiqueta em dobro");
const obs = db.prepare("SELECT texto FROM observacoes WHERE lead_id = ?").all(zap).map(o => o.texto);
assert.ok(obs.some(t => t.includes("quer 2 quartos")), "a observação não veio");
assert.ok(obs.some(t => t.startsWith("Leads unidos")), "faltou o registro da junção");
const guardado = db.prepare("SELECT removido_json FROM leads_unidos WHERE removido_id = ?").get(form);
assert.equal(JSON.parse(guardado.removido_json).phone, "54381154779714", "a cópia não foi guardada");
assert.ok(db.prepare("SELECT 1 FROM leads_apagados WHERE lead_id = ?").get(form), "as telas não saberiam que a cópia saiu");
assert.equal(leadPorTelefone(db, org, "5493814779714").id, zap, "a próxima mensagem não cairia no lead certo");
assert.equal(db.prepare("SELECT phone FROM leads WHERE id = ?").get(br2).phone, "558791112222");
console.log("   ok");

console.log("5. Unir de novo o mesmo grupo não quebra nada");
r = await pedir(tG, "POST", "/leads/lote/duplicados/unir", { grupos: [{ principal: zap, outros: [form] }] });
assert.equal(r.status, 200);
assert.equal(r.d.unidos, 0);
assert.equal(r.d.falhas.length, 1);
r = await pedir(tG, "GET", "/leads/lote/duplicados");
assert.equal(r.d.grupos.length, 0);
console.log("   ok");

console.log("6. O unir da ficha: atendente pode, corretor não, número diferente não");
const f1 = lead({ name: "Fabian", phone: "541122334455" });
const f2 = lead({ name: "Fabian R", phone: "5491122334455" });
msg(f1, "in", Date.now() - H, "hola");
r = await pedir(tM, "POST", `/leads/${f1}/duplicados/${f2}/unir`);
assert.equal(r.status, 403);
const outra = lead({ name: "Fabian", phone: "5491199998888" });
r = await pedir(tV, "POST", `/leads/${f1}/duplicados/${outra}/unir`);
assert.equal(r.status, 409, "uniu dois celulares diferentes");
r = await pedir(tV, "POST", `/leads/${f2}/duplicados/${f1}/unir`);
assert.equal(r.status, 200, JSON.stringify(r.d));
assert.equal(r.d.principal_id, f1, "deveria ficar o lead em que o cliente escreve");
assert.equal(db.prepare("SELECT id FROM leads WHERE id = ?").get(f2), undefined);
console.log("   ok");

console.log("7. O aviso da ficha reconhece o número com o 15 como o mesmo celular");
const v1 = lead({ name: "Mariano", phone: "54351154441122" });
const v2 = lead({ name: "Mariano P", phone: "5493514441122" });
r = await pedir(tG, "GET", `/leads/${v2}/duplicados`);
assert.equal(r.status, 200);
const it = r.d.itens.find(x => x.id === v1);
assert.ok(it, "o aviso não achou a outra cópia");
assert.equal(it.motivo, "forma");
console.log("   ok");

console.log("\nTudo certo ✅");
fim(0);
