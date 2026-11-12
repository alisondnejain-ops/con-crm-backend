/* A IA ABRE A CONVERSA COM O LEAD DO FORMULÁRIO (12/11/2026, services/robo.js
   → abrirConversaDoFormulario, opção `abre_formulario` em Configurações →
   Autoatendimento).

   1. Desligada (padrão): o lead do formulário chega e ninguém escreve.
   2. Ligar pela tela passa o formulário do site de "corretor da vez" para a
      regra de sempre, e avisa.
   3. Ligada: lead novo do formulário recebe a primeira mensagem da IA, que viu
      o aviso de primeira mensagem e as respostas do formulário; sai pelo
      WhatsApp e entra na conversa como atendimento automático.
   4. Vale também dentro do expediente.
   5. Lead que já está com um corretor: a IA não escreve.
   6. Lead que já tem conversa: a IA não abre de novo.

   Rodar:  npm run teste:robo-abre-formulario */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-robo-abre.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4861";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
process.env.ANTHROPIC_BASE_URL = "http://localhost:4862";
process.env.ROBO_ATRASO_MIN = "50";
process.env.ROBO_ATRASO_MAX = "80";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

let perguntas = [], enviados = [];
const mock = http.createServer((req, res) => {
  const pedacos = [];
  req.on("data", c => pedacos.push(c));
  req.on("end", () => {
    const corpo = Buffer.concat(pedacos).toString("utf8");
    if (req.url === "/v1/messages") {
      perguntas.push(JSON.parse(corpo));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
        texto: "Oi, Carla! Recebi seu cadastro no nosso site e por isso estou escrevendo. Você procura o lote para morar ou investir?",
        encerrar: false, coletado: {} }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    if (req.url.startsWith("/send/")) {
      enviados.push(JSON.parse(corpo || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ messageid: "wa_" + Math.random().toString(36).slice(2) }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => mock.listen(4862, r));

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const BASE = "http://localhost:4861";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const org = "org_abre";
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,robo_ativo,robo_aprender,robo_sempre,uazapi_host,uazapi_token) VALUES (?,?,?,?,1,0,1,?,?)")
  .run(org, "Imobiliária Sol", "SOL-1", Date.now(), "http://localhost:4862", "token-sol");
db.prepare(`INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at) VALUES (?,?,'imobiliaria','http://localhost:4862','token-sol',1,?)`).run("c_sol", org, Date.now());
let n = 0;
const pessoa = (nome, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
    .run(id, org, nome, nome.toLowerCase() + "@sol.com", senha, role, Date.now() + (++n));
  return id; };
pessoa("Gestora", "adm"); const marina = pessoa("Marina", "corretor");

const tG = (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "gestora@sol.com", password: "123456" }) })).json()).token;
const chamar = async (c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + tG, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const token = (await chamar("/config/formulario-site/token", "POST")).d.token;
assert.ok(token, "token do formulário");
const formulario = async (nome, telefone) => {
  const r = await fetch(BASE + "/publico/leads", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ nome, telefone, consentimento_lgpd: true, objetivo: "Morar", observacao: "Quero saber dos lotes perto do rio" }) });
  assert.equal(r.status, 201, "formulário aceito"); return (await r.json()).lead_id;
};
const saidas = (leadId) => db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out'").all(leadId);
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const esperarAte = async (fn, ms = 4000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await esperar(60); } return fn(); };

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 3).join("\n    ")); } }

await caso("1. Desligada: o lead do formulário chega e ninguém escreve", async () => {
  const id = await formulario("Pedro Antigo", "5587991230001");
  await esperar(600);
  assert.equal(saidas(id).length, 0); assert.equal(perguntas.length, 0);
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(id).assigned_to, marina, "foi ao corretor da vez");
});

await caso("2. Ligar passa o formulário do site para a regra de sempre e avisa", async () => {
  const r = await chamar("/config/robo/acoes", "POST", { abre_formulario: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.abre_formulario, true); assert.equal(r.d.formulario_site_mudou, true);
  assert.equal(db.prepare("SELECT quem_recebe FROM entrada_site WHERE org_id = ?").get(org).quem_recebe, "regra");
  // Salvar de novo outra coisa não desliga.
  const r2 = await chamar("/config/robo/acoes", "POST", { observacao: true });
  assert.equal(r2.d.abre_formulario, true); assert.equal(r2.d.formulario_site_mudou, false);
});

let carla;
await caso("3. Ligada: a IA manda a primeira mensagem, sabendo do formulário", async () => {
  carla = await formulario("Carla Souza", "5587991230002");
  const out = await esperarAte(() => saidas(carla).length ? saidas(carla) : null);
  assert.ok(out && out.length >= 1, "saiu mensagem");
  assert.equal(out[0].from_user_id, null); assert.equal(out[0].from_name, "Atendimento automático");
  assert.ok(enviados.some(e => String(e.number || "").includes("5587991230002")), "foi pelo WhatsApp");
  const texto = JSON.stringify(perguntas.at(-1));
  assert.ok(texto.includes("PRIMEIRA MENSAGEM DA CONVERSA"), "aviso de primeira mensagem");
  assert.ok(texto.includes("lotes perto do rio"), "as respostas do formulário foram junto");
  assert.equal(db.prepare("SELECT assigned_to FROM leads WHERE id = ?").get(carla).assigned_to, null, "na fila, sem dono");
  assert.equal(db.prepare("SELECT first_resp_at FROM leads WHERE id = ?").get(carla).first_resp_at, null, "não carimba a 1ª resposta");
});

await caso("4. Vale dentro do expediente", async () => {
  const h = new Date(); const ini = `${String((h.getHours() + 22) % 24).padStart(2, "0")}:00`, fim = `${String((h.getHours() + 23) % 24).padStart(2, "0")}:00`;
  db.prepare("UPDATE orgs SET robo_sempre = 0, robo_inicio = ?, robo_fim = ?, robo_dias = '[0,1,2,3,4,5,6]' WHERE id = ?").run(ini, fim, org);
  const id = await formulario("Davi Lima", "5587991230003");
  assert.ok(await esperarAte(() => saidas(id).length), "abriu dentro do expediente");
});

await caso("5. Lead que já está com um corretor: a IA não escreve", async () => {
  const id = "l_" + randomUUID();
  db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at,assigned_to,assigned_at,source) VALUES (?,?,?,?,?,?,?,?,'whatsapp')")
    .run(id, org, "Eva Prado", "5587991230004", "Lead", Date.now(), marina, Date.now());
  const antes = perguntas.length;
  await formulario("Eva Prado", "5587991230004");
  await esperar(600);
  assert.equal(saidas(id).length, 0); assert.equal(perguntas.length, antes);
});

await caso("6. Lead que já tem conversa: a IA não abre de novo", async () => {
  const antes = saidas(carla).length, p = perguntas.length;
  await formulario("Carla Souza", "5587991230002");
  await esperar(600);
  assert.equal(saidas(carla).length, antes); assert.equal(perguntas.length, p);
});

mock.close();
console.log(falhas ? `\n${falhas} caso(s) falharam.` : "\nTudo certo ✅");
process.exit(falhas ? 1 : 0);
