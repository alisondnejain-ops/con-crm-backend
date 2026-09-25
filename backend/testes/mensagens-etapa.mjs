/* MENSAGENS PRONTAS POR ETAPA (24-25/09/2026, pedido do Ali).

   Cada mensagem pronta pode dizer em que etapa(s) do funil ela aparece
   primeiro na conversa. O que este teste tranca:

   1. mensagem antiga (sem etapa) continua valendo para TODAS — a migração
      não pode esconder o que a equipe já usava;
   2. só entram ids de etapa DESTA imobiliária — id inventado ou da casa
      vizinha é descartado em silêncio, senão a mensagem apontaria para uma
      etapa que ninguém daqui consegue ver nem desmarcar;
   3. editar o texto, ligar/desligar ou mover NÃO apaga as etapas;
   4. etapa apagada sai da lista na leitura, e a mensagem que fica sem
      nenhuma vira geral em vez de sumir;
   5. o corretor lê as etapas (é ele quem usa os botões) mas não edita;
   6. o dono de uma conta AUTÔNOMA (papel `corretor`) vê as desligadas na
      tela de configuração — antes a lista dele vinha só com as ligadas, e a
      mensagem que ele desligava sumia da tela para sempre.

   Rodar:  npm run teste:mensagens-etapa
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-msg-etapa.db");
process.env.JWT_SECRET = "teste";
process.env.PORT = "4636";
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");
const { garantirPipelinePadrao, pipelinePadrao, etapasDoPipeline, criarEtapa, apagarEtapa } = await import("../src/services/pipelines.js");
await import("../src/server.js");
const BASE = "http://localhost:4636";
await new Promise(r => setTimeout(r, 700));

const bcrypt = (await import("bcryptjs")).default;
const senha = bcrypt.hashSync("123456", 8);
const criarOrg = (nome, codigo, extra = {}) => { const id = "org_" + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id, nome, codigo, Date.now());
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE orgs SET ${k}=? WHERE id=?`).run(v, id);
  garantirPipelinePadrao(id);
  return id; };
const criarUser = (org, nome, email, role) => { const id = "u_" + randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id, org, nome, email, senha, role, Date.now());
  return id; };

const org = criarOrg("Conecta", "ME-1");
const vizinha = criarOrg("Place", "ME-2");
criarUser(org, "Ali", "ali@me.com", "adm");
criarUser(org, "Vanessa", "vanessa@me.com", "sdr");
criarUser(org, "Marina", "marina@me.com", "corretor");

const etapas = etapasDoPipeline(org, pipelinePadrao(org).id);
const etLead = etapas.find(e => e.name === "Lead"), etAtend = etapas.find(e => e.name === "Atendimento");
const etVizinha = etapasDoPipeline(vizinha, pipelinePadrao(vizinha).id)[0];
assert.ok(etLead && etAtend && etVizinha, "funil padrão sem as etapas esperadas");

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "123456" }) });
  const d = await r.json(); assert.ok(d.token, `login de ${email} falhou: ${JSON.stringify(d)}`); return d.token;
}
const chamar = async (token, caminho, opts = {}) => {
  const r = await fetch(BASE + caminho, { ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + token } });
  return { status: r.status, body: await r.json() };
};
const tAli = await entrar("ali@me.com"), tVanessa = await entrar("vanessa@me.com"), tMarina = await entrar("marina@me.com");
const doId = (lista, id) => lista.find(m => m.id === id);

console.log("1. Mensagens semeadas nascem gerais (todas as etapas)");
let r = await chamar(tAli, "/config/mensagens?todas=1");
assert.equal(r.status, 200);
assert.ok(r.body.mensagens.length >= 4);
assert.ok(r.body.mensagens.every(m => Array.isArray(m.etapas) && m.etapas.length === 0));

console.log("2. Criar com etapas: só ficam as desta imobiliária");
r = await chamar(tVanessa, "/config/mensagens", { method: "POST", body: JSON.stringify({
  titulo: "Saudação", corpo: "Oi {nome}!", etapas: [etLead.id, "inventada", etVizinha.id, etLead.id] }) });
assert.equal(r.status, 200);
const saud = r.body.mensagens.find(m => m.titulo === "Saudação");
assert.deepEqual(saud.etapas, [etLead.id]);

console.log("3. Editar o texto não mexe nas etapas");
r = await chamar(tAli, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ corpo: "Olá {nome}!" }) });
assert.deepEqual(doId(r.body.mensagens, saud.id).etapas, [etLead.id]);

console.log("4. Desligar e mover não mexem nas etapas");
r = await chamar(tAli, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ ativo: false }) });
assert.deepEqual(doId(r.body.mensagens, saud.id).etapas, [etLead.id]);
r = await chamar(tAli, `/config/mensagens/${saud.id}/mover`, { method: "POST", body: JSON.stringify({ direcao: "cima" }) });
assert.deepEqual(doId(r.body.mensagens, saud.id).etapas, [etLead.id]);
r = await chamar(tAli, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ ativo: true }) });

console.log("5. Várias etapas, e depois voltar a ser geral");
r = await chamar(tAli, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ etapas: [etLead.id, etAtend.id] }) });
assert.deepEqual(doId(r.body.mensagens, saud.id).etapas.sort(), [etLead.id, etAtend.id].sort());
r = await chamar(tAli, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ etapas: [] }) });
assert.deepEqual(doId(r.body.mensagens, saud.id).etapas, []);

console.log("6. O corretor lê as etapas, mas não edita");
await chamar(tAli, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ etapas: [etAtend.id] }) });
r = await chamar(tMarina, "/config/mensagens");
assert.deepEqual(doId(r.body.mensagens, saud.id).etapas, [etAtend.id]);
r = await chamar(tMarina, `/config/mensagens/${saud.id}`, { method: "PATCH", body: JSON.stringify({ etapas: [] }) });
assert.equal(r.status, 403);

console.log("7. Etapa apagada sai da lista; sem nenhuma, a mensagem vira geral");
const nova = criarEtapa(org, pipelinePadrao(org).id, { name: "Temporária" }).etapa;
r = await chamar(tAli, "/config/mensagens", { method: "POST", body: JSON.stringify({ titulo: "Só na temporária", corpo: "x", etapas: [nova.id] }) });
const temp = r.body.mensagens.find(m => m.titulo === "Só na temporária");
assert.deepEqual(temp.etapas, [nova.id]);
assert.ok(apagarEtapa(org, nova.id).ok);
r = await chamar(tAli, "/config/mensagens?todas=1");
assert.deepEqual(doId(r.body.mensagens, temp.id).etapas, []);

console.log("8. Dono de conta autônoma vê as mensagens desligadas na configuração");
const casaDele = criarOrg("Corretor Solo", "ME-3", { tipo: "autonomo" });
const dono = criarUser(casaDele, "Alberto", "alberto@me.com", "corretor");
db.prepare("UPDATE orgs SET dono_user_id=? WHERE id=?").run(dono, casaDele);
const tDono = await entrar("alberto@me.com");
r = await chamar(tDono, "/config/mensagens?todas=1");
const primeira = r.body.mensagens[0];
r = await chamar(tDono, `/config/mensagens/${primeira.id}`, { method: "PATCH", body: JSON.stringify({ ativo: false }) });
assert.equal(r.status, 200);
r = await chamar(tDono, "/config/mensagens?todas=1");
assert.ok(doId(r.body.mensagens, primeira.id), "a mensagem desligada sumiu da tela do dono");
assert.equal(doId(r.body.mensagens, primeira.id).ativo, false);

console.log("\nTudo certo ✅");
process.exit(0);
