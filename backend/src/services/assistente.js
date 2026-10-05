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
import { chamarClaude, claudeConfigurado, textoDe, MODELO_ASSISTENTE } from "./claude.js";
import { registrar } from "./iauso.js";
import { MANUAL_CONHUB } from "./ajuda.js";
import { CORES_TAG } from "./tags.js";

/* ===== TETO DO MÊS =====
   Cada pergunta custa centavos, e "centavos" sem teto vira fatura. O teto é
   por conta e por tipo; passado, o assistente avisa e a nuvem de suporte vai
   direto para uma pessoa. */
export const LIMITES = {
  config: () => Number(process.env.ASSISTENTE_LIMITE_MES || 200),
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

   Teto de 10 voltas por pergunta: um pedido de configuração bem grande cabe;
   um laço que não termina, não. */
const VOLTAS = 10;

export async function conversar({ conversa, user, tipo, texto, system, tools, executar, effort }) {
  let mensagens = json(conversa.mensagens, []);
  const itens = json(conversa.itens, []);
  const novos = [];
  /* CONVERSA LONGA RECOMEÇA, em vez de ser cortada pela frente. Cada pergunta
     reenvia o histórico inteiro (é dinheiro), e cortar as mensagens antigas
     seria EDITAR o histórico — que o modelo recusa (os blocos de raciocínio
     ficam presos ao começo da conversa). Recomeçar do zero é válido; a tela
     marca a divisa. */
  if (mensagens.length > 60) {
    mensagens = [];
    novos.push(novoItem("sistema", "A conversa ficou longa e recomeçou daqui. O que já foi feito na conta continua feito."));
  }
  novos.push(novoItem("voce", texto));
  const efeitos = { navegar: null, humano: null };
  const inicio = mensagens.length;
  mensagens.push({ role: "user", content: texto });
  db.prepare("INSERT INTO assistente_turnos (id,org_id,user_id,tipo,created_at) VALUES (?,?,?,?,?)")
    .run("at_" + randomUUID(), user.org_id, user.id, tipo, agora());

  let falhou = null;
  for (let volta = 0; volta < VOLTAS; volta++) {
    const r = await chamarClaude({ system, messages: mensagens, tools, effort });
    if (!r.ok) { falhou = r.erro; break; }
    registrar({ orgId: user.org_id, userId: user.id, recurso: tipo === "config" ? "assistente" : "suporte", uso: r.uso, modelo: r.modelo, custo: r.custo ?? undefined });
    const resp = r.resposta;

    /* Recusa do filtro de segurança: o conteúdo pode vir vazio, e resposta
       vazia no histórico faria a API recusar todas as próximas. Sai a
       pergunta que provocou a recusa; a conversa continua utilizável. */
    if (resp.stop_reason === "refusal") {
      mensagens.length = inicio;
      novos.push(novoItem("assistente", "Não consigo ajudar com isso por aqui. Se precisar, fale com o suporte."));
      break;
    }
    if (!Array.isArray(resp.content) || !resp.content.length) { falhou = "A IA não respondeu nada."; break; }
    mensagens.push({ role: "assistant", content: resp.content });
    const fala = textoDe(resp);
    if (fala) novos.push(novoItem("assistente", fala));

    const pedidos = resp.content.filter(b => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !pedidos.length) break;

    // Todas as respostas das ferramentas voltam numa mensagem só.
    const resultados = [];
    for (const p of pedidos) {
      let saida;
      try { saida = await executar(p.name, p.input || {}, efeitos); }
      catch (e) { saida = { erro: "Falhou: " + e.message }; }
      if (saida && saida.mostrar) novos.push(novoItem(saida.erro ? "erro" : "acao", saida.mostrar));
      resultados.push({ type: "tool_result", tool_use_id: p.id, content: JSON.stringify(saida?.dados ?? saida ?? {}).slice(0, 20000), ...(saida?.erro ? { is_error: true } : {}) });
    }
    mensagens.push({ role: "user", content: resultados });
    if (volta === VOLTAS - 1) novos.push(novoItem("erro", "Parei aqui para não entrar em laço. Confira o que já foi feito e me peça o resto."));
  }

  /* Falha no meio: a conversa precisa terminar numa resposta do assistente
     ou numa pergunta da pessoa. Pedido de ferramenta sem resposta ou resposta
     de ferramenta sem continuação deixariam o histórico inválido — então o
     que ficou pela metade sai. */
  if (falhou) {
    novos.push(novoItem("erro", falhou));
    while (mensagens.length > inicio) {
      const u = mensagens[mensagens.length - 1];
      if (u.role === "assistant" && !(u.content || []).some(b => b.type === "tool_use")) break;
      mensagens.pop();
    }
  }
  /* O laço também pode terminar pelo teto de voltas logo depois das respostas
     das ferramentas — aí a próxima pergunta viria grudada nelas. Fica só até
     a última fala completa do assistente. */
  while (mensagens.length > inicio) {
    const u = mensagens[mensagens.length - 1];
    if (u.role === "assistant" && !(u.content || []).some(b => b.type === "tool_use")) break;
    mensagens.pop();
  }

  const guardar = mensagens;
  const todosItens = itens.concat(novos).slice(-200);
  db.prepare("UPDATE assistente_conversas SET mensagens = ?, itens = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(guardar), JSON.stringify(todosItens), agora(), conversa.id);
  return { itens: novos, navegar: efeitos.navegar, humano: efeitos.humano, falhou: !!falhou };
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
  "Leva a pessoa até uma tela do ConHub. Use para o que você não faz por aqui (apagar, WhatsApp, equipe, cobrança) ou quando ela pedir para ver algo.",
  { tela: { type: "string", enum: Object.keys(TELAS) }, motivo: { type: "string", description: "Uma frase curta: o que ela vai fazer lá (ex.: 'na aba Conexão, toque em Conectar')." } },
  ["tela", "motivo"]);

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
      ao_chegar: { type: "object", additionalProperties: false, description: "Substitui a automação inteira da etapa.",
        properties: {
          responsavel: { type: "string", enum: ["nao_mexer", "roleta", "fila", "pessoa"], description: "roleta = próximo corretor disponível; fila = devolve à fila; pessoa = sempre a pessoa_id" },
          pessoa_id: { type: "string" },
          mover_para_funil_id: { type: ["string", "null"] } },
        required: ["responsavel"] } },
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
  FERRAMENTA_ABRIR_TELA,
];

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

