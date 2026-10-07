/* O CLAUDE DO GESTOR MEXE NOS LEADS (07/10/2026, pedido do Ali: "liberar
   pra fazer migração de lead no funil, ele pode literalmente fazer o trabalho
   que o gestor pode fazer totalmente… essa liberdade maior é apenas para
   gestores").

   Só o modo de configuração (gestor e dono de autônomo) recebe estas
   ferramentas — quem decide é `modoDe`, no servidor. E a regra do assistente
   continua a mesma: a IA não tem poder próprio. Mover, repassar, marcar tag,
   finalizar, cadastrar: cada uma é a MESMA rota que a tela chama, com o
   crachá de quem conversa. A etapa que exige campo recusa aqui como recusa no
   Kanban; a automação da etapa e a catraca rodam como rodariam no clique.

   O QUE CONTINUA DE FORA, de propósito: apagar lead, mandar mensagem ao
   cliente (a IA falando pelo WhatsApp em nome de uma pessoa da equipe), LGPD,
   cobrança, conexão e equipe. Ação sem volta ou que fala com o cliente não sai
   de uma frase mal entendida.

   AÇÃO EM MASSA PEDE CONFIRMAÇÃO EM OUTRA MENSAGEM. Mais de LIMITE_DIRETO
   leads: a ferramenta devolve uma prévia (quantos, quais, para onde) e um
   código; só uma chamada com o código, feita DEPOIS de a pessoa responder,
   executa — e executa sobre a lista da prévia, não sobre o filtro de novo.
   A trava é do servidor, não da instrução: o modelo não consegue prever e
   executar na mesma pergunta, nem que queira. Mover trezentos leads por causa
   de um "isso" ambíguo seria uma tarde de trabalho para desfazer. */

import { randomUUID } from "crypto";

const T = (name, description, properties = {}, required = []) =>
  ({ name, description, input_schema: { type: "object", properties, required, additionalProperties: false } });
const sem = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const quando = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR") : undefined);

export const LIMITE_DIRETO = 10;   // até aqui, sem prévia
const TETO = 500;                  // leads por operação
const TETO_REPASSE = 200;          // cada repasse avisa a pessoa no celular
const VALIDADE = 30 * 60000;       // a prévia vale 30 minutos

/* ===== O FILTRO =====
   Os mesmos critérios dos filtros da tela, com ids — o modelo os tira de
   ver_funis, ver_equipe e ver_tags, nunca de cabeça. */
const FILTRO = {
  texto: { type: "string", description: "parte do nome ou do telefone" },
  funil_id: { type: "string" },
  etapa_id: { type: "string" },
  responsavel_id: { type: "string", description: "id de ver_equipe, ou \"fila\" para os sem dono" },
  temperatura: { type: "string", enum: ["QUENTE", "MORNO", "FRIO", "SEM"] },
  tag_id: { type: "string" },
  origem: { type: "string", description: "parte da origem (ex.: WhatsApp, Meta, Portal, Site, Planilha)" },
  campanha: { type: "string", description: "parte do nome da campanha do anúncio" },
  aguardando: { type: "boolean", description: "só quem está esperando resposta" },
  sem_conversa_ha_dias: { type: "integer", description: "sem nenhuma interação há pelo menos N dias" },
  entrou_ha_dias: { type: "integer", description: "chegou nos últimos N dias" },
  incluir_finalizados: { type: "boolean", description: "inclui atendimentos finalizados (padrão: não)" },
};
const SELECAO = {
  lead_ids: { type: "array", items: { type: "string" }, description: "ids de buscar_leads" },
  filtro: { type: "object", additionalProperties: false, properties: FILTRO,
    description: "em vez de lead_ids: todos os leads que batem com TODOS os critérios" },
  confirmacao: { type: "string", description: "o código da prévia — só depois de a pessoa confirmar, numa mensagem seguinte" },
};

