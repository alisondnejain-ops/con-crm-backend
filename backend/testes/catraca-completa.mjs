/* CATRACA COMPLETA (CETRO 11, 13/11/2026).

   1. Precedência: anúncio > formulário > campanha > imóvel > canal inteiro.
   2. Destino alternativo quando ninguém está disponível: gestor e fila.
   3. Prazo para pegar com "avisar o gestor": o lead fica com o corretor.
   4. Lead repetido: gestor, origem (sem desfazer repasse legítimo) e etapa.
   Rodar:  npm run teste:catraca-completa */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-catraca-completa.db");
process.env.JWT_SECRET = "teste";
for (const k of ["AGENDADAS_AGENDADOR", "MARKETING_AGENDADOR", "PRAZO_AGENDADOR", "UAZAPI_AUTOCONFIGURAR", "CATRACA_TEMPO_AGENDADOR"]) process.env[k] = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { receberLead } = await import("../src/services/portais.js");
const { criar, editar } = await import("../src/services/catracas.js");
const { agirSemResposta } = await import("../src/services/catraca-tempo.js");
const { trocarResponsavel } = await import("../src/services/movimento.js");
const { garantirPipelines } = await import("../src/services/pipelines.js").catch(() => ({}));

const org = "org_cc";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Casa CC", "CC-1", Date.now());
(await import("../src/services/pipelines.js")).garantirPipelinePadrao(org);
const pessoa = (id, papel, disp = 1) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x',?,?,?,'ativo')`).run(id, org, id, id + "@cc.com", papel, disp, Date.now());
pessoa("g", "adm"); pessoa("a1", "corretor"); pessoa("a2", "corretor"); pessoa("b1", "corretor"); pessoa("z", "corretor", 0);

let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); }
}
let n = 0;
const form = (extra = {}) => receberLead(org, { portal: "Meta", formulario: true, telefone: "5587991" + String(100000 + (++n)),
  nome: "Cliente " + n, qual: {}, respostas: {}, anuncio: { form_id: "F1", campaign_id: "C1", campaign_name: "Campanha 1", ad_id: "AD9", platform: "fb", ...extra } });
const dono = (id) => db.prepare("SELECT assigned_to, catraca_id FROM leads WHERE id = ?").get(id);

const cForm = criar(org, "g", { nome: "Pelo formulário", entrega: "corretor", membros: ["a1"], canais: { formularios: ["F1"] } });
const cCamp = criar(org, "g", { nome: "Pela campanha", entrega: "corretor", membros: ["a2"], canais: { campanhas: ["C1"] } });

console.log("Catraca completa");
await caso("1. Precedência: formulário ganha da campanha; anúncio ganha de tudo", async () => {
  let r = form(); assert.equal(dono(r.lead_id).catraca_id, cForm); assert.equal(dono(r.lead_id).assigned_to, "a1");
  const cAd = criar(org, "g", { nome: "Pelo anúncio", entrega: "corretor", membros: ["b1"], canais: { anuncios: ["AD9"] } });
  r = form(); assert.equal(dono(r.lead_id).catraca_id, cAd); assert.equal(dono(r.lead_id).assigned_to, "b1");
  editar(org, cAd, { ativa: false });
  r = form({ form_id: "F-outro" }); assert.equal(dono(r.lead_id).catraca_id, cCamp, "sem formulário ligado, a campanha deveria valer");
});

await caso("2. Ninguém disponível: vai ao gestor; com 'fila', fica sem dono", async () => {
  const c = criar(org, "g", { nome: "Ninguém", entrega: "corretor", membros: ["z"], canais: { formularios: ["F2"] }, fallback: "gestor" });
  let r = form({ form_id: "F2", ad_id: null, campaign_id: null, campaign_name: null });
  assert.equal(dono(r.lead_id).assigned_to, "g");
  editar(org, c, { fallback: "fila" });
  r = form({ form_id: "F2", ad_id: null, campaign_id: null, campaign_name: null });
  assert.equal(dono(r.lead_id).assigned_to, null);
  assert.throws(() => editar(org, c, { fallback: "x" }), /inválido/);
});

await caso("3. Prazo vencido com 'avisar o gestor': o lead fica", async () => {
  editar(org, cForm, { tempo_resposta_min: 5, tempo_acao: "notificar" });
  const r = form({ ad_id: null });
  db.prepare("UPDATE leads SET assigned_at = ? WHERE id = ?").run(Date.now() - 600000, r.lead_id);
  db.prepare("UPDATE leads SET stage_id = NULL WHERE id = ?").run(r.lead_id);
  db.prepare("UPDATE catracas SET tempo_desde = ? WHERE id = ?").run(Date.now() - 3600000, cForm);
  const feitos = await agirSemResposta(org);
  assert.ok(feitos.some(f => f.lead_id === r.lead_id && f.acao === "notificar"));
  assert.equal(dono(r.lead_id).assigned_to, "a1", "avisar o gestor não pode tirar o lead");
  const de_novo = await agirSemResposta(org);
  assert.ok(!de_novo.some(f => f.lead_id === r.lead_id), "avisou duas vezes");
  editar(org, cForm, { tempo_resposta_min: null, tempo_acao: "proximo" });
});

await caso("4. Lead repetido: gestor, origem e etapa", async () => {
  const tel = "5587992000001";
  const um = (extra = {}) => receberLead(org, { portal: "Meta", formulario: true, telefone: tel, nome: "Volta", qual: {}, respostas: {},
    anuncio: { form_id: "F1", campaign_id: null, ad_id: null, platform: "fb", ...extra } });
  const r = um(); const id = r.lead_id;
  assert.equal(dono(id).assigned_to, "a1");
  // padrão: fica com quem está
  um(); assert.equal(dono(id).assigned_to, "a1");
  // gestor
  editar(org, cForm, { repetido: "gestor" }); um(); assert.equal(dono(id).assigned_to, "g");
  // origem: volta ao primeiro corretor (a1), porque foi a política que tirou
  editar(org, cForm, { repetido: "origem" }); um(); assert.equal(dono(id).assigned_to, "a1");
  // repasse legítimo de a1 para a2: a origem não desfaz
  trocarResponsavel(id, "a2", "g", "mao"); um(); assert.equal(dono(id).assigned_to, "a2");
  // etapa
  const st = db.prepare("SELECT s.id FROM pipeline_stages s WHERE s.org_id = ? ORDER BY s.ordem DESC LIMIT 1").get(org);
  assert.ok(st, "a conta do teste ficou sem funil");
  editar(org, cForm, { repetido: "etapa", repetido_stage_id: st.id }); um();
  assert.equal(db.prepare("SELECT stage_id FROM leads WHERE id = ?").get(id).stage_id, st.id);
  assert.throws(() => editar(org, cForm, { repetido: "etapa", repetido_stage_id: null }));
});

console.log(falhas ? `\n${falhas} caso(s) falharam ❌` : "\nTudo certo ✅");
process.exit(falhas ? 1 : 0);
