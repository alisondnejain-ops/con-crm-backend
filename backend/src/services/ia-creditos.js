/* ===== CRÉDITOS DE IA POR CONTA (07/11/2026) =====

   Pedido do Ali: "que o consumo de token seja controlado pelo gestor, ele
   contrata mais token e segue fazendo os atendimentos para a conta dele".
   Decisões dele: pacotes em REAIS, e quando o crédito acaba a IA PARA e o
   gestor é avisado.

   O QUE GASTA CRÉDITO: só o AGENTE — o Autoatendimento respondendo o cliente
   (`atendimento`), o bloco "Chamar a IA" dos fluxos (`fluxo_ia`) e o
   aprendizado depois de cada atendimento (`aprendizado`). Resumo, leitura de
   etapa/temperatura, rascunho de mensagem e o assistente Claude continuam
   como estavam (cada um com o próprio teto do mês): não são o agente que o
   gestor contrata.

   COMO SE COBRA: cada chamada do agente já tem o custo em dólar gravado em
   `ia_uso` (services/iauso.js). O débito é esse custo × câmbio × margem, os
   dois definidos pelo master no hub. O saldo é guardado em MILIONÉSIMOS de
   real (`ia_saldo_micro`): uma resposta custa centavos ou frações de
   centavo, e arredondar cada uma para cima cobraria o triplo do combinado.

   QUEM ENTRA NISSO: a conta em que o master LIGOU (`orgs.ia_creditos_ligado`).
   Desligado é como sempre foi — o ConHub paga a IA. É o que impede esta
   versão de calar o Autoatendimento de todas as contas que já usam, com
   saldo zero, no minuto em que sobe.

   O SALDO PODE FICAR UM POUCO NEGATIVO: o custo de uma resposta só se sabe
   depois que a IA respondeu, e a resposta que já saiu não volta. A próxima é
   que não sai. A compra seguinte cobre a diferença. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { avisar as push } from "./push.js";
import { sendMail } from "./mail.js";
import { semMaster } from "../auth.js";

export const RECURSOS_DO_AGENTE = new Set(["atendimento", "fluxo_ia", "aprendizado"]);
const MICRO = 1e6;

/* ===== O BANCO ===== */
const cols = db.prepare("PRAGMA table_info(orgs)").all().map(c => c.name);
const addOrg = (n, d) => { if (!cols.includes(n)) db.exec(`ALTER TABLE orgs ADD COLUMN ${n} ${d}`); };
addOrg("ia_creditos_ligado", "INTEGER");
addOrg("ia_saldo_micro", "INTEGER DEFAULT 0");
addOrg("ia_aviso_baixo_em", "INTEGER");
addOrg("ia_aviso_zero_em", "INTEGER");
const colsUso = db.prepare("PRAGMA table_info(ia_uso)").all().map(c => c.name);
if (!colsUso.includes("debito_micro")) db.exec("ALTER TABLE ia_uso ADD COLUMN debito_micro INTEGER");
db.exec(`CREATE TABLE IF NOT EXISTS ia_creditos_mov (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tipo TEXT NOT NULL,            -- compra | ajuste | estorno
  micro INTEGER NOT NULL,        -- com sinal, em milionésimos de real
  valor REAL,                    -- o que foi cobrado (compra), em reais
  descricao TEXT,
  provedor TEXT, cobranca_id TEXT, pedido_id TEXT, url TEXT,
  status TEXT NOT NULL,          -- pendente | pago | cancelado | estornado | feito
  criado_por TEXT, criado_em INTEGER NOT NULL, pago_em INTEGER
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_iacred_org ON ia_creditos_mov(org_id, criado_em)");
db.exec("CREATE INDEX IF NOT EXISTS idx_iacred_cobr ON ia_creditos_mov(provedor, cobranca_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_iacred_ped ON ia_creditos_mov(pedido_id)");

/* ===== O PREÇO (do master) ===== */
const PADRAO = { cambio: 5.6, margem: 3, pacotes: [50, 100, 200, 500], aviso_baixo: 10 };
export function configDosCreditos() {
  try {
    const v = db.prepare("SELECT valor FROM config_plataforma WHERE chave = 'ia_creditos_config'").get();
    const c = v ? JSON.parse(v.valor) : {};
    return {
      cambio: Number(c.cambio) > 0 ? Number(c.cambio) : PADRAO.cambio,
      margem: Number(c.margem) > 0 ? Number(c.margem) : PADRAO.margem,
      pacotes: Array.isArray(c.pacotes) && c.pacotes.length ? c.pacotes.map(Number).filter(x => x >= 5) : PADRAO.pacotes,
      aviso_baixo: Number(c.aviso_baixo) >= 0 ? Number(c.aviso_baixo) : PADRAO.aviso_baixo,
    };
  } catch { return { ...PADRAO }; }
}
export function salvarConfigDosCreditos({ cambio, margem, pacotes, aviso_baixo }) {
  const atual = configDosCreditos();
  const num = (v, min, max, nome) => {
    if (v === undefined) return undefined;
    const n = Number(String(v).replace(",", "."));
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${nome}: use um número entre ${min} e ${max}.`);
    return n;
  };
  const novo = { ...atual };
  const c = num(cambio, 1, 20, "Câmbio"); if (c !== undefined) novo.cambio = c;
  const m = num(margem, 1, 20, "Margem"); if (m !== undefined) novo.margem = m;
  const a = num(aviso_baixo, 0, 10000, "Aviso de saldo baixo"); if (a !== undefined) novo.aviso_baixo = a;
  if (pacotes !== undefined) {
    const lista = (Array.isArray(pacotes) ? pacotes : String(pacotes).split(/[;,\s]+/))
      .map(x => Number(String(x).replace(",", "."))).filter(x => Number.isFinite(x));
    if (!lista.length || lista.length > 6 || lista.some(x => x < 5 || x > 10000))
      throw new Error("Pacotes: de 1 a 6 valores, cada um entre R$ 5 e R$ 10.000.");
    novo.pacotes = [...new Set(lista.map(x => Math.round(x * 100) / 100))].sort((a, b) => a - b);
  }
  db.prepare("INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES ('ia_creditos_config', ?, ?)")
    .run(JSON.stringify(novo), Date.now());
  return novo;
}

