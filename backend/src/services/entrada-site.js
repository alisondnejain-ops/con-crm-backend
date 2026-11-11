/* O FORMULÁRIO DO SITE DA IMOBILIÁRIA (11/11/2026, pedido do Ali para a
   landing page do Reserva Real do Rio).

   A landing manda o lead em POST /publico/leads com
   "Authorization: Bearer <token>". O token diz EM QUAL CONTA o lead entra —
   ele não é segredo: o navegador da pessoa o envia, e ele aparece no código da
   página. Quem segura o abuso é o limite por IP e por conta, a lista de sites
   permitidos (vale dentro de navegador) e o botão de gerar outro token.

   O lead entra pelo MESMO caminho do formulário da Meta e dos portais
   (`receberLead`): mesmo telefone ou e-mail = o mesmo lead, que ganha uma
   observação nova (nunca um segundo lead); catraca do canal "site"; funil;
   gatilhos dos fluxos; aviso no celular. */
import { randomBytes } from "crypto";
import db from "../db.js";
import { receberLead } from "./portais.js";
import { gravarCampos } from "./campos-lead.js";
import { normalizarPeloPadrao, validarTelefone } from "./telefone.js";
import { paisDaOrg } from "./pais-da-org.js";
import { etapaDeEntrada } from "./catracas.js";

const novoToken = () => "lp_" + randomBytes(24).toString("base64url");

const ORIGEM_OK = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
export function limparOrigem(o) {
  const t = String(o || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!t) return null;
  try {
    const u = new URL(t);
    const base = `${u.protocol}//${u.host}`;
    return ORIGEM_OK.test(base) ? base : null;
  } catch { return null; }
}

function linha(orgId) {
  return db.prepare("SELECT * FROM entrada_site WHERE org_id = ?").get(orgId) || null;
}

