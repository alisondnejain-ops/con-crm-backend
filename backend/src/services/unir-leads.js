/* UNIR LEADS DUPLICADOS (03/11/2026, pedido do Ali: os leads da VJ dos últimos
   dois dias apareceram em dobro).

   A causa achada: número argentino escrito do jeito local no formulário
   ("0381 15 477-9714") era gravado como veio, e quando o cliente escrevia pelo
   WhatsApp (54 9 381 4779714) nascia outra cópia. A leitura foi corrigida em
   services/telefone.js → argentinaNacional; o que já entrou em dobro sai daqui.

   QUEM É PAR: leads da mesma conta cujo número, lido do jeito certo, é o MESMO
   celular (`chave`) — inclusive a forma com e sem o dígito a mais. Só número:
   nome e e-mail iguais avisam na ficha, mas juntar em lote por nome juntaria
   duas Marias Silva. O par marcado como "não é a mesma pessoa" fica de fora.

   QUEM FICA ("principal"): o que tem venda registrada; senão o que recebeu a
   mensagem mais recente do cliente pelo WhatsApp (é o número que o WhatsApp
   usa, e é nele que a próxima mensagem vai cair); senão o mais antigo. O
   telefone que fica é o da cópia por onde o cliente escreveu por último.

   O QUE ACONTECE: tudo que pende das outras cópias (conversa, ligações,
   tarefas, observações, etiquetas, histórico) passa para o principal; o que o
   principal não tem preenchido é completado com o das outras; a origem (o
   anúncio, a campanha) é a de quem entrou primeiro; a data de entrada é a mais
   antiga; e as outras cópias são apagadas. ANTES de apagar, a linha inteira de
   cada uma vai para `leads_unidos` — a junção não tem botão de desfazer, mas
   não é cega: o que sumiu continua guardado. */
import { randomUUID } from "crypto";
import db from "../db.js";
import { argentinaNacional } from "./telefone.js";

