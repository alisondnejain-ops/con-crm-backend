/* O ASSISTENTE DE CONFIGURAÇÃO (05/10/2026, pedido do Ali: "integrar você
   (Claude) ao ConHub, e permitir que o cliente faça as configurações que ele
   precise na conta dele, limitado ao plano que ele contratar").

   A REGRA QUE SEGURA TODO O RESTO: a IA não ganha poder próprio. Cada
   ferramenta dela é uma chamada às MESMAS rotas que a tela usa, com o crachá
   de QUEM está conversando (`chamarRota`). Papel, plano, ferramenta
   contratada, o que é só do master — tudo continua sendo conferido pelo
   servidor, no lugar de sempre. Se a pessoa não pode fazer algo pela tela, a
   IA também não pode, e a recusa volta com a mesma frase que a tela mostraria.
   Regra escrita duas vezes diverge; aqui ela é escrita uma.

   O QUE ELA NÃO FAZ, de propósito: apagar (funil, etapa, tag, lead), mexer em
   cobrança, conexão do WhatsApp, equipe ou senha. Para isso ela leva a pessoa
   até a tela certa (`abrir_tela`). Ação sem volta não sai de uma frase mal
   entendida.

   Tudo o que ela muda fica em `assistente_acoes`: o que, quando e a pedido de
   quem. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { chamarClaude, claudeConfigurado, textoDe, MODELO_ASSISTENTE, ferramentaDePesquisa } from "./claude.js";
import { registrar } from "./iauso.js";
import { MANUAL_CONHUB } from "./ajuda.js";
import { CORES_TAG } from "./tags.js";
import { FERRAMENTAS_LEADS, executorDeLeads } from "./assistente-leads.js";
import { FERRAMENTAS_MARKETING, executorDeMarketing } from "./assistente-marketing.js";

/* ===== TETO DO MÊS =====
   Cada pergunta custa centavos, e "centavos" sem teto vira fatura. O teto é
   por conta e por tipo; passado, o assistente avisa e a nuvem de suporte vai
   direto para uma pessoa. */
export const LIMITES = {
  // 1000 desde 10/10/2026 (era 200 — o gestor batia no teto no meio do mês).
  config: () => Number(process.env.ASSISTENTE_LIMITE_MES || 1000),
  // A consulta é de toda a equipe (atendentes e corretores), então o teto é maior.
  consulta: () => Number(process.env.ASSISTENTE_CONSULTA_LIMITE_MES || 400),
  suporte: () => Number(process.env.SUPORTE_IA_LIMITE_MES || 300),
};
const inicioDoMes = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function usadosNoMes(orgId, tipo) {
  return db.prepare("SELECT COUNT(*) n FROM assistente_turnos WHERE org_id = ? AND tipo = ? AND created_at >= ?")
    .get(orgId, tipo, inicioDoMes()).n;
}

/* ===== CONVERSA GUARDADA ===== */
const agora = () => Date.now();
const json = (t, padrao) => { try { return JSON.parse(t); } catch { return padrao; } };

export function conversaAtual(userId, tipo) {
  return db.prepare("SELECT * FROM assistente_conversas WHERE user_id = ? AND tipo = ? ORDER BY updated_at DESC LIMIT 1")
    .get(userId, tipo) || null;
}
export function novaConversa(user, tipo) {
  const c = { id: "ac_" + randomUUID(), org_id: user.org_id, user_id: user.id, tipo, mensagens: "[]", itens: "[]", created_at: agora(), updated_at: agora() };
  db.prepare(`INSERT INTO assistente_conversas (id,org_id,user_id,tipo,mensagens,itens,created_at,updated_at)
    VALUES (@id,@org_id,@user_id,@tipo,@mensagens,@itens,@created_at,@updated_at)`).run(c);
  return c;
}
export const itensDa = (c) => (c ? json(c.itens, []) : []);
const novoItem = (de, texto, extra = {}) => ({ id: "it_" + randomUUID().slice(0, 12), de, texto, em: agora(), ...extra });

/* ===== O LAÇO DA CONVERSA =====
   Uma pergunta da pessoa pode virar várias idas e voltas: o modelo pede uma
   ferramenta, recebe o resultado, pede outra… até responder. O histórico vai
   e volta EXATAMENTE como a API devolveu (o modelo recusa histórico editado).

   ELE NÃO PARA NO MEIO DO TRABALHO (08/10/2026, pedido do Ali: "o assistente
   está parando de trabalhar depois de um tempo… preciso que ele não pare,
   exatamente como funciona o Claude hoje"). Eram três paradas:
   (1) um teto de 16 passos por pergunta, e ao bater nele o trabalho feito
       SUMIA do histórico — o "continua" seguinte não sabia o que já tinha
       sido feito, refazia tudo e pagava de novo;
   (2) a requisição passava de 5 minutos e o próprio Node a derrubava;
   (3) passando de 60 mensagens a conversa era APAGADA — e uma pergunta com
       ferramentas soma dezenas de mensagens, então isso acontecia a cada
       duas ou três tarefas.
   Agora cada requisição trabalha até um teto de TEMPO (`TEMPO_POR_VEZ`) e de
   passos, e quando para o histórico fica inteiro (`pendente`): a tela manda
   "continuar" sozinha e o trabalho segue de onde estava, sem gastar pergunta
   do mês. E a conversa longa é RESUMIDA, não apagada (`compactar`). */
const VOLTAS = 25;
const TEMPO_POR_VEZ = 150000;      // ms de trabalho por requisição (o Node derruba aos 300 s)
const TEMPO_TOTAL = 280000;
/* Resumir quando o pedido passa disto: abaixo de 100 mil tokens o Haiku 5.5
   cobra a tabela barata, acima dela cinco vezes mais. */
const RESUMIR_ACIMA = Number(process.env.ASSISTENTE_RESUMIR_TOKENS || 70000);
const PESADO = (b) => b && (b.type === "image" || b.type === "document");
const RESUMIR_COM_ARQUIVOS = 8 * 1024 * 1024;   // bytes de arquivo guardados no histórico

/* Quanto de arquivo o histórico está carregando. Cada pergunta reenvia tudo,
   e a API recusa pedido grande demais. */
function pesoDeArquivos(mensagens) {
  let n = 0;
  for (const m of mensagens) for (const b of (Array.isArray(m.content) ? m.content : [])) {
    if (PESADO(b)) n += String(b.source?.data || "").length;
  }
  return n;
}

/* A CONVERSA LONGA É RESUMIDA (compactação simples, a que a documentação da
   Anthropic recomenda para quem monta o histórico na mão): a própria IA
   escreve o resumo do que foi pedido, do que já foi feito e do que falta, e a
   conversa recomeça a partir dele — sem nenhum bloco antigo, então não há
   histórico "editado" para a API recusar. Antes ela era simplesmente apagada,
   e o assistente esquecia no meio da tarefa o que tinha acabado de fazer. */
