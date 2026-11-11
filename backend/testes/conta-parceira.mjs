/* A CONTA PARCEIRA (11/11/2026, POST /orgs/:id/parceira).

   Pedido do Ali para a Reserva Real do Rio: conta só para coordenar os
   corretores parceiros — sem cobrança nem cartão, todas as ferramentas, e o
   master entrando sem o código de 6 dígitos.

   1. Só o master marca; o gestor da conta não.
   2. Conta do site esperando cartão fica ATIVA quando marcada.
   3. Todas as ferramentas ficam ligadas, com origem "parceira".
   4. O master entra sem código.
   5. Escrever em /assinatura responde 409 (não há mensalidade).
   6. Desmarcar volta tudo como era (trava sem cartão, pede código).
   7. O ambiente interno é recusado.

   Rodar:  npm run teste:conta-parceira */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-conta-parceira.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4831";
process.env.MARKETING_AGENDADOR = "0";
process.env.UAZAPI_AUTOCONFIGURAR = "0";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
await import("../src/server.js");
const BASE = "http://localhost:4831";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const agora = Date.now();
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES ('org_ch','Casa do ConHub','CH-P',?)").run(agora);
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
  VALUES ('u_master','org_ch','Ali','ali@ch.com',?,'adm',1,?,'ativo',1)`).run(senha, agora);
// Como nasce uma conta do site: exige cartão e ainda não tem.
db.prepare(`INSERT INTO orgs (id,name,adm_code,created_at,tipo,exige_cartao,dono_user_id)
  VALUES ('org_rr','Reserva Real do Rio','RR-1',?,'imobiliaria',1,'u_elder')`).run(agora - 86400000);
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES ('u_elder','org_rr','Elder','elder@rr.com',?,'adm',1,?,'ativo')`).run(senha, agora);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at,tipo) VALUES ('org_int','ConHub interno','INT-1',?,'interna')").run(agora);

const entrarLogin = async (email) => (await (await fetch(BASE + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }) })).json()).token;
const chamar = async (t, c, m = "GET", corpo) => { const r = await fetch(BASE + c, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" },
  body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const tMaster = await entrarLogin("ali@ch.com"), tElder = await entrarLogin("elder@rr.com");

let ok = 0; const caso = async (nome, fn) => { await fn(); ok++; console.log("✓", nome); };

await caso("0. Antes: a conta espera o cartão e o master precisa do código", async () => {
  const a = await chamar(tElder, "/assinatura");
  assert.equal(a.d.status, "aguardando_cartao");
  const e = await chamar(tMaster, "/orgs/org_rr/entrar", "POST", {});
  assert.equal(e.status, 428);
});

await caso("1. Só o master marca", async () => {
  const g = await chamar(tElder, "/orgs/org_rr/parceira", "POST", { ligado: true });
  assert.ok(g.status === 403 || g.status === 401, "gestor não pode: " + g.status);
  const sem = await chamar(tMaster, "/orgs/org_rr/parceira", "POST", {});
  assert.equal(sem.status, 400);
  const m = await chamar(tMaster, "/orgs/org_rr/parceira", "POST", { ligado: true });
  assert.equal(m.status, 200, JSON.stringify(m.d));
  assert.equal(m.d.org.parceira, true);
  const linha = db.prepare("SELECT parceira, parceira_por FROM orgs WHERE id='org_rr'").get();
  assert.equal(linha.parceira, 1); assert.equal(linha.parceira_por, "u_master");
});

await caso("2. Sem cartão, a conta fica ativa e sem cobrança", async () => {
  const a = await chamar(tElder, "/assinatura");
  assert.equal(a.d.status, "ativo"); assert.equal(a.d.parceira, true);
  // E as rotas que o porteiro trava respondem.
  const l = await chamar(tElder, "/leads");
  assert.equal(l.status, 200);
});

await caso("3. Todas as ferramentas ligadas, com origem parceira", async () => {
  const r = await chamar(tElder, "/assinatura/recursos");
  assert.equal(r.status, 200);
  assert.ok(r.d.recursos.length >= 2);
  for (const x of r.d.recursos) { assert.equal(x.ativo, true, x.id); assert.equal(x.origem, "parceira", x.id); }
});

await caso("4. O master entra sem código", async () => {
  const e = await chamar(tMaster, "/orgs/org_rr/entrar", "POST", {});
  assert.equal(e.status, 200, JSON.stringify(e.d));
  assert.ok(e.d.token);
  const l = await chamar(e.d.token, "/leads");
  assert.equal(l.status, 200);
});

await caso("5. Escrever em /assinatura responde 409", async () => {
  const c = await chamar(tElder, "/assinatura/cancelar", "POST", {});
  assert.equal(c.status, 409); assert.match(c.d.error, /parceira/);
  const p = await chamar(tElder, "/assinatura/plano", "POST", { plano_id: "essencial_mensal" });
  assert.equal(p.status, 409);
});

await caso("6. Desmarcar volta como era", async () => {
  const m = await chamar(tMaster, "/orgs/org_rr/parceira", "POST", { ligado: false });
  assert.equal(m.status, 200); assert.equal(m.d.org.parceira, false);
  const a = await chamar(tElder, "/assinatura");
  assert.equal(a.d.status, "aguardando_cartao");
  const e = await chamar(tMaster, "/orgs/org_rr/entrar", "POST", {});
  assert.equal(e.status, 428);
});

await caso("7. O ambiente interno é recusado", async () => {
  const m = await chamar(tMaster, "/orgs/org_int/parceira", "POST", { ligado: true });
  assert.equal(m.status, 409);
});

console.log(`\n${ok} casos passaram.`);
process.exit(0);