const lista = (t) => { try { const v = JSON.parse(t || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

export function configDaEntrada(orgId) {
  const c = linha(orgId);
  if (!c) return { existe: false, ativo: false, token: null, origens: [], quem_recebe: "corretor", pipeline_id: null, stage_id: null };
  return {
    existe: true, ativo: !!c.ativo, token: c.token, origens: lista(c.origens),
    quem_recebe: c.quem_recebe === "regra" ? "regra" : "corretor",
    pipeline_id: c.pipeline_id || null, stage_id: c.stage_id || null,
    ultimo_em: c.ultimo_em || null, ultimo_resultado: c.ultimo_resultado || null,
  };
}

/* Gera o token (ou troca: o anterior para na hora). */
export function gerarToken(orgId) {
  const agora = Date.now();
  const token = novoToken();
  if (linha(orgId)) db.prepare("UPDATE entrada_site SET token = ?, atualizado_em = ? WHERE org_id = ?").run(token, agora, orgId);
  else db.prepare("INSERT INTO entrada_site (org_id,token,ativo,origens,quem_recebe,criado_em,atualizado_em) VALUES (?,?,1,'[]','corretor',?,?)")
    .run(orgId, token, agora, agora);
  cacheOrigens = null;
  return configDaEntrada(orgId);
}

export class ErroEntrada extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

export function salvarConfig(orgId, b = {}) {
  if (!linha(orgId)) gerarToken(orgId);
  const atual = configDaEntrada(orgId);
  let origens = atual.origens;
  if (b.origens !== undefined) {
    if (!Array.isArray(b.origens)) throw new ErroEntrada("Lista de sites inválida.");
    const limpas = [];
    for (const o of b.origens.slice(0, 10)) {
      if (!String(o || "").trim()) continue;
      const l = limparOrigem(o);
      if (!l) throw new ErroEntrada(`"${String(o).slice(0, 80)}" não é um endereço de site (exemplo: https://meusite.com.br).`);
      if (!limpas.includes(l)) limpas.push(l);
    }
    origens = limpas;
  }
  const quem = b.quem_recebe === undefined ? atual.quem_recebe : (b.quem_recebe === "regra" ? "regra" : "corretor");
  let pipeline = atual.pipeline_id, stage = atual.stage_id;
  if (b.stage_id !== undefined) {
    if (!b.stage_id) { pipeline = null; stage = null; }
    else {
      const e = etapaDeEntrada(orgId, String(b.stage_id));
      if (!e) throw new ErroEntrada("A etapa escolhida não existe nesta conta ou está desativada.");
      pipeline = e.pipeline_id; stage = e.stage_id;
    }
  }
  const ativo = b.ativo === undefined ? atual.ativo : !!b.ativo;
  db.prepare("UPDATE entrada_site SET origens = ?, quem_recebe = ?, pipeline_id = ?, stage_id = ?, ativo = ?, atualizado_em = ? WHERE org_id = ?")
    .run(JSON.stringify(origens), quem, pipeline, stage, ativo ? 1 : 0, Date.now(), orgId);
  cacheOrigens = null;
  return configDaEntrada(orgId);
}

/* Todos os sites permitidos, de todas as contas: é o que o preflight (que
   não leva o token) pode conferir. Guardado 60s. */
let cacheOrigens = null, cacheEm = 0;
export function origemPermitidaEmAlguma(origem) {
  const o = limparOrigem(origem);
  if (!o) return false;
  if (!cacheOrigens || Date.now() - cacheEm > 60000) {
    cacheOrigens = new Set();
    for (const r of db.prepare("SELECT origens FROM entrada_site WHERE ativo = 1").all()) for (const x of lista(r.origens)) cacheOrigens.add(x);
    cacheEm = Date.now();
  }
  return cacheOrigens.has(o);
}

export function contaDoToken(token) {
  const t = String(token || "").trim();
  if (!t || t.length > 200) return null;
  const c = db.prepare("SELECT org_id, ativo FROM entrada_site WHERE token = ?").get(t);
  return c || null;
}

/* Liga a resposta do formulário ao campo personalizado da conta, quando ele
   existe: no Reserva o pacote criou "Motivo da compra", "Forma de pagamento"
   e "Prazo de compra". Valor fora das opções é pulado (fica na observação). */
const CAMPOS_DAS_RESPOSTAS = {
  objetivo: ["motivo_da_compra", "objetivo"],
  pagamento: ["forma_de_pagamento", "pagamento"],
  prazo: ["prazo_de_compra", "prazo"],
  visita: ["visita", "quer_visitar"],
};
const TEMPERATURAS = { quente: "QUENTE", morno: "MORNO", frio: "FRIO" };
const sim = (v) => v === true || /^(sim|s|true|1|yes|aceito|on)$/i.test(String(v ?? "").trim());
const texto = (v, n = 300) => (v == null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, n);

export function receberDoSite(orgId, b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new ErroEntrada("O corpo precisa ser um JSON.");
  const nome = texto(b.nome, 120);
  const telBruto = texto(b.telefone, 40);
  if (!nome) throw new ErroEntrada("Informe o nome.");
  if (!telBruto) throw new ErroEntrada("Informe o telefone.");
  if (!sim(b.consentimento_lgpd))
    throw new ErroEntrada("Sem o consentimento (consentimento_lgpd) o contato não pode ser guardado.", 422);

  const pais = paisDaOrg(orgId);
  const telefone = normalizarPeloPadrao(telBruto, pais);
  const erroTel = validarTelefone(telefone);
  if (erroTel) throw new ErroEntrada(`Telefone inválido. ${erroTel}`, 422);

  const temperatura = TEMPERATURAS[texto(b.temperatura, 20).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")] || null;
  const origem = texto(b.origem, 80) || "Site";
  const utm = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) { const x = texto(b[k], 200); if (x) utm[k] = x; }

  const rotulos = [
    ["Empreendimento", b.empreendimento], ["Cidade", b.cidade], ["Objetivo", b.objetivo], ["Pagamento", b.pagamento],
    ["Prazo", b.prazo], ["Visita", b.visita], ["Temperatura informada", b.temperatura],
  ].filter(([, x]) => texto(x));
  const obs = texto(b.observacao, 1000);
  const linhas = [
    `Veio do formulário do site${texto(b.empreendimento) ? ` (${texto(b.empreendimento, 120)})` : ""} — origem: ${origem}.`,
    rotulos.length ? `Respostas do formulário:\n${rotulos.map(([k, x]) => `• ${k}: ${texto(x)}`).join("\n")}` : null,
    obs ? `Observação do cliente: "${obs}"` : null,
    Object.keys(utm).length ? `Campanha (UTM): ${Object.entries(utm).map(([k, x]) => `${k}=${x}`).join(" · ")}` : null,
    texto(b.pagina, 300) ? `Página: ${texto(b.pagina, 300)}` : null,
    `Consentimento LGPD: sim${texto(b.data_hora, 40) ? ` (enviado em ${texto(b.data_hora, 40)})` : ""}.`,
  ].filter(Boolean).join("\n");

  const cfg = configDaEntrada(orgId);
  const r = receberLead(orgId, {
    portal: "site", externo: "", nome, email: "", telefone, mensagem: "", codigo: "",
    canal: { canal: "site", ref: "" },
    rodizio: cfg.quem_recebe === "corretor",
    entrada: cfg.stage_id || null,
    source: "site", origem, origemGatilho: "site", texto: linhas,
  });
  if (!r.ok) throw new ErroEntrada(r.erro || "Não deu para registrar o lead.", r.status || 400);

  const lead = db.prepare("SELECT id, priority, priority_por, campaign_name, custom_fields FROM leads WHERE id = ?").get(r.lead_id);
  // Temperatura: entra sem apagar a que uma pessoa colocou na mão.
  if (temperatura && lead.priority_por !== "mao")
    db.prepare("UPDATE leads SET priority = ?, priority_por = 'formulario', priority_em = ? WHERE id = ?").run(temperatura, Date.now(), lead.id);
  if (utm.utm_campaign && !lead.campaign_name)
    db.prepare("UPDATE leads SET campaign_name = ?, platform = COALESCE(platform, ?) WHERE id = ?").run(utm.utm_campaign, utm.utm_source ? utm.utm_source.slice(0, 20).toLowerCase() : null, lead.id);
  // Respostas nos campos da conta — no lead que já existia, só o que está vazio.
  const chaves = new Set(db.prepare("SELECT key FROM custom_fields WHERE org_id = ? AND is_active = 1").all(orgId).map(c => c.key));
  let atuais = {}; try { atuais = JSON.parse(lead.custom_fields || "{}") || {}; } catch {}
  const valores = {};
  for (const [campo, opcoes] of Object.entries(CAMPOS_DAS_RESPOSTAS)) {
    const x = texto(b[campo], 200);
    const chave = opcoes.find(k => chaves.has(k));
    if (x && chave && (r.novo || atuais[chave] == null || atuais[chave] === "")) valores[chave] = x;
  }
  if (Object.keys(valores).length) { try { gravarCampos(orgId, lead.id, valores, { estrito: false }); } catch {} }

  db.prepare("UPDATE entrada_site SET ultimo_em = ?, ultimo_resultado = ? WHERE org_id = ?")
    .run(Date.now(), r.novo ? "lead novo" : "lead existente atualizado", orgId);
  return { lead_id: r.lead_id, novo: !!r.novo, responsavel: r.assigned_to ? true : false };
}
