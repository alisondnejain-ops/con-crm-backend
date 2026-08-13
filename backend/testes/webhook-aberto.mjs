/* OS WEBHOOKS NÃO PODEM EXIGIR LOGIN.

   Este teste existe por causa de um estrago real: uma rota nova foi montada
   como `app.use(cobrando, tarefasRoutes)` — sem caminho. Sem caminho, o
   middleware de login passa a valer para TODA rota registrada depois dele, e as
   que vinham depois eram os webhooks da Meta e da Uazapi.

   Resultado: todo lead que chegava pelo WhatsApp levava 401 e ia para o lixo. O
   CRM continuava de pé, a tela abria, ninguém via erro nenhum — só parou de
   entrar lead. O tipo de falha que só aparece quando alguém repara na ausência.

   Nenhum teste de unidade pega isso: cada rota, isolada, funciona. O que
   quebra é a ORDEM DE MONTAGEM. Então aqui o servidor sobe inteiro, do jeito
   que sobe em produção, e a conferência é feita de fora, por HTTP.

   Rodar:  npm run teste:webhook
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-webhook.db");
try { fs.unlinkSync(DB); } catch (e) {}
// O MESMO banco do servidor filho — sem isto o teste lê e escreve no banco de
// desenvolvimento e conclui que o webhook não gravou nada.
process.env.DB_PATH = DB;

const PORTA = 4711;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => { saida += d; });
servidor.stderr.on("data", (d) => { saida += d; });

const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
const esperarNoAr = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url("/health")); if (r.ok) return true; } catch (e) {}
    await new Promise(x => setTimeout(x, 250));
  }
  throw new Error("o servidor não subiu:\n" + saida);
};

try {
  await esperarNoAr();
  console.log("Servidor no ar, igual à produção.");

  // A imobiliária precisa ter o token da Uazapi para o webhook saber de quem é.
  const { default: db } = await import("../src/db.js");
  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get();
  db.prepare("UPDATE orgs SET uazapi_host=?, uazapi_token=? WHERE id=?")
    .run("https://uazapi.exemplo", "tok-teste", org.id);

  console.log("\n1. O webhook da Uazapi responde SEM login — e cria o lead");
  const r1 = await fetch(url("/webhooks/uazapi"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "tok-teste", event: "messages", message: {
      messageid: "wa_1", fromMe: false, sender: "5587991234567@s.whatsapp.net",
      senderName: "Cliente Novo", text: "Oi, vi o anúncio", messageType: "Conversation" } }),
  });
  console.log("   POST /webhooks/uazapi →", r1.status);
  assert.equal(r1.status, 200, "webhook atrás de login = lead perdido");
  await new Promise(x => setTimeout(x, 400));

  console.log("2. O lead chegou ao banco");
  const lead = db.prepare("SELECT name, phone FROM leads WHERE phone = ?").get("5587991234567");
  console.log("   ", lead ? `${lead.name} (${lead.phone})` : "NENHUM");
  if (!lead) console.log("o webhook registrou:", JSON.stringify((await (await fetch(url("/integracoes/webhooks"))).json()).eventos));
  assert.ok(lead, "o webhook respondeu 200 mas não gravou o lead");

  console.log("3. O webhook da Meta também responde sem login");
  const r2 = await fetch(url("/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc"));
  console.log("   GET /webhooks/meta →", r2.status);
  assert.notEqual(r2.status, 401, "a Meta não faz login: 401 aqui é integração morta");

  console.log("4. O painel de instalação continua aberto");
  for (const p of ["/integracoes", "/integracoes/webhooks", "/versao.txt", "/health"]) {
    const r = await fetch(url(p));
    console.log(`   GET ${p} → ${r.status}`);
    assert.equal(r.status, 200, `${p} precisa abrir sem login`);
  }

  console.log("5. E o que É protegido continua protegido");
  for (const p of ["/leads", "/reports", "/config/mensagens", "/tarefas/qualquer", "/distribution/atendentes"]) {
    const r = await fetch(url(p));
    console.log(`   GET ${p} → ${r.status}`);
    assert.equal(r.status, 401, `${p} não pode estar aberto`);
  }

  console.log("\nTudo certo ✅");
} finally {
  servidor.kill("SIGKILL");
}
