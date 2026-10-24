/* CATRACAS POR PRODUTO (03/10/2026, pedido do Ali: "várias catracas de
   atendimento para vários produtos que a imobiliária tenha, fazendo assim cada
   formulário ser vinculado inclusive a uma determinada catraca").

   A CATRACA PRINCIPAL CONTINUA SENDO A DE SEMPRE: todos os corretores ativos,
   a vez em `orgs.rodizio_ultimo` (services/rodizio.js). Ela não tem linha na
   tabela `catracas` — e é isso que garante que nenhum cliente muda de
   comportamento ao publicar: sem catraca criada, tudo passa pelo mesmo
   caminho de antes.

   Uma catraca de produto tem:
     - os MEMBROS (só corretores ativos; um corretor pode estar em várias);
     - a VEZ própria (`catracas.ultimo_user_id`), separada da principal —
       senão o lead do lançamento embaralharia a vez do usado;
     - o modo de ENTREGA do lead que chega pelo formulário ligado a ela:
       'atendente' (a atendente da vez recebe e repassa por esta catraca) ou
       'corretor' (vai direto para o próximo corretor disponível dela).
   A disponibilidade é UMA só, a de sempre (`users.available`) — decisão do
   Ali: o corretor não marca prontidão catraca por catraca.

   O LEAD LEMBRA A CATRACA (`leads.catraca_id`): é ela que o repasse da ficha,
   o "Próximo" da fila e a automação da etapa usam. Catraca desativada, apagada
   ou sem ninguém disponível → a principal, e a resposta diz isso
   (`reserva`), para a tela não prometer um nome da catraca do produto e
   entregar a outro.

   Conta de corretor autônomo não tem catraca (nem a principal aparece para
   ela): `catracaAtiva` devolve nulo ali, e tudo segue a regra da casa dele. */
import { randomUUID } from "node:crypto";
import db from "../db.js";
import { semMaster } from "../auth.js";
import { filaDaVez, montarFila, pegarProximo, marcarQueRecebeu } from "./rodizio.js";

export class ErroCatraca extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const ENTREGAS = ["atendente", "corretor"];
const ehAutonomo = (orgId) => db.prepare("SELECT tipo FROM orgs WHERE id = ?").get(orgId)?.tipo === "autonomo";

/* A catraca, se existe NESTA conta, está ativa e a conta não é de autônomo.
   É a única porta: toda decisão de "qual catraca vale" passa por aqui. */
export function catracaAtiva(orgId, catracaId) {
  if (!catracaId) return null;
  const c = db.prepare("SELECT * FROM catracas WHERE id = ? AND org_id = ? AND ativa = 1").get(String(catracaId), orgId);
  if (!c || ehAutonomo(orgId)) return null;
  return c;
}

/* Os membros na ordem fixa em que a roda gira — a MESMA ordem da principal
   (data de entrada e nome), então o corretor aparece na mesma posição relativa
   em todas as catracas em que está. Só corretor ativo: quem saiu da equipe ou
   mudou de papel continua na tabela, mas não recebe. */
export function rodaDaCatraca(orgId, catracaId) {
  return db.prepare(
    `SELECT u.id, u.name, u.available, u.avatar_url FROM catraca_membros m
     JOIN users u ON u.id = m.user_id
     WHERE m.catraca_id = ? AND m.org_id = ? AND u.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'${semMaster("u")}
     ORDER BY u.created_at, u.name`).all(catracaId, orgId, orgId);
}

const resumo = (c) => c ? { id: c.id, nome: c.nome, entrega: c.entrega } : null;

/* A fila de UMA catraca de produto, no mesmo formato da principal. */
export function filaDaCatraca(orgId, catracaId) {
  const c = catracaAtiva(orgId, catracaId);
  if (!c) return null;
  return { ...montarFila(rodaDaCatraca(orgId, c.id), c.ultimo_user_id), catraca: resumo(c) };
}

/* A fila que vale para ESTE lead: a da catraca dele, ou a principal.

   `reserva: true` = o lead é de uma catraca de produto, mas ninguém dela está
   disponível agora, e o repasse vai pela principal. A tela escreve isso — o
   nome que o botão mostra é sempre o nome de quem vai receber de verdade. */
