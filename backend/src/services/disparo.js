/* DISPARO EM MASSA COM FLUXOS — o motor (27/09/2026).

   Pedido do Ali: disparar para leads do próprio sistema (por etiqueta, etapa
   do funil, temperatura, responsável, origem) e para as listas enviadas, com
   um CONSTRUTOR DE FLUXOS parecido com o do ManyChat — mensagem, espera,
   esperar resposta e desviar, botões. As respostas entram na conversa do lead.

   A estrutura de proteção (termo, origem das listas, bloqueio, número
   separado) mora em services/marketing.js e é pré-requisito de tudo aqui.

   ===== COMO UM DISPARO ANDA =====

   Cada pessoa do público vira uma EXECUÇÃO (`marketing_execucoes`): em que
   bloco do fluxo ela está e quando é a próxima ação. O batimento
   (`processarDisparos`, a cada poucos segundos) pega as execuções cuja vez
   chegou e as faz andar pelo fluxo até esbarrar em algo que precisa de
   tempo: um envio (que respeita os limites), uma espera, ou uma resposta.

   ===== OS LIMITES — por que não se envia tudo de uma vez =====

   O número é de API não oficial. Mandar 500 mensagens em dez minutos é a
   forma mais rápida de perdê-lo — e, sem número de contingência, o disparo
   sai pelo MESMO número que recebe os leads. Por isso a conta tem:
   limite por dia, intervalo aleatório entre uma mensagem e outra, horário
   comercial (e domingo desligado por padrão). Entre um envio e outro, NADA
   sai daquele número — nem de outra campanha. E cinco falhas seguidas pausam
   o disparo sozinhas: é o sinal de que o número está sendo restringido.

   ===== O QUE PARA UMA EXECUÇÃO NO MEIO =====

   - a pessoa pediu para sair (lista de bloqueio);
   - alguém da equipe escreveu para ela depois de o disparo começar ("gente
     entrou, robô saiu", a mesma regra do atendimento automático) — sem isso
     o fluxo mandaria "ainda tem interesse?" no meio de uma negociação;
   - o número não tem WhatsApp;
   - o disparo foi cancelado. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { normalizePhone } from "./stages.js";
import { sendText, sendMedia, sendMenu, numeroAlternativo } from "./uazapi.js";
import { ErroMarketing, exigirPronto, linhaDeDisparo, marcarProximoEnvio, proximoEnvioEm, ritmoDaOrg } from "./marketing.js";
import { ROTULO_DISPARO, marcarEnvio, desmarcarEnvio, envioEmCurso } from "./marca-disparo.js";

const agoraFn = () => Date.now();
const formas = (t) => [t, numeroAlternativo(t)].filter(Boolean);
const telefoneValido = (t) => /^55\d{10,11}$/.test(t);
const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/* ===================== O FLUXO ===================== */

export const TIPOS_DE_BLOCO = ["inicio", "mensagem", "espera", "resposta", "botoes"];
const UNIDADES = { minutos: 60000, horas: 3600000, dias: 86400000 };
const PRAZO_PADRAO = { quantidade: 24, unidade: "horas" };
const MAX_BOTOES = 3;           // o WhatsApp não mostra mais que três botões
const MAX_ROTULO = 20;          // nem rótulo maior que vinte letras
export const RODAPE_SAIR = "_Responda SAIR para não receber mais mensagens._";

export function grafoPadrao() {
  return {
    nos: [
      { id: "inicio", tipo: "inicio", x: 60, y: 160, dados: {} },
      { id: "n1", tipo: "mensagem", x: 370, y: 160, dados: { texto: "Oi, {nome}! Tudo bem?" } },
    ],
    ligacoes: [{ de: "inicio", saida: "proximo", para: "n1" }],
  };
}

/* As saídas de cada bloco — é por elas que se liga um bloco a outro. */
export function saidasDe(no) {
  switch (no.tipo) {
    case "inicio": case "mensagem": case "espera": return ["proximo"];
    case "resposta": return [...(no.dados.regras || []).map(r => r.id), "outra", "sem_resposta"];
    case "botoes": return [...(no.dados.botoes || []).map(b => b.id), "outra", "sem_resposta"];
    default: return [];
  }
}

