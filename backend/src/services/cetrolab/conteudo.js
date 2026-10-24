/* O CONTEÚDO INSTITUCIONAL DO SITE (12/10/2026).

   O modelo Institucional do Cetrolab mostra o que o catálogo não tem: quem é a
   imobiliária ("Sobre nós"), as redes sociais, a equipe com foto e o que os
   clientes falam. Nada disso é inventado: sem texto, sem pessoa escolhida ou
   sem depoimento, a seção simplesmente não aparece.

   Três regras que valem para a internet:
   - A EQUIPE é escolha da gestão, um por um. Ninguém vai para o site por estar
     cadastrado no CRM — nome e foto de alguém na internet é decisão, não
     consequência. Quem sai da equipe (removido, desativado) some do site
     sozinho, mesmo continuando na lista guardada.
   - Do usuário vai só nome, foto e a função. Nunca e-mail nem telefone: o
     contato é sempre o WhatsApp da imobiliária, com uma mensagem dizendo com
     quem a pessoa quer falar.
   - Rede social só de Instagram, Facebook e YouTube, e só https. O endereço
     vira link na página pública; aceitar qualquer coisa seria deixar o site
     da imobiliária apontar para onde alguém digitou. */
import db from "../../db.js";

const LIMITES = { sobre: 1500, pessoas: 24, depoimentos: 12, nome: 60, texto: 500 };
const REDES = {
  instagram: /^(www\.)?instagram\.com$/i,
  facebook: /^((www|m|pt-br)\.)?(facebook\.com|fb\.com)$/i,
  youtube: /^((www|m)\.)?(youtube\.com|youtu\.be)$/i,
};
const NOMES_REDES = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

const ler = (orgId) => db.prepare("SELECT * FROM cetrolab_conteudo WHERE org_id = ?").get(orgId) || {};
const json = (t, padrao) => { try { const v = JSON.parse(t || ""); return Array.isArray(v) ? v : padrao; } catch { return padrao; } };

// A equipe que PODE ser escolhida: gente ativa da conta, sem o master do ConHub.
function equipeDaConta(orgId) {
  return db.prepare(`SELECT id, name, role, avatar_url FROM users
    WHERE org_id = ? AND status = 'ativo' AND COALESCE(master,0) = 0 ORDER BY name`).all(orgId);
}
const cargoDe = (role) => ({ adm: "Gestão", sdr: "Atendimento", corretor: "Corretor(a)" }[role] || "Equipe");

/* Para a tela do gestor: o que está guardado e quem pode ser escolhido. */
export function conteudoDoSite(orgId) {
  const c = ler(orgId);
  return {
    sobre: c.sobre || "",
    instagram: c.instagram || "", facebook: c.facebook || "", youtube: c.youtube || "",
    equipe: json(c.equipe, []),
    depoimentos: json(c.depoimentos, []),
    pessoas: equipeDaConta(orgId).map(u => ({ id: u.id, nome: u.name, cargo: cargoDe(u.role), tem_foto: !!u.avatar_url })),
  };
}

function rede(campo, valor) {
  const v = String(valor || "").trim();
  if (!v) return { valor: null };
  let u;
  try { u = new URL(v); } catch { return { erro: `O endereço do ${NOMES_REDES[campo]} precisa ser o link completo, começando com https://` }; }
  if (u.protocol !== "https:") return { erro: `O endereço do ${NOMES_REDES[campo]} precisa começar com https://` };
  if (!REDES[campo].test(u.hostname)) return { erro: `Esse não é um endereço do ${NOMES_REDES[campo]}.` };
  return { valor: u.toString() };
}

/* Salva só o que veio no corpo — o resto continua como estava. */
export function salvarConteudo(orgId, b = {}) {
  const atual = ler(orgId);
  const novo = {
    sobre: atual.sobre ?? null, instagram: atual.instagram ?? null, facebook: atual.facebook ?? null,
    youtube: atual.youtube ?? null, equipe: atual.equipe ?? null, depoimentos: atual.depoimentos ?? null,
  };
  if ("sobre" in b) {
    const t = String(b.sobre || "").trim();
    if (t.length > LIMITES.sobre) return { erro: `O texto "Sobre nós" passa de ${LIMITES.sobre} letras (tem ${t.length}).` };
    novo.sobre = t || null;
  }
  for (const campo of Object.keys(REDES)) if (campo in b) {
    const r = rede(campo, b[campo]);
    if (r.erro) return { erro: r.erro };
    novo[campo] = r.valor;
  }
  if ("equipe" in b) {
    const ids = Array.isArray(b.equipe) ? [...new Set(b.equipe.map(String))] : [];
    if (ids.length > LIMITES.pessoas) return { erro: `No máximo ${LIMITES.pessoas} pessoas no site.` };
    const validos = new Set(equipeDaConta(orgId).map(u => u.id));
    const fora = ids.filter(id => !validos.has(id));
    if (fora.length) return { erro: "Só dá para mostrar no site quem está ativo na equipe desta conta." };
    novo.equipe = JSON.stringify(ids);
  }
  if ("depoimentos" in b) {
    const lista = Array.isArray(b.depoimentos) ? b.depoimentos : [];
    if (lista.length > LIMITES.depoimentos) return { erro: `No máximo ${LIMITES.depoimentos} depoimentos.` };
    const limpos = [];
    for (const [n, d] of lista.entries()) {
      const nome = String(d?.nome || "").trim(), texto = String(d?.texto || "").trim();
      if (!nome && !texto) continue;
      if (!nome) return { erro: `O depoimento ${n + 1} está sem o nome de quem falou.` };
      if (nome.length > LIMITES.nome) return { erro: `O nome do depoimento ${n + 1} passa de ${LIMITES.nome} letras.` };
      if (texto.length < 10) return { erro: `O depoimento de ${nome} está curto demais.` };
      if (texto.length > LIMITES.texto) return { erro: `O depoimento de ${nome} passa de ${LIMITES.texto} letras.` };
      limpos.push({ nome, texto });
    }
    novo.depoimentos = JSON.stringify(limpos);
  }
  db.prepare(`INSERT INTO cetrolab_conteudo (org_id, sobre, instagram, facebook, youtube, equipe, depoimentos, atualizado_em)
    VALUES (@org_id, @sobre, @instagram, @facebook, @youtube, @equipe, @depoimentos, @agora)
    ON CONFLICT(org_id) DO UPDATE SET sobre=@sobre, instagram=@instagram, facebook=@facebook, youtube=@youtube,
      equipe=@equipe, depoimentos=@depoimentos, atualizado_em=@agora`).run({ org_id: orgId, ...novo, agora: Date.now() });
  return { conteudo: conteudoDoSite(orgId) };
}

/* Para a página pública: só o que pode ir para a internet. A equipe sai na
   ordem escolhida, e só quem continua ativo. */
export function conteudoPublico(orgId) {
  const c = ler(orgId);
  const ativos = new Map(equipeDaConta(orgId).map(u => [u.id, u]));
  const equipe = json(c.equipe, []).map(id => ativos.get(id)).filter(Boolean)
    .map(u => ({ nome: u.name, cargo: cargoDe(u.role), foto: u.avatar_url || null }));
  return {
    sobre: c.sobre || null,
    redes: { instagram: c.instagram || null, facebook: c.facebook || null, youtube: c.youtube || null },
    equipe,
    depoimentos: json(c.depoimentos, []),
  };
}
