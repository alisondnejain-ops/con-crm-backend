/* MARKETING — a estrutura que vem ANTES do disparo em massa (27/09/2026).

   Pedido do Ali: "monta a estrutura primeiro — a liberação, o termo de aceite e
   tudo mais". O disparo em si é a próxima etapa. Esta aqui existe para uma
   coisa só: quando alguém perguntar (cliente, Procon, ANPD, juiz) de onde veio
   um contato e quem autorizou a mensagem, o ConHub ter a resposta registrada,
   com nome, data e o arquivo original.

   POR QUE ISSO PROTEGE O CONHUB, e o contrato sozinho não protegeria: pela
   LGPD o operador (o ConHub) só responde junto com a imobiliária quando deixa
   de cumprir a lei ou as instruções dela (art. 42). Um termo dizendo "a culpa é
   da imobiliária" num sistema sem trava nenhuma não convence ninguém; o mesmo
   termo num sistema que RECUSA lista comprada, que obriga a declarar a origem,
   que guarda o original e que respeita quem pediu para sair, sim.

   As cinco peças desta fase:
   1. liberação por conta, feita pelo master no hub (`orgs.marketing_liberado`);
   2. termo de uso versionado, com o aceite registrado;
   3. lista de contatos só entra com a declaração de origem — e "comprada" é
      recusada — e o arquivo original fica guardado, com a impressão digital;
   4. lista de bloqueio permanente: quem pediu para sair nunca volta;
   5. número de disparo SEPARADO, que não pode ser o número que recebe leads. */

import db from "../db.js";
import { createHash, randomUUID } from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { normalizePhone } from "./stages.js";
import { lerXlsx, lerCSV } from "./xlsx.js";
import { numeroAlternativo } from "./uazapi.js";
import { desligarCanal, canalDaCasa, garantirCasa, canalPorId } from "./canais.js";

/* ===== O TERMO =====

   VERSIONADO: mudar uma vírgula no texto exige trocar TERMO_VERSAO, e aí todo
   gestor precisa aceitar de novo antes de mexer em lista ou número. O aceite
   guarda o resumo (hash) do texto exato — assim, anos depois, dá para provar
   qual texto a pessoa leu, mesmo que ele tenha mudado desde então.

   Texto a ser revisado por advogado antes de valer como contrato definitivo;
   trocou o texto, sobe a versão. */
export const TERMO_VERSAO = "3 — 27/09/2026";
export const TERMO_TEXTO = `TERMO DE USO DO DISPARO DE MENSAGENS EM MASSA — ConHub

1. O QUE É ESTE RECURSO
O disparo de mensagens em massa permite que a IMOBILIÁRIA (a empresa titular desta conta no ConHub) envie mensagens pelo WhatsApp, seguindo fluxos montados por ela, a listas de contatos enviadas por ela ou a leads do próprio CRM escolhidos por etiqueta, etapa do funil ou qualificação. O envio sai do número de WhatsApp da própria IMOBILIÁRIA já conectado ao ConHub ou, se ela preferir, de um número cadastrado só para disparo — nos dois casos por uma API não oficial (Uazapi), contratada por ela e em nome dela. As respostas dos contatos entram na conversa do lead no CRM.

2. PAPÉIS NA LEI GERAL DE PROTEÇÃO DE DADOS (LGPD)
A IMOBILIÁRIA é a CONTROLADORA dos dados dos contatos: é ela quem decide quem recebe, o que recebe e com base em qual autorização. O ConHub é OPERADOR: apenas executa as instruções da IMOBILIÁRIA, dentro das travas descritas neste termo.

3. ORIGEM DOS CONTATOS
A IMOBILIÁRIA declara que só enviará mensagens a pessoas com quem tem base legal para isso — consentimento da pessoa, ou relação anterior com ela (legítimo interesse), sempre com a opção de sair. É PROIBIDO usar lista comprada, alugada, raspada da internet ou obtida de terceiros sem autorização das pessoas. A cada lista enviada, a IMOBILIÁRIA declara a origem dos contatos e a data em que foram coletados, e a cada disparo declara que as pessoas escolhidas se enquadram nessa regra; o ConHub guarda essas declarações, o arquivo original e o público de cada disparo para prestação de contas.

4. PEDIDO PARA SAIR
A primeira mensagem que cada pessoa recebe em cada disparo leva a opção de sair ("responda SAIR"), que não pode ser removida. Quem pedir para sair entra numa lista de bloqueio permanente da IMOBILIÁRIA, sai de qualquer disparo em andamento e não recebe novos disparos, mesmo que apareça em outra lista.

5. RISCOS CONHECIDOS
a) A API usada NÃO é a API oficial do WhatsApp e o uso para envio em massa contraria os termos do WhatsApp. O número usado pode ser restringido ou banido a qualquer momento, sem aviso.
b) O ConHub não garante a entrega das mensagens.
c) Por padrão o disparo sai do número de WhatsApp já conectado ao ConHub, o mesmo que recebe os leads. Se esse número for restringido ou banido por causa do disparo, o atendimento por ele também para. A IMOBILIÁRIA pode cadastrar um número separado, só para disparo (contingência), e reconhece que a escolha de disparar pelo número de atendimento é dela. O WhatsApp pessoal de corretores não deve ser usado para disparo.
d) O ConHub aplica limites de envio (quantidade por dia, intervalo entre mensagens e horário comercial) e pausa o disparo quando as falhas se repetem. Os limites reduzem o risco de bloqueio, mas não o eliminam.

6. RESPONSABILIDADE
A IMOBILIÁRIA responde integralmente pelo conteúdo das mensagens, pela escolha dos destinatários e pela origem dos contatos. Se o ConHub for demandado, multado ou condenado por fato decorrente do uso deste recurso pela IMOBILIÁRIA, a IMOBILIÁRIA se obriga a ressarcir o ConHub de todos os valores e custos, inclusive honorários.

7. SUSPENSÃO E REGISTROS
O ConHub pode suspender este recurso a qualquer momento em caso de denúncia, abuso ou descumprimento deste termo. Os registros deste aceite, das listas enviadas, das declarações de origem e dos pedidos para sair são guardados e poderão ser apresentados a autoridades ou em processos.

8. ACEITE
Ao aceitar, a pessoa declara que tem poderes para representar a IMOBILIÁRIA. O aceite fica registrado com o nome, o e-mail, a data, a hora e o endereço de internet de quem aceitou, junto com a versão deste texto.`;

