/* AS CONTAS FECHAM (25/11/2026, pedido do Ali: Visão geral 1.325 recebidos no
   Braço Externo, funil 1.281 — "as contas não estão batendo").

   Confere que os recebidos do funil de conversão são EXATAMENTE os do cartão
   "Leads recebidos" da Visão geral com o mesmo funil (antes o topo ignorava o
   funil), e que a diferença para o primeiro degrau fecha:
     recebidos − ainda não entraram + recebidos antes que entraram = degrau.

   Rodar:  npm run teste:contas-fecham  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.TZ = "America/Recife";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-contas-fecham.db");
process.env.JWT_SECRET = "teste";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const P = await import("../src/services/pipelines.js");
const C = await import("../src/services/conversao.js");
const PA = await import("../src/services/painel.js");

const org = "org_cf";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "CF-1", Date.now());
const user = (nome) => { const id = "u_" + nome.toLowerCase();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@cf.com", Date.now());
  return id; };
const vero = user("Veronica"), joao = user("Joao");

const DIA = 86400000;
const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const ini = hoje.getTime() - 10 * DIA, fim = hoje.getTime() - DIA;
const PERIODO = { de: iso(ini), ate: iso(fim) };
const NO = (d) => ini + d * DIA + 10 * 3600000;
const ANTES = ini - 20 * DIA;

function funil(nome, etapas) {
  const pl = P.criarPipeline(org, { name: nome });
  const e = {};
  for (const [n, conv, tipo, entrada] of etapas)
    e[n] = P.criarEtapa(org, pl.pipeline.id, { name: n, counts_as_conversion: !!conv, status_type: tipo || "aberto",
      entrada_comercial: !!entrada }).etapa.id;
  return { id: pl.pipeline.id, e };
}
const BRACO = funil("Braço Externo", [["Novo"], ["Lead", 1, null, 1], ["Qualificado", 1], ["Venda", 1, "ganho"], ["Perdido", 0, "perdido"]]);
const OUTRO = funil("Locação", [["Novo"], ["Lead", 1, null, 1], ["Locado", 1, "ganho"]]);

let seq = 0;
function lead(F, etapa, criado, dono) {
  const id = "l_" + (++seq);
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,stage_id,pipeline_id,assigned_to,assigned_at,created_at,stage_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, org, "Lead " + seq, "558799" + String(seq).padStart(6, "0"), etapa,
    F.e[etapa], F.id, dono, criado, criado, criado);
  return id;
}
function mover(F, id, etapa, t) {
  const l = db.prepare("SELECT stage, stage_id FROM leads WHERE id = ?").get(id);
  db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,motivo,created_at,de_stage_id,para_stage_id,etapa_fonte)
    VALUES (?,?,?,?,?,'mao',?,?,?,'gravado')`).run("le_" + randomUUID(), org, id, l.stage, etapa, t, l.stage_id, F.e[etapa]);
  db.prepare("UPDATE leads SET stage = ?, stage_id = ?, pipeline_id = ?, stage_entered_at = ? WHERE id = ?").run(etapa, F.e[etapa], F.id, t, id);
}

// Recebidos no período, no Braço: 5. Dois ficam em "Novo" (não entraram).
lead(BRACO, "Novo", NO(1), vero);
lead(BRACO, "Novo", NO(2), joao);
const a = lead(BRACO, "Novo", NO(1), vero); mover(BRACO, a, "Lead", NO(2));
const b = lead(BRACO, "Novo", NO(2), joao); mover(BRACO, b, "Qualificado", NO(3));
lead(BRACO, "Lead", NO(3), vero);                       // nasce na faixa
// Recebido ANTES do período e entra no comercial agora.
const c = lead(BRACO, "Novo", ANTES, vero); mover(BRACO, c, "Lead", NO(4));
// Leads de OUTRO funil no período: não podem entrar nos recebidos do Braço.
lead(OUTRO, "Novo", NO(1), vero); lead(OUTRO, "Novo", NO(2), joao);

const fechar = (filtros, nome) => {
  const f = C.funilDeConversao(org, BRACO.id, { ...PERIODO, ...filtros });
  const cartao = PA.painel(org, { ...PERIODO, pipeline_id: BRACO.id, ...filtros }).atendimento.recebidos;
  assert.ok(f.topo, nome + ": tem topo");
  assert.equal(f.topo.chegaram, cartao, `${nome}: recebidos do funil = cartão da Visão geral`);
  assert.equal(f.topo.chegaram - f.topo.ainda_nao + f.topo.de_antes, f.base, `${nome}: a conta fecha com o primeiro degrau`);
  for (const [conj, v] of [["recebidos", f.topo.chegaram], ["ainda_nao", f.topo.ainda_nao], ["de_antes", f.topo.de_antes], ["base", f.base]]) {
    const lista = C.conferenciaDoFunil(org, BRACO.id, { ...PERIODO, ...filtros }, { conjunto: conj, supervisor: true });
    assert.equal(lista.total, v, `${nome}: a lista "${conj}" tem o mesmo número`);
  }
  return f;
};

const casa = fechar({}, "Casa");
assert.deepEqual([casa.topo.chegaram, casa.topo.ainda_nao, casa.topo.de_antes, casa.base], [5, 2, 1, 4]);
console.log("ok 1 — casa: 5 recebidos − 2 em Novo + 1 de antes = 4 no primeiro degrau (outro funil fora)");

const v = fechar({ responsavel: vero }, "Veronica");
assert.deepEqual([v.topo.chegaram, v.topo.ainda_nao, v.topo.de_antes, v.base], [3, 1, 1, 3]);
console.log("ok 2 — uma pessoa: a mesma conta fecha");

fechar({ responsavel: [vero, joao].join(",") }, "Duas pessoas");
console.log("ok 3 — várias pessoas: fecha");


// 4. Lead SEM funil gravado: o Kanban o mostra no funil padrão; a conta também.
db.prepare("UPDATE pipelines SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE org_id = ?").run(BRACO.id, org);
const semFunil = "l_semfunil";
db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)`)
  .run(semFunil, org, "Sem funil", "5587990000999", "Novo", vero, NO(2));
const c4 = PA.painel(org, { ...PERIODO, pipeline_id: BRACO.id }).atendimento.recebidos;
assert.equal(c4, 6, "o lead sem funil conta no funil padrão, como no Kanban");
assert.equal(PA.painel(org, { ...PERIODO, pipeline_id: OUTRO.id }).atendimento.recebidos, 2, "e não conta no outro funil");
fechar({}, "Com lead sem funil");
console.log("ok 4 — lead sem funil conta no funil padrão (Kanban = Visão geral = funil)");
console.log("\ncontas-fecham: tudo certo");