/* ===== O SALDO ===== */
const orgDe = (orgId) => db.prepare("SELECT id, name, ia_creditos_ligado, ia_saldo_micro FROM orgs WHERE id = ?").get(orgId) || null;
export const usaCreditos = (orgId) => !!orgDe(orgId)?.ia_creditos_ligado;
export const saldoReais = (orgId) => (orgDe(orgId)?.ia_saldo_micro || 0) / MICRO;

/* A pergunta que trava o agente: esta conta pode gastar IA agora? */
export function temCredito(orgId) {
  const o = orgDe(orgId);
  if (!o || !o.ia_creditos_ligado) return true;
  return (o.ia_saldo_micro || 0) > 0;
}

/* Quanto custa (em micro-reais) uma chamada que custou `usd` dólares. */
export function precoMicro(usd) {
  const c = configDosCreditos();
  return Math.ceil(Math.max(0, Number(usd) || 0) * c.cambio * c.margem * MICRO);
}

/* Debita o agente. Chamado por iauso.registrar logo depois de gravar o uso.
   Nunca lança. Devolve o débito em micro (0 quando a conta não usa crédito). */
export function debitarAgente(orgId, recurso, usd) {
  try {
    if (!RECURSOS_DO_AGENTE.has(recurso) || !usaCreditos(orgId)) return 0;
    const micro = precoMicro(usd);
    if (!micro) return 0;
    const antes = orgDe(orgId).ia_saldo_micro || 0;
    db.prepare("UPDATE orgs SET ia_saldo_micro = COALESCE(ia_saldo_micro,0) - ? WHERE id = ?").run(micro, orgId);
    conferirAvisos(orgId, antes, antes - micro);
    return micro;
  } catch (e) {
    console.error("[ia-creditos] débito falhou:", e.message);
    return 0;
  }
}

