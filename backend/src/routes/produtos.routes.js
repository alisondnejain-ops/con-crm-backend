import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, roles, supervisiona } from "../auth.js";
import { salvar, apagar, tipoPermitido, ehVideo, limiteBytes, modoArmazenamento } from "../services/storage.js";

const r = Router();
r.use(authRequired);

// A Conecta retém 45% da comissão e repassa 55% ao corretor.
export const SPLIT = { imobiliaria: 45, corretor: 55 };
// Quantidade de mídia por tipo de produto, como combinado com a operação.
const LIMITES = { casa: { foto: 10, video: 1 }, terreno: { foto: 4, video: 1 } };

// As três modalidades com que a Conecta trabalha. Antes era só uma caixinha
// "Morar Bem sim/não", que não representava a operação.
export const MODALIDADES = ["Morar Bem PE", "Minha Casa Minha Vida", "SBPE"];
const modalidadeValida = (m) => (m && MODALIDADES.includes(m) ? m : null);

const midiasDe = (id) => db.prepare("SELECT id,tipo,url,ordem FROM produto_midias WHERE produto_id=? ORDER BY tipo DESC, ordem, created_at").all(id);

function comValores(p) {
  if (!p) return p;
  const total = p.valor && p.comissao_pct ? (p.valor * p.comissao_pct) / 100 : null;
  return {
    ...p,
    morar_bem: !!p.morar_bem,   // mantido para não quebrar cadastro antigo
    modalidade: p.modalidade || null,
    midias: midiasDe(p.id),
    comissao: total == null ? null : {
      total, imobiliaria: (total * SPLIT.imobiliaria) / 100, corretor: (total * SPLIT.corretor) / 100,
      split: SPLIT,
    },
  };
}

// Catálogo. Todo mundo consulta — é o ponto do módulo: parar de depender de
// grupo de WhatsApp para saber o que está disponível.
// Filtros: ?q= ?tipo=casa|terreno ?cidade= ?bairro= ?quartos= ?valor_max= ?status=
r.get("/", (req, res) => {
  const { q, tipo, cidade, bairro, quartos, valor_min, valor_max, morar_bem, modalidade, captador, status } = req.query;
  const where = ["p.org_id = ?"], args = [req.user.org_id];

  // Quem não supervisiona só vê o que já foi aprovado — mais o que ele mesmo enviou.
  if (supervisiona(req.user)) { if (status) { where.push("p.status = ?"); args.push(status); } }
  else { where.push("(p.status = 'ativo' OR p.created_by = ?)"); args.push(req.user.id); }

  if (tipo) { where.push("p.tipo = ?"); args.push(tipo); }
  if (cidade) { where.push("p.cidade LIKE ?"); args.push(`%${cidade}%`); }
  if (bairro) { where.push("p.bairro LIKE ?"); args.push(`%${bairro}%`); }
  if (quartos) { where.push("p.quartos >= ?"); args.push(Number(quartos)); }
  if (valor_min) { where.push("p.valor >= ?"); args.push(Number(valor_min)); }
  if (valor_max) { where.push("p.valor <= ?"); args.push(Number(valor_max)); }
  if (modalidade) { where.push("p.modalidade = ?"); args.push(modalidade); }
  // Filtro antigo, de quando só existia Morar Bem: continua funcionando para
  // links salvos por alguém antes da mudança.
  else if (morar_bem === "1") where.push("(p.modalidade = 'Morar Bem PE' OR p.morar_bem = 1)");
  if (captador) { where.push("p.captador_id = ?"); args.push(captador); }
  // Busca livre: cobre título, bairro, cidade, endereço e construtora de uma vez.
  if (q) {
    where.push("(p.titulo LIKE ? OR p.bairro LIKE ? OR p.cidade LIKE ? OR p.endereco LIKE ? OR p.construtor LIKE ?)");
    for (let i = 0; i < 5; i++) args.push(`%${q}%`);
  }

  const rows = db.prepare(`SELECT p.* FROM produtos p WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC`).all(...args);
  res.json(rows.map(comValores));
});

r.get("/opcoes", (req, res) => {
  const lista = (campo) => db.prepare(`SELECT DISTINCT ${campo} v FROM produtos WHERE org_id=? AND ${campo} IS NOT NULL AND ${campo} <> '' ORDER BY ${campo}`)
    .all(req.user.org_id).map(x => x.v);
  res.json({ cidades: lista("cidade"), bairros: lista("bairro"), split: SPLIT, armazenamento: modoArmazenamento() });
});

r.get("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!p) return res.status(404).json({ error: "Produto não encontrado" });
  res.json(comValores(p));
});

