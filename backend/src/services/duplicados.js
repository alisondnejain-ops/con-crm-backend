/* AVISO DE POSSÍVEL LEAD DUPLICADO (02/11/2026, pedido do Ali depois do Fabian,
   argentino, que apareceu duas vezes na VJ).

   A regra das duas formas do número (services/telefone.js → formasDoTelefone)
   impede que o MESMO celular vire dois leads daqui em diante. Ela não pega o
   que nenhuma regra de número cobre: o número estrangeiro que entrou com o
   código errado, a pessoa que mandou formulário com um número e escreveu de
   outro, e os duplicados que já existiam antes da correção. O CRM não tem
   "juntar leads" — então o que dá para fazer é AVISAR na ficha, com o atalho
   para o outro lead, e deixar quem atende decidir.

   É um aviso, nunca uma ação: nada é juntado, movido ou apagado. E tem o
   "não é a mesma pessoa", que cala o aviso daquele par para sempre — duas
   Marias Silva de verdade não podem ficar com um alerta eterno na ficha.

   Os sinais, do mais forte ao mais fraco:
   - a outra forma do MESMO celular (com/sem o dígito a mais);
   - os mesmos 8 últimos dígitos (o mesmo número com o código do país ou o
     DDD diferente — é o que sobra do número estrangeiro lido errado);
   - o mesmo e-mail;
   - o mesmo nome completo (duas palavras ou mais — "Maria" sozinho não diz
     nada).

   O corretor só vê o que é dele: lead de colega aparece só como contagem
   ("e mais 1 com outra pessoa da equipe"), sem nome nem número. */
import db from "../db.js";
import { formasDoTelefone } from "./telefone.js";
import { chave as chaveDoCelular } from "./unir-leads.js";
import { podeVerLead } from "../auth.js";

db.exec(`CREATE TABLE IF NOT EXISTS leads_nao_duplicados (
  org_id TEXT NOT NULL, lead_a TEXT NOT NULL, lead_b TEXT NOT NULL,
  por TEXT, em INTEGER, PRIMARY KEY (org_id, lead_a, lead_b))`);

const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const NOMES_VAZIOS = new Set(["lead de teste da meta", "titular anonimizado", "cliente", "sem nome", "lead"]);
const chaveDoNome = (nome) => {
  const k = semAcento(nome);
  if (!k || NOMES_VAZIOS.has(k) || /^[\d\s+().-]+$/.test(k)) return null;
  return k.split(" ").filter(p => p.length >= 2).length >= 2 ? k : null;
};
const par = (a, b) => (a < b ? [a, b] : [b, a]);

const MOTIVOS = {
  forma: "mesmo celular, com ou sem o dígito a mais",
  final: "mesmo número com outro código do país ou DDD",
  email: "mesmo e-mail",
  nome: "mesmo nome",
};
const PESO = { forma: 0, final: 1, email: 2, nome: 3 };

export function possiveisDuplicados(user, lead) {
  if (!lead || lead.anonimizado_em) return { itens: [], outros: 0 };
  const digitos = String(lead.phone || "").replace(/\D/g, "");
  const final = digitos.length >= 8 ? digitos.slice(-8) : null;
  const formas = digitos ? formasDoTelefone(digitos).filter(f => f !== digitos) : [];
  const email = String(lead.email || "").trim().toLowerCase() || null;
  const nome = chaveDoNome(lead.name);
  if (!final && !email && !nome) return { itens: [], outros: 0 };

  const conds = [], args = [lead.org_id, lead.id];
  if (final) { conds.push("substr(l.phone, -8) = ?"); args.push(final); }
  /* O mesmo celular escrito de outro jeito (03/11/2026): o argentino com o
     "15" no meio não tem os mesmos 8 finais, mas tem os mesmos 6. A conferência
     de verdade é a do celular lido do jeito certo, logo abaixo. */
  const k = chaveDoCelular(lead.phone);
  if (k) { conds.push("substr(l.phone, -6) = ?"); args.push(k.slice(-6)); }
  if (email) { conds.push("(l.email IS NOT NULL AND LOWER(TRIM(l.email)) = ?)"); args.push(email); }
  if (nome) { conds.push("LOWER(TRIM(l.name)) = LOWER(TRIM(?))"); args.push(lead.name); }
  const candidatos = db.prepare(`SELECT l.id, l.org_id, l.name, l.phone, l.email, l.assigned_to, l.created_at,
      u.name AS dono_nome
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE l.org_id = ? AND l.id <> ? AND l.anonimizado_em IS NULL AND (${conds.join(" OR ")})
    ORDER BY l.created_at DESC LIMIT 50`).all(...args);

  const ignorados = new Set(db.prepare(`SELECT lead_a, lead_b FROM leads_nao_duplicados
    WHERE org_id = ? AND (lead_a = ? OR lead_b = ?)`).all(lead.org_id, lead.id, lead.id)
    .map(r => (r.lead_a === lead.id ? r.lead_b : r.lead_a)));

  const achados = [];
  for (const c of candidatos) {
    if (ignorados.has(c.id)) continue;
    const d = String(c.phone || "").replace(/\D/g, "");
    let motivo = null;
    if (d && (formas.includes(d) || (k && d !== digitos && chaveDoCelular(d) === k))) motivo = "forma";
    else if (final && d && d !== digitos && d.slice(-8) === final) motivo = "final";
    else if (email && String(c.email || "").trim().toLowerCase() === email) motivo = "email";
    else if (nome && chaveDoNome(c.name) === nome) motivo = "nome";
    // O mesmo número exato não aparece aqui: o cadastro já recusa, e se
    // existir é o caso "forma"/"final" de sempre.
    if (!motivo && d && d === digitos) motivo = "final";
    if (motivo) achados.push({ c, motivo });
  }
  achados.sort((a, b) => PESO[a.motivo] - PESO[b.motivo] || b.c.created_at - a.c.created_at);

  const itens = [];
  let outros = 0;
  for (const { c, motivo } of achados) {
    if (!podeVerLead(user, c)) { outros++; continue; }
    if (itens.length >= 5) continue;
    itens.push({ id: c.id, nome: c.name, telefone: c.phone || null, dono: c.dono_nome || null,
      entrou_em: c.created_at, motivo, porque: MOTIVOS[motivo] });
  }
  return { itens, outros };
}

export function marcarNaoDuplicado(user, lead, outroId) {
  const outro = db.prepare("SELECT id, org_id, assigned_to FROM leads WHERE id = ?").get(outroId);
  if (!outro || outro.org_id !== lead.org_id || !podeVerLead(user, outro)) return { erro: "Lead não encontrado.", status: 404 };
  const [a, b] = par(lead.id, outro.id);
  db.prepare(`INSERT OR IGNORE INTO leads_nao_duplicados (org_id, lead_a, lead_b, por, em) VALUES (?,?,?,?,?)`)
    .run(lead.org_id, a, b, user.id, Date.now());
  return { ok: true };
}
