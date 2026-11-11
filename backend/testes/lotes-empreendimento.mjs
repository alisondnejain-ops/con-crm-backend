/* MODO EMPREENDIMENTO E ESPELHO DE LOTES (11/11/2026, services/lotes.js e
   services/kit-reserva.js).

   1. Conta sem o modo: /lotes não existe (404), e o gestor não liga o modo.
   2. O master aplica o pacote do Reserva: modo ligado, 60 lotes da planilha,
      ficha, orientações, mensagens, etiquetas, funil e fluxo (desligado).
   3. Aplicar de novo não duplica nada.
   4. O corretor reserva um lote disponível; o prazo é o da conta.
   5. Outro corretor não reserva o mesmo lote e não vê o cliente do colega.
   6. Liberar: o colega não pode; quem reservou pode.
   7. Vender é da gestão (corretor 403).
   8. Reserva vencida volta a ficar disponível, com histórico.
   9. Importar planilha: prévia não grava; reserva em andamento não é desfeita.
   10. O texto da IA lista os disponíveis e não fala de preço.
   11. O fluxo de boas-vindas do pacote é um fluxo válido para disparar.

   Rodar:  npm run teste:lotes-empreendimento */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-lotes.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4833";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const { textoParaIA } = await import("../src/services/lotes.js");
const { validarGrafo } = await import("../src/services/disparo.js");
const BASE = "http://localhost:4833";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const agora = Date.now();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('org_ch','Casa do ConHub','CH-L',?)").run(agora);
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES ('u_master','org_ch','Ali','ali@ch.com',?,'adm',1,?,'ativo',1)`).run(senha, agora);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo,parceira) VALUES ('org_rr','Reserva Real do Rio','RR-L',?,'imobiliaria',1)").run(agora);
const pessoa = (id, nome, role) => db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, "org_rr", nome, nome.toLowerCase() + "@rr.com", senha, role, agora);
pessoa("u_elder", "Elder", "adm"); pessoa("u_lara", "Lara", "corretor"); pessoa("u_bia", "Bia", "corretor");
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at)
  VALUES ('l_silvio','org_rr','Silvio','5581999990000','{}','Lead',?,'u_lara',?)`).run(agora, agora);
db.prepare(`INSERT INTO leads (id,org_id,name,phone,qual_json,stage,created_at,assigned_to,assigned_at)
  VALUES ('l_outro','org_rr','Cliente da Bia','5581999990001','{}','Lead',?,'u_bia',?)`).run(agora, agora);

// A Lara tinha o WhatsApp pessoal ligado antes do modo, com uma conversa nele.
db.prepare("UPDATE users SET canal_liberado = 1 WHERE id = 'u_lara'").run();
db.prepare("INSERT INTO canais (id,org_id,tipo,user_id,host,token,ativo,created_at) VALUES ('c_lara','org_rr','corretor','u_lara','https://x.uazapi.com','tok-lara',1,?)").run(agora);
db.prepare("UPDATE leads SET canal_id = 'c_lara' WHERE id = 'l_silvio'").run();

// Toda conta de verdade já nasce com o funil padrão (garantirPipelinePadrao no start e na criação).
(await import("../src/services/pipelines.js")).garantirPipelinePadrao("org_rr");

const entrar = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tMaster = await entrar("ali@ch.com"), tElder = await entrar("elder@rr.com"), tLara = await entrar("lara@rr.com"), tBia = await entrar("bia@rr.com");

let ok = 0; const caso = async (nome, fn) => { await fn(); ok++; console.log("✓", nome); };
const lote = (codigo) => db.prepare("SELECT * FROM lotes WHERE org_id = 'org_rr' AND codigo = ?").get(codigo);

await caso("1. Sem o modo, /lotes não existe e o gestor não liga", async () => {
  assert.equal((await chamar(tElder, "/lotes")).status, 404);
  const g = await chamar(tElder, "/orgs/org_rr/empreendimento", "POST", { ligado: true });
  assert.ok(g.status === 403 || g.status === 401);
});

await caso("2. O master aplica o pacote do Reserva", async () => {
  const r = await chamar(tMaster, "/orgs/org_rr/empreendimento/kit-reserva", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.org.empreendimento, true);
  assert.equal(r.d.feito.lotes, 60);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lotes WHERE org_id='org_rr' AND status='disponivel'").get().n, 21);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ia_produtos WHERE org_id='org_rr'").get().n, 1);
  assert.equal(r.d.feito.orientacoes, 7); assert.equal(r.d.feito.mensagens, 5); assert.equal(r.d.feito.tags, 5);
  assert.equal(r.d.feito.funil, true); assert.equal(r.d.feito.fluxo, true);
  const p = db.prepare("SELECT * FROM pipelines WHERE org_id='org_rr' AND name='Vendas de lotes'").get();
  assert.equal(p.is_default, 0, "a conta tem leads: o funil não vira padrão sozinho");
  assert.ok(r.d.feito.avisos.some(a => /não virou o padrão/.test(a)));
  assert.equal(lote("A1").area, 708.15); assert.equal(lote("D16").area, 1209.67); assert.equal(lote("A7").status, "vendido");
  // A sessão do gestor diz que a conta é de empreendimento.
  const me = await chamar(tElder, "/auth/me");
  assert.equal(me.d.org.empreendimento, true);
});

