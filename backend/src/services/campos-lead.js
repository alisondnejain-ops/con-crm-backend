/* GRAVAR OS CAMPOS PERSONALIZADOS DE UM LEAD (08/10/2026).

   Saiu da rota `PATCH /leads/:id/campos` para um lugar só porque agora são
   três caminhos que preenchem campo: a ficha, a IA do Autoatendimento
   (durante a conversa) e o gatilho dos fluxos "campo preenchido com valor",
   que precisa nascer de QUALQUER um dos dois. Regra escrita duas vezes
   diverge — a tipagem (número recusa texto, seleção recusa opção que não
   existe) e o disparo da automação moram aqui.

   Não decide permissão: quem chama já conferiu quem pode mexer no lead. */
import db from "../db.js";
import { dispararGatilho } from "./automacoes.js";

export class ErroCampo extends Error { constructor(m) { super(m); this.status = 400; } }

const opcoesDe = (def) => { try { return JSON.parse(def.options || "[]"); } catch { return []; } };

/* `valores` = { chave: valor }. Vazio apaga. Chave que não é campo ativo da
   conta é ignorada. Devolve { campos, preenchidos } — `preenchidos` são as
   chaves que passaram a ter um valor diferente do que tinham. */
export function gravarCampos(orgId, leadId, valores, { estrito = true } = {}) {
  const lead = db.prepare("SELECT id, custom_fields FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) throw new ErroCampo("Lead não encontrado.");
  const porChave = new Map(db.prepare("SELECT key, name, type, options FROM custom_fields WHERE org_id = ? AND is_active = 1")
    .all(orgId).map(d => [d.key, d]));
  const campos = JSON.parse(lead.custom_fields || "{}");
  const antes = JSON.stringify(campos);
  const anterior = { ...campos };
  const ignorados = [];
  for (const chave of Object.keys(valores || {})) {
    const def = porChave.get(chave);
    if (!def) { ignorados.push(chave); continue; }
    const bruto = valores[chave];
    const opcoes = opcoesDe(def);
    if (bruto === "" || bruto === null || bruto === undefined || (Array.isArray(bruto) && !bruto.length)) {
      delete campos[chave];
      continue;
    }
    // `estrito` falso (a IA): valor que não serve é pulado em vez de recusar tudo.
    const recusar = (m) => { if (estrito) throw new ErroCampo(m); ignorados.push(chave); };
    if (def.type === "number" || def.type === "currency") {
      const t = String(bruto).trim();
      const n = typeof bruto === "number" ? bruto : Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
      if (!Number.isFinite(n)) { recusar(`"${chave}" precisa ser um número.`); continue; }
      campos[chave] = n;
    } else if (def.type === "boolean") {
      campos[chave] = typeof bruto === "string" ? /^(sim|s|true|1|yes)$/i.test(bruto.trim()) : !!bruto;
    } else if (def.type === "multiselect") {
      const v = (Array.isArray(bruto) ? bruto : [bruto]).map(String).map(x => opcoes.find(o => normal(o) === normal(x)) || x).filter(x => opcoes.includes(x));
      if (v.length) campos[chave] = v; else delete campos[chave];
    } else if (def.type === "select") {
      const o = opcoes.find(x => normal(x) === normal(bruto));
      if (!o) { recusar(`"${chave}" precisa ser uma das opções.`); continue; }
      campos[chave] = o;
    } else {
      campos[chave] = String(bruto).trim().slice(0, 200);
    }
  }
  if (JSON.stringify(campos) !== antes)
    db.prepare("UPDATE leads SET custom_fields = ? WHERE id = ?").run(JSON.stringify(campos), lead.id);
  const preenchidos = Object.keys(campos).filter(k => JSON.stringify(campos[k]) !== JSON.stringify(anterior[k]));
  // O gatilho "campo preenchido" (services/automacoes.js): um evento por campo que mudou.
  for (const k of preenchidos) dispararGatilho(orgId, "campo", { leadId: lead.id, ref: k, valor: campos[k] });
  return { campos, preenchidos, ignorados };
}

export const normal = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/* O valor de um campo casa com o esperado? Esperado vazio = "está
   preenchido". Lista (multiselect) casa se tiver a opção; sim/não pelo texto. */
export function campoCasa(valor, esperado) {
  const vazio = valor === undefined || valor === null || valor === "" || (Array.isArray(valor) && !valor.length);
  if (!String(esperado ?? "").trim()) return !vazio;
  if (vazio) return false;
  const e = normal(esperado);
  if (Array.isArray(valor)) return valor.some(v => normal(v) === e);
  if (typeof valor === "boolean") return valor === /^(sim|s|true|1|yes)$/i.test(e);
  if (typeof valor === "number") return Number(String(esperado).replace(",", ".")) === valor;
  return normal(valor) === e;
}
