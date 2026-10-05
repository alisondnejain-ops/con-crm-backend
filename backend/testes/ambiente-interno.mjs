/* AMBIENTE INTERNO DO CONHUB (05/10/2026).

   Servidor de pé e uma Uazapi de mentira. O que precisa continuar valendo:
   - existe UM ambiente interno, criado pelo hub, fora da lista de clientes;
   - ele nunca é cobrado nem travado, e não se apaga nem muda de tipo;
   - nasce com o funil comercial do ConHub, sem os modelos de imóvel;
   - o chamado de suporte de um cliente sai pelo WhatsApp DELE (não mais pelo
     da conta do master), e a equipe dele responde de dentro do sistema;
   - nada disso muda o que uma imobiliária vê.

   Rodar:  npm run teste:ambiente-interno */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-interno.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

/* A Uazapi de mentira guarda por qual instância (token) cada mensagem saiu. */
const enviados = [];
let seq = 0;
const uaz = http.createServer((req, res) => {
  let corpo = ""; req.on("data", c => corpo += c);
  req.on("end", () => {
    const d = JSON.parse(corpo || "{}");
    res.setHeader("content-type", "application/json");
    if (req.url === "/send/text") {
      const id = "3EB0INT" + (++seq);
      enviados.push({ ...d, id, token: req.headers.token });
      return res.end(JSON.stringify({ messageid: id }));
    }
    res.end(JSON.stringify({}));
  });
});
await new Promise(r => uaz.listen(4883, "127.0.0.1", r));

const PORTA = 4797;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "",
    ANTHROPIC_API_KEY: "", UAZAPI_AUTOCONFIGURAR: "0", MARKETING_AGENDADOR: "0", SITE_DOMINIO_AGENDADOR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => { saida += d; });
servidor.stderr.on("data", d => { saida += d; });
const url = p => `http://127.0.0.1:${PORTA}${p}`;
const fim = (codigo) => { servidor.kill("SIGTERM"); uaz.close(); process.exit(codigo); };
process.on("uncaughtException", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-2500)); fim(1); });
process.on("unhandledRejection", e => { console.error("\n" + (e.stack || e.message)); console.error(saida.slice(-2500)); fim(1); });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(url("/health")); if (r.ok) break; } catch (e) {}
  await new Promise(x => setTimeout(x, 250));
}

const { default: db } = await import("../src/db.js");
const { sign } = await import("../src/auth.js");
const C = await import("../src/services/canais.js");
const { recursosDaOrg } = await import("../src/services/recursos.js");
const { sugerirEtapa } = await import("../src/routes/messages.routes.js");

/* A conta mais antiga é a de um cliente (como a Conecta), e é nela que mora
   o master — o caso que fazia o suporte sair pelo WhatsApp do cliente. */
