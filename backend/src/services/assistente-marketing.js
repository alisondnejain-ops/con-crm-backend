/* O CLAUDE DO GESTOR CONFIGURA O MARKETING, AS CATRACAS, OS FORMULÁRIOS E O
   AUTOATENDIMENTO (08/10/2026, pedido do Ali: "liberar o acesso completo ao
   marketing de cada conta… esse acesso vai ser para o assistente do Claude").

   Mesma regra de assistente.js e assistente-leads.js: a IA não tem poder
   próprio. Cada ferramenta é a MESMA rota que a tela usa, com o crachá de
   quem conversa — fluxo só com o Marketing liberado e o termo aceito, ligar o
   Autoatendimento só com a ferramenta no plano, catraca só em conta que tem
   catraca. A recusa da rota volta com a frase da tela.

   Só o modo de configuração (gestor e dono de autônomo) recebe estas
   ferramentas — quem decide é `modoDe`, no servidor.

   O QUE NÃO ESTÁ AQUI, de propósito: disparar campanha para uma lista (é
   mensagem para centenas de clientes, e a declaração de origem é assinada por
   uma pessoa na tela), apagar fluxo ou catraca, e mexer no número de disparo.
   Para isso a IA leva a pessoa à tela. Orientações e fichas de produto podem
   ser apagadas: o Ali pediu, e são textos da própria equipe. */

const T = (name, description, properties = {}, required = []) =>
  ({ name, description, input_schema: { type: "object", properties, required, additionalProperties: false } });
const sem = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const enc = encodeURIComponent;

/* ===== O FORMATO DO FLUXO (o mesmo do construtor) ===== */
const GATILHO = {
  type: "object", additionalProperties: false,
  description: "Quando alguém entra sozinho no fluxo. manual = só por disparo em massa (não liga sozinho).",
  properties: {
    tipo: { type: "string", enum: ["manual", "formulario", "lead_novo", "etapa", "etiqueta", "campo"] },
    form_ids: { type: "array", items: { type: "string" }, description: "formulario: ids de ver_formularios — um ou vários (o fluxo vale para todos)" },
    origens: { type: "array", items: { type: "string", enum: ["whatsapp", "formulario", "portal", "manual"] }, description: "lead_novo: de onde (vazio = todas)" },
    etapa_id: { type: "string", description: "etapa: id de ver_funis" },
    tag_id: { type: "string", description: "etiqueta: id de ver_tags" },
    campo: { type: "string", description: "campo: chave de ver_campos" },
    valor: { type: "string", description: "campo: valor esperado (vazio = qualquer valor)" },
    reentrada: { type: "boolean", description: "o mesmo lead pode entrar de novo (depois de terminar, com 1h de intervalo)" },
    parar_ao_responder: { type: "boolean", description: "parar o fluxo quando o cliente responder" },
  },
  required: ["tipo"],
};
const DESCRICAO_BLOCOS = `Blocos (campo "tipo") e o que cada um leva em "dados":
- mensagem: {texto, midia?} — {nome} vira o primeiro nome do cliente. Ou {modelo:{nome, idioma, texto, variaveis:[...]}} para modelo aprovado da Meta (de ver_modelos_meta). Saída: proximo.
- espera: {quantidade, unidade: minutos|horas|dias}. Saída: proximo.
- resposta (esperar a resposta e desviar): {regras:[{id, palavras:"sim, quero"}], prazo:{quantidade, unidade}}. Saídas: o id de cada regra, "outra", "sem_resposta".
- botoes: {texto, botoes:[{id, rotulo (até 20 letras)}] (até 3), prazo}. Saídas: o id de cada botão, "outra", "sem_resposta".
- condicao: {regra: tag|etapa|temperatura|responsavel|campo|respondeu, valor, campo}. tag/etapa: valor = id; temperatura: QUENTE|MORNO|FRIO|SEM; responsavel: com|sem; campo: campo = chave e valor esperado (vazio = preenchido); respondeu: o cliente mandou mensagem desde que entrou. Saídas: sim, nao.
- add_tag / remover_tag: {tag_id}. mover_etapa: {etapa_id}. atribuir: {modo: catraca|pessoa|fila, catraca_id?, user_id?}. tarefa: {titulo, em_horas}. Saída: proximo.
Ligações: [{de, saida, para}] — de/para são ids de bloco; o início tem id "inicio" e saída "proximo". Uma ligação por saída. Sem ligação, o fluxo termina ali.`;

