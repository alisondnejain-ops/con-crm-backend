/* MODO EMPREENDIMENTO E ESPELHO DE LOTES (11/11/2026, pedido do Ali para a
   Reserva Real do Rio: "ajustar internamente apenas na conta do Reserva todo o
   sistema pra se adequar ao empreendimento").

   A conta que VENDE UM EMPREENDIMENTO não é uma imobiliária: não tem catálogo
   de imóveis de terceiros, plantão nem portais. O que ela tem é um ESPELHO —
   os lotes, a situação de cada um, e os corretores parceiros pedindo reserva
   para os clientes deles. Até aqui isso morava numa planilha do Google (aba
   "Lotes" e aba "Pedidos"), com a reserva vencendo em 24h escrita à mão.

   As regras:
   - O modo liga conta por conta, só pelo master (`orgs.empreendimento`). Nulo
     em toda conta: nada muda para ninguém sem ele ligar.
   - Reservar é de quem atende (corretor e supervisão), e só lote DISPONÍVEL.
     A reserva vence sozinha no prazo da conta (padrão 24h) e o lote volta a
     ficar disponível, com aviso no celular de quem reservou. Quem manda é o
     `vence_em` gravado, não o relógio do batimento: reserva vencida também é
     solta na hora em que alguém lista os lotes.
   - Liberar é de quem reservou ou da supervisão. Vender, bloquear, mudar área,
     preço e observação é só da supervisão — a venda de um lote decide o
     estoque de todos os parceiros.
   - O corretor vê QUE um lote está reservado e por quem, mas o nome do
     cliente só na reserva dele: os parceiros disputam os mesmos lotes, e o
     cliente de um não é informação do outro.
   - Toda mudança fica em `lotes_historico` (quem, quando, de/para).
   - O que a IA do Autoatendimento sabe sai daqui (`textoParaIA`): quais lotes
     estão disponíveis agora e a área de cada um. Preço só vai à IA se a
     gestão ligar (`preco_para_ia`) — valor dito ao cliente é decisão de gente. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { supervisiona, podeVerLead, semMaster } from "../auth.js";
import { avisar } from "./push.js";
import { desligarCanal } from "./canais.js";

export class ErroLote extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export const STATUS = { disponivel: "Disponível", reservado: "Reservado", vendido: "Vendido", bloqueado: "Bloqueado" };
const HORAS_PADRAO = 24;

export function ehEmpreendimento(orgId) {
  return !!db.prepare("SELECT empreendimento FROM orgs WHERE id = ?").get(orgId)?.empreendimento;
}

export function configDoEmpreendimento(orgId) {
  const o = db.prepare("SELECT name, empreendimento, empreendimento_json FROM orgs WHERE id = ?").get(orgId);
  let c = {}; try { c = JSON.parse(o?.empreendimento_json || "{}") || {}; } catch {}
  const horas = Number(c.reserva_horas);
  return {
    ligado: !!o?.empreendimento,
    nome: String(c.nome || o?.name || "").slice(0, 80),
    cidade: String(c.cidade || "").slice(0, 80),
    tour: String(c.tour || "").slice(0, 300),
    reserva_horas: horas >= 1 && horas <= 720 ? Math.round(horas) : HORAS_PADRAO,
    preco_para_ia: !!c.preco_para_ia,
  };
}

const urlOk = (u) => { if (!u) return ""; try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; } };

export function salvarConfig(orgId, dados = {}) {
  const atual = configDoEmpreendimento(orgId);
  const prox = { nome: atual.nome, cidade: atual.cidade, tour: atual.tour, reserva_horas: atual.reserva_horas, preco_para_ia: atual.preco_para_ia };
  if (dados.nome !== undefined) prox.nome = String(dados.nome || "").trim().slice(0, 80);
  if (dados.cidade !== undefined) prox.cidade = String(dados.cidade || "").trim().slice(0, 80);
  if (dados.tour !== undefined) {
    const u = urlOk(String(dados.tour || "").trim());
    if (u === null) throw new ErroLote(400, "O link do tour precisa começar com http:// ou https://.");
    prox.tour = u;
  }
  if (dados.reserva_horas !== undefined) {
    const h = Math.round(Number(dados.reserva_horas));
    if (!(h >= 1 && h <= 720)) throw new ErroLote(400, "O prazo da reserva vai de 1 a 720 horas.");
    prox.reserva_horas = h;
  }
  if (dados.preco_para_ia !== undefined) prox.preco_para_ia = !!dados.preco_para_ia;
  db.prepare("UPDATE orgs SET empreendimento_json = ? WHERE id = ?").run(JSON.stringify(prox), orgId);
  return configDoEmpreendimento(orgId);
}

/* No empreendimento TODO atendimento sai pelo número da casa (pedido do Ali,
   11/11/2026): ligar o modo desliga as linhas pessoais dos corretores — as
   conversas delas voltam para o número da casa, nada é apagado — e tira a
   liberação de número de cada um. As rotas de ligar linha pessoal recusam
   enquanto o modo estiver ligado (canais.routes.js, leads/:id/canal). */
