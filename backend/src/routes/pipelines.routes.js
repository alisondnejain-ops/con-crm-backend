/* API DO CORE DE GESTAO: pipelines, etapas e campos personalizados.

   QUEM PODE O QUE

   Ler é de todo mundo que está logado, e é de propósito: o corretor precisa
   das etapas para desenhar o funil dele, e esconder a lista só faria a tela
   dele quebrar. Escrever é de quem supervisiona (gestor e atendente) — montar
   o fluxo de trabalho é decisão de quem responde pela operação, não de quem
   está atendendo dentro dele.

   Fica atrás do `cobrando` no server.js, junto das outras rotas de trabalho:
   configurar funil é uso do sistema, e conta bloqueada não usa o sistema. */

import { Router } from "express";
import db from "../db.js";
import { authRequired, supervisiona } from "../auth.js";
import {
  listarPipelines, pipelinePorId, criarPipeline, editarPipeline, duplicarPipeline, apagarPipeline,
  etapasDoPipeline, etapaPorId, criarEtapa, editarEtapa, reordenarEtapas, apagarEtapa,
  criarDoTemplate, pipelinePadrao, TEMPLATES,
} from "../services/pipelines.js";

const r = Router();
r.use(authRequired);

const soGestao = (req, res, next) => supervisiona(req.user)
  ? next()
  : res.status(403).json({ error: "Só a gestão configura os funis." });

const ok = (res, resultado) => resultado.erro
  ? res.status(resultado.leads ? 409 : 400).json({ error: resultado.erro, leads: resultado.leads })
  : res.json(resultado);

/* ===== PIPELINES ===== */

/* A lista vem COM as etapas de cada um. Duas requisições (lista e depois as
   etapas do escolhido) fariam o kanban abrir vazio e preencher um instante
   depois, em toda troca de funil — e são poucos dados. */
r.get("/", (req, res) => {
  const incluirInativos = req.query.todos === "1" && supervisiona(req.user);
  const pipelines = listarPipelines(req.user.org_id, { incluirInativos }).map(p => ({
    ...p,
    stages: etapasDoPipeline(req.user.org_id, p.id, { incluirInativas: incluirInativos }),
  }));
  res.json({
    pipelines,
    padrao: pipelinePadrao(req.user.org_id)?.id || null,
    // Os modelos prontos só interessam a quem pode criar.
    templates: supervisiona(req.user)
      ? TEMPLATES.map(t => ({ id: t.id, nome: t.nome, tipo: t.tipo, descricao: t.descricao,
          para: t.para, etapas: t.etapas.map(e => e.name) }))
      : undefined,
  });
});

r.get("/:id", (req, res) => {
  const p = pipelinePorId(req.user.org_id, req.params.id);
  if (!p) return res.status(404).json({ error: "Pipeline não encontrado." });
  res.json({ ...p, stages: etapasDoPipeline(req.user.org_id, p.id, { incluirInativas: supervisiona(req.user) }) });
});

r.post("/", soGestao, (req, res) => {
  /* Duas portas na mesma rota: criar do zero, ou a partir de um modelo. O
     `template` é o caminho que a maioria vai usar — funil vazio obriga a
     inventar as etapas antes de ver o produto funcionando. */
  const { template, name, description, type, is_default } = req.body || {};
  return ok(res, template
    ? criarDoTemplate(req.user.org_id, template, { name, is_default })
    : criarPipeline(req.user.org_id, { name, description, type, is_default }));
});

r.patch("/:id", soGestao, (req, res) => ok(res, editarPipeline(req.user.org_id, req.params.id, req.body || {})));

r.post("/:id/duplicar", soGestao, (req, res) =>
  ok(res, duplicarPipeline(req.user.org_id, req.params.id, req.body?.name)));

r.delete("/:id", soGestao, (req, res) => ok(res, apagarPipeline(req.user.org_id, req.params.id)));

/* ===== ETAPAS ===== */

r.post("/:id/etapas", soGestao, (req, res) =>
  ok(res, criarEtapa(req.user.org_id, req.params.id, req.body || {})));

r.patch("/etapas/:etapaId", soGestao, (req, res) =>
  ok(res, editarEtapa(req.user.org_id, req.params.etapaId, req.body || {})));

r.delete("/etapas/:etapaId", soGestao, (req, res) =>
  ok(res, apagarEtapa(req.user.org_id, req.params.etapaId)));

r.post("/:id/etapas/ordem", soGestao, (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: "Mande a lista de etapas na ordem nova." });
  res.json(reordenarEtapas(req.user.org_id, req.params.id, ids));
});

/* ===== CAMPOS PERSONALIZADOS =====

   Ficam aqui, e não numa rota própria, porque na prática são a mesma
   configuração: o gestor escolhe quais campos a empresa usa e, na etapa,
   quais deles são obrigatórios. Separar em dois lugares faria a segunda
   decisão parecer independente da primeira. */

const TIPOS = ["text", "number", "currency", "select", "multiselect", "date", "boolean", "phone", "email"];

/* A chave é o que fica gravado em cada lead, para sempre. Por isso ela nasce
   do nome uma vez e NUNCA muda depois: mudar a chave de um campo com dados
   dentro faria o valor de todos os leads apontar para um campo que não existe
   mais — sem erro nenhum, só um campo que amanheceu vazio. */