export const FERRAMENTAS_MARKETING = [
  // Fluxos
  T("ver_fluxos", "Lista os fluxos de Marketing: gatilho, quantos blocos, se a automação está ligada e quantos leads entraram."),
  T("ver_fluxo", "Abre um fluxo inteiro: gatilho, blocos (com ids e dados), ligações, o que falta para ligar e os números da automação. Chame antes de editar — para editar, mande o fluxo inteiro de volta.",
    { fluxo_id: { type: "string" } }, ["fluxo_id"]),
  T("salvar_fluxo", `Cria (sem fluxo_id) ou substitui (com fluxo_id) um fluxo. Mande SEMPRE o fluxo inteiro: gatilho, todos os blocos e todas as ligações. As posições na tela são arrumadas sozinhas. Não liga a automação — para isso, ligar_fluxo.\n${DESCRICAO_BLOCOS}`,
    { fluxo_id: { type: "string" }, nome: { type: "string" }, gatilho: GATILHO,
      blocos: { type: "array", items: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", description: "curto, sem espaço (ex.: b1)" }, tipo: { type: "string" }, dados: { type: "object" } }, required: ["id", "tipo"] } },
      ligacoes: { type: "array", items: { type: "object", additionalProperties: false, properties: {
        de: { type: "string" }, saida: { type: "string" }, para: { type: "string" } }, required: ["de", "saida", "para"] } } },
    ["nome", "gatilho", "blocos", "ligacoes"]),
  T("ligar_fluxo", "Liga (ativo true) ou desliga a automação de um fluxo com gatilho. Desligar só fecha a porta: quem está no meio termina. Se faltar algo, a recusa diz o quê.",
    { fluxo_id: { type: "string" }, ativo: { type: "boolean" } }, ["fluxo_id", "ativo"]),
  T("ver_execucoes_do_fluxo", "Os últimos leads que passaram pela automação e por onde cada um andou.", { fluxo_id: { type: "string" } }, ["fluxo_id"]),
  T("ver_modelos_meta", "Os modelos de mensagem aprovados na API oficial da Meta (nome, idioma, texto, quantas variáveis). Sem API oficial, vem vazio com o motivo."),
  // Catracas
  T("ver_catracas", "Lista as catracas por produto: participantes (ids), de onde recebem, etapa que aciona, ficha de produto da IA e a vez. Também a catraca principal."),
  T("salvar_catraca", "Cria (sem catraca_id) ou edita uma catraca por produto. Mande só o que muda ao editar. membros: ids de corretores (ver_equipe).",
    { catraca_id: { type: "string" }, nome: { type: "string" },
      membros: { type: "array", items: { type: "string" } },
      entrega: { type: "string", enum: ["atendente", "corretor"], description: "atendente = a atendente da vez recebe e repassa; corretor = vai direto ao próximo disponível" },
      ativa: { type: "boolean" },
      canais: { type: "object", additionalProperties: false, properties: {
        whatsapp: { type: "boolean" }, portal: { type: "boolean" }, site: { type: "boolean" },
        formularios: { type: "array", items: { type: "string" }, description: "ids de ver_formularios" } } },
      funil_id: { type: ["string", "null"], description: "funil da etapa que aciona (null tira)" },
      etapa_id: { type: ["string", "null"] },
      ficha_id: { type: ["string", "null"], description: "ficha de produto da IA (ver_fichas_de_produto); null tira" } }),
  // Formulários
  T("ver_formularios", "Os formulários dos anúncios do Meta: funil e etapa em que o lead nasce, catracas e ficha de produto da IA."),
  T("configurar_formulario", "Configura um formulário do anúncio: funil/etapa em que o lead nasce (funil_id vazio = funil de quem recebe), catracas e ficha de produto da IA. Mande só o que muda. Vale para os próximos leads.",
    { form_id: { type: "string" }, funil_id: { type: ["string", "null"] }, etapa_id: { type: ["string", "null"] },
      catraca_ids: { type: "array", items: { type: "string" } }, ficha_id: { type: ["string", "null"] } }, ["form_id"]),
  // Autoatendimento
  T("ver_autoatendimento", "Como está o Autoatendimento (a IA que atende o cliente): ligado, horário, dias, máximo de mensagens, onde atua (funis/etapas), campos que preenche, se escreve o resumo e a etapa para onde move ao terminar."),
  T("configurar_autoatendimento", "Muda o Autoatendimento. Mande só o que muda. Ligar exige a ferramenta no plano. escopo vazio = atua em todo lugar.",
    { ativo: { type: "boolean" }, a_qualquer_hora: { type: "boolean" },
      inicio: { type: "string", description: "HH:MM — a IA assume (com horário)" }, fim: { type: "string", description: "HH:MM — a equipe assume" },
      dias_da_equipe: { type: "array", items: { type: "integer" }, description: "dias em que a EQUIPE trabalha: 0=domingo … 6=sábado" },
      max_mensagens: { type: "integer" },
      escopo: { type: "object", additionalProperties: false, properties: {
        funis: { type: "array", items: { type: "string" } }, etapas: { type: "array", items: { type: "string" } } } },
      campos: { type: "array", items: { type: "string" }, description: "chaves de ver_campos que a IA pode preencher" },
      escrever_resumo: { type: "boolean", description: "ao se despedir, escreve o resumo como observação" },
      etapa_final_id: { type: ["string", "null"], description: "para onde mover quando termina e o cliente quer seguir (null = não mover)" } }),
  T("editar_orientacao_da_ia", "Edita, liga ou desliga uma orientação do Autoatendimento (id de ver_orientacoes_da_ia).",
    { id: { type: "string" }, texto: { type: "string" }, ativa: { type: "boolean" } }, ["id"]),
  T("apagar_orientacao_da_ia", "Apaga uma orientação do Autoatendimento.", { id: { type: "string" } }, ["id"]),
  T("ver_fichas_de_produto", "As fichas de produto da IA (uma por empreendimento): texto, imóvel do catálogo ligado e onde estão ligadas."),
  T("salvar_ficha_de_produto", "Cria (sem ficha_id) ou edita uma ficha de produto: o que a IA precisa saber de um empreendimento. O que a IA pode falar segue as orientações da conta. Ligue a ficha a formulário (configurar_formulario) ou catraca (salvar_catraca).",
    { ficha_id: { type: "string" }, nome: { type: "string" }, texto: { type: "string" },
      imovel_id: { type: ["string", "null"], description: "imóvel do catálogo (ver_imoveis)" }, ativa: { type: "boolean" } }),
  T("apagar_ficha_de_produto", "Apaga uma ficha de produto (ela sai dos formulários e catracas).", { ficha_id: { type: "string" } }, ["ficha_id"]),
  // Imóveis
  T("ver_imoveis", "O catálogo de imóveis da conta (até 40), para usar de base nas fichas e nas orientações.",
    { busca: { type: "string", description: "parte do título, bairro, cidade ou construtora" },
      finalidade: { type: "string", enum: ["venda", "aluguel"] }, cidade: { type: "string" } }),
  T("ver_imovel", "Abre um imóvel do catálogo com todos os dados.", { imovel_id: { type: "string" } }, ["imovel_id"]),
];
export const NOMES_DAS_FERRAMENTAS_DE_MARKETING = new Set(FERRAMENTAS_MARKETING.map(f => f.name));

/* Posição na tela: colunas pela distância do início, empilhadas na ordem. */
function arrumar(nos, ligacoes) {
  const col = new Map([["inicio", 0]]), fila = ["inicio"];
  while (fila.length) {
    const id = fila.shift();
    for (const l of ligacoes) if (l.de === id && !col.has(l.para)) { col.set(l.para, col.get(id) + 1); fila.push(l.para); }
  }
  const maxCol = Math.max(0, ...col.values());
  const porCol = new Map();
  return nos.map(n => {
    const c = col.has(n.id) ? col.get(n.id) : maxCol + 1;
    const i = porCol.get(c) || 0; porCol.set(c, i + 1);
    return { ...n, x: 60 + c * 310, y: 60 + i * 190 };
  });
}

const resumoGrafo = (g) => ({
  gatilho: (g.nos || []).find(n => n.tipo === "inicio")?.dados?.gatilho || { tipo: "manual" },
  blocos: (g.nos || []).filter(n => n.tipo !== "inicio").map(n => ({ id: n.id, tipo: n.tipo, dados: n.dados })),
  ligacoes: g.ligacoes || [],
});

export function executorDeMarketing({ chamarRota, autorizacao, registrarAcao }) {
  const ler = async (caminho, montar = (d) => d) => {
    const r = await chamarRota(autorizacao, "GET", caminho);
    return r.erro ? { erro: r.erro } : { dados: montar(r.dados) };
  };
  const mudar = async (ferramenta, entrada, metodo, caminho, corpo, frase) => {
    const r = await chamarRota(autorizacao, metodo, caminho, corpo);
    registrarAcao(ferramenta, entrada, r);
    return r.erro ? { erro: r.erro, mostrar: `Não deu: ${r.erro}` } : { dados: r.dados, mostrar: frase };
  };

  return async (nome, e) => {
    if (!NOMES_DAS_FERRAMENTAS_DE_MARKETING.has(nome)) return null;
    switch (nome) {
      case "ver_fluxos": return ler("/marketing/fluxos", (d) => ({ fluxos: (d.fluxos || []).map(f => ({
        id: f.id, nome: f.nome, gatilho: f.gatilho, blocos: f.blocos, ligado: f.ativo, entraram: f.entraram, disparos: f.disparos })) }));
      case "ver_fluxo": return ler(`/marketing/fluxos/${enc(e.fluxo_id)}`, (d) => ({
        id: d.id, nome: d.nome, ligado: d.ativo, ...resumoGrafo(d.grafo),
        falta_para_ligar: [...(d.gatilho_avisos || []), ...(d.avisos || [])], automacao_desatualizada: d.automacao_desatualizada || undefined,
        numeros: d.automacao ? sem({ ...d.automacao, por_bloco: undefined }) : undefined }));
      case "salvar_fluxo": {
        const blocos = Array.isArray(e.blocos) ? e.blocos.filter(b => b && b.id !== "inicio" && b.tipo !== "inicio") : [];
        const ligacoes = Array.isArray(e.ligacoes) ? e.ligacoes : [];
        /* form_ids (o que a IA manda) vira a lista do gatilho. Sem funil nem
           catraca junto: o que cada formulário já tem não é tocado. */
        const { form_ids, ...gat } = e.gatilho || { tipo: "manual" };
        if (Array.isArray(form_ids)) gat.formularios = form_ids.map(id => ({ id: String(id) }));
        const nos = arrumar([{ id: "inicio", tipo: "inicio", dados: { gatilho: gat } },
          ...blocos.map(b => ({ id: String(b.id), tipo: b.tipo, dados: b.dados || {} }))], ligacoes);
        let id = e.fluxo_id;
        if (!id) {
          const c = await chamarRota(autorizacao, "POST", "/marketing/fluxos", { nome: e.nome });
          if (c.erro) { registrarAcao(nome, e, c); return { erro: c.erro, mostrar: `Não deu: ${c.erro}` }; }
          id = c.dados.id;
        }
        const r = await chamarRota(autorizacao, "PUT", `/marketing/fluxos/${enc(id)}`, { nome: e.nome, grafo: { nos, ligacoes } });
        registrarAcao(nome, e, r);
        if (r.erro) return { erro: r.erro + (e.fluxo_id ? "" : ` (o fluxo “${e.nome}” foi criado vazio; corrija e salve de novo com fluxo_id ${id})`), mostrar: `Não deu: ${r.erro}` };
        const falta = [...(r.dados.gatilho_avisos || []), ...(r.dados.avisos || [])];
        return { dados: { fluxo_id: id, ligado: r.dados.ativo, falta_para_ligar: falta, ...resumoGrafo(r.dados.grafo) },
          mostrar: `✓ ${e.fluxo_id ? "Atualizei" : "Criei"} o fluxo “${e.nome}”.${falta.length ? ` Para ligar, falta: ${falta[0]}` : ""}` };
      }
      case "ligar_fluxo": return mudar(nome, e, "POST", `/marketing/fluxos/${enc(e.fluxo_id)}/ativar`, { ativo: !!e.ativo },
        e.ativo ? "✓ Automação ligada." : "✓ Automação desligada (quem está no meio termina).");
      case "ver_execucoes_do_fluxo": return ler(`/marketing/fluxos/${enc(e.fluxo_id)}/logs`, (d) => ({ execucoes: (d.execucoes || []).slice(0, 30).map(x => ({
        lead: x.nome, estado: x.estado, motivo: x.fim_motivo || undefined, entrou: new Date(x.criado_em).toLocaleString("pt-BR"),
        passos: (x.passos || []).map(p => `${p.no_id}: ${p.erro ? "falhou — " + p.erro : p.texto || p.status}`) })) }));
      case "ver_modelos_meta": return ler("/marketing/modelos-meta");

      case "ver_catracas": return ler("/distribution/catracas", (d) => ({
        principal: d.principal ? { vez: d.principal.proximo?.name || null } : null,
        catracas: (d.catracas || []).map(c => sem({ id: c.id, nome: c.nome, ativa: c.ativa, entrega: c.entrega, membros: c.membros,
          canais: c.canais,
          etapa_que_aciona: c.etapa ? (c.etapa.ok ? `${c.etapa.funil} › ${c.etapa.nome}` : "apagada ou desativada") : null,
          funil_id: c.pipeline_id, etapa_id: c.stage_id, ficha_id: c.ia_produto_id, leads_abertos: c.leads_abertos,
          vez: c.fila?.proximo?.name || null })) }));
      case "salvar_catraca": {
        const corpo = sem({ nome: e.nome, membros: e.membros, entrega: e.entrega, ativa: e.ativa, canais: e.canais,
          ...(e.etapa_id !== undefined || e.funil_id !== undefined ? { pipeline_id: e.funil_id || null, stage_id: e.etapa_id || null } : {}),
          ia_produto_id: e.ficha_id === undefined ? undefined : e.ficha_id || null });
        if (e.catraca_id) return mudar(nome, e, "PATCH", `/distribution/catracas/${enc(e.catraca_id)}`, corpo, `✓ Catraca atualizada${e.nome ? ` (“${e.nome}”)` : ""}.`);
        return mudar(nome, e, "POST", "/distribution/catracas", corpo, `✓ Criei a catraca “${e.nome}”.`);
      }

      case "ver_formularios": return ler("/anuncios-meta/formularios", (d) => ({
        erros: (d.erros || []).length ? d.erros : undefined,
        formularios: (d.formularios || []).map(f => sem({ id: f.id, nome: f.nome, arquivado: f.status && f.status !== "ACTIVE" ? true : undefined,
          leads_no_crm: f.leads_crm, funil_id: f.pipeline_id, etapa_id: f.stage_id, entrada: f.entrada || undefined,
          funil_invalido: f.funil_invalido || undefined, catraca_ids: f.catraca_ids, ficha_id: f.ia_produto_id })) }));
      case "configurar_formulario": {
        const feito = [], f = enc(e.form_id);
        if (e.funil_id !== undefined || e.etapa_id !== undefined) {
          const r = await chamarRota(autorizacao, "POST", `/anuncios-meta/formularios/${f}`, { pipeline_id: e.funil_id || null, stage_id: e.etapa_id || null });
          registrarAcao(nome, e, r); if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` }; feito.push("funil");
        }
        if (e.catraca_ids !== undefined) {
          const r = await chamarRota(autorizacao, "POST", `/anuncios-meta/formularios/${f}/catraca`, { catraca_ids: e.catraca_ids });
          registrarAcao(nome, e, r); if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` }; feito.push("catracas");
        }
        if (e.ficha_id !== undefined) {
          const r = await chamarRota(autorizacao, "POST", `/anuncios-meta/formularios/${f}/produto`, { ia_produto_id: e.ficha_id || null });
          registrarAcao(nome, e, r); if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` }; feito.push("ficha de produto");
        }
        if (!feito.length) return { erro: "Diga o que mudar: funil/etapa, catracas ou ficha." };
        return { dados: { ok: true, mudou: feito }, mostrar: `✓ Formulário configurado (${feito.join(", ")}).` };
      }

      case "ver_autoatendimento": return ler("/config/robo", (d) => sem({ incluido_no_plano: d.incluido, ligado: d.ativo, ia_no_servidor: d.configurada,
        a_qualquer_hora: d.sempre, inicio: d.inicio, fim: d.fim, dias_da_equipe: d.dias, max_mensagens: d.teto, atendendo_agora: d.agora_atenderia,
        escopo: { funis: d.escopo?.pipelines || [], etapas: d.escopo?.etapas || [] }, campos: d.campos, escrever_resumo: d.observacao,
        etapa_final_id: d.etapa_final }));
      case "configurar_autoatendimento": {
        const feito = [];
        const geral = sem({ ativo: e.ativo, sempre: e.a_qualquer_hora, inicio: e.inicio, fim: e.fim, dias: e.dias_da_equipe, teto: e.max_mensagens });
        if (Object.keys(geral).length) {
          const r = await chamarRota(autorizacao, "POST", "/config/robo", geral);
          registrarAcao(nome, e, r); if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` }; feito.push("geral");
        }
        const acoes = sem({ escopo: e.escopo ? { pipelines: e.escopo.funis || [], etapas: e.escopo.etapas || [] } : undefined,
          campos: e.campos, observacao: e.escrever_resumo, etapa_final: e.etapa_final_id === undefined ? undefined : e.etapa_final_id || null });
        if (Object.keys(acoes).length) {
          const r = await chamarRota(autorizacao, "POST", "/config/robo/acoes", acoes);
          registrarAcao(nome, e, r); if (r.erro) return { erro: r.erro, mostrar: `Não deu: ${r.erro}` }; feito.push("ações");
        }
        if (!feito.length) return { erro: "Diga o que mudar no Autoatendimento." };
        return { dados: { ok: true }, mostrar: "✓ Autoatendimento atualizado." };
      }
      case "editar_orientacao_da_ia": return mudar(nome, e, "PATCH", `/config/robo/ensino/${enc(e.id)}`, sem({ texto: e.texto, ativo: e.ativa }), "✓ Orientação atualizada.");
      case "apagar_orientacao_da_ia": return mudar(nome, e, "DELETE", `/config/robo/ensino/${enc(e.id)}`, undefined, "✓ Orientação apagada.");
      case "ver_fichas_de_produto": return ler("/config/robo/produtos", (d) => ({ fichas: (d.fichas || []).map(f => sem({ id: f.id, nome: f.nome, texto: f.texto,
        ativa: f.ativo, imovel: f.produto_titulo || undefined, imovel_id: f.produto_id || undefined,
        formularios: f.formularios.map(x => x.nome), catracas: f.catracas.map(x => x.nome) })) }));
      case "salvar_ficha_de_produto": {
        const corpo = sem({ nome: e.nome, texto: e.texto, produto_id: e.imovel_id === undefined ? undefined : e.imovel_id || null, ativo: e.ativa });
        if (e.ficha_id) return mudar(nome, e, "PATCH", `/config/robo/produtos/${enc(e.ficha_id)}`, corpo, "✓ Ficha de produto atualizada.");
        const r = await mudar(nome, e, "POST", "/config/robo/produtos", corpo, `✓ Criei a ficha de produto “${e.nome}”.`);
        if (r.dados?.ficha) r.dados = { ficha_id: r.dados.ficha.id };
        return r;
      }
      case "apagar_ficha_de_produto": return mudar(nome, e, "DELETE", `/config/robo/produtos/${enc(e.ficha_id)}`, undefined, "✓ Ficha de produto apagada.");

      case "ver_imoveis": {
        const q = new URLSearchParams(sem({ q: e.busca || undefined, finalidade: e.finalidade, cidade: e.cidade }));
        return ler(`/produtos?${q}`, (d) => {
          const lista = Array.isArray(d) ? d : (d.produtos || []);
          return { total: lista.length, imoveis: lista.slice(0, 40).map(p => sem({ id: p.id, titulo: p.titulo, finalidade: p.finalidade, tipo: p.tipo,
            bairro: p.bairro || undefined, cidade: p.cidade || undefined, quartos: p.quartos || undefined, valor: p.valor || undefined, situacao: p.status })) };
        });
      }
      case "ver_imovel": return ler(`/produtos/${enc(e.imovel_id)}`, (p) => sem({ id: p.id, titulo: p.titulo, finalidade: p.finalidade, tipo: p.tipo,
        formato: p.formato || undefined, bairro: p.bairro || undefined, cidade: p.cidade || undefined, quartos: p.quartos || undefined,
        suites: p.suites || undefined, banheiros: p.banheiros || undefined, vagas: p.vagas || undefined, area_construida: p.area_util || undefined,
        terreno: p.metragem || undefined, valor: p.valor || undefined, modalidade: p.modalidade || undefined, construtora: p.construtor || undefined,
        descricao_do_anuncio: p.descricao || undefined, observacoes_internas: p.observacoes || undefined, situacao: p.status }));
      default: return null;
    }
  };
}
