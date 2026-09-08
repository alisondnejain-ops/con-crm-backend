/* A TELA DE ENTRADA — mesmos indicadores para toda conta, cada um vendo o
   próprio recorte (08/09/2026, pedido do Ali a partir do painel da Confidere
   Imóveis).

   O que este teste protege:

   1. A MESMA TRAVA do funil do corretor: quem não supervisiona sai daqui com
      `responsavel` sobrescrito pelo próprio id — nunca confia no que vem pela
      query.
   2. OS NÚMEROS BATEM com o que foi de fato criado: ligação, contato (só as
      que têm resultado "falou"), visita agendada/realizada, proposta e venda
      — cada um pela fonte certa (ligações por `user_id`, etapas por
      `lead_etapas.para`, venda por `sale_value`/`sale_date`).
   3. COMPARATIVO com o período anterior não inventa "+100%" quando não há
      base — vira `null`.
   4. METAS são só da gestão para ESCREVER; o corretor lê a própria dentro de
      `/painel/geral`, nunca configura.
   5. COMISSÃO na venda: aceita 0–100, recusa fora da faixa, e o VGC soma só
      quem tem comissão preenchida — a cobertura aparece ao lado.

   Rodar:  npm run teste:painel-geral
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-painel-geral.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4635";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4635";
await new Promise(r => setTimeout(r, 700));

const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "PG-1", Date.now());
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);
const funilId = pipelinePadrao(org).id;
const { moverEtapa } = await import("../src/services/etapas.js");

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@pg.com", senha, role, Date.now());
  return id; };
const ali = user("Ali", "adm"), marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");

const criarLead = (dono, i, quando = Date.now()) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,pipeline_id,assigned_to,created_at)
    VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?,?)`)
    .run(id, org, `Cliente ${i}`, "55879" + String(20000000 + i), funilId, dono, quando);
  return id; };

const ligar = (leadId, userId, resultado, quando = Date.now()) =>
  db.prepare("INSERT INTO ligacoes (id,lead_id,user_id,resultado,created_at) VALUES (?,?,?,?,?)")
    .run("lg_" + randomUUID(), leadId, userId, resultado, quando);

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@pg.com", password: "123456" }) });
  const d = await r.json();
  assert.ok(d.token, `login de ${nome} falhou: ${JSON.stringify(d)}`);
  return d.token;
}
const chamar = (token, caminho, opts = {}) => fetch(BASE + caminho,
  { ...opts, headers: { authorization: "Bearer " + token, ...(opts.headers || {}) } });
const post = (token, caminho, body) => chamar(token, caminho,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (token, caminho, body) => chamar(token, caminho,
  { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ===== MASSA DE DADOS =====
// 3 leads da Marina, 2 do Rafael — todos criados AGORA (dentro do período "hoje").
const m1 = criarLead(marina, 1), m2 = criarLead(marina, 2), m3 = criarLead(marina, 3);
const r1 = criarLead(rafael, 4), r2 = criarLead(rafael, 5);

// Marina: 3 ligações (2 falaram, 1 não atendeu), 1 visita agendada, 1 visita
// realizada, 1 proposta, 1 venda com comissão.
ligar(m1, marina, "falou"); ligar(m1, marina, "falou"); ligar(m2, marina, "nao_atendeu");
moverEtapa({ leadId: m1, para: "Agendamento", motivo: "mao", userId: marina });
moverEtapa({ leadId: m1, para: "Visita", motivo: "mao", userId: marina });
moverEtapa({ leadId: m2, para: "Proposta", motivo: "mao", userId: marina });

// Rafael: 1 ligação (falou), sem venda.
ligar(r1, rafael, "falou");

const tAli = await entrar("Ali"), tMarina = await entrar("Marina"), tRafael = await entrar("Rafael");

console.log("1. Marina registra a própria venda, com comissão");
let r = await patch(tMarina, `/leads/${m3}/venda`, { valor: "300000", comissao: "5" });
let d = await r.json();
console.log(`   ${r.status} · ${JSON.stringify(d)}`);
assert.equal(r.status, 200);

console.log("2. Comissão fora de 0–100 é recusada");
r = await patch(tMarina, `/leads/${m2}/venda`, { valor: "100000", comissao: "150" });
console.log(`   ${r.status}`);
assert.equal(r.status, 400);
// O lead não pode ter ficado com venda registrada por causa da tentativa recusada.
const semVenda = db.prepare("SELECT sale_value FROM leads WHERE id=?").get(m2);
assert.equal(semVenda.sale_value, null, "a venda recusada não pode ter gravado nada");

console.log("3. Venda SEM comissão é aceita (campo opcional)");
r = await patch(tRafael, `/leads/${r1}/venda`, { valor: "200000" });
d = await r.json();
console.log(`   ${r.status}`);
assert.equal(r.status, 200);
const semComissao = db.prepare("SELECT sale_commission_pct FROM leads WHERE id=?").get(r1);
assert.equal(semComissao.sale_commission_pct, null);

console.log("4. O corretor vê só os PRÓPRIOS números em /painel/geral");
r = await chamar(tMarina, "/painel/geral?periodo=hoje");
d = await r.json();
console.log(`   ${r.status} · leads=${d.kpis.leads.atual} vendas=${d.kpis.vendas.atual} visitas=${d.kpis.visitas.atual}`);
assert.equal(r.status, 200);
assert.equal(d.kpis.leads.atual, 3, "a Marina tem 3 leads");
assert.equal(d.kpis.vendas.atual, 1, "a Marina fechou 1 venda");
assert.equal(d.kpis.visitas.atual, 1, "a Marina teve 1 visita realizada");

console.log("5. E não vê o do colega mesmo pedindo pelo endereço");
r = await chamar(tMarina, `/painel/geral?periodo=hoje&responsavel=${rafael}`);
d = await r.json();
console.log(`   pediu o do Rafael, recebeu leads=${d.kpis.leads.atual}`);
assert.equal(d.kpis.leads.atual, 3, "o responsável mandado pelo corretor foi descartado");

console.log("6. O gestor vê a operação inteira (Marina + Rafael)");
r = await chamar(tAli, "/painel/geral?periodo=hoje");
d = await r.json();
console.log(`   leads=${d.kpis.leads.atual} vendas=${d.kpis.vendas.atual}`);
assert.equal(d.kpis.leads.atual, 5, "5 leads no total");
assert.equal(d.kpis.vendas.atual, 2, "2 vendas no total (Marina + Rafael)");

console.log("7. O funil de atividade tem as sete linhas, com as duas colunas de %");
r = await chamar(tAli, "/painel/geral?periodo=hoje");
d = await r.json();
const passos = d.funil_atividade.map(p => `${p.id}=${p.valor}`).join(" · ");
console.log(`   ${passos}`);
assert.equal(d.funil_atividade.length, 7);
assert.equal(d.funil_atividade[0].id, "leads");
assert.equal(d.funil_atividade[0].taxa_sequencial, null, "o primeiro degrau não tem taxa");
const ligacoesPasso = d.funil_atividade.find(p => p.id === "ligacoes");
assert.equal(ligacoesPasso.valor, 4, "3 da Marina + 1 do Rafael");
const contatoPasso = d.funil_atividade.find(p => p.id === "contato");
assert.equal(contatoPasso.valor, 3, "só as ligações com resultado 'falou'");

console.log("8. VGC soma só quem tem comissão — e diz a cobertura");
r = await chamar(tAli, "/painel/geral?periodo=hoje");
d = await r.json();
console.log(`   vgc=${d.kpis.vgc.atual} cobertura=${JSON.stringify(d.kpis.vgc.cobertura)}`);
assert.equal(d.kpis.vgc.atual, 300000 * 0.05, "só a venda da Marina tem comissão (5% de 300000)");
assert.equal(d.kpis.vgc.cobertura.com_comissao, 1);
assert.equal(d.kpis.vgc.cobertura.total, 2);

console.log("9. Sem venda no período anterior, a variação não inventa número");
r = await chamar(tAli, "/painel/geral?periodo=hoje");
d = await r.json();
console.log(`   vendas.anterior=${d.kpis.vendas.anterior} variacao=${d.kpis.vendas.variacao_pct}`);
assert.equal(d.kpis.vendas.anterior, 0);
assert.equal(d.kpis.vendas.variacao_pct, null, "sem base de comparação, não é 0% nem +100%");

console.log("10. A configuração de metas é só da gestão");
r = await chamar(tMarina, "/painel/metas");
console.log(`   corretor lendo /painel/metas → ${r.status}`);
assert.equal(r.status, 403);
r = await post(tMarina, "/painel/metas", { ligacoes: 999 });
console.log(`   corretor escrevendo /painel/metas → ${r.status}`);
assert.equal(r.status, 403);

console.log("11. O gestor define a meta da operação e a pessoal da Marina");
const mesAtual = new Date().toISOString().slice(0, 7);
r = await post(tAli, "/painel/metas", { mes: mesAtual, ligacoes: 100, vgv: 500000 });
console.log(`   meta da operação: ${r.status}`);
assert.equal(r.status, 200);
r = await post(tAli, "/painel/metas", { user_id: marina, mes: mesAtual, ligacoes: 10 });
console.log(`   meta pessoal da Marina: ${r.status}`);
assert.equal(r.status, 200);

console.log("12. A Marina vê a PRÓPRIA meta (10 ligações), não a da operação (100)");
r = await chamar(tMarina, "/painel/geral?periodo=hoje");
d = await r.json();
const metaLig = d.metas.itens.find(i => i.campo === "ligacoes");
console.log(`   meta=${metaLig.meta} realizado=${metaLig.realizado} pct=${metaLig.pct}`);
assert.equal(metaLig.meta, 10);
assert.equal(metaLig.realizado, 3, "as 3 ligações que ela fez este mês");
assert.equal(metaLig.pct, 30);

console.log("13. Meta não definida é null, nunca 0%");
r = await chamar(tRafael, "/painel/geral?periodo=hoje");
d = await r.json();
const metaLigRafael = d.metas.itens.find(i => i.campo === "ligacoes");
console.log(`   Rafael (sem meta pessoal): meta=${metaLigRafael.meta} pct=${metaLigRafael.pct}`);
assert.equal(metaLigRafael.meta, null);
assert.equal(metaLigRafael.pct, null, "sem meta, o progresso é null, não 0%");

console.log("14. A gestão consulta a config com todo mundo lado a lado");
r = await chamar(tAli, `/painel/metas?mes=${mesAtual}`);
d = await r.json();
console.log(`   operação.ligacoes.meta=${d.operacao.itens.find(i => i.campo === "ligacoes").meta} · corretores=${d.corretores.length}`);
assert.equal(r.status, 200);
assert.equal(d.operacao.itens.find(i => i.campo === "ligacoes").meta, 100);
assert.equal(d.corretores.length, 2);

console.log("15. Sem login, nada disso abre");
for (const caminho of ["/painel/geral", "/painel/metas"]) {
  r = await fetch(BASE + caminho);
  console.log(`   ${caminho} → ${r.status}`);
  assert.equal(r.status, 401);
}

console.log("\nTudo certo ✅");
process.exit(0);