const PEDIDO_DE_RESUMO = `Pare aqui e escreva um RESUMO desta conversa para você mesmo continuar o trabalho depois, sem ela. Não chame ferramentas. Inclua, em tópicos curtos:
- o que a pessoa pediu (com as palavras e números dela);
- o que você JÁ FEZ na conta, com os nomes e ids que importam (funis, etapas, fluxos, leads, tags);
- o que ainda FALTA fazer, se faltar, e o próximo passo;
- decisões e preferências que a pessoa deixou claras;
- confirmações pendentes (códigos de prévia ainda não confirmados).
Escreva só o resumo.`;
async function compactar({ mensagens, system, tools, user, tipo }) {
  const pedido = mensagens.slice();
  const ultima = pedido[pedido.length - 1];
  // Terminou em resultado de ferramenta: o pedido de resumo entra na mesma mensagem.
  if (ultima && ultima.role === "user") {
    const conteudo = Array.isArray(ultima.content) ? ultima.content : [{ type: "text", text: String(ultima.content) }];
    pedido[pedido.length - 1] = { role: "user", content: [...conteudo, { type: "text", text: PEDIDO_DE_RESUMO }] };
  } else pedido.push({ role: "user", content: PEDIDO_DE_RESUMO });
  const r = await chamarClaude({ system, messages: pedido, tools, tool_choice: tools?.length ? { type: "none" } : undefined, effort: "low", max_tokens: 6000 });
  if (!r.ok) return null;
  registrar({ orgId: user.org_id, userId: user.id, recurso: { config: "assistente", consulta: "consulta" }[tipo] || "suporte", uso: r.uso, modelo: r.modelo, custo: r.custo ?? undefined });
  const resumo = textoDe(r.resposta);
  return resumo ? resumo.slice(0, 20000) : null;
}

/* `anexos` (só do gestor, ver assistente-anexos.js): os blocos de arquivo vão
   ANTES do texto na mensagem da pessoa, e a tela guarda só o nome de cada um.
   `voltas`: o teto de passos de UMA requisição — passou dele, o trabalho fica
   pendente e continua na próxima, não se perde.
   `continuar`: a requisição é a continuação automática de um trabalho que
   parou pelo tempo ou pelos passos — não é pergunta nova (não conta no mês e
   não aparece como fala da pessoa). */
export async function conversar({ conversa, user, tipo, texto, system, tools, executar, effort, anexos = null, voltas = VOLTAS, continuar = false }) {
  const comecou = Date.now();
  let mensagens = json(conversa.mensagens, []);
  const itens = json(conversa.itens, []);
  const novos = [];
  if (continuar && !conversa.pendente) return { itens: [], falhou: false, parou: false, nada: true };

  /* Resumir ANTES de juntar a pergunta nova, entre um trabalho e outro: o
     pedido de resumo é o histórico que já foi aceito mais uma linha. */
  let contextoInicial = conversa.contexto_tokens || 0;
  const grande = (conversa.contexto_tokens || 0) > RESUMIR_ACIMA || pesoDeArquivos(mensagens) > RESUMIR_COM_ARQUIVOS || mensagens.length > 300;
  if (grande && mensagens.length) {
    const resumo = await compactar({ mensagens, system, tools, user, tipo });
    /* O resumo vira a primeira mensagem da conversa nova, e a pergunta da
       vez entra junto dela logo abaixo. Se a IA cair na primeira chamada,
       é o resumo que fica — não uma conversa vazia. */
    mensagens = resumo ? [{ role: "user", content: [{ type: "text", text: `[Resumo do que aconteceu antes nesta conversa — você mesmo escreveu]\n${resumo}` }] }] : [];
    novos.push(novoItem("sistema", resumo
      ? "A conversa ficou longa: resumi o que já foi feito e continuei daqui, sem perder o fio."
      : "A conversa ficou longa e recomeçou daqui. O que já foi feito na conta continua feito."));
    contextoInicial = 0;
  }

  const blocos = anexos?.blocos || [];
  if (!continuar) novos.push(novoItem("voce", texto, anexos?.resumo?.length ? { anexos: anexos.resumo } : {}));
  /* `pergunta` identifica ESTA mensagem da pessoa: a prévia de uma ação em
     massa guarda a pergunta em que nasceu, e só executa numa outra — quem
     confirma é a pessoa respondendo, não o modelo no embalo. A continuação
     automática é a MESMA pergunta (guardada na conversa): senão a IA poderia
     confirmar sozinha, na continuação, a prévia que ela mesma acabou de abrir. */
  const pergunta = continuar && conversa.pergunta_em_curso ? conversa.pergunta_em_curso : randomUUID();
  const efeitos = { navegar: null, humano: null, menu: undefined, pergunta };
  const textoDaVez = continuar
    ? "[continuação automática: o trabalho anterior parou só pelo limite de tempo de uma requisição. Continue exatamente de onde parou, sem refazer o que já foi feito. Se já terminou, diga em uma frase.]"
    : texto;
  const conteudoNovo = [
    ...blocos,
    { type: "text", text: textoDaVez },
  ];
  /* Parou no meio: a última mensagem é o resultado das ferramentas. A fala
     nova entra NA MESMA mensagem (duas mensagens seguidas da pessoa não são
     histórico válido) — e o que foi feito continua ali, à vista da IA. */
  const base = mensagens.slice();
  const ultima = mensagens[mensagens.length - 1];
  if (ultima && ultima.role === "user") {
    const antes = Array.isArray(ultima.content) ? ultima.content : [{ type: "text", text: String(ultima.content) }];
    mensagens[mensagens.length - 1] = { role: "user", content: [...antes, ...conteudoNovo] };
  } else {
    mensagens.push({ role: "user", content: conteudoNovo.length === 1 ? textoDaVez : conteudoNovo });
  }
  /* A pergunta conta no teto do mês já aqui (duas abas não passam juntas do
     limite), e é DEVOLVIDA se a IA falhar antes de responder qualquer coisa:
     "a IA não conseguiu responder" não pode gastar a cota de quem perguntou. */
  const turnoId = continuar ? null : "at_" + randomUUID();
  if (turnoId) db.prepare("INSERT INTO assistente_turnos (id,org_id,user_id,tipo,created_at) VALUES (?,?,?,?,?)")
    .run(turnoId, user.org_id, user.id, tipo, agora());
  let falhouNaPrimeira = false;

  let falhou = null, pausada = false, parou = false, contexto = contextoInicial;
  for (let volta = 0; ; volta++) {
    const decorrido = Date.now() - comecou;
    if (volta >= voltas || (volta > 0 && decorrido > TEMPO_POR_VEZ)) { parou = true; break; }
    const r = await chamarClaude({ system, messages: mensagens, tools, effort, timeoutMs: Math.max(30000, Math.min(180000, TEMPO_TOTAL - decorrido)) });
    if (!r.ok) { falhou = r.erro; if (volta === 0) { mensagens = base; falhouNaPrimeira = true; } break; }
    registrar({ orgId: user.org_id, userId: user.id, recurso: { config: "assistente", consulta: "consulta" }[tipo] || "suporte", uso: r.uso, modelo: r.modelo, custo: r.custo ?? undefined });
    contexto = r.uso?.entrada || contexto;
    const resp = r.resposta;

    /* Recusa do filtro de segurança: o conteúdo pode vir vazio, e resposta
       vazia no histórico faria a API recusar todas as próximas. Na primeira
       volta sai a pergunta que provocou a recusa; depois dela, fica o que já
       foi feito. A conversa continua utilizável. */
    if (resp.stop_reason === "refusal") {
      if (volta === 0) mensagens = base;
      pausada = false;
      novos.push(novoItem("assistente", "Não consigo ajudar com isso por aqui. Se precisar, fale com o suporte."));
      break;
    }
    if (!Array.isArray(resp.content) || !resp.content.length) { falhou = "A IA não respondeu nada."; if (volta === 0) { mensagens = base; falhouNaPrimeira = true; } break; }
    /* PESQUISA NA WEB PAUSADA (`pause_turn`): a pesquisa roda nos servidores
       da Anthropic e, quando demora, a API devolve a resposta pela metade.
       Para continuar, ela é mandada de volta como está; o que vem depois é a
       continuação da MESMA fala, e por isso entra junto dela — duas falas
       seguidas do assistente não são um histórico válido. */
    if (pausada) mensagens[mensagens.length - 1] = { role: "assistant", content: mensagens[mensagens.length - 1].content.concat(resp.content) };
    else mensagens.push({ role: "assistant", content: resp.content });
    pausada = resp.stop_reason === "pause_turn";
    const fala = textoDe(resp);
    const fontes = fontesDe(resp);
    if (fala) novos.push(novoItem("assistente", fala, fontes.length ? { fontes } : {}));
    if (pausada) continue;

    // A fala passou do tamanho máximo de uma resposta: segue na continuação.
    if (resp.stop_reason === "max_tokens") { parou = true; break; }
    const pedidos = resp.content.filter(b => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !pedidos.length) break;

    // Todas as respostas das ferramentas voltam numa mensagem só.
    const resultados = [];
    for (const p of pedidos) {
      let saida;
      try { saida = await executar(p.name, p.input || {}, efeitos); }
      catch (e) { saida = { erro: "Falhou: " + e.message }; }
      if (saida && saida.mostrar) novos.push(novoItem(saida.erro ? "erro" : (saida.tipo || "acao"), saida.mostrar));
      resultados.push({ type: "tool_result", tool_use_id: p.id, content: JSON.stringify(saida?.dados ?? saida ?? {}).slice(0, 20000), ...(saida?.erro ? { is_error: true } : {}) });
    }
    mensagens.push({ role: "user", content: resultados });
  }

  /* O histórico precisa terminar numa fala completa do assistente ou numa
     mensagem da pessoa (a pergunta, ou os resultados das ferramentas). Fala
     pela metade (pesquisa pausada, ou cortada pelo tamanho com um pedido de
     ferramenta incompleto) sai — o que foi feito antes dela fica. */
  const u = mensagens[mensagens.length - 1];
  if (u && u.role === "assistant" && (pausada || (u.content || []).some(b => b.type === "tool_use"))) mensagens.pop();
  if (falhou) novos.push(novoItem("erro", falhou));
  if (falhouNaPrimeira && turnoId) db.prepare("DELETE FROM assistente_turnos WHERE id = ?").run(turnoId);
  /* Parou pelo tempo, pelos passos ou pelo tamanho: o trabalho fica PENDENTE
     e a tela pede a continuação sozinha. Erro não continua sozinho — a pessoa
     vê o erro e decide. */
  const pendente = !falhou && parou && mensagens.length > 0;

  const todosItens = itens.concat(novos).slice(-200);
  db.prepare(`UPDATE assistente_conversas SET mensagens = ?, itens = ?, updated_at = ?, contexto_tokens = ?, pendente = ?, pergunta_em_curso = ?
    WHERE id = ?`).run(JSON.stringify(mensagens), JSON.stringify(todosItens), agora(), contexto, pendente ? 1 : 0, pergunta, conversa.id);
  return { itens: novos, navegar: efeitos.navegar, humano: efeitos.humano, ...(efeitos.menu !== undefined ? { menu: efeitos.menu } : {}),
    falhou: !!falhou, parou: pendente };
}

