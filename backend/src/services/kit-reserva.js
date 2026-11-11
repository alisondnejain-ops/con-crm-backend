/* O PACOTE DO RESERVA REAL DO RIO (11/11/2026, pedido do Ali: "pega tudo que
   a gente tem do Reserva e organiza na conta… fluxos, marketing, IA, tudo").

   Aplicado pelo master, uma vez, pelo hub (Ferramentas da conta → Modo
   empreendimento → "Aplicar o pacote do Reserva Real do Rio"). Liga o modo e
   cria o que a operação precisa para atender no primeiro dia. É IDEMPOTENTE:
   rodar de novo não duplica nada e NÃO sobrescreve o que a equipe já mudou —
   cada peça é procurada pelo nome antes de nascer.

   O conteúdo vem SÓ do material do empreendimento (a planilha de lotes da
   pasta "Reserva Real do Rio" no Drive do Ali, a peça de divulgação e o link
   do tour 3D). O que não está lá — preço, entrada, parcelas, infraestrutura,
   prazo de obra, documentação — não foi escrito: a ficha e as orientações
   dizem que o corretor confirma. Inventar isso aqui seria a IA prometendo ao
   cliente, em nome da incorporadora, o que ninguém decidiu.

   Os lotes entram com a situação da planilha em 11/11/2026 e só os que ainda
   não existem na conta: lote já cadastrado (ou já reservado, ou vendido pela
   tela) não é tocado. Cliente e corretor da planilha NÃO entram — reserva
   antiga de planilha não é reserva do sistema. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { criarFicha } from "./ia-produtos.js";
import { criarTag, CORES_TAG } from "./tags.js";
import { criarPipeline, inserirEtapa } from "./pipelines.js";
import { validarGrafo } from "./disparo.js";
import { ligarModo, salvarConfig, importar, configDoEmpreendimento } from "./lotes.js";

const NOME = "Reserva Real do Rio";
const TOUR = "https://rdantassmart.com/reservarealdorio";

/* A planilha "Reserva Real do Rio – Lotes", aba Lotes, como estava em
   11/11/2026 (Lote, Quadra, Área, Situação, Observação). */
export const LOTES_DA_PLANILHA = `Lote;Quadra;Área (m²);Status;Observação
A1;A;708,15;Disponível;
A2;A;641,15;Disponível;
A3;A;640,53;Disponível;
A4;A;638,57;Disponível;
A5;A;637,27;Disponível;
A6;A;635,98;Disponível;Conferir: planta x planilha de vendas
A7;A;634,01;Vendido;
A8;A;631,99;Vendido;Conferir: planta x planilha de vendas
A9;A;628,06;Vendido;
A10;A;623,46;Vendido;
A11;A;619,53;Vendido;
A12;A;616,39;Vendido;
A13;A;612,69;Vendido;
A14;A;608,32;Vendido;
A15;A;604,67;Disponível;
A16;A;803,31;Vendido;
B1;B;887,48;Disponível;
B2;B;600,00;Disponível;
B3;B;600,00;Disponível;
B4;B;600,00;Disponível;
B5;B;600,00;Disponível;
B6;B;600,00;Vendido;
B7;B;600,00;Disponível;
B8;B;600,00;Vendido;
B9;B;600,00;Disponível;
B10;B;795,83;Disponível;
C1;C;600,00;Vendido;
C2;C;600,00;Vendido;
C3;C;600,00;Disponível;
C4;C;600,00;Disponível;
C5;C;600,00;Vendido;
C6;C;600,00;Vendido;
C7;C;600,00;Vendido;
C8;C;600,00;Vendido;
C9;C;750,00;Vendido;
C10;C;750,00;Vendido;
C11;C;600,00;Vendido;
C12;C;600,00;Vendido;
C13;C;600,00;Vendido;
C14;C;600,00;Vendido;
C15;C;600,00;Vendido;
C16;C;600,00;Vendido;
C17;C;600,00;Vendido;
C18;C;600,00;Vendido;
D1;D;382,00;Vendido;
D2;D;626,98;Disponível;
D3;D;645,74;Disponível;
D4;D;684,50;Disponível;
D5;D;683,26;Vendido;
D6;D;702,03;Disponível;
D7;D;720,79;Vendido;
D8;D;739,55;Vendido;
D9;D;758,31;Vendido;
D10;D;780,04;Vendido;
D11;D;810,24;Vendido;
D12;D;840,97;Vendido;
D13;D;871,70;Vendido;
D14;D;902,43;Vendido;
D15;D;933,16;Vendido;
D16;D;1.209,67;Vendido;`;

