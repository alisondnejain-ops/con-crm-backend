/* O MESMO NÚMERO, O MESMO VALOR, EM TODAS AS TELAS (25/09/2026).

   Pedido do Ali: "caso haja alguma atualização de números, seja individual ou
   da imobiliária toda, isso se atualize em todas as frentes — nada pode ficar
   solto ou desamarrado". Antes deste dia:

   - "Leads" de uma pessoa tinha TRÊS contas: Relatórios lia o histórico de
     atribuição, o Painel contava leads criados no período que estão com ela
     hoje, e a aba Equipe da Operação olhava só a última atribuição. O lead
     criado no mês passado e repassado hoje contava numa tela e não na outra.
   - Relatórios abria em "últimos 30 dias" e as outras em "este mês".

   Este teste monta exatamente o caso que divergia (lead antigo repassado
   hoje) e confere, rota por rota, que cada número bate:

   RECEBIDOS da Marina   = Painel (/painel/geral) = Relatórios (/reports)
                         = Operação (/painel?responsavel) = Equipe (/painel/equipe)
   VENDAS e VGV da casa  = Painel = Operação = soma de Relatórios = soma do Score
   PERÍODO "mes"         = o mesmo intervalo em /reports, /reports/score e /painel

   Rodar:  npm run teste:numeros-batem
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-numeros-batem.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4649";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4649";
await new Promise(r => setTimeout(r, 700));

const DIA = 86400000;
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa", "NB-1", Date.now());
const { garantirPipelinePadrao, pipelinePadrao } = await import("../src/services/pipelines.js");
garantirPipelinePadrao(org);
const funilId = pipelinePadrao(org).id;
const { trocarResponsavel } = await import("../src/services/movimento.js");
const { resolverPeriodo } = await import("../src/services/painel.js");

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, nome.toLowerCase() + "@nb.com", senha, role, Date.now());
  return id; };
const ali = user("Ali", "adm"), vanessa = user("Vanessa", "sdr");
const marina = user("Marina", "corretor"), rafael = user("Rafael", "corretor");

let n = 0;
const criarLead = (dono, quando) => { const id = "l_" + randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,qual_json,stage,pipeline_id,assigned_to,assigned_at,created_at)
    VALUES (?,?,?,?,'WhatsApp','{}','Lead',?,?,?,?)`)
    .run(id, org, `Cliente ${++n}`, "55879" + String(30000000 + n), funilId, dono, quando, quando);
  return id; };

async function entrar(nome) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: nome.toLowerCase() + "@nb.com", password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login de ${nome}: ${JSON.stringify(d)}`); return d.token;
}
const get = async (token, caminho) => {
  const r = await fetch(BASE + caminho, { headers: { authorization: "Bearer " + token } });
  const d = await r.json(); assert.equal(r.status, 200, `${caminho}: ${JSON.stringify(d)}`); return d;
};
const patch = (token, caminho, body) => fetch(BASE + caminho, { method: "PATCH",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });

// ===== O CASO QUE DIVERGIA =====
// A: nasceu há 40 dias com a atendente e foi repassado HOJE para a Marina.
const antigo = criarLead(vanessa, Date.now() - 40 * DIA);
trocarResponsavel(antigo, marina, ali, "mao");
// B: nasceu hoje, já com a Marina. C: nasceu hoje com o Rafael.
const novoMarina = criarLead(marina, Date.now());
const novoRafael = criarLead(rafael, Date.now());

const tAli = await entrar("Ali"), tMarina = await entrar("Marina"), tRafael = await entrar("Rafael");
assert.equal((await patch(tMarina, `/leads/${novoMarina}/venda`, { valor: "300000" })).status, 200);
assert.equal((await patch(tRafael, `/leads/${novoRafael}/venda`, { valor: "200000" })).status, 200);

console.log("1. RECEBIDOS da Marina: o lead antigo repassado hoje conta em TODAS as telas");
const painelDela = await get(tMarina, "/painel/geral?periodo=mes");
const rel = await get(tAli, "/reports?periodo=mes");
const linhaMarina = rel.atendentes.find(a => a.id === marina);
const operacao = await get(tAli, `/painel?periodo=mes&responsavel=${marina}`);
const equipe = await get(tAli, "/painel/equipe?periodo=mes");
const naEquipe = equipe.equipe.find(p => p.id === marina);
const valores = { painel: painelDela.kpis.leads.atual, relatorios: linhaMarina.recebidos,
  operacao: operacao.atendimento.recebidos, equipe: naEquipe.recebidos_no_periodo };
console.log("   " + JSON.stringify(valores));
for (const [tela, v] of Object.entries(valores)) assert.equal(v, 2, `${tela} deveria mostrar 2 recebidos`);

console.log("2. O gestor filtrando a Marina no Painel vê o MESMO número que ela");
const painelGestorFiltrado = await get(tAli, `/painel/geral?periodo=mes&responsavel=${marina}`);
assert.equal(painelGestorFiltrado.kpis.leads.atual, painelDela.kpis.leads.atual);
// E o gráfico de 14 dias soma o mesmo que o cartão, quando o período cabe nele.
const hoje = await get(tMarina, "/painel/geral?periodo=hoje");
const somaSerie = hoje.serie.reduce((s, d) => s + d.leads, 0);
console.log(`   cartão de hoje=${hoje.kpis.leads.atual} · gráfico de hoje=${hoje.serie[hoje.serie.length - 1].leads} · soma 14 dias=${somaSerie}`);
assert.equal(hoje.serie[hoje.serie.length - 1].leads, hoje.kpis.leads.atual, "o último dia do gráfico é o cartão de hoje");

console.log("3. VENDAS e VGV da casa: Painel = Operação = Relatórios = Score");
const painelCasa = await get(tAli, "/painel/geral?periodo=mes");
const operacaoCasa = await get(tAli, "/painel?periodo=mes");
const score = await get(tAli, "/reports/score?periodo=mes");
const somaRel = rel.atendentes.reduce((s, a) => s + a.vendas, 0);
const somaRelValor = rel.atendentes.reduce((s, a) => s + a.valor_vendido, 0);
const somaScore = score.equipe.reduce((s, m) => s + (m.vendas || 0), 0);
const vendas = { painel: painelCasa.kpis.vendas.atual, operacao: operacaoCasa.vendas.quantidade,
  relatorios: somaRel, score: somaScore };
console.log("   vendas " + JSON.stringify(vendas));
for (const [tela, v] of Object.entries(vendas)) assert.equal(v, 2, `${tela} deveria mostrar 2 vendas`);
const vgv = { painel: painelCasa.kpis.vgv.atual, operacao: operacaoCasa.vendas.vgv, relatorios: somaRelValor };
console.log("   vgv " + JSON.stringify(vgv));
for (const [tela, v] of Object.entries(vgv)) assert.equal(v, 500000, `${tela} deveria mostrar R$ 500.000`);

console.log("4. Venda individual: a da Marina é a mesma no Painel dela e no Relatórios");
assert.equal(painelDela.kpis.vendas.atual, 1);
assert.equal(linhaMarina.vendas, 1);
assert.equal(painelDela.kpis.vgv.atual, linhaMarina.valor_vendido);

console.log("5. O período \"mes\" é o MESMO intervalo em Relatórios, Score e Painel");
const mes = resolverPeriodo({ periodo: "mes" });
console.log(`   mes=${new Date(mes.de).toISOString()} · reports=${new Date(rel.periodo.de).toISOString()} · score=${new Date(score.periodo.de).toISOString()}`);
assert.equal(rel.periodo.de, mes.de);
assert.equal(score.periodo.de, mes.de);
assert.equal(new Date(operacaoCasa.periodo.de).getTime(), mes.de);
// As datas soltas continuam valendo (o "Escolher datas").
const custom = await get(tAli, "/reports?periodo=custom&de=2026-01-01&ate=2026-01-31");
assert.equal(new Date(custom.periodo.de).getDate(), 1);
assert.equal(custom.atendentes.find(a => a.id === marina).recebidos, 0, "janeiro não tem nada");

console.log("6. /painel não calcula mais a equipe em dobro (a tela usa /painel/equipe)");
assert.equal(operacaoCasa.atividades, undefined);

console.log("7. \"Responderam à 1ª mensagem\" divide só por quem RECEBEU mensagem");
// antigo: recebeu e respondeu · novoMarina: recebeu e não respondeu · novoRafael: nada enviado
const msg = (lead, dir, quando) => db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at)
  VALUES (?,?,?,?,?)`).run("m_" + randomUUID(), lead, dir, "oi", quando);
msg(antigo, "out", Date.now() - 60000); msg(antigo, "in", Date.now() - 30000);
msg(novoMarina, "out", Date.now() - 60000);
// Filtrado pela Marina: os dois leads dela no período (o antigo repassado conta).
const resp = (await get(tAli, `/painel?periodo=mes&responsavel=${marina}`)).atendimento;
console.log(`   ${resp.clientes_responderam} de ${resp.clientes_contatados} · ${resp.taxa_resposta_cliente}%`);
assert.equal(resp.clientes_contatados, 2, "o lead sem mensagem enviada fica fora da conta");
assert.equal(resp.clientes_responderam, 1);
assert.equal(resp.taxa_resposta_cliente, 50);

console.log("\nTudo certo ✅");
process.exit(0);