const limpar = (v) => (v == null || v === "" ? null : String(v).trim());
// Aceita 285000, "285000", "285.000,50" e "285000.5". Sem tratar o formato
// brasileiro, "285.000" viraria 285 — o JavaScript lê o ponto como decimal.
export function numero(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).trim();
  let normal;
  if (s.includes(",")) {
    // Com vírgula, o ponto só pode ser separador de milhar: "1.250.000,50".
    normal = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // Grupos exatos de 3 dígitos sem vírgula: "285.000" é 285 mil, não 285.
    normal = s.replace(/\./g, "");
  } else {
    normal = s; // "285000" ou "285000.50", já no formato do sistema
  }
  const n = Number(normal);
  return isFinite(n) ? n : null;
}

function validar(b) {
  if (!["casa", "terreno"].includes(b.tipo)) return "Escolha se é casa ou terreno.";
  if (!limpar(b.titulo)) return "Dê um nome ao produto (ex.: Casa 3 quartos no Jardim Amazonas).";
  if (b.tipo === "casa" && !["empreendimento", "solta"].includes(b.formato))
    return "Para casa, informe se é empreendimento ou casa solta.";
  if (!limpar(b.cidade)) return "Informe a cidade.";
  if (b.valor != null && b.valor !== "" && numero(b.valor) == null) return "Valor inválido.";
  if (b.maps_url && !/^https?:\/\//i.test(b.maps_url)) return "O link do Maps precisa começar com https://";
  return null;
}

// Cadastro. Corretor entra como aguardando aprovação; gestor e atendente já
// publicam direto — foi a regra que a operação pediu.
r.post("/", (req, res) => {
  const b = req.body || {};
  const erro = validar(b);
  if (erro) return res.status(400).json({ error: erro });

  const captador = b.captador_id
    ? db.prepare("SELECT id,name FROM users WHERE id=? AND org_id=?").get(b.captador_id, req.user.org_id)
    : { id: req.user.id, name: req.user.name };
  if (!captador) return res.status(404).json({ error: "Captador não encontrado." });

  const id = "p_" + randomUUID();
  db.prepare(`INSERT INTO produtos
    (id,org_id,tipo,titulo,formato,quartos,banheiros,construtor,valor,metragem,cidade,bairro,endereco,
     maps_url,morar_bem,modalidade,comissao_pct,captador_id,captador_nome,observacoes,status,created_by,created_at)
    VALUES (@id,@org_id,@tipo,@titulo,@formato,@quartos,@banheiros,@construtor,@valor,@metragem,@cidade,@bairro,@endereco,
     @maps_url,@morar_bem,@modalidade,@comissao_pct,@captador_id,@captador_nome,@observacoes,@status,@created_by,@created_at)`).run({
    id, org_id: req.user.org_id, tipo: b.tipo, titulo: limpar(b.titulo),
    formato: b.tipo === "casa" ? b.formato : null,
    quartos: numero(b.quartos), banheiros: numero(b.banheiros), construtor: limpar(b.construtor),
    valor: numero(b.valor), metragem: numero(b.metragem),
    cidade: limpar(b.cidade), bairro: limpar(b.bairro), endereco: limpar(b.endereco), maps_url: limpar(b.maps_url),
    modalidade: modalidadeValida(b.modalidade),
    // Espelha a coluna antiga: relatórios e telas velhas continuam somando certo.
    morar_bem: modalidadeValida(b.modalidade) === "Morar Bem PE" ? 1 : 0,
    comissao_pct: numero(b.comissao_pct),
    captador_id: captador.id, captador_nome: captador.name, observacoes: limpar(b.observacoes),
    status: supervisiona(req.user) ? "ativo" : "aguardando_aprovacao",
    created_by: req.user.id, created_at: Date.now(),
  });
  res.json(comValores(db.prepare("SELECT * FROM produtos WHERE id=?").get(id)));
});

// Editar: o dono do cadastro enquanto não foi aprovado, ou quem supervisiona.
function podeEditar(user, p) {
  if (!p) return false;
  return supervisiona(user) || (p.created_by === user.id && p.status !== "vendido");
}

r.patch("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!podeEditar(req.user, p)) return res.status(403).json({ error: "Você não pode editar este produto." });
  const b = { ...p, ...req.body };
  const erro = validar(b);
  if (erro) return res.status(400).json({ error: erro });

  db.prepare(`UPDATE produtos SET tipo=@tipo,titulo=@titulo,formato=@formato,quartos=@quartos,banheiros=@banheiros,
    construtor=@construtor,valor=@valor,metragem=@metragem,cidade=@cidade,bairro=@bairro,endereco=@endereco,
    maps_url=@maps_url,morar_bem=@morar_bem,modalidade=@modalidade,comissao_pct=@comissao_pct,observacoes=@observacoes WHERE id=@id`).run({
    id: p.id, tipo: b.tipo, titulo: limpar(b.titulo), formato: b.tipo === "casa" ? b.formato : null,
    quartos: numero(b.quartos), banheiros: numero(b.banheiros), construtor: limpar(b.construtor),
    valor: numero(b.valor), metragem: numero(b.metragem), cidade: limpar(b.cidade), bairro: limpar(b.bairro),
    endereco: limpar(b.endereco), maps_url: limpar(b.maps_url),
    modalidade: modalidadeValida(b.modalidade),
    morar_bem: modalidadeValida(b.modalidade) === "Morar Bem PE" ? 1 : 0,
    comissao_pct: numero(b.comissao_pct), observacoes: limpar(b.observacoes),
  });
  res.json(comValores(db.prepare("SELECT * FROM produtos WHERE id=?").get(p.id)));
});