export function ligarModo(orgId, ligado) {
  db.prepare("UPDATE orgs SET empreendimento = ? WHERE id = ?").run(ligado ? 1 : null, orgId);
  if (!ligado) return { linhas_desligadas: 0, conversas_devolvidas: 0 };
  let linhas = 0, conversas = 0;
  for (const c of db.prepare("SELECT id FROM canais WHERE org_id = ? AND tipo = 'corretor' AND ativo = 1").all(orgId)) {
    const r = desligarCanal(c.id); if (!r.erro) { linhas++; conversas += r.devolvidos || 0; }
  }
  db.prepare("UPDATE users SET canal_liberado = 0 WHERE org_id = ?").run(orgId);
  return { linhas_desligadas: linhas, conversas_devolvidas: conversas };
}

export const SO_NUMERO_DA_CASA = "Nesta conta todo atendimento é feito pelo número da imobiliária. Não é possível usar WhatsApp pessoal.";

const registrar = (orgId, lote, acao, para, user, extra = {}) => db.prepare(`INSERT INTO lotes_historico
  (id,org_id,lote_id,acao,de_status,para_status,user_id,lead_id,cliente,obs,em) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  .run(randomUUID(), orgId, lote.id, acao, lote.status, para, user?.id || null, extra.lead_id ?? lote.lead_id ?? null,
    extra.cliente ?? lote.cliente ?? null, extra.obs || null, Date.now());

/* A RESERVA VENCIDA VOLTA A FICAR DISPONÍVEL. Roda no batimento de minuto e
   também antes de listar ou reservar — o `vence_em` é quem manda. */
export function expirarVencidas(orgId = null) {
  const agora = Date.now();
  const vencidas = db.prepare(`SELECT * FROM lotes WHERE status = 'reservado' AND vence_em IS NOT NULL AND vence_em <= ?
    ${orgId ? "AND org_id = ?" : ""}`).all(...(orgId ? [agora, orgId] : [agora]));
  for (const l of vencidas) {
    const r = db.prepare(`UPDATE lotes SET status='disponivel', corretor_id=NULL, lead_id=NULL, cliente=NULL, reservado_em=NULL,
      vence_em=NULL, atualizado_em=? WHERE id = ? AND status = 'reservado' AND vence_em <= ?`).run(agora, l.id, agora);
    if (!r.changes) continue;
    registrar(l.org_id, l, "venceu", "disponivel", null, { obs: "A reserva venceu sem virar venda." });
    if (l.corretor_id) avisar(l.corretor_id, { titulo: `Reserva do lote ${l.codigo} venceu`,
      corpo: `O lote ${l.codigo}${l.cliente ? ` (${l.cliente})` : ""} voltou a ficar disponível para todos.`, leadId: l.lead_id || undefined }).catch(() => {});
  }
  return vencidas.length;
}

const nomes = (orgId) => Object.fromEntries(db.prepare(`SELECT id, name FROM users u WHERE org_id = ? ${semMaster("u")}`).all(orgId).map(u => [u.id, u.name]));

function paraTela(l, user, quem, leads) {
  const meu = l.corretor_id && l.corretor_id === user.id;
  const sup = supervisiona(user);
  const vistoCliente = sup || meu;
  return {
    id: l.id, codigo: l.codigo, quadra: l.quadra, area: l.area, preco: l.preco, status: l.status,
    obs: sup ? (l.obs || null) : null,
    corretor_id: l.corretor_id || null, corretor: l.corretor_id ? (quem[l.corretor_id] || "Corretor") : null,
    cliente: vistoCliente ? (l.cliente || null) : null,
    lead_id: vistoCliente ? (l.lead_id || null) : null,
    lead_nome: vistoCliente && l.lead_id ? (leads[l.lead_id] || null) : null,
    reservado_em: l.reservado_em || null, vence_em: l.vence_em || null, vendido_em: l.vendido_em || null,
    meu, pode_liberar: l.status === "reservado" && (meu || sup),
  };
}

/* Ordem natural: A1, A2 … A10, B1. */
const chaveOrdem = (c) => String(c).replace(/\d+/g, n => n.padStart(6, "0"));

export function listar(orgId, user) {
  expirarVencidas(orgId);
  const lista = db.prepare("SELECT * FROM lotes WHERE org_id = ?").all(orgId)
    .sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || chaveOrdem(a.codigo).localeCompare(chaveOrdem(b.codigo)));
  const quem = nomes(orgId);
  const ids = [...new Set(lista.map(l => l.lead_id).filter(Boolean))];
  const leads = ids.length ? Object.fromEntries(db.prepare(`SELECT id, name FROM leads WHERE org_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .all(orgId, ...ids).map(x => [x.id, x.name])) : {};
  const lotes = lista.map(l => paraTela(l, user, quem, leads));
  const contagem = { total: lotes.length };
  for (const s of Object.keys(STATUS)) contagem[s] = lotes.filter(l => l.status === s).length;
  return { config: configDoEmpreendimento(orgId), lotes, contagem, supervisiona: supervisiona(user) };
}

