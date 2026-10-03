/* OS FORMULÁRIOS DA META, E O FUNIL DE CADA UM (03/10/2026, pedido do Ali:
   "uma subseção dentro do Atender onde aparecem todos os formulários criados
   naquela página, e a opção de aplicar um determinado formulário a um funil").

   Até aqui o lead do formulário caía no funil de QUEM O RECEBE (`entradaDe`):
   com a atendente, no de SDR; com corretor, no comercial. Isso serve para o
   formulário genérico, mas não para o de aluguel — que deveria nascer no funil
   de Locação — nem para o de lançamento. Agora cada formulário pode ter um
   funil (e a etapa de entrada dele). O RESPONSÁVEL não muda: quem recebe o
   lead continua sendo decidido pela catraca. Formulário sem escolha segue a
   regra de sempre.

   DE ONDE VEM A LISTA: (1) da Meta, pela página conectada
   (`/{page}/leadgen_forms`, com o token da página); e (2) dos leads que já
   entraram com um `form_id`. As duas juntas, porque cada uma cobre um buraco
   da outra: a Meta conhece o formulário que ainda não trouxe lead, e os leads
   conhecem o formulário de uma página que não está mais conectada — ou o da
   página antiga da instalação, que não tem token guardado aqui. Se a Meta
   recusar a leitura (permissão do app), a tela diz o motivo e a lista
   continua com o que os leads já trouxeram. */
import db from "../db.js";
import { abrir } from "./cofre.js";
import { formulariosDaPagina } from "./meta.js";
import { catracaAtiva } from "./catracas.js";

export class ErroFormulario extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

/* O funil configurado para um formulário — só se ele ainda existe e está
   ativo. Funil desativado ou etapa apagada depois de configurar: devolve nulo
   e o lead cai na regra de sempre, em vez de nascer fora de todas as colunas. */
export function entradaDoFormulario(orgId, formId) {
  if (!formId) return null;
  const f = db.prepare("SELECT pipeline_id, stage_id FROM meta_formularios WHERE org_id = ? AND form_id = ?").get(orgId, String(formId));
  if (!f || !f.pipeline_id) return null;
  return entradaValida(orgId, f.pipeline_id, f.stage_id);
}

function entradaValida(orgId, pipelineId, stageId) {
  const p = db.prepare("SELECT id, name FROM pipelines WHERE id = ? AND org_id = ? AND is_active = 1").get(pipelineId, orgId);
  if (!p) return null;
  let e = stageId
    ? db.prepare("SELECT id, name FROM pipeline_stages WHERE id = ? AND pipeline_id = ? AND org_id = ? AND is_active = 1").get(stageId, p.id, orgId)
    : null;
  // Etapa não escolhida (ou apagada): a primeira do funil, que é onde lead entra.
  if (!e) e = db.prepare(`SELECT id, name FROM pipeline_stages WHERE pipeline_id = ? AND org_id = ? AND is_active = 1
    ORDER BY ordem, created_at LIMIT 1`).get(p.id, orgId);
  if (!e) return null;
  return { pipeline_id: p.id, stage_id: e.id, nome: e.name, funil: p.name };
}

export async function listarFormularios(orgId) {
  const paginas = db.prepare("SELECT page_id, nome, page_token FROM meta_paginas WHERE org_id = ? ORDER BY conectado_em").all(orgId);
  const porId = new Map();
  const erros = [];

  for (const p of paginas) {
    const token = abrir(p.page_token);
    if (!token) { erros.push({ pagina: p.nome || p.page_id, erro: "o token da página não abre (CRYPTO_KEY trocada?)" }); continue; }
    try {
      for (const f of await formulariosDaPagina(p.page_id, token))
        porId.set(f.id, { id: f.id, nome: f.nome, status: f.status, leads_meta: f.leads_count, criado_em: f.criado_em,
                          page_id: p.page_id, pagina: p.nome || p.page_id });
    } catch (e) {
      erros.push({ pagina: p.nome || p.page_id, erro: String(e.message || e).slice(0, 200) });
    }
  }

  // Os formulários que já trouxeram lead para esta conta.
  const doCrm = db.prepare(`SELECT form_id, MAX(form_name) AS nome, COUNT(*) AS n, MAX(created_at) AS ultimo
    FROM leads WHERE org_id = ? AND form_id IS NOT NULL AND form_id <> '' GROUP BY form_id`).all(orgId);
  for (const f of doCrm) {
    const ja = porId.get(f.form_id) || { id: f.form_id, nome: f.nome, status: null, leads_meta: null, pagina: null };
    porId.set(f.form_id, { ...ja, nome: ja.nome || f.nome, leads_crm: f.n, ultimo_lead_em: f.ultimo });
  }

  // E os que já têm escolha gravada (formulário arquivado, página desconectada).
  const escolhas = db.prepare("SELECT * FROM meta_formularios WHERE org_id = ?").all(orgId);
  for (const c of escolhas) if (!porId.has(c.form_id)) porId.set(c.form_id, { id: c.form_id, nome: c.nome, status: null, pagina: null });

  const escolhaDe = new Map(escolhas.map(c => [c.form_id, c]));
  const formularios = [...porId.values()].map(f => {
    const c = escolhaDe.get(f.id);
    const entrada = c && c.pipeline_id ? entradaValida(orgId, c.pipeline_id, c.stage_id) : null;
    return {
      ...f,
      nome: f.nome || c?.nome || `Formulário ${f.id}`,
      leads_crm: f.leads_crm || 0,
      pipeline_id: c?.pipeline_id || null,
      stage_id: c?.stage_id || null,
      // Escolhido, mas o funil foi desativado depois: a tela avisa.
      funil_invalido: !!(c?.pipeline_id && !entrada),
      entrada,
      // A catraca do formulário (03/10/2026). Desativada ou apagada depois:
      // a tela avisa, e o lead segue a regra de sempre.
      catraca_id: c?.catraca_id || null,
      catraca_invalida: !!(c?.catraca_id && !catracaAtiva(orgId, c.catraca_id)),
    };
  });
  // Ativos primeiro; dentro deles, quem trouxe lead por último.
  const peso = (f) => (f.status && f.status !== "ACTIVE" ? 1 : 0);
  formularios.sort((a, b) => peso(a) - peso(b) || (b.ultimo_lead_em || b.criado_em || 0) - (a.ultimo_lead_em || a.criado_em || 0));

  return { paginas: paginas.map(p => ({ page_id: p.page_id, nome: p.nome })), formularios, erros };
}