export function filaDoLead(orgId, lead) {
  const propria = lead && filaDaCatraca(orgId, lead.catraca_id);
  if (propria && propria.proximo) return { ...propria, reserva: false };
  const principal = { ...filaDaVez(orgId), catraca: null };
  if (propria) return { ...principal, reserva: true, catraca_do_lead: propria.catraca };
  return { ...principal, reserva: false };
}

/* Entrega ao próximo da catraca do lead e move a vez DELA. Sem ninguém
   disponível na catraca do produto, a principal (e move a vez da principal).
   Devolve { userId, catraca, reserva } — userId nulo quando nem a principal
   tem alguém. */
export function pegarProximoDoLead(orgId, lead) {
  const c = lead && catracaAtiva(orgId, lead.catraca_id);
  if (c) {
    const { proximo } = montarFila(rodaDaCatraca(orgId, c.id), c.ultimo_user_id);
    if (proximo) {
      db.prepare("UPDATE catracas SET ultimo_user_id = ? WHERE id = ?").run(proximo.id, c.id);
      return { userId: proximo.id, catraca: resumo(c), reserva: false };
    }
  }
  return { userId: pegarProximo(orgId), catraca: null, reserva: !!c, catraca_do_lead: resumo(c) };
}

/* Corretor escolhido a dedo também move a vez (regra de 25/08/2026), e na
   catraca certa: se o lead é de uma catraca de produto e a pessoa é membro
   dela, a vez que anda é a do produto; senão, a da principal, como sempre. */
export function marcarQueRecebeuNoLead(orgId, lead, userId) {
  const c = lead && catracaAtiva(orgId, lead.catraca_id);
  if (c && db.prepare("SELECT 1 FROM catraca_membros WHERE catraca_id = ? AND user_id = ?").get(c.id, userId)) {
    db.prepare("UPDATE catracas SET ultimo_user_id = ? WHERE id = ?").run(userId, c.id);
    return;
  }
  marcarQueRecebeu(orgId, userId);
}

/* O lead novo do formulário com modo 'corretor': o próximo DISPONÍVEL desta
   catraca, movendo a vez dela. Nulo quando ninguém está disponível — aí quem
   chama aplica a regra de sempre do lead novo (a atendente da vez), e não a
   catraca principal: o lead é do produto, e a atendente vai repassá-lo pela
   catraca dele. */
export function pegarDaCatraca(orgId, catracaId) {
  const c = catracaAtiva(orgId, catracaId);
  if (!c) return null;
  const { proximo } = montarFila(rodaDaCatraca(orgId, c.id), c.ultimo_user_id);
  if (!proximo) return null;
  db.prepare("UPDATE catracas SET ultimo_user_id = ? WHERE id = ?").run(proximo.id, c.id);
  return proximo.id;
}

/* ===== CANAIS DE AQUISIÇÃO E ETAPA QUE ACIONA (03/10/2026) =====

   Cada catraca diz de onde vêm os leads dela (WhatsApp da imobiliária,
   portais, site, formulários específicos) e, se quiser, a etapa que a aciona.
   Um canal pode estar em várias catracas (decisão do Ali): quando mais de uma
   disputa o mesmo lead, elas se revezam (`ultima_entrega_em`), e cada uma
   entrega pela vez dela. */
export const CANAIS = ["whatsapp", "portal", "site", "formulario"];

/* De que canal o lead veio. Nulo = nenhum que uma catraca escolha: a linha
   pessoal de um corretor (o cliente escolheu a pessoa), o disparo (já é
   campanha), o cadastro na mão e a planilha. */
export function canalDoLead(lead) {
  if (!lead) return null;
  if (lead.source === "meta") return lead.form_id ? { canal: "formulario", ref: String(lead.form_id) } : null;
  if (lead.source === "portal") return { canal: "portal", ref: "" };
  if (lead.canal_id || lead.platform === "disparo" || lead.origem === "Disparo") return null;
  if (lead.origem === "Site") return { canal: "site", ref: "" };
  if (lead.source === "whatsapp" || (!lead.source && !lead.import_id && /whatsapp/i.test(lead.origem || "")))
    return { canal: "whatsapp", ref: "" };
  return null;
}