/* As páginas que a pesquisa na web citou, para a pessoa conferir. Vêm nas
   citações dos blocos de texto; repetidas saem, e cinco bastam. */
function fontesDe(resp) {
  const vistas = new Map();
  for (const b of resp?.content || []) {
    for (const c of (b.type === "text" && Array.isArray(b.citations) ? b.citations : [])) {
      if (c.url && !vistas.has(c.url)) vistas.set(c.url, { url: c.url, titulo: String(c.title || c.url).slice(0, 120) });
    }
  }
  return [...vistas.values()].slice(0, 5);
}

/* ===== AS FERRAMENTAS ===== */

/* As telas para onde o assistente pode levar a pessoa. A chave é o nome da
   tela no app (`view`); o texto é o que ela vê no menu. */
export const TELAS = {
  dashboard: "Painel", funil: "Funil", atendimento: "Atender", catraca: "Catraca", imoveis: "Imóveis",
  plantao: "Plantão", gestao: "Operação → Visão geral", relatorios: "Operação → Relatórios",
  marketing: "Marketing → Disparos", fluxos: "Marketing → Fluxos", formularios: "Marketing → Formulários",
  base: "Base de leads", equipe: "Equipe", config: "Configurações", conta: "Minha conta",
};

const sem = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const T = (name, description, properties = {}, required = []) =>
  ({ name, description, input_schema: { type: "object", properties, required, additionalProperties: false } });

const FERRAMENTA_ABRIR_TELA = T("abrir_tela",
  "Leva a pessoa até uma tela do ConHub. Use para o que você não faz por aqui (apagar, mandar mensagem ao cliente, WhatsApp, equipe, cobrança) ou quando ela pedir para ver algo.",
  { tela: { type: "string", enum: Object.keys(TELAS) }, motivo: { type: "string", description: "Uma frase curta: o que ela vai fazer lá (ex.: 'na aba Conexão, toque em Conectar')." } },
  ["tela", "motivo"]);

/* A ORDEM DO MENU DA PRÓPRIA PESSOA (05/10/2026, pedido do Ali: o corretor
   "consegue reorganizar a própria conta… mudar função de posição, só não pode
   mudar o nome das funções"). Vale nos dois modos e mexe só no menu de quem
   conversa — nunca no de outra pessoa nem no da conta.

   O menu vem da TELA, junto com a pergunta (`menu`): é o navegador que sabe
   quais telas esta pessoa vê, e uma segunda lista aqui divergiria no primeiro
   item novo. A ferramenta só aceita chaves que estão nele, e o que vai ao
   servidor é a lista de chaves — os nomes continuam vindo do código. */
