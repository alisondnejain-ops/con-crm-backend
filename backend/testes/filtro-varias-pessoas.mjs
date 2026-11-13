/* FILTRO DE VÁRIAS PESSOAS (CETRO 04.1, 13/11/2026) e agendadas canceladas
   no repasse (CETRO 07.7).

   Confere: duas pessoas no filtro são a UNIÃO (os números somam quando os
   leads são diferentes, e o lead que passou pelas duas conta uma vez); a
   fila entra junto; o corretor que manda outras pessoas continua vendo só
   ele; a caixa (/leads?atendente=) aceita várias; a meta de várias pessoas é
   a soma das metas delas; e a mensagem agendada pelo dono anterior é
   cancelada, com motivo, no repasse.

   Rodar:  npm run teste:filtro-varias-pessoas
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-filtro-varias.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

const PORTA = 4797;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "T-1",
         ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456", UAZAPI_AUTOCONFIGURAR: "0", AGENDADAS_AGENDADOR: "0" },
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
const blanca = pessoa("Blanca", "corretor"), sil = pessoa("Sil", "corretor"), rui = pessoa("Rui", "corretor");

const entrar = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const tG = await entrar("ali@teste.com"), tB = await entrar("blanca@teste.com");
const pedir = async (t, metodo, p, corpo) => { const r = await fetch(url(p), { method: metodo,
  headers: { "Content-Type": "application/json", authorization: "Bearer " + t }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };

let n = 0;
const agora = Date.now();
const lead = (dono, venda = null) => { const id = "l_" + randomUUID(); n++;
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at,sale_date,sale_value)
    VALUES (?,?,?,?,'{}','Atendimento',?,?,?,?,?)`).run(id, org, "Cliente " + n, "55879920000" + String(n).padStart(2, "0"),
    agora - 3600000, dono, dono ? agora - 3600000 : null, venda ? agora - 1800000 : null, venda);
  return id; };
lead(blanca, 200000); lead(blanca); lead(sil, 300000); lead(sil); lead(sil); lead(rui); lead(null);

const geral = async (t, resp) => (await pedir(t, "GET", `/painel/geral?periodo=mes${resp ? "&responsavel=" + resp : ""}`)).d;
const k = (g) => ({ leads: g.kpis.leads.atual, vendas: g.kpis.vendas.atual, vgv: g.kpis.vgv.atual });

console.log("1. Duas pessoas = a soma das duas (leads diferentes)");
const gB = k(await geral(tG, blanca)), gS = k(await geral(tG, sil)), gBS = k(await geral(tG, `${blanca},${sil}`));
console.log("  ", JSON.stringify({ gB, gS, gBS }));
assert.equal(gBS.leads, gB.leads + gS.leads);
assert.equal(gBS.vendas, gB.vendas + gS.vendas);
assert.equal(gBS.vgv, gB.vgv + gS.vgv);
assert.equal(gBS.leads, 5);

console.log("2. A fila entra junto (união)");
const gBF = k(await geral(tG, `${blanca},fila`));
assert.equal(gBF.leads, gB.leads + 1);

console.log("2b. A Operação diz o mesmo número de recebidos que o Painel");
const op = async (resp) => (await pedir(tG, "GET", `/painel?periodo=mes&responsavel=${resp}`)).d.atendimento.recebidos;
assert.equal(await op(`${blanca},${sil}`), gBS.leads);
assert.equal(await op(`${blanca},fila`), gBF.leads);

console.log("3. O lead que passou pelas duas conta UMA vez");
const movido = lead(blanca);
let r = await pedir(tG, "POST", "/distribution/transfer", { lead_id: movido, user_id: sil });
assert.equal(r.status, 200, JSON.stringify(r.d));
const gB2 = k(await geral(tG, blanca)), gS2 = k(await geral(tG, sil)), gBS2 = k(await geral(tG, `${blanca},${sil}`));
assert.equal(gB2.leads, gB.leads + 1);
assert.equal(gS2.leads, gS.leads + 1);
assert.equal(gBS2.leads, gBS.leads + 1, "o lead repassado entre as duas contou duas vezes");

console.log("4. Corretor pedindo outras pessoas continua vendo só ele");
const gCorretor = k(await geral(tB, `${sil},${rui}`));
assert.deepEqual(gCorretor, k(await geral(tB)));
assert.equal(gCorretor.leads, gB2.leads);

console.log("5. A caixa aceita várias pessoas e a fila");
r = await pedir(tG, "GET", `/leads?atendente=${rui},fila`);
const donos = new Set(r.d.map(l => l.assigned_to));
assert.deepEqual([...donos].sort(), [null, rui].sort());

console.log("6. Meta de várias pessoas = soma das metas delas");
const mes = new Date().toISOString().slice(0, 7);
assert.equal((await pedir(tG, "POST", "/painel/metas", { user_id: blanca, mes, trabalhados: 10 })).status, 200);
assert.equal((await pedir(tG, "POST", "/painel/metas", { user_id: sil, mes, trabalhados: 5, ligacoes: 7 })).status, 200);
const metas = (await geral(tG, `${blanca},${sil}`)).metas.itens;
const m = (c) => metas.find(i => i.campo === c).meta;
assert.equal(m("trabalhados"), 15);
assert.equal(m("ligacoes"), 7);
assert.equal(m("propostas"), null, "campo que ninguém definiu tem que continuar sem meta");

console.log("7. A agendada do dono anterior é cancelada no repasse, com motivo");
const l2 = lead(blanca);
const ag = "ag_" + randomUUID();
db.prepare(`INSERT INTO mensagens_agendadas (id,org_id,lead_id,user_id,texto,quando,status,created_at)
  VALUES (?,?,?,?,?,?,'pendente',?)`).run(ag, org, l2, blanca, "Oi!", agora + 86400000, agora);
r = await pedir(tG, "POST", "/distribution/transfer", { lead_id: l2, user_id: rui });
assert.equal(r.status, 200);
const linha = db.prepare("SELECT status, motivo FROM mensagens_agendadas WHERE id = ?").get(ag);
assert.equal(linha.status, "cancelada");
assert.match(linha.motivo, /passou para outra pessoa/);

console.log("\nTudo certo ✅");
fim(0);