/* A primeira mensagem de quem chega pelo site traz o texto que o próprio site
   escreve no botão do WhatsApp (services/site.js): "Vim pelo site da…",
   "…que vi no site: https://…/imoveis/…", "Tentei acessar o site da…". */
export const veioDoSite = (texto) => /\b(pelo|no|o) site\b|\/imoveis\/[\w-]+/i.test(String(texto || ""));

/* As catracas ATIVAS que recebem leads deste canal, na ordem do revezamento
   (quem entregou há mais tempo primeiro). */
export function catracasDoCanal(orgId, c) {
  if (!c || ehAutonomo(orgId)) return [];
  return db.prepare(`SELECT k.* FROM catraca_canais x JOIN catracas k ON k.id = x.catraca_id
    WHERE x.org_id = ? AND x.canal = ? AND x.ref = ? AND k.org_id = ? AND k.ativa = 1
    ORDER BY COALESCE(k.ultima_entrega_em, 0), k.created_at`).all(orgId, c.canal, c.ref || "", orgId);
}

/* Os ids das catracas que recebem os leads de um formulário (todas, ativas ou
   não — a tela marca a desativada). */
export function catracasDoFormulario(orgId, formId) {
  if (!formId) return [];
  return db.prepare("SELECT catraca_id FROM catraca_canais WHERE org_id = ? AND canal = 'formulario' AND ref = ?")
    .all(orgId, String(formId)).map(r => r.catraca_id);
}

/* Liga um formulário exatamente a estas catracas (o gatilho de formulário do
   fluxo escolhe por aqui). Só catracas ativas desta conta. */
export function definirCatracasDoFormulario(orgId, formId, ids) {
  const fid = String(formId || "").trim();
  if (!/^[\w-]{1,64}$/.test(fid)) throw new ErroCatraca(400, "Formulário inválido.");
  const lista = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];
  for (const id of lista) if (!catracaAtiva(orgId, id)) throw new ErroCatraca(400, "Essa catraca não existe nesta conta ou está desativada.");
  db.transaction(() => {
    db.prepare(`DELETE FROM catraca_canais WHERE org_id = ? AND canal = 'formulario' AND ref = ?
      AND catraca_id IN (SELECT id FROM catracas WHERE org_id = ? AND ativa = 1)`).run(orgId, fid, orgId);
    const ins = db.prepare("INSERT OR IGNORE INTO catraca_canais (catraca_id, org_id, canal, ref) VALUES (?,?,'formulario',?)");
    for (const id of lista) ins.run(id, orgId, fid);
  })();
  return lista;
}

/* A etapa da catraca como entrada de lead novo (a "direto ao corretor" faz
   o lead nascer nela). Nula se a etapa foi apagada ou desativada: aí vale o
   funil de quem recebe, como sempre. */
export function etapaDeEntrada(orgId, stageId) {
  if (!stageId) return null;
  const e = db.prepare(`SELECT s.id, s.name, s.pipeline_id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.id = ? AND s.org_id = ? AND COALESCE(s.is_active,1) = 1 AND COALESCE(p.is_active,1) = 1`).get(stageId, orgId);
  return e ? { pipeline_id: e.pipeline_id, stage_id: e.id, nome: e.name } : null;
}

const entregou = (c) => db.prepare("UPDATE catracas SET ultima_entrega_em = ? WHERE id = ?").run(Date.now(), c.id);

/* O LEAD NOVO de um canal: qual catraca ele lembra e, se alguma delas é
   "direto ao corretor", quem o recebe na hora. Devolve
   { catraca, dono } — dono nulo = a regra de sempre (atendente da vez), com o
   lead lembrando a catraca para o repasse dela. Sem catraca: { null, null }. */
export function catracaNoNascimento(orgId, canal) {
  const lista = catracasDoCanal(orgId, canal);
  if (!lista.length) return { catraca: null, dono: null };
  for (const c of lista.filter(c => c.entrega === "corretor")) {
    const dono = pegarDaCatraca(orgId, c.id);
    if (dono) { entregou(c); return { catraca: c, dono }; }
  }
  /* Ninguém disponível nas "direto ao corretor" (ou todas são "pela
     atendente"): o lead lembra a primeira da vez, preferindo a que passa pela
     atendente — é ela quem vai repassar. */
  const c = lista.find(c => c.entrega === "atendente") || lista[0];
  return { catraca: c, dono: null };
}

