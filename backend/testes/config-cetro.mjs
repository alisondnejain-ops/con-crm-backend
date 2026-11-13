/* CONFIGURAÇÕES DO CETRO (capítulo 24, 13/11/2026): "configurar
   individualmente nas etapas" como padrão da conta, e o aviso menor que o prazo.
   Rodar:  npm run teste:config-cetro */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-config-cetro.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }
const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { definirConfigDoPrazo, configDoPrazo } = await import("../src/services/prazo-vencido.js");
const { garantirPipelinePadrao, editarEtapa } = await import("../src/services/pipelines.js");
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Imob C", "C-1", Date.now());
garantirPipelinePadrao(org);
const etapa = db.prepare("SELECT id FROM pipeline_stages WHERE org_id=? LIMIT 1").get(org).id;
let r = definirConfigDoPrazo(org, { acao: "etapas" });
assert.equal(r.acao, "etapas"); assert.equal(configDoPrazo(org).acao, "etapas");
r = editarEtapa(org, etapa, { prazo_acao: "etapas" }); assert.ok(r.erro, "'etapas' não vale como ação de uma etapa");
r = editarEtapa(org, etapa, { sla_minutes: 60, warning_before_minutes: 90 }); assert.match(r.erro || "", /antes do prazo/);
r = editarEtapa(org, etapa, { sla_minutes: 1440, warning_before_minutes: 120 }); assert.ok(!r.erro, JSON.stringify(r));
console.log("OK — configurações do CETRO.");