export const FERRAMENTAS_LEADS = [
  T("buscar_leads", "Procura leads da conta inteira. Devolve o total e até 50, com id, funil, etapa, responsável, temperatura e tags.",
    { ...FILTRO, limite: { type: "integer", description: "quantos devolver (até 50)" } }),
  T("ver_lead", "Abre um lead: dados, funil e etapa, responsável, tags, observações, tarefas e as últimas mensagens.",
    { lead_id: { type: "string" } }, ["lead_id"]),
  T("mover_leads", `Move leads para uma etapa — de qualquer funil da conta (mudar de funil é mover para uma etapa do outro funil). Os campos obrigatórios e a automação da etapa valem como no Kanban. Mais de ${LIMITE_DIRETO} leads: volta uma prévia com código; mostre e espere a pessoa confirmar.`,
    { ...SELECAO, etapa_id: { type: "string" } }, ["etapa_id"]),
  T("migrar_funil_da_pessoa", "Leva TODOS os leads de uma pessoa (ou da fila) para outro funil, como em Base de leads → Arrumar a base. Sempre volta primeiro uma prévia com código. O responsável não muda.",
    { pessoa_id: { type: "string", description: "id de ver_equipe, ou \"fila\"" }, funil_id: { type: "string" },
      etapa_id: { type: "string", description: "etapa de chegada (padrão: a primeira do funil)" },
      manter_etapa: { type: "boolean", description: "quem estiver numa etapa de mesmo nome no destino fica nela" },
      confirmacao: { type: "string" } }, ["pessoa_id", "funil_id"]),
  T("repassar_leads", `Troca o responsável: para uma pessoa (corretor ou atendente), para o próximo da catraca ("roleta"), de volta à fila ("fila") ou para quem conversa ("eu"). Quem recebe é avisado no celular. Mais de ${LIMITE_DIRETO}: prévia com código.`,
    { ...SELECAO, para: { type: "string", description: "id de ver_equipe, \"roleta\", \"fila\" ou \"eu\"" } }, ["para"]),
  T("etiquetar_leads", `Coloca ou tira uma tag de leads. Mais de ${LIMITE_DIRETO}: prévia com código.`,
    { ...SELECAO, tag_id: { type: "string" }, acao: { type: "string", enum: ["colocar", "tirar"] } }, ["tag_id", "acao"]),
  T("finalizar_leads", `Finaliza o atendimento (sai da caixa de entrada sem mudar a etapa; volta sozinho se o cliente responder) ou reabre. Mais de ${LIMITE_DIRETO}: prévia com código.`,
    { ...SELECAO, acao: { type: "string", enum: ["finalizar", "reabrir"] } }, ["acao"]),
  T("criar_tarefa", "Cria uma tarefa num lead. Ela fica com quem está com o lead.",
    { lead_id: { type: "string" }, titulo: { type: "string" },
      quando: { type: "string", description: "data e hora, AAAA-MM-DDTHH:MM (hora de Brasília)" } }, ["lead_id", "titulo", "quando"]),
  T("adicionar_observacao", "Escreve uma observação na ficha do lead (o recado que quem atende lê antes de falar).",
    { lead_id: { type: "string" }, texto: { type: "string" } }, ["lead_id", "texto"]),
  T("corrigir_nome", "Corrige o nome do lead.", { lead_id: { type: "string" }, nome: { type: "string" } }, ["lead_id", "nome"]),
  T("cadastrar_lead", "Cadastra um lead novo. Telefone com DDD; número já cadastrado é recusado dizendo qual lead é.",
    { nome: { type: "string" }, telefone: { type: "string" },
      pais: { type: "string", description: "sigla do país do número sem código (padrão BR)" },
      etapa_id: { type: "string" }, responsavel_id: { type: "string", description: "id de ver_equipe ou \"fila\" (padrão: quem conversa)" },
      observacao: { type: "string" } }, ["nome", "telefone"]),
  T("registrar_venda", "Registra a venda do lead (vai para os relatórios de dinheiro). Só quando a pessoa disser o valor.",
    { lead_id: { type: "string" }, valor: { type: "number" }, data: { type: "string", description: "AAAA-MM-DD (padrão hoje)" },
      imovel: { type: "string" }, comissao_pct: { type: "number" } }, ["lead_id", "valor"]),
  T("ver_numeros", "Indicadores do período (leads, vendas, valor, visitas, ligações) e as metas — da operação ou de uma pessoa.",
    { periodo: { type: "string", enum: ["hoje", "ontem", "7d", "este_mes", "mes_passado", "30d"] },
      responsavel_id: { type: "string" } }),
];

