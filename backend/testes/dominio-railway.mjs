/* DOMÍNIO DO SITE CADASTRADO NO RAILWAY PELA API (04/10/2026).

   Servidor inteiro de pé, com um Railway DE MENTIRA (um servidor GraphQL
   local apontado por RAILWAY_API_URL). O Railway de verdade não é alcançável
   deste ambiente — o que se prova aqui é o nosso lado: o que é pedido, com
   que credencial, e o que a imobiliária vê com cada resposta.

   - salvar o domínio cadastra no Railway (com projeto/ambiente/serviço e o
     token) e devolve à imobiliária o CNAME e o TXT de verificação;
   - o nome do registro sai relativo ao domínio ("www", "_railway-verify.www");
   - registro que o Railway já enxerga aparece como pronto;
   - campo que o Railway não conhece não derruba a leitura (pergunta de novo
     com menos campos);
   - domínio já cadastrado no serviço é reaproveitado, não vira erro;
   - recusa do Railway vira a frase do quadro, com o motivo escrito;
   - trocar, tirar o domínio ou apagar a conta remove o cadastro no Railway;
   - o hub sabe que o cadastro é automático.

   Rodar:  npm run teste:dominio-railway
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(os.tmpdir(), "concrm-teste-dominio-railway.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB + s); } catch (e) {} }
process.env.DB_PATH = DB;
process.env.JWT_SECRET = "teste";

/* ===== O Railway de mentira ===== */
const rw = { pedidos: [], apagados: [], dominios: new Map(), seq: 0, esquemaAntigo: false, recusar: null, enxerga: false };
const RW_PORTA = 4728;
const falso = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    const { query, variables } = JSON.parse(corpo || "{}");
    rw.pedidos.push({ query, variables, auth: req.headers.authorization });
    const responde = (x) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(x)); };
    if (/customDomainCreate/.test(query)) {
      const d = variables.input.domain;
      if (rw.recusar) return responde({ errors: [{ message: rw.recusar }] });
      for (const [id, x] of rw.dominios) if (x.domain === d) return responde({ errors: [{ message: "Domain already exists" }] });
      const id = "cd_" + (++rw.seq);
      rw.dominios.set(id, { domain: d, input: variables.input });
      return responde({ data: { customDomainCreate: { id, domain: d } } });
    }
    if (/customDomainDelete/.test(query)) { rw.apagados.push(variables.id); rw.dominios.delete(variables.id); return responde({ data: { customDomainDelete: true } }); }
    if (/domains\(/.test(query)) {
      return responde({ data: { domains: { customDomains: [...rw.dominios].map(([id, x]) => ({ id, domain: x.domain })) } } });
    }
    if (/customDomain\(/.test(query)) {
      if (rw.esquemaAntigo && /verificationDnsHost/.test(query))
        return responde({ errors: [{ message: 'Cannot query field "verificationDnsHost" on type "CustomDomainStatus".' }] });
      const x = rw.dominios.get(variables.id);
      if (!x) return responde({ data: { customDomain: null } });
      const zona = x.domain.replace(/^www\./, "");
      const status = {
        dnsRecords: [{ hostlabel: "www", recordType: "DNS_RECORD_TYPE_CNAME", requiredValue: "xyz123.up.railway.app",
          currentValue: rw.enxerga ? "xyz123.up.railway.app" : "", status: rw.enxerga ? "DNS_RECORD_STATUS_PROPAGATED" : "DNS_RECORD_STATUS_REQUIRES_UPDATE", zone: zona }],
        verificationToken: "railway-verify=abc123",
      };
      if (!rw.esquemaAntigo) Object.assign(status, { verificationDnsHost: `_railway-verify.www.${zona}`, verified: rw.enxerga, certificateStatus: "CERTIFICATE_STATUS_TYPE_PENDING" });
      return responde({ data: { customDomain: { id: variables.id, domain: x.domain, status } } });
    }
    responde({ errors: [{ message: "consulta não esperada no teste" }] });
  });
});
await new Promise((ok) => falso.listen(RW_PORTA, "127.0.0.1", ok));