function automacaoDe(a) {
  const cfg = {};
  if (a.responsavel === "roleta") cfg.distribuir = "rodizio";
  else if (a.responsavel === "pessoa" && a.pessoa_id) cfg.distribuir = a.pessoa_id;
  else if (a.responsavel === "fila") cfg.limpar_responsavel = true;
  if (a.mover_para_funil_id) cfg.mover_para_pipeline = a.mover_para_funil_id;
  return cfg;
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
export function executorDeConfig({ autorizacao, user, conversaId }) {
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

  return async (nome, e, efeitos) => {
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
          required_fields: e.campos_obrigatorios, automation_config: e.ao_chegar ? automacaoDe(e.ao_chegar) : undefined }),
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
      case "ver_orientacoes_da_ia": return ler("/config/robo/ensino", (d) => ({ orientacoes: (d.linhas || []).map(l => ({ texto: l.texto, ativa: !!l.ativo })) }));
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

/* ===== AS INSTRUÇÕES =====
   Fixas (entram no cache); o que muda por conta vai no segundo bloco. */
const INSTRUCOES_CONFIG = `Você é o assistente de configuração do ConHub, um CRM de imobiliárias, e conversa em português do Brasil com quem administra a conta.

Seu trabalho: entender o que a pessoa quer montar na conta dela e FAZER, usando as ferramentas — funis, etapas, prazos, automação da etapa, funil de entrada de cada pessoa, campos, tags, mensagens prontas e orientações do Autoatendimento.

Como trabalhar:
- Antes de mexer em funil, etapa, campo, tag ou mensagem, leia o que existe (ver_funis, ver_campos, ver_tags, ver_mensagens_prontas, ver_equipe). Nunca invente um id.
- Pedido claro: faça, e depois diga em poucas linhas o que ficou feito. Pedido ambíguo ou grande (ex.: refazer um funil inteiro): proponha o plano em tópicos curtos e espere o "pode".
- Uma ferramenta recusou: diga o motivo com as palavras da recusa e o que a pessoa pode fazer. Não tente contornar uma recusa de permissão ou de plano.
- Você NÃO apaga nada, não mexe em cobrança, plano, WhatsApp/conexão, equipe, senha nem em leads. Para isso, use abrir_tela e diga onde clicar.
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
