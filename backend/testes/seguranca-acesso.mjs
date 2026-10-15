/* SEGURANÇA DE ACESSO (14/10/2026, depois da análise de vulnerabilidades).

   Servidor de pé. O que se prova:
   1. o cadastro pelo site NÃO toma o convite pendente de um sócio (era o
      caminho para virar master), nem o convite de corretor de outra casa —
      e o recomeço de quem só fechou a aba continua funcionando;
   2. o freio "por computador" usa o endereço que o proxy viu, não o que o
      visitante escreveu no x-forwarded-for;
   3. 4 senhas erradas travam a conta, e só a nova senha destrava;
   4. o master só entra numa conta com o código de 60s que a gestão vê; a
      entrada fica registrada, vence e pode ser encerrada pela gestão.

   Rodar:  npm run teste:seguranca-acesso
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-seguranca-acesso.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste-acesso";
const PORTA = 4872;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste-acesso", ADM_CODE: "ACE-1",
    ADM_EMAIL: "ali@teste.com", ADM_PASSWORD: "123456", APP_URL: "", RESEND_API_KEY: "",
    UAZAPI_AUTOCONFIGURAR: "0", MARKETING_AGENDADOR: "0", FOTOS_AGENDADOR: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let saida = "";
servidor.stdout.on("data", d => (saida += d));
servidor.stderr.on("data", d => (saida += d));
const url = p => `http://127.0.0.1:${PORTA}${p}`;
let n = 0;
const caso = (t) => console.log(`\n${++n}. ${t}`);
const req = async (metodo, p, corpo, token, extra = {}) => {
  const r = await fetch(url(p), { method: metodo, headers: { "content-type": "application/json",
    ...(token ? { authorization: "Bearer " + token } : {}), ...extra }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};
const login = async (email, senha = "123456") => (await req("POST", "/auth/login", { email, password: senha })).b.token;
let ip = 0;
const deFora = () => ({ "x-forwarded-for": `10.0.${Math.floor(++ip / 200)}.${ip % 200}` });

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url("/health"))).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  const { default: db } = await import("../src/db.js");
  const bcrypt = (await import("bcryptjs")).default;
  const { randomUUID } = await import("crypto");
  const { codigoAtual, codigoConfere, JANELA_MS, FOLGA_MS } = await import("../src/services/acesso-master.js");
  const senha = bcrypt.hashSync("123456", 8);

  const orgA = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get().id;
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Casa B", "ACE-B", Date.now() + 1);
  const pessoa = (o, email, role, extra = {}) => {
    const id = "u_" + randomUUID();
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,invite_tipo)
      VALUES (?,?,?,?,?,?,1,?,?,?)`).run(id, o, email.split("@")[0], email, extra.status === "pendente" ? "" : senha, role,
      Date.now(), extra.status || "ativo", extra.tipo || null);
    return id;
  };
  const gestoraB = pessoa(orgB, "gestorab@teste.com", "adm");
  pessoa(orgB, "convidado@teste.com", "corretor", { status: "pendente", tipo: "convite" });
  const tAli = await login("ali@teste.com");
  assert.ok(tAli, "o master entra");

  caso("O cadastro pelo site NÃO toma o convite de sócio pendente");
  let r = await req("POST", "/orgs/masters", { nome: "Sócio Novo", email: "socio@teste.com" }, tAli);
  assert.equal(r.s, 200);
  r = await req("POST", "/publico/comecar", { nome: "Invasor", email: "socio@teste.com", telefone: "87991112222" }, null, deFora());
  assert.equal(r.s, 409, "recusado"); assert.ok(!r.b.link, "sem link de senha na resposta");
  r = await req("POST", "/auth/criar-imobiliaria", { imobiliaria: "Casa X", name: "Invasor", email: "socio@teste.com", phone: "87991112222" }, null, deFora());
  assert.equal(r.s, 409, "nem pela porta antiga de imobiliária");
  r = await req("POST", "/auth/register", { name: "Invasor", email: "socio@teste.com", phone: "87991112222", role: "corretor", adm_code: "ACE-B" }, null, deFora());
  assert.equal(r.s, 409, "nem pelo link de cadastro de outra imobiliária");
  const socio = db.prepare("SELECT master, status, org_id FROM users WHERE email = 'socio@teste.com'").get();
  assert.equal(socio.master, 1); assert.equal(socio.status, "pendente"); assert.equal(socio.org_id, orgA);

  caso("Nem o convite pendente de um corretor de outra imobiliária");
  r = await req("POST", "/publico/comecar", { nome: "Invasor", email: "convidado@teste.com", telefone: "87991112222" }, null, deFora());
  assert.equal(r.s, 409);
  assert.equal(db.prepare("SELECT org_id FROM users WHERE email = 'convidado@teste.com'").get().org_id, orgB);

  caso("Quem só fechou a aba e cadastrou de novo continua conseguindo");
  r = await req("POST", "/publico/comecar", { nome: "Marina", email: "marina@teste.com", telefone: "87991112222" }, null, deFora());
  assert.equal(r.s, 201);
  r = await req("POST", "/publico/comecar", { nome: "Marina", email: "marina@teste.com", telefone: "87991112222" }, null, deFora());
  assert.equal(r.s, 201, "o cadastro pela metade é reaproveitado");

  caso("O freio por computador usa o endereço que o proxy viu");
  // Simula o Railway: o visitante escreve o que quiser, o proxy acrescenta o
  // endereço real no fim. Mudar só a primeira parte não pode furar o teto (5/h).
  const res = [];
  for (let i = 0; i < 7; i++)
    res.push((await req("POST", "/publico/comecar", { nome: "Spam", email: `spam${i}@x.com`, telefone: "87991112222" }, null,
      { "x-forwarded-for": `1.2.3.${i}, 200.200.200.200` })).s);
  assert.deepEqual(res.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.equal(res[5], 429, "o sexto do mesmo computador é recusado");

  caso("3 senhas erradas avisam quantas faltam; a 4ª trava a conta");
  pessoa(orgB, "corretor@teste.com", "corretor");
  const tentar = (s) => req("POST", "/auth/login", { email: "corretor@teste.com", password: s }, null, deFora());
  r = await tentar("errada1"); assert.equal(r.s, 401); assert.match(r.b.error, /Mais 3 tentativas/);
  r = await tentar("errada2"); assert.match(r.b.error, /Mais 2/);
  r = await tentar("errada3"); assert.match(r.b.error, /Mais 1 tentativa/);
  r = await tentar("errada4"); assert.equal(r.s, 423); assert.match(r.b.error, /Esqueci minha senha/);
  r = await tentar("123456"); assert.equal(r.s, 423, "travada, nem a senha certa entra");

  caso("Acertar antes da 4ª zera a contagem");
  pessoa(orgB, "atenta@teste.com", "corretor");
  for (const s of ["e1", "e2", "e3"]) await req("POST", "/auth/login", { email: "atenta@teste.com", password: s }, null, deFora());
  r = await req("POST", "/auth/login", { email: "atenta@teste.com", password: "123456" }, null, deFora());
  assert.equal(r.s, 200);
  r = await req("POST", "/auth/login", { email: "atenta@teste.com", password: "e1" }, null, deFora());
  assert.match(r.b.error, /Mais 3 tentativas/);

  caso("A nova senha pelo link destrava");
  const tGestoraB = await login("gestorab@teste.com");
  const alvo = db.prepare("SELECT id FROM users WHERE email = 'corretor@teste.com'").get().id;
  r = await req("POST", `/auth/users/${alvo}/redefinir-senha`, {}, tGestoraB);
  const token = new URL(r.b.link, "http://x").searchParams.get("token");
  r = await req("POST", "/auth/set-password", { token, password: "novasenha" });
  assert.equal(r.s, 200);
  r = await req("POST", "/auth/login", { email: "corretor@teste.com", password: "novasenha" }, null, deFora());
  assert.equal(r.s, 200, "destravada");

  caso("O master não entra na conta sem o código; com o código errado, também não");
  r = await req("POST", `/orgs/${orgB}/entrar`, {}, tAli);
  assert.equal(r.s, 428); assert.ok(r.b.precisa_codigo);
  r = await req("POST", `/orgs/${orgB}/entrar`, { codigo: "000000" === codigoAtual(orgB).codigo ? "111111" : "000000" }, tAli);
  assert.equal(r.s, 403);

  caso("A gestão vê o código; o master não");
  r = await req("GET", "/auth/conta/acesso", null, tGestoraB);
  assert.equal(r.s, 200); assert.match(r.b.codigo, /^\d{6}$/); assert.ok(r.b.muda_em > Date.now());
  const codigo = r.b.codigo;
  assert.equal((await req("GET", "/auth/conta/acesso", null, tAli)).s, 403);
  const tCorretorB = await login("atenta@teste.com");
  assert.equal((await req("GET", "/auth/conta/acesso", null, tCorretorB)).s, 403, "o corretor também não");

  caso("Com o código do momento, o master entra — e a gestão vê a entrada");
  r = await req("POST", `/orgs/${orgB}/entrar`, { codigo }, tAli);
  assert.equal(r.s, 200);
  const tNaB = r.b.token;
  assert.equal((await req("GET", "/leads", null, tNaB)).s, 200);
  assert.equal((await req("GET", "/auth/conta/acesso", null, tNaB)).s, 403, "nem de dentro ele lê o código");
  r = await req("GET", "/auth/conta/acesso", null, tGestoraB);
  assert.equal(r.b.acessos.length, 1); assert.equal(r.b.acessos[0].aberto, true);

  caso("A gestão encerra a entrada: o crachá do master para de abrir a conta e volta ao hub");
  r = await req("POST", "/auth/conta/acesso/encerrar", {}, tGestoraB);
  assert.equal(r.b.encerrados, 1);
  r = await req("GET", "/leads", null, tNaB);
  assert.equal(r.s, 403); assert.equal(r.b.codigo, "acesso_vencido");
  assert.equal((await req("GET", "/orgs", null, tNaB)).s, 200, "o hub continua abrindo");
  r = await req("GET", "/auth/me", null, tNaB);
  assert.equal(r.s, 200); assert.equal(r.b.org, null);

  caso("A entrada vence sozinha no prazo");
  r = await req("POST", `/orgs/${orgB}/entrar`, { codigo: codigoAtual(orgB).codigo }, tAli);
  const tDeNovo = r.b.token;
  assert.equal((await req("GET", "/leads", null, tDeNovo)).s, 200);
  db.prepare("UPDATE acessos_master SET ate = ? WHERE org_id = ? AND encerrado_em IS NULL").run(Date.now() - 1000, orgB);
  assert.equal((await req("GET", "/leads", null, tDeNovo)).s, 403);

  caso("Crachá forjado com o org de outra conta, sem entrada, não abre nada");
  // O crachá do hub de antes aponta para a conta B mas sem `ac`.
  const jwt = (await import("jsonwebtoken")).default;
  const eu = db.prepare("SELECT * FROM users WHERE email = 'ali@teste.com'").get();
  const semEntrada = jwt.sign({ id: eu.id, role: eu.role, org_id: orgB, name: eu.name, master: true, sd: eu.sessoes_desde || 0 }, "teste-acesso", { expiresIn: "1h" });
  assert.equal((await req("GET", "/leads", null, semEntrada)).s, 403);

  caso("A conta do próprio master e o ambiente interno não pedem código");
  assert.equal((await req("POST", `/orgs/${orgA}/entrar`, {}, tAli)).s, 200);
  r = await req("POST", "/orgs/interna", {}, tAli);
  assert.equal((await req("POST", `/orgs/${r.b.org.id}/entrar`, {}, tAli)).s, 200);

  caso("Cinco códigos errados travam a tentativa naquela conta");
  const errado = codigoAtual(orgB).codigo === "123456" ? "654321" : "123456";
  const st = [];
  for (let i = 0; i < 7; i++) st.push((await req("POST", `/orgs/${orgB}/entrar`, { codigo: errado }, tAli)).s);
  assert.deepEqual(st, [403, 403, 403, 403, 403, 429, 429], st.join(","));
  r = await req("POST", `/orgs/${orgB}/entrar`, { codigo: codigoAtual(orgB).codigo }, tAli);
  assert.equal(r.s, 429, "nem o certo passa enquanto travado");

  caso("O código muda a cada minuto, com 15 segundos de folga na virada");
  const base = Math.floor(Date.now() / JANELA_MS) * JANELA_MS;
  const c1 = codigoAtual(orgB, base + 30000).codigo, c2 = codigoAtual(orgB, base + JANELA_MS + 30000).codigo;
  assert.notEqual(c1, c2);
  assert.ok(codigoConfere(orgB, c1, base + 59000));
  assert.ok(codigoConfere(orgB, c1, base + JANELA_MS + FOLGA_MS - 1000), "o de antes vale logo após a virada");
  assert.ok(!codigoConfere(orgB, c1, base + JANELA_MS + FOLGA_MS + 1000), "passada a folga, não vale");
  assert.ok(!codigoConfere(orgA, c1, base + 30000) || codigoAtual(orgA, base + 30000).codigo === c1, "cada conta tem o seu");

  caso("Exceção de conta conhecida: sem código, com saldo de 4 horas por DIA, e a gestão avisada a cada entrada");
  r = await req("POST", `/orgs/${orgB}/acesso-livre`, { liberado: true }, tGestoraB);
  assert.equal(r.s, 403, "o cliente não liga a exceção");
  r = await req("POST", `/orgs/${orgB}/acesso-livre`, { liberado: true }, tAli);
  assert.equal(r.s, 200, JSON.stringify(r.b)); assert.equal(r.b.org.acesso.livre, true);
  assert.equal(r.b.org.acesso.saldo_hoje_ms, 4 * 3600000);
  r = await req("POST", `/orgs/${orgB}/entrar`, {}, tAli);
  assert.equal(r.s, 200, "entra sem código (e passa por cima da trava de códigos errados)");
  assert.equal(r.b.sem_codigo, true); assert.equal(r.b.saldo_ms, 4 * 3600000);
  let tLivre = r.b.token;
  await new Promise(res => setTimeout(res, 300));
  assert.match(saida, /e-mail para gestorab@teste\.com não enviado\. Assunto: ConHub: entrada do suporte/, "a gestão é avisada");
  const ultima = db.prepare("SELECT * FROM acessos_master WHERE org_id = ? ORDER BY inicio DESC LIMIT 1").get(orgB);
  assert.equal(ultima.sem_codigo, 1);
  const uso = () => db.prepare("SELECT COALESCE(SUM(usado_ms),0) n FROM acesso_livre_uso WHERE org_id = ?").get(orgB).n;
  // Conta aberta: o tempo desde o último pedido sai do saldo.
  db.prepare("UPDATE acessos_master SET visto_em = ? WHERE id = ?").run(Date.now() - 60000, ultima.id);
  assert.equal((await req("GET", "/leads", null, tLivre)).s, 200);
  assert.ok(uso() >= 59000 && uso() < 70000, "1 minuto aberto = 1 minuto gasto: " + uso());
  // Aba fechada (intervalo grande) não conta.
  db.prepare("UPDATE acessos_master SET visto_em = ? WHERE id = ?").run(Date.now() - 30 * 60000, ultima.id);
  const antes = uso();
  await req("GET", "/leads", null, tLivre);
  assert.ok(uso() - antes < 2000, "intervalo de 30 min sem pedido não conta");
  // O hub não gasta.
  db.prepare("UPDATE acessos_master SET visto_em = ? WHERE id = ?").run(Date.now() - 60000, ultima.id);
  const antesHub = uso();
  await req("GET", "/orgs", null, tLivre);
  assert.equal(uso(), antesHub, "o hub não conta");
  // Gastou as 4 horas: volta ao hub, e só amanhã entra sem código.
  const { diaDe } = await import("../src/services/acesso-master.js");
  db.prepare("UPDATE acesso_livre_uso SET usado_ms = ? WHERE org_id = ? AND dia = ?").run(4 * 3600000, orgB, diaDe(Date.now()));
  r = await req("GET", "/leads", null, tLivre);
  assert.equal(r.s, 403); assert.equal(r.b.codigo, "acesso_vencido"); assert.match(r.b.error, /tempo de hoje/);
  r = await req("POST", `/orgs/${orgB}/entrar`, {}, tAli);
  assert.equal(r.s, 428); assert.equal(r.b.livre_esgotado, true); assert.match(r.b.error, /Amanhã renovam/);
  r = await req("POST", `/orgs/${orgB}/entrar`, { codigo: "000000" }, tAli);
  assert.notEqual(r.s, 200, "com código digitado, vale a conferência do código (aqui, a trava do caso anterior)");
  // Saldo de ontem não acumula: o dia novo começa com 4 horas.
  db.prepare("UPDATE acesso_livre_uso SET dia = ? WHERE org_id = ?").run("2000-01-01", orgB);
  r = await req("POST", `/orgs/${orgB}/entrar`, {}, tAli);
  assert.equal(r.s, 200, "dia novo, saldo novo"); assert.equal(r.b.saldo_ms, 4 * 3600000); tLivre = r.b.token;
  r = await req("GET", "/auth/conta/acesso", null, tGestoraB);
  assert.ok(r.b.livre, "a gestão vê que a exceção está ligada");
  assert.ok(r.b.acessos.some(a => a.sem_codigo && a.aberto));
  assert.equal((await req("POST", "/auth/conta/acesso/livre/desligar", {}, tAli)).s, 403, "o master não usa a rota da gestão");
  r = await req("POST", "/auth/conta/acesso/livre/desligar", {}, tGestoraB);
  assert.equal(r.s, 200);
  assert.equal((await req("GET", "/leads", null, tLivre)).s, 403, "desligar encerra a entrada aberta");
  r = await req("POST", `/orgs/${orgB}/entrar`, {}, tAli);
  assert.equal(r.s, 428, "voltou a pedir o código");
  const interna = db.prepare("SELECT id FROM orgs WHERE tipo = 'interna'").get().id;
  r = await req("POST", `/orgs/${interna}/acesso-livre`, { liberado: true }, tAli);
  assert.equal(r.s, 409, "conta que não pede código não precisa de exceção");

  console.log(`\nOK — ${n} casos.`);
} catch (e) {
  console.error("\nFALHOU:", e.stack || e.message);
  console.error(saida.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
}