const texto = (v, max) => String(v ?? "").slice(0, max);
const idLimpo = (v) => String(v || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
const prazoLimpo = (p) => {
  const unidade = UNIDADES[p?.unidade] ? p.unidade : PRAZO_PADRAO.unidade;
  const quantidade = Math.round(Number(p?.quantidade));
  return { quantidade: quantidade >= 1 && quantidade <= 999 ? quantidade : PRAZO_PADRAO.quantidade, unidade };
};
const midiaLimpa = (m) => {
  if (!m || !m.url) return null;
  const tipo = ["image", "video", "audio", "document"].includes(m.tipo) ? m.tipo : "document";
  return { url: texto(m.url, 1000), tipo, nome: texto(m.nome, 200), mime: texto(m.mime, 100) };
};

/* Limpa o que veio da tela e diz o que está errado.

   Duas réguas: para SALVAR basta a estrutura estar de pé (dá para salvar um
   rascunho pela metade); para DISPARAR, todo bloco que o público vai
   atravessar precisa estar preenchido. */
export function validarGrafo(bruto, { paraDisparar = false } = {}) {
  const erros = [];
  const nosBrutos = Array.isArray(bruto?.nos) ? bruto.nos.slice(0, 100) : [];
  const nos = [];
  const ids = new Set();
  for (const n of nosBrutos) {
    const id = idLimpo(n.id);
    if (!id || ids.has(id) || !TIPOS_DE_BLOCO.includes(n.tipo)) continue;
    ids.add(id);
    const d = n.dados || {};
    let dados = {};
    if (n.tipo === "mensagem") dados = { texto: texto(d.texto, 4000), midia: midiaLimpa(d.midia) };
    if (n.tipo === "espera") {
      const p = prazoLimpo({ quantidade: d.quantidade, unidade: d.unidade });
      dados = { quantidade: p.quantidade, unidade: p.unidade };
    }
    if (n.tipo === "resposta") dados = {
      regras: (Array.isArray(d.regras) ? d.regras : []).slice(0, 10)
        .map(r => ({ id: idLimpo(r.id), palavras: texto(r.palavras, 300) })).filter(r => r.id),
      prazo: prazoLimpo(d.prazo),
    };
    if (n.tipo === "botoes") dados = {
      texto: texto(d.texto, 1024),
      botoes: (Array.isArray(d.botoes) ? d.botoes : []).slice(0, MAX_BOTOES)
        .map(b => ({ id: idLimpo(b.id), rotulo: texto(String(b.rotulo || "").trim(), MAX_ROTULO) })).filter(b => b.id),
      escrever_opcoes: d.escrever_opcoes !== false,
      prazo: prazoLimpo(d.prazo),
    };
    nos.push({ id, tipo: n.tipo, x: Math.round(Number(n.x) || 0), y: Math.round(Number(n.y) || 0), dados });
  }
  const inicios = nos.filter(n => n.tipo === "inicio");
  if (inicios.length !== 1) erros.push("O fluxo precisa ter exatamente um bloco de início.");

  const porId = new Map(nos.map(n => [n.id, n]));
  const usadas = new Map();
  for (const l of (Array.isArray(bruto?.ligacoes) ? bruto.ligacoes : [])) {
    const de = porId.get(idLimpo(l.de)), para = porId.get(idLimpo(l.para));
    const saida = idLimpo(l.saida);
    if (!de || !para || para.tipo === "inicio" || !saidasDe(de).includes(saida)) continue;
    usadas.set(`${de.id}:${saida}`, { de: de.id, saida, para: para.id });   // uma ligação por saída
  }
  const ligacoes = [...usadas.values()];
  const grafo = { nos, ligacoes };

  if (paraDisparar && inicios.length === 1) {
    const alcancaveis = new Set();
    const pilha = [inicios[0].id];
    while (pilha.length) {
      const id = pilha.pop();
      if (alcancaveis.has(id)) continue;
      alcancaveis.add(id);
      for (const l of ligacoes) if (l.de === id) pilha.push(l.para);
    }
    const nomeDe = (n) => ({ mensagem: "Mensagem", espera: "Espera", resposta: "Esperar resposta", botoes: "Botões" }[n.tipo] || n.tipo);
    let temEnvio = false;
    for (const id of alcancaveis) {
      const n = porId.get(id);
      if (n.tipo === "mensagem") {
        temEnvio = true;
        if (!n.dados.texto.trim() && !n.dados.midia) erros.push(`Um bloco "${nomeDe(n)}" está vazio: escreva o texto ou anexe um arquivo.`);
      }
      if (n.tipo === "botoes") {
        temEnvio = true;
        if (!n.dados.texto.trim()) erros.push("Um bloco \"Botões\" está sem o texto da pergunta.");
        if (!n.dados.botoes.some(b => b.rotulo)) erros.push("Um bloco \"Botões\" está sem nenhum botão escrito.");
        if (n.dados.botoes.some(b => !b.rotulo)) erros.push("Há um botão sem texto num bloco \"Botões\".");
      }
      if (n.tipo === "resposta" && n.dados.regras.some(r => !r.palavras.trim()))
        erros.push("Um caminho de \"Esperar resposta\" está sem palavras-chave.");
    }
    if (!temEnvio) erros.push("O fluxo não envia nada: ligue o início a pelo menos uma mensagem.");
  }
  return { grafo, erros: [...new Set(erros)] };
}

const proximoDe = (grafo, noId, saida) => grafo.ligacoes.find(l => l.de === noId && l.saida === saida)?.para || null;

/* ===================== FLUXOS (CRUD) ===================== */

const fluxoDaOrg = (orgId, id) =>
  db.prepare("SELECT * FROM marketing_fluxos WHERE id = ? AND org_id = ? AND apagado_em IS NULL").get(id, orgId);

export function listarFluxos(orgId) {
  return db.prepare(`SELECT f.id, f.nome, f.grafo, f.atualizado_em,
      (SELECT COUNT(*) FROM marketing_campanhas c WHERE c.fluxo_id = f.id) AS disparos
    FROM marketing_fluxos f WHERE f.org_id = ? AND f.apagado_em IS NULL ORDER BY f.atualizado_em DESC`).all(orgId)
    .map(f => {
      let blocos = 0; try { blocos = JSON.parse(f.grafo).nos.length; } catch {}
      return { id: f.id, nome: f.nome, atualizado_em: f.atualizado_em, blocos, disparos: f.disparos };
    });
}

export function criarFluxo(orgId, user, { nome }) {
  exigirPronto(orgId);
  const n = String(nome || "").replace(/\s+/g, " ").trim().slice(0, 80) || "Fluxo sem nome";
  const id = "mf_" + randomUUID();
  const agora = agoraFn();
  db.prepare(`INSERT INTO marketing_fluxos (id,org_id,nome,grafo,criado_por,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?)`)
    .run(id, orgId, n, JSON.stringify(grafoPadrao()), user.id, agora, agora);
  return lerFluxo(orgId, id);
}

export function lerFluxo(orgId, id) {
  const f = fluxoDaOrg(orgId, id);
  if (!f) throw new ErroMarketing(404, "Fluxo não encontrado.");
  let grafo; try { grafo = JSON.parse(f.grafo); } catch { grafo = grafoPadrao(); }
  return { id: f.id, nome: f.nome, grafo, atualizado_em: f.atualizado_em,
    avisos: validarGrafo(grafo, { paraDisparar: true }).erros };
}

export function salvarFluxo(orgId, id, { nome, grafo }) {
  exigirPronto(orgId);
  const f = fluxoDaOrg(orgId, id);
  if (!f) throw new ErroMarketing(404, "Fluxo não encontrado.");
  const { grafo: limpo, erros } = validarGrafo(grafo);
  if (erros.length) throw new ErroMarketing(400, erros[0]);
  const n = nome === undefined ? f.nome : (String(nome || "").replace(/\s+/g, " ").trim().slice(0, 80) || f.nome);
  db.prepare("UPDATE marketing_fluxos SET nome = ?, grafo = ?, atualizado_em = ? WHERE id = ?")
    .run(n, JSON.stringify(limpo), agoraFn(), id);
  return lerFluxo(orgId, id);
}

/* Apagar o fluxo não mexe em disparo nenhum: cada disparo guardou a própria
   cópia do fluxo no momento em que começou. */
export function apagarFluxo(orgId, id) {
  const f = fluxoDaOrg(orgId, id);
  if (!f) throw new ErroMarketing(404, "Fluxo não encontrado.");
  db.prepare("UPDATE marketing_fluxos SET apagado_em = ? WHERE id = ?").run(agoraFn(), id);
}

/* ===================== O PÚBLICO ===================== */

const lista = (v) => Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).slice(0, 200) : [];
export function publicoLimpo(p) {
  const l = p?.leads;
  const leads = l ? {
    todos: !!l.todos,
    tags: lista(l.tags), etapas: lista(l.etapas), temperaturas: lista(l.temperaturas).filter(t => ["QUENTE", "MORNO", "FRIO", "SEM"].includes(t)),
    responsaveis: lista(l.responsaveis), origens: lista(l.origens),
  } : null;
  return { listas: lista(p?.listas), leads };
}
const temFiltro = (l) => l && (l.todos || l.tags.length || l.etapas.length || l.temperaturas.length || l.responsaveis.length || l.origens.length);

/* As opções que a tela oferece para montar o público. */
export function opcoesDePublico(orgId) {
  const tags = db.prepare(`SELECT t.id, t.nome, t.cor, (SELECT COUNT(*) FROM lead_tags lt WHERE lt.tag_id = t.id) AS leads
    FROM tags t WHERE t.org_id = ? ORDER BY t.nome`).all(orgId);
  const etapas = db.prepare(`SELECT s.id, s.name AS nome, p.name AS funil,
      (SELECT COUNT(*) FROM leads l WHERE l.stage_id = s.id) AS leads
    FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.org_id = ? AND COALESCE(s.is_active,1) = 1 AND COALESCE(p.is_active,1) = 1
    ORDER BY p.is_default DESC, p.ordem, p.name, s.ordem`).all(orgId);
  const responsaveis = db.prepare(`SELECT u.id, u.name AS nome, u.role FROM users u
    WHERE u.org_id = ? AND u.status = 'ativo' AND COALESCE(u.master,0) = 0 ORDER BY u.name`).all(orgId);
  const origens = db.prepare(`SELECT origem, COUNT(*) AS leads FROM leads WHERE org_id = ? AND origem IS NOT NULL AND origem <> ''
    GROUP BY origem ORDER BY leads DESC LIMIT 50`).all(orgId).map(o => ({ nome: o.origem, leads: o.leads }));
  const listas = db.prepare(`SELECT id, nome, validos, criado_em FROM marketing_listas
    WHERE org_id = ? AND arquivada_em IS NULL ORDER BY criado_em DESC`).all(orgId);
  return { tags, etapas, responsaveis, origens, listas };
}