db.exec(`CREATE TABLE IF NOT EXISTS leads_unidos (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  removido_id TEXT NOT NULL, removido_json TEXT NOT NULL, por TEXT, em INTEGER NOT NULL)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_unidos ON leads_unidos(org_id, em)");

/* O celular, escrito de um jeito só, para comparar: o argentino com 9 e sem
   0/15, o brasileiro com o nono dígito, o mexicano sem o 1. Nulo quando não é
   número de verdade (curto demais). */
export function chave(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length < 8) return null;
  if (d.startsWith("54")) { const ar = argentinaNacional(d.slice(2)); if (ar) return "54" + ar; }
  if (/^55\d{2}[6-9]\d{7}$/.test(d)) return d.slice(0, 4) + "9" + d.slice(4);
  if (/^521\d{10}$/.test(d)) return "52" + d.slice(3);
  return d;
}

const NOME_VAZIO = (n) => !n || /^[\d\s+().-]+$/.test(String(n)) || /^(sem nome|lead|cliente)$/i.test(String(n).trim());
const vazio = (v) => v == null || v === "";

// Colunas que a junção nunca copia de uma cópia para o principal.
const NAO_COPIA = new Set(["id", "org_id", "versao", "phone", "anonimizado_em", "anonimizado_por",
  "created_at", "first_resp_at", "last_interaction_at", "closed_at", "canal_id", "name",
  "qual_json", "custom_fields", "stage", "stage_id", "pipeline_id", "stage_entered_at"]);
// A origem do lead anda junta: vem inteira de quem entrou primeiro.
const ORIGEM = ["source", "origem", "platform", "campaign_name", "campaign_id", "adset_name", "adset_id",
  "ad_name", "ad_id", "form_name", "form_id", "meta_lead_id", "import_id"];

function infoDosLeads(ids) {
  if (!ids.length) return new Map();
  const ph = ids.map(() => "?").join(",");
  const linhas = db.prepare(`SELECT lead_id,
      COUNT(*) AS msgs,
      MAX(CASE WHEN direction = 'in' THEN created_at END) AS ultima_in
    FROM messages WHERE lead_id IN (${ph}) GROUP BY lead_id`).all(...ids);
  return new Map(linhas.map(l => [l.lead_id, l]));
}

function escolherPrincipal(membros, info) {
  const comVenda = membros.filter(m => m.sale_date || m.sale_value);
  if (comVenda.length) return [...comVenda].sort((a, b) => a.created_at - b.created_at)[0];
  const comMsg = membros.filter(m => info.get(m.id)?.ultima_in);
  if (comMsg.length) return [...comMsg].sort((a, b) => info.get(b.id).ultima_in - info.get(a.id).ultima_in)[0];
  return [...membros].sort((a, b) => a.created_at - b.created_at)[0];
}

// O telefone que fica: o da cópia por onde o cliente escreveu por último.
function telefoneQueFica(membros, info, principal) {
  const comMsg = membros.filter(m => info.get(m.id)?.ultima_in && m.phone);
  if (comMsg.length) return [...comMsg].sort((a, b) => info.get(b.id).ultima_in - info.get(a.id).ultima_in)[0];
  return principal;
}

/* A lista de grupos repetidos da conta, para a prévia. `desdeDias` limita aos
   grupos em que alguma cópia entrou nesses dias (nulo = todos). */
export function gruposDuplicados(orgId, { desdeDias = null } = {}) {
  const leads = db.prepare(`SELECT l.id, l.name, l.phone, l.email, l.created_at, l.assigned_to, l.sale_date,
      l.sale_value, l.stage, l.source, l.closed_at, u.name AS dono
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE l.org_id = ? AND l.anonimizado_em IS NULL AND l.phone IS NOT NULL AND l.phone <> ''`).all(orgId);
  const porChave = new Map();
  for (const l of leads) {
    const k = chave(l.phone);
    if (!k) continue;
    if (!porChave.has(k)) porChave.set(k, []);
    porChave.get(k).push(l);
  }
  const naoE = db.prepare("SELECT lead_a, lead_b FROM leads_nao_duplicados WHERE org_id = ?").all(orgId)
    .map(r => r.lead_a + "|" + r.lead_b);
  const marcadoNaoE = (a, b) => naoE.includes(a < b ? a + "|" + b : b + "|" + a);
  const corte = desdeDias ? Date.now() - desdeDias * 86400000 : 0;

  const grupos = [];
  for (const [k, membros0] of porChave) {
    if (membros0.length < 2) continue;
    // Quem foi marcado "não é a mesma pessoa" com alguém do grupo sai dele.
    const membros = membros0.filter(m => !membros0.some(o => o.id !== m.id && marcadoNaoE(m.id, o.id)));
    if (membros.length < 2) continue;
    if (corte && !membros.some(m => m.created_at >= corte)) continue;
    const info = infoDosLeads(membros.map(m => m.id));
    const principal = escolherPrincipal(membros, info);
    const doFone = telefoneQueFica(membros, info, principal);
    // A prévia diz o que a junção grava de verdade (ver unirGrupo).
    const fone = info.get(doFone.id)?.ultima_in ? doFone.phone : (chave(doFone.phone) || doFone.phone);
    const nomeFinal = NOME_VAZIO(principal.name) ? (membros.find(m => !NOME_VAZIO(m.name))?.name || principal.name) : principal.name;
    const ordenados = [principal, ...membros.filter(m => m.id !== principal.id)];
    grupos.push({
      chave: k,
      principal_id: principal.id,
      telefone_final: fone,
      nome_final: nomeFinal,
      leads: ordenados.map(m => ({
        id: m.id, nome: m.name, telefone: m.phone, dono: m.dono || null, entrou_em: m.created_at,
        etapa: m.stage, origem: m.source || null, venda: !!(m.sale_date || m.sale_value),
        mensagens: info.get(m.id)?.msgs || 0, ultima_do_cliente: info.get(m.id)?.ultima_in || null,
      })),
    });
  }
  grupos.sort((a, b) => Math.max(...b.leads.map(l => l.entrou_em)) - Math.max(...a.leads.map(l => l.entrou_em)));
  return { grupos, leads_em_dobro: grupos.reduce((s, g) => s + g.leads.length - 1, 0) };
}

function mesclarJson(a, b) {
  let x = {}, y = {};
  try { x = a ? JSON.parse(a) : {}; } catch { x = {}; }
  try { y = b ? JSON.parse(b) : {}; } catch { y = {}; }
  if (!x || typeof x !== "object") x = {};
  if (!y || typeof y !== "object") return a;
  for (const [k, v] of Object.entries(y)) if (vazio(x[k]) && !vazio(v)) x[k] = v;
  return Object.keys(x).length ? JSON.stringify(x) : a;
}

const posicao = db.prepare("SELECT ordem, pipeline_id, status_type FROM pipeline_stages WHERE id = ?");

/* Une um grupo: `principalId` fica, `outrosIds` são juntados a ele e apagados.
   Tudo numa transação: ou junta inteiro, ou nada muda. */
export function unirGrupo(orgId, userId, principalId, outrosIds) {
  const outrosLista = [...new Set((outrosIds || []).map(String))].filter(id => id !== principalId);
  if (!outrosLista.length) return { erro: "Nada para unir." };
  const ler = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ? AND anonimizado_em IS NULL");
  const p0 = ler.get(principalId, orgId);
  if (!p0) return { erro: "Lead principal não encontrado.", status: 404 };
  const outros = outrosLista.map(id => ler.get(id, orgId));
  if (outros.some(o => !o)) return { erro: "Algum dos leads não foi encontrado (já unido ou apagado?).", status: 404 };

  const membros = [p0, ...outros];
  const info = infoDosLeads(membros.map(m => m.id));
  const doTelefone = telefoneQueFica(membros, info, p0);
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name)
    .filter(t => !["leads", "leads_apagados", "leads_unidos"].includes(t))
    .filter(t => db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === "lead_id"));
  const colunas = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
  let movidas = 0;

  db.transaction(() => {
    const p = { ...p0 };
    const maisAntigo = [...membros].sort((a, b) => a.created_at - b.created_at)[0];
    for (const o of outros) {
      for (const c of colunas) if (!NAO_COPIA.has(c) && vazio(p[c]) && !vazio(o[c])) p[c] = o[c];
      if (NOME_VAZIO(p.name) && !NOME_VAZIO(o.name)) p.name = o.name;
      p.qual_json = mesclarJson(p.qual_json, o.qual_json);
      p.custom_fields = mesclarJson(p.custom_fields, o.custom_fields);
      // A etapa: a de quem tem venda; senão a mais adiantada no mesmo funil.
      const ep = p.stage_id ? posicao.get(p.stage_id) : null, eo = o.stage_id ? posicao.get(o.stage_id) : null;
      const levaEtapa = (!p.sale_date && o.sale_date) || (!ep && eo) || (!p.stage && !p.stage_id && o.stage)
        || (ep && eo && ep.pipeline_id === eo.pipeline_id && ep.status_type === "aberto" && (eo.ordem ?? 0) > (ep.ordem ?? 0));
      if (levaEtapa && (o.stage || o.stage_id)) {
        p.stage = o.stage; p.stage_id = o.stage_id; p.pipeline_id = o.pipeline_id; p.stage_entered_at = o.stage_entered_at;
      }
    }
    if (maisAntigo.id !== p0.id) for (const c of ORIGEM) if (colunas.includes(c)) p[c] = maisAntigo[c];
    p.created_at = Math.min(...membros.map(m => m.created_at || Date.now()));
    const fr = membros.map(m => m.first_resp_at).filter(Boolean);
    p.first_resp_at = fr.length ? Math.min(...fr) : null;
    const ul = membros.map(m => m.last_interaction_at).filter(Boolean);
    p.last_interaction_at = ul.length ? Math.max(...ul) : p0.last_interaction_at;
    p.closed_at = membros.some(m => !m.closed_at) ? null : Math.max(...membros.map(m => m.closed_at));
    p.phone = doTelefone.phone || p0.phone;
    // Ninguém escreveu pelo WhatsApp ainda: fica o número escrito do jeito certo.
    if (!info.get(doTelefone.id)?.ultima_in) p.phone = chave(p.phone) || p.phone;
    p.canal_id = doTelefone.canal_id ?? p0.canal_id;

    for (const o of outros) {
      db.prepare(`INSERT INTO leads_unidos (id, org_id, principal_id, removido_id, removido_json, por, em)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), orgId, p0.id, o.id, JSON.stringify(o), userId || null, Date.now());
      for (const t of tabelas) {
        movidas += db.prepare(`UPDATE OR IGNORE "${t}" SET lead_id = ? WHERE lead_id = ?`).run(p0.id, o.id).changes;
        // O que sobrou bateu numa trava de "um por lead" — é a mesma coisa em dobro.
        db.prepare(`DELETE FROM "${t}" WHERE lead_id = ?`).run(o.id);
      }
      db.prepare("DELETE FROM leads_nao_duplicados WHERE org_id = ? AND (lead_a = ? OR lead_b = ?)").run(orgId, o.id, o.id);
      db.prepare("DELETE FROM leads WHERE id = ?").run(o.id);
    }

    const mudar = colunas.filter(c => !["id", "org_id", "versao"].includes(c) && p[c] !== p0[c]);
    if (mudar.length)
      db.prepare(`UPDATE leads SET ${mudar.map(c => `"${c}" = ?`).join(", ")} WHERE id = ?`)
        .run(...mudar.map(c => p[c]), p0.id);

    const lista = outros.map(o => `“${o.name || "sem nome"}” (${o.phone || "sem número"}, entrou em ${new Date(o.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })})`).join("; ");
    db.prepare("INSERT INTO observacoes (id, org_id, lead_id, texto, autor_id, created_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), orgId, p0.id, `Leads unidos: este lead estava em dobro e foi juntado com ${lista}. A conversa e o histórico das cópias estão aqui.`, userId || null, Date.now());
  })();

  return { ok: true, principal_id: p0.id, unidos: outros.length, registros_movidos: movidas };
}

// Une vários grupos; cada um na própria transação — um que falhe não desfaz os outros.
export function unirGrupos(orgId, userId, grupos) {
  const lista = Array.isArray(grupos) ? grupos.slice(0, 500) : [];
  let unidos = 0, gruposOk = 0;
  const falhas = [];
  for (const g of lista) {
    try {
      const r = unirGrupo(orgId, userId, String(g?.principal || ""), g?.outros);
      if (r.erro) falhas.push({ principal: g?.principal, motivo: r.erro });
      else { unidos += r.unidos; gruposOk++; }
    } catch (e) {
      falhas.push({ principal: g?.principal, motivo: e.message });
    }
  }
  return { ok: true, grupos: gruposOk, unidos, falhas };
}