export const TERMO_HASH = createHash("sha256").update(TERMO_TEXTO).digest("hex");

/* A frase que a pessoa marca a cada lista. Fica gravada por extenso junto
   com a lista — é a declaração, não um "aceito" genérico. */
export const DECLARACAO_LISTA =
  "Declaro, em nome da imobiliária, que os contatos desta lista autorizaram receber mensagens ou têm relação anterior com a imobiliária, que a origem informada é verdadeira e que a lista não foi comprada nem obtida de terceiros sem autorização.";

/* ===== ORIGENS DE LISTA =====

   "Comprada" está na lista DE PROPÓSITO, e é recusada. Sem a opção, quem
   comprou a lista escolheria "outra origem" e escreveria qualquer coisa; com
   ela, a resposta honesta fica registrada e o sistema diz não. */
export const ORIGENS = {
  conversaram: { rotulo: "Clientes e leads que já conversaram com a imobiliária" },
  site: { rotulo: "Cadastro no site ou formulário, com autorização para receber mensagens" },
  presencial: { rotulo: "Cadastro presencial (plantão, evento, stand), com autorização" },
  indicacao: { rotulo: "Indicação, com a pessoa ciente do contato" },
  outra: { rotulo: "Outra origem (descreva)", detalhe: true },
  comprada: { rotulo: "Lista comprada, alugada ou recebida de terceiros", recusada: true },
};

// ===== ERROS COM STATUS =====
export class ErroMarketing extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// ===== LIBERAÇÃO E ACEITE =====
export const liberado = (orgId) =>
  !!db.prepare("SELECT marketing_liberado FROM orgs WHERE id = ?").get(orgId)?.marketing_liberado;

export const aceiteVigente = (orgId) => db.prepare(
  "SELECT * FROM marketing_termos WHERE org_id = ? AND versao = ? ORDER BY aceito_em DESC LIMIT 1").get(orgId, TERMO_VERSAO) || null;

/* As duas travas de tudo que vem depois: recurso liberado e termo da versão
   atual aceito. Ficam num lugar só — cada rota nova chama esta, e a esquecida
   seria justamente a que abriria o recurso sem aceite. */
export function exigirPronto(orgId, { termo = true } = {}) {
  if (!liberado(orgId))
    throw new ErroMarketing(403, "O disparo em massa não está liberado para esta conta. Fale com o ConHub.");
  if (termo && !aceiteVigente(orgId))
    throw new ErroMarketing(409, "Aceite o termo de uso do disparo antes de continuar.");
}

/* Quem aceita é o gestor DA imobiliária. O master pode estar dentro de
   qualquer conta pelo hub, e um aceite dele por um cliente não vincularia o
   cliente a nada — seria o ConHub assinando o próprio termo pelo outro lado.
   Na conta de origem dele (a casa dele) vale normalmente. */
