/* GATILHO "MENSAGEM DO CLIENTE" (30/10/2026, lista do Fernando): palavra,
   frase inicial ou código de imóvel, chegando pelo webhook do WhatsApp.

   1. Palavra inteira, sem acento/maiúscula: "Qual o VALOR?" liga; "valorizou" não.
   2. "Começa com": só no começo da mensagem.
   3. Código de imóvel do catálogo liga; código que não é desta conta não.
   4. Gente da equipe escreveu nas últimas 12h: não liga.
   5. Já está em outro fluxo: não liga.
   6. Duas palavras iguais em dois gatilhos do mesmo fluxo: sobreposição.

   Rodar:  npm run teste:gatilho-palavra */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-gatilho-palavra.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4825";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const mock = http.createServer((req, res) => { let c = ""; req.on("data", d => c += d); req.on("end", () => {
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ messageid: "wa_" + Math.random(), instance: { status: "connected" }, status: { connected: true } })); }); });
await new Promise(r => mock.listen(4826, r));
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
await import("../src/server.js");
const P = await import("../src/services/pipelines.js");
const { sobreposicoes, gatilhoLimpo } = await import("../src/services/automacoes.js");
const BASE = "http://localhost:4825";
await new Promise(r => setTimeout(r, 700));
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,uazapi_host,uazapi_token) VALUES (?,?,?,?,?,?)").run(org, "Casa", "GP-1", Date.now(), "http://127.0.0.1:4826", "tok-gp");
P.garantirPipelinePadrao(org);
db.prepare("INSERT INTO canais (id,org_id,tipo,host,token,ativo,created_at,triagem) VALUES (?,?,'imobiliaria',?,'tok-gp',1,?,0)").run("c_" + randomUUID(), org, "http://127.0.0.1:4826", Date.now());
db.prepare("INSERT OR REPLACE INTO org_recursos (org_id, recurso, master) VALUES (?, 'marketing', 'liberado')").run(org);
const marina = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,'x','sdr',1,?,'ativo')`).run(marina, org, "Marina", "m@gp.com", Date.now());
const produto = "p_a1b2c3d4-0000-0000-0000-000000000000";
db.prepare("INSERT INTO produtos (id,org_id,tipo,titulo,status,created_at) VALUES (?,?,?,?,?,?)").run(produto, org, "casa", "Casa", "ativo", Date.now());

// Um fluxo ligado por gatilho, criado direto (a tela/rota de ligar já tem teste próprio).
function fluxoLigado(nome, gatilho) {
  const grafo = { nos: [{ id: "inicio", tipo: "inicio", x: 0, y: 0, dados: { gatilho } }, { id: "m", tipo: "mensagem", x: 1, y: 0, dados: { texto: "Oi!" } }],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "m" }] };
  const f = "f_" + randomUUID(), c = "mc_" + randomUUID(), agora = Date.now();
  db.prepare(`INSERT INTO marketing_campanhas (id,org_id,nome,fluxo_id,fluxo_nome,grafo,publico,status,total,criado_em,iniciada_em,tipo)
    VALUES (?,?,?,?,?,?,'{}','rodando',0,?,?,'automacao')`).run(c, org, nome, f, nome, JSON.stringify(grafo), agora, agora);
  db.prepare(`INSERT INTO marketing_fluxos (id,org_id,nome,grafo,criado_por,criado_em,atualizado_em,ativo,gatilho_tipo,automacao_id)
    VALUES (?,?,?,?,'x',?,?,1,'palavra',?)`).run(f, org, nome, JSON.stringify(grafo), agora, agora, c);
  return c;
}
const cValor = fluxoLigado("Valor", { tipo: "palavra", modo: "contem", palavras: ["valor"] });
const cAlugar = fluxoLigado("Alugar", { tipo: "palavra", modo: "comeca", palavras: ["quero alugar"] });
const cCodigo = fluxoLigado("Código", { tipo: "palavra", modo: "codigo" });
const entraram = (c) => db.prepare("SELECT COUNT(*) n FROM marketing_execucoes WHERE campanha_id = ?").get(c).n;
let tel = 0;
const manda = async (texto, fone) => { fone = fone || "55879930" + String(++tel).padStart(5, "0");
  await fetch(BASE + "/webhooks/uazapi", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "tok-gp", event: "messages", message: { chatid: `${fone}@s.whatsapp.net`, text: texto, senderName: "Cliente", messageid: "wa_" + Math.random().toString(36).slice(2) } }) });
  await new Promise(r => setTimeout(r, 300)); return fone; };

let falhas = 0;
async function caso(nome, fn) { try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas++; console.log("  ✗ " + nome + "\n    " + (e.stack || e.message).split("\n").slice(0, 2).join("\n    ")); } }
console.log("Gatilho: mensagem do cliente");
await caso("1. Palavra inteira, sem acento nem maiúscula", async () => {
  await manda("Oi, qual o VALOR desse apê?");
  assert.equal(entraram(cValor), 1);
  await manda("o bairro valorizou muito");
  assert.equal(entraram(cValor), 1, "valorizou não é valor");
});
await caso("2. Começa com", async () => {
  await manda("Quero alugar uma casa");
  assert.equal(entraram(cAlugar), 1);
  await manda("Oi! quero alugar");
  assert.equal(entraram(cAlugar), 1, "não começa com");
});
await caso("3. Código de imóvel desta conta", async () => {
  await manda("Tenho interesse no imóvel (cód. A1B2C3) que vi no site");
  assert.equal(entraram(cCodigo), 1);
  await manda("e o FFFFFF?");
  assert.equal(entraram(cCodigo), 1, "código de imóvel que não existe aqui");
});
await caso("4. Gente escreveu nas últimas 12h: não liga", async () => {
  const fone = await manda("bom dia");
  const lead = db.prepare("SELECT id FROM leads WHERE phone LIKE ?").get("%" + fone.slice(-8));
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,from_user_id,created_at) VALUES (?,?,?,?,?,?)").run("m_" + randomUUID(), lead.id, "out", "Oi!", marina, Date.now());
  const antes = entraram(cValor);
  await manda("e o valor?", fone);
  assert.equal(entraram(cValor), antes);
});
await caso("5. Já em outro fluxo: não liga", async () => {
  const fone = await manda("quero alugar já");          // entra no Alugar
  const antes = entraram(cValor);
  await manda("qual o valor?", fone);
  assert.equal(entraram(cValor), antes);
});
await caso("6. Mesma palavra em dois gatilhos: sobreposição", async () => {
  const s = sobreposicoes([gatilhoLimpo({ tipo: "palavra", palavras: ["Preço"] }), gatilhoLimpo({ tipo: "palavra", modo: "comeca", palavras: ["preco"] })]);
  assert.equal(s.length, 1); assert.match(s[0], /Preço/);
});
console.log(falhas ? `\n${falhas} falha(s).` : "\nTudo certo.");
mock.close(); process.exit(falhas ? 1 : 0);