/* A ETAPA QUE ACIONA: o lead entrou em `stageId`. As catracas candidatas são
   as que têm esta etapa e recebem o canal do lead — mais a catraca que o lead
   já lembra (escolhida na ficha, por exemplo), se a etapa dela for esta.
   Devolve { catraca, userId } de quem recebe, { catraca, ninguem: true }
   quando ninguém está disponível, ou null quando nenhuma catraca é desta
   etapa. Quem troca o dono é quem chama (services/movimento.js). */
export function catracaDaEtapa(orgId, lead, stageId) {
  if (!stageId || ehAutonomo(orgId)) return null;
  const porCanal = catracasDoCanal(orgId, canalDoLead(lead)).filter(c => c.stage_id === stageId);
  const doLead = lead.catraca_id ? catracaAtiva(orgId, lead.catraca_id) : null;
  const lista = [...porCanal];
  if (doLead && doLead.stage_id === stageId && !lista.some(c => c.id === doLead.id)) lista.unshift(doLead);
  if (!lista.length) return null;
  for (const c of lista) {
    const userId = pegarDaCatraca(orgId, c.id);
    if (userId) { entregou(c); return { catraca: resumo(c), userId }; }
  }
  return { catraca: resumo(lista[0]), ninguem: true };
}

/* Uma das catracas que recebem os leads deste formulário — compatibilidade
   com quem pergunta por UMA (o repasse usa a do lead). */
export function catracaDoFormulario(orgId, formId) {
  return catracasDoCanal(orgId, formId ? { canal: "formulario", ref: String(formId) } : null)[0] || null;
}

/* ===== GESTÃO (tela Catraca) ===== */

export function listar(orgId) {
  const lista = db.prepare("SELECT * FROM catracas WHERE org_id = ? ORDER BY ativa DESC, created_at").all(orgId);
  const membros = db.prepare(
    `SELECT m.user_id FROM catraca_membros m JOIN users u ON u.id = m.user_id
     WHERE m.catraca_id = ? AND u.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'${semMaster("u")}`);
  const leads = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND catraca_id = ? AND closed_at IS NULL");
  const etapa = db.prepare(`SELECT s.name AS etapa, p.name AS funil, (COALESCE(s.is_active,1) = 1 AND COALESCE(p.is_active,1) = 1) AS ok
    FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ? AND s.org_id = ?`);
  return {
    principal: { ...filaDaVez(orgId), catraca: null },
    catracas: lista.map(c => ({
      id: c.id, nome: c.nome, entrega: c.entrega, ativa: !!c.ativa, created_at: c.created_at,
      membros: membros.all(c.id, orgId).map(m => m.user_id),
      leads_abertos: leads.get(orgId, c.id).n,
      ...canaisDe(c.id),
      pipeline_id: c.pipeline_id || null, stage_id: c.stage_id || null, ia_produto_id: c.ia_produto_id || null,
      /* A etapa escolhida, com nomes; `etapa_invalida` quando foi apagada ou
         desativada depois — a catraca deixa de ser acionada e a tela avisa. */
      etapa: c.stage_id ? (() => { const e = etapa.get(c.stage_id, orgId); return e ? { funil: e.funil, nome: e.etapa, ok: !!e.ok } : { ok: false }; })() : null,
      fila: c.ativa ? montarFila(rodaDaCatraca(orgId, c.id), c.ultimo_user_id) : null,
    })),
  };
}

function nomeValido(nome) {
  const n = String(nome || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!n) throw new ErroCatraca(400, "Dê um nome à catraca (ex.: Lançamento Jardins, Aluguel).");
  if (/^catraca principal$/i.test(n)) throw new ErroCatraca(400, "“Catraca principal” é o nome da catraca de sempre. Escolha outro.");
  return n;
}
const chave = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function nomeLivre(orgId, nome, foraId = null) {
  const outra = db.prepare("SELECT id, nome FROM catracas WHERE org_id = ?").all(orgId)
    .find(c => c.id !== foraId && chave(c.nome) === chave(nome));
  if (outra) throw new ErroCatraca(409, `Já existe uma catraca chamada “${outra.nome}”.`);
}
function entregaValida(entrega) {
  if (entrega == null) return "atendente";
  if (!ENTREGAS.includes(entrega)) throw new ErroCatraca(400, "Entrega inválida: escolha atendente ou corretor.");
  return entrega;
}
// Os membros que chegam do navegador: só corretores ativos DESTA conta.
function membrosValidos(orgId, ids) {
  if (!Array.isArray(ids)) throw new ErroCatraca(400, "Lista de corretores inválida.");
  const unicos = [...new Set(ids.map(String))];
  const validos = db.prepare(
    `SELECT id FROM users u WHERE u.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'${semMaster("u")}`)
    .all(orgId).map(u => u.id);
  const fora = unicos.filter(id => !validos.includes(id));
  if (fora.length) throw new ErroCatraca(400, "Só corretores ativos desta conta entram na catraca.");
  return unicos;
}

