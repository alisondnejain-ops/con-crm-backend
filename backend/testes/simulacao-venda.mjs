/* SIMULAÇÃO, VENDA E CONE (CETRO 13 e 16, 13/11/2026).

   Rodar:  npm run teste:simulacao-venda
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-simulacao-venda.db");
process.env.JWT_SECRET = "teste"; process.env.PORT = "4663";
process.env.MARKETING_AGENDADOR = "0"; process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4663";
await new Promise(r => setTimeout(r, 700));
const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imob SV", "SV-1", Date.now());
const novo = (nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, email, senha, role, Date.now()); return id; };
const gestor = novo("Gestora", "g@sv.com", "adm"); const marina = novo("Marina", "m@sv.com", "corretor");
const { garantirPipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);
const login = async (e) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "123456" }) })).json()).token;
const cli = (t) => (p, o = {}) => fetch(BASE + p, { ...o, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json() }));
const G = cli(await login("g@sv.com")), M = cli(await login("m@sv.com"));
const lead = (nome, dono = marina) => { const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,assigned_to,stage,created_at,assigned_at) VALUES (?,?,?,?,?,?,?,?)").run(id, org, nome, "55879" + Math.floor(Math.random() * 1e8), dono, "Lead", Date.now(), Date.now()); return id; };
let falhas = 0;
const caso = async (n, f) => { try { await f(); console.log("  ✓ " + n); } catch (e) { falhas++; console.log("  ✗ " + n + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } };

const L1 = lead("Cliente Um"), L2 = lead("Cliente Dois");
let r;
await caso("1. Simulação SAC e Price calculadas pelo servidor; renda ausente = não informado", async () => {
  r = await M(`/leads/${L1}/simulacao/calcular`, { method: "POST", body: { tipo: "pronto", premissas: { preco: 300000, entrada: 60000, prazo_meses: 360, juros_aa: 10, sistema: "sac", renda: 8000 } } });
  assert.equal(r.status, 200); assert.equal(r.body.financiado, 240000); assert.equal(r.body.parcela_inicial, 2580.46); assert.equal(r.body.comprometimento, 32.26);
  r = await M(`/leads/${L1}/simulacao/calcular`, { method: "POST", body: { tipo: "pronto", premissas: { preco: 300000, entrada: 60000, prazo_meses: 360, juros_aa: 0, sistema: "price" } } });
  assert.equal(r.body.parcela_inicial, 666.67); assert.equal(r.body.comprometimento, null);
});
await caso("2. Entradas inválidas são recusadas com a frase, nunca truncadas", async () => {
  for (const [p, re] of [[{ preco: 100, entrada: 80, subsidio: 30, prazo_meses: 10 }, /passam do preço/], [{ preco: 100, prazo_meses: 0 }, /prazo/],
    [{ preco: 100, entrada: -1, prazo_meses: 10 }, /negativos/]]) {
    r = await M(`/leads/${L1}/simulacao/calcular`, { method: "POST", body: { tipo: "pronto", premissas: p } });
    assert.equal(r.status, 400); assert.match(r.body.error, re);
  }
});
await caso("3. Lançamento: 40/70 é recusado; componentes fora de 100% também", async () => {
  const comp = { sinal: { pct: 10, qtd: 3 }, mensais: { pct: 20, qtd: 36 }, reforcos: { pct: 10, qtd: 3 }, chaves: { pct: 10 }, financiar: { pct: 50 } };
  r = await M(`/leads/${L1}/simulacao/calcular`, { method: "POST", body: { tipo: "lancamento", premissas: { preco: 500000, componentes: comp, obra: { durante: 40, apos: 70 } } } });
  assert.equal(r.status, 400); assert.match(r.body.error, /110%/);
  r = await M(`/leads/${L1}/simulacao/calcular`, { method: "POST", body: { tipo: "lancamento", premissas: { preco: 500000, componentes: { ...comp, financiar: { pct: 40 } } } } });
  assert.equal(r.status, 400); assert.match(r.body.error, /90%/);
  r = await M(`/leads/${L1}/simulacao`, { method: "POST", body: { tipo: "lancamento", premissas: { preco: 500000, componentes: comp, obra: { durante: 40, apos: 60 } } } });
  assert.equal(r.status, 200); assert.equal(r.body.resultado.obra.diferenca, 0); assert.equal(r.body.simulacao.tipo, "lancamento");
  r = await M(`/leads/${L1}/linha-do-tempo`); assert.ok(r.body.eventos.some(e => e.tipo === "simulacao"), "a simulação entra na linha do tempo");
});

// Catálogo com unidade
const prod = (await G("/produtos", { method: "POST", body: { categoria: "empreendimento", titulo: "Residencial SV", cidade: "Petrolina", valor: 300000 } })).body.id;
const un = (await G(`/produtos/${prod}/unidades`, { method: "PUT", body: { unidades: [{ identificacao: "Apto 1", preco: 300000 }, { identificacao: "Apto 2", preco: 320000 }] } })).body.unidades;

await caso("4. Venda com imóvel e unidade: unidade fica vendida; comissão em valor vira %", async () => {
  r = await M(`/leads/${L1}/venda`, { method: "PATCH", body: { valor: 300000, data: "2026-11-13", produto_id: prod, unidade_id: un[0].id, comissao_valor: 15000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const l = db.prepare("SELECT * FROM leads WHERE id=?").get(L1);
  assert.equal(l.sale_commission_pct, 5); assert.equal(l.sale_commission_value, 15000); assert.match(l.sale_property, /Residencial SV · Apto 1/);
  assert.equal(db.prepare("SELECT status FROM produto_unidades WHERE id=?").get(un[0].id).status, "vendido");
});
await caso("5. Dois cliques no Salvar: a segunda não move a etapa de novo nem audita outra vez", async () => {
  const etapas = db.prepare("SELECT COUNT(*) n FROM lead_etapas WHERE lead_id=?").get(L1).n;
  r = await M(`/leads/${L1}/venda`, { method: "PATCH", body: { valor: 300000, data: "2026-11-13", produto_id: prod, unidade_id: un[0].id, comissao_valor: 15000 } });
  assert.equal(r.body.repetida, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lead_etapas WHERE lead_id=?").get(L1).n, etapas);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM venda_eventos WHERE lead_id=?").get(L1).n, 1);
});
await caso("6. Outro lead não vende a mesma unidade", async () => {
  r = await M(`/leads/${L2}/venda`, { method: "PATCH", body: { valor: 300000, produto_id: prod, unidade_id: un[0].id } });
  assert.equal(r.status, 409);
});
await caso("7. Cancelar solta a unidade e a auditoria fica", async () => {
  r = await M(`/leads/${L1}/venda`, { method: "PATCH", body: { valor: null } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT status FROM produto_unidades WHERE id=?").get(un[0].id).status, "disponivel");
  const ev = db.prepare("SELECT tipo FROM venda_eventos WHERE lead_id=? ORDER BY created_at").all(L1).map(e => e.tipo);
  assert.deepEqual(ev, ["registro", "cancelamento"]);
  r = await M(`/leads/${L1}/linha-do-tempo`); assert.ok(r.body.eventos.some(e => e.texto === "Venda cancelada"));
});
await caso("8. Venda em dólar não soma no VGV em real", async () => {
  const prodUSD = (await G("/produtos", { method: "POST", body: { categoria: "apartamento", moeda: "USD", titulo: "Apto Miami", cidade: "Miami", valor: 200000 } })).body.id;
  await M(`/leads/${L2}/venda`, { method: "PATCH", body: { valor: 200000, produto_id: prodUSD } });
  await M(`/leads/${L1}/venda`, { method: "PATCH", body: { valor: 300000, produto_id: prod, unidade_id: un[1].id } });
  r = await G(`/painel/geral?periodo=este_mes`);
  assert.equal(r.body.kpis.vgv.atual, 300000); assert.equal(r.body.kpis.vgv.em_dolar.quantidade, 1); assert.equal(r.body.kpis.vendas.atual, 2);
  assert.equal(r.body.kpis.ticket_medio.atual, 300000);
});
await caso("9. Metas de conversão: só o gestor grava; independentes por coluna; pessoa herda a da operação", async () => {
  const pid = db.prepare("SELECT id FROM pipelines WHERE org_id=? LIMIT 1").get(org).id;
  const etapas = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id=? ORDER BY ordem").all(pid);
  r = await M(`/painel/metas-conversao/${pid}`, { method: "PUT", body: { metas: [] } }); assert.equal(r.status, 403);
  r = await G(`/painel/metas-conversao/${pid}`, { method: "PUT", body: { metas: [{ stage_id: etapas[1].id, anterior: 40, acumulada: 20 }] } });
  assert.equal(r.status, 200); assert.equal(r.body.metas[etapas[1].id].anterior, 40); assert.equal(r.body.metas[etapas[1].id].acumulada, 20);
  r = await G(`/painel/metas-conversao/${pid}`, { method: "PUT", body: { metas: [{ stage_id: etapas[1].id, anterior: 150 }] } }); assert.equal(r.status, 400);
  r = await G(`/painel/metas-conversao/${pid}?user_id=${marina}`);
  assert.equal(r.body.pessoa[etapas[1].id].origem, "operacao");
  const outro = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id <> ? LIMIT 1").get(pid);
  if (outro) { r = await G(`/painel/metas-conversao/${pid}`, { method: "PUT", body: { metas: [{ stage_id: outro.id, anterior: 10 }] } }); assert.equal(r.status, 400); }
});
await caso("10. Por origem: o total é a soma das linhas; cada lead numa origem só", async () => {
  r = await G(`/painel/campanhas?periodo=este_mes`);
  const soma = r.body.por_origem.reduce((s, o) => s + o.leads, 0);
  assert.equal(soma, r.body.total_origem.leads); assert.equal(r.body.total_origem.vgv, 300000); assert.equal(r.body.total_origem.vendas_em_dolar, 1);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nOK — simulação, venda e cone.");
process.exit(falhas ? 1 : 0);
