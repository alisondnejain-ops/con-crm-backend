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

const ORIENTACOES = [
  `Você atende o ${NOME}, um loteamento em Petrolina-PE à beira do Rio São Francisco. Trate a pessoa pelo primeiro nome, com acolhimento e sem pressa.`,
  "Antes de falar de lote, entenda o que a pessoa busca: construir a casa, investir ou ter um lugar de lazer, e qual tamanho de lote ela imagina.",
  `Quando a pessoa quiser conhecer o loteamento, mande o tour 3D: ${TOUR}`,
  "Não informe preço, entrada, parcelas nem condições de pagamento: diga que o corretor passa os valores atualizados.",
  "Fale só dos lotes que o sistema mostra como disponíveis. Você não reserva nem promete lote — quem reserva é o corretor.",
  "Pergunte se a pessoa já conhece a região e para quando ela pensa em comprar.",
  "Quando a pessoa pedir valores, quiser visitar o loteamento ou escolher um lote, diga que um corretor vai falar com ela em seguida e encerre o atendimento.",
];

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

const chave = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function aplicarKitReserva(orgId, user) {
  const feito = { modo: true, config: false, ficha: false, orientacoes: 0, mensagens: 0, tags: 0, funil: false, fluxo: false, lotes: null, avisos: [] };
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
