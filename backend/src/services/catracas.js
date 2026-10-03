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

/* A catraca ligada a um formulário — só se ela ainda vale. */
export function catracaDoFormulario(orgId, formId) {
  if (!formId) return null;
  const f = db.prepare("SELECT catraca_id FROM meta_formularios WHERE org_id = ? AND form_id = ?").get(orgId, String(formId));
  return f ? catracaAtiva(orgId, f.catraca_id) : null;
}

/* ===== GESTÃO (tela Catraca) ===== */

export function listar(orgId) {
  const lista = db.prepare("SELECT * FROM catracas WHERE org_id = ? ORDER BY ativa DESC, created_at").all(orgId);
  const membros = db.prepare(
    `SELECT m.user_id FROM catraca_membros m JOIN users u ON u.id = m.user_id
     WHERE m.catraca_id = ? AND u.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'${semMaster("u")}`);
  const leads = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND catraca_id = ? AND closed_at IS NULL");
  const forms = db.prepare("SELECT COUNT(*) n FROM meta_formularios WHERE org_id = ? AND catraca_id = ?");
  return {
    principal: { ...filaDaVez(orgId), catraca: null },
    catracas: lista.map(c => ({
      id: c.id, nome: c.nome, entrega: c.entrega, ativa: !!c.ativa, created_at: c.created_at,
      membros: membros.all(c.id, orgId).map(m => m.user_id),
      leads_abertos: leads.get(orgId, c.id).n,
      formularios: forms.get(orgId, c.id).n,
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

function gravarMembros(orgId, catracaId, ids) {
  db.prepare("DELETE FROM catraca_membros WHERE catraca_id = ?").run(catracaId);
  const ins = db.prepare("INSERT INTO catraca_membros (catraca_id,user_id,org_id,added_at) VALUES (?,?,?,?)");
  const agora = Date.now();
  for (const id of ids) ins.run(catracaId, id, orgId, agora);
}

export function criar(orgId, userId, { nome, entrega, membros = [] } = {}) {
  if (ehAutonomo(orgId)) throw new ErroCatraca(403, "Conta de corretor autônomo não tem catraca.");
  const n = nomeValido(nome);
  nomeLivre(orgId, n);
  const e = entregaValida(entrega);
  const ids = membrosValidos(orgId, membros);
  const id = "cat_" + randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO catracas (id,org_id,nome,entrega,ativa,criada_por,created_at) VALUES (?,?,?,?,1,?,?)")
      .run(id, orgId, n, e, userId, Date.now());
    gravarMembros(orgId, id, ids);
  })();
  return id;
}

export function editar(orgId, catracaId, { nome, entrega, ativa, membros } = {}) {
  const c = db.prepare("SELECT * FROM catracas WHERE id = ? AND org_id = ?").get(String(catracaId), orgId);
  if (!c) throw new ErroCatraca(404, "Catraca não encontrada.");
  const campos = {};
  if (nome !== undefined) { campos.nome = nomeValido(nome); nomeLivre(orgId, campos.nome, c.id); }
  if (entrega !== undefined) campos.entrega = entregaValida(entrega);
  if (ativa !== undefined) campos.ativa = ativa ? 1 : 0;
  const ids = membros !== undefined ? membrosValidos(orgId, membros) : null;
  db.transaction(() => {
    const ks = Object.keys(campos);
    if (ks.length) db.prepare(`UPDATE catracas SET ${ks.map(k => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...ks.map(k => campos[k]), c.id);
    if (ids) gravarMembros(orgId, c.id, ids);
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
    db.prepare("UPDATE meta_formularios SET catraca_id = NULL WHERE org_id = ? AND catraca_id = ?").run(orgId, c.id);
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