/* Os canais de uma catraca no formato da tela. */
function canaisDe(catracaId) {
  const linhas = db.prepare("SELECT canal, ref FROM catraca_canais WHERE catraca_id = ?").all(catracaId);
  const tem = (k) => linhas.some(l => l.canal === k);
  const formularios = linhas.filter(l => l.canal === "formulario").map(l => l.ref);
  return { canais: { whatsapp: tem("whatsapp"), portal: tem("portal"), site: tem("site"), formularios }, formularios: formularios.length };
}
function canaisValidos(c) {
  if (c == null) return null;
  if (typeof c !== "object") throw new ErroCatraca(400, "Canais inválidos.");
  const forms = Array.isArray(c.formularios) ? c.formularios : [];
  const ids = [...new Set(forms.map(f => String(f || "").trim()).filter(Boolean))];
  if (ids.some(id => !/^[\w-]{1,64}$/.test(id))) throw new ErroCatraca(400, "Formulário inválido.");
  return { whatsapp: !!c.whatsapp, portal: !!c.portal, site: !!c.site, formularios: ids };
}
function gravarCanais(orgId, catracaId, c) {
  db.prepare("DELETE FROM catraca_canais WHERE catraca_id = ?").run(catracaId);
  const ins = db.prepare("INSERT OR IGNORE INTO catraca_canais (catraca_id, org_id, canal, ref) VALUES (?,?,?,?)");
  for (const k of ["whatsapp", "portal", "site"]) if (c[k]) ins.run(catracaId, orgId, k, "");
  for (const f of c.formularios) ins.run(catracaId, orgId, "formulario", f);
}
/* A etapa que aciona: do funil escolhido, desta conta e ativa. Vazio tira. */
function etapaValida(orgId, pipelineId, stageId) {
  if (!stageId) return { pipeline_id: null, stage_id: null };
  const e = db.prepare(`SELECT s.id, s.pipeline_id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.id = ? AND s.org_id = ? AND p.org_id = ? AND COALESCE(s.is_active,1) = 1 AND COALESCE(p.is_active,1) = 1`).get(String(stageId), orgId, orgId);
  if (!e || (pipelineId && e.pipeline_id !== String(pipelineId)))
    throw new ErroCatraca(400, "Essa etapa não existe neste funil ou está desativada.");
  return { pipeline_id: e.pipeline_id, stage_id: e.id };
}

function gravarMembros(orgId, catracaId, ids) {
  db.prepare("DELETE FROM catraca_membros WHERE catraca_id = ?").run(catracaId);
  const ins = db.prepare("INSERT INTO catraca_membros (catraca_id,user_id,org_id,added_at) VALUES (?,?,?,?)");
  const agora = Date.now();
  for (const id of ids) ins.run(catracaId, id, orgId, agora);
}

export function criar(orgId, userId, { nome, entrega, membros = [], canais, pipeline_id, stage_id, ia_produto_id } = {}) {
  if (ehAutonomo(orgId)) throw new ErroCatraca(403, "Conta de corretor autônomo não tem catraca.");
  const n = nomeValido(nome);
  nomeLivre(orgId, n);
  const e = entregaValida(entrega);
  const ids = membrosValidos(orgId, membros);
  const ch = canaisValidos(canais);
  const et = etapaValida(orgId, pipeline_id, stage_id);
  const id = "cat_" + randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO catracas (id,org_id,nome,entrega,ativa,criada_por,created_at,pipeline_id,stage_id) VALUES (?,?,?,?,1,?,?,?,?)")
      .run(id, orgId, n, e, userId, Date.now(), et.pipeline_id, et.stage_id);
    gravarMembros(orgId, id, ids);
    if (ch) gravarCanais(orgId, id, ch);
  })();
  if (ia_produto_id) editar(orgId, id, { ia_produto_id });
  return id;
}