/* Quem recebe. Duas fontes, somadas: os contatos das listas escolhidas e os
   leads do CRM que batem com os filtros (dentro de cada filtro vale "qualquer
   um"; entre filtros diferentes, "todos ao mesmo tempo").

   Sai de fora, e a conta diz quantos: quem pediu para sair, número inválido,
   o mesmo número repetido (inclusive com e sem o nono dígito) e quem já está
   no meio de outro disparo — duas campanhas ao mesmo tempo no celular da
   mesma pessoa é o que faz ela bloquear o número. */
export function resolverPublico(orgId, publicoBruto) {
  const publico = publicoLimpo(publicoBruto);
  const bloqueio = new Set(db.prepare("SELECT telefone FROM marketing_bloqueio WHERE org_id = ?").all(orgId).map(r => r.telefone));
  const emAndamento = new Set(db.prepare(`SELECT e.telefone FROM marketing_execucoes e
      JOIN marketing_campanhas c ON c.id = e.campanha_id
    WHERE e.org_id = ? AND e.estado IN ('ativa','aguardando_resposta') AND c.status IN ('rodando','pausada')`)
    .all(orgId).map(r => r.telefone));
  const leadPorTel = new Map();
  for (const l of db.prepare("SELECT id, name, phone FROM leads WHERE org_id = ? AND phone IS NOT NULL AND phone <> ''").all(orgId))
    leadPorTel.set(l.phone, l);

  const resumo = { de_listas: 0, de_leads: 0, bloqueados: 0, repetidos: 0, invalidos: 0, em_andamento: 0 };
  const contatos = [];
  const vistos = new Set();
  const acolher = (bruto, nome, leadId, fonte) => {
    const tel = normalizePhone(String(bruto || "").trim());
    if (!telefoneValido(tel)) { resumo.invalidos++; return; }
    const f = formas(tel);
    if (f.some(x => vistos.has(x))) { resumo.repetidos++; return; }
    f.forEach(x => vistos.add(x));
    if (f.some(x => bloqueio.has(x))) { resumo.bloqueados++; return; }
    if (f.some(x => emAndamento.has(x))) { resumo.em_andamento++; return; }
    const lead = leadId ? { id: leadId } : f.map(x => leadPorTel.get(x)).find(Boolean);
    contatos.push({ telefone: tel, nome: String(nome || lead?.name || "").trim().slice(0, 120), lead_id: lead?.id || null });
    resumo[fonte]++;
  };

  if (publico.listas.length) {
    const em = publico.listas.map(() => "?").join(",");
    const linhas = db.prepare(`SELECT c.telefone, c.nome FROM marketing_contatos c
        JOIN marketing_listas l ON l.id = c.lista_id
      WHERE c.org_id = ? AND l.org_id = ? AND l.arquivada_em IS NULL AND c.lista_id IN (${em})
      ORDER BY c.created_at`).all(orgId, orgId, ...publico.listas);
    for (const r of linhas) acolher(r.telefone, r.nome, null, "de_listas");
  }
  if (temFiltro(publico.leads)) {
    const l = publico.leads;
    const onde = ["l.org_id = ?", "l.phone IS NOT NULL", "l.phone <> ''"];
    const args = [orgId];
    const em = (xs) => xs.map(() => "?").join(",");
    if (l.tags.length) { onde.push(`EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id IN (${em(l.tags)}))`); args.push(...l.tags); }
    if (l.etapas.length) { onde.push(`l.stage_id IN (${em(l.etapas)})`); args.push(...l.etapas); }
    if (l.temperaturas.length) {
      const reais = l.temperaturas.filter(t => t !== "SEM");
      const partes = [];
      if (reais.length) { partes.push(`l.priority IN (${em(reais)})`); args.push(...reais); }
      if (l.temperaturas.includes("SEM")) partes.push("l.priority IS NULL");
      onde.push(`(${partes.join(" OR ")})`);
    }
    if (l.responsaveis.length) {
      const pessoas = l.responsaveis.filter(r => r !== "fila");
      const partes = [];
      if (pessoas.length) { partes.push(`l.assigned_to IN (${em(pessoas)})`); args.push(...pessoas); }
      if (l.responsaveis.includes("fila")) partes.push("l.assigned_to IS NULL");
      onde.push(`(${partes.join(" OR ")})`);
    }
    if (l.origens.length) { onde.push(`l.origem IN (${em(l.origens)})`); args.push(...l.origens); }
    const leads = db.prepare(`SELECT l.id, l.name, l.phone FROM leads l WHERE ${onde.join(" AND ")} ORDER BY l.created_at`).all(...args);
    for (const r of leads) acolher(r.phone, r.name, r.id, "de_leads");
  }
  return { publico, contatos, resumo, total: contatos.length };
}

export function previaDoPublico(orgId, publico) {
  const r = resolverPublico(orgId, publico);
  return { total: r.total, resumo: r.resumo, amostra: r.contatos.slice(0, 6).map(c => c.nome || "sem nome") };
}

/* ===================== OS DISPAROS (CAMPANHAS) ===================== */

export const DECLARACAO_DISPARO =
  "Declaro, em nome da imobiliária, que as pessoas deste disparo autorizaram receber mensagens ou têm relação anterior com a imobiliária, e que nenhuma delas veio de lista comprada ou obtida de terceiros sem autorização.";

/* A linha de onde o disparo sai mora em services/marketing.js
   (`linhaDeDisparo`): a de contingência, se houver, senão a da casa. */