await caso("3. Aplicar de novo não duplica nada", async () => {
  const r = await chamar(tMaster, "/orgs/org_rr/empreendimento/kit-reserva", "POST", {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.feito.lotes, r.d.feito.orientacoes, r.d.feito.mensagens, r.d.feito.tags, r.d.feito.funil, r.d.feito.fluxo, r.d.feito.ficha], [0, 0, 0, 0, false, false, false]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lotes WHERE org_id='org_rr'").get().n, 60);
});

await caso("4. O corretor reserva um lote disponível pelo prazo da conta", async () => {
  const l = lote("B1");
  const r = await chamar(tLara, `/lotes/${l.id}/reservar`, "POST", { lead_id: "l_silvio" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.horas, 24);
  const d = lote("B1");
  assert.equal(d.status, "reservado"); assert.equal(d.corretor_id, "u_lara"); assert.equal(d.cliente, "Silvio");
  assert.ok(Math.abs(d.vence_em - (Date.now() + 24 * 3600000)) < 60000);
  // Lote vendido não se reserva.
  assert.equal((await chamar(tLara, `/lotes/${lote("A7").id}/reservar`, "POST", { cliente: "X" })).status, 409);
  // Cliente de outro corretor não serve.
  assert.equal((await chamar(tLara, `/lotes/${lote("B2").id}/reservar`, "POST", { lead_id: "l_outro" })).status, 403);
});

await caso("5. Outro corretor não reserva o mesmo lote nem vê o cliente do colega", async () => {
  const l = lote("B1");
  assert.equal((await chamar(tBia, `/lotes/${l.id}/reservar`, "POST", { cliente: "Fulano" })).status, 409);
  const vBia = (await chamar(tBia, "/lotes")).d.lotes.find(x => x.codigo === "B1");
  assert.equal(vBia.status, "reservado"); assert.equal(vBia.corretor, "Lara"); assert.equal(vBia.cliente, null); assert.equal(vBia.lead_id, null);
  const vLara = (await chamar(tLara, "/lotes")).d.lotes.find(x => x.codigo === "B1");
  assert.equal(vLara.cliente, "Silvio"); assert.equal(vLara.meu, true);
  const vElder = (await chamar(tElder, "/lotes")).d.lotes.find(x => x.codigo === "B1");
  assert.equal(vElder.cliente, "Silvio");
});

await caso("6. Liberar: o colega não, quem reservou sim", async () => {
  const l = lote("B1");
  assert.equal((await chamar(tBia, `/lotes/${l.id}/liberar`, "POST", {})).status, 403);
  assert.equal((await chamar(tLara, `/lotes/${l.id}/liberar`, "POST", {})).status, 200);
  assert.equal(lote("B1").status, "disponivel"); assert.equal(lote("B1").cliente, null);
});

await caso("7. Vender é da gestão", async () => {
  const l = lote("B2");
  await chamar(tLara, `/lotes/${l.id}/reservar`, "POST", { lead_id: "l_silvio" });
  assert.equal((await chamar(tLara, `/lotes/${l.id}/vender`, "POST", {})).status, 403);
  assert.equal((await chamar(tElder, `/lotes/${l.id}/vender`, "POST", {})).status, 200);
  const d = lote("B2"); assert.equal(d.status, "vendido"); assert.equal(d.lead_id, "l_silvio"); assert.ok(d.vendido_em);
  // Edição na mão também é só da gestão.
  assert.equal((await chamar(tLara, `/lotes/${lote("B3").id}`, "PATCH", { preco: "150.000" })).status, 403);
  assert.equal((await chamar(tElder, `/lotes/${lote("B3").id}`, "PATCH", { preco: "150.000,00", status: "bloqueado" })).status, 200);
  assert.equal(lote("B3").preco, 150000); assert.equal(lote("B3").status, "bloqueado");
});

await caso("8. Reserva vencida volta a ficar disponível, com histórico", async () => {
  const l = lote("B4");
  await chamar(tLara, `/lotes/${l.id}/reservar`, "POST", { cliente: "Maria" });
  db.prepare("UPDATE lotes SET vence_em = ? WHERE id = ?").run(Date.now() - 1000, l.id);
  const v = (await chamar(tElder, "/lotes")).d.lotes.find(x => x.codigo === "B4");
  assert.equal(v.status, "disponivel");
  const h = (await chamar(tElder, `/lotes/${l.id}/historico`)).d.historico;
  assert.equal(h[0].acao, "venceu"); assert.equal(h[1].acao, "reservou");
  // Prorrogar é da gestão.
  await chamar(tLara, `/lotes/${l.id}/reservar`, "POST", { cliente: "Maria" });
  assert.equal((await chamar(tLara, `/lotes/${l.id}/prorrogar`, "POST", { horas: 12 })).status, 403);
  const p = await chamar(tElder, `/lotes/${l.id}/prorrogar`, "POST", { horas: 12 });
  assert.equal(p.status, 200); assert.ok(lote("B4").vence_em > Date.now() + 35 * 3600000);
});

await caso("9. Importar: prévia não grava, e reserva em andamento não é desfeita", async () => {
  const texto = "Lote;Quadra;Área (m²);Status\nB4;B;600,00;Disponível\nE1;E;450,50;Disponível\nE2;E;470;Vendido\nE3;E;;Talvez";
  const prev = await chamar(tElder, "/lotes/importar", "POST", { texto, previa: true });
  assert.equal(prev.status, 200); assert.equal(prev.d.novos, 2); assert.equal(prev.d.fora.length, 1);
  assert.equal(lote("E1"), undefined);
  assert.equal((await chamar(tLara, "/lotes/importar", "POST", { texto })).status, 403);
  const imp = await chamar(tElder, "/lotes/importar", "POST", { texto });
  assert.equal(imp.status, 200); assert.equal(lote("E1").area, 450.5); assert.equal(lote("E2").status, "vendido");
  assert.equal(lote("B4").status, "reservado", "a planilha não desfaz a reserva da Lara");
  // Vírgula como separador também é lida (a área partida em duas colunas volta inteira).
  const csv = "Lote,Quadra,Área (m²),Status\nE4,E,612,69,Disponível";
  await chamar(tElder, "/lotes/importar", "POST", { texto: csv });
  assert.equal(lote("E4").area, 612.69);
});

await caso("10. O texto da IA lista os disponíveis, sem preço", async () => {
  const t = textoParaIA("org_rr");
  assert.match(t, /SITUAÇÃO DOS LOTES/); assert.match(t, /A1 \(708,15 m²\)/);
  assert.ok(!/A7 \(/.test(t), "vendido não entra"); assert.ok(!/B3 \(/.test(t), "bloqueado não entra");
  assert.ok(!/R\$/.test(t)); assert.match(t, /não informe/); assert.match(t, /rdantassmart\.com\/reservarealdorio/);
  // Conta sem o modo não manda nada.
  assert.equal(textoParaIA("org_ch"), "");
});

await caso("11. O fluxo de boas-vindas é válido para disparar", async () => {
  const f = db.prepare("SELECT * FROM marketing_fluxos WHERE org_id = 'org_rr'").get();
  const v = validarGrafo(JSON.parse(f.grafo), { paraDisparar: true });
  assert.deepEqual(v.erros, []);
  assert.equal(JSON.parse(f.grafo).nos.length, 10);
});

await caso("12. Só o número da casa: o WhatsApp pessoal foi desligado e não religa", async () => {
  const c = db.prepare("SELECT ativo, token FROM canais WHERE id = 'c_lara'").get();
  assert.equal(c.ativo, 0); assert.ok(!c.token);
  assert.equal(db.prepare("SELECT canal_id FROM leads WHERE id = 'l_silvio'").get().canal_id, null);
  assert.equal(db.prepare("SELECT canal_liberado FROM users WHERE id = 'u_lara'").get().canal_liberado, 0);
  const meu = await chamar(tLara, "/canais/meu", "POST", {});
  assert.equal(meu.status, 403); assert.match(meu.d.error, /número da imobiliária/);
  const lib = await chamar(tElder, "/canais/liberar", "POST", { user_id: "u_lara", liberado: true });
  assert.equal(lib.status, 403);
  const tr = await chamar(tLara, "/leads/l_silvio/canal", "POST", { para: "minha" });
  assert.equal(tr.status, 403);
  // E ligar do celular também não (o botão some; a rota recusa).
  assert.equal((await chamar(tLara, "/leads/l_silvio/ligacao", "POST", {})).status, 403);
});

await caso("13. O corretor não abre a Base de leads (importar, exportar, lote)", async () => {
  for (const [m, c] of [["GET", "/leads/export"], ["POST", "/leads/import"], ["GET", "/leads/importacoes"], ["GET", "/leads/lote/passar"]])
    assert.equal((await chamar(tLara, c, m, m === "POST" ? {} : undefined)).status, 403, c);
});

console.log(`\n${ok} casos passaram.`);
process.exit(0);