const FICHA = `${NOME} — loteamento em Petrolina-PE, à beira do Rio São Francisco.
"Seu endereço à beira do São Francisco."

Lotes de 382 m² a 1.209,67 m², a maioria com 600 m², em quatro quadras (A, B, C e D). Quais estão disponíveis agora o sistema informa logo abaixo, em tempo real.

Tour 3D do loteamento: ${TOUR}

Ainda não estão escritos aqui, e por isso o corretor é quem informa: preço, entrada, parcelas e condições de pagamento; infraestrutura e áreas comuns; prazo de obras; documentação.`;

/* As orientações da primeira versão do pacote (11/11/2026). Algumas mandavam
   dizer "um corretor vai falar com você", o que a qualificação nova proíbe —
   reaplicar o pacote DESLIGA as que continuam com o texto original (editada
   pela equipe não é tocada; desligada não é apagada). */
const ORIENTACOES_V1 = [
  `Você atende o ${NOME}, um loteamento em Petrolina-PE à beira do Rio São Francisco. Trate a pessoa pelo primeiro nome, com acolhimento e sem pressa.`,
  "Antes de falar de lote, entenda o que a pessoa busca: construir a casa, investir ou ter um lugar de lazer, e qual tamanho de lote ela imagina.",
  "Não informe preço, entrada, parcelas nem condições de pagamento: diga que o corretor passa os valores atualizados.",
  "Fale só dos lotes que o sistema mostra como disponíveis. Você não reserva nem promete lote — quem reserva é o corretor.",
  "Pergunte se a pessoa já conhece a região e para quando ela pensa em comprar.",
  "Quando a pessoa pedir valores, quiser visitar o loteamento ou escolher um lote, diga que um corretor vai falar com ela em seguida e encerre o atendimento.",
];

/* A qualificação (11/11/2026), no molde da que o Fernando montou para os
   produtos da VJ: um objetivo claro (visita ao loteamento ou ligação de 10
   minutos), nada de prometer corretor, uma pergunta por vez, e o resumo no
   formato que o corretor lê. Cada linha cabe nos 500 caracteres do campo. */
const ORIENTACOES = [
  `Você faz o primeiro atendimento comercial do ${NOME}, loteamento à beira do Rio São Francisco em Petrolina-PE. Conecte com o cliente, apresente o loteamento e descubra o que ele busca. Não feche venda nem reserve lote pelo WhatsApp. A conversa segue o que o cliente traz, sem roteiro fixo, e o cliente não deve recomeçar com outra pessoa.`,
  "Toda mensagem sua termina com uma pergunta curta ou um próximo passo concreto. Só na confirmação final de dia e horário você encerra sem pergunta. Nunca deixe o cliente sem continuação.",
  "Cumprimente pelo primeiro nome. Se o lead veio de anúncio ou formulário, leia as respostas na observação do lead e não pergunte de novo o que já está lá.",
  "Apresente em poucas frases: loteamento à beira do Rio São Francisco, em Petrolina; lotes de 382 m² a 1.209,67 m², a maioria com 600 m²; quatro quadras; e quais estão disponíveis agora, só os que o sistema mostra. Feche com: \"Esse perfil está dentro do que você procura hoje?\"",
  `Quando a pessoa quiser conhecer o loteamento, mande o tour 3D: ${TOUR}`,
  "Nunca invente preço, entrada, parcela, infraestrutura, prazo de obra ou documentação. Se perguntarem, diga que isso te mostramos melhor na visita ou na ligação. Nunca diga que um lote está disponível sem o sistema mostrar, e nunca reserve nem prometa lote.",
  "Seu objetivo é marcar uma visita ao loteamento ou uma ligação de 10 minutos com o corretor. Proponha no momento certo: quando o cliente pedir preço, quiser escolher lote ou mostrar interesse claro. Pergunte o dia e o período: \"Fica melhor de manhã, à tarde ou depois das 18h?\". Se ele mora longe, proponha a ligação e mande o tour 3D.",
  "O convite para visita ou ligação só vem depois da pergunta \"esse perfil está dentro do que você procura?\". Se disser que não, pergunte o que faltou (tamanho do lote, localização, forma de pagamento, prazo) antes de convidar.",
  "Nunca diga que vai passar para o corretor ou que a equipe vai retornar. Diga que compreendeu e que vamos ajudá-lo nisso.",
  "Priorize a necessidade, uma pergunta por vez, sem questionário: para que é o lote (construir para morar, investir ou lazer), se conhece a região, para quando pensa em comprar, como pretende pagar e quem decide junto. Não exija todas as respostas para seguir.",
  "Se o cliente disser \"não era isso\" ou \"está fora do que busco\", pergunte o que faltou e o que é indispensável. Não insista antes de entender.",
  "Se o cliente preferir receber tudo por escrito, diga que depois da visita ou da ligação mandamos as informações em texto para ele revisar com calma, e que sem esse passo o atendimento fica genérico. Proponha a visita ou a ligação com o período.",
  "Quando o cliente disser de onde conheceu o loteamento (Instagram, Google, site, placa, indicação, portal), preencha o campo Como conheceu. Se ele não disser, não pergunte e não preencha.",
  "Ao se despedir, escreva o resumo assim: Objetivo (morar/investir/lazer); Conhece a região; Prazo de compra; Forma de pagamento; Quem decide; Lote ou quadra de interesse; Visita ou ligação marcada (dia e período); Temperatura: quente (compra em até 3 meses e marcou), morno (até 12 meses) ou frio (mais de um ano ou sem interesse), com o motivo.",
];