function gestoresDa(orgId) {
  const org = db.prepare("SELECT dono_user_id, tipo FROM orgs WHERE id = ?").get(orgId) || {};
  const lista = db.prepare(`SELECT u.id, u.name, u.email FROM users u WHERE u.org_id = ? AND u.status = 'ativo'
    AND (u.role = 'adm' OR u.id = ?)${semMaster("u")}`).all(orgId, org.tipo === "autonomo" ? org.dono_user_id || "" : "");
  return lista;
}

/* O aviso de saldo baixo e o de saldo zerado saem UMA VEZ cada; a compra
   seguinte rearma os dois. */
function conferirAvisos(orgId, antes, depois) {
  const c = configDosCreditos();
  const baixo = Math.round(c.aviso_baixo * MICRO);
  const o = db.prepare("SELECT name, ia_aviso_baixo_em, ia_aviso_zero_em FROM orgs WHERE id = ?").get(orgId);
  if (!o) return;
  if (depois <= 0 && antes > 0 && !o.ia_aviso_zero_em) {
    db.prepare("UPDATE orgs SET ia_aviso_zero_em = ? WHERE id = ?").run(Date.now(), orgId);
    avisarGestores(orgId, "O crédito de IA acabou",
      "O Autoatendimento parou de responder os clientes. Compre mais crédito em Configurações → Autoatendimento para ele voltar.");
  } else if (depois > 0 && depois <= baixo && antes > baixo && !o.ia_aviso_baixo_em) {
    db.prepare("UPDATE orgs SET ia_aviso_baixo_em = ? WHERE id = ?").run(Date.now(), orgId);
    avisarGestores(orgId, "O crédito de IA está acabando",
      `Restam ${fmtReais(depois / MICRO)} de crédito. Quando acabar, o Autoatendimento para. Compre mais em Configurações → Autoatendimento.`);
  }
}

export const fmtReais = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function avisarGestores(orgId, titulo, corpo) {
  for (const g of gestoresDa(orgId)) {
    push(g.id, { titulo, corpo }).catch(() => {});
    if (g.email) sendMail({ to: g.email, subject: `ConHub — ${titulo}`,
      html: `<p>Olá, ${String(g.name || "").split(" ")[0]}!</p><p>${corpo}</p>` }).catch(() => {});
  }
  console.log(`[ia-creditos] ${titulo} (${orgId})`);
}

/* ===== ENTRADAS: compra paga, estorno, ajuste do master ===== */
function creditar(orgId, micro) {
  db.prepare("UPDATE orgs SET ia_saldo_micro = COALESCE(ia_saldo_micro,0) + ?, ia_aviso_baixo_em = NULL, ia_aviso_zero_em = NULL WHERE id = ?")
    .run(micro, orgId);
}

export function novaCompra({ orgId, valor, provedor, quem }) {
  const id = "icr_" + randomUUID();
  db.prepare(`INSERT INTO ia_creditos_mov (id,org_id,tipo,micro,valor,descricao,provedor,status,criado_por,criado_em)
    VALUES (?,?,'compra',?,?,?,?,'pendente',?,?)`)
    .run(id, orgId, Math.round(valor * MICRO), valor, `Crédito de IA ${fmtReais(valor)}`, provedor, quem || null, Date.now());
  return id;
}
export const marcarCobranca = (id, { cobrancaId = null, pedidoId = null, url = null }) =>
  db.prepare("UPDATE ia_creditos_mov SET cobranca_id = ?, pedido_id = ?, url = ? WHERE id = ?").run(cobrancaId, pedidoId, url, id);
export const compraPorCobranca = (provedor, cobrancaId) => cobrancaId
  ? db.prepare("SELECT * FROM ia_creditos_mov WHERE tipo = 'compra' AND provedor = ? AND cobranca_id = ?").get(provedor, String(cobrancaId)) || null : null;
export const compraPorPedido = (pedidoId) => pedidoId
  ? db.prepare("SELECT * FROM ia_creditos_mov WHERE tipo = 'compra' AND pedido_id = ?").get(String(pedidoId)) || null : null;

/* Paga: credita o valor do PACOTE gravado na compra (o valor do aviso pode
   vir com juros ou taxa). Idempotente: a mesma compra não credita duas vezes. */