/* Gravar o funil de um formulário. `pipeline_id` vazio volta à regra de
   sempre. Funil e etapa precisam ser DESTA conta e estar ativos — o que chega
   aqui vem do navegador. */
export function definirFunil(orgId, userId, formId, { pipeline_id, stage_id, nome, page_id } = {}) {
  const id = String(formId || "").trim();
  if (!/^[\w-]{1,64}$/.test(id)) throw new ErroFormulario(400, "Formulário inválido.");
  const nomeLimpo = String(nome || "").replace(/\s+/g, " ").trim().slice(0, 160) || null;
  const pagina = page_id ? String(page_id).replace(/[^\d]/g, "").slice(0, 40) || null : null;

  if (!pipeline_id) {
    db.prepare(`INSERT INTO meta_formularios (org_id,form_id,page_id,nome,pipeline_id,stage_id,atualizado_por,atualizado_em)
      VALUES (?,?,?,?,NULL,NULL,?,?) ON CONFLICT(org_id,form_id) DO UPDATE SET pipeline_id = NULL, stage_id = NULL,
      nome = COALESCE(excluded.nome, nome), page_id = COALESCE(excluded.page_id, page_id),
      atualizado_por = excluded.atualizado_por, atualizado_em = excluded.atualizado_em`)
      .run(orgId, id, pagina, nomeLimpo, userId, Date.now());
    return { pipeline_id: null, stage_id: null, entrada: null };
  }

  const p = db.prepare("SELECT id FROM pipelines WHERE id = ? AND org_id = ? AND is_active = 1").get(String(pipeline_id), orgId);
  if (!p) throw new ErroFormulario(400, "Esse funil não existe nesta conta ou está desativado.");
  let etapa = null;
  if (stage_id) {
    etapa = db.prepare("SELECT id FROM pipeline_stages WHERE id = ? AND pipeline_id = ? AND org_id = ? AND is_active = 1")
      .get(String(stage_id), p.id, orgId);
    if (!etapa) throw new ErroFormulario(400, "Essa etapa não é do funil escolhido.");
  }
  const entrada = entradaValida(orgId, p.id, etapa?.id || null);
  if (!entrada) throw new ErroFormulario(400, "Esse funil não tem nenhuma etapa ativa para o lead entrar.");

  db.prepare(`INSERT INTO meta_formularios (org_id,form_id,page_id,nome,pipeline_id,stage_id,atualizado_por,atualizado_em)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(org_id,form_id) DO UPDATE SET pipeline_id = excluded.pipeline_id,
    stage_id = excluded.stage_id, nome = COALESCE(excluded.nome, nome), page_id = COALESCE(excluded.page_id, page_id),
    atualizado_por = excluded.atualizado_por, atualizado_em = excluded.atualizado_em`)
    .run(orgId, id, pagina, nomeLimpo, p.id, etapa?.id || null, userId, Date.now());
  return { pipeline_id: p.id, stage_id: etapa?.id || null, entrada };
}

/* Ligar um formulário a uma catraca de produto (services/catracas.js).
   Vazio volta à regra de sempre (a atendente da vez, catraca principal no
   repasse). Gravado à parte do funil: escolher um não mexe no outro. */
export function definirCatraca(orgId, userId, formId, { catraca_id, nome, page_id } = {}) {
  const id = String(formId || "").trim();
  if (!/^[\w-]{1,64}$/.test(id)) throw new ErroFormulario(400, "Formulário inválido.");
  const nomeLimpo = String(nome || "").replace(/\s+/g, " ").trim().slice(0, 160) || null;
  const pagina = page_id ? String(page_id).replace(/[^\d]/g, "").slice(0, 40) || null : null;
  let catraca = null;
  if (catraca_id) {
    catraca = catracaAtiva(orgId, catraca_id);
    if (!catraca) throw new ErroFormulario(400, "Essa catraca não existe nesta conta ou está desativada.");
  }
  db.prepare(`INSERT INTO meta_formularios (org_id,form_id,page_id,nome,catraca_id,atualizado_por,atualizado_em)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id,form_id) DO UPDATE SET catraca_id = excluded.catraca_id,
    nome = COALESCE(excluded.nome, nome), page_id = COALESCE(excluded.page_id, page_id),
    atualizado_por = excluded.atualizado_por, atualizado_em = excluded.atualizado_em`)
    .run(orgId, id, pagina, nomeLimpo, catraca ? catraca.id : null, userId, Date.now());
  return { catraca_id: catraca ? catraca.id : null };
}