// Aprovação do produto enviado por corretor.
r.post("/:id/status", roles("adm", "sdr"), (req, res) => {
  const permitidos = ["ativo", "recusado", "vendido", "inativo"];
  const { status } = req.body || {};
  if (!permitidos.includes(status)) return res.status(400).json({ error: "Situação inválida." });
  const info = db.prepare("UPDATE produtos SET status=? WHERE id=? AND org_id=?").run(status, req.params.id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Produto não encontrado" });
  res.json({ ok: true, status });
});

// Apagar do catálogo é só de gestor e atendente. O corretor pode cadastrar e
// corrigir o que enviou, mas tirar produto do ar é decisão da gestão.
r.delete("/:id", roles("adm", "sdr"), (req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!p) return res.status(404).json({ error: "Produto não encontrado" });
  for (const m of db.prepare("SELECT chave FROM produto_midias WHERE produto_id=?").all(p.id)) apagar(m.chave);
  db.prepare("DELETE FROM produto_midias WHERE produto_id=?").run(p.id);
  db.prepare("DELETE FROM produtos WHERE id=?").run(p.id);
  res.json({ ok: true });
});

// Upload de foto/vídeo. O arquivo chega em base64 para não precisar de biblioteca
// de multipart — simples e suficiente para o volume de uma imobiliária.
r.post("/:id/midias", async (req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!podeEditar(req.user, p)) return res.status(403).json({ error: "Você não pode enviar mídia para este produto." });

  const { mime, base64 } = req.body || {};
  if (!mime || !base64) return res.status(400).json({ error: "Envie o arquivo." });
  if (!tipoPermitido(mime)) return res.status(400).json({ error: "Formato não aceito. Use JPG, PNG, WEBP, MP4 ou MOV." });

  const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  const limite = limiteBytes(mime);
  if (buffer.length > limite)
    return res.status(413).json({ error: `Arquivo muito grande (${(buffer.length / 1048576).toFixed(1)} MB). O limite é ${Math.round(limite / 1048576)} MB.` });

  const tipo = ehVideo(mime) ? "video" : "foto";
  const max = LIMITES[p.tipo][tipo];
  const jaTem = db.prepare("SELECT COUNT(*) n FROM produto_midias WHERE produto_id=? AND tipo=?").get(p.id, tipo).n;
  if (jaTem >= max)
    return res.status(409).json({ error: `Limite de ${max} ${tipo === "foto" ? "fotos" : "vídeo(s)"} por ${p.tipo} atingido.` });

  try {
    const { url, chave } = await salvar({ buffer, mime, prefixo: `produtos/${p.id}` });
    const id = "m_" + randomUUID();
    db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,chave,ordem,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, p.id, tipo, url, chave, jaTem, Date.now());
    res.json({ ok: true, midia: { id, tipo, url }, restantes: max - jaTem - 1 });
  } catch (e) {
    console.error("[produtos] falha ao salvar mídia:", e.message);
    res.status(500).json({ error: "Não consegui guardar o arquivo. Tente de novo." });
  }
});

r.delete("/:id/midias/:midiaId", (req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!podeEditar(req.user, p)) return res.status(403).json({ error: "Sem permissão." });
  const m = db.prepare("SELECT * FROM produto_midias WHERE id=? AND produto_id=?").get(req.params.midiaId, p.id);
  if (!m) return res.status(404).json({ error: "Mídia não encontrada" });
  apagar(m.chave);
  db.prepare("DELETE FROM produto_midias WHERE id=?").run(m.id);
  res.json({ ok: true });
});

export default r;
