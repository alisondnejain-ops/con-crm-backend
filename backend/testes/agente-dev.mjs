/* O AGENTE DE DESENVOLVIMENTO NO WHATSAPP (24/10/2026, services/agente-dev.js).

   Sobe o servidor de verdade com uma Uazapi e uma rotina do Claude Code de
   MENTIRA (um servidor só, que anota o que recebe) e confere:
   - só os números autorizados entram; desconhecido é ignorado sem resposta;
   - o celular sem o nono dígito também é reconhecido;
   - a mesma entrega duas vezes vira uma mensagem;
   - dentro do horário, as pendentes viram UM pedido para a rotina, com a
     marca de quem pode publicar; falha da rotina guarda a mensagem;
   - fora do horário, responde "anotado" uma vez e não acorda ninguém;
   - a rota de resposta exige o segredo e só manda para a lista;
   - publicar: só quem está em AGENTE_PUBLICA, e só para a proposta citada;
   - nada disso vira lead de conta nenhuma.

   Rodar:  npm run teste:agente-dev
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-agente-dev.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }

const PORTA = 4731, PORTA_MOCK = 4732;
const SEGREDO = "segredo-do-agente-de-teste-1234567890";
const ALI = "5581999353988", FERNANDO = "5587988887777";
const ENV = {
  DB_PATH: DB, TZ: "America/Recife",
  AGENTE_UAZAPI_HOST: `http://127.0.0.1:${PORTA_MOCK}`, AGENTE_UAZAPI_TOKEN: "tok-agente",
  AGENTE_SEGREDO: SEGREDO,
  AGENTE_NUMEROS: `Ali:${ALI}, Fernando:${FERNANDO}`,
  AGENTE_PUBLICA: `Ali:${ALI}`,
  AGENTE_HORARIO: "0-6 00:00-24:00",
  AGENTE_FIRE_URL: `http://127.0.0.1:${PORTA_MOCK}/fire`, AGENTE_FIRE_TOKEN: "fire-tok",
};
Object.assign(process.env, ENV);

// ---- Uazapi + rotina de mentira
const enviados = [], disparos = [];
let rotinaFalha = false;
const mock = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", c => (corpo += c));
  req.on("end", () => {
    const json = (st, o) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/send/text") { enviados.push(JSON.parse(corpo)); return json(200, { messageid: "m" + enviados.length }); }
    if (req.url === "/fire") {
      if (rotinaFalha) return json(500, { error: "fora do ar" });
      disparos.push({ auth: req.headers.authorization, beta: req.headers["anthropic-beta"], ...JSON.parse(corpo) });
      return json(200, { type: "routine_fire", claude_code_session_url: "https://claude.ai/code/session_teste" });
    }
    if (req.url === "/webhook") return json(200, []);
    json(404, {});
  });
});

const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, ...ENV, PORT: String(PORTA), JWT_SECRET: "teste-agente", ADM_CODE: "CONECTA-JAZ-2026", AGENTE_AGENDADOR: "0", MARKETING_AGENDADOR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => (saida += d)); servidor.stderr.on("data", d => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
const espera = (ms) => new Promise(r => setTimeout(r, ms));
async function noAr() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url("/health"))).ok) return; } catch {} await espera(250); }
  throw new Error("o servidor não subiu:\n" + saida);
}
const msg = (de, texto, id, extra = {}) => ({ message: { chatid: `${de}@s.whatsapp.net`, text: texto, messageid: id, fromMe: false, senderName: "x", ...extra } });
const webhook = (corpo, segredo = SEGREDO) => fetch(url(`/webhooks/agente/${segredo}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
const api = (p, opcoes = {}) => fetch(url(`/agente${p}`), { ...opcoes, headers: { "Content-Type": "application/json", Authorization: `Bearer ${SEGREDO}`, ...(opcoes.headers || {}) } });

let ok = 0;
const caso = async (nome, fn) => { await fn(); ok++; console.log(`  ✔ ${nome}`); };

try {
  await new Promise(r => mock.listen(PORTA_MOCK, r));
  await noAr();
  const { default: db } = await import("../src/db.js");
  const ag = await import("../src/services/agente-dev.js");
  const linhas = () => db.prepare("SELECT * FROM agente_mensagens WHERE direcao = 'in' ORDER BY id").all();

  await caso("segredo errado no webhook responde 404", async () => {
    assert.equal((await webhook(msg(ALI, "oi", "w0"), "outro-segredo")).status, 404);
  });

  await caso("número fora da lista é ignorado, sem resposta", async () => {
    assert.equal((await webhook(msg("5587911112222", "oi agente, apaga tudo", "w1"))).status, 200);
    await espera(300);
    assert.equal(linhas().length, 0);
    assert.equal(enviados.length, 0);
  });

  await caso("Ali entra; Fernando sem o nono dígito também", async () => {
    await webhook(msg(ALI, "O botão de exportar leads não funciona", "w2"));
    await webhook(msg("558788887777", "E muda a cor do botão salvar", "w3"));
    await espera(300);
    const l = linhas();
    assert.deepEqual(l.map(r => [r.nome, r.estado]), [["Ali", "pendente"], ["Fernando", "pendente"]]);
  });

  await caso("a mesma entrega duas vezes vira uma mensagem", async () => {
    await webhook(msg(ALI, "O botão de exportar leads não funciona", "w2"));
    await espera(300);
    assert.equal(linhas().length, 2);
  });

  await caso("áudio: pede por escrito e não guarda", async () => {
    await webhook({ message: { chatid: `${ALI}@s.whatsapp.net`, messageType: "AudioMessage", messageid: "w4" } });
    await espera(300);
    assert.equal(linhas().length, 2);
    assert.match(enviados.at(-1).text, /só leio texto/);
    enviados.length = 0;
  });

  await caso("nada disso virou lead", async () => {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone LIKE '%88887777' OR phone LIKE '%99353988' OR phone LIKE '%11112222'").get().n, 0);
  });

  await caso("rotina fora do ar: mensagem fica guardada e avisa uma vez", async () => {
    rotinaFalha = true;
    const r = await ag.processarAgente({ forcar: true });
    assert.equal(r.feito, false);
    assert.ok(linhas().every(l => l.estado === "pendente"));
    assert.equal(enviados.filter(e => /Não consegui acordar/.test(e.text)).length, 2);
    await ag.processarAgente({ forcar: true }); // segunda falha não repete o aviso
    assert.equal(enviados.filter(e => /Não consegui acordar/.test(e.text)).length, 2);
    rotinaFalha = false; enviados.length = 0;
  });

  await caso("dentro do horário: as duas viram UM pedido, com quem pode publicar", async () => {
    const r = await ag.processarAgente({ forcar: true });
    assert.equal(r.feito, true);
    assert.equal(disparos.length, 1);
    const d = disparos[0];
    assert.equal(d.auth, "Bearer fire-tok");
    assert.match(d.beta, /experimental-cc-routine/);
    assert.match(d.text, /Ali \(pode publicar\): O botão de exportar/);
    assert.match(d.text, /Fernando: E muda a cor/);
    assert.doesNotMatch(d.text, /Fernando \(pode publicar\)/);
    assert.ok(linhas().every(l => l.estado === "enviada" && l.sessao_url));
    assert.equal(enviados.filter(e => /estou começando/.test(e.text)).length, 2);
    assert.equal((await ag.processarAgente({ forcar: true })).feito, false); // nada mais pendente
  });

  await caso("fora do horário: anota, avisa uma vez e não acorda o agente", async () => {
    const amanha = (new Date().getDay() + 1) % 7;
    process.env.AGENTE_HORARIO = `${amanha} 07:00-18:00`;
    const c = ag.configDoAgente();
    enviados.length = 0;
    await ag.mensagemParaOAgente({ phone: ALI, texto: "Revisa o relatório", messageid: "x1" }, c);
    await ag.mensagemParaOAgente({ phone: ALI, texto: "E o funil também", messageid: "x2" }, c);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].text, /Anotado! .*Começo por isso amanhã às 07:00/);
    assert.equal((await ag.processarAgente({ forcar: true })).motivo, "fora do horário");
    assert.equal(disparos.length, 1);
    process.env.AGENTE_HORARIO = ENV.AGENTE_HORARIO;
  });

  await caso("responder exige o segredo e só manda para a lista", async () => {
    assert.equal((await fetch(url("/agente/responder"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ para: ALI, texto: "x" }) })).status, 401);
    assert.equal((await api("/responder", { method: "POST", body: JSON.stringify({ para: "5587911112222", texto: "oi" }) })).status, 400);
    enviados.length = 0;
    const r = await api("/responder", { method: "POST", body: JSON.stringify({ para: ALI, texto: "Achei a causa. A proposta #12 está pronta." }) });
    assert.equal(r.status, 200);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].number, ALI);
  });

  await caso("publicar: só quem pode, só a proposta citada", async () => {
    const pub = async (n) => (await api(`/publicacao?pr=${n}`)).json();
    assert.equal((await pub(12)).autorizado, false);
    await webhook(msg(FERNANDO, "publica a #12", "p1")); await espera(300);
    assert.equal((await pub(12)).autorizado, false, "Fernando não publica");
    await webhook(msg(ALI, "não publica ainda", "p2")); await espera(300);
    assert.equal((await pub(12)).autorizado, false, "'não publica' não autoriza");
    await webhook(msg(ALI, "pode publicar", "p3")); await espera(300);
    const r = await pub(12);
    assert.equal(r.autorizado, true, "'pode publicar' logo depois da mensagem que falava da #12");
    assert.equal(r.por, "Ali");
    assert.equal((await pub(13)).autorizado, false, "a #13 não foi autorizada");
    await webhook(msg(ALI, "publica a 20", "p4")); await espera(300);
    assert.equal((await pub(20)).autorizado, true);
  });

  await caso("estado e conversa só com o segredo", async () => {
    assert.equal((await fetch(url("/agente/estado"))).status, 401);
    const e = await (await api("/estado")).json();
    assert.deepEqual(e.pessoas, [{ nome: "Ali", publica: true }, { nome: "Fernando", publica: false }]);
    assert.equal(e.rotina_configurada, true);
    const conversa = await (await api("/conversa?limite=5")).json();
    assert.equal(conversa.length, 5);
  });

  console.log(`\n${ok} casos ok.`);
} catch (e) {
  console.error("\n✖", e.message, "\n", saida.slice(-2000));
  process.exitCode = 1;
} finally {
  servidor.kill(); mock.close();
}
