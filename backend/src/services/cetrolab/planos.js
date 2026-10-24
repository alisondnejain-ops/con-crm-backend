/* OS PLANOS DO CETROLAB (12/10/2026, decisão do Ali: "você define no hub").

   O preço de site não está escrito no código, ao contrário dos planos do
   ConHub: o produto é novo e o preço vai mudar enquanto o mercado responde.
   Quem cadastra é o master, no hub. Enquanto não houver plano cadastrado,
   NADA fica à venda — a ferramenta aparece como "em breve", e o master ainda
   pode liberá-la na mão para uma conta (cortesia, teste).

   Dois públicos, uma tabela:
     - `conhub`: o preço da ferramenta para quem já é cliente do ConHub. UM SÓ
       ativo: é ele que a contratação avulsa cobra (services/recursos.js), e
       dois preços ativos para a mesma ferramenta seriam uma escolha que
       ninguém sabe quem faz.
     - `fora`: os planos de quem vai contratar só o site, sem o CRM. Servidos
       por /publico/cetrolab/planos para a página de venda; a contratação em
       si é a etapa seguinte.

   Este arquivo só conhece o banco: é importado por services/recursos.js, e
   qualquer import a mais aqui viraria um ciclo. */
import { randomUUID } from "crypto";
import db from "../../db.js";

export const PUBLICOS = { conhub: "Clientes do ConHub", fora: "Quem não é cliente (só o site)" };

const formatar = (l) => l && ({
  id: l.id, nome: l.nome, resumo: l.resumo || "", valor_mensal: l.valor_mensal,
  para: l.para, ativo: !!l.ativo, ordem: l.ordem,
});

export const planosCetrolab = ({ soAtivos = false, para = null } = {}) => {
  const where = [], args = [];
  if (soAtivos) where.push("ativo = 1");
  if (para) { where.push("para = ?"); args.push(para); }
  return db.prepare(`SELECT * FROM cetrolab_planos ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY para, ordem, created_at`).all(...args).map(formatar);
};

/* O preço da ferramenta para quem já é cliente. Nulo = não há plano à venda. */
export function planoParaClientes() {
  return planosCetrolab({ soAtivos: true, para: "conhub" })[0] || null;
}
export const precoParaClientes = () => planoParaClientes()?.valor_mensal ?? null;

/* Devolve `{plano}` ou `{erro}` — a frase que o master lê. */
export function salvarPlano(id, b = {}) {
  const atual = id ? db.prepare("SELECT * FROM cetrolab_planos WHERE id = ?").get(id) : null;
  if (id && !atual) return { erro: "Plano não encontrado.", status: 404 };
  const novo = { ...(atual || { ativo: 1, ordem: 0 }) };

  if (b.nome !== undefined || !atual) {
    const nome = String(b.nome || "").replace(/\s+/g, " ").trim();
    if (nome.length < 2 || nome.length > 60) return { erro: "Dê um nome ao plano (2 a 60 letras)." };
    novo.nome = nome;
  }
  if (b.resumo !== undefined) {
    const r = String(b.resumo || "").replace(/\s+/g, " ").trim();
    if (r.length > 240) return { erro: "O resumo passa de 240 letras — é o texto curto do cartão do plano." };
    novo.resumo = r || null;
  }
  if (b.valor_mensal !== undefined || !atual) {
    const v = valorBR(b.valor_mensal);
    if (v == null || v < 1 || v > 100000) return { erro: "Informe o valor por mês, de R$ 1 a R$ 100.000 (ex.: 79 ou 79,90)." };
    novo.valor_mensal = v;
  }
  if (b.para !== undefined || !atual) {
    if (!PUBLICOS[b.para]) return { erro: "Escolha para quem é o plano: clientes do ConHub ou quem vai contratar só o site." };
    novo.para = b.para;
  }
  if (b.ativo !== undefined) novo.ativo = b.ativo ? 1 : 0;
  if (b.ordem !== undefined) novo.ordem = Math.max(0, Math.min(99, parseInt(b.ordem, 10) || 0));

  if (novo.para === "conhub" && novo.ativo) {
    const outro = db.prepare("SELECT nome FROM cetrolab_planos WHERE para = 'conhub' AND ativo = 1 AND id <> ?").get(id || "");
    if (outro) return { erro: `Já existe um preço ativo para clientes do ConHub ("${outro.nome}"). Desative-o antes — a contratação cobra um preço só.`, status: 409 };
  }

  const agora = Date.now();
  if (atual) {
    db.prepare(`UPDATE cetrolab_planos SET nome=?, resumo=?, valor_mensal=?, para=?, ativo=?, ordem=?, atualizado_em=? WHERE id=?`)
      .run(novo.nome, novo.resumo || null, novo.valor_mensal, novo.para, novo.ativo, novo.ordem, agora, id);
  } else {
    id = "cp_" + randomUUID();
    db.prepare(`INSERT INTO cetrolab_planos (id,nome,resumo,valor_mensal,para,ativo,ordem,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, novo.nome, novo.resumo || null, novo.valor_mensal, novo.para, novo.ativo, novo.ordem, agora);
  }
  return { plano: formatar(db.prepare("SELECT * FROM cetrolab_planos WHERE id = ?").get(id)) };
}

/* "79", "79,90", "1.500" ou um número. */
function valorBR(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const t = String(v ?? "").replace(/[R$\s]/g, "");
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/\.(?=\d{3}(\D|$))/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