const FERRAMENTAS_MENU = [
  T("ver_meu_menu", "Mostra o menu de quem conversa, na ordem atual: cada item com id, nome e seção. Chame antes de reorganizar."),
  T("organizar_meu_menu", "Muda a ORDEM do menu de quem conversa (só dela). Não renomeia nem esconde nada. No computador os itens ficam agrupados por seção, e a ordem vale dentro de cada seção (a seção sobe ou desce junto com o primeiro item dela); no celular vale a ordem exata e os 4 primeiros ficam na barra de baixo.",
    { ordem: { type: "array", items: { type: "string" }, description: "ids de ver_meu_menu na ordem nova — mande TODOS" },
      restaurar: { type: "boolean", description: "true volta à ordem padrão (ignora ordem)" } }),
];

export function executarMenu({ autorizacao, menu, registrar }) {
  const lista = Array.isArray(menu) ? menu : [];
  return async (nome, e, efeitos) => {
    if (nome === "ver_meu_menu") {
      if (!lista.length) return { erro: "Não recebi o menu da tela. Peça para a pessoa fechar e abrir o assistente de novo." };
      return { dados: { menu: lista.map(i => ({ id: i.id, nome: i.rotulo, secao: i.secao })) } };
    }
    if (nome !== "organizar_meu_menu") return null;
    if (!lista.length) return { erro: "Não recebi o menu da tela. Peça para a pessoa fechar e abrir o assistente de novo." };
    let ordem = [];
    if (!e.restaurar) {
      const ids = lista.map(i => i.id);
      const pedidos = (Array.isArray(e.ordem) ? e.ordem : []).map(String);
      const fora = pedidos.filter(id => !ids.includes(id));
      if (fora.length) return { erro: `Estes itens não estão no menu desta pessoa: ${fora.join(", ")}. Use os ids de ver_meu_menu.` };
      if (!pedidos.length) return { erro: "Mande a ordem nova (ids de ver_meu_menu) ou restaurar: true." };
      ordem = [...new Set(pedidos)];
      // O que ficou de fora segue depois, na ordem em que já estava.
      for (const id of ids) if (!ordem.includes(id)) ordem.push(id);
    }
    const r = await chamarRota(autorizacao, "POST", "/auth/me/menu", { ordem });
    registrar && registrar(nome, e, r);
    if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` };
    efeitos.menu = r.dados.menu_ordem || null;
    const rotulo = (id) => (lista.find(i => i.id === id) || {}).rotulo || id;
    return { dados: { ok: true, menu: (efeitos.menu || lista.map(i => i.id)).map(rotulo) },
      mostrar: efeitos.menu ? "✓ Reorganizei o seu menu." : "✓ O seu menu voltou à ordem padrão." };
  };
}

// O menu que a tela mandou: só o formato esperado passa.
export function menuDoCorpo(valor) {
  if (!Array.isArray(valor)) return [];
  const limpo = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
  return valor.slice(0, 40).map(i => ({ id: limpo(i && i.id, 40), rotulo: limpo(i && i.rotulo, 40), secao: limpo(i && i.secao, 30) }))
    .filter(i => /^[a-z][a-z0-9_:-]{0,39}$/.test(i.id) && i.rotulo);
}

export const FERRAMENTAS_CONFIG = [
  T("ver_funis", "Lista os funis da conta com as etapas (ids, prazos, automações) e os modelos prontos. Chame antes de mexer em funil ou etapa — nunca invente id."),
  T("criar_funil", "Cria um funil. Com modelo_id, cria a partir de um modelo pronto (com as etapas dele).",
    { nome: { type: "string" }, modelo_id: { type: "string", description: "id de um modelo de ver_funis (opcional)" } }, ["nome"]),
  T("editar_funil", "Renomeia, liga/desliga ou torna padrão um funil.",
    { funil_id: { type: "string" }, nome: { type: "string" }, ativo: { type: "boolean" }, padrao: { type: "boolean" } }, ["funil_id"]),
  T("criar_etapa", "Cria uma etapa no fim do funil.",
    { funil_id: { type: "string" }, nome: { type: "string" },
      tipo: { type: "string", enum: ["aberto", "ganho", "perdido"], description: "aberto (padrão), ganho (venda/fechou) ou perdido" },
      conta_como_conversao: { type: "boolean" },
      prazo_minutos: { type: "integer", description: "SLA: minutos sem interação até o lead atrasar" } },
    ["funil_id", "nome"]),
  T("editar_etapa", "Muda uma etapa: nome, tipo, prazo (null tira), ligada/desligada, início do processo comercial, campos obrigatórios e o que acontece quando um lead chega nela.",
    { etapa_id: { type: "string" }, nome: { type: "string" },
      tipo: { type: "string", enum: ["aberto", "ganho", "perdido"] },
      ativa: { type: "boolean" },
      prazo_minutos: { type: ["integer", "null"] },
      inicio_comercial: { type: "boolean" },
      conta_como_conversao: { type: "boolean" },
      campos_obrigatorios: { type: "array", items: { type: "string" }, description: "chaves dos campos (de ver_campos) exigidos para entrar na etapa" },
      ao_chegar: { type: "object", additionalProperties: false, description: "O que acontece quando um lead chega na etapa. Só o que vier aqui muda; o resto da regra fica como está.",
        properties: {
          responsavel: { type: "string", enum: ["nao_mexer", "roleta", "catraca", "fila", "pessoa"], description: "roleta = próximo corretor da catraca do lead (ou da principal); catraca = próximo da catraca_id; fila = devolve à fila; pessoa = sempre a pessoa_id" },
          pessoa_id: { type: "string" },
          catraca_id: { type: "string", description: "de ver_catracas" },
          mover_para_funil_id: { type: ["string", "null"] },
          colocar_etiquetas: { type: "array", items: { type: "string" }, description: "ids de ver_tags; [] tira todas" },
          tirar_etiquetas: { type: "array", items: { type: "string" }, description: "ids de ver_tags; [] tira todas" },
          etiqueta_do_corretor: { type: "boolean", description: "coloca uma etiqueta com o nome do corretor que ficou com o lead" } } } },
    ["etapa_id"]),
  T("ordenar_etapas", "Define a ordem das etapas de um funil (lista com TODOS os ids, na ordem nova).",
    { funil_id: { type: "string" }, etapas_ids: { type: "array", items: { type: "string" } } }, ["funil_id", "etapas_ids"]),
  T("ver_equipe", "Lista as pessoas ativas (id, nome, papel) e o funil em que os leads de cada uma entram."),
  T("definir_funil_de_entrada", "Define em que funil nascem os leads que caem com uma pessoa. funil_id vazio = funil padrão.",
    { pessoa_id: { type: "string" }, funil_id: { type: "string" } }, ["pessoa_id", "funil_id"]),
  T("ver_campos", "Lista os campos personalizados (chave, nome, tipo)."),
  T("criar_campo", "Cria um campo personalizado para a ficha do lead.",
    { nome: { type: "string" },
      tipo: { type: "string", enum: ["text", "number", "currency", "select", "multiselect", "date", "boolean", "phone", "email"] },
      opcoes: { type: "array", items: { type: "string" }, description: "para select/multiselect" },
      mostrar_no_card: { type: "boolean" } },
    ["nome", "tipo"]),
  T("ver_tags", "Lista as etiquetas (tags) e as cores permitidas."),
  T("criar_tag", "Cria uma etiqueta.", { nome: { type: "string" }, cor: { type: "string", enum: CORES_TAG } }, ["nome", "cor"]),
  T("ver_mensagens_prontas", "Lista as mensagens prontas (botões acima do campo de conversa)."),
  T("criar_mensagem_pronta", "Cria uma mensagem pronta. {nome} no texto vira o primeiro nome do cliente.",
    { titulo: { type: "string", description: "nome curto do botão (até 40)" }, texto: { type: "string" },
      etapas_ids: { type: "array", items: { type: "string" }, description: "em que etapas aparece primeiro (vazio = todas)" } },
    ["titulo", "texto"]),
  T("editar_mensagem_pronta", "Edita, liga ou desliga uma mensagem pronta.",
    { id: { type: "string" }, titulo: { type: "string" }, texto: { type: "string" }, ativa: { type: "boolean" },
      etapas_ids: { type: "array", items: { type: "string" } } }, ["id"]),
  T("ver_orientacoes_da_ia", "Lista as orientações que ensinam o Autoatendimento (a IA que atende o cliente) a falar."),
  T("adicionar_orientacao_da_ia", "Acrescenta uma orientação curta ao Autoatendimento (como tratar o cliente, o que perguntar).",
    { texto: { type: "string" } }, ["texto"]),
  // O trabalho do dia a dia nos leads (07/10/2026) — só o gestor recebe.
  ...FERRAMENTAS_LEADS,
  // Marketing, catracas, formulários, Autoatendimento e imóveis (08/10/2026).
  ...FERRAMENTAS_MARKETING,
  ...FERRAMENTAS_MENU,
  FERRAMENTA_ABRIR_TELA,
];
// Com a pesquisa na internet, como na consulta (o teto de buscas é lido na hora).
export const ferramentasDeConfig = () => [...FERRAMENTAS_CONFIG, ferramentaDePesquisa(MAX_PESQUISAS())];

/* Chama uma rota do próprio CRM com o crachá de quem pediu. É aqui que a
   permissão é decidida — pela rota, como na tela. */
const BASE = () => `http://127.0.0.1:${process.env.PORT || 4000}`;
export async function chamarRota(autorizacao, metodo, caminho, corpo) {
  const res = await fetch(BASE() + caminho, {
    method: metodo,
    headers: { "content-type": "application/json", authorization: autorizacao },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) return { erro: dados.error || `A rota respondeu ${res.status}.`, status: res.status };
  return { dados };
}

/* A regra "ao chegar" da tela, montada a partir do pedido da IA. MESCLA com a
   que está gravada: pedir "coloque a etiqueta X" não pode apagar a roleta que
   já estava lá. Só o que veio no pedido muda. */
function automacaoDe(a, atual = {}) {
  const cfg = { ...(atual || {}) };
  if (a.responsavel !== undefined) {
    delete cfg.distribuir; delete cfg.catraca_id; delete cfg.limpar_responsavel;
    if (a.responsavel === "roleta") cfg.distribuir = "rodizio";
    else if (a.responsavel === "catraca" && a.catraca_id) { cfg.distribuir = "catraca"; cfg.catraca_id = a.catraca_id; }
    else if (a.responsavel === "pessoa" && a.pessoa_id) cfg.distribuir = a.pessoa_id;
    else if (a.responsavel === "fila") cfg.limpar_responsavel = true;
  }
  if (a.mover_para_funil_id !== undefined) { delete cfg.mover_para_pipeline; if (a.mover_para_funil_id) cfg.mover_para_pipeline = a.mover_para_funil_id; }
  if (a.colocar_etiquetas !== undefined) cfg.adicionar_tags = a.colocar_etiquetas;
  if (a.tirar_etiquetas !== undefined) cfg.remover_tags = a.tirar_etiquetas;
  if (a.etiqueta_do_corretor !== undefined) { if (a.etiqueta_do_corretor) cfg.tag_do_corretor = true; else delete cfg.tag_do_corretor; }
  return cfg;
}
async function automacaoAtual(autorizacao, etapaId) {
  const r = await chamarRota(autorizacao, "GET", "/pipelines?todos=1");
  for (const p of r.dados?.pipelines || []) for (const s of p.stages || []) if (s.id === etapaId) return s.automation_config || {};
  return {};
}

const resumoFunis = (d) => ({
  funis: (d.pipelines || []).map(p => ({
    id: p.id, nome: p.name, tipo: p.type, padrao: p.id === d.padrao, ativo: !!p.is_active,
    etapas: (p.stages || []).map(e => sem({
      id: e.id, nome: e.name, ordem: e.ordem, tipo: e.status_type, ativa: !!e.is_active,
      prazo_minutos: e.sla_minutes ?? undefined, inicio_comercial: e.entrada_comercial ? true : undefined,
      conta_como_conversao: e.counts_as_conversion ? true : undefined,
      obrigatorios: (e.required_fields || []).length ? e.required_fields : undefined,
      ao_chegar: e.automation_config && Object.keys(e.automation_config).length ? e.automation_config : undefined,
    })),
  })),
  modelos: (d.templates || []).map(t => ({ id: t.id, nome: t.nome, descricao: t.descricao, etapas: t.etapas })),
});

/* Executa uma ferramenta. Devolve { dados } para o modelo, e `mostrar` quando
   algo MUDOU na conta — é a linha "✓ Criei a etapa X" que a pessoa vê. */
export function executorDeConfig({ autorizacao, user, conversaId, menu }) {
  const registrarAcao = (ferramenta, entrada, r) => {
    try {
      db.prepare(`INSERT INTO assistente_acoes (id,org_id,user_id,conversa_id,ferramenta,entrada,resultado,ok,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run("aa_" + randomUUID(), user.org_id, user.id, conversaId, ferramenta,
        JSON.stringify(entrada).slice(0, 4000), r.erro ? r.erro : "ok", r.erro ? 0 : 1, agora());
    } catch (e) { console.warn("[assistente] não registrei a ação:", e.message); }
  };
  const mudar = async (ferramenta, entrada, metodo, caminho, corpo, frase) => {
    const r = await chamarRota(autorizacao, metodo, caminho, corpo);
    registrarAcao(ferramenta, entrada, r);
    return r.erro ? { erro: r.erro, mostrar: `Não deu: ${r.erro}` } : { dados: r.dados, mostrar: frase };
  };
  const ler = async (caminho, montar = (d) => d) => {
    const r = await chamarRota(autorizacao, "GET", caminho);
    return r.erro ? { erro: r.erro } : { dados: montar(r.dados) };
  };

  const doMenu = executarMenu({ autorizacao, menu, registrar: registrarAcao });
  const doLead = executorDeLeads({ chamarRota, autorizacao, user, conversaId, registrarAcao });
  const doMarketing = executorDeMarketing({ chamarRota, autorizacao, registrarAcao });
  return async (nome, e, efeitos) => {
    const m = await doMenu(nome, e, efeitos);
    if (m) return m;
    const l = await doLead(nome, e, efeitos);
    if (l) return l;
    const mk = await doMarketing(nome, e, efeitos);
    if (mk) return mk;
    switch (nome) {
      case "ver_funis": return ler("/pipelines?todos=1", resumoFunis);
      case "criar_funil": return mudar(nome, e, "POST", "/pipelines", sem({ name: e.nome, template: e.modelo_id || undefined }), `✓ Criei o funil “${e.nome}”.`);
      case "editar_funil": return mudar(nome, e, "PATCH", `/pipelines/${encodeURIComponent(e.funil_id)}`,
        sem({ name: e.nome, is_active: e.ativo, is_default: e.padrao }), "✓ Funil atualizado.");
      case "criar_etapa": return mudar(nome, e, "POST", `/pipelines/${encodeURIComponent(e.funil_id)}/etapas`,
        sem({ name: e.nome, status_type: e.tipo, counts_as_conversion: e.conta_como_conversao, sla_minutes: e.prazo_minutos }), `✓ Criei a etapa “${e.nome}”.`);
      case "editar_etapa": return mudar(nome, e, "PATCH", `/pipelines/etapas/${encodeURIComponent(e.etapa_id)}`,
        sem({ name: e.nome, status_type: e.tipo, is_active: e.ativa, sla_minutes: e.prazo_minutos,
          entrada_comercial: e.inicio_comercial, counts_as_conversion: e.conta_como_conversao,
          required_fields: e.campos_obrigatorios,
          automation_config: e.ao_chegar ? automacaoDe(e.ao_chegar, await automacaoAtual(autorizacao, e.etapa_id)) : undefined }),
        `✓ Etapa atualizada${e.nome ? ` (“${e.nome}”)` : ""}.`);
      case "ordenar_etapas": return mudar(nome, e, "POST", `/pipelines/${encodeURIComponent(e.funil_id)}/etapas/ordem`, { ids: e.etapas_ids }, "✓ Ordem das etapas atualizada.");
      case "ver_equipe": return ler("/pipelines/entrada", (d) => ({
        pessoas: (d.pessoas || []).map(p => ({ id: p.id, nome: p.name, papel: { adm: "gestor", sdr: "atendente", corretor: "corretor" }[p.role] || p.role, funil_de_entrada: p.pipeline_entrada || "padrão" })),
        funis: d.pipelines }));
      case "definir_funil_de_entrada": return mudar(nome, e, "POST", "/pipelines/entrada", { user_id: e.pessoa_id, pipeline_id: e.funil_id || "" }, "✓ Funil de entrada definido.");
      case "ver_campos": return ler("/pipelines/campos/lista", (d) => ({ campos: (d.campos || []).map(c => ({ chave: c.key, nome: c.name, tipo: c.type, opcoes: c.options })) }));
      case "criar_campo": return mudar(nome, e, "POST", "/pipelines/campos",
        sem({ name: e.nome, type: e.tipo, options: e.opcoes, show_on_card: e.mostrar_no_card }), `✓ Criei o campo “${e.nome}”.`);
      case "ver_tags": return ler("/tags", (d) => ({ tags: (d.tags || []).map(t => ({ id: t.id, nome: t.nome, cor: t.cor })), cores: d.cores }));
      case "criar_tag": return mudar(nome, e, "POST", "/tags", { nome: e.nome, cor: e.cor }, `✓ Criei a tag “${e.nome}”.`);
      case "ver_mensagens_prontas": return ler("/config/mensagens?todas=1", (d) => ({
        mensagens: (d.mensagens || []).map(m => ({ id: m.id, titulo: m.titulo, texto: m.corpo, ativa: !!m.ativo, etapas: m.etapas })) }));
      case "criar_mensagem_pronta": return mudar(nome, e, "POST", "/config/mensagens",
        sem({ titulo: e.titulo, corpo: e.texto, etapas: e.etapas_ids }), `✓ Criei a mensagem pronta “${e.titulo}”.`);
      case "editar_mensagem_pronta": return mudar(nome, e, "PATCH", `/config/mensagens/${encodeURIComponent(e.id)}`,
        sem({ titulo: e.titulo, corpo: e.texto, ativo: e.ativa, etapas: e.etapas_ids }), "✓ Mensagem pronta atualizada.");
      case "ver_orientacoes_da_ia": return ler("/config/robo/ensino", (d) => ({ orientacoes: (d.linhas || []).map(l => ({ id: l.id, texto: l.texto, ativa: !!l.ativo })) }));
      case "adicionar_orientacao_da_ia": return mudar(nome, e, "POST", "/config/robo/ensino", { texto: e.texto }, "✓ Orientação acrescentada ao Autoatendimento.");
      case "abrir_tela": return abrirTela(e, efeitos);
      default: return { erro: "Ferramenta desconhecida." };
    }
  };
}

export function abrirTela(e, efeitos) {
  if (!TELAS[e.tela]) return { erro: "Tela desconhecida." };
  efeitos.navegar = { tela: e.tela, rotulo: TELAS[e.tela], motivo: String(e.motivo || "").slice(0, 200) };
  return { dados: { ok: true, mostrado_botao: true } };
}

/* ===== O MODO CONSULTA (atendente e corretor) =====
   Pedido do Ali (05/10/2026): o botão do Claude também para a atendente e o
   corretor, "sem permitir ajustes como a conta de gestor, apenas responder
   dúvidas e fazer pesquisas". Por isso o modo de consulta não tem UMA
   ferramenta que escreva: só leitura, pelas mesmas rotas da tela e com o
   crachá de quem pergunta — o corretor só acha os leads dele, como na caixa
   dele. E a pesquisa na internet roda nos servidores da Anthropic
   (`web_search`), sem nada do CRM ir junto: a instrução proíbe pôr nome,
   telefone ou documento de cliente numa busca. */
const MAX_PESQUISAS = () => Number(process.env.ASSISTENTE_PESQUISAS_POR_PERGUNTA || 5);
export const FERRAMENTAS_CONSULTA = () => [
  T("buscar_leads", "Procura leads que a pessoa pode ver (o corretor, só os dele) por nome, telefone, etapa ou temperatura. Devolve até 20, com id para ver_lead.",
    { texto: { type: "string", description: "parte do nome ou do telefone (opcional)" },
      etapa: { type: "string", description: "nome da etapa (opcional)" },
      temperatura: { type: "string", enum: ["QUENTE", "MORNO", "FRIO", "SEM"] },
      aguardando: { type: "boolean", description: "só quem está esperando resposta" } }),
  T("ver_lead", "Abre um lead: dados, etapa, responsável, observações, tarefas e as últimas mensagens da conversa.",
    { lead_id: { type: "string" } }, ["lead_id"]),
  T("ver_meus_numeros", "Os indicadores do período (leads recebidos, vendas, valor vendido, visitas/demonstrações, ligações) e as metas do mês. O corretor vê os dele; a atendente, os da equipe.",
    { periodo: { type: "string", enum: ["hoje", "ontem", "7d", "este_mes", "mes_passado", "30d"] } }),
  T("ver_funis", "Lista os funis da conta e as etapas, só para consulta."),
  ...FERRAMENTAS_MENU,
  FERRAMENTA_ABRIR_TELA,
  ferramentaDePesquisa(MAX_PESQUISAS()),
];

const resumoDoLead = (l) => sem({
  id: l.id, nome: l.name, telefone: l.phone || undefined, etapa: l.stage, temperatura: l.priority || "sem",
  responsavel: l.assigned_name || (l.assigned_to ? undefined : "na fila"), origem: l.origem || undefined,
  campanha: l.campaign_name || undefined,
  ultima_mensagem: l.last_at ? new Date(l.last_at).toLocaleString("pt-BR") : undefined,
  esperando_resposta: l.last_direction === "in" || l.aguarda_contato ? true : undefined,
  venda: l.sale_value ? { valor: l.sale_value, data: l.sale_date ? new Date(l.sale_date).toLocaleDateString("pt-BR") : undefined } : undefined,
});
const semAcento = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function executorDeConsulta({ autorizacao, user, conversaId, menu }) {
  const ler = async (caminho, montar = (d) => d) => {
    const r = await chamarRota(autorizacao, "GET", caminho);
    return r.erro ? { erro: r.erro } : { dados: montar(r.dados) };
  };
  // A ordem do menu é a única coisa que a consulta muda, e fica registrada como as ações do gestor.
  const registrar = user ? (ferramenta, entrada, r) => {
    try {
      db.prepare(`INSERT INTO assistente_acoes (id,org_id,user_id,conversa_id,ferramenta,entrada,resultado,ok,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run("aa_" + randomUUID(), user.org_id, user.id, conversaId || null, ferramenta,
        JSON.stringify(entrada).slice(0, 4000), r.erro ? r.erro : "ok", r.erro ? 0 : 1, agora());
    } catch (e) { console.warn("[assistente] não registrei a ação:", e.message); }
  } : null;
  const doMenu = executarMenu({ autorizacao, menu, registrar });
  return async (nome, e, efeitos) => {
    const m = await doMenu(nome, e, efeitos);
    if (m) return m;
    switch (nome) {
      case "buscar_leads": {
        const q = String(e.texto || "").trim();
        const digitos = q.replace(/\D/g, "");
        const r = await chamarRota(autorizacao, "GET", "/leads" + (q ? `?q=${encodeURIComponent(digitos.length >= 4 ? digitos : q)}` : ""));
        if (r.erro) return { erro: r.erro };
        let lista = Array.isArray(r.dados) ? r.dados : (r.dados.leads || []);
        // A rota do corretor não filtra por texto (a caixa dele já vem inteira): filtra aqui.
        if (q) lista = lista.filter(l => digitos.length >= 4
          ? String(l.phone || "").includes(digitos)
          : semAcento(l.name).includes(semAcento(q)));
        if (e.etapa) lista = lista.filter(l => semAcento(l.stage) === semAcento(e.etapa));
        if (e.temperatura) lista = lista.filter(l => (l.priority || "SEM") === e.temperatura);
        if (e.aguardando) lista = lista.filter(l => l.last_direction === "in" || l.aguarda_contato);
        lista.sort((a, b) => (b.last_at || b.created_at || 0) - (a.last_at || a.created_at || 0));
        return { dados: { total: lista.length, leads: lista.slice(0, 20).map(resumoDoLead) } };
      }
      case "ver_lead": return ler(`/leads/${encodeURIComponent(e.lead_id)}`, (l) => ({
        ...resumoDoLead(l),
        qualificacao: l.qual && Object.keys(l.qual).length ? l.qual : undefined,
        observacoes: (l.observacoes || []).slice(-10).map(o => ({ texto: o.texto, por: o.autor_nome || o.por || undefined })),
        tarefas: (l.lista_tarefas || []).slice(0, 10).map(t => sem({ titulo: t.titulo, quando: t.quando ? new Date(t.quando).toLocaleString("pt-BR") : undefined, feita: t.feita ? true : undefined })),
        conversa: (l.messages || []).filter(m => m.body).slice(-30).map(m => ({
          de: m.direction === "in" ? "cliente" : "imobiliária", texto: String(m.body).slice(0, 500),
          em: new Date(m.created_at).toLocaleString("pt-BR") })),
      }));
      case "ver_meus_numeros": return ler(`/painel/geral?periodo=${encodeURIComponent(e.periodo || "este_mes")}`, (d) => ({
        periodo: d.periodo, indicadores: d.kpis, funil_de_atividade: (d.funil_atividade || []).map(p => ({ passo: p.nome, valor: p.valor })),
        metas: d.metas }));
      case "ver_funis": return ler("/pipelines", (d) => ({ funis: resumoFunis(d).funis }));
      case "abrir_tela": return abrirTela(e, efeitos);
      default: return { erro: "Ferramenta desconhecida." };
    }
  };
}

const INSTRUCOES_CONSULTA = `Você é o assistente do ConHub, um CRM de imobiliárias, e conversa em português do Brasil com quem atende os clientes (atendente ou corretor).

Você SÓ CONSULTA. Não muda nada na conta — nem etapa, nem lead, nem configuração —, e não tem ferramenta para isso. Se pedirem uma mudança, diga onde clicar na tela (use abrir_tela) ou que quem configura é a gestão.

A ÚNICA exceção é o menu da própria pessoa: ela pode reorganizar a ordem das telas do menu dela como quiser (ver_meu_menu, organizar_meu_menu), ou voltar à ordem padrão. Só a posição: os nomes não mudam e nada some do menu — se pedirem para renomear ou esconder, diga que isso não dá. Isso não mexe no menu de mais ninguém.

O que você faz:
- Tira dúvidas de uso do sistema, pelo manual abaixo, com o caminho exato na tela.
- Pesquisa os dados da pessoa: leads (buscar_leads, ver_lead), os números dela (ver_meus_numeros) e os funis (ver_funis). Nunca invente lead, número ou etapa: o que não veio das ferramentas, você não sabe.
- Pesquisa na internet (web_search) quando a pergunta é de fora do sistema: financiamento, programas habitacionais, documentação, mercado, como abordar um cliente. Diga de onde veio a informação e, quando for regra que muda (taxa, prazo, valor), avise para conferir na fonte oficial.
- Pode sugerir texto de mensagem para o cliente; quem envia é a pessoa, pela conversa.

Privacidade: NUNCA coloque nome, telefone, e-mail, CPF ou qualquer dado de cliente numa pesquisa na internet. Pesquise o assunto, não a pessoa.

Responda curto, sem jargão técnico, sem markdown pesado (no máximo listas simples). Não fale de ids.

${MANUAL_CONHUB}`;

export function sistemaDeConsulta(user, org) {
  const papel = user.role === "sdr" ? "atendente" : "corretor(a)";
  return [
    { type: "text", text: INSTRUCOES_CONSULTA },
    { type: "text", text: `Conta: ${org?.name || "—"}. Quem conversa: ${user.name}, ${papel}. Hoje: ${new Date().toLocaleDateString("pt-BR")}.` },
  ];
}

/* ===== AS INSTRUÇÕES =====
   Fixas (entram no cache); o que muda por conta vai no segundo bloco. */
const INSTRUCOES_CONFIG = `Você é o assistente de configuração do ConHub, um CRM de imobiliárias, e conversa em português do Brasil com quem administra a conta.

Seu trabalho: entender o que a pessoa quer e FAZER, usando as ferramentas, como o gestor faria pela tela:
- configuração: funis, etapas, prazos, automação da etapa, funil de entrada de cada pessoa, campos, tags, mensagens prontas e orientações do Autoatendimento;
- leads: procurar e abrir (buscar_leads, ver_lead), mover de etapa e de funil (mover_leads, migrar_funil_da_pessoa), repassar (repassar_leads), tags (etiquetar_leads), finalizar/reabrir, tarefas, observações, corrigir nome, cadastrar lead e registrar venda;
- números do período (ver_numeros) e pesquisa na internet (web_search) para assuntos de fora do sistema;
- marketing e distribuição: fluxos (ver_fluxos, ver_fluxo, salvar_fluxo, ligar_fluxo), catracas por produto (ver_catracas, salvar_catraca), formulários dos anúncios (ver_formularios, configurar_formulario), a regra "quando um lead chegar nesta etapa" (editar_etapa → ao_chegar: catraca específica, etiquetas, etiqueta com o nome do corretor);
- Autoatendimento: horário, ligar/desligar, em quais funis/etapas atua, campos que preenche, resumo como observação e etapa final (configurar_autoatendimento), orientações (acrescentar, editar, apagar) e fichas de produto (uma por empreendimento, ligadas a formulário ou catraca), além do catálogo de imóveis (ver_imoveis, ver_imovel) como base.

A pessoa pode mandar arquivos junto (foto, print, PDF, planilha, texto, cenas de um vídeo). Leia o que veio e use: um print de outro sistema pode virar funil, uma planilha pode virar uma lista de leads para mover. Do vídeo você só vê os quadros que vieram — não assistiu nem ouviu nada; diga isso se a pergunta depender do som.

Como trabalhar:
- Antes de mexer em funil, etapa, campo, tag ou mensagem, leia o que existe (ver_funis, ver_campos, ver_tags, ver_mensagens_prontas, ver_equipe). Nunca invente um id.
- TERMINE O TRABALHO INTEIRO NA MESMA VEZ. Pedido grande (muitos leads, várias etapas, um funil inteiro, uma lista longa) se faz até o fim, passo a passo, sem parar no meio para perguntar "quer que eu continue?", "posso seguir?" ou "faço o resto?" — a pessoa já pediu, e cada parada obriga ela a voltar e repetir. Não há limite de passos para você se preocupar: se o trabalho for longo, o sistema continua sozinho de onde você parou. Só responda quando tudo estiver feito, dizendo em poucas linhas o que ficou feito.
- As ÚNICAS paradas para esperar a pessoa são estas: (1) a ferramenta devolveu precisa_confirmar (mais de 10 leads); (2) ligar uma automação nova; (3) ligar a IA que fala com o cliente ou mudar o que ela pode falar; (4) o pedido é ambíguo de verdade — dá para entender de dois jeitos que levam a resultados diferentes. Fora disso, decida pelo caminho mais razoável, faça e conte o que fez. Pedido grande não é pedido ambíguo.
- Uma ferramenta recusou: diga o motivo com as palavras da recusa e o que a pessoa pode fazer. Não tente contornar uma recusa de permissão ou de plano.
- AÇÃO EM MASSA: quando a ferramenta devolver precisa_confirmar, mostre à pessoa quantos leads, alguns nomes e o que vai mudar, e PARE. Só chame de novo com o código depois que ela responder confirmando. Nunca invente um código.
- Antes de mover, repassar ou marcar, confira com buscar_leads quais leads são. Para mover para outro funil, use a etapa do funil de destino (de ver_funis).
- Registrar venda só quando a pessoa disser o valor. Datas e horas são do horário de Brasília.
- FLUXOS: leia o fluxo (ver_fluxo) antes de editar e mande-o INTEIRO de volta em salvar_fluxo. Monte com o que existe (ids de ver_tags, ver_funis, ver_campos, ver_catracas, ver_equipe, ver_formularios). Antes de ligar uma automação nova, descreva em tópicos o que ela vai fazer com o cliente (quem entra, que mensagens saem, quando) e espere o "pode" — ela passa a mandar mensagem sozinha. Mensagem fora da janela de 24h na API oficial só sai com modelo aprovado (ver_modelos_meta).
- AUTOATENDIMENTO: ligar a IA que fala com o cliente é decisão do gestor — confirme antes de ligar. As regras do que a IA pode e não pode falar são as orientações da conta (não há proibição fixa do ConHub): ao escrever ou apagar uma orientação que libera preço, aprovação ou visita, descreva a mudança e espere o "pode".
- Você NÃO apaga lead, funil, etapa, tag, fluxo nem catraca (orientações da IA e fichas de produto você pode apagar, a pedido), não manda mensagem ao cliente nem dispara campanha, não mexe em cobrança, plano, WhatsApp/conexão, número de disparo, equipe, senha nem em LGPD. Para isso, use abrir_tela e diga onde clicar.
- Privacidade: nunca coloque nome, telefone, e-mail ou CPF de cliente numa pesquisa na internet.
- O menu da própria pessoa pode ser reorganizado (ver_meu_menu, organizar_meu_menu): só a ordem, nunca o nome; nada some do menu.
- Responda curto, sem jargão técnico, sem markdown pesado (no máximo listas simples). Não fale de ids para a pessoa.
- Se a dúvida for de uso do sistema e não de configuração, responda pelo manual abaixo.

${MANUAL_CONHUB}`;

export function sistemaDeConfig(user, org) {
  const papel = user.gestor || user.role === "adm" ? "gestor(a)" : user.role === "sdr" ? "atendente" : "corretor(a)";
  return [
    { type: "text", text: INSTRUCOES_CONFIG },
    { type: "text", text: `Conta: ${org?.name || "—"} (${org?.tipo === "autonomo" ? "corretor autônomo" : "imobiliária"}). Quem conversa: ${user.name}, ${papel}. Hoje: ${new Date().toLocaleDateString("pt-BR")}.` },
  ];
}

export function disponibilidade(user, tipo) {
  if (!claudeConfigurado()) return { disponivel: false, motivo: "A IA não está ligada neste servidor." };
  const usados = usadosNoMes(user.org_id, tipo), limite = LIMITES[tipo]();
  if (usados >= limite) return { disponivel: false, motivo: `O limite de ${limite} perguntas deste mês foi atingido.`, usados, limite };
  return { disponivel: true, usados, limite, modelo: MODELO_ASSISTENTE() };
}