export function editar(orgId, catracaId, { nome, entrega, ativa, membros, canais, pipeline_id, stage_id, ia_produto_id } = {}) {
  const c = db.prepare("SELECT * FROM catracas WHERE id = ? AND org_id = ?").get(String(catracaId), orgId);
  if (!c) throw new ErroCatraca(404, "Catraca não encontrada.");
  const campos = {};
  if (nome !== undefined) { campos.nome = nomeValido(nome); nomeLivre(orgId, campos.nome, c.id); }
  if (entrega !== undefined) campos.entrega = entregaValida(entrega);
  if (ativa !== undefined) campos.ativa = ativa ? 1 : 0;
  if (stage_id !== undefined) Object.assign(campos, etapaValida(orgId, pipeline_id, stage_id));
  /* A ficha de produto que a IA usa com os leads desta catraca (08/10/2026). */
  if (ia_produto_id !== undefined) {
    if (ia_produto_id && !db.prepare("SELECT 1 FROM ia_produtos WHERE id = ? AND org_id = ?").get(String(ia_produto_id), orgId))
      throw new ErroCatraca(400, "Ficha de produto não encontrada nesta conta.");
    campos.ia_produto_id = ia_produto_id ? String(ia_produto_id) : null;
  }
  const ids = membros !== undefined ? membrosValidos(orgId, membros) : null;
  const ch = canais !== undefined ? canaisValidos(canais) : null;
  db.transaction(() => {
    const ks = Object.keys(campos);
    if (ks.length) db.prepare(`UPDATE catracas SET ${ks.map(k => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...ks.map(k => campos[k]), c.id);
    if (ids) gravarMembros(orgId, c.id, ids);
    if (ch) gravarCanais(orgId, c.id, ch);
  })();
}

/* Apagar de vez só a catraca que NUNCA foi usada (nenhum lead ligado a ela).
   Com lead, ela se DESATIVA: os leads passam a ir pela principal, e a catraca
   continua aparecendo para dizer de onde eles vieram — apagar deixaria o
   lead apontando para uma catraca que não existe, sem ninguém saber qual era.
   O formulário ligado a uma catraca apagada volta à regra de sempre. */
export function apagar(orgId, catracaId) {
  const c = db.prepare("SELECT * FROM catracas WHERE id = ? AND org_id = ?").get(String(catracaId), orgId);
  if (!c) throw new ErroCatraca(404, "Catraca não encontrada.");
  const usados = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND catraca_id = ?").get(orgId, c.id).n;
  if (usados) {
    db.prepare("UPDATE catracas SET ativa = 0 WHERE id = ?").run(c.id);
    return { desativada: true, leads: usados };
  }
  db.transaction(() => {
    db.prepare("DELETE FROM catraca_membros WHERE catraca_id = ?").run(c.id);
    db.prepare("DELETE FROM catraca_canais WHERE catraca_id = ?").run(c.id);
    db.prepare("DELETE FROM catracas WHERE id = ?").run(c.id);
  })();
  return { apagada: true };
}

/* Trocar a catraca de UM lead (o que entrou pelo WhatsApp, por exemplo, e só
   na conversa se descobriu de que produto é). Nulo volta à principal. Não muda
   o dono: só o caminho do próximo repasse. */
export function definirCatracaDoLead(orgId, leadId, catracaId) {
  const lead = db.prepare("SELECT id FROM leads WHERE id = ? AND org_id = ?").get(String(leadId), orgId);
  if (!lead) throw new ErroCatraca(404, "Lead não encontrado.");
  let id = null;
  if (catracaId) {
    const c = catracaAtiva(orgId, catracaId);
    if (!c) throw new ErroCatraca(400, "Essa catraca não existe nesta conta ou está desativada.");
    id = c.id;
  }
  db.prepare("UPDATE leads SET catraca_id = ? WHERE id = ?").run(id, lead.id);
  return id;
}
