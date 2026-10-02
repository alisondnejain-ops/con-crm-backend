/* IMPORTAR LEADS POR PLANILHA (02/10/2026). A rota `POST /leads/import`
   consultava `pipeline_stages.active` — coluna que nunca existiu (é
   `is_active`) — e derrubava TODA importação com erro 500 desde 01/09/2026.
   Nenhum teste chamava a rota. Este sobe o servidor e importa de verdade,
   e confere a prévia que o popup mostra antes do botão.

   Rodar:  npm run teste:importar-leads */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-importar-leads.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;

const PORTA = 4793;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "CONECTA-JAZ-2026", APP_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", (d) => (saida += d));
servidor.stderr.on("data", (d) => (saida += d));
const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url("/health"))).ok) break; } catch (e) {}
    await new Promise((x) => setTimeout(x, 250));
  }
  const { default: db } = await import("../src/db.js");
  const { randomUUID } = await import("crypto");
  const P = await import("../src/services/pipelines.js");
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
  P.garantirPipelinePadrao ? P.garantirPipelinePadrao(org) : null;
  if (!db.prepare("SELECT 1 FROM pipelines WHERE org_id = ?").get(org)) P.criarDoTemplate(org, "comercial", { is_default: true });
  const usuario = (email, role, nome) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status) VALUES (?,?,?,?,?,?,1,?,'ativo')`)
      .run(id, org, nome || email.split("@")[0], email, senha, role, Date.now());
    return id;
  };
  usuario("gestor@imp.com", "adm");
  const vero = usuario("vero@imp.com", "corretor", "Veronica Gomez");
  db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at,qual_json) VALUES (?,?,?,?,?,?,'{}')")
    .run("l_existe", org, "Já existe", "5587991110001", "Lead", Date.now());
  const login = async (email) => (await (await fetch(url("/auth/login"), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "123456" }) })).json()).token;
  const tGestor = await login("gestor@imp.com");
  const tVero = await login("vero@imp.com");
  const importar = async (t, corpo) => {
    const r = await fetch(url("/leads/import"), { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify(corpo) });
    return { status: r.status, body: await r.json() };
  };
  const linhas = [
    { nome: "Ana", telefone: "(87) 99222-0001", corretor: "Veronica Gomez" },
    { nome: "Bia", telefone: "(87) 99222-0002", corretor: "Veronica Gomez", temperatura: "quente" },
    { nome: "Excel", telefone: "5,58799E+12", corretor: "Veronica Gomez" },
    { nome: "Sem DDD", telefone: "99222-0003" },
    { nome: "Já existe", telefone: "(87) 99111-0001" },
    { nome: "Repetida", telefone: "(87) 99222-0001" },
  ];
  const antes = db.prepare("SELECT COUNT(*) n FROM leads").get().n;

  caso("A prévia confere linha a linha e NÃO grava nada");
  let r = await importar(tGestor, { linhas, previa: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.criados, 2);
  assert.equal(r.body.ignorados, 4);
  assert.deepEqual(r.body.motivos, { "sem telefone válido": 2, "telefone já cadastrado": 1, "telefone repetido na planilha": 1 });
  assert.ok(r.body.exemplos.some((x) => x.telefone === "5,58799E+12"), "o exemplo mostra o valor que veio, para a pessoa entender o motivo");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads").get().n, antes, "prévia não pode gravar");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM importacoes").get().n, 0);
  console.log("   2 entram, 4 de fora, nada gravado");

  caso("A importação de verdade grava os mesmos 2 — sem erro 500 (a coluna é is_active)");
  r = await importar(tGestor, { linhas, corretores: { "Veronica Gomez": vero }, rotulo: "Leads Veronica", arquivo: "Leads Veronica.csv" });
  assert.equal(r.status, 200, JSON.stringify(r.body) + "\n" + saida.split("\n").slice(-5).join("\n"));
  assert.equal(r.body.criados, 2);
  const novos = db.prepare("SELECT * FROM leads WHERE import_id = ?").all(r.body.import_id);
  assert.equal(novos.length, 2);
  console.log("   2 leads gravados");

  caso("Entram com a dona escolhida, dentro do funil, e sem temperatura inventada");
  for (const l of novos) {
    assert.equal(l.assigned_to, vero);
    assert.ok(l.pipeline_id && l.stage_id, "lead importado precisa nascer dentro de um funil");
  }
  assert.equal(novos.find((l) => l.name === "Ana").priority, null, "sem coluna de temperatura, sem temperatura");
  assert.equal(novos.find((l) => l.name === "Bia").priority, "QUENTE");
  console.log("   dona Veronica, no funil, Ana sem temperatura e Bia quente");

  caso("A dona vê os leads na caixa dela");
  const caixa = await (await fetch(url("/leads"), { headers: { Authorization: `Bearer ${tVero}` } })).json();
  assert.equal(caixa.filter((l) => ["Ana", "Bia"].includes(l.name)).length, 2);
  console.log("   aparecem para a Veronica");

  caso("Importar de novo a mesma planilha não duplica nada, e não cria lista vazia");
  const listas = db.prepare("SELECT COUNT(*) n FROM importacoes").get().n;
  r = await importar(tGestor, { linhas, corretores: { "Veronica Gomez": vero } });
  assert.equal(r.body.criados, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM importacoes").get().n, listas);
  console.log("   0 novos, nenhuma lista vazia");

  caso("Corretor não importa");
  r = await importar(tVero, { linhas, previa: true });
  assert.equal(r.status, 403);
  console.log("   403");

  console.log(`\nTodos os ${n} casos passaram.`);
} catch (e) {
  console.error("\nFALHOU:", e.message);
  console.error(saida.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
}