/* ===== AS PRÉVIAS GUARDADAS =====
   Em memória: uma prévia vale 30 minutos e serve a quem a pediu, naquela
   conversa. Reiniciar o servidor apaga — a pessoa pede de novo, e nada foi
   feito pela metade. */
const PREVIAS = new Map();
function guardarPrevia(p) {
  const agora = Date.now();
  for (const [k, v] of PREVIAS) if (agora - v.em > VALIDADE) PREVIAS.delete(k);
  const codigo = "cf_" + randomUUID().slice(0, 8);
  PREVIAS.set(codigo, { ...p, em: agora });
  return codigo;
}
function pegarPrevia(codigo, { ferramenta, conversaId, userId, pergunta }) {
  const p = PREVIAS.get(String(codigo || ""));
  if (!p || Date.now() - p.em > VALIDADE) return { erro: "Esse código de confirmação não existe ou venceu (vale 30 minutos). Faça a prévia de novo." };
  if (p.ferramenta !== ferramenta || p.conversaId !== conversaId || p.userId !== userId)
    return { erro: "Esse código é de outra operação. Faça a prévia de novo." };
  /* A trava: a prévia e a execução não podem ser a mesma pergunta. Quem
     confirma é a pessoa, respondendo — não o modelo, no embalo. */
  if (p.pergunta === pergunta) return { erro: "A pessoa ainda não confirmou. Mostre a prévia (quantos leads e o que vai mudar) e espere ela responder." };
  PREVIAS.delete(String(codigo));
  return { previa: p };
}