export function confirmarCompra(mov) {
  if (!mov || mov.status === "pago") return false;
  const r = db.prepare("UPDATE ia_creditos_mov SET status = 'pago', pago_em = ? WHERE id = ? AND status <> 'pago'").run(Date.now(), mov.id);
  if (!r.changes) return false;
  creditar(mov.org_id, mov.micro);
  console.log(`[ia-creditos] compra paga: ${fmtReais(mov.valor)} (${mov.org_id})`);
  return true;
}
export function estornarCompra(mov) {
  if (!mov || mov.status !== "pago") return false;
  db.prepare("UPDATE ia_creditos_mov SET status = 'estornado' WHERE id = ?").run(mov.id);
  db.prepare("UPDATE orgs SET ia_saldo_micro = COALESCE(ia_saldo_micro,0) - ? WHERE id = ?").run(mov.micro, mov.org_id);
  return true;
}
export function cancelarCompra(mov) {
  if (!mov || mov.status !== "pendente") return false;
  db.prepare("UPDATE ia_creditos_mov SET status = 'cancelado' WHERE id = ?").run(mov.id);
  return true;
}

/* O master liga/desliga a conta e lança cortesia ou correção. */
export function ajustarPeloMaster(orgId, { ligado, reais, motivo, quem }) {
  if (ligado !== undefined) db.prepare("UPDATE orgs SET ia_creditos_ligado = ? WHERE id = ?").run(ligado ? 1 : 0, orgId);
  if (reais !== undefined && reais !== null && reais !== "") {
    const v = Number(String(reais).replace(",", "."));
    if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 100000) throw new Error("Informe um valor em reais (ex.: 50 ou -10).");
    const micro = Math.round(v * MICRO);
    db.prepare(`INSERT INTO ia_creditos_mov (id,org_id,tipo,micro,valor,descricao,status,criado_por,criado_em,pago_em)
      VALUES (?,?,'ajuste',?,?,?,'feito',?,?,?)`).run("icr_" + randomUUID(), orgId, micro, v,
      String(motivo || (v > 0 ? "Crédito do ConHub" : "Correção do ConHub")).slice(0, 120), quem || null, Date.now(), Date.now());
    if (v > 0) creditar(orgId, micro);
    else db.prepare("UPDATE orgs SET ia_saldo_micro = COALESCE(ia_saldo_micro,0) + ? WHERE id = ?").run(micro, orgId);
  }
  return situacaoDosCreditos(orgId);
}

/* ===== O QUE A TELA MOSTRA ===== */
export function situacaoDosCreditos(orgId) {
  const o = orgDe(orgId);
  if (!o) return null;
  const desde = Date.now() - 30 * 86400000;
  const gasto = db.prepare(`SELECT COALESCE(SUM(debito_micro),0) m, COUNT(*) n FROM ia_uso
    WHERE org_id = ? AND created_at >= ? AND debito_micro > 0`).get(orgId, desde);
  const porRecurso = db.prepare(`SELECT recurso, COALESCE(SUM(debito_micro),0) m, COUNT(*) n FROM ia_uso
    WHERE org_id = ? AND created_at >= ? AND debito_micro > 0 GROUP BY recurso`).all(orgId, desde)
    .map(r => ({ recurso: r.recurso, reais: r.m / MICRO, vezes: r.n }));
  const c = configDosCreditos();
  return {
    ligado: !!o.ia_creditos_ligado,
    saldo: (o.ia_saldo_micro || 0) / MICRO,
    acabou: !!o.ia_creditos_ligado && (o.ia_saldo_micro || 0) <= 0,
    baixo: !!o.ia_creditos_ligado && (o.ia_saldo_micro || 0) > 0 && (o.ia_saldo_micro || 0) <= c.aviso_baixo * MICRO,
    gasto_30d: gasto.m / MICRO, respostas_30d: gasto.n, por_recurso: porRecurso,
    pacotes: c.pacotes,
    movimentos: db.prepare(`SELECT id, tipo, valor, descricao, provedor, status, url, criado_em, pago_em FROM ia_creditos_mov
      WHERE org_id = ? ORDER BY criado_em DESC LIMIT 12`).all(orgId),
  };
}
