/* AS FICHAS DE PRODUTO DO AUTOATENDIMENTO (08/10/2026, pedido do Ali: "uma
   ficha por empreendimento, ligada ao formulário ou à catraca, para a IA
   responder sobre o produto certo").

   Uma ficha é texto escrito pela equipe — localização, diferenciais, o que
   explicar sobre o programa — e, se quiser, um imóvel do catálogo ligado a
   ela. Ela vale num atendimento quando o lead chegou por um FORMULÁRIO ligado
   à ficha, ou é de uma CATRACA ligada à ficha. O formulário ganha: é o
   anúncio que a pessoa acabou de preencher, a pista mais direta do que ela
   quer.

   DO CATÁLOGO VAI SÓ O QUE É PÚBLICO: título, finalidade, tipo, bairro,
   cidade, cômodos, áreas e a descrição do anúncio. Nunca as observações
   internas, a construtora, a comissão nem o captador — e nem o valor: a IA
   continua proibida de falar preço, e dar o número a ela seria pedir que ela
   o recite. O mesmo vale para o texto da ficha, e a tela diz isso. */
import { randomUUID } from "crypto";
import db from "../db.js";

export class ErroFicha extends Error { constructor(status, m) { super(m); this.status = status; } }
const TETO_FICHAS = 40, TETO_TEXTO = 4000;

const formatar = (f) => ({ id: f.id, nome: f.nome, texto: f.texto, produto_id: f.produto_id || null, ativo: !!f.ativo,
  produto_titulo: f.produto_titulo || null, created_at: f.created_at, updated_at: f.updated_at,
  formularios: db.prepare("SELECT form_id, nome FROM meta_formularios WHERE org_id = ? AND ia_produto_id = ?").all(f.org_id, f.id)
    .map(x => ({ id: x.form_id, nome: x.nome || x.form_id })),
  catracas: db.prepare("SELECT id, nome FROM catracas WHERE org_id = ? AND ia_produto_id = ? AND ativa = 1").all(f.org_id, f.id) });

export function listarFichas(orgId) {
  return db.prepare(`SELECT f.*, p.titulo AS produto_titulo FROM ia_produtos f LEFT JOIN produtos p ON p.id = f.produto_id AND p.org_id = f.org_id
    WHERE f.org_id = ? ORDER BY f.ativo DESC, f.nome`).all(orgId).map(formatar);
}

function produtoValido(orgId, id) {
  if (!id) return null;
  const p = db.prepare("SELECT id FROM produtos WHERE id = ? AND org_id = ?").get(String(id), orgId);
  if (!p) throw new ErroFicha(400, "O imóvel escolhido não está no catálogo desta conta.");
  return p.id;
}
const nomeLimpo = (n) => {
  const t = String(n || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) throw new ErroFicha(400, "Dê um nome à ficha (ex.: Residencial Jardins).");
  return t;
};

export function criarFicha(orgId, userId, { nome, texto, produto_id }) {
  const n = db.prepare("SELECT COUNT(*) n FROM ia_produtos WHERE org_id = ?").get(orgId).n;
  if (n >= TETO_FICHAS) throw new ErroFicha(400, `São no máximo ${TETO_FICHAS} fichas. Apague alguma antes de criar outra.`);
  const id = "ip_" + randomUUID().slice(0, 12), agora = Date.now();
  const t = String(texto || "").trim().slice(0, TETO_TEXTO);
  const prod = produtoValido(orgId, produto_id);
  if (!t && !prod) throw new ErroFicha(400, "Escreva o que a IA precisa saber do produto, ou ligue um imóvel do catálogo.");
  db.prepare(`INSERT INTO ia_produtos (id,org_id,nome,texto,produto_id,ativo,criado_por,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)`)
    .run(id, orgId, nomeLimpo(nome), t, prod, userId || null, agora, agora);
  return fichaPorId(orgId, id);
}

