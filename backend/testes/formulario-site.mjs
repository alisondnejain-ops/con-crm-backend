/* FORMULÁRIO DO SITE — POST /publico/leads (11/11/2026,
   services/entrada-site.js, routes/entrada-site.routes.js).

   1. Sem token ou com token errado: 401.
   2. Só o gestor gera e configura o token (corretor 403).
   3. Preflight (OPTIONS): site liberado recebe os cabeçalhos; outro, 403.
   4. Lead novo: 201, corretor DISPONÍVEL da vez, etapa escolhida, temperatura,
      campanha, campos da conta e a observação com tudo.
   5. Mesmo telefone: o mesmo lead (sem duplicar), com observação nova.
   6. Validação: sem nome 400, telefone inválido 422, sem consentimento 422.
   7. Site não liberado: 403.
   8. Ninguém disponível: fica na fila (sem atendente), não vai a indisponível.
   9. Desligado: 403.
   10. Limite por IP: 429.

   Rodar:  npm run teste:formulario-site */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-formulario-site.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4847";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.SITE_LEADS_POR_IP = "14";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const BASE = "http://localhost:4847";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const agora = Date.now();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('org_rr','Reserva Real do Rio','RR-F',?)").run(agora);
const pessoa = (id, nome, role, disp) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,?,?,'ativo')`).run(id, "org_rr", nome, nome.toLowerCase() + "@rr.com", senha, role, disp, agora);
pessoa("u_elder", "Elder", "adm", 1); pessoa("u_lara", "Lara", "corretor", 1); pessoa("u_bia", "Bia", "corretor", 0);
const pip = await import("../src/services/pipelines.js");
pip.garantirPipelinePadrao("org_rr");
const funil = pip.criarPipeline("org_rr", { name: "Vendas de lotes", type: "custom" }).pipeline;
pip.inserirEtapa("org_rr", funil.id, { name: "Lead novo" }, 0);
pip.inserirEtapa("org_rr", funil.id, { name: "Primeiro contato" }, 1);
const leadNovo = db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id = ? AND name = 'Lead novo'").get(funil.id).id;
// O campo que o pacote do Reserva cria.
db.prepare(`INSERT INTO custom_fields (id,org_id,name,key,type,options,ordem,is_active,created_at) VALUES ('cf1','org_rr','Motivo da compra','motivo_da_compra','select',?,0,1,?)`)
  .run(JSON.stringify(["Construir para morar", "Investir", "Lazer"]), agora);

const entrar = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tElder = await entrar("elder@rr.com"), tLara = await entrar("lara@rr.com");
const SITE = "https://rdantassmart.com";
let TOKEN = null;
const enviar = async (corpo, { token = TOKEN, origem = SITE } = {}) => {
  const h = { "content-type": "application/json" };
  if (token) h.authorization = "Bearer " + token;
  if (origem) h.origin = origem;
  const r = await fetch(BASE + "/publico/leads", { method: "POST", headers: h, body: JSON.stringify(corpo) });
  return { status: r.status, d: await r.json().catch(() => ({})), cors: r.headers.get("access-control-allow-origin") };
};
const corpo = (extra = {}) => ({
  nome: "Carla Souza", telefone: "+5587991234567", cidade: "Petrolina", empreendimento: "Reserva Real do Rio",
  origem: "Landing Reserva", objetivo: "Investir", pagamento: "Parcelado", prazo: "Até 3 meses", visita: "Sim",
  temperatura: "Quente", observacao: "Quero lote perto do rio", consentimento_lgpd: true,
  utm_source: "facebook", utm_medium: "cpc", utm_campaign: "reserva-novembro", utm_content: "video1", utm_term: "lote",
  pagina: "https://rdantassmart.com/reservarealdorio/cadastro/", data_hora: "2026-11-11T15:00:00-03:00", ...extra });

let ok = 0; const caso = async (nome, fn) => { await fn(); ok++; console.log("✓", nome); };

await caso("1. Sem token ou com token errado: 401", async () => {
  assert.equal((await enviar(corpo(), { token: null })).status, 401);
  assert.equal((await enviar(corpo(), { token: "lp_errado" })).status, 401);
});

await caso("2. Só o gestor gera e configura o token", async () => {
  assert.equal((await chamar(tLara, "/config/formulario-site/token", "POST")).status, 403);
  const g = await chamar(tElder, "/config/formulario-site/token", "POST");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.ok(/^lp_/.test(g.d.token)); assert.ok(g.d.endereco.endsWith("/publico/leads"));
  TOKEN = g.d.token;
  const s = await chamar(tElder, "/config/formulario-site", "PATCH", { origens: [SITE + "/"], quem_recebe: "corretor", stage_id: leadNovo });
  assert.equal(s.status, 200, JSON.stringify(s.d));
  assert.deepEqual(s.d.origens, [SITE]);
  assert.equal(s.d.stage_id, leadNovo);
  assert.equal((await chamar(tElder, "/config/formulario-site", "PATCH", { origens: ["isto não é site"] })).status, 400);
});

await caso("3. Preflight: site liberado recebe os cabeçalhos; outro, 403", async () => {
  const r = await fetch(BASE + "/publico/leads", { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,authorization" } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), SITE);
  assert.ok(/authorization/i.test(r.headers.get("access-control-allow-headers")));
  const x = await fetch(BASE + "/publico/leads", { method: "OPTIONS", headers: { origin: "https://outro.com", "access-control-request-method": "POST" } });
  assert.equal(x.status, 403);
});

let primeiro;
await caso("4. Lead novo vai ao corretor disponível, na etapa escolhida, com tudo gravado", async () => {
  const r = await enviar(corpo());
  assert.equal(r.status, 201, JSON.stringify(r.d));
  assert.equal(r.d.novo, true); assert.equal(r.cors, SITE);
  primeiro = r.d.lead_id;
  const l = db.prepare("SELECT * FROM leads WHERE id = ?").get(primeiro);
  assert.equal(l.org_id, "org_rr"); assert.equal(l.phone, "5587991234567"); assert.equal(l.name, "Carla Souza");
  assert.equal(l.assigned_to, "u_lara", "só a Lara está disponível");
  assert.equal(l.stage_id, leadNovo); assert.equal(l.pipeline_id, funil.id);
  assert.equal(l.priority, "QUENTE"); assert.equal(l.campaign_name, "reserva-novembro");
  assert.equal(l.origem, "Landing Reserva"); assert.equal(l.source, "site");
  assert.equal(JSON.parse(l.custom_fields).motivo_da_compra, "Investir");
  const o = db.prepare("SELECT texto FROM observacoes WHERE lead_id = ?").all(primeiro).map(x => x.texto).join("\n");
  for (const t of ["Objetivo: Investir", "Pagamento: Parcelado", "Prazo: Até 3 meses", "Visita: Sim", "utm_campaign=reserva-novembro", "Consentimento LGPD: sim", "Quero lote perto do rio", "rdantassmart.com/reservarealdorio"])
    assert.ok(o.includes(t), t);
});

await caso("5. Mesmo telefone: o mesmo lead, com observação nova", async () => {
  const r = await enviar(corpo({ nome: "Carla S.", telefone: "87991234567", temperatura: "Frio" }));
  assert.equal(r.status, 201, JSON.stringify(r.d));
  assert.equal(r.d.novo, false); assert.equal(r.d.lead_id, primeiro);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id='org_rr' AND phone LIKE '%991234567'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observacoes WHERE lead_id = ?").get(primeiro).n, 2);
  // Temperatura posta na mão não é apagada pelo formulário.
  db.prepare("UPDATE leads SET priority='MORNO', priority_por='mao' WHERE id = ?").run(primeiro);
  await enviar(corpo({ temperatura: "Frio" }));
  assert.equal(db.prepare("SELECT priority FROM leads WHERE id = ?").get(primeiro).priority, "MORNO");
});

await caso("6. Validação: nome, telefone e consentimento", async () => {
  const a = await enviar(corpo({ nome: "" })); assert.equal(a.status, 400); assert.ok(/nome/i.test(a.d.error));
  const b = await enviar(corpo({ telefone: "" })); assert.equal(b.status, 400);
  const c = await enviar(corpo({ telefone: "123" })); assert.equal(c.status, 422); assert.ok(/telefone/i.test(c.d.error));
  const d = await enviar(corpo({ telefone: "+5587990000001", consentimento_lgpd: false })); assert.equal(d.status, 422);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone = '5587990000001'").get().n, 0);
});

await caso("7. Site não liberado: 403", async () => {
  const r = await enviar(corpo({ telefone: "+5587990000002" }), { origem: "https://outro.com" });
  assert.equal(r.status, 403);
});

await caso("8. Ninguém disponível: fila, nunca a quem está indisponível", async () => {
  db.prepare("UPDATE users SET available = 0 WHERE id = 'u_lara'").run();
  const r = await enviar(corpo({ nome: "Pedro", telefone: "+5587990000003" }));
  assert.equal(r.status, 201, JSON.stringify(r.d));
  const l = db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(r.d.lead_id);
  assert.equal(l.assigned_to, null);
  db.prepare("UPDATE users SET available = 1 WHERE id = 'u_lara'").run();
});

await caso("9. Desligado: 403", async () => {
  await chamar(tElder, "/config/formulario-site", "PATCH", { ativo: false });
  assert.equal((await enviar(corpo({ telefone: "+5587990000004" }))).status, 403);
  await chamar(tElder, "/config/formulario-site", "PATCH", { ativo: true });
});

await caso("10. Limite por IP: 429", async () => {
  let viu429 = false;
  for (let i = 0; i < 16 && !viu429; i++) if ((await enviar(corpo({ telefone: "+55879900001" + String(i).padStart(2, "0") }))).status === 429) viu429 = true;
  assert.ok(viu429);
});

console.log(`\n${ok} casos passaram.`);
process.exit(0);