function loteDaConta(orgId, id) {
  const l = db.prepare("SELECT * FROM lotes WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!l) throw new ErroLote(404, "Lote não encontrado.");
  return l;
}

export function reservar(orgId, user, loteId, { lead_id, cliente, obs } = {}) {
  expirarVencidas(orgId);
  const l = loteDaConta(orgId, loteId);
  if (l.status !== "disponivel") throw new ErroLote(409, l.status === "reservado"
    ? `O lote ${l.codigo} já está reservado${l.corretor_id === user.id ? " por você" : ""}.`
    : `O lote ${l.codigo} não está disponível (${STATUS[l.status] || l.status}).`);
  let lead = null;
  if (lead_id) {
    lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(lead_id, orgId);
    if (!lead || !podeVerLead(user, lead)) throw new ErroLote(403, "Escolha um cliente que está com você.");
  }
  const nomeCliente = String(cliente || lead?.name || "").trim().slice(0, 80);
  if (!nomeCliente) throw new ErroLote(400, "Diga para qual cliente é a reserva.");
  const cfg = configDoEmpreendimento(orgId);
  const agora = Date.now(), vence = agora + cfg.reserva_horas * 3600000;
  const r = db.prepare(`UPDATE lotes SET status='reservado', corretor_id=?, lead_id=?, cliente=?, reservado_em=?, vence_em=?,
    atualizado_em=?, atualizado_por=? WHERE id = ? AND status = 'disponivel'`)
    .run(user.id, lead?.id || null, nomeCliente, agora, vence, agora, user.id, l.id);
  // Dois corretores clicando no mesmo lote ao mesmo tempo: o banco decide quem chegou primeiro.
  if (!r.changes) throw new ErroLote(409, `O lote ${l.codigo} acabou de ser reservado por outra pessoa.`);
  registrar(orgId, l, "reservou", "reservado", user, { lead_id: lead?.id || null, cliente: nomeCliente, obs: String(obs || "").slice(0, 300) || null });
  return { ok: true, vence_em: vence, horas: cfg.reserva_horas };
}

export function liberar(orgId, user, loteId) {
  const l = loteDaConta(orgId, loteId);
  if (l.status !== "reservado") throw new ErroLote(409, `O lote ${l.codigo} não está reservado.`);
  if (l.corretor_id !== user.id && !supervisiona(user)) throw new ErroLote(403, "Só quem reservou ou a gestão libera esta reserva.");
  db.prepare(`UPDATE lotes SET status='disponivel', corretor_id=NULL, lead_id=NULL, cliente=NULL, reservado_em=NULL, vence_em=NULL,
    atualizado_em=?, atualizado_por=? WHERE id = ?`).run(Date.now(), user.id, l.id);
  registrar(orgId, l, "liberou", "disponivel", user);
  if (l.corretor_id && l.corretor_id !== user.id) avisar(l.corretor_id, { titulo: `Reserva do lote ${l.codigo} liberada`,
    corpo: `A gestão liberou a reserva do lote ${l.codigo}${l.cliente ? ` (${l.cliente})` : ""}.` }).catch(() => {});
  return { ok: true };
}

/* Prorrogar é da gestão: o prazo existe para o lote não ficar preso. */
export function prorrogar(orgId, user, loteId, horas) {
  if (!supervisiona(user)) throw new ErroLote(403, "Só a gestão prorroga uma reserva.");
  const l = loteDaConta(orgId, loteId);
  if (l.status !== "reservado") throw new ErroLote(409, `O lote ${l.codigo} não está reservado.`);
  const h = Math.round(Number(horas) || configDoEmpreendimento(orgId).reserva_horas);
  if (!(h >= 1 && h <= 720)) throw new ErroLote(400, "Prorrogue de 1 a 720 horas.");
  const vence = Math.max(Date.now(), l.vence_em || 0) + h * 3600000;
  db.prepare("UPDATE lotes SET vence_em = ?, atualizado_em = ?, atualizado_por = ? WHERE id = ?").run(vence, Date.now(), user.id, l.id);
  registrar(orgId, l, "prorrogou", "reservado", user, { obs: `+${h}h` });
  return { ok: true, vence_em: vence };
}

export function vender(orgId, user, loteId, { lead_id, cliente } = {}) {
  if (!supervisiona(user)) throw new ErroLote(403, "Só a gestão marca um lote como vendido.");
  const l = loteDaConta(orgId, loteId);
  if (l.status === "vendido") throw new ErroLote(409, `O lote ${l.codigo} já está vendido.`);
  let leadId = l.lead_id, nome = l.cliente;
  if (lead_id) {
    const lead = db.prepare("SELECT id, name FROM leads WHERE id = ? AND org_id = ?").get(lead_id, orgId);
    if (!lead) throw new ErroLote(404, "Cliente não encontrado.");
    leadId = lead.id; nome = lead.name;
  }
  if (cliente) nome = String(cliente).trim().slice(0, 80);
  const agora = Date.now();
  db.prepare(`UPDATE lotes SET status='vendido', lead_id=?, cliente=?, vence_em=NULL, vendido_em=?, atualizado_em=?, atualizado_por=? WHERE id = ?`)
    .run(leadId || null, nome || null, agora, agora, user.id, l.id);
  registrar(orgId, l, "vendeu", "vendido", user, { lead_id: leadId || null, cliente: nome || null });
  if (l.corretor_id && l.corretor_id !== user.id) avisar(l.corretor_id, { titulo: `Lote ${l.codigo} vendido`,
    corpo: `O lote ${l.codigo}${nome ? ` (${nome})` : ""} foi marcado como vendido.`, leadId: leadId || undefined }).catch(() => {});
  return { ok: true };
}

/* Edição da gestão: área, preço, observação e a situação na mão (disponível,
   bloqueado, vendido). Voltar um vendido a disponível também passa por aqui. */
export function editar(orgId, user, loteId, dados = {}) {
  if (!supervisiona(user)) throw new ErroLote(403, "Só a gestão edita os lotes.");
  const l = loteDaConta(orgId, loteId);
  const prox = { area: l.area, preco: l.preco, obs: l.obs, status: l.status };
  if (dados.area !== undefined) { const a = numeroBR(dados.area); if (dados.area !== "" && dados.area !== null && a === null) throw new ErroLote(400, "Área inválida."); prox.area = a; }
  if (dados.preco !== undefined) { const p = numeroBR(dados.preco); if (dados.preco !== "" && dados.preco !== null && p === null) throw new ErroLote(400, "Preço inválido."); prox.preco = p; }
  if (dados.obs !== undefined) prox.obs = String(dados.obs || "").trim().slice(0, 300) || null;
  if (dados.status !== undefined) {
    if (!["disponivel", "bloqueado", "vendido"].includes(dados.status)) throw new ErroLote(400, "Situação inválida. Para reservar, use Reservar.");
    prox.status = dados.status;
  }
  const mudouStatus = prox.status !== l.status;
  const solta = mudouStatus && prox.status !== "vendido";
  db.prepare(`UPDATE lotes SET area=?, preco=?, obs=?, status=?, ${solta ? "corretor_id=NULL, lead_id=NULL, cliente=NULL, reservado_em=NULL, vendido_em=NULL," : ""}
    ${mudouStatus && prox.status === "vendido" ? "vendido_em=" + Date.now() + "," : ""} vence_em=CASE WHEN ? = 'reservado' THEN vence_em ELSE NULL END,
    atualizado_em=?, atualizado_por=? WHERE id = ?`)
    .run(prox.area, prox.preco, prox.obs, prox.status, prox.status, Date.now(), user.id, l.id);
  if (mudouStatus) registrar(orgId, l, "editou", prox.status, user);
  return { ok: true };
}

export function historico(orgId, user, loteId) {
  const l = loteDaConta(orgId, loteId);
  const quem = nomes(orgId);
  const sup = supervisiona(user);
  return db.prepare("SELECT * FROM lotes_historico WHERE org_id = ? AND lote_id = ? ORDER BY em DESC LIMIT 50").all(orgId, l.id)
    .map(h => ({ acao: h.acao, de: h.de_status, para: h.para_status, em: h.em, quem: h.user_id ? (quem[h.user_id] || "Alguém") : "Sistema",
      cliente: sup || h.user_id === user.id ? h.cliente : null, obs: h.obs }));
}

/* ===== IMPORTAR (a planilha que já existe) ===== */
function numeroBR(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let t = String(v).replace(/[R$\s]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const statusDe = (t) => {
  const s = semAcento(t);
  if (!s || s.startsWith("dispon") || s === "livre") return "disponivel";
  if (s.startsWith("vend")) return "vendido";
  if (s.startsWith("bloq") || s.startsWith("reserv")) return "bloqueado";
  return null;
};

/* Separa as linhas de um CSV/TSV colado ou de um arquivo, aceitando vírgula
   decimal ("708,15") quando o separador é ponto e vírgula ou tabulação. */
function linhasDe(texto) {
  const linhas = String(texto || "").replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (!linhas.length) return [];
  const cab = linhas[0];
  const sep = cab.includes("\t") ? "\t" : cab.includes(";") ? ";" : ",";
  const partir = (l) => {
    const out = []; let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === sep && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim());
  };
  return linhas.map(partir);
}

export function lerPlanilha(texto) {
  const linhas = linhasDe(texto);
  if (linhas.length < 2) throw new ErroLote(400, "A planilha precisa ter o cabeçalho e ao menos um lote.");
  const cab = linhas[0].map(semAcento);
  const col = (...nomes) => cab.findIndex(c => nomes.some(n => c === n || c.startsWith(n)));
  const iLote = col("lote", "codigo", "unidade"), iQuadra = col("quadra"), iArea = col("area", "metragem"),
    iStatus = col("status", "situacao"), iPreco = col("preco", "valor"), iObs = col("observ", "obs");
  if (iLote < 0) throw new ErroLote(400, "Não achei a coluna \"Lote\" no cabeçalho.");
  const ok = [], fora = [];
  const vistos = new Set();
  linhas.slice(1).forEach((l, n) => {
    // Com separador vírgula, "708,15" vira duas colunas: junta de volta quando a área se partiu.
    let cel = l;
    if (cel.length > cab.length && iArea >= 0 && /^\d+$/.test(cel[iArea] || "") && /^\d{1,2}$/.test(cel[iArea + 1] || ""))
      cel = [...cel.slice(0, iArea), `${cel[iArea]},${cel[iArea + 1]}`, ...cel.slice(iArea + 2)];
    const codigo = String(cel[iLote] || "").trim().toUpperCase().slice(0, 20);
    if (!codigo) return;
    if (vistos.has(codigo)) { fora.push({ linha: n + 2, codigo, motivo: "repetido na planilha" }); return; }
    const status = iStatus >= 0 ? statusDe(cel[iStatus]) : "disponivel";
    if (!status) { fora.push({ linha: n + 2, codigo, motivo: `situação "${cel[iStatus]}" não reconhecida` }); return; }
    vistos.add(codigo);
    ok.push({ codigo, quadra: iQuadra >= 0 ? String(cel[iQuadra] || "").trim().toUpperCase().slice(0, 10) : (codigo.match(/^[A-Z]+/)?.[0] || ""),
      area: iArea >= 0 ? numeroBR(cel[iArea]) : null, preco: iPreco >= 0 ? numeroBR(cel[iPreco]) : null,
      status, obs: iObs >= 0 ? (String(cel[iObs] || "").trim().slice(0, 300) || null) : null });
  });
  return { ok, fora };
}

/* Importa por código: lote novo entra; lote que já existe ganha área, preço e
   observação da planilha. A SITUAÇÃO só muda quando a planilha traz "vendido"
   ou quando o lote está parado (disponível/bloqueado) — reserva em andamento
   não é desfeita por uma planilha antiga. */
export function importar(orgId, user, texto, { previa = false } = {}) {
  if (!supervisiona(user)) throw new ErroLote(403, "Só a gestão importa os lotes.");
  const { ok, fora } = lerPlanilha(texto);
  const existentes = Object.fromEntries(db.prepare("SELECT * FROM lotes WHERE org_id = ?").all(orgId).map(l => [l.codigo, l]));
  const novos = ok.filter(x => !existentes[x.codigo]).length;
  const resumo = { novos, atualizados: ok.length - novos, fora, total: ok.length,
    disponiveis: ok.filter(x => x.status === "disponivel").length, vendidos: ok.filter(x => x.status === "vendido").length };
  if (previa) return { previa: true, ...resumo, exemplos: ok.slice(0, 8) };
  const agora = Date.now();
  const tx = db.transaction(() => {
    ok.forEach((x, i) => {
      const e = existentes[x.codigo];
      if (!e) {
        db.prepare(`INSERT INTO lotes (id,org_id,codigo,quadra,area,preco,status,obs,ordem,vendido_em,atualizado_em,atualizado_por)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), orgId, x.codigo, x.quadra, x.area, x.preco, x.status, x.obs, i,
            x.status === "vendido" ? agora : null, agora, user.id);
        return;
      }
      const trocaStatus = e.status !== x.status && (x.status === "vendido" || e.status === "disponivel" || e.status === "bloqueado");
      db.prepare(`UPDATE lotes SET quadra=?, area=COALESCE(?, area), preco=COALESCE(?, preco), obs=COALESCE(?, obs), ordem=?,
        status=?, vendido_em=CASE WHEN ? = 'vendido' AND vendido_em IS NULL THEN ? ELSE vendido_em END,
        atualizado_em=?, atualizado_por=? WHERE id = ?`)
        .run(x.quadra || e.quadra, x.area, x.preco, x.obs, i, trocaStatus ? x.status : e.status, trocaStatus ? x.status : e.status, agora, agora, user.id, e.id);
      if (trocaStatus) registrar(orgId, e, "importou", x.status, user);
    });
  });
  tx();
  return { ok: true, ...resumo };
}

/* O que a IA do Autoatendimento sabe dos lotes, em texto para o pedido. */
export function textoParaIA(orgId) {
  if (!ehEmpreendimento(orgId)) return "";
  expirarVencidas(orgId);
  const cfg = configDoEmpreendimento(orgId);
  const lotes = db.prepare("SELECT codigo, quadra, area, preco, status FROM lotes WHERE org_id = ?").all(orgId)
    .sort((a, b) => chaveOrdem(a.codigo).localeCompare(chaveOrdem(b.codigo)));
  if (!lotes.length) return "";
  const disp = lotes.filter(l => l.status === "disponivel");
  const m2 = (a) => a == null ? "" : ` (${a.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} m²)`;
  const reais = (p) => p == null ? "" : ` — R$ ${p.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const linhas = disp.map(l => `${l.codigo}${m2(l.area)}${cfg.preco_para_ia ? reais(l.preco) : ""}`);
  const areas = disp.map(l => l.area).filter(a => a != null);
  return [
    `SITUAÇÃO DOS LOTES AGORA (atualizada pelo sistema, vale mais que qualquer outra informação): ${disp.length} disponíveis de ${lotes.length}.`,
    areas.length ? `Áreas dos disponíveis: de ${Math.min(...areas).toLocaleString("pt-BR")} a ${Math.max(...areas).toLocaleString("pt-BR")} m².` : "",
    disp.length ? `Lotes disponíveis: ${linhas.join("; ")}.` : "No momento não há lote disponível — diga que a equipe avisa quando abrir.",
    "Lote reservado ou vendido não está disponível; não ofereça. Quem reserva um lote é o corretor, pelo sistema — você não reserva nem promete lote.",
    cfg.preco_para_ia ? "" : "Valores e condições de pagamento: não informe; diga que o corretor passa.",
    cfg.tour ? `Tour 3D do loteamento: ${cfg.tour}` : "",
  ].filter(Boolean).join("\n");
}