export function editarFicha(orgId, id, dados) {
  const f = db.prepare("SELECT * FROM ia_produtos WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!f) throw new ErroFicha(404, "Ficha não encontrada.");
  const nome = dados.nome === undefined ? f.nome : nomeLimpo(dados.nome);
  const texto = dados.texto === undefined ? f.texto : String(dados.texto || "").trim().slice(0, TETO_TEXTO);
  const prod = dados.produto_id === undefined ? f.produto_id : produtoValido(orgId, dados.produto_id);
  if (!texto && !prod) throw new ErroFicha(400, "A ficha não pode ficar vazia: escreva o texto ou ligue um imóvel do catálogo.");
  const ativo = dados.ativo === undefined ? f.ativo : (dados.ativo ? 1 : 0);
  db.prepare("UPDATE ia_produtos SET nome = ?, texto = ?, produto_id = ?, ativo = ?, updated_at = ? WHERE id = ?")
    .run(nome, texto, prod, ativo, Date.now(), id);
  return fichaPorId(orgId, id);
}

/* Apagar solta a ficha dos formulários e catracas — senão eles apontariam
   para uma ficha que não existe, e a IA atenderia sem produto sem ninguém
   saber por quê. */
export function apagarFicha(orgId, id) {
  const f = db.prepare("SELECT id FROM ia_produtos WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!f) throw new ErroFicha(404, "Ficha não encontrada.");
  db.transaction(() => {
    db.prepare("UPDATE meta_formularios SET ia_produto_id = NULL WHERE org_id = ? AND ia_produto_id = ?").run(orgId, id);
    db.prepare("UPDATE catracas SET ia_produto_id = NULL WHERE org_id = ? AND ia_produto_id = ?").run(orgId, id);
    db.prepare("DELETE FROM ia_produtos WHERE id = ?").run(id);
  })();
}

export function fichaPorId(orgId, id) {
  const f = db.prepare(`SELECT f.*, p.titulo AS produto_titulo FROM ia_produtos f LEFT JOIN produtos p ON p.id = f.produto_id AND p.org_id = f.org_id
    WHERE f.id = ? AND f.org_id = ?`).get(id, orgId);
  return f ? formatar(f) : null;
}

/* Liga (ou solta, com nulo) a ficha a um formulário. O formulário pode ainda
   não ter linha (nunca configurado): nasce aqui, como em definirFunil. */
export function ligarFichaAoFormulario(orgId, userId, formId, fichaId, nomeForm = "") {
  const ficha = fichaId ? db.prepare("SELECT id FROM ia_produtos WHERE id = ? AND org_id = ?").get(String(fichaId), orgId) : null;
  if (fichaId && !ficha) throw new ErroFicha(400, "Ficha de produto não encontrada nesta conta.");
  const f = String(formId || "").replace(/[^\w:.-]/g, "").slice(0, 80);
  if (!f) throw new ErroFicha(400, "Formulário inválido.");
  const existe = db.prepare("SELECT 1 FROM meta_formularios WHERE org_id = ? AND form_id = ?").get(orgId, f);
  if (existe) db.prepare("UPDATE meta_formularios SET ia_produto_id = ?, atualizado_em = ? WHERE org_id = ? AND form_id = ?").run(ficha?.id || null, Date.now(), orgId, f);
  else db.prepare(`INSERT INTO meta_formularios (org_id, form_id, nome, ia_produto_id, atualizado_por, atualizado_em) VALUES (?,?,?,?,?,?)`)
    .run(orgId, f, String(nomeForm || "").slice(0, 160) || null, ficha?.id || null, userId || null, Date.now());
}
export function ligarFichaACatraca(orgId, catracaId, fichaId) {
  const c = db.prepare("SELECT id FROM catracas WHERE id = ? AND org_id = ?").get(String(catracaId || ""), orgId);
  if (!c) throw new ErroFicha(404, "Catraca não encontrada.");
  const ficha = fichaId ? db.prepare("SELECT id FROM ia_produtos WHERE id = ? AND org_id = ?").get(String(fichaId), orgId) : null;
  if (fichaId && !ficha) throw new ErroFicha(400, "Ficha de produto não encontrada nesta conta.");
  db.prepare("UPDATE catracas SET ia_produto_id = ? WHERE id = ?").run(ficha?.id || null, c.id);
}

/* O texto do catálogo que a IA pode ver — só o público, sem valor. */
function textoDoCatalogo(orgId, produtoId) {
  const p = produtoId && db.prepare("SELECT * FROM produtos WHERE id = ? AND org_id = ?").get(produtoId, orgId);
  if (!p) return "";
  const l = [`Imóvel do catálogo: ${p.titulo}`, `${p.finalidade === "aluguel" ? "Para alugar" : "À venda"} · ${p.tipo === "terreno" ? "terreno" : "casa"}`];
  const local = [p.bairro, p.cidade].filter(Boolean).join(", ");
  if (local) l.push(`Local: ${local}`);
  const comodos = [p.quartos && `${p.quartos} quarto(s)`, p.suites && `${p.suites} suíte(s)`, p.banheiros && `${p.banheiros} banheiro(s)`, p.vagas && `${p.vagas} vaga(s)`].filter(Boolean);
  if (comodos.length) l.push(comodos.join(" · "));
  if (p.area_util) l.push(`Área construída: ${p.area_util} m²`);
  if (p.metragem) l.push(`Terreno: ${p.metragem} m²`);
  if (p.modalidade) l.push(`Financiamento: ${p.modalidade}`);
  if (p.descricao) l.push(String(p.descricao).slice(0, 1500));
  return l.join("\n");
}

/* A ficha que vale para este lead, já em texto para o prompt — ou nulo. */
export function fichaDoLead(orgId, lead) {
  if (!lead) return null;
  let id = null;
  if (lead.form_id) id = db.prepare(`SELECT f.ia_produto_id id FROM meta_formularios f JOIN ia_produtos p ON p.id = f.ia_produto_id AND p.ativo = 1
    WHERE f.org_id = ? AND f.form_id = ?`).get(orgId, lead.form_id)?.id || null;
  if (!id && lead.catraca_id) id = db.prepare(`SELECT c.ia_produto_id id FROM catracas c JOIN ia_produtos p ON p.id = c.ia_produto_id AND p.ativo = 1
    WHERE c.org_id = ? AND c.id = ?`).get(orgId, lead.catraca_id)?.id || null;
  if (!id) return null;
  const f = db.prepare("SELECT * FROM ia_produtos WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!f) return null;
  const texto = [String(f.texto || "").trim(), textoDoCatalogo(orgId, f.produto_id)].filter(Boolean).join("\n\n");
  return { id: f.id, nome: f.nome, texto };
}

/* AS OUTRAS FICHAS DA CONTA (09/10/2026, print do Ali: o cliente escreveu
   "quero saber do Horizon" e a IA respondeu "não tenho os dados aqui" — com a
   ficha do Horizon escrita). A ficha só valia para o lead de um formulário ou
   catraca ligados a ela, e o lead que chega pelo WhatsApp direto não tem
   nenhum dos dois: a IA atendia sem ficha nenhuma, e é justamente o lead que
   diz o nome do produto na conversa.

   Agora as fichas ativas da conta vão também, como "os produtos da
   imobiliária". Ordem de prioridade dentro de um teto de texto (cada ficha é
   paga em toda resposta): primeiro as que a conversa cita pelo nome, depois as
   outras enquanto couber; as que não couberem vão só pelo nome, para a IA
   saber que existem e dizer que o corretor detalha. Sem acento e sem
   maiúscula, e vale uma palavra do nome ("horizon" acha "Residencial Horizon"). */
const TETO_OUTRAS = 16000;
const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const GENERICAS = new Set(["residencial", "condominio", "edificio", "loteamento", "empreendimento", "torre", "torres", "casas", "apartamentos"]);
const citada = (nome, conversa) => {
  const n = semAcento(nome).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return false;
  if (conversa.includes(n)) return true;
  return n.split(" ").some(p => p.length >= 4 && !GENERICAS.has(p) && new RegExp(`\\b${p}\\b`).test(conversa));
};
export function outrasFichas(orgId, excetoId, conversa = "") {
  const c = semAcento(conversa);
  const todas = db.prepare("SELECT * FROM ia_produtos WHERE org_id = ? AND ativo = 1 ORDER BY nome").all(orgId)
    .filter(f => f.id !== excetoId);
  const ordem = [...todas.filter(f => citada(f.nome, c)), ...todas.filter(f => !citada(f.nome, c))];
  const fichas = [], soNomes = [];
  let usado = 0;
  for (const f of ordem) {
    const texto = [String(f.texto || "").trim(), textoDoCatalogo(orgId, f.produto_id)].filter(Boolean).join("\n\n");
    if (texto && usado + texto.length <= TETO_OUTRAS) { fichas.push({ nome: f.nome, texto }); usado += texto.length; }
    else soNomes.push(f.nome);
  }
  return { fichas, soNomes };
}

/* A CATRACA DO PRODUTO QUE O CLIENTE ESCOLHEU (09/10/2026, print do Ali: "eu
   escolhi o Horizon e a IA não me colocou na catraca do Horizon"). A IA diz
   qual ficha a pessoa escolheu (o nome, como veio na lista); aqui ele vira a
   catraca: a ligada àquela ficha, ou — sem ligação — a catraca ativa cujo nome
   cita o produto ("Horizon" acha "Catraca Horizon"). Mais de uma candidata
   pelo nome é chute, e chute não move lead: devolve nulo. */
export function catracaDoProduto(orgId, nomeProduto) {
  const alvo = semAcento(nomeProduto).trim();
  if (!alvo) return null;
  const fichas = db.prepare("SELECT id, nome FROM ia_produtos WHERE org_id = ? AND ativo = 1").all(orgId);
  const ficha = fichas.find(f => semAcento(f.nome).trim() === alvo)
    || (() => { const cs = fichas.filter(f => citada(f.nome, alvo)); return cs.length === 1 ? cs[0] : null; })();
  if (!ficha) return null;
  const catracas = db.prepare("SELECT id, nome, ia_produto_id FROM catracas WHERE org_id = ? AND ativa = 1").all(orgId);
  const ligada = catracas.filter(c => c.ia_produto_id === ficha.id);
  if (ligada.length === 1) return { catraca_id: ligada[0].id, catraca: ligada[0].nome, ficha: ficha.nome };
  if (ligada.length > 1) return null;
  const pelo = catracas.filter(c => citada(ficha.nome, semAcento(c.nome)));
  return pelo.length === 1 ? { catraca_id: pelo[0].id, catraca: pelo[0].nome, ficha: ficha.nome } : null;
}