const PORTA = 4727;
const servidor = spawn(process.execPath, [path.join(aqui, "..", "src", "server.js")], {
  env: { ...process.env, DB_PATH: DB, PORT: String(PORTA), JWT_SECRET: "teste", ADM_CODE: "DOM-RW-1", APP_URL: "", SITE_DNS_DESTINO: "",
    SITE_DOMINIO_AGENDADOR: "0", RAILWAY_API_URL: `http://127.0.0.1:${RW_PORTA}/graphql/v2`, RAILWAY_API_TOKEN: "tok-teste",
    RAILWAY_PROJECT_TOKEN: "", RAILWAY_PROJECT_ID: "proj-1", RAILWAY_ENVIRONMENT_ID: "env-1", RAILWAY_SERVICE_ID: "svc-1" },
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
  const bcrypt = (await import("bcryptjs")).default;
  const senha = bcrypt.hashSync("123456", 8);
  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get().id;
  const orgB = "org_b_" + randomUUID().slice(0, 6);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(orgB, "Outra Casa", "OUTRA-RW", Date.now());
  const usuario = (o, email, role, master = 0) => {
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master) VALUES (?,?,?,?,?,?,1,?,'ativo',?)`)
      .run("u_" + randomUUID(), o, email.split("@")[0], email, senha, role, Date.now(), master);
  };
  usuario(org, "gestor@rw.com", "adm");
  usuario(orgB, "gestorb@rw.com", "adm");
  usuario(org, "master@rw.com", "adm", 1);
  const como = async (email) => {
    const t = (await (await fetch(url("/auth/login"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "123456" }) })).json()).token;
    const h = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    return {
      get: async (p) => { const r = await fetch(url(p), { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
      send: async (m, p, b) => { const r = await fetch(url(p), { method: m, headers: h, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    };
  };
  const gestor = await como("gestor@rw.com"), gestorB = await como("gestorb@rw.com"), master = await como("master@rw.com");

  caso("Salvar o domínio cadastra no Railway e devolve o CNAME e o TXT para criar");
  let r = await gestor.send("PATCH", "/site", { dominio: "www.casanova.test" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const criado = rw.pedidos.find(p => /customDomainCreate/.test(p.query));
  assert.ok(criado, "o Railway não recebeu o cadastro");
  assert.deepEqual(criado.variables.input, { domain: "www.casanova.test", projectId: "proj-1", environmentId: "env-1", serviceId: "svc-1" });
  assert.equal(criado.auth, "Bearer tok-teste");
  assert.equal(r.body.dominio_automatico, true);
  assert.equal(r.body.dominio_estado, "aguardando_dns");
  assert.deepEqual(r.body.dominio_registros, [
    { tipo: "CNAME", nome: "www", valor: "xyz123.up.railway.app", ok: false },
    { tipo: "TXT", nome: "_railway-verify.www", valor: "railway-verify=abc123", ok: false },
  ]);
  assert.equal(r.body.dominio_destino, "xyz123.up.railway.app");
  assert.match(r.body.dominio_detalhe, /o CNAME www e o TXT _railway-verify\.www/);
  console.log("   ✓", r.body.dominio_detalhe);

  caso("Quando o Railway passa a enxergar os registros, eles aparecem como prontos");
  rw.enxerga = true;
  r = await gestor.send("POST", "/site/dominio/verificar");
  assert.equal(r.status, 200);
  assert.ok(r.body.dominio_registros.every(x => x.ok), JSON.stringify(r.body.dominio_registros));
  // O domínio de teste não existe de verdade: o site não responde por ele, então segue esperando.
  assert.equal(r.body.dominio_estado, "aguardando_dns");
  assert.match(r.body.dominio_detalhe, /certificado/);
  assert.equal(rw.pedidos.filter(p => /customDomainCreate/.test(p.query)).length, 1, "conferir não pode cadastrar de novo");
  console.log("   ✓", r.body.dominio_detalhe);

  caso("Campo que o Railway não conhece não derruba a leitura");
  rw.esquemaAntigo = true; rw.enxerga = false;
  r = await gestor.send("POST", "/site/dominio/verificar");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dominio_registros.map(x => [x.tipo, x.nome]), [["CNAME", "www"], ["TXT", "_railway-verify.www"]]);
  rw.esquemaAntigo = false;
  console.log("   ✓ leu de novo sem o campo novo");

  caso("Trocar o domínio tira o cadastro antigo do Railway e cria o novo");
  const antigo = [...rw.dominios.keys()][0];
  r = await gestor.send("PATCH", "/site", { dominio: "www.casanova2.test" });
  assert.equal(r.status, 200);
  assert.ok(rw.apagados.includes(antigo));
  assert.equal(r.body.dominio_registros[0].valor, "xyz123.up.railway.app");
  assert.equal([...rw.dominios.values()].map(x => x.domain).join(), "www.casanova2.test");

  caso("Domínio já cadastrado no serviço é reaproveitado");
  rw.dominios.set("cd_existente", { domain: "www.jaexiste.test" });
  r = await gestorB.send("PATCH", "/site", { dominio: "www.jaexiste.test" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dominio_estado, "aguardando_dns");
  assert.equal(db.prepare("SELECT dominio_railway_id FROM sites WHERE org_id = ?").get(orgB).dominio_railway_id, "cd_existente");

  caso("Recusa do Railway vira a frase do quadro, com o motivo");
  rw.recusar = "Custom domain limit reached for this service";
  r = await gestor.send("PATCH", "/site", { dominio: "www.limite.test" });
  assert.equal(r.status, 200);
  assert.equal(r.body.dominio_estado, "aguardando_conhub");
  assert.match(r.body.dominio_detalhe, /Custom domain limit reached/);
  assert.deepEqual(r.body.dominio_registros, []);
  // Conferir de novo tenta outra vez — e com o Railway aceitando, segue.
  rw.recusar = null;
  r = await gestor.send("POST", "/site/dominio/verificar");
  assert.equal(r.body.dominio_estado, "aguardando_dns");
  assert.equal(r.body.dominio_registros.length, 2);
  console.log("   ✓ recusado, e depois aceito ao conferir de novo");

  caso("O hub sabe que o cadastro é automático");
  r = await master.get("/orgs/dominios");
  assert.equal(r.status, 200);
  assert.equal(r.body.automatico, true);
  assert.ok(r.body.dominios.every(x => x.automatico === 1), JSON.stringify(r.body.dominios));
  r = await gestor.get("/orgs/dominios");
  assert.notEqual(r.status, 200, "o gestor de uma imobiliária não lê a lista de domínios da plataforma");

  caso("Tirar o domínio remove o cadastro no Railway");
  const doGestor = db.prepare("SELECT dominio_railway_id FROM sites WHERE org_id = ?").get(org).dominio_railway_id;
  r = await gestor.send("PATCH", "/site", { dominio: "" });
  assert.equal(r.status, 200);
  assert.ok(rw.apagados.includes(doGestor));
  assert.equal(r.body.dominio, "");

  caso("Apagar a conta remove o domínio dela do Railway");
  r = await master.send("DELETE", `/orgs/${orgB}`, { confirmar: "Outra Casa" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(rw.apagados.includes("cd_existente"));

  console.log("\nTudo certo ✅");
} catch (e) {
  console.error("\n❌", e.message);
  console.error(saida.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  servidor.kill();
  falso.close();
}