export function criarCampanha(orgId, user, { nome, fluxo_id, publico, declaracao, agendar_para }, { ip } = {}) {
  exigirPronto(orgId);
  const eu = db.prepare("SELECT id, name, master, org_id FROM users WHERE id = ?").get(user.id);
  if (eu?.master && eu.org_id !== orgId)
    throw new ErroMarketing(403, "O disparo precisa ser feito pelo gestor desta imobiliária, não pelo ConHub.");
  const linha = linhaDeDisparo(orgId);
  if (!linha.canal) throw new ErroMarketing(409, linha.erro);
  const n = String(nome || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (n.length < 2) throw new ErroMarketing(400, "Dê um nome ao disparo.");
  const f = fluxo_id && fluxoDaOrg(orgId, fluxo_id);
  if (!f) throw new ErroMarketing(400, "Escolha o fluxo que será enviado.");
  const { grafo, erros } = validarGrafo(JSON.parse(f.grafo), { paraDisparar: true });
  if (erros.length) throw new ErroMarketing(422, "O fluxo não está pronto: " + erros[0]);
  if (declaracao !== true) throw new ErroMarketing(400, "Marque a declaração sobre o público para disparar.");
  const r = resolverPublico(orgId, publico);
  if (!r.total) throw new ErroMarketing(422, "Ninguém no público escolhido pode receber este disparo.");

  const id = "mc_" + randomUUID();
  const agora = agoraFn();
  /* AGENDAR (27/09/2026): a imobiliária escolhe quando o disparo começa.
     Sem data, começa agora. A data vale como a primeira ação de cada pessoa
     — daí para frente o ritmo do número decide o espaçamento. */
  let quando = agora, agendada = null;
  if (agendar_para !== undefined && agendar_para !== null && agendar_para !== "") {
    const t = typeof agendar_para === "number" ? agendar_para : new Date(agendar_para).getTime();
    if (!Number.isFinite(t)) throw new ErroMarketing(400, "Data do agendamento inválida.");
    if (t < agora - 60000) throw new ErroMarketing(400, "Essa data já passou. Escolha um horário no futuro, ou comece agora.");
    if (t > agora + 90 * 86400000) throw new ErroMarketing(400, "Dá para agendar até 90 dias à frente.");
    if (t > agora + 60000) { quando = t; agendada = t; }
  }
  const inicio = grafo.nos.find(x => x.tipo === "inicio").id;
  db.transaction(() => {
    db.prepare(`INSERT INTO marketing_campanhas (id,org_id,nome,fluxo_id,fluxo_nome,grafo,publico,declaracao,status,total,
        criado_por,criado_por_nome,ip,criado_em,iniciada_em,agendada_para) VALUES (?,?,?,?,?,?,?,?,'rodando',?,?,?,?,?,?,?)`)
      .run(id, orgId, n, f.id, f.nome, JSON.stringify(grafo), JSON.stringify({ ...r.publico, resumo: r.resumo }),
        DECLARACAO_DISPARO, r.total, eu?.id || user.id, eu?.name || null, ip || null, agora, quando, agendada);
    const ins = db.prepare(`INSERT INTO marketing_execucoes (id,org_id,campanha_id,telefone,nome,lead_id,no_atual,estado,proxima_em,criado_em,atualizado_em)
      VALUES (?,?,?,?,?,?,?,'ativa',?,?,?)`);
    for (const c of r.contatos) ins.run("me_" + randomUUID(), orgId, id, c.telefone, c.nome || null, c.lead_id, inicio, quando, agora, agora);
  })();
  console.log(`[disparo] "${n}" ${agendada ? `agendado para ${new Date(agendada).toISOString()}` : "começou"} para ${r.total} pessoa(s) em ${orgId} (por ${eu?.name})`);
  return relatorio(orgId, id);
}

const campanhaDaOrg = (orgId, id) => db.prepare("SELECT * FROM marketing_campanhas WHERE id = ? AND org_id = ?").get(id, orgId);

export function pausar(orgId, id, user) {
  const c = campanhaDaOrg(orgId, id);
  if (!c) throw new ErroMarketing(404, "Disparo não encontrado.");
  if (c.status !== "rodando") throw new ErroMarketing(409, "Este disparo não está rodando.");
  db.prepare("UPDATE marketing_campanhas SET status = 'pausada', motivo = ? WHERE id = ?").run(`Pausado por ${user.name || "gestor"}.`, id);
  return relatorio(orgId, id);
}
export function retomar(orgId, id) {
  exigirPronto(orgId);
  const c = campanhaDaOrg(orgId, id);
  if (!c) throw new ErroMarketing(404, "Disparo não encontrado.");
  if (c.status !== "pausada") throw new ErroMarketing(409, "Só dá para retomar um disparo pausado.");
  const linha = linhaDeDisparo(orgId);
  if (!linha.canal) throw new ErroMarketing(409, linha.erro);
  db.prepare("UPDATE marketing_campanhas SET status = 'rodando', motivo = NULL, falhas_seguidas = 0 WHERE id = ?").run(id);
  return relatorio(orgId, id);
}
export function cancelar(orgId, id) {
  const c = campanhaDaOrg(orgId, id);
  if (!c) throw new ErroMarketing(404, "Disparo não encontrado.");
  if (!["rodando", "pausada"].includes(c.status)) throw new ErroMarketing(409, "Este disparo já terminou.");
  const agora = agoraFn();
  db.transaction(() => {
    db.prepare("UPDATE marketing_campanhas SET status = 'cancelada', concluida_em = ? WHERE id = ?").run(agora, id);
    db.prepare(`UPDATE marketing_execucoes SET estado = 'cancelada', fim_motivo = 'disparo cancelado', atualizado_em = ?
      WHERE campanha_id = ? AND estado IN ('ativa','aguardando_resposta')`).run(agora, id);
  })();
  return relatorio(orgId, id);
}

function contagens(id) {
  const est = Object.fromEntries(db.prepare("SELECT estado, COUNT(*) n FROM marketing_execucoes WHERE campanha_id = ? GROUP BY estado").all(id).map(r => [r.estado, r.n]));
  const env = db.prepare(`SELECT SUM(status='ok') ok, SUM(status='falha') falha, COUNT(DISTINCT CASE WHEN status='ok' THEN execucao_id END) pessoas
    FROM marketing_envios WHERE campanha_id = ?`).get(id);
  const responderam = db.prepare("SELECT COUNT(*) n FROM marketing_execucoes WHERE campanha_id = ? AND respondeu = 1").get(id).n;
  return {
    em_andamento: (est.ativa || 0) + (est.aguardando_resposta || 0),
    esperando_resposta: est.aguardando_resposta || 0,
    concluidas: est.concluida || 0, sairam: est.saiu || 0, assumidas: est.assumida || 0,
    falharam: est.falhou || 0, canceladas: est.cancelada || 0,
    mensagens_enviadas: env.ok || 0, mensagens_com_falha: env.falha || 0, pessoas_alcancadas: env.pessoas || 0,
    responderam,
  };
}

export function listarCampanhas(orgId) {
  return db.prepare("SELECT * FROM marketing_campanhas WHERE org_id = ? ORDER BY criado_em DESC LIMIT 100").all(orgId)
    .map(c => ({ id: c.id, nome: c.nome, fluxo_nome: c.fluxo_nome, status: c.status, motivo: c.motivo, total: c.total,
      criado_por_nome: c.criado_por_nome, criado_em: c.criado_em, concluida_em: c.concluida_em, agendada_para: c.agendada_para || null,
      agendado: !!(c.status === "rodando" && c.agendada_para && c.agendada_para > agoraFn()), ...contagens(c.id) }));
}

/* O relatório de um disparo: os números, e quantas pessoas passaram por
   cada bloco — é o que o ManyChat mostra em cima de cada caixa do fluxo. */
export function relatorio(orgId, id) {
  const c = campanhaDaOrg(orgId, id);
  if (!c) throw new ErroMarketing(404, "Disparo não encontrado.");
  let grafo = { nos: [], ligacoes: [] }; try { grafo = JSON.parse(c.grafo); } catch {}
  let publico = {}; try { publico = JSON.parse(c.publico); } catch {}
  const enviadosPorBloco = Object.fromEntries(db.prepare(`SELECT no_id, COUNT(DISTINCT execucao_id) n FROM marketing_envios
    WHERE campanha_id = ? AND status = 'ok' GROUP BY no_id`).all(id).map(r => [r.no_id, r.n]));
  const paradosPorBloco = Object.fromEntries(db.prepare(`SELECT no_atual, COUNT(*) n FROM marketing_execucoes
    WHERE campanha_id = ? AND estado IN ('ativa','aguardando_resposta') GROUP BY no_atual`).all(id).map(r => [r.no_atual, r.n]));
  const falhas = db.prepare(`SELECT telefone, erro, enviado_em FROM marketing_envios WHERE campanha_id = ? AND status = 'falha'
    ORDER BY enviado_em DESC LIMIT 20`).all(id);
  /* Quando sai a próxima mensagem. Sem isto, um disparo criado no domingo à
     noite fica com tudo em zero até segunda às 8h e parece travado. */
  const proximo = c.status === "rodando"
    ? db.prepare("SELECT MIN(proxima_em) p FROM marketing_execucoes WHERE campanha_id = ? AND estado = 'ativa'").get(id).p : null;
  return {
    agendada_para: c.agendada_para || null,
    agendado: !!(c.agendada_para && c.agendada_para > agoraFn() && !contagens(id).mensagens_enviadas),
    espera_motivo: proximo && proximo > agoraFn() + 60000 && !(c.agendada_para && c.agendada_para > agoraFn()) ? motivoDaEspera(orgId, agoraFn()) : null,
    id: c.id, nome: c.nome, fluxo_nome: c.fluxo_nome, status: c.status, motivo: c.motivo, total: c.total,
    criado_por_nome: c.criado_por_nome, criado_em: c.criado_em, concluida_em: c.concluida_em,
    declaracao: c.declaracao, publico, grafo, ...contagens(id), proximo_envio_em: proximo || null,
    por_bloco: grafo.nos.map(n => ({ id: n.id, tipo: n.tipo, enviados: enviadosPorBloco[n.id] || 0, parados_aqui: paradosPorBloco[n.id] || 0 })),
    falhas,
  };
}

/* POR QUE A PRÓXIMA MENSAGEM AINDA NÃO SAIU, dito com a regra que está
   segurando (27/09/2026: o Ali disparou num domingo às 18h e viu "próxima
   mensagem amanhã às 8h" sem saber por quê — parecia que não funcionava).
   Null quando é só o intervalo entre uma mensagem e outra. */
function motivoDaEspera(orgId, agora) {
  const lim = ritmoDaOrg(orgId);
  const d = new Date(agora);
  if (lim.janela) {
    if (!lim.domingo && d.getDay() === 0) return "Hoje é domingo, e o envio aos domingos está desligado no ritmo de envio.";
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < lim.hora_inicio) return `O envio começa às ${lim.hora_inicio}h, pelo ritmo de envio.`;
    if (h >= lim.hora_fim) return `O envio para às ${lim.hora_fim}h, pelo ritmo de envio.`;
  }
  const hoje = db.prepare("SELECT COUNT(*) n FROM marketing_envios WHERE org_id = ? AND status = 'ok' AND enviado_em >= ?").get(orgId, inicioDoDia(agora)).n;
  if (hoje >= lim.limite_dia) return `O limite de ${lim.limite_dia} mensagens por dia já foi atingido hoje.`;
  return null;
}