export function aceitarTermo(orgId, user, { ip, userAgent }) {
  exigirPronto(orgId, { termo: false });
  const eu = db.prepare("SELECT id, name, email, role, org_id, master FROM users WHERE id = ?").get(user.id);
  if (!eu) throw new ErroMarketing(401, "Sessão inválida.");
  if (eu.master && eu.org_id !== orgId)
    throw new ErroMarketing(403, "O aceite precisa ser feito pelo gestor desta imobiliária, não pelo ConHub.");
  const linha = {
    id: "mt_" + randomUUID(), org_id: orgId, user_id: eu.id, user_nome: eu.name, user_email: eu.email,
    papel: eu.role, versao: TERMO_VERSAO, texto_hash: TERMO_HASH, ip: ip || null,
    user_agent: String(userAgent || "").slice(0, 300) || null, aceito_em: Date.now(),
  };
  db.prepare(`INSERT INTO marketing_termos (id,org_id,user_id,user_nome,user_email,papel,versao,texto_hash,ip,user_agent,aceito_em)
    VALUES (@id,@org_id,@user_id,@user_nome,@user_email,@papel,@versao,@texto_hash,@ip,@user_agent,@aceito_em)`).run(linha);
  console.log(`[marketing] termo v${TERMO_VERSAO} aceito por ${eu.name} (${orgId})`);
  return linha;
}

export const historicoDeAceites = (orgId) => db.prepare(
  `SELECT id, user_nome, user_email, papel, versao, texto_hash, ip, aceito_em
   FROM marketing_termos WHERE org_id = ? ORDER BY aceito_em DESC`).all(orgId);

// ===== TELEFONES =====
const telefoneValido = (t) => /^55\d{10,11}$/.test(t);
/* As duas formas do mesmo celular (com e sem o nono dígito) — o bloqueio e a
   comparação com o número da casa têm que valer para as duas, senão quem
   pediu para sair voltaria a receber por uma diferença de um dígito. */
const formas = (t) => [t, numeroAlternativo(t)].filter(Boolean);

export function bloqueado(orgId, telefone) {
  const f = formas(telefone);
  return !!db.prepare(`SELECT 1 FROM marketing_bloqueio WHERE org_id = ? AND telefone IN (${f.map(() => "?").join(",")})`)
    .get(orgId, ...f);
}

// ===== LISTAS =====

/* Acha as colunas de telefone e nome pelo cabeçalho; sem cabeçalho, a coluna
   de telefone é a que tem mais células parecendo número. */