const chaveDe = (nome) => String(nome || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

r.get("/campos/lista", (req, res) => {
  res.json({
    campos: db.prepare(`SELECT * FROM custom_fields WHERE org_id = ? AND is_active = 1
      ORDER BY ordem, created_at`).all(req.user.org_id).map(formatarCampo),
    tipos: TIPOS,
  });
});

const formatarCampo = (c) => ({
  id: c.id, name: c.name, key: c.key, type: c.type,
  options: (() => { try { return JSON.parse(c.options || "[]"); } catch (e) { return []; } })(),
  is_required_default: !!c.is_required_default,
  show_on_card: !!c.show_on_card,
  show_on_lead_profile: !!c.show_on_lead_profile,
  show_on_conversation_sidebar: !!c.show_on_conversation_sidebar,
  show_on_reports: !!c.show_on_reports,
  ordem: c.ordem,
});

r.post("/campos", soGestao, (req, res) => {
  const { name, type = "text", options = [], show_on_card = false,
    show_on_lead_profile = true, show_on_conversation_sidebar = false,
    show_on_reports = false, is_required_default = false } = req.body || {};
  const nome = String(name || "").trim();
  if (!nome) return res.status(400).json({ error: "O campo precisa de um nome." });
  if (!TIPOS.includes(type)) return res.status(400).json({ error: "Tipo de campo desconhecido." });
  const key = chaveDe(nome);
  if (!key) return res.status(400).json({ error: "Dê ao campo um nome com letras ou números." });
  const repetido = db.prepare("SELECT id FROM custom_fields WHERE org_id = ? AND key = ? AND is_active = 1").get(req.user.org_id, key);
  if (repetido) return res.status(409).json({ error: "Já existe um campo com esse nome." });

  const { n } = db.prepare("SELECT COUNT(*) n FROM custom_fields WHERE org_id = ?").get(req.user.org_id);
  const id = "cf_" + Math.random().toString(36).slice(2, 12);
  db.prepare(`INSERT INTO custom_fields
    (id,org_id,name,key,type,options,is_required_default,show_on_card,show_on_lead_profile,
     show_on_conversation_sidebar,show_on_reports,ordem,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
    id, req.user.org_id, nome, key, type, JSON.stringify(options || []),
    is_required_default ? 1 : 0, show_on_card ? 1 : 0, show_on_lead_profile ? 1 : 0,
    show_on_conversation_sidebar ? 1 : 0, show_on_reports ? 1 : 0, n, Date.now(), Date.now());
  res.json({ campo: formatarCampo(db.prepare("SELECT * FROM custom_fields WHERE id = ?").get(id)) });
});

r.patch("/campos/:campoId", soGestao, (req, res) => {
  const atual = db.prepare("SELECT * FROM custom_fields WHERE id = ? AND org_id = ?").get(req.params.campoId, req.user.org_id);
  if (!atual) return res.status(404).json({ error: "Campo não encontrado." });
  const d = req.body || {};
  const b = (v, padrao) => v !== undefined ? (v ? 1 : 0) : padrao;
  // A `key` não entra: ela é o endereço do valor dentro de cada lead.
  db.prepare(`UPDATE custom_fields SET name = ?, type = ?, options = ?, is_required_default = ?,
    show_on_card = ?, show_on_lead_profile = ?, show_on_conversation_sidebar = ?, show_on_reports = ?,
    ordem = ?, is_active = ?, updated_at = ? WHERE id = ? AND org_id = ?`).run(
    d.name !== undefined ? String(d.name).trim() || atual.name : atual.name,
    d.type !== undefined && TIPOS.includes(d.type) ? d.type : atual.type,
    d.options !== undefined ? JSON.stringify(d.options || []) : atual.options,
    b(d.is_required_default, atual.is_required_default),
    b(d.show_on_card, atual.show_on_card),
    b(d.show_on_lead_profile, atual.show_on_lead_profile),
    b(d.show_on_conversation_sidebar, atual.show_on_conversation_sidebar),
    b(d.show_on_reports, atual.show_on_reports),
    d.ordem !== undefined ? Number(d.ordem) : atual.ordem,
    b(d.is_active, atual.is_active), Date.now(), req.params.campoId, req.user.org_id);
  res.json({ campo: formatarCampo(db.prepare("SELECT * FROM custom_fields WHERE id = ?").get(req.params.campoId)) });
});

/* Desativa, não apaga. Os valores continuam nos leads: um campo apagado de vez
   levaria junto o que a equipe preencheu em centenas de atendimentos, e quem
   desliga um campo raramente quer isso — quer parar de pedi-lo. */
r.delete("/campos/:campoId", soGestao, (req, res) => {
  const alvo = db.prepare("SELECT id FROM custom_fields WHERE id = ? AND org_id = ?").get(req.params.campoId, req.user.org_id);
  if (!alvo) return res.status(404).json({ error: "Campo não encontrado." });
  db.prepare("UPDATE custom_fields SET is_active = 0, updated_at = ? WHERE id = ?").run(Date.now(), req.params.campoId);
  res.json({ ok: true, desativado: true });
});

export default r;
