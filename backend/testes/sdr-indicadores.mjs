/* INDICADORES DO SDR (31/10/2026, primeira versão para o Fernando).

   1. Os números são DA atendente: recebidos, contatados, 1ª resposta,
      responderam, qualificados, repassados ao corretor e perdidos.
   2. Por origem, sobre os leads que passaram pelas atendentes.
   3. Quem supervisiona (gestão e atendente) vê; o corretor não.

   Rodar:  npm run teste:sdr-indicadores */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-sdr.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4819";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const P = await import("../src/services/pipelines.js");
const BASE = "http://localhost:4819";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_sdr1";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,wa_number) VALUES (?,?,?,?,?)").run(org, "Imobiliária Lua", "LUA-1", Date.now(), "");
P.garantirPipelinePadrao(org);
let ordem = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@lua.com", senha, role, Date.now() + (++ordem));
  return id; };
pessoa("Gestora", "adm"); const vanessa = pessoa("Vanessa", "sdr"); const bia = pessoa("Bia", "sdr");
const marina = pessoa("Marina", "corretor");
const pl = P.pipelinePadrao(org);
const qual = P.criarEtapa(org, pl.id, { name: "Lead qualificado", status_type: "aberto" });
const perda = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id = ? AND status_type = 'perdido'").get(pl.id);

const entrar = async (n) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: n.toLowerCase() + "@lua.com", password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tG = await entrar("Gestora"), tV = await entrar("Vanessa"), tM = await entrar("Marina");

const agora = Date.now(), MIN = 60000;
const lead = (nome, origem, source) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at,origem,source,pipeline_id)
    VALUES (?,?,?,?,'{}','Lead',?,?,?,?,?,?)`).run(id, org, nome, "55879912" + String(ordem++).padStart(5, "0"), agora - 60 * MIN, vanessa, agora - 60 * MIN, origem, source, pl.id);
  return id; };
const msg = (leadId, dir, quem, quando, body = "oi") => db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,body,created_at)
  VALUES (?,?,?,?,?,?)`).run("m_" + randomUUID(), leadId, dir, quem, body, quando);

// L1: falou em 10 min, cliente respondeu, qualificou e repassou à Marina.
const l1 = lead("Ana", null, "meta");
msg(l1, "out", vanessa, agora - 50 * MIN); msg(l1, "in", null, agora - 45 * MIN);
// L2: falou em 30 min, sem resposta; perdido.
const l2 = lead("Bruno", null, "whatsapp");
msg(l2, "out", vanessa, agora - 30 * MIN);
// L3: ninguém falou ainda.
lead("Carla", null, "whatsapp");

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }

console.log("Indicadores do SDR");
await caso("1. Os números da atendente", async () => {
  const rq = await chamar(tV, `/leads/${l1}/stage`, "PATCH", { stage_id: qual.etapa ? qual.etapa.id : qual.id });
  assert.equal(rq.status, 200, JSON.stringify(rq.d));
  // O corte do fim do expediente desliga quem ficou disponível antes dele; disponível agora vale.
  db.prepare("UPDATE users SET available = 1, available_desde = ? WHERE id = ?").run(Date.now(), marina);
  const rt = await chamar(tV, "/distribution/transfer", "POST", { lead_id: l1, user_id: marina });
  assert.equal(rt.status, 200, JSON.stringify(rt.d));
  const rp = await chamar(tV, `/leads/${l2}/stage`, "PATCH", { stage_id: perda.id });
  assert.equal(rp.status, 200, JSON.stringify(rp.d));
  const r = await chamar(tG, "/reports/sdr?periodo=hoje");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const v = r.d.por_pessoa.find(p => p.id === vanessa);
  assert.ok(v, JSON.stringify(r.d));
  assert.equal(v.recebidos, 3);
  assert.equal(v.contatados, 2);
  assert.equal(v.primeira_resposta_mediana_min, 20, "mediana de 10 e 30 minutos");
  assert.equal(v.responderam, 1); assert.equal(v.taxa_resposta, 50);
  assert.equal(v.qualificados, 1); assert.equal(v.taxa_qualificacao, 50);
  assert.equal(v.repassados_ao_corretor, 1);
  assert.equal(v.perdidos, 1);
  const b = r.d.por_pessoa.find(p => p.id === bia);
  assert.equal(b.contatados, 0); assert.equal(b.taxa_qualificacao, null, "sem base é nulo, não 0%");
});
await caso("2. Por origem", async () => {
  const r = await chamar(tG, "/reports/sdr?periodo=hoje");
  const meta = r.d.por_origem.find(o => o.origem === "Anúncio (Meta)");
  const wpp = r.d.por_origem.find(o => o.origem === "WhatsApp");
  assert.equal(meta.recebidos, 1); assert.equal(meta.qualificados, 1); assert.equal(meta.taxa_qualificacao, 100);
  assert.equal(wpp.recebidos, 2); assert.equal(wpp.contatados, 1); assert.equal(wpp.qualificados, 0);
});
await caso("3. A atendente vê; o corretor não", async () => {
  const v = await chamar(tV, "/reports/sdr?periodo=hoje");
  assert.equal(v.status, 200); assert.equal(v.d.por_pessoa.length, 2);
  assert.equal((await chamar(tM, "/reports/sdr?periodo=hoje")).status, 403);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