/* ===== O EXECUTOR ===== */
export function executorDeLeads({ chamarRota, autorizacao, user, conversaId, registrarAcao }) {
  let cachePipes = null, cacheLeads = null;
  const pipes = async () => {
    if (cachePipes) return cachePipes;
    const r = await chamarRota(autorizacao, "GET", "/pipelines?todos=1");
    const funis = new Map(), etapas = new Map();
    for (const p of (r.dados?.pipelines || [])) {
      funis.set(p.id, p.name);
      for (const e of (p.stages || [])) etapas.set(e.id, { nome: e.name, funil: p.name, funil_id: p.id });
    }
    cachePipes = { funis, etapas };
    return cachePipes;
  };
  // A lista da conta inteira, com os finalizados — o filtro de cada
  // ferramenta decide quem fica. Lida uma vez por pergunta.
  const todos = async () => {
    if (cacheLeads) return cacheLeads;
    const r = await chamarRota(autorizacao, "GET", "/leads?finalizados=1");
    if (r.erro) return r;
    cacheLeads = { lista: Array.isArray(r.dados) ? r.dados : (r.dados.leads || []) };
    return cacheLeads;
  };
  const esquecerLista = () => { cacheLeads = null; };

  const filtrar = (lista, f = {}) => {
    const agora = Date.now();
    const q = String(f.texto || "").trim(), dig = q.replace(/\D/g, "");
    return lista.filter(l => {
      if (!f.incluir_finalizados && l.closed_at) return false;
      if (q && !(dig.length >= 4 ? String(l.phone || "").includes(dig) : semAcento(l.name).includes(semAcento(q)))) return false;
      if (f.funil_id && l.pipeline_id !== f.funil_id) return false;
      if (f.etapa_id && l.stage_id !== f.etapa_id) return false;
      if (f.responsavel_id && (f.responsavel_id === "fila" ? l.assigned_to : l.assigned_to !== f.responsavel_id)) return false;
      if (f.temperatura && (l.priority || "SEM") !== f.temperatura) return false;
      if (f.tag_id && !(l.tags || []).some(t => t.id === f.tag_id)) return false;
      if (f.origem && !semAcento([l.origem, l.source, l.platform].join(" ")).includes(semAcento(f.origem))) return false;
      if (f.campanha && !semAcento(l.campaign_name).includes(semAcento(f.campanha))) return false;
      if (f.aguardando && !(l.last_direction === "in" || l.aguarda_contato)) return false;
      if (f.sem_conversa_ha_dias > 0 && (l.last_interaction_at || l.created_at || 0) > agora - f.sem_conversa_ha_dias * 86400000) return false;
      if (f.entrou_ha_dias > 0 && (l.created_at || 0) < agora - f.entrou_ha_dias * 86400000) return false;
      return true;
    });
  };

  const resumo = async (l) => {
    const { etapas, funis } = await pipes();
    return sem({
      id: l.id, nome: l.name, telefone: l.phone || undefined,
      funil: funis.get(l.pipeline_id) || undefined, etapa: (etapas.get(l.stage_id) || {}).nome || l.stage,
      responsavel: l.assigned_name || (l.assigned_to ? undefined : "na fila"),
      temperatura: l.priority || "sem", tags: (l.tags || []).length ? l.tags.map(t => t.nome) : undefined,
      origem: l.origem || undefined, campanha: l.campaign_name || undefined,
      ultima_interacao: quando(l.last_interaction_at || l.last_at),
      esperando_resposta: l.last_direction === "in" || l.aguarda_contato ? true : undefined,
      finalizado: l.closed_at ? true : undefined,
      venda: l.sale_value ? { valor: l.sale_value, data: l.sale_date ? new Date(l.sale_date).toLocaleDateString("pt-BR") : undefined } : undefined,
    });
  };

  /* A seleção vira uma lista de leads: por ids ou por filtro — nunca "todos"
     sem critério nenhum. */
  async function selecionar(e) {
    const t = await todos();
    if (t.erro) return { erro: t.erro };
    if (Array.isArray(e.lead_ids) && e.lead_ids.length) {
      const pedidos = [...new Set(e.lead_ids.map(String))];
      const porId = new Map(t.lista.map(l => [l.id, l]));
      const achados = pedidos.map(id => porId.get(id)).filter(Boolean);
      const faltam = pedidos.filter(id => !porId.has(id));
      return { leads: achados, faltam };
    }
    const f = e.filtro && typeof e.filtro === "object" ? e.filtro : null;
    const criterios = f ? Object.entries(f).filter(([k, v]) => k !== "incluir_finalizados" && v !== undefined && v !== "" && v !== false) : [];
    if (!criterios.length) return { erro: "Diga quais leads: lead_ids (de buscar_leads) ou um filtro com pelo menos um critério." };
    return { leads: filtrar(t.lista, f), faltam: [] };
  }

  /* Uma ação sobre vários leads, com a prévia quando passa do limite.
     `porLead(l)` faz UMA chamada de rota e devolve { erro? }. */
  async function emLote(ferramenta, e, efeitos, { descrever, porLead, teto = TETO, feito }, previa) {
    let leads;
    if (previa) leads = previa.leads;
    else {
      const s = await selecionar(e);
      if (s.erro) return { erro: s.erro };
      if (!s.leads.length) return { erro: "Nenhum lead bate com essa seleção." + (s.faltam.length ? ` (${s.faltam.length} id(s) não encontrados nesta conta.)` : "") };
      if (s.leads.length > teto) return { erro: `São ${s.leads.length} leads — o máximo por vez é ${teto}. Divida a seleção (por etapa, por pessoa ou por data).` };
      leads = s.leads.map(l => ({ id: l.id, nome: l.name }));
      if (leads.length > LIMITE_DIRETO) {
        const codigo = guardarPrevia({ ferramenta, conversaId, userId: user.id, pergunta: efeitos.pergunta, leads, entrada: e });
        return {
          dados: { precisa_confirmar: true, codigo, quantos: leads.length, o_que_vai_acontecer: descrever(leads.length),
            exemplos: leads.slice(0, 8).map(l => l.nome), ids_nao_encontrados: s.faltam.length || undefined,
            instrucao: "Mostre isto à pessoa e espere ela confirmar numa nova mensagem. Só então chame de novo com confirmacao: codigo." },
          mostrar: `Aguardando sua confirmação: ${descrever(leads.length)}.`, tipo: "aviso",
        };
      }
    }
    const falhas = [];
    let certos = 0;
    for (const l of leads) {
      const r = await porLead(l);
      if (r && r.erro) falhas.push({ lead: l.nome, motivo: r.erro });
      else certos++;
    }
    esquecerLista();
    registrarAcao(ferramenta, { ...e, leads: leads.length }, falhas.length && !certos ? { erro: falhas[0].motivo } : {});
    const motivos = [...new Set(falhas.map(f => f.motivo))].slice(0, 3);
    return {
      dados: { feitos: certos, falharam: falhas.length, falhas: falhas.slice(0, 15) },
      ...(certos ? {} : { erro: `Nenhum lead mudou: ${motivos.join(" / ")}` }),
      mostrar: certos
        ? `✓ ${feito(certos)}${falhas.length ? ` — ${falhas.length} ficaram de fora (${motivos.join(" / ")})` : ""}.`
        : `Não deu: ${motivos.join(" / ")}`,
    };
  }

  const uma = async (ferramenta, e, metodo, caminho, corpo, frase) => {
    const r = await chamarRota(autorizacao, metodo, caminho, corpo);
    registrarAcao(ferramenta, e, r);
    esquecerLista();
    return r.erro ? { erro: r.erro, mostrar: `Não deu: ${r.erro}` } : { dados: r.dados, mostrar: frase };
  };
  const nomeDoLead = async (id) => {
    const t = await todos();
    return (t.lista || []).find(l => l.id === id)?.name || "o lead";
  };
  const plural = (n, um, varios) => (n === 1 ? um : varios.replace("#", n));

  /* A confirmação executa EXATAMENTE o que a prévia mostrou: a entrada
     guardada substitui o que vier na segunda chamada. Sem isto, o modelo
     poderia confirmar "mover para Visita" mandando outra etapa junto. */
  const EM_LOTE = new Set(["mover_leads", "migrar_funil_da_pessoa", "repassar_leads", "etiquetar_leads", "finalizar_leads"]);
  return async (nome, entrada, efeitos) => {
    let e = entrada || {}, previa = null;
    if (EM_LOTE.has(nome)) {
      const { confirmacao, ...resto } = e;
      if (confirmacao) {
        const c = pegarPrevia(confirmacao, { ferramenta: nome, conversaId, userId: user.id, pergunta: efeitos.pergunta });
        if (c.erro) return { erro: c.erro };
        previa = c.previa;
        e = previa.entrada;
      } else e = resto;
    }
    switch (nome) {
      case "buscar_leads": {
        const t = await todos();
        if (t.erro) return { erro: t.erro };
        const lista = filtrar(t.lista, e)
          .sort((a, b) => (b.last_interaction_at || b.created_at || 0) - (a.last_interaction_at || a.created_at || 0));
        const n = Math.max(1, Math.min(50, Number(e.limite) || 20));
        return { dados: { total: lista.length, leads: await Promise.all(lista.slice(0, n).map(resumo)) } };
      }
      case "ver_lead": {
        const r = await chamarRota(autorizacao, "GET", `/leads/${encodeURIComponent(e.lead_id)}`);
        if (r.erro) return { erro: r.erro };
        const l = r.dados;
        return { dados: {
          ...(await resumo(l)),
          email: l.email || undefined,
          qualificacao: l.qual && Object.keys(l.qual).length ? l.qual : undefined,
          campos: l.custom_fields && Object.keys(l.custom_fields).length ? l.custom_fields : undefined,
          observacoes: (l.observacoes || []).slice(-10).map(o => ({ texto: o.texto, por: o.autor_nome || undefined })),
          tarefas: (l.lista_tarefas || []).slice(0, 10).map(t => sem({ titulo: t.titulo, quando: quando(t.quando), feita: t.feita ? true : undefined })),
          conversa: (l.messages || []).filter(m => m.body).slice(-30).map(m => ({
            de: m.direction === "in" ? "cliente" : "imobiliária", texto: String(m.body).slice(0, 500), em: quando(m.created_at) })),
        } };
      }

      case "mover_leads": {
        const { etapas } = await pipes();
        const destino = etapas.get(e.etapa_id);
        if (!destino) return { erro: "Etapa não encontrada nesta conta. Use os ids de ver_funis." };
        const onde = `${destino.funil} › ${destino.nome}`;
        return emLote(nome, e, efeitos, {
          descrever: (n) => `mover ${plural(n, "1 lead", "# leads")} para ${onde}`,
          porLead: (l) => chamarRota(autorizacao, "PATCH", `/leads/${encodeURIComponent(l.id)}/stage`, { stage_id: e.etapa_id }),
          feito: (n) => `${plural(n, "1 lead movido", "# leads movidos")} para ${onde}`,
        }, previa);
      }

      case "migrar_funil_da_pessoa": {
        if (previa) {
          const x = e;
          const r = await chamarRota(autorizacao, "POST", "/leads/lote/mover-funil",
            sem({ user_id: x.pessoa_id, pipeline_id: x.funil_id, stage_id: x.etapa_id, manter_etapa: !!x.manter_etapa }));
          registrarAcao(nome, x, r);
          esquecerLista();
          if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` };
          return { dados: r.dados, mostrar: `✓ ${plural(r.dados.movidos || 0, "1 lead levado", "# leads levados")} para o funil ${r.dados.destino || ""}.` };
        }
        const qs = new URLSearchParams(sem({ user_id: e.pessoa_id, pipeline_id: e.funil_id, stage_id: e.etapa_id, manter: e.manter_etapa ? "1" : undefined }));
        const r = await chamarRota(autorizacao, "GET", "/leads/lote/mover-funil?" + qs);
        if (r.erro) return { erro: r.erro };
        if (!r.dados.leads) return { dados: { ...r.dados, nada_a_mover: true } };
        const codigo = guardarPrevia({ ferramenta: nome, conversaId, userId: user.id, pergunta: efeitos.pergunta, entrada: e });
        const frase = `levar ${plural(r.dados.leads, "1 lead", "# leads")} de ${r.dados.pessoa} para o funil ${r.dados.destino}`;
        return { dados: { precisa_confirmar: true, codigo, previa: r.dados, o_que_vai_acontecer: frase,
          instrucao: "Mostre isto à pessoa (inclusive em que etapa os leads caem) e espere ela confirmar numa nova mensagem. Só então chame de novo com confirmacao: codigo." },
          mostrar: `Aguardando sua confirmação: ${frase}.`, tipo: "aviso" };
      }

      case "repassar_leads": {
        const para = String(e.para || "");
        let quem = para === "roleta" ? "o próximo da catraca" : para === "fila" ? "a fila" : para === "eu" ? "você" : null;
        if (!quem) {
          const r = await chamarRota(autorizacao, "GET", "/pipelines/entrada");
          const p = (r.dados?.pessoas || []).find(x => x.id === para);
          if (!p) return { erro: "Pessoa não encontrada na equipe ativa. Use os ids de ver_equipe." };
          quem = p.name;
        }
        return emLote(nome, e, efeitos, {
          teto: TETO_REPASSE,
          descrever: (n) => `passar ${plural(n, "1 lead", "# leads")} para ${quem}`,
          porLead: (l) => {
            const id = l.id;
            if (para === "roleta") return chamarRota(autorizacao, "POST", "/distribution/handoff", { lead_id: id });
            if (para === "fila") return chamarRota(autorizacao, "POST", "/distribution/devolver", { lead_id: id });
            if (para === "eu") return chamarRota(autorizacao, "POST", "/distribution/assumir", { lead_id: id });
            return chamarRota(autorizacao, "POST", "/distribution/devolver", { lead_id: id, user_id: para });
          },
          feito: (n) => `${plural(n, "1 lead passado", "# leads passados")} para ${quem}`,
        }, previa);
      }

      case "etiquetar_leads": {
        const r = await chamarRota(autorizacao, "GET", "/tags");
        const tag = (r.dados?.tags || []).find(t => t.id === e.tag_id);
        if (!tag) return { erro: "Tag não encontrada. Use os ids de ver_tags." };
        const pondo = e.acao !== "tirar";
        return emLote(nome, e, efeitos, {
          descrever: (n) => `${pondo ? "colocar" : "tirar"} a tag “${tag.nome}” ${pondo ? "em" : "de"} ${plural(n, "1 lead", "# leads")}`,
          porLead: (l) => chamarRota(autorizacao, pondo ? "POST" : "DELETE", `/leads/${encodeURIComponent(l.id)}/tags/${encodeURIComponent(tag.id)}`),
          feito: (n) => `Tag “${tag.nome}” ${pondo ? "colocada em" : "tirada de"} ${plural(n, "1 lead", "# leads")}`,
        }, previa);
      }

      case "finalizar_leads": {
        const fim = e.acao !== "reabrir";
        if (!previa && !fim && e.filtro) e = { ...e, filtro: { ...e.filtro, incluir_finalizados: true } };
        return emLote(nome, e, efeitos, {
          descrever: (n) => `${fim ? "finalizar" : "reabrir"} o atendimento de ${plural(n, "1 lead", "# leads")}`,
          porLead: (l) => chamarRota(autorizacao, "POST", `/leads/${encodeURIComponent(l.id)}/${fim ? "finalizar" : "reabrir"}`),
          feito: (n) => `${plural(n, "1 atendimento", "# atendimentos")} ${fim ? plural(n, "finalizado", "finalizados") : plural(n, "reaberto", "reabertos")}`,
        }, previa);
      }

      case "criar_tarefa": {
        const t = new Date(String(e.quando || "").length <= 16 ? `${e.quando}:00` : e.quando).getTime();
        if (!isFinite(t)) return { erro: "Data e hora inválidas. Use AAAA-MM-DDTHH:MM." };
        return uma(nome, e, "POST", `/leads/${encodeURIComponent(e.lead_id)}/tarefas`, { titulo: e.titulo, quando: t },
          `✓ Tarefa “${e.titulo}” para ${quando(t)} em ${await nomeDoLead(e.lead_id)}.`);
      }
      case "adicionar_observacao":
        return uma(nome, e, "POST", `/leads/${encodeURIComponent(e.lead_id)}/observacoes`, { texto: e.texto },
          `✓ Observação escrita em ${await nomeDoLead(e.lead_id)}.`);
      case "corrigir_nome":
        return uma(nome, e, "PATCH", `/leads/${encodeURIComponent(e.lead_id)}/nome`, { nome: e.nome }, `✓ Nome corrigido para “${e.nome}”.`);
      case "cadastrar_lead":
        return uma(nome, e, "POST", "/leads", sem({ nome: e.nome, telefone: e.telefone, pais: e.pais, stage_id: e.etapa_id,
          assigned_to: e.responsavel_id, observacao: e.observacao }), `✓ Cadastrei o lead ${e.nome}.`);
      case "registrar_venda": {
        const hoje = new Date(); const d = (x) => String(x).padStart(2, "0");
        const data = e.data || `${hoje.getFullYear()}-${d(hoje.getMonth() + 1)}-${d(hoje.getDate())}`;
        return uma(nome, e, "PATCH", `/leads/${encodeURIComponent(e.lead_id)}/venda`,
          sem({ valor: e.valor, data, imovel: e.imovel, comissao: e.comissao_pct }),
          `✓ Venda de R$ ${Number(e.valor).toLocaleString("pt-BR")} registrada em ${await nomeDoLead(e.lead_id)}.`);
      }
      case "ver_numeros": {
        const qs = new URLSearchParams(sem({ periodo: e.periodo || "este_mes", responsavel: e.responsavel_id }));
        const r = await chamarRota(autorizacao, "GET", "/painel/geral?" + qs);
        if (r.erro) return { erro: r.erro };
        const d = r.dados;
        return { dados: { periodo: d.periodo, indicadores: d.kpis,
          funil_de_atividade: (d.funil_atividade || []).map(p => ({ passo: p.nome, valor: p.valor })), metas: d.metas } };
      }
      default: return null;
    }
  };
}

export const NOMES_DAS_FERRAMENTAS_DE_LEADS = new Set(FERRAMENTAS_LEADS.map(f => f.name));