function lerContatos(matriz) {
  const linhas = matriz.filter(l => l.some(c => String(c || "").trim()));
  if (!linhas.length) return { contatos: [], total: 0 };
  const cab = linhas[0].map(c => String(c || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim());
  let iTel = cab.findIndex(c => /(telefone|celular|whats|fone|numero|contato)/.test(c));
  let iNome = cab.findIndex(c => /nome/.test(c));
  let corpo = linhas;
  if (iTel >= 0) corpo = linhas.slice(1);
  else {
    const colunas = Math.max(...linhas.map(l => l.length));
    let melhor = -1, max = 0;
    for (let c = 0; c < colunas; c++) {
      const n = linhas.filter(l => String(l[c] || "").replace(/\D/g, "").length >= 10).length;
      if (n > max) { max = n; melhor = c; }
    }
    iTel = melhor;
    if (iNome < 0) iNome = melhor === 0 ? 1 : 0;
  }
  if (iTel < 0) return { contatos: [], total: corpo.length };
  return {
    total: corpo.length,
    contatos: corpo.map(l => ({ bruto: l[iTel], nome: iNome >= 0 && iNome !== iTel ? String(l[iNome] || "").trim().slice(0, 120) : "" })),
  };
}

export function criarLista(orgId, user, { nome, origem, origem_detalhe, coletado_em, declaracao, arquivo }, { ip }) {
  exigirPronto(orgId);
  const nomeLista = String(nome || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (nomeLista.length < 2) throw new ErroMarketing(400, "Dê um nome à lista.");
  const o = ORIGENS[origem];
  if (!o) throw new ErroMarketing(400, "Escolha de onde vieram os contatos.");
  if (o.recusada)
    throw new ErroMarketing(422, "Lista comprada, alugada ou recebida de terceiros não pode ser usada: as pessoas não autorizaram receber mensagens da imobiliária. É o caso que a LGPD pune e que faz o número cair.");
  const detalhe = String(origem_detalhe || "").trim().slice(0, 500);
  if (o.detalhe && detalhe.length < 10) throw new ErroMarketing(400, "Descreva de onde vieram os contatos (pelo menos uma frase).");
  const data = String(coletado_em || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new ErroMarketing(400, "Informe quando os contatos foram coletados.");
  if (new Date(`${data}T00:00:00`).getTime() > Date.now()) throw new ErroMarketing(400, "A data da coleta não pode estar no futuro.");
  if (declaracao !== true) throw new ErroMarketing(400, "Marque a declaração de origem para enviar a lista.");
  if (!arquivo || !arquivo.base64) throw new ErroMarketing(400, "Escolha o arquivo da lista (.xlsx ou .csv).");

  const buf = Buffer.from(String(arquivo.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buf.length) throw new ErroMarketing(400, "O arquivo está vazio.");
  if (buf.length > 8 * 1024 * 1024) throw new ErroMarketing(413, "Arquivo muito grande. O limite é 8 MB.");
  let matriz;
  try { matriz = (buf[0] === 0x50 && buf[1] === 0x4b) ? lerXlsx(buf) : lerCSV(buf.toString("utf8")); }
  catch (e) { throw new ErroMarketing(400, "Não consegui ler o arquivo: " + e.message); }

  const { contatos, total } = lerContatos(matriz);
  const vistos = new Set();
  const validos = [];
  let invalidos = 0, repetidos = 0, bloqueados = 0;
  for (const c of contatos) {
    const tel = normalizePhone(String(c.bruto || "").trim());
    if (!telefoneValido(tel)) { invalidos++; continue; }
    if (vistos.has(tel) || vistos.has(numeroAlternativo(tel))) { repetidos++; continue; }
    vistos.add(tel);
    if (bloqueado(orgId, tel)) { bloqueados++; continue; }
    validos.push({ tel, nome: c.nome });
  }
  if (!validos.length)
    throw new ErroMarketing(422, bloqueados
      ? "Todos os números válidos desta lista pediram para sair — nenhum pode receber disparo."
      : "Não encontrei nenhum telefone válido no arquivo. Use uma coluna chamada \"telefone\" ou \"celular\", com DDD.");

  const eu = db.prepare("SELECT id, name FROM users WHERE id = ?").get(user.id);
  const id = "ml_" + randomUUID();
  const agora = Date.now();
  db.transaction(() => {
    db.prepare(`INSERT INTO marketing_listas (id,org_id,nome,origem,origem_detalhe,coletado_em,declaracao,arquivo_nome,
      arquivo_hash,arquivo_bytes,arquivo_gz,total,validos,invalidos,repetidos,bloqueados,criado_por,criado_por_nome,ip,criado_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, orgId, nomeLista, origem, detalhe || null, data, DECLARACAO_LISTA,
      String(arquivo.nome || "lista").slice(0, 200), createHash("sha256").update(buf).digest("hex"), buf.length,
      gzipSync(buf), total, validos.length, invalidos, repetidos, bloqueados, eu?.id || user.id, eu?.name || null, ip || null, agora);
    const ins = db.prepare("INSERT OR IGNORE INTO marketing_contatos (id,org_id,lista_id,telefone,nome,created_at) VALUES (?,?,?,?,?,?)");
    for (const v of validos) ins.run("mc_" + randomUUID(), orgId, id, v.tel, v.nome || null, agora);
  })();
  console.log(`[marketing] lista "${nomeLista}" (${validos.length} contatos, origem ${origem}) enviada por ${eu?.name} em ${orgId}`);
  return resumoLista(db.prepare("SELECT * FROM marketing_listas WHERE id = ?").get(id));
}

function resumoLista(l) {
  return {
    id: l.id, nome: l.nome, origem: l.origem, origem_rotulo: ORIGENS[l.origem]?.rotulo || l.origem,
    origem_detalhe: l.origem_detalhe, coletado_em: l.coletado_em, declaracao: l.declaracao,
    arquivo_nome: l.arquivo_nome, arquivo_hash: l.arquivo_hash, arquivo_bytes: l.arquivo_bytes,
    total: l.total, validos: l.validos, invalidos: l.invalidos, repetidos: l.repetidos, bloqueados: l.bloqueados,
    criado_por_nome: l.criado_por_nome, criado_em: l.criado_em, arquivada_em: l.arquivada_em || null,
  };
}

export const listas = (orgId) => db.prepare(
  "SELECT * FROM marketing_listas WHERE org_id = ? ORDER BY criado_em DESC").all(orgId).map(resumoLista);

/* O arquivo original, como veio. É a prova — por isso ele não sai do banco
   para um endereço público: é dado pessoal, e só gestor e master baixam. */
export function arquivoOriginal(orgId, listaId) {
  const l = db.prepare("SELECT arquivo_nome, arquivo_gz, arquivo_hash FROM marketing_listas WHERE id = ? AND org_id = ?").get(listaId, orgId);
  if (!l || !l.arquivo_gz) throw new ErroMarketing(404, "Lista não encontrada.");
  return { nome: l.arquivo_nome, hash: l.arquivo_hash, buffer: gunzipSync(l.arquivo_gz) };
}

/* ARQUIVAR, não apagar. Os contatos saem de uso (não recebem disparo), mas a
   declaração, o arquivo original e quem enviou continuam guardados — apagar
   isso seria apagar a prestação de contas justamente da lista que alguém quis
   tirar do ar, que costuma ser a lista que deu problema. */
export function arquivarLista(orgId, listaId, user) {
  const l = db.prepare("SELECT id, arquivada_em FROM marketing_listas WHERE id = ? AND org_id = ?").get(listaId, orgId);
  if (!l) throw new ErroMarketing(404, "Lista não encontrada.");
  if (l.arquivada_em) return;
  db.transaction(() => {
    db.prepare("DELETE FROM marketing_contatos WHERE lista_id = ?").run(listaId);
    db.prepare("UPDATE marketing_listas SET arquivada_em = ?, arquivada_por = ? WHERE id = ?").run(Date.now(), user.id, listaId);
  })();
}

// ===== BLOQUEIO =====

/* Só a MENSAGEM INTEIRA conta como pedido para sair. "Vou sair do trabalho às
   18h" não pode tirar ninguém da lista — e, pior, o contrário: um pedido
   escondido no meio de uma frase é raro, e o gestor pode bloquear na mão. */
const PALAVRAS_DE_SAIDA = new Set(["sair", "parar", "pare", "stop", "cancelar", "descadastrar", "remover",
  "nao quero", "nao quero mais", "nao quero receber", "me tire da lista", "me tira da lista", "sair da lista"]);
export function pedidoDeSaida(texto) {
  const t = String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  return PALAVRAS_DE_SAIDA.has(t);
}

export function bloquear(orgId, telefone, { motivo = "manual", texto = null, por = null } = {}) {
  const tel = normalizePhone(String(telefone || "").trim());
  if (!telefoneValido(tel)) throw new ErroMarketing(400, "Número inválido. Use DDD + número.");
  db.prepare(`INSERT OR IGNORE INTO marketing_bloqueio (org_id,telefone,motivo,texto,criado_por,criado_em)
    VALUES (?,?,?,?,?,?)`).run(orgId, tel, motivo, texto ? String(texto).slice(0, 200) : null, por, Date.now());
  return tel;
}

/* Chamado pelo webhook a cada mensagem recebida. Só age se a pessoa está em
   alguma lista de marketing desta imobiliária e a mensagem é um pedido de
   saída — nada muda na conversa, que segue para o atendimento normalmente.
   Nunca lança: uma falha aqui não pode impedir a mensagem de entrar. */
export function registrarPedidoDeSaida(orgId, telefone, texto) {
  try {
    if (!telefone || !pedidoDeSaida(texto)) return false;
    const f = formas(telefone);
    const em = f.map(() => "?").join(",");
    /* Está numa lista OU já recebeu (ou vai receber) um disparo — o público
       pode vir dos leads do CRM, que não passam por lista nenhuma. */
    const naLista = db.prepare(`SELECT 1 FROM marketing_contatos WHERE org_id = ? AND telefone IN (${em}) LIMIT 1`).get(orgId, ...f)
      || db.prepare(`SELECT 1 FROM marketing_execucoes WHERE org_id = ? AND telefone IN (${em}) LIMIT 1`).get(orgId, ...f);
    if (!naLista) return false;
    bloquear(orgId, telefone, { motivo: "pediu_sair", texto });
    // E sai de todo disparo em andamento, na hora.
    db.prepare(`UPDATE marketing_execucoes SET estado = 'saiu', respondeu = primeira_enviada, fim_motivo = 'pediu para sair', atualizado_em = ?
      WHERE org_id = ? AND telefone IN (${em}) AND estado IN ('ativa','aguardando_resposta')`).run(Date.now(), orgId, ...f);
    console.log(`[marketing] ${String(telefone).slice(0, 4)}**** pediu para sair das mensagens de ${orgId}`);
    return true;
  } catch (e) {
    console.warn("[marketing] não consegui registrar o pedido de saída:", e.message);
    return false;
  }
}

export const listaDeBloqueio = (orgId, limite = 200) => ({
  total: db.prepare("SELECT COUNT(*) n FROM marketing_bloqueio WHERE org_id = ?").get(orgId).n,
  itens: db.prepare(`SELECT telefone, motivo, texto, criado_em FROM marketing_bloqueio WHERE org_id = ?
    ORDER BY criado_em DESC LIMIT ?`).all(orgId, limite),
});

// ===== NÚMERO DE DISPARO =====

const mascararToken = (t) => t ? `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} caracteres)` : null;
const soDigitos = (v) => String(v || "").replace(/\D/g, "");

// Consulta a instância na Uazapi. Nunca lança; teto de 15s.
async function consultarInstancia(host, token) {
  try {
    const res = await fetch(`${host}/instance/status`, { headers: { token }, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, erro: data.message || data.error || `HTTP ${res.status}` };
    const inst = data.instance || data;
    const flags = (data.status && typeof data.status === "object") ? data.status : {};
    const status = String(inst.status || (typeof data.status === "string" ? data.status : "") || "");
    const conectado = typeof flags.connected === "boolean" ? (flags.connected && flags.loggedIn !== false)
      : status ? ["connected", "open", "online"].includes(status.toLowerCase()) : null;
    const numero = soDigitos(String(inst.owner || inst.number || "").split("@")[0].split(":")[0]);
    return { ok: true, conectado, numero: numero ? normalizePhone(numero) : null };
  } catch (e) {
    return { ok: false, erro: e.name === "TimeoutError" ? "a instância não respondeu em 15 segundos" : e.message };
  }
}

/* Os números que JÁ são de atendimento nesta conta: a linha da casa e as
   linhas pessoais dos corretores. Nenhum deles pode virar número de disparo. */
function numerosDeAtendimento(orgId) {
  const org = db.prepare("SELECT wa_number FROM orgs WHERE id = ?").get(orgId);
  const linhas = db.prepare("SELECT wa_number FROM canais WHERE org_id = ? AND tipo <> 'disparo' AND wa_number IS NOT NULL").all(orgId);
  const set = new Set();
  for (const v of [org?.wa_number, ...linhas.map(l => l.wa_number)]) {
    const t = normalizePhone(soDigitos(v));
    if (telefoneValido(t)) formas(t).forEach(x => set.add(x));
  }
  return set;
}

export async function salvarNumero(orgId, user, { host, token }) {
  exigirPronto(orgId);
  let h = String(host || "").trim().replace(/\/+$/, "");
  const tk = String(token || "").trim();
  if (!h || !tk) throw new ErroMarketing(400, "Preencha o endereço e o token da instância de disparo.");
  if (!/^https?:\/\//i.test(h)) h = "https://" + h;
  let url;
  try { url = new URL(h); } catch { throw new ErroMarketing(400, "Endereço da instância inválido."); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new ErroMarketing(400, "Use o endereço com https://.");

  /* A trava principal desta tela: o token não pode ser de nenhuma linha que
     já existe no ConHub — nem desta conta (seria o número que recebe leads),
     nem de outra (seria o número de outra imobiliária). */
  const emUso = db.prepare("SELECT 1 FROM canais WHERE token = ? AND NOT (org_id = ? AND tipo = 'disparo') LIMIT 1").get(tk, orgId)
    || db.prepare("SELECT 1 FROM orgs WHERE uazapi_token = ? LIMIT 1").get(tk)
    || db.prepare("SELECT 1 FROM marketing_numero WHERE token = ? AND org_id <> ? LIMIT 1").get(tk, orgId);
  if (emUso)
    throw new ErroMarketing(409, "Este token já é de uma linha de atendimento no ConHub. Sem cadastrar nada, o disparo já sai pelo número de atendimento — o número de contingência precisa ser uma instância SEPARADA, com outro número.");

  const inst = await consultarInstancia(h, tk);
  if (inst.ok && inst.numero && numerosDeAtendimento(orgId).has(inst.numero))
    throw new ErroMarketing(409, "Esta instância está conectada ao mesmo número que recebe os leads — o disparo já sai por ele sem cadastrar nada. O número de contingência precisa ser outro.");

  const hostFinal = url.origin + url.pathname.replace(/\/+$/, "");
  db.transaction(() => {
    db.prepare(`INSERT INTO marketing_numero (org_id,host,token,numero,conectado,atualizado_em,atualizado_por)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET host=excluded.host, token=excluded.token,
      numero=excluded.numero, conectado=excluded.conectado, atualizado_em=excluded.atualizado_em, atualizado_por=excluded.atualizado_por`)
      .run(orgId, hostFinal, tk, inst.numero || null,
        inst.conectado == null ? null : (inst.conectado ? 1 : 0), Date.now(), user.id);
    /* A LINHA DE DISPARO VIRA UM CANAL (27/09/2026). É por ela que a
       resposta do cliente chega: o webhook reconhece o token, a mensagem
       entra na conversa do lead e o fluxo "escuta" o que ele disse. Um
       canal por imobiliária, reaproveitado ao trocar a instância. */
    const existente = db.prepare("SELECT id FROM canais WHERE org_id = ? AND tipo = 'disparo'").get(orgId);
    let canalId = existente?.id;
    if (existente)
      db.prepare(`UPDATE canais SET host = ?, token = ?, wa_number = ?, ativo = 1, provider = 'uazapi', conectado_em = ? WHERE id = ?`)
        .run(hostFinal, tk, inst.numero || null, Date.now(), canalId);
    else {
      canalId = "cn_" + randomUUID();
      db.prepare(`INSERT INTO canais (id,org_id,tipo,nome,host,token,wa_number,ativo,criado_por,created_at,conectado_em,provider)
        VALUES (?,?,'disparo','Disparo',?,?,?,1,?,?,?,'uazapi')`)
        .run(canalId, orgId, hostFinal, tk, inst.numero || null, user.id, Date.now(), Date.now());
    }
    db.prepare("UPDATE marketing_numero SET canal_id = ? WHERE org_id = ?").run(canalId, orgId);
  })();
  return numeroDeDisparo(orgId, inst);
}

export function numeroDeDisparo(orgId, consulta = null) {
  const n = db.prepare("SELECT * FROM marketing_numero WHERE org_id = ?").get(orgId);
  if (!n) return null;
  const tel = n.numero || "";
  return {
    host: n.host, token: mascararToken(n.token),
    numero: tel ? `${tel.slice(0, 4)}****${tel.slice(-4)}` : null,
    conectado: n.conectado == null ? null : !!n.conectado,
    atualizado_em: n.atualizado_em,
    consulta: consulta ? { ok: consulta.ok, erro: consulta.erro || null } : undefined,
    limites: ritmoDaOrg(orgId),
  };
}

/* DE ONDE O DISPARO SAI (27/09/2026, pedido do Ali: "por padrão você vai
   utilizar a conexão existente no ConHub; o que fica opcional é colocar um
   número específico para disparo — ele decide se quer um número de
   contingência").

   Com número de disparo cadastrado e conectado, é por ele. Sem, é pela linha
   da CASA — a mesma que recebe os leads. A escolha é da imobiliária, e o
   risco dela está escrito no termo (item 5c) e na tela.

   Número de disparo cadastrado mas DESLIGADO não cai para a casa sozinho:
   quem cadastrou um número de contingência escolheu não arriscar o de
   atendimento, e trocar em silêncio desfaria essa escolha. Fica sem linha, e a
   tela diz por quê.

   A casa na API OFICIAL da Meta não serve: fora de uma conversa aberta nas
   últimas 24h ela só aceita modelo aprovado, e o disparo falharia pessoa a
   pessoa até pausar. Aí é obrigatório o número de disparo. */
export function linhaDeDisparo(orgId) {
  const n = db.prepare("SELECT * FROM marketing_numero WHERE org_id = ?").get(orgId);
  const limites = ritmoDaOrg(orgId);
  if (n) {
    const c = n.canal_id && canalPorId(n.canal_id);
    if (c && c.ativo && c.token) return { canal: c, canalId: c.id, propria: true, limites };
    return { erro: "O número de disparo cadastrado está desligado. Salve-o de novo ou remova-o para disparar pelo número de atendimento.", propria: true, limites };
  }
  garantirCasa(orgId);
  const casa = canalDaCasa(orgId);
  if (casa && casa.provider === "meta")
    return { erro: "O WhatsApp desta conta é a API oficial da Meta, que só envia mensagem fora de conversa com modelo aprovado. Para disparar, cadastre um número de disparo (Uazapi).", propria: false, limites };
  if (!casa || !casa.ativo || !casa.token)
    return { erro: "Conecte o WhatsApp da imobiliária em Configurações → Conexão, ou cadastre um número de disparo.", propria: false, limites };
  return { canal: casa, canalId: null, propria: false, limites };
}

/* O RITMO é da conta, não do número: vale para a linha que estiver
   disparando, seja a da casa ou a de contingência. Mora em tabela própria
   desde que o número de disparo virou opcional — antes ficava na linha do
   número, e sem número não haveria onde guardar. */
export function ritmoDaOrg(orgId) {
  return limitesDoNumero(db.prepare("SELECT * FROM marketing_ritmo WHERE org_id = ?").get(orgId));
}
export function marcarProximoEnvio(orgId, quando) {
  db.prepare(`INSERT INTO marketing_ritmo (org_id, proximo_envio_em) VALUES (?, ?)
    ON CONFLICT(org_id) DO UPDATE SET proximo_envio_em = excluded.proximo_envio_em`).run(orgId, quando);
}
export const proximoEnvioEm = (orgId) =>
  db.prepare("SELECT proximo_envio_em FROM marketing_ritmo WHERE org_id = ?").get(orgId)?.proximo_envio_em || null;

/* OS LIMITES DO ENVIO. Padrão conservador para número de API não oficial:
   150 por dia, de 30 a 90 segundos entre uma mensagem e outra, das 8h às 20h,
   sem domingo. A imobiliária ajusta, dentro de uma régua que não deixa virar
   metralhadora. */
export const limitesDoNumero = (n) => ({
  limite_dia: n?.limite_dia ?? 150, intervalo_min: n?.intervalo_min ?? 30, intervalo_max: n?.intervalo_max ?? 90,
  hora_inicio: n?.hora_inicio ?? 8, hora_fim: n?.hora_fim ?? 20, domingo: !!n?.domingo,
});

export function salvarLimites(orgId, dados) {
  exigirPronto(orgId);
  const inteiro = (v, padrao) => (v === undefined || v === null || v === "") ? padrao : Math.round(Number(v));
  const atual = ritmoDaOrg(orgId);
  const l = {
    limite_dia: inteiro(dados.limite_dia, atual.limite_dia),
    intervalo_min: inteiro(dados.intervalo_min, atual.intervalo_min),
    intervalo_max: inteiro(dados.intervalo_max, atual.intervalo_max),
    hora_inicio: inteiro(dados.hora_inicio, atual.hora_inicio),
    hora_fim: inteiro(dados.hora_fim, atual.hora_fim),
    domingo: dados.domingo === undefined ? atual.domingo : !!dados.domingo,
  };
  if (!(l.limite_dia >= 1 && l.limite_dia <= 1000)) throw new ErroMarketing(400, "O limite por dia vai de 1 a 1000 mensagens.");
  if (!(l.intervalo_min >= 10 && l.intervalo_min <= 3600)) throw new ErroMarketing(400, "O intervalo mínimo vai de 10 segundos a 1 hora.");
  if (!(l.intervalo_max >= l.intervalo_min && l.intervalo_max <= 3600)) throw new ErroMarketing(400, "O intervalo máximo precisa ser maior que o mínimo (até 1 hora).");
  if (!(l.hora_inicio >= 0 && l.hora_inicio <= 23 && l.hora_fim >= 1 && l.hora_fim <= 24 && l.hora_fim > l.hora_inicio))
    throw new ErroMarketing(400, "Horário inválido: o fim precisa ser depois do começo.");
  db.prepare(`INSERT INTO marketing_ritmo (org_id,limite_dia,intervalo_min,intervalo_max,hora_inicio,hora_fim,domingo)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET limite_dia=excluded.limite_dia, intervalo_min=excluded.intervalo_min,
    intervalo_max=excluded.intervalo_max, hora_inicio=excluded.hora_inicio, hora_fim=excluded.hora_fim, domingo=excluded.domingo`)
    .run(orgId, l.limite_dia, l.intervalo_min, l.intervalo_max, l.hora_inicio, l.hora_fim, l.domingo ? 1 : 0);
  return ritmoDaOrg(orgId);
}

/* Tirar o número de disparo desliga a linha (as conversas que estavam nela
   voltam para o número da casa — ver desligarCanal) e PAUSA os disparos em
   andamento. Não seguem sozinhos pela casa: quem tinha um número de
   contingência escolheu não arriscar o de atendimento — retomar é o gestor
   dizendo que agora pode. */
export function removerNumero(orgId) {
  const n = db.prepare("SELECT canal_id FROM marketing_numero WHERE org_id = ?").get(orgId);
  if (n?.canal_id) desligarCanal(n.canal_id);
  db.prepare("DELETE FROM marketing_numero WHERE org_id = ?").run(orgId);
  db.prepare(`UPDATE marketing_campanhas SET status = 'pausada', motivo = 'O número de disparo foi removido. Retome para continuar pelo número de atendimento.'
    WHERE org_id = ? AND status = 'rodando'`).run(orgId);
}


// ===== ESTADO DA TELA =====
export function estado(orgId, user) {
  const a = aceiteVigente(orgId);
  const eu = db.prepare("SELECT master, org_id FROM users WHERE id = ?").get(user.id);
  const ultimo = db.prepare("SELECT versao, aceito_em FROM marketing_termos WHERE org_id = ? ORDER BY aceito_em DESC LIMIT 1").get(orgId);
  return {
    liberado: liberado(orgId),
    termo: {
      versao: TERMO_VERSAO, texto: TERMO_TEXTO, hash: TERMO_HASH,
      aceite: a ? { por: a.user_nome, email: a.user_email, em: a.aceito_em, ip: a.ip } : null,
      // Já aceitou uma versão anterior: a tela diz que o texto mudou.
      versao_anterior: !a && ultimo ? ultimo.versao : null,
      pode_aceitar: !(eu?.master && eu.org_id !== orgId),
    },
    declaracao: DECLARACAO_LISTA,
    origens: Object.entries(ORIGENS).map(([id, o]) => ({ id, rotulo: o.rotulo, detalhe: !!o.detalhe, recusada: !!o.recusada })),
    numero: numeroDeDisparo(orgId),
    limites: ritmoDaOrg(orgId),
    linha: (() => { const l = linhaDeDisparo(orgId);
      return { propria: l.propria, pronta: !!l.canal, erro: l.erro || null }; })(),
    listas: db.prepare("SELECT COUNT(*) n FROM marketing_listas WHERE org_id = ? AND arquivada_em IS NULL").get(orgId).n,
    contatos: db.prepare("SELECT COUNT(DISTINCT telefone) n FROM marketing_contatos WHERE org_id = ?").get(orgId).n,
    bloqueados: db.prepare("SELECT COUNT(*) n FROM marketing_bloqueio WHERE org_id = ?").get(orgId).n,
  };
}

// ===== LIBERAÇÃO PELO MASTER =====
export function definirLiberacao(orgId, ligado, porUserId) {
  db.prepare("UPDATE orgs SET marketing_liberado = ?, marketing_liberado_em = ?, marketing_liberado_por = ? WHERE id = ?")
    .run(ligado ? 1 : 0, Date.now(), porUserId, orgId);
}
