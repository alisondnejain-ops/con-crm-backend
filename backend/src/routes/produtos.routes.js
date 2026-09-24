import express, { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, roles, supervisiona } from "../auth.js";
import { salvar, apagar, tipoPermitido, ehVideo, limiteBytes, modoArmazenamento, LIMITE_VIDEO_MB, limiteVideoBinario } from "../services/storage.js";
import { garantirH264 } from "../services/video.js";
import { pendencias } from "../services/portais.js";
import { caminhoDoImovel } from "../services/site.js";

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
  const midias = midiasDe(p.id);
  return {
    ...p,
    morar_bem: !!p.morar_bem,   // mantido para não quebrar cadastro antigo
    modalidade: p.modalidade || null,
    publicar_portais: !!p.publicar_portais,
    midias,
    // O formulário mostra o que falta para ir ao portal com a MESMA regra que
    // decide o feed — uma cópia no navegador divergiria na primeira mudança.
    portal: pendencias(p, midias.filter(m => m.tipo === "foto").map(m => m.url)),
    // Endereço da página do imóvel no site da imobiliária — null com o site desligado.
    site_path: caminhoDoImovel(p.org_id, p),
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
  const { q, tipo, finalidade, cidade, bairro, quartos, valor_min, valor_max, morar_bem, modalidade, captador, status } = req.query;
  const where = ["p.org_id = ?"], args = [req.user.org_id];

  // Quem não supervisiona só vê o que já foi aprovado — mais o que ele mesmo enviou.
  if (supervisiona(req.user)) { if (status) { where.push("p.status = ?"); args.push(status); } }
  else { where.push("(p.status = 'ativo' OR p.created_by = ?)"); args.push(req.user.id); }

  if (tipo) { where.push("p.tipo = ?"); args.push(tipo); }
  if (finalidade) { where.push("p.finalidade = ?"); args.push(finalidade); }
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

/* Campos do ANÚNCIO nos portais. Gravados por uma função só, chamada no
   cadastro e na edição — são 14 colunas, e repeti-las nos dois SQL grandes
   de baixo seria o jeito de uma delas ficar esquecida em um dos lados. */
const EXIBIR_ENDERECO = ["bairro", "rua", "completo"];
/* `publicar_portais` só muda por quem supervisiona: pôr um anúncio na internet
   é decisão da gestão. O corretor que capta edita o resto do anúncio. */
function gravarCamposPortal(id, b, user, anterior = 0) {
  const cep = limpar(b.cep) && String(b.cep).replace(/\D/g, "");
  db.prepare(`UPDATE produtos SET publicar_portais=@publicar_portais, descricao=@descricao, uf=@uf, cep=@cep,
    numero_end=@numero_end, complemento=@complemento, latitude=@latitude, longitude=@longitude, vagas=@vagas,
    suites=@suites, area_util=@area_util, condominio=@condominio, iptu=@iptu, exibir_endereco=@exibir_endereco,
    atualizado_em=@atualizado_em WHERE id=@id`).run({
    id, publicar_portais: supervisiona(user) ? (b.publicar_portais ? 1 : 0) : (anterior ? 1 : 0), descricao: limpar(b.descricao),
    uf: limpar(b.uf) ? String(b.uf).trim().toUpperCase() : null, cep: cep || null,
    numero_end: limpar(b.numero_end), complemento: limpar(b.complemento),
    latitude: numero(b.latitude), longitude: numero(b.longitude),
    vagas: numero(b.vagas), suites: numero(b.suites), area_util: numero(b.area_util),
    condominio: numero(b.condominio), iptu: numero(b.iptu),
    exibir_endereco: EXIBIR_ENDERECO.includes(b.exibir_endereco) ? b.exibir_endereco : "bairro",
    atualizado_em: Date.now(),
  });
}

function validar(b) {
  if (!["casa", "terreno"].includes(b.tipo)) return "Escolha se é casa ou terreno.";
  if (b.finalidade && !["venda", "aluguel"].includes(b.finalidade)) return "Escolha se é venda ou aluguel.";
  if (!limpar(b.titulo)) return "Dê um nome ao produto (ex.: Casa 3 quartos no Jardim Amazonas).";
  if (b.tipo === "casa" && !["empreendimento", "solta"].includes(b.formato))
    return "Para casa, informe se é empreendimento ou casa solta.";
  if (!limpar(b.cidade)) return "Informe a cidade.";
  if (b.valor != null && b.valor !== "" && numero(b.valor) == null) return "Valor inválido.";
  if (b.maps_url && !/^https?:\/\//i.test(b.maps_url)) return "O link do Maps precisa começar com https://";
  if (limpar(b.uf) && !/^[A-Za-z]{2}$/.test(String(b.uf).trim())) return "Estado (UF) são duas letras, ex.: PE.";
  if (limpar(b.cep) && String(b.cep).replace(/\D/g, "").length !== 8) return "O CEP tem 8 números.";
  if (limpar(b.descricao) && String(b.descricao).trim().length > 3000) return "A descrição do anúncio passa de 3000 caracteres — os portais cortam o resto.";
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
    (id,org_id,tipo,finalidade,titulo,formato,quartos,banheiros,construtor,valor,metragem,cidade,bairro,endereco,
     maps_url,morar_bem,modalidade,comissao_pct,captador_id,captador_nome,observacoes,status,created_by,created_at)
    VALUES (@id,@org_id,@tipo,@finalidade,@titulo,@formato,@quartos,@banheiros,@construtor,@valor,@metragem,@cidade,@bairro,@endereco,
     @maps_url,@morar_bem,@modalidade,@comissao_pct,@captador_id,@captador_nome,@observacoes,@status,@created_by,@created_at)`).run({
    id, org_id: req.user.org_id, tipo: b.tipo, finalidade: b.finalidade === "aluguel" ? "aluguel" : "venda", titulo: limpar(b.titulo),
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
  gravarCamposPortal(id, b, req.user);
  res.json(comValores(db.prepare("SELECT * FROM produtos WHERE id=?").get(id)));
});

// Situações terminais: o negócio fechou, de um jeito ou de outro — não
// existe "vendido" para um imóvel anunciado como aluguel, nem o contrário.
const FECHADO = new Set(["vendido", "alugado"]);

// Editar: o dono do cadastro enquanto não foi aprovado, ou quem supervisiona.
function podeEditar(user, p) {
  if (!p) return false;
  return supervisiona(user) || (p.created_by === user.id && !FECHADO.has(p.status));
}

r.patch("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!podeEditar(req.user, p)) return res.status(403).json({ error: "Você não pode editar este produto." });
  const b = { ...p, ...req.body };
  const erro = validar(b);
  if (erro) return res.status(400).json({ error: erro });

  // Transferir a captação: o UPDATE não gravava captador nenhum, então trocar o
  // "Quem captou" na edição não fazia efeito — a tela salvava e o banco ignorava.
  // Vale para a equipe inteira, gestor incluído: ele também capta imóvel.
  let captador = { id: p.captador_id, nome: p.captador_nome };
  if (req.body.captador_id && req.body.captador_id !== p.captador_id) {
    const u = db.prepare("SELECT id,name FROM users WHERE id=? AND org_id=?").get(req.body.captador_id, req.user.org_id);
    if (!u) return res.status(404).json({ error: "Captador não encontrado." });
    captador = { id: u.id, nome: u.name };
  }

  db.prepare(`UPDATE produtos SET tipo=@tipo,finalidade=@finalidade,titulo=@titulo,formato=@formato,quartos=@quartos,banheiros=@banheiros,
    construtor=@construtor,valor=@valor,metragem=@metragem,cidade=@cidade,bairro=@bairro,endereco=@endereco,
    maps_url=@maps_url,morar_bem=@morar_bem,modalidade=@modalidade,comissao_pct=@comissao_pct,
    captador_id=@captador_id,captador_nome=@captador_nome,observacoes=@observacoes WHERE id=@id`).run({
    captador_id: captador.id, captador_nome: captador.nome,
    id: p.id, tipo: b.tipo, finalidade: b.finalidade === "aluguel" ? "aluguel" : "venda",
    titulo: limpar(b.titulo), formato: b.tipo === "casa" ? b.formato : null,
    quartos: numero(b.quartos), banheiros: numero(b.banheiros), construtor: limpar(b.construtor),
    valor: numero(b.valor), metragem: numero(b.metragem), cidade: limpar(b.cidade), bairro: limpar(b.bairro),
    endereco: limpar(b.endereco), maps_url: limpar(b.maps_url),
    modalidade: modalidadeValida(b.modalidade),
    morar_bem: modalidadeValida(b.modalidade) === "Morar Bem PE" ? 1 : 0,
    comissao_pct: numero(b.comissao_pct), observacoes: limpar(b.observacoes),
  });
  gravarCamposPortal(p.id, b, req.user, p.publicar_portais);
  res.json(comValores(db.prepare("SELECT * FROM produtos WHERE id=?").get(p.id)));
});

// Aprovação do produto enviado por corretor.
r.post("/:id/status", roles("adm", "sdr"), (req, res) => {
  const permitidos = ["ativo", "recusado", "vendido", "alugado", "inativo"];
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

/* Confere produto + permissão + teto de mídia por tipo — usada pelas duas
   rotas de upload (foto/áudio em base64 e vídeo binário). Regra escrita duas
   vezes diverge (já custou caro neste projeto antes); ficou num lugar só.
   Devolve `null` depois de já ter respondido o erro. */
function podeReceberMidia(req, res, tipo) {
  const p = db.prepare("SELECT * FROM produtos WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  // Produto inexistente dava "sem permissão", que mandava procurar o erro no
  // lugar errado. São coisas diferentes e a mensagem tem que dizer qual é.
  if (!p) { res.status(404).json({ error: "Imóvel não encontrado. Salve o cadastro antes de enviar as fotos." }); return null; }
  if (!podeEditar(req.user, p)) { res.status(403).json({ error: "Você não pode enviar mídia para este produto." }); return null; }
  const max = LIMITES[p.tipo][tipo];
  const jaTem = db.prepare("SELECT COUNT(*) n FROM produto_midias WHERE produto_id=? AND tipo=?").get(p.id, tipo).n;
  if (jaTem >= max) {
    res.status(409).json({ error: `Limite de ${max} ${tipo === "foto" ? "fotos" : "vídeo(s)"} por ${p.tipo} atingido.` });
    return null;
  }
  return { p, jaTem, max };
}

function gravarMidia({ p, jaTem, max, tipo, url, chave }) {
  const id = "m_" + randomUUID();
  db.prepare("INSERT INTO produto_midias (id,produto_id,tipo,url,chave,ordem,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, p.id, tipo, url, chave, jaTem, Date.now());
  return { ok: true, midia: { id, tipo, url }, restantes: max - jaTem - 1 };
}

// Upload de foto (e, historicamente, vídeo pequeno). O arquivo chega em
// base64 para não precisar de biblioteca de multipart — simples e suficiente
// para foto. Vídeo tem rota própria, logo abaixo — ver o comentário dela.
r.post("/:id/midias", async (req, res) => {
  const { mime, base64 } = req.body || {};
  if (!mime || !base64) return res.status(400).json({ error: "Envie o arquivo." });
  if (!tipoPermitido(mime)) return res.status(400).json({ error: "Formato não aceito. Use JPG, PNG, WEBP, MP4 ou MOV." });

  const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  const limite = limiteBytes(mime);
  if (buffer.length > limite)
    return res.status(413).json({ error: `Arquivo muito grande (${(buffer.length / 1048576).toFixed(1)} MB). O limite é ${Math.round(limite / 1048576)} MB.` });

  const tipo = ehVideo(mime) ? "video" : "foto";
  const alvo = podeReceberMidia(req, res, tipo);
  if (!alvo) return;

  try {
    const { url, chave } = await salvar({ buffer, mime, prefixo: `produtos/${alvo.p.id}` });
    res.json(gravarMidia({ ...alvo, tipo, url, chave }));
  } catch (e) {
    /* "Tente de novo" não ajuda ninguém: se a causa é armazenamento mal
       configurado, tentar de novo dá o mesmo erro para sempre. Devolvemos o
       motivo real — quem lê é o gestor, não o cliente final. */
    console.error("[produtos] falha ao salvar mídia:", e.message);
    res.status(500).json({ error: "Não consegui guardar o arquivo: " + e.message,
      onde: modoArmazenamento() });
  }
});

/* VÍDEO DE IMÓVEL, à parte — travado em 30 MB e sem converter HEVC até
   23/09/2026 (achado ao investigar "vídeo não carrega na sessão de
   imóveis"). Esta rota nasceu junto com a de conversa
   (`POST /leads/:id/anexo/video`, `messages.routes.js`) mas o upload de
   PRODUTO ficou parado no desenho antigo: base64 dentro do JSON, preso ao
   teto de `limiteBytes()` (30 MB) pensado para foto/áudio de conversa — e
   vídeo de celular hoje passa disso com frequência. O corretor selecionava
   um vídeo de 60-150 MB, o navegador lia e codificava o arquivo inteiro
   antes de mandar (minutos em 4G), e só no fim vinha o 413 — indistinguível
   de "trava e não vai".

   Mesmo desenho da rota de conversa, pelo mesmo motivo (ver o comentário
   longo lá): `express.raw()` só nesta rota, corpo cru sem base64, sem
   `JSON.parse` de string gigante travando o processo (Node é de uma thread
   só). `mime` vai na query — aqui o corpo é só o arquivo. */
r.post("/:id/midias/video", express.raw({ limit: `${LIMITE_VIDEO_MB + 5}mb`, type: () => true }), async (req, res) => {
  const mime = String(req.query.mime || "video/mp4");
  if (!ehVideo(mime)) return res.status(400).json({ error: "Esta rota é só para vídeo." });

  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) return res.status(400).json({ error: "Arquivo vazio." });
  if (buffer.length > limiteVideoBinario())
    return res.status(413).json({ error: `O vídeo passa do limite de ${LIMITE_VIDEO_MB} MB.` });

  const alvo = podeReceberMidia(req, res, "video");
  if (!alvo) return;

  /* HEVC (padrão do iPhone) vira H.264 antes de salvar — o mesmo motivo da
     rota de conversa: o CRM sempre aceitou o arquivo, quem recusa em
     silêncio é o WhatsApp do outro lado quando o corretor manda o imóvel
     pro cliente (`POST /leads/:id/produto`, que envia esta mídia crua). */
  let bufferFinal = buffer, mimeFinal = mime;
  try {
    const processado = await garantirH264(buffer);
    bufferFinal = processado.buffer; mimeFinal = processado.mime;
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }

  try {
    const { url, chave } = await salvar({ buffer: bufferFinal, mime: mimeFinal, prefixo: `produtos/${alvo.p.id}` });
    res.json(gravarMidia({ ...alvo, tipo: "video", url, chave }));
  } catch (e) {
    console.error("[produtos] falha ao salvar vídeo:", e.message);
    res.status(500).json({ error: "Não consegui guardar o vídeo: " + e.message, onde: modoArmazenamento() });
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
