/* O FUNIL DE CONVERSÃO POR COORTE (01/10/2026).

   A base é quem entrou no processo comercial no período (o Inbox fica fora),
   acompanhada até o corte; as duas taxas são "desde a entrada" e "da etapa
   anterior"; a etapa vale pelo id; e o dono é o de quando o lead entrou.

   Rodar:  npm run teste:funil-de-conversao  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.TZ = "America/Recife";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-funil-conversao.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4637";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://127.0.0.1:4637";
await new Promise(r => setTimeout(r, 700));
const P = await import("../src/services/pipelines.js");
const C = await import("../src/services/conversao.js");
const PA = await import("../src/services/painel.js");
const { moverEtapa } = await import("../src/services/etapas.js");

const org = "org_fc", outra = "org_outra";
for (const [id, cod] of [[org, "FC-1"], [outra, "FC-2"]])
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, id, cod, Date.now());

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const user = (o, nome, role) => { const id = "u_" + nome.toLowerCase();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, o, nome, nome.toLowerCase() + "@fc.com", senha, role, Date.now());
  return id; };
const ali = user(org, "Ali", "adm"), marina = user(org, "Marina", "corretor"), rafael = user(org, "Rafael", "corretor");
user(outra, "Zeca", "adm");

const DIA = 86400000;
const SET = (d, h = 10) => new Date(2026, 8, d, h).getTime();
const PERIODO = { de: "2026-09-10", ate: "2026-09-20" };
const AGORA = new Date(2026, 9, 1, 12).getTime();

function novoFunil(nome, { entrada = "Qualificado", o = org } = {}) {
  const pl = P.criarPipeline(o, { name: nome });
  const e = {};
  for (const [n, conv, tipo] of [["Inbox"], ["Qualificado", 1], ["Pasta"], ["Agendamento", 1], ["Visita", 1],
    ["Proposta", 1], ["Negociação", 1], ["Venda", 1, "ganho"], ["Perdido", 0, "perdido"]])
    e[n] = P.criarEtapa(o, pl.pipeline.id, { name: n, counts_as_conversion: !!conv, status_type: tipo || "aberto",
      entrada_comercial: n === entrada }).etapa.id;
  return { id: pl.pipeline.id, e, o };
}
let seq = 0;
function lead(F, etapa, criado, dono = null) {
  const id = "l_" + (++seq);
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,stage,stage_id,pipeline_id,assigned_to,assigned_at,created_at,stage_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, F.o, "Lead " + seq, "558799" + String(seq).padStart(6, "0"), etapa,
    F.e[etapa], F.id, dono, dono ? criado : null, criado, criado);
  return id;
}
function mover(F, id, etapa, t, motivo = "mao") {
  const l = db.prepare("SELECT stage, stage_id FROM leads WHERE id = ?").get(id);
  db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,motivo,created_at,de_stage_id,para_stage_id,etapa_fonte)
    VALUES (?,?,?,?,?,?,?,?,?,'gravado')`).run("le_" + randomUUID(), F.o, id, l.stage, etapa, motivo, t, l.stage_id, F.e[etapa]);
  db.prepare("UPDATE leads SET stage = ?, stage_id = ?, stage_entered_at = ? WHERE id = ?").run(etapa, F.e[etapa], t, id);
}
const caminho = (F, id, etapas, t0) => etapas.forEach((e, i) => mover(F, id, e, t0 + (i + 1) * 3600000));
function repassar(id, de, para, t) {
  db.prepare(`INSERT INTO lead_transfers (id,org_id,lead_id,from_user_id,to_user_id,trigger_reason,created_at)
    VALUES (?,?,?,?,?,'mao',?)`).run("tr_" + randomUUID(), org, id, de, para, t);
  db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ?").run(para, t, id);
}
const conv = (F, f = PERIODO, agora = AGORA) => C.funilDeConversao(F.o, F.id, f, agora);
const linha = (r, nome) => r.linhas.find(l => l.name === nome);
const quase = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≠ ${b}`);

console.log("1. O exemplo 20 → 8 → 6 → 3 → 2 → 1");
const F1 = novoFunil("Exemplo");
const marcosDoExemplo = ["Agendamento", "Visita", "Proposta", "Negociação", "Venda"];
const quantos = [8, 6, 3, 2, 1];
for (let i = 0; i < 20; i++) {
  const id = lead(F1, "Inbox", SET(11), marina);
  mover(F1, id, "Qualificado", SET(12));
  caminho(F1, id, marcosDoExemplo.filter((_, k) => i < quantos[k]), SET(13));
}
let r = conv(F1);
for (const l of r.linhas) console.log(`   ${l.name.padEnd(12)} ${String(l.chegaram).padStart(2)} · desde a entrada ${l.desde_entrada?.toFixed(1)}% · da anterior ${l.anterior ? l.anterior.taxa.toFixed(1) + "%" : "—"}`);
assert.equal(r.base, 20);
assert.equal(linha(r, "Qualificado").desde_entrada, 100);
assert.equal(linha(r, "Qualificado").anterior, null, "a entrada não tem etapa anterior");
const esperado = [[40, 40], [75, 30], [50, 15], [66.6667, 10], [50, 5]];
marcosDoExemplo.forEach((n, k) => { quase(linha(r, n).anterior.taxa, esperado[k][0]); quase(linha(r, n).desde_entrada, esperado[k][1]); });
assert.equal(linha(r, "Visita").anterior.vieram, 6);
assert.equal(linha(r, "Visita").anterior.chegaram, 8);

console.log("2. O Inbox não entra na base, mas aparece em \"onde estão agora\"");
const F2 = novoFunil("Inbox");
for (let i = 0; i < 5; i++) lead(F2, "Inbox", SET(12));
const q2 = lead(F2, "Inbox", SET(12)); mover(F2, q2, "Qualificado", SET(13));
r = conv(F2);
assert.equal(r.base, 1);
const op = PA.funil(org, F2.id, PERIODO).operacional;
assert.equal(op.find(o => o.name === "Inbox").leads_agora, 5);
assert.equal(op.find(o => o.name === "Inbox").fase, "antes");
assert.equal(op.find(o => o.name === "Pasta").fase, "comercial");
assert.equal(op.find(o => o.name === "Perdido").fase, "perdido");
console.log(`   base ${r.base} · 5 no Inbox agora`);

console.log("3. A base não é \"total menos Inbox\"");
const p3 = lead(F2, "Inbox", SET(12)); mover(F2, p3, "Perdido", SET(13));   // descartado na triagem
r = conv(F2);
const criados = db.prepare("SELECT COUNT(*) n FROM leads WHERE pipeline_id = ?").get(F2.id).n;
const noInbox = db.prepare("SELECT COUNT(*) n FROM leads WHERE pipeline_id = ? AND stage = 'Inbox'").get(F2.id).n;
console.log(`   total ${criados} − Inbox ${noInbox} = ${criados - noInbox}, base ${r.base}`);
assert.equal(r.base, 1);
assert.notEqual(criados - noInbox, r.base);

console.log("4. Entrada direta numa etapa adiantada conta, sem inventar passagem");
const F4 = novoFunil("Direta");
for (let i = 0; i < 3; i++) { const id = lead(F4, "Inbox", SET(11)); caminho(F4, id, ["Qualificado", "Agendamento", "Visita"], SET(12)); }
const d4 = lead(F4, "Inbox", SET(11)); mover(F4, d4, "Visita", SET(12));          // pulou direto
const n4 = lead(F4, "Visita", SET(12));                                           // nasceu em Visita
r = conv(F4);
const v4 = linha(r, "Visita");
console.log(`   base ${r.base} · Visita ${v4.chegaram} · da anterior ${v4.anterior.vieram} de ${v4.anterior.chegaram} · ${v4.sem_passar_pela_anterior} sem passar pela anterior`);
assert.equal(r.base, 5);
assert.equal(v4.chegaram, 5);
assert.equal(v4.anterior.chegaram, 3);
assert.equal(v4.anterior.vieram, 3);
assert.equal(v4.sem_passar_pela_anterior, 2);

console.log("5. Sair e voltar à faixa não conta duas vezes");
const F5 = novoFunil("Volta");
const v5 = lead(F5, "Inbox", SET(11));
caminho(F5, v5, ["Qualificado", "Inbox", "Qualificado", "Agendamento"], SET(12));
r = conv(F5);
assert.equal(r.base, 1);
assert.equal(linha(r, "Agendamento").chegaram, 1);
console.log("   1 lead, 1 entrada");

console.log("6. Perder o lead não o tira da coorte em que entrou");
mover(F5, v5, "Perdido", SET(15));
const v5b = lead(F5, "Inbox", SET(11)); caminho(F5, v5b, ["Qualificado", "Inbox"], SET(12));
r = conv(F5);
assert.equal(r.base, 2);
console.log("   base 2: um perdido, um devolvido ao Inbox");

console.log("7. O que acontece depois do corte não entra");
const F7 = novoFunil("Corte");
const c7 = lead(F7, "Inbox", SET(11)); mover(F7, c7, "Qualificado", SET(12)); mover(F7, c7, "Agendamento", SET(25));
r = conv(F7);
assert.equal(r.corte, new Date(2026, 8, 20, 23, 59, 59, 999).getTime());
assert.equal(linha(r, "Agendamento").chegaram, 0, "chegou dia 25, o período fechou dia 20");
// Período ainda aberto: o corte é agora.
r = conv(F7, PERIODO, SET(15));
assert.equal(r.corte, SET(15));
assert.equal(r.corte_no_fim_do_periodo, false);
console.log("   agendamento do dia 25 fora · período aberto corta em agora");

console.log("8. Quem entrou antes do período não é da coorte, mesmo avançando nele");
const a8 = lead(F7, "Inbox", SET(2)); mover(F7, a8, "Qualificado", SET(5)); mover(F7, a8, "Agendamento", SET(15));
r = conv(F7);
assert.equal(r.base, 1);
console.log("   entrou dia 5: fora da coorte de 10 a 20");

console.log("9. Sem base é \"sem base\"; base sem avanço é 0%");
const F9 = novoFunil("Vazio");
r = conv(F9);
assert.equal(r.base, 0);
assert.equal(linha(r, "Qualificado").desde_entrada, null);
assert.equal(linha(r, "Agendamento").desde_entrada, null);
const z9 = lead(F9, "Inbox", SET(11)); mover(F9, z9, "Qualificado", SET(12));
r = conv(F9);
assert.equal(linha(r, "Agendamento").desde_entrada, 0);
assert.equal(linha(r, "Agendamento").anterior.taxa, 0);
assert.equal(linha(r, "Visita").anterior.taxa, null, "ninguém chegou ao Agendamento: não há de onde medir");
console.log("   null sem base · 0 com base · null sem anterior");

console.log("10. Renomear a etapa não apaga a passagem");
const antes10 = linha(conv(F1), "Visita").chegaram;
P.editarEtapa(org, F1.e["Visita"], { name: "Visita feita" });
r = conv(F1);
assert.equal(linha(r, "Visita feita").chegaram, antes10);
console.log(`   "Visita feita": ${antes10} chegaram, como antes`);

console.log("11. Desativar uma etapa de apoio mantém quem passou por ela");
const F11 = novoFunil("Apoio");
const a11 = lead(F11, "Inbox", SET(11)); mover(F11, a11, "Pasta", SET(12));
assert.equal(conv(F11).base, 1);
mover(F11, a11, "Agendamento", SET(13));
P.editarEtapa(org, F11.e["Pasta"], { is_active: false });
assert.equal(conv(F11).base, 1);
console.log("   entrou pela Pasta, Pasta desativada, continua na base");

console.log("12. O início do processo comercial é configurado pelo id");
const F12 = novoFunil("Sem marca", { entrada: null });
r = conv(F12);
assert.equal(r.entrada.name, "Qualificado");
assert.equal(r.entrada.configurada, false);
assert.ok(r.avisos.some(a => a.includes("não está marcado")));
let e12 = P.editarEtapa(org, F12.e["Agendamento"], { entrada_comercial: true });
assert.ok(!e12.erro);
r = conv(F12);
assert.equal(r.entrada.name, "Agendamento");
assert.equal(r.entrada.configurada, true);
assert.equal(r.linhas[0].name, "Agendamento");
assert.ok(!r.avisos.some(a => a.includes("não está marcado")));
assert.ok(r.avisos.some(a => a.includes("Qualificado") && a.includes("antes do início")));
console.log("   sem marca: Qualificado (com aviso) · marcada: Agendamento");

console.log("13. Configuração inválida é recusada com a razão");
e12 = P.editarEtapa(org, F12.e["Perdido"], { entrada_comercial: true });
console.log(`   ${e12.erro}`);
assert.match(e12.erro, /perda/);
P.editarEtapa(org, F12.e["Inbox"], { is_active: false });
e12 = P.editarEtapa(org, F12.e["Inbox"], { entrada_comercial: true });
assert.match(e12.erro, /desativada/);
P.editarEtapa(org, F12.e["Visita"], { entrada_comercial: true });
const marcadas = db.prepare("SELECT name FROM pipeline_stages WHERE pipeline_id = ? AND entrada_comercial = 1").all(F12.id);
assert.deepEqual(marcadas.map(m => m.name), ["Visita"], "uma por funil");

console.log("14. Passagem por regra automática é separada da confirmada");
const F14 = novoFunil("Regra");
const r14a = lead(F14, "Inbox", SET(11)); caminho(F14, r14a, ["Qualificado"], SET(12)); mover(F14, r14a, "Agendamento", SET(14), "palavra");
const r14b = lead(F14, "Inbox", SET(11)); caminho(F14, r14b, ["Qualificado", "Agendamento"], SET(12));
r = conv(F14);
assert.equal(linha(r, "Agendamento").chegaram, 2);
assert.equal(linha(r, "Agendamento").por_regra_automatica, 1);
console.log("   2 chegaram · 1 só pela palavra-chave");

console.log("15. Venda: chegar à etapa x venda registrada");
const s15a = lead(F14, "Inbox", SET(11)); caminho(F14, s15a, ["Qualificado", "Venda"], SET(12));
db.prepare("UPDATE leads SET sale_value = 300000, sale_date = ? WHERE id = ?").run(SET(14), s15a);
const s15b = lead(F14, "Inbox", SET(11)); caminho(F14, s15b, ["Qualificado", "Venda"], SET(12));
r = conv(F14);
assert.equal(linha(r, "Venda").chegaram, 2);
assert.equal(linha(r, "Venda").com_venda_registrada, 1);
console.log("   2 na etapa Venda · 1 com venda registrada");

console.log("16. A coorte é do dono na entrada; repasse depois não reescreve");
const F16 = novoFunil("Donos");
const d16 = lead(F16, "Inbox", SET(11), marina); mover(F16, d16, "Qualificado", SET(12));
repassar(d16, marina, rafael, SET(13));
r = conv(F16);
assert.equal(r.por_responsavel.find(g => g.id === marina).base, 1);
assert.ok(!r.por_responsavel.find(g => g.id === rafael));
assert.equal(conv(F16, { ...PERIODO, responsavel: marina }).base, 1);
assert.equal(conv(F16, { ...PERIODO, responsavel: rafael }).base, 0);
// A troca de dono na mesma operação da entrada (automação do SDR) é o dono.
const d16b = lead(F16, "Inbox", SET(11), marina); mover(F16, d16b, "Qualificado", SET(12)); repassar(d16b, marina, rafael, SET(12) + 50);
assert.equal(conv(F16, { ...PERIODO, responsavel: rafael }).base, 1);
console.log("   repassado depois: continua da Marina · na mesma operação: do Rafael");

console.log("17. Lead na fila na entrada fica em \"Sem responsável\"");
const f17 = lead(F16, "Inbox", SET(11)); mover(F16, f17, "Qualificado", SET(12));
r = conv(F16);
assert.equal(r.por_responsavel.find(g => g.grupo === "sem_responsavel").base, 1);
assert.equal(conv(F16, { ...PERIODO, responsavel: "fila" }).base, 1);
assert.equal(r.por_responsavel.reduce((s, g) => s + g.base, 0), r.base, "ninguém em dois grupos");

console.log("18. Dono anterior ao registro das trocas é \"desconhecido\"");
const F18 = novoFunil("Agosto");
const AGO = (d) => new Date(2026, 7, d, 10).getTime();
const g18 = lead(F18, "Inbox", AGO(20), marina); mover(F18, g18, "Qualificado", AGO(21));
const PAGO = { de: "2026-08-15", ate: "2026-08-31" };
r = conv(F18, PAGO);
assert.equal(r.base, 1);
assert.equal(r.por_responsavel[0].grupo, "desconhecido");
assert.equal(conv(F18, { ...PAGO, responsavel: marina }).base, 0);
assert.equal(conv(F18, { ...PAGO, responsavel: marina }).cobertura.dono_desconhecido, 1);
console.log("   entrou em 21/08: dono desconhecido, fora do filtro por pessoa, contado à parte");

console.log("19. Antes do histórico existir: \"sem data\", não zero");
const h19 = lead(F18, "Qualificado", AGO(1), marina);   // em julho/agosto, nunca mudou
r = conv(F18, { de: "2026-08-01", ate: "2026-08-31" });
assert.equal(r.cobertura.periodo_comeca_antes, true);
assert.equal(r.cobertura.entrada_sem_data, 1);
assert.ok(r.avisos.some(a => a.includes("14/08/2026")));
assert.equal(r.base, 1, "o lead sem data não entra na base");
assert.equal(conv(F18, PAGO).cobertura.entrada_sem_data, 0, "período depois da cobertura: entrou antes, fora");
console.log("   1 sem data, fora da base, com aviso");

console.log("20. Linhas antigas só ganham etapa com evidência segura — e uma vez só");
const F20 = novoFunil("Antigo");
const outroComVisita = novoFunil("Outro com Visita");
const h20 = lead(F20, "Inbox", SET(11));
const antiga = (para, t) => db.prepare(`INSERT INTO lead_etapas (id,org_id,lead_id,de,para,motivo,created_at)
  VALUES (?,?,?,?,?,'mao',?)`).run("le_" + randomUUID(), org, h20, "Inbox", para, t);
db.prepare("UPDATE pipeline_stages SET name = 'Qualificado único' WHERE id = ?").run(F20.e["Qualificado"]);
// As etapas precisam existir na data da mudança: etapa criada depois não é candidata.
db.prepare("UPDATE pipeline_stages SET created_at = ? WHERE pipeline_id IN (?, ?)").run(SET(1), F20.id, outroComVisita.id);
antiga("Qualificado único", SET(12));    // nome único na conta: identificada
antiga("Visita", SET(13));               // nome em vários funis: desconhecida
let id20 = C.identificarEtapasDoHistorico(org);
const fontes = db.prepare("SELECT para, para_stage_id, etapa_fonte FROM lead_etapas WHERE lead_id = ? ORDER BY created_at").all(h20);
console.log(`   ${fontes.map(f => `${f.para} → ${f.etapa_fonte}`).join(" · ")}`);
assert.equal(fontes[0].para_stage_id, F20.e["Qualificado"]);
assert.equal(fontes[0].etapa_fonte, "nome");
assert.equal(fontes[1].para_stage_id, null);
assert.equal(fontes[1].etapa_fonte, "desconhecida");
assert.equal(C.identificarEtapasDoHistorico(org).conferidas, 0, "rodar de novo não mexe em nada");
// Etapa criada DEPOIS da mudança não serve de evidência.
antiga("Proposta", SET(13) + 1);
db.prepare("UPDATE pipeline_stages SET created_at = ? WHERE id = ?").run(SET(1), F20.e["Proposta"]);
db.prepare("UPDATE pipeline_stages SET created_at = ? WHERE name = 'Proposta' AND id <> ?").run(Date.now(), F20.e["Proposta"]);
C.identificarEtapasDoHistorico(org);
assert.equal(db.prepare("SELECT para_stage_id FROM lead_etapas WHERE lead_id = ? AND para = 'Proposta'").get(h20).para_stage_id,
  F20.e["Proposta"], "só a etapa que já existia é candidata");
r = conv(F20);
assert.equal(r.base, 1);
assert.equal(r.cobertura.com_lacunas, 1, "a mudança sem etapa identificada é avisada");

console.log("21. moverEtapa grava o id das duas etapas");
const m21 = lead(F1, "Inbox", Date.now());
moverEtapa({ leadId: m21, paraEtapaId: F1.e["Qualificado"] });
const g21 = db.prepare("SELECT de_stage_id, para_stage_id, etapa_fonte FROM lead_etapas WHERE lead_id = ?").get(m21);
assert.deepEqual(g21, { de_stage_id: F1.e["Inbox"], para_stage_id: F1.e["Qualificado"], etapa_fonte: "gravado" });

console.log("22. A conferência devolve exatamente quem está por trás do número");
let k = C.conferenciaDoFunil(org, F1.id, PERIODO, { etapa: F1.e["Visita"], conjunto: "anterior" }, AGORA);
assert.equal(k.total, 8);
k = C.conferenciaDoFunil(org, F1.id, PERIODO, { etapa: F1.e["Visita"], conjunto: "vieram" }, AGORA);
assert.equal(k.total, 6);
k = C.conferenciaDoFunil(org, F1.id, PERIODO, { conjunto: "base", porPagina: 7, pagina: 3 }, AGORA);
assert.equal(k.total, 20); assert.equal(k.itens.length, 6);
k = C.conferenciaDoFunil(org, F4.id, PERIODO, { etapa: F4.e["Visita"], conjunto: "sem_anterior" }, AGORA);
assert.deepEqual(k.itens.map(i => i.id).sort(), [d4, n4].sort());
assert.ok(C.conferenciaDoFunil(org, F1.id, PERIODO, { conjunto: "tudo" }).erro);
console.log("   8 no Agendamento · 6 vieram · paginação 20 em 7 · 2 diretas");

console.log("\n===== PELA ROTA =====");
async function entrar(email) {
  const resp = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  return (await resp.json()).token;
}
const get = async (tk, url) => { const resp = await fetch(BASE + url, { headers: { authorization: "Bearer " + tk } }); return { status: resp.status, d: await resp.json() }; };
const tAli = await entrar("ali@fc.com"), tRafael = await entrar("rafael@fc.com"), tZeca = await entrar("zeca@fc.com");
const q = `de=${PERIODO.de}&ate=${PERIODO.ate}`;

console.log("23. O corretor vê só a coorte dele, mande o filtro que mandar");
let x = await get(tRafael, `/painel/funil/${F16.id}?${q}&responsavel=${marina}`);
assert.equal(x.status, 200);
assert.equal(x.d.conversao.base, 1, "só o lead que ERA dele na entrada");
x = await get(tAli, `/painel/funil/${F16.id}?${q}`);
assert.equal(x.d.conversao.base, 3);
console.log("   Rafael: 1 · gestão: 3");

console.log("24. Conferência pela rota: permissão e quem pode abrir");
x = await get(tRafael, `/painel/funil/${F16.id}/conferencia?${q}&conjunto=base&responsavel=${marina}`);
assert.equal(x.d.total, 1);
assert.equal(x.d.itens[0].id, d16b);
assert.equal(x.d.itens[0].pode_abrir, true);
x = await get(tAli, `/painel/funil/${F16.id}/conferencia?${q}&conjunto=base&responsavel=${marina}`);
assert.equal(x.d.itens[0].id, d16);
assert.equal(x.d.itens[0].responsavel_atual, "Rafael");
x = await get(tAli, `/painel/funil/${F16.id}/conferencia?${q}&conjunto=xyz`);
assert.equal(x.status, 400);

console.log("25. Outra imobiliária não lê este funil");
x = await get(tZeca, `/painel/funil/${F1.id}?${q}`);
assert.equal(x.status, 404);
x = await get(tZeca, `/painel/funil/${F1.id}/conferencia?${q}`);
assert.equal(x.status, 404);
console.log("   404 nas duas");

console.log("26. O apelido \"comercial\" responde o funil comercial da casa");
x = await get(tAli, `/painel/funil/comercial?${q}`);
assert.equal(x.status, 200);
assert.ok(x.d.pipeline_id);

console.log("\nTudo certo ✅");
process.exit(0);