/* ===================== O BATIMENTO ===================== */

function dentroDoHorario(agora, lim) {
  if (!lim.janela) return true;   // horário livre: a imobiliária dispara quando quiser
  const d = new Date(agora);
  if (!lim.domingo && d.getDay() === 0) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return h >= lim.hora_inicio && h < lim.hora_fim;
}
function proximaAbertura(agora, lim) {
  if (!lim.janela) return agora;
  const d = new Date(agora);
  for (let i = 0; i < 8; i++) {
    const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, lim.hora_inicio, 0, 0, 0);
    if (!lim.domingo && dia.getDay() === 0) continue;
    if (dia.getTime() > agora) return dia.getTime();
    const fim = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, lim.hora_fim, 0, 0, 0).getTime();
    if (agora < fim && dentroDoHorario(agora, lim)) return agora;
  }
  return agora + 3600000;
}
const inicioDoDia = (agora) => { const d = new Date(agora); d.setHours(0, 0, 0, 0); return d.getTime(); };
const aleatorio = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

export const personalizar = (t, nome) => String(t || "").replace(/\{nome\}/gi, String(nome || "").trim().split(/\s+/)[0] || "");

function salvar(e, campos) {
  const pares = Object.entries({ ...campos, atualizado_em: agoraFn() });
  db.prepare(`UPDATE marketing_execucoes SET ${pares.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...pares.map(([, v]) => v), e.id);
  Object.assign(e, campos);
}
const finalizar = (e, estado, motivo = null) => salvar(e, { estado, fim_motivo: motivo, proxima_em: null, espera_ate: null });

function pausarCampanha(id, motivo) {
  db.prepare("UPDATE marketing_campanhas SET status = 'pausada', motivo = ? WHERE id = ? AND status = 'rodando'").run(motivo, id);
  console.warn(`[disparo] campanha ${id} pausada: ${motivo}`);
}

/* A equipe já escreveu para esta pessoa depois de o disparo começar? */
function equipeAssumiu(e) {
  if (!e.lead_id) return false;
  return !!db.prepare(`SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'out' AND from_user_id IS NOT NULL
    AND created_at > ? LIMIT 1`).get(e.lead_id, e.criado_em);
}

/* Registra a mensagem que saiu. Se a pessoa já é lead, ela entra na
   conversa dele — marcada como do disparo, sem autor de equipe (não conta
   como resposta de ninguém no relatório). Se ainda não é, fica guardada e
   entra na conversa quando ela responder e virar lead (`vincularLead`). */
function registrarEnvio(e, camp, no, { texto, midia, waId }, canalId, agora) {
  db.prepare(`INSERT INTO marketing_envios (id,org_id,campanha_id,execucao_id,telefone,lead_id,no_id,texto,media_url,media_mime,media_nome,status,wa_id,enviado_em,canal_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'ok',?,?,?)`).run("mv_" + randomUUID(), e.org_id, camp.id, e.id, e.telefone, e.lead_id, no.id,
    texto || null, midia?.url || null, midia?.mime || null, midia?.nome || null, waId || null, agora, canalId || null);
  if (e.lead_id) inserirNaConversa(e.lead_id, camp.nome, { texto, midia, waId }, canalId, agora);
}
function inserirNaConversa(leadId, campanhaNome, { texto, midia, waId }, canalId, quando) {
  try {
    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,wa_id,created_at,canal_id)
      VALUES (?,?,'out',NULL,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), leadId, `${ROTULO_DISPARO} · ${campanhaNome}`,
      texto || (midia ? midia.nome || "Arquivo" : ""), midia?.url || null, midia?.mime || null, midia?.nome || null, waId || null, quando, canalId);
  } catch (err) {
    // O eco do WhatsApp chegou antes e já gravou esta mensagem (mesmo wa_id).
    if (!/UNIQUE/i.test(err.message)) console.warn("[disparo] não consegui pôr a mensagem na conversa:", err.message);
  }
}

const naoTemWhatsapp = (m) => /não está no WhatsApp|not on whatsapp/i.test(String(m || ""));

/* O que um bloco manda, e como — uma função só para o disparo de verdade e
   para o "Enviar teste para mim" do construtor. Se fossem duas, o teste
   mostraria uma coisa e o disparo mandaria outra. */
async function enviarConteudo({ org, canalId, telefone, nome, no, rodape = "" }) {
  const enviados = [];
  const e = { telefone, nome };
  if (no.tipo === "mensagem") {
    const corpo = personalizar(no.dados.texto, e.nome).trim();
    const midia = no.dados.midia;
    if (midia && midia.tipo !== "audio") {
      const legenda = (corpo + rodape).trim();
      const r = await sendMedia({ orgId: org, canalId, toPhone: e.telefone, type: midia.tipo, file: midia.url,
        caption: legenda || undefined, docName: midia.tipo === "document" ? midia.nome : undefined, mime: midia.mime });
      enviados.push({ texto: legenda, midia, waId: r?.messageid });
    } else {
      if (midia) {
        const r = await sendMedia({ orgId: org, canalId, toPhone: e.telefone, type: "audio", file: midia.url, mime: midia.mime });
        enviados.push({ texto: "", midia, waId: r?.messageid });
      }
      const t = (corpo + rodape).trim();
      if (t) {
        const r = await sendText({ orgId: org, canalId, toPhone: e.telefone, text: t });
        enviados.push({ texto: t, waId: r?.messageid });
      }
    }
  } else if (no.tipo === "botoes") {
    const botoes = no.dados.botoes.filter(b => b.rotulo);
    const opcoes = botoes.map((b, i) => `${i + 1} - ${b.rotulo}`).join("\n");
    const pergunta = personalizar(no.dados.texto, e.nome).trim();
    const escrito = `${pergunta}${no.dados.escrever_opcoes ? `\n\n${opcoes}` : ""}${rodape}`;
    let r;
    try {
      r = await sendMenu({ orgId: org, canalId, toPhone: e.telefone, text: escrito,
        choices: botoes.map(b => ({ id: b.id, rotulo: b.rotulo })) });
    } catch (err) {
      if (naoTemWhatsapp(err.message)) throw err;
      /* Botões recusados pela API: vai o texto com as opções numeradas, e
         a resposta "1", "2"... é reconhecida do mesmo jeito. */
      console.warn(`[disparo] botões recusados (${err.message}); enviando as opções escritas.`);
      r = await sendText({ orgId: org, canalId, toPhone: e.telefone, text: `${pergunta}\n\n${opcoes}${rodape}` });
    }
    enviados.push({ texto: escrito, waId: r?.messageid });
  }
  return enviados;
}

/* Envia um bloco para uma pessoa, se os limites deixarem agora.
   Devolve "enviado", "adiado" (tenta depois, sem perder o lugar) ou "parado". */
async function enviarBloco(e, no, camp, agora, travadas) {
  const org = e.org_id;
  if (travadas.has(org)) { salvar(e, { no_atual: no.id, proxima_em: travadas.get(org) }); return "adiado"; }
  const linha = linhaDeDisparo(org);
  if (!linha.canal) {
    pausarCampanha(camp.id, linha.erro);
    salvar(e, { no_atual: no.id, proxima_em: agora + 60000 }); return "adiado";
  }
  const bloqueadoAgora = formas(e.telefone).some(x => db.prepare("SELECT 1 FROM marketing_bloqueio WHERE org_id = ? AND telefone = ?").get(org, x));
  if (bloqueadoAgora) { finalizar(e, "saiu", "pediu para sair"); return "parado"; }
  if (equipeAssumiu(e)) { finalizar(e, "assumida", "a equipe assumiu a conversa"); return "parado"; }

  const lim = linha.limites;
  const travar = (quando) => { travadas.set(org, quando); salvar(e, { no_atual: no.id, proxima_em: quando }); return "adiado"; };
  if (!dentroDoHorario(agora, lim)) return travar(proximaAbertura(agora, lim));
  const hoje = db.prepare("SELECT COUNT(*) n FROM marketing_envios WHERE org_id = ? AND status = 'ok' AND enviado_em >= ?").get(org, inicioDoDia(agora)).n;
  if (hoje >= lim.limite_dia) return travar(proximaAbertura(inicioDoDia(agora) + 86400000, lim));
  const proxNumero = proximoEnvioEm(org);
  if (proxNumero && proxNumero > agora) return travar(proxNumero);

  const canalId = linha.canalId;   // nulo = a linha da casa
  const rodape = !e.primeira_enviada ? `\n\n${RODAPE_SAIR}` : "";
  let enviados = [];
  // O eco pode chegar antes do registro (ver services/marca-disparo.js).
  marcarEnvio(org, e.telefone, camp.nome);
  try {
    enviados = await enviarConteudo({ org, canalId, telefone: e.telefone, nome: e.nome, no, rodape });
  } catch (err) {
    desmarcarEnvio(org, e.telefone);
    const erro = String(err.message || err).slice(0, 300);
    db.prepare(`INSERT INTO marketing_envios (id,org_id,campanha_id,execucao_id,telefone,lead_id,no_id,status,erro,enviado_em)
      VALUES (?,?,?,?,?,?,?,'falha',?,?)`).run("mv_" + randomUUID(), org, camp.id, e.id, e.telefone, e.lead_id, no.id, erro, agora);
    // Não esperar à toa: o próximo envio deste número também respeita o intervalo.
    marcarProximoEnvio(org, agora + aleatorio(lim.intervalo_min, lim.intervalo_max) * 1000);
    travadas.set(org, agora + lim.intervalo_min * 1000);
    if (naoTemWhatsapp(erro)) { finalizar(e, "falhou", "o número não tem WhatsApp"); return "parado"; }
    const seguidas = db.prepare("UPDATE marketing_campanhas SET falhas_seguidas = falhas_seguidas + 1 WHERE id = ? RETURNING falhas_seguidas").get(camp.id).falhas_seguidas;
    if (seguidas >= 5) pausarCampanha(camp.id, `Pausado depois de ${seguidas} falhas seguidas no envio — o número pode estar sendo restringido. Último erro: ${erro}`);
    const tentativas = (e.tentativas || 0) + 1;
    if (tentativas >= 3) { finalizar(e, "falhou", erro); return "parado"; }
    salvar(e, { no_atual: no.id, tentativas, proxima_em: agora + 5 * 60000 });
    return "adiado";
  }

  try { for (const env of enviados) registrarEnvio(e, camp, no, env, canalId, agora); }
  finally { desmarcarEnvio(org, e.telefone); }
  db.prepare("UPDATE marketing_campanhas SET falhas_seguidas = 0 WHERE id = ?").run(camp.id);
  const proximo = agora + aleatorio(lim.intervalo_min, lim.intervalo_max) * 1000;
  marcarProximoEnvio(org, proximo);
  travadas.set(org, proximo);
  salvar(e, { primeira_enviada: 1, tentativas: 0 });
  return "enviado";
}

/* Faz uma execução andar pelo fluxo até esbarrar em algo que leva tempo. */
async function avancar(e, agora, travadas, cache) {
  let camp = cache.get(e.campanha_id);
  if (!camp) {
    const c = db.prepare("SELECT * FROM marketing_campanhas WHERE id = ?").get(e.campanha_id);
    let grafo = { nos: [], ligacoes: [] }; try { grafo = JSON.parse(c.grafo); } catch {}
    camp = { ...c, grafo, porId: new Map(grafo.nos.map(n => [n.id, n])) };
    cache.set(c.id, camp);
  }
  if (camp.status !== "rodando") return;
  let noId = e.no_atual;
  for (let passos = 0; passos < 30; passos++) {
    const no = camp.porId.get(noId);
    if (!no) return finalizar(e, "concluida", "fim do fluxo");
    if (no.tipo === "inicio") {
      noId = proximoDe(camp.grafo, no.id, "proximo");
      if (!noId) return finalizar(e, "concluida", "fim do fluxo");
      continue;
    }
    if (no.tipo === "espera") {
      const prox = proximoDe(camp.grafo, no.id, "proximo");
      if (!prox) return finalizar(e, "concluida", "fim do fluxo");
      return salvar(e, { no_atual: prox, proxima_em: agora + no.dados.quantidade * UNIDADES[no.dados.unidade] });
    }
    if (no.tipo === "resposta") {
      const p = no.dados.prazo || PRAZO_PADRAO;
      return salvar(e, { no_atual: no.id, estado: "aguardando_resposta", espera_ate: agora + p.quantidade * UNIDADES[p.unidade] });
    }
    // mensagem ou botões: precisa de vaga para enviar
    const r = await enviarBloco(e, no, camp, agora, travadas);
    if (r !== "enviado") return;
    const statusAgora = db.prepare("SELECT status FROM marketing_campanhas WHERE id = ?").get(camp.id).status;
    if (no.tipo === "botoes") {
      const p = no.dados.prazo || PRAZO_PADRAO;
      return salvar(e, { no_atual: no.id, estado: "aguardando_resposta", espera_ate: agora + p.quantidade * UNIDADES[p.unidade] });
    }
    noId = proximoDe(camp.grafo, no.id, "proximo");
    if (!noId) return finalizar(e, "concluida", "fim do fluxo");
    salvar(e, { no_atual: noId, proxima_em: agora });
    if (statusAgora !== "rodando") return;
  }
  finalizar(e, "falhou", "o fluxo anda em círculo sem enviar nada");
}

/* Segue a saída escolhida de um bloco que esperava resposta. */
function seguir(e, saida, agora, grafo) {
  const prox = proximoDe(grafo, e.no_atual, saida);
  if (!prox) return finalizar(e, "concluida", saida === "sem_resposta" ? "não respondeu no prazo" : "fim do fluxo");
  salvar(e, { no_atual: prox, estado: "ativa", proxima_em: agora, espera_ate: null });
}
const grafoDaCampanha = (id) => { try { return JSON.parse(db.prepare("SELECT grafo FROM marketing_campanhas WHERE id = ?").get(id).grafo); } catch { return { nos: [], ligacoes: [] }; } };

let ocupado = false;
export async function processarDisparos({ agora = agoraFn() } = {}) {
  if (ocupado) return;
  ocupado = true;
  try {
    // 1. Quem esperava resposta e o prazo acabou segue pelo "não respondeu".
    const vencidas = db.prepare(`SELECT e.* FROM marketing_execucoes e JOIN marketing_campanhas c ON c.id = e.campanha_id
      WHERE e.estado = 'aguardando_resposta' AND e.espera_ate <= ? AND c.status = 'rodando' LIMIT 500`).all(agora);
    for (const e of vencidas) seguir(e, "sem_resposta", agora, grafoDaCampanha(e.campanha_id));

    // 2. Quem tem ação marcada para agora.
    const devidas = db.prepare(`SELECT e.* FROM marketing_execucoes e JOIN marketing_campanhas c ON c.id = e.campanha_id
      WHERE e.estado = 'ativa' AND e.proxima_em <= ? AND c.status = 'rodando' ORDER BY e.proxima_em LIMIT 500`).all(agora);
    const travadas = new Map(), cache = new Map();
    for (const e of devidas) {
      try { await avancar(e, agora, travadas, cache); }
      catch (err) { console.error("[disparo] erro ao avançar execução:", err); }
    }

    // 3. Disparo sem ninguém em andamento terminou.
    db.prepare(`UPDATE marketing_campanhas SET status = 'concluida', concluida_em = ?
      WHERE status = 'rodando' AND NOT EXISTS (SELECT 1 FROM marketing_execucoes e
        WHERE e.campanha_id = marketing_campanhas.id AND e.estado IN ('ativa','aguardando_resposta'))`).run(agora);
  } finally { ocupado = false; }
}

/* ===================== A RESPOSTA DO CLIENTE ===================== */

function casar(no, textoRecebido) {
  const t = normalizar(textoRecebido);
  if (!t) return "outra";
  if (no.tipo === "botoes") {
    const botoes = no.dados.botoes.filter(b => b.rotulo);
    const num = /^(\d+)\b/.exec(t);
    if (num && botoes[Number(num[1]) - 1]) return botoes[Number(num[1]) - 1].id;
    const exato = botoes.find(b => normalizar(b.rotulo) === t || b.id === String(textoRecebido || "").trim());
    if (exato) return exato.id;
    /* "Não, obrigada" é o botão Não. O rótulo aparecendo como palavra
       inteira vale; se aparecem dois ("sim... não sei"), vale o que veio
       primeiro na frase. */
    const frase = ` ${t} `;
    const achados = botoes.map(b => ({ b, pos: frase.indexOf(` ${normalizar(b.rotulo)} `) }))
      .filter(x => normalizar(x.b.rotulo) && x.pos >= 0).sort((a, b) => a.pos - b.pos);
    return achados.length ? achados[0].b.id : "outra";
  }
  if (no.tipo === "resposta") {
    const frase = ` ${t} `;
    for (const r of no.dados.regras) {
      const palavras = String(r.palavras || "").split(",").map(normalizar).filter(Boolean);
      if (palavras.some(p => frase.includes(` ${p} `))) return r.id;
    }
    return "outra";
  }
  return "outra";
}

/* Liga ao lead as execuções e as mensagens enviadas antes de ele existir —
   o contato da lista que respondeu e virou lead ganha na conversa o que o
   disparo mandou, com a data certa. */
export function vincularLead(orgId, lead) {
  const f = formas(lead.phone);
  const em = f.map(() => "?").join(",");
  db.prepare(`UPDATE marketing_execucoes SET lead_id = ? WHERE org_id = ? AND lead_id IS NULL AND telefone IN (${em})`).run(lead.id, orgId, ...f);
  const soltos = db.prepare(`SELECT v.*, c.nome AS campanha FROM marketing_envios v
      JOIN marketing_campanhas c ON c.id = v.campanha_id
    WHERE v.org_id = ? AND v.lead_id IS NULL AND v.status = 'ok' AND v.telefone IN (${em}) ORDER BY v.enviado_em`).all(orgId, ...f);
  for (const v of soltos) {
    inserirNaConversa(lead.id, v.campanha, { texto: v.texto, midia: v.media_url ? { url: v.media_url, mime: v.media_mime, nome: v.media_nome } : null, waId: v.wa_id },
      v.canal_id, v.enviado_em);
    db.prepare("UPDATE marketing_envios SET lead_id = ? WHERE id = ?").run(lead.id, v.id);
  }
}

/* ENVIAR TESTE PARA MIM (27/09/2026). Antes de mandar para trezentas pessoas,
   o gestor vê no próprio celular como a mensagem chega — foto, legenda,
   botões ou opções numeradas, rodapé de saída. Vai o começo do fluxo: as
   mensagens seguidas desde o início, pulando as esperas, até o primeiro
   bloco que espera resposta (os botões saem, e o teste para ali). Não vira
   disparo, não conta no limite do dia e não entra em relatório. Freio: dez
   testes por hora por conta — o número é o mesmo do disparo. */
const testes = new Map();
export async function enviarTeste(orgId, fluxoId, { telefone, nome } = {}) {
  exigirPronto(orgId);
  const f = fluxoDaOrg(orgId, fluxoId);
  if (!f) throw new ErroMarketing(404, "Fluxo não encontrado.");
  const tel = normalizePhone(String(telefone || "").trim());
  if (!telefoneValido(tel)) throw new ErroMarketing(400, "Digite o número com DDD, ex.: (87) 99999-0000.");
  const { grafo, erros } = validarGrafo(JSON.parse(f.grafo), { paraDisparar: true });
  if (erros.length) throw new ErroMarketing(422, "Antes do teste: " + erros[0]);
  const linha = linhaDeDisparo(orgId);
  if (!linha.canal) throw new ErroMarketing(409, linha.erro);
  const agora = agoraFn();
  const recentes = (testes.get(orgId) || []).filter(t => t > agora - 3600000);
  if (recentes.length >= 10) throw new ErroMarketing(429, "Muitos testes na última hora. Espere um pouco antes do próximo.");
  testes.set(orgId, [...recentes, agora]);

  const porId = new Map(grafo.nos.map(n => [n.id, n]));
  let no = porId.get(proximoDe(grafo, grafo.nos.find(n => n.tipo === "inicio").id, "proximo"));
  let mensagens = 0, primeira = true, parou = "fim do fluxo";
  for (let passos = 0; no && passos < 12; passos++) {
    if (no.tipo === "espera") { no = porId.get(proximoDe(grafo, no.id, "proximo")); continue; }
    if (no.tipo === "resposta") { parou = "esperar resposta"; break; }
    marcarEnvio(orgId, tel, "teste");
    let env;
    try {
      env = await enviarConteudo({ org: orgId, canalId: linha.canalId, telefone: tel, nome: nome || "Teste",
        no, rodape: primeira ? `\n\n${RODAPE_SAIR}` : "" });
    } finally { desmarcarEnvio(orgId, tel); }
    mensagens += env.length; primeira = false;
    if (no.tipo === "botoes") { parou = "botões"; break; }
    no = porId.get(proximoDe(grafo, no.id, "proximo"));
  }
  return { mensagens, parou, pelo: linha.propria ? "número de contingência" : "número de atendimento" };
}

/* A pessoa está no meio de um fluxo de disparo (em andamento ou pausado)?
   O robô de atendimento usa isto para não responder por cima do fluxo. */
export function emFluxoDeDisparo(orgId, phone) {
  if (!orgId || !phone) return false;
  const f = formas(phone);
  return !!db.prepare(`SELECT 1 FROM marketing_execucoes e JOIN marketing_campanhas c ON c.id = e.campanha_id
    WHERE e.org_id = ? AND e.telefone IN (${f.map(() => "?").join(",")}) AND e.estado IN ('ativa','aguardando_resposta')
      AND e.primeira_enviada = 1 AND c.status IN ('rodando','pausada') LIMIT 1`).get(orgId, ...f);
}
/* Qual disparo alcançou este número por último (o nome da campanha), ou
   null. É o que faz o lead que nasce respondendo pela linha da casa entrar
   com origem "Disparo" — e com a CAMPANHA gravada, para aparecer no
   relatório de Campanhas e nos filtros de campanha de toda tela, como um
   lead da Meta aparece com a campanha do anúncio. */
export function campanhaQueAlcancou(orgId, phone) {
  if (!orgId || !phone) return null;
  const f = formas(phone);
  const r = db.prepare(`SELECT c.nome FROM marketing_envios v JOIN marketing_campanhas c ON c.id = v.campanha_id
    WHERE v.org_id = ? AND v.status = 'ok' AND v.telefone IN (${f.map(() => "?").join(",")})
    ORDER BY v.enviado_em DESC LIMIT 1`).get(orgId, ...f);
  return r ? r.nome : null;
}

/* Esta mensagem que SAIU do número (webhook com fromMe) é o eco de um envio
   do disparo? Devolve o nome da campanha, ou null. Dois caminhos: o envio
   ainda está no ar (o eco chegou antes do registro) ou o registro já existe
   com o mesmo id do WhatsApp — o contato da lista que também é lead, mas foi
   alcançado pela lista, não tem a mensagem na conversa para o eco casar. */
export function ecoDeDisparo(orgId, phone, messageid) {
  const agora = envioEmCurso(orgId, phone);
  if (agora) return agora.campanha || ROTULO_DISPARO;
  if (!messageid) return null;
  const r = db.prepare(`SELECT c.nome FROM marketing_envios v JOIN marketing_campanhas c ON c.id = v.campanha_id
    WHERE v.org_id = ? AND v.wa_id = ? LIMIT 1`).get(orgId, messageid);
  return r ? r.nome : null;
}

/* ===================== NO RELATÓRIO DA IMOBILIÁRIA =====================

   Os disparos que tiveram envio no período, com o que cada um virou — é o
   que entra em Operação → Campanhas, ao lado das campanhas da Meta. O
   período escolhe QUAIS disparos aparecem; os números são do disparo
   INTEIRO. Cortar pela metade faria "responderam" passar de "alcançados"
   (a resposta de hoje a uma mensagem de ontem), e um número impossível
   derruba a confiança na tabela toda. */
export function resumoDeDisparos(orgId, { de, ate }) {
  const campanhas = db.prepare(`SELECT DISTINCT c.id, c.nome, c.status, c.criado_em FROM marketing_campanhas c
    JOIN marketing_envios v ON v.campanha_id = c.id
    WHERE c.org_id = ? AND v.status = 'ok' AND v.enviado_em BETWEEN ? AND ?
    ORDER BY c.criado_em DESC`).all(orgId, de, ate);
  return campanhas.map(c => {
    const n = contagens(c.id);
    const leadsNovos = db.prepare(`SELECT COUNT(*) n FROM leads WHERE org_id = ? AND platform = 'disparo'
      AND campaign_name = ? AND created_at >= ?`).get(orgId, c.nome, c.criado_em).n;
    /* Venda de quem o disparo alcançou, fechada DEPOIS de ele começar. Não
       quer dizer que o disparo vendeu — quer dizer que a venda veio de alguém
       que ele tocou, e é assim que a coluna se chama na tela. */
    const vendas = db.prepare(`SELECT COUNT(DISTINCT l.id) n, COALESCE(SUM(l.sale_value), 0) vgv FROM (
        SELECT DISTINCT lead_id FROM marketing_execucoes WHERE campanha_id = ? AND lead_id IS NOT NULL) x
      JOIN leads l ON l.id = x.lead_id
      WHERE l.sale_value IS NOT NULL AND l.sale_date >= ?`).get(c.id, c.criado_em);
    const alcancados = n.pessoas_alcancadas, responderam = n.responderam;
    return { id: c.id, nome: c.nome, status: c.status, criado_em: c.criado_em,
      alcancados, mensagens: n.mensagens_enviadas, responderam, taxa_resposta: alcancados ? Math.round(responderam / alcancados * 1000) / 10 : 0,
      sairam: n.sairam, leads_novos: leadsNovos, vendas: vendas.n, vgv: vendas.vgv };
  });
}

/* Chamado pelo caminho de toda mensagem que chega (mensageria.js), depois de
   ela já estar gravada na conversa. Nunca lança. */
export function mensagemRecebida({ orgId, lead, texto: recebido, fromMe }) {
  if (fromMe || !lead?.phone) return;
  try {
    vincularLead(orgId, lead);
    const f = formas(lead.phone);
    const em = f.map(() => "?").join(",");
    const agora = agoraFn();
    /* Só responde quem RECEBEU alguma coisa. Mensagem de quem está na fila
       do disparo mas ainda não recebeu nada (o disparo esperando o horário,
       por exemplo) não é resposta a ele — contá-la mostrava "1 respondeu"
       com zero mensagens enviadas. */
    db.prepare(`UPDATE marketing_execucoes SET respondeu = 1 WHERE org_id = ? AND telefone IN (${em})
      AND estado IN ('ativa','aguardando_resposta') AND primeira_enviada = 1`).run(orgId, ...f);
    const e = db.prepare(`SELECT e.* FROM marketing_execucoes e JOIN marketing_campanhas c ON c.id = e.campanha_id
      WHERE e.org_id = ? AND e.telefone IN (${em}) AND e.estado = 'aguardando_resposta' AND c.status = 'rodando'
      ORDER BY e.atualizado_em DESC LIMIT 1`).get(orgId, ...f);
    if (!e) return;
    const grafo = grafoDaCampanha(e.campanha_id);
    const no = grafo.nos.find(n => n.id === e.no_atual);
    if (!no) return finalizar(e, "concluida", "fim do fluxo");
    seguir(e, casar(no, recebido), agora, grafo);
  } catch (err) {
    console.warn("[disparo] não consegui tratar a resposta:", err.message);
  }
}