const conecta = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
db.prepare("UPDATE orgs SET name='Conecta', uazapi_host='http://127.0.0.1:4883', uazapi_token='token-conecta' WHERE id=?").run(conecta);
C.garantirCasa(conecta);
const novo = (id, org, nome, papel, master = 0) =>
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,'x',?,1,?,'ativo',?)`).run(id, org, nome, nome.toLowerCase() + "@c.com", papel, Date.now(), master);
novo("u_ali", conecta, "Ali", "adm", 1);
novo("u_gisele", conecta, "Gisele", "adm");

const cracha = (id) => "Bearer " + sign(db.prepare("SELECT * FROM users WHERE id=?").get(id));
const api = async (quem, metodo, p, corpo) => {
  const r = await fetch(url(p), { method: metodo, headers: { authorization: cracha(quem), "content-type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const esperar = (ms = 400) => new Promise(r => setTimeout(r, ms));

let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

caso("o hub cria o ambiente interno uma vez só, fora da lista de clientes");
{
  const a = await api("u_ali", "POST", "/orgs/interna", {});
  assert.equal(a.status, 200);
  assert.equal(a.body.criado, true);
  assert.equal(a.body.org.tipo, "interna");
  const b = await api("u_ali", "POST", "/orgs/interna", {});
  assert.equal(b.body.criado, false, "segunda chamada não cria outro");
  assert.equal(b.body.org.id, a.body.org.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orgs WHERE tipo='interna'").get().n, 1);
  const hub = await api("u_ali", "GET", "/orgs");
  assert.ok(!hub.body.orgs.some(o => o.id === a.body.org.id), "não aparece entre as imobiliárias");
  assert.ok(!hub.body.autonomos.some(o => o.id === a.body.org.id));
  assert.equal(hub.body.interna.id, a.body.org.id);
  const gestor = await api("u_gisele", "POST", "/orgs/interna", {});
  assert.equal(gestor.status, 403, "só o master cria");
  console.log("   ok");
}
const interna = db.prepare("SELECT id FROM orgs WHERE tipo='interna'").get().id;
novo("u_bia", interna, "Bia", "adm");
novo("u_caio", interna, "Caio", "corretor");

caso("nasce com o funil comercial do ConHub, e os modelos de imóvel não aparecem para ele");
{
  const r = await api("u_bia", "GET", "/pipelines");
  assert.equal(r.status, 200);
  assert.equal(r.body.pipelines.length, 1);
  const etapas = r.body.pipelines[0].stages.map(e => e.name);
  assert.deepEqual(etapas, ["Lead novo", "Primeiro contato", "Demonstração agendada", "Demonstração feita",
    "Em teste grátis", "Proposta", "Cliente", "Perdido"]);
  const modelos = r.body.templates.map(t => t.id);
  assert.ok(modelos.includes("conhub_comercial"));
  assert.ok(!modelos.includes("comercial") && !modelos.includes("locacao"), "sem modelo imobiliário: " + modelos);
  const cliente = await api("u_gisele", "GET", "/pipelines");
  const doCliente = cliente.body.templates.map(t => t.id);
  assert.ok(doCliente.includes("locacao") && !doCliente.includes("conhub_comercial"), "a imobiliária continua como era");
  console.log("   ok");
}

caso("nunca é cobrado nem travado — nem com vencimento no passado");
{
  db.prepare("UPDATE orgs SET vence_em = ?, exige_cartao = 1 WHERE id = ?").run(Date.now() - 90 * 86400000, interna);
  const s = await api("u_bia", "GET", "/assinatura");
  assert.equal(s.status, 200);
  assert.equal(s.body.status, "ativo");
  assert.equal(s.body.cobranca, false);
  const leads = await api("u_bia", "GET", "/leads");
  assert.equal(leads.status, 200, "o porteiro deixa passar");
  const plano = await api("u_bia", "POST", "/assinatura/cartao", { token: "tok", cpfCnpj: "11144477735" });
  assert.equal(plano.status, 409, "não dá para pôr cartão nem plano");
  console.log("   ok");
}

caso("Marketing ligado, Autoatendimento desligado");
{
  const r = Object.fromEntries(recursosDaOrg(interna).map(x => [x.id, x.ativo]));
  assert.equal(r.marketing, true);
  assert.equal(r.autoatendimento, false);
  console.log("   ok");
}

caso("não se apaga nem muda de tipo pelo hub");
{
  const apagar = await api("u_ali", "DELETE", "/orgs/" + interna, { confirmar: "ConHub" });
  assert.equal(apagar.status, 409);
  const tipo = await api("u_ali", "POST", `/orgs/${interna}/tipo`, { tipo: "autonomo", dono_user_id: "u_bia" });
  assert.equal(tipo.status, 409);
  assert.ok(db.prepare("SELECT 1 FROM orgs WHERE id=? AND tipo='interna'").get(interna));
  console.log("   ok");
}

caso("o chamado do cliente sai pelo WhatsApp do ambiente interno, não pelo da Conecta");
let chamadoId;
{
  db.prepare("UPDATE orgs SET uazapi_host='http://127.0.0.1:4883', uazapi_token='token-interno' WHERE id=?").run(interna);
  C.garantirCasa(interna);
  const r = await api("u_gisele", "POST", "/suporte/humano", { resumo: "Não consigo importar a planilha." });
  assert.equal(r.status, 200);
  await esperar();
  const msg = enviados.find(e => /Suporte #/.test(e.text || ""));
  assert.ok(msg, "o chamado foi enviado");
  assert.equal(msg.token, "token-interno", "saiu pela linha do ambiente interno");
  assert.equal(msg.number, "5581999353988");
  chamadoId = db.prepare("SELECT id FROM suporte_chamados ORDER BY created_at DESC LIMIT 1").get().id;
  console.log("   ok");
}

caso("a equipe do ConHub vê e responde os chamados; o cliente não");
{
  for (const quem of ["u_bia", "u_caio", "u_ali"]) {
    const r = await api(quem, "GET", "/suporte/chamados");
    assert.equal(r.status, 200, quem);
    assert.ok(r.body.chamados.some(c => c.id === chamadoId));
  }
  const cliente = await api("u_gisele", "GET", "/suporte/chamados");
  assert.equal(cliente.status, 403);
  const espiar = await api("u_gisele", "GET", `/suporte/hub/chamados/${chamadoId}`);
  assert.equal(espiar.status, 403, "cliente não abre chamado pelo painel");
  const config = await api("u_bia", "GET", "/suporte/hub");
  assert.equal(config.status, 403, "configurar o número continua só do master");
  const antes = enviados.length;
  const resp = await api("u_caio", "POST", `/suporte/hub/chamados/${chamadoId}/responder`, { texto: "Já vou te ajudar." });
  assert.equal(resp.status, 200);
  await esperar();
  assert.ok(enviados.slice(antes).some(e => /por Caio/.test(e.text || "")), "o WhatsApp do suporte sabe quem respondeu");
  const naNuvem = await api("u_gisele", "GET", "/suporte");
  assert.ok(naNuvem.body.chamado.mensagens.some(m => m.de === "suporte" && /Já vou te ajudar/.test(m.texto)));
  // Quem sai da equipe do ConHub perde a fila na hora.
  db.prepare("UPDATE users SET status='removido' WHERE id='u_caio'").run();
  assert.equal((await api("u_caio", "GET", "/suporte/chamados")).status, 401);
  console.log("   ok");
}

caso("venda num funil sem etapa 'Venda' vai para a etapa de ganho (Cliente)");
let leadId;
{
  const r = await api("u_bia", "POST", "/leads", { nome: "Imobiliária Prospect", telefone: "87991112222" });
  assert.ok(r.status === 200 || r.status === 201, r.status + " " + (r.body.error || ""));
  leadId = r.body.lead?.id || r.body.id;
  assert.ok(leadId);
  const v = await api("u_bia", "PATCH", `/leads/${leadId}/venda`, { valor: "497", data: new Date().toISOString().slice(0, 10), imovel: "Essencial" });
  assert.equal(v.status, 200);
  assert.equal(v.body.stage, "Cliente");
  const lead = db.prepare("SELECT stage, stage_id FROM leads WHERE id=?").get(leadId);
  const etapa = db.prepare("SELECT name, status_type FROM pipeline_stages WHERE id=?").get(lead.stage_id);
  assert.equal(etapa.name, "Cliente");
  assert.equal(etapa.status_type, "ganho");
  console.log("   ok");
}

caso("o Painel conta a demonstração feita (onde a imobiliária conta a visita)");
{
  const r = await api("u_bia", "POST", "/leads", { nome: "Outro Prospect", telefone: "87991113333" });
  const id = r.body.lead?.id || r.body.id;
  const etapa = db.prepare(`SELECT s.id FROM pipeline_stages s WHERE s.org_id=? AND s.name='Demonstração feita'`).get(interna).id;
  const m = await api("u_bia", "PATCH", `/leads/${id}/stage`, { stage_id: etapa });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const p = await api("u_bia", "GET", "/painel/geral?periodo=este_mes");
  assert.equal(p.status, 200);
  assert.equal(p.body.kpis.visitas.atual, 1);
  const passo = p.body.funil_atividade.find(x => x.id === "visita_realizada");
  assert.equal(passo.nome, "Demonstrações feitas");
  assert.equal(passo.valor, 1);
  console.log("   ok");
}

caso("mensagens prontas de venda do ConHub, e a palavra-chave de imóvel não sugere etapa");
{
  const r = await api("u_bia", "GET", "/config/mensagens");
  assert.equal(r.status, 200);
  const titulos = (r.body.mensagens || r.body).map(x => x.titulo);
  assert.ok(titulos.includes("Agendar demonstração"), titulos.join(", "));
  assert.ok(!titulos.includes("Pedir documentação"));
  db.prepare(`INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES ('m1',?,'in','Vou mandar a documentação',?)`)
    .run(leadId, Date.now());
  db.prepare("UPDATE leads SET stage='Lead novo' WHERE id=?").run(leadId);
  sugerirEtapa(leadId);
  assert.equal(db.prepare("SELECT sugestao_etapa FROM leads WHERE id=?").get(leadId).sugestao_etapa, null);
  const cliente = await api("u_gisele", "GET", "/config/mensagens");
  const doCliente = (cliente.body.mensagens || cliente.body).map(x => x.titulo);
  assert.ok(doCliente.includes("Pedir documentação"), "a imobiliária continua com os textos dela");
  console.log("   ok");
}

console.log(`\n${n} casos ok`);
fim(0);
