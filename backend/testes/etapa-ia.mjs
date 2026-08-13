/* A IA lê a conversa e SUGERE a etapa — sem nunca gravá-la.

   O teste que importa aqui não é "a IA acerta" (isso depende do modelo), é
   "quando a IA erra o formato, o funil não é tocado". Etapa alimenta o
   relatório que vira cobrança em reunião: resposta estranha tem que virar
   erro na tela, nunca lead mexido de lugar.

   A chamada à Anthropic é trocada por uma resposta de mentira, então o teste
   roda offline e de graça.

   Rodar:  npm run teste:etapa-ia
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-etapa-ia.db");
process.env.JWT_SECRET = "teste";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}

// A resposta que a "Anthropic" vai devolver na próxima chamada.
let proximaResposta = null;
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes("api.anthropic.com")) return real(url, opts);
  return {
    ok: true, status: 200,
    json: async () => ({
      content: [{ type: "text", text: proximaResposta }],
      usage: { input_tokens: 1200, output_tokens: 90 },
    }),
  };
};

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { etapaDaConversa } = await import("../src/services/ia.js");

const conversa = [
  { de: "cliente", texto: "oi, vi o anúncio de vocês" },
  { de: "imobiliaria", texto: "oi! me manda seu RG e comprovante de renda que eu já adianto" },
  { de: "cliente", texto: "segue aí, mandei os dois" },
];

console.log("1. Resposta boa vira sugestão com motivo e trecho");
proximaResposta = JSON.stringify({
  etapa: "Pasta", confianca: "alta",
  porque: "O cliente enviou RG e comprovante de renda.",
  trecho: "segue aí, mandei os dois",
});
let r = await etapaDaConversa({ mensagens: conversa, nome: "Joana" });
console.log(`   ${r.sugestao.etapa} · ${r.sugestao.confianca} · «${r.sugestao.trecho}»`);
assert.equal(r.ok, true);
assert.equal(r.sugestao.etapa, "Pasta");
assert.equal(r.sugestao.confianca, "alta");
assert.equal(r.sugestao.mensagens_lidas, 3);
assert.deepEqual(r.uso, { entrada: 1200, saida: 90 });

console.log("2. Etapa que não existe no funil é recusada");
proximaResposta = JSON.stringify({ etapa: "Negociação avançada", confianca: "alta", porque: "x" });
r = await etapaDaConversa({ mensagens: conversa });
console.log("   ", r.erro);
assert.equal(r.ok, false, "não pode aceitar etapa inventada");

console.log("3. Resposta que não é JSON vira erro, não palpite");
proximaResposta = "Acho que esse lead está em Pasta, mas não tenho certeza.";
r = await etapaDaConversa({ mensagens: conversa });
console.log("   ", r.erro);
assert.equal(r.ok, false);

console.log("4. Confiança fora da lista cai para 'baixa' — nunca para cima");
proximaResposta = JSON.stringify({ etapa: "Visita", confianca: "altíssima", porque: "x" });
r = await etapaDaConversa({ mensagens: conversa });
assert.equal(r.sugestao.confianca, "baixa");

console.log("5. Conversa curta demais não gasta chamada");
r = await etapaDaConversa({ mensagens: [{ de: "cliente", texto: "oi" }] });
assert.equal(r.ok, false);

console.log("6. A rota guarda a SUGESTÃO e não encosta na etapa do lead");
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "A-1", Date.now());
const corretor = "u_" + randomUUID();
db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
  VALUES (?,?,?,?,'x','corretor',1,?,'ativo')`).run(corretor, org, "Marina", "marina@x.com", Date.now());
const leadId = "l_" + randomUUID();
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(leadId, org, "Joana", "5587900001111", "Lead", corretor, Date.now());
conversa.forEach((m, i) => db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)")
  .run("m_" + randomUUID(), leadId, m.de === "cliente" ? "in" : "out", m.texto, Date.now() + i));

const { default: express } = await import("express");
const jwt = (await import("jsonwebtoken")).default;
const { default: leadsRoutes } = await import("../src/routes/leads.routes.js");
const token = jwt.sign({ id: corretor, role: "corretor", org_id: org, name: "Marina" }, "teste", { expiresIn: "1h" });
const app = express(); app.use(express.json()); app.use("/leads", leadsRoutes);
const srv = app.listen(0); const porta = srv.address().port;
const chamar = (p, m) => fetch(`http://127.0.0.1:${porta}${p}`,
  { method: m || "GET", headers: { authorization: "Bearer " + token } }).then(x => x.json());

proximaResposta = JSON.stringify({ etapa: "Pasta", confianca: "alta", porque: "Documentos enviados.", trecho: "mandei os dois" });
const resp = await chamar(`/leads/${leadId}/etapa-ia`, "POST");
console.log(`   sugeriu ${resp.sugestao.etapa}; o lead continua em ${db.prepare("SELECT stage FROM leads WHERE id=?").get(leadId).stage}`);
assert.equal(resp.sugestao.etapa, "Pasta");
assert.equal(db.prepare("SELECT stage FROM leads WHERE id=?").get(leadId).stage, "Lead",
  "a IA NÃO pode mover o lead — só o corretor confirmando");

console.log("7. A sugestão volta junto com a conversa, e o gasto fica com dono");
const lead = await chamar(`/leads/${leadId}`);
assert.equal(lead.etapa_ia.sugestao.etapa, "Pasta");
assert.equal(lead.etapa_ia.igual_a_atual, false);
const { resumoDeUso } = await import("../src/services/iauso.js");
const uso = resumoDeUso(org, 30);
console.log("   ", uso.por_recurso.map(x => `${x.rotulo}: ${x.usos}`).join(" · "));
assert.equal(uso.por_recurso.find(x => x.recurso === "etapa").usos, 1);

console.log("8. Depois que o corretor confirma, a sugestão para de pedir confirmação");
db.prepare("UPDATE leads SET stage='Pasta' WHERE id=?").run(leadId);
const lead2 = await chamar(`/leads/${leadId}`);
assert.equal(lead2.etapa_ia.igual_a_atual, true);

srv.close();
console.log("\nTudo certo ✅");