/* Os campos que a IA preenche na conversa (o corretor vê na ficha). */
const CAMPOS = [
  { name: "Motivo da compra", type: "select", options: ["Construir para morar", "Investir", "Lazer"] },
  { name: "Prazo de compra", type: "select", options: ["Até 3 meses", "3 a 12 meses", "Mais de 1 ano"] },
  { name: "Forma de pagamento", type: "select", options: ["À vista", "Parcelado direto", "Financiamento", "Não sabe"] },
  { name: "Decisores", type: "text" },
  { name: "Lote de interesse", type: "text" },
  { name: "Melhor período para contato", type: "select", options: ["Manhã", "Tarde", "Depois das 18h"] },
  { name: "Como conheceu", type: "text" },
];
const chaveDoCampo = (nome) => String(nome || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

const mensagens = (horas) => [
  ["Apresentação", `Oi, {nome}! Aqui é do ${NOME}, loteamento à beira do Rio São Francisco, em Petrolina. Posso te mostrar os lotes disponíveis?`],
  ["Tour 3D", `{nome}, dá para conhecer o loteamento em 3D por aqui: ${TOUR}\nMe conta o que achou!`],
  ["Convite para visita", `{nome}, que tal conhecer o ${NOME} pessoalmente? Qual dia e horário ficam melhores para você?`],
  ["Lote reservado", `{nome}, o lote está reservado para você por ${horas} horas. Vamos conversar sobre os próximos passos?`],
  ["Retorno", `Oi, {nome}! Passando para saber se ficou alguma dúvida sobre o ${NOME}.`],
];

const TAGS = [["Interesse em lote", 0], ["Quer visitar", 1], ["Pediu valores", 2], ["Lote reservado", 3], ["Investidor", 4]];

/* O funil da venda de lote: sem as etapas de financiamento (Pasta,
   Aprovação) da imobiliária, com a reserva no meio. Os nomes seguem a régua
   dos marcos (services/marcos.js): "Agendado", "Visita realizada",
   "Proposta", "Venda". */
const ETAPAS = [
  { name: "Lead novo", color: "#64748B", sla_minutes: 60 },
  { name: "Primeiro contato", color: "#0E8F6E", sla_minutes: 1440 },
  { name: "Agendado", color: "#2563EB", counts_as_conversion: true, sla_minutes: 2880 },
  { name: "Visita realizada", color: "#7C3AED", counts_as_conversion: true, sla_minutes: 2880 },
  { name: "Lote reservado", color: "#D97706", counts_as_conversion: true, sla_minutes: 1440 },
  { name: "Proposta", color: "#DB2777", counts_as_conversion: true, sla_minutes: 4320 },
  { name: "Venda", color: "#059669", status_type: "ganho", counts_as_conversion: true },
  { name: "Perdido", color: "#9CA3AF", status_type: "perdido" },
];

function fluxoDeBoasVindas(tags) {
  const g = {
    nos: [
      { id: "inicio", tipo: "inicio", x: 60, y: 200, dados: {} },
      { id: "apresenta", tipo: "mensagem", x: 360, y: 200, dados: { texto:
        `Oi, {nome}! Aqui é do ${NOME}, loteamento à beira do Rio São Francisco, em Petrolina.\n\nConheça em 3D: ${TOUR}` } },
      { id: "pergunta", tipo: "botoes", x: 660, y: 200, dados: { texto: "Como posso te ajudar?", escrever_opcoes: true,
        prazo: { quantidade: 1, unidade: "dias" },
        botoes: [{ id: "b_lotes", rotulo: "Lotes disponíveis" }, { id: "b_visita", rotulo: "Agendar visita" }, { id: "b_corretor", rotulo: "Falar com corretor" }] } },
      { id: "tag_lote", tipo: "add_tag", x: 980, y: 60, dados: { tag_id: tags["Interesse em lote"] } },
      { id: "ia_lotes", tipo: "ia", x: 1280, y: 60, dados: { instrucao:
        "Diga, em linhas curtas, quantos lotes estão disponíveis agora e as áreas (use só a situação dos lotes informada). Não fale de preço. Termine perguntando qual tamanho de lote a pessoa procura." } },
      { id: "tag_visita", tipo: "add_tag", x: 980, y: 220, dados: { tag_id: tags["Quer visitar"] } },
      { id: "aviso_visita", tipo: "tarefa", x: 1280, y: 220, dados: { titulo: "Combinar visita ao loteamento", em_horas: 2,
        criar_tarefa: true, avisar: true, avisar_gestao: false, aviso: "Cliente quer visitar o loteamento." } },
      { id: "msg_visita", tipo: "mensagem", x: 1580, y: 220, dados: { texto: "Perfeito, {nome}! Um corretor vai combinar com você o melhor dia e horário para conhecer o loteamento." } },
      { id: "corretor", tipo: "atribuir", x: 980, y: 380, dados: { modo: "catraca" } },
      { id: "msg_corretor", tipo: "mensagem", x: 1280, y: 380, dados: { texto: "Combinado, {nome}! Um corretor vai falar com você em seguida." } },
    ],
    ligacoes: [
      { de: "inicio", saida: "proximo", para: "apresenta" },
      { de: "apresenta", saida: "proximo", para: "pergunta" },
      { de: "pergunta", saida: "b_lotes", para: "tag_lote" },
      { de: "tag_lote", saida: "proximo", para: "ia_lotes" },
      { de: "pergunta", saida: "b_visita", para: "tag_visita" },
      { de: "tag_visita", saida: "proximo", para: "aviso_visita" },
      { de: "aviso_visita", saida: "proximo", para: "msg_visita" },
      { de: "pergunta", saida: "b_corretor", para: "corretor" },
      { de: "corretor", saida: "proximo", para: "msg_corretor" },
    ],
  };
  return validarGrafo(g).grafo || g;
}

/* Liga a qualificação sem desfazer o que a gestão já escolheu: campos que
   faltam são criados; os da IA se SOMAM aos já marcados; onde ela atua, para
   onde move e a roleta da etapa só são preenchidos quando estão vazios — o que
   já estava escolhido fica, com um aviso. */
function qualificacao(orgId, funilNome, feito) {
  const agora = Date.now();
  const chaves = [];
  for (const c of CAMPOS) {
    const key = chaveDoCampo(c.name);
    chaves.push(key);
    if (db.prepare("SELECT 1 FROM custom_fields WHERE org_id = ? AND key = ? AND is_active = 1").get(orgId, key)) continue;
    const { n } = db.prepare("SELECT COUNT(*) n FROM custom_fields WHERE org_id = ?").get(orgId);
    db.prepare(`INSERT INTO custom_fields
      (id,org_id,name,key,type,options,is_required_default,show_on_card,show_on_lead_profile,
       show_on_conversation_sidebar,show_on_reports,ordem,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,0,0,1,0,0,?,1,?,?)`).run(
      "cf_" + randomUUID().replace(/-/g, "").slice(0, 10), orgId, c.name, key, c.type,
      JSON.stringify(c.options || []), n, agora, agora);
    feito.campos++;
  }

  const o = db.prepare("SELECT robo_escopo, robo_campos, robo_etapa_final FROM orgs WHERE id = ?").get(orgId) || {};
  const json = (t, p) => { try { return t ? JSON.parse(t) : p; } catch { return p; } };
  const campos = [...new Set([...json(o.robo_campos, []).filter(k => typeof k === "string"), ...chaves])].slice(0, 15);

  const funil = db.prepare("SELECT id, name FROM pipelines WHERE org_id = ?").all(orgId).find(p => chave(p.name) === chave(funilNome));
  const etapa = (nome) => funil && db.prepare("SELECT id, name, automation_config FROM pipeline_stages WHERE pipeline_id = ? AND org_id = ?")
    .all(funil.id, orgId).find(s => chave(s.name) === chave(nome));
  const leadNovo = etapa("Lead novo");
  const primeiro = etapa("Primeiro contato");

  let escopo = json(o.robo_escopo, {});
  const escopoVazio = !(escopo.pipelines || []).length && !(escopo.etapas || []).length;
  if (escopoVazio && leadNovo) { escopo = { pipelines: [], etapas: [leadNovo.id] }; feito.qualificacao.push("A IA atende só em Lead novo"); }
  else if (!escopoVazio) feito.avisos.push("Onde a IA atua já estava escolhido e não foi mudado.");

  let etapaFinal = o.robo_etapa_final || null;
  if (!etapaFinal && primeiro) { etapaFinal = primeiro.id; feito.qualificacao.push("Ao terminar, move para Primeiro contato"); }
  else if (etapaFinal && primeiro && etapaFinal !== primeiro.id) feito.avisos.push("A etapa para onde a IA move já estava escolhida e não foi mudada.");

  db.prepare("UPDATE orgs SET robo_escopo = ?, robo_campos = ?, robo_observacao = 1, robo_etapa_final = ? WHERE id = ?")
    .run(JSON.stringify(escopo), JSON.stringify(campos), etapaFinal, orgId);
  feito.qualificacao.push("Resumo do atendimento como observação");

  if (primeiro) {
    const cfg = json(primeiro.automation_config, {});
    if (!cfg.distribuir && !cfg.limpar_responsavel) {
      db.prepare("UPDATE pipeline_stages SET automation_config = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...cfg, distribuir: "rodizio", so_sem_corretor: true }), agora, primeiro.id);
      feito.qualificacao.push("Primeiro contato entrega ao próximo corretor da roleta");
    } else if (cfg.distribuir !== "rodizio") feito.avisos.push("A etapa Primeiro contato já tinha um responsável escolhido e não foi mudada.");
  } else feito.avisos.push(`Não achei a etapa "Primeiro contato" no funil "${funilNome}": a roleta e a etapa final da IA não foram ligadas.`);
}

const chave = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function aplicarKitReserva(orgId, user) {
  const feito = { modo: true, config: false, ficha: false, orientacoes: 0, orientacoes_desligadas: 0, campos: 0, qualificacao: [], mensagens: 0, tags: 0, funil: false, fluxo: false, lotes: null, avisos: [] };
  ligarModo(orgId, true);

  const cfg = configDoEmpreendimento(orgId);
  if (!cfg.tour || !cfg.cidade || cfg.nome !== NOME) {
    salvarConfig(orgId, { nome: NOME, cidade: cfg.cidade || "Petrolina-PE", tour: cfg.tour || TOUR });
    feito.config = true;
  }
  const horas = configDoEmpreendimento(orgId).reserva_horas;

  // Ficha de produto da IA.
  const fichas = db.prepare("SELECT nome FROM ia_produtos WHERE org_id = ?").all(orgId).map(f => chave(f.nome));
  if (!fichas.includes(chave(NOME))) {
    try { criarFicha(orgId, user.id, { nome: NOME, texto: FICHA }); feito.ficha = true; }
    catch (e) { feito.avisos.push(e.message); }
  }

  // Orientações do Autoatendimento.
  const temOri = new Set(db.prepare("SELECT texto FROM robo_ensino WHERE org_id = ?").all(orgId).map(x => chave(x.texto)));
  let ordem = db.prepare("SELECT COALESCE(MAX(ordem), -1) m FROM robo_ensino WHERE org_id = ?").get(orgId).m;
  const novas = new Set(ORIENTACOES.map(chave));
  for (const t of ORIENTACOES_V1) {
    if (novas.has(chave(t))) continue;
    const r = db.prepare("UPDATE robo_ensino SET ativo = 0 WHERE org_id = ? AND texto = ? AND ativo = 1").run(orgId, t);
    feito.orientacoes_desligadas += r.changes;
  }
  for (const t of ORIENTACOES) {
    if (temOri.has(chave(t))) continue;
    db.prepare("INSERT INTO robo_ensino (id,org_id,texto,ordem,ativo,criado_por,created_at) VALUES (?,?,?,?,1,?,?)")
      .run(randomUUID(), orgId, t, ++ordem, user.id, Date.now());
    feito.orientacoes++;
  }

  // Mensagens prontas.
  const temMsg = new Set(db.prepare("SELECT titulo FROM mensagens_rapidas WHERE org_id = ?").all(orgId).map(x => chave(x.titulo)));
  let ordemMsg = db.prepare("SELECT COALESCE(MAX(ordem), -1) m FROM mensagens_rapidas WHERE org_id = ?").get(orgId).m;
  for (const [titulo, corpo] of mensagens(horas)) {
    if (temMsg.has(chave(titulo))) continue;
    db.prepare("INSERT INTO mensagens_rapidas (id,org_id,titulo,corpo,ordem,ativo,criado_por,created_at) VALUES (?,?,?,?,?,1,?,?)")
      .run(randomUUID(), orgId, titulo, corpo, ++ordemMsg, user.id, Date.now());
    feito.mensagens++;
  }

  // Etiquetas.
  const tags = {};
  for (const [nome, cor] of TAGS) {
    const existe = db.prepare("SELECT id, nome FROM tags WHERE org_id = ?").all(orgId).find(t => chave(t.nome) === chave(nome));
    if (existe) { tags[nome] = existe.id; continue; }
    const r = criarTag(orgId, { nome, cor: CORES_TAG[cor % CORES_TAG.length] }, user.id);
    if (r.tag) { tags[nome] = r.tag.id; feito.tags++; } else feito.avisos.push(r.erro);
  }

  // O funil da venda de lote. Vira o padrão só numa conta que ainda não tem lead —
  // trocar o padrão de uma operação em andamento mudaria onde os leads novos caem.
  const funilNome = "Vendas de lotes";
  const temFunil = db.prepare("SELECT id FROM pipelines WHERE org_id = ?").all(orgId).length
    && db.prepare("SELECT name FROM pipelines WHERE org_id = ?").all(orgId).some(p => chave(p.name) === chave(funilNome));
  if (!temFunil) {
    const semLeads = !db.prepare("SELECT 1 FROM leads WHERE org_id = ? LIMIT 1").get(orgId);
    const criado = criarPipeline(orgId, { name: funilNome, description: `Venda de lotes do ${NOME}.`, type: "custom", is_default: semLeads });
    if (criado.pipeline) {
      ETAPAS.forEach((e, i) => inserirEtapa(orgId, criado.pipeline.id, e, i));
      feito.funil = true;
      if (!semLeads) feito.avisos.push(`O funil "${funilNome}" foi criado, mas não virou o padrão porque a conta já tem leads. Mude em Configurações → Funis e etapas, se quiser.`);
    }
  }

  // A qualificação: campos, resumo, onde a IA atua, para onde ela move e a roleta.
  qualificacao(orgId, funilNome, feito);

  // Fluxo de boas-vindas — nasce DESLIGADO: quem liga é a gestão, escolhendo o gatilho.
  const fluxoNome = `Boas-vindas ${NOME}`;
  const temFluxo = db.prepare("SELECT nome FROM marketing_fluxos WHERE org_id = ? AND apagado_em IS NULL").all(orgId).some(f => chave(f.nome) === chave(fluxoNome));
  if (!temFluxo && Object.keys(tags).length >= 2) {
    const agora = Date.now();
    db.prepare("INSERT INTO marketing_fluxos (id,org_id,nome,grafo,criado_por,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?)")
      .run("mf_" + randomUUID(), orgId, fluxoNome, JSON.stringify(fluxoDeBoasVindas(tags)), user.id, agora, agora);
    feito.fluxo = true;
  }

  // Os lotes da planilha — só os que ainda não existem (importar não desfaz reserva nem venda).
  const antes = db.prepare("SELECT codigo FROM lotes WHERE org_id = ?").all(orgId).map(l => l.codigo);
  const linhas = LOTES_DA_PLANILHA.split("\n");
  const so = [linhas[0], ...linhas.slice(1).filter(l => !antes.includes(l.split(";")[0]))].join("\n");
  feito.lotes = so.split("\n").length > 1 ? importar(orgId, { ...user, role: "adm" }, so).novos : 0;

  return feito;
}
