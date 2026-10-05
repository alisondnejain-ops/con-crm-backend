/* PIPELINES E ETAPAS — o core de gestao configuravel (28/08/2026).

   Até aqui o funil era uma constante do servidor, igual para todo mundo. Este
   arquivo é o que troca isso por dado: cada empresa monta os próprios fluxos,
   e o código deixa de saber que existe uma etapa chamada "Pasta".

   TRES DECISOES QUE VALEM MAIS QUE O CRUD

   1. O NOME DA ETAPA CONTINUA SENDO GRAVADO NO LEAD.

      `leads.stage` guarda o nome e `leads.stage_id` guarda o vínculo. Os dois,
      sempre, escritos juntos por `moverEtapa`. Parece redundância e é o que
      torna a mudança possível: cerca de trinta consultas e a tela inteira leem
      o nome hoje, e trocá-las de uma vez seria reescrever o sistema num
      commit — com uma operação real rodando em cima.

      A duplicação tem um custo conhecido e pequeno: renomear uma etapa precisa
      atualizar os leads que estão nela (ver `renomearEtapa`). É um preço muito
      menor que o de uma migração de tudo de uma vez.

   2. APAGAR ETAPA COM LEAD DENTRO NAO EXISTE.

      Some a coluna e os leads ficam órfãos — sem etapa, fora do funil, fora do
      relatório, e sem ninguém perceber. A etapa se DESATIVA: sai da tela, o
      histórico continua de pé, e os leads que estão nela seguem visíveis até
      alguém movê-los. Apagar de vez só quando está vazia.

   3. TODA CONSULTA FILTRA POR org_id, inclusive as que já teriam o
      pipeline_id. Um id vazado entre empresas não pode virar acesso a dado de
      outra imobiliária, e a defesa mais barata é nunca confiar só no id. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { TEMPLATES, templatePorId, FUNIL_ATUAL } from "./templates.js";

const agora = () => Date.now();
const novoId = (p) => `${p}_${randomUUID().slice(0, 12)}`;

const parseJson = (v, padrao) => {
  try { return v ? JSON.parse(v) : padrao; } catch (e) { return padrao; }
};

/* Como uma etapa sai daqui para a tela e para as regras. `required_fields` e
   `automation_config` viram objeto: JSON cru na resposta obriga cada tela a
   lembrar de fazer o parse, e a que esquecer quebra sem erro claro. */
export const formatarEtapa = (e) => e && ({
  id: e.id,
  pipeline_id: e.pipeline_id,
  name: e.name,
  ordem: e.ordem,
  color: e.color,
  status_type: e.status_type || "aberto",
  is_active: !!e.is_active,
  counts_as_conversion: !!e.counts_as_conversion,
  // Onde o processo comercial começa: o que vem antes (Inbox, triagem) não
  // entra na base da conversão. Uma por funil; sem nenhuma marcada, vale a
  // primeira etapa que conta como conversão (ver services/conversao.js).
  entrada_comercial: !!e.entrada_comercial,
  sla_minutes: e.sla_minutes ?? null,
  warning_before_minutes: e.warning_before_minutes ?? null,
  required_fields: parseJson(e.required_fields, []),
  automation_config: parseJson(e.automation_config, {}),
});

export const formatarPipeline = (p) => p && ({
  id: p.id, name: p.name, description: p.description || null,
  type: p.type || "custom", is_default: !!p.is_default, is_active: !!p.is_active,
  ordem: p.ordem, created_at: p.created_at,
});

// ===== LEITURA =====

export const listarPipelines = (orgId, { incluirInativos = false } = {}) =>
  db.prepare(`SELECT * FROM pipelines WHERE org_id = ?${incluirInativos ? "" : " AND is_active = 1"}
              ORDER BY ordem, created_at`).all(orgId).map(formatarPipeline);

export const pipelinePorId = (orgId, id) =>
  formatarPipeline(db.prepare("SELECT * FROM pipelines WHERE id = ? AND org_id = ?").get(id, orgId));

export const etapasDoPipeline = (orgId, pipelineId, { incluirInativas = false } = {}) =>
  db.prepare(`SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND org_id = ?
              ${incluirInativas ? "" : "AND is_active = 1"} ORDER BY ordem, created_at`)
    .all(pipelineId, orgId).map(formatarEtapa);

export const etapaPorId = (orgId, id) =>
  formatarEtapa(db.prepare("SELECT * FROM pipeline_stages WHERE id = ? AND org_id = ?").get(id, orgId));

/* O pipeline padrao da empresa: onde lead novo cai quando ninguem disse outra
   coisa. Sempre devolve algum — o que estiver marcado, ou o primeiro ativo.
   Devolver nulo aqui faria o webhook do WhatsApp ter que decidir o que fazer
   com um lead sem funil, no meio da madrugada. */
export function pipelinePadrao(orgId) {
  const marcado = db.prepare(
    "SELECT * FROM pipelines WHERE org_id = ? AND is_default = 1 AND is_active = 1 ORDER BY ordem LIMIT 1").get(orgId);
  if (marcado) return formatarPipeline(marcado);
  const primeiro = db.prepare(
    "SELECT * FROM pipelines WHERE org_id = ? AND is_active = 1 ORDER BY ordem, created_at LIMIT 1").get(orgId);
  return formatarPipeline(primeiro);
}

// A primeira etapa de um pipeline — onde o lead entra.
export const primeiraEtapa = (orgId, pipelineId) =>
  formatarEtapa(db.prepare(`SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND org_id = ?
    AND is_active = 1 ORDER BY ordem, created_at LIMIT 1`).get(pipelineId, orgId));

/* A etapa de um lead a partir do NOME, dentro do pipeline dele.

   É a ponte entre o mundo antigo (nome em texto) e o novo (vínculo). Todo
   caminho que ainda passa nome — a rota de mudar etapa, a confirmação da
   recomendação da IA, a importação de planilha — chega aqui. */
export function etapaPorNome(orgId, pipelineId, nome) {
  if (!nome) return null;
  const alvo = db.prepare(`SELECT * FROM pipeline_stages
    WHERE org_id = ? AND pipeline_id = ? AND name = ? AND is_active = 1 LIMIT 1`)
    .get(orgId, pipelineId, nome);
  if (alvo) return formatarEtapa(alvo);
  /* Fora do pipeline informado: acontece quando o lead ainda não foi ligado a
     nenhum (base anterior a 28/08/2026) ou quando alguém manda um nome de
     outro fluxo. Melhor achar do que recusar — recusar aqui pararia a
     movimentação de lead antigo. */
  const qualquer = db.prepare(`SELECT * FROM pipeline_stages
    WHERE org_id = ? AND name = ? AND is_active = 1 ORDER BY ordem LIMIT 1`).get(orgId, nome);
  return formatarEtapa(qualquer);
}

// ===== ESCRITA =====

export function criarPipeline(orgId, { name, description = null, type = "custom", is_default = false }) {
  const nome = String(name || "").trim();
  if (!nome) return { erro: "O pipeline precisa de um nome." };
  const { n } = db.prepare("SELECT COUNT(*) n FROM pipelines WHERE org_id = ?").get(orgId);
  const id = novoId("pl");
  const rodar = db.transaction(() => {
    // Primeiro pipeline da casa vira o padrão sozinho: conta sem padrão é
    // conta onde o lead novo não sabe onde cair.
    const padrao = is_default || n === 0 ? 1 : 0;
    if (padrao) db.prepare("UPDATE pipelines SET is_default = 0 WHERE org_id = ?").run(orgId);
    db.prepare(`INSERT INTO pipelines (id,org_id,name,description,type,is_default,is_active,ordem,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,?)`).run(id, orgId, nome, description, type, padrao, n, agora(), agora());
  });
  rodar();
  return { pipeline: pipelinePorId(orgId, id) };
}

export function editarPipeline(orgId, id, dados) {
  const atual = db.prepare("SELECT * FROM pipelines WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!atual) return { erro: "Pipeline não encontrado." };
  const { name, description, type, is_active, is_default, ordem } = dados || {};
  /* Desligar o último pipeline ativo deixaria a imobiliária sem lugar nenhum
     para o lead cair — e o webhook não tem como pedir ajuda às 3 da manhã. */
  if (is_active === false && atual.is_active) {
    const { n } = db.prepare("SELECT COUNT(*) n FROM pipelines WHERE org_id = ? AND is_active = 1 AND id <> ?").get(orgId, id);
    if (!n) return { erro: "Este é o único pipeline ativo. Crie ou reative outro antes de desligar este." };
  }
  const rodar = db.transaction(() => {
    if (is_default === true) db.prepare("UPDATE pipelines SET is_default = 0 WHERE org_id = ?").run(orgId);
    db.prepare(`UPDATE pipelines SET name = ?, description = ?, type = ?, is_active = ?, is_default = ?, ordem = ?, updated_at = ?
                WHERE id = ? AND org_id = ?`).run(
      name !== undefined ? String(name).trim() || atual.name : atual.name,
      description !== undefined ? description : atual.description,
      type !== undefined ? type : atual.type,
      is_active !== undefined ? (is_active ? 1 : 0) : atual.is_active,
      is_default !== undefined ? (is_default ? 1 : 0) : atual.is_default,
      ordem !== undefined ? Number(ordem) : atual.ordem,
      agora(), id, orgId);
  });
  rodar();
  return { pipeline: pipelinePorId(orgId, id) };
}

/* Duplicar: a forma mais barata de experimentar sem arriscar o que está
   rodando. O gestor copia o funil que funciona, mexe na cópia e só então
   decide — em vez de editar o que a equipe está usando agora. */
export function duplicarPipeline(orgId, id, novoNome) {
  const origem = db.prepare("SELECT * FROM pipelines WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!origem) return { erro: "Pipeline não encontrado." };
  const etapas = db.prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND org_id = ? ORDER BY ordem").all(id, orgId);
  const criado = criarPipeline(orgId, {
    name: String(novoNome || `${origem.name} (cópia)`).trim(),
    description: origem.description, type: origem.type, is_default: false,
  });
  if (criado.erro) return criado;
  const rodar = db.transaction(() => {
    etapas.forEach((e, i) => inserirEtapa(orgId, criado.pipeline.id, {
      name: e.name, color: e.color, status_type: e.status_type,
      counts_as_conversion: !!e.counts_as_conversion, sla_minutes: e.sla_minutes,
      entrada_comercial: !!e.entrada_comercial,
      warning_before_minutes: e.warning_before_minutes,
      required_fields: parseJson(e.required_fields, []),
      automation_config: parseJson(e.automation_config, {}),
    }, i));
  });
  rodar();
  return { pipeline: criado.pipeline, etapas: etapasDoPipeline(orgId, criado.pipeline.id) };
}

/* Apagar um pipeline. Só quando não há lead nenhum apontando para ele — nem
   nas etapas inativas. Pipeline com lead dentro que some leva os atendimentos
   junto para lugar nenhum. */
export function apagarPipeline(orgId, id) {
  const alvo = db.prepare("SELECT * FROM pipelines WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!alvo) return { erro: "Pipeline não encontrado." };
  const { n } = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND pipeline_id = ?").get(orgId, id);
  if (n) return { erro: `Este pipeline tem ${n} lead(s) dentro. Mova-os antes de apagar, ou desative o pipeline.`, leads: n };
  const rodar = db.transaction(() => {
    db.prepare("DELETE FROM pipeline_stages WHERE pipeline_id = ? AND org_id = ?").run(id, orgId);
    db.prepare("DELETE FROM pipelines WHERE id = ? AND org_id = ?").run(id, orgId);
  });
  rodar();
  return { ok: true };
}

export function inserirEtapa(orgId, pipelineId, e, ordem) {
  const id = novoId("st");
  db.prepare(`INSERT INTO pipeline_stages
    (id,pipeline_id,org_id,name,ordem,color,status_type,is_active,counts_as_conversion,entrada_comercial,
     sla_minutes,warning_before_minutes,required_fields,automation_config,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
    id, pipelineId, orgId, String(e.name).trim(), ordem,
    e.color || null, e.status_type || "aberto",
    e.counts_as_conversion ? 1 : 0,
    e.entrada_comercial && e.status_type !== "perdido" ? 1 : 0,
    e.sla_minutes ?? null, e.warning_before_minutes ?? null,
    JSON.stringify(e.required_fields || []), JSON.stringify(e.automation_config || {}),
    agora(), agora());
  return id;
}

export function criarEtapa(orgId, pipelineId, dados) {
  const pipeline = db.prepare("SELECT id FROM pipelines WHERE id = ? AND org_id = ?").get(pipelineId, orgId);
  if (!pipeline) return { erro: "Pipeline não encontrado." };
  if (!String(dados?.name || "").trim()) return { erro: "A etapa precisa de um nome." };
  const { n } = db.prepare("SELECT COUNT(*) n FROM pipeline_stages WHERE pipeline_id = ?").get(pipelineId);
  if (dados.entrada_comercial && dados.status_type === "perdido")
    return { erro: ERRO_ENTRADA_PERDIDO };
  const id = inserirEtapa(orgId, pipelineId, dados, dados.ordem ?? n);
  if (dados.entrada_comercial) soUmaEntrada(pipelineId, id);
  return { etapa: etapaPorId(orgId, id) };
}

/* ===== O QUE A ETAPA FAZ QUANDO O LEAD CHEGA (01/10/2026) =====

   O motor (`rodarAutomacao`, services/movimento.js) existia desde 28/08, mas
   não havia tela: só dava para ligar mexendo no banco. Com a tela, o que chega
   aqui vem do navegador, e é conferido antes de gravar — senão uma pessoa de
   OUTRA imobiliária ou um funil de outra conta ficariam gravados na etapa, e
   o erro só apareceria quando um lead passasse por ela.

   Três chaves e só elas (o resto é descartado): `distribuir` ("rodizio" ou o
   id de alguém ATIVO desta conta), `limpar_responsavel` (devolve à fila) e
   `mover_para_pipeline` (outro funil ATIVO desta conta, com etapa ativa).
   Distribuir e devolver à fila juntos se contradizem e são recusados. */
export function validarAutomacao(orgId, pipelineId, cfg) {
  if (cfg === null || cfg === undefined) return { config: {} };
  if (typeof cfg !== "object" || Array.isArray(cfg)) return { erro: "Configuração da automação inválida." };
  const config = {};
  if (cfg.distribuir) {
    if (cfg.distribuir === "rodizio") config.distribuir = "rodizio";
    else {
      const p = db.prepare("SELECT id FROM users WHERE id = ? AND org_id = ? AND status = 'ativo'").get(String(cfg.distribuir), orgId);
      if (!p) return { erro: "A pessoa escolhida para receber o lead não está ativa na equipe." };
      config.distribuir = p.id;
    }
  }
  if (cfg.limpar_responsavel) {
    if (config.distribuir) return { erro: "Escolha uma coisa só: entregar a alguém ou devolver à fila." };
    config.limpar_responsavel = true;
  }
  if (cfg.mover_para_pipeline) {
    const alvo = db.prepare("SELECT id, is_active FROM pipelines WHERE id = ? AND org_id = ?").get(String(cfg.mover_para_pipeline), orgId);
    if (!alvo) return { erro: "O funil de destino não foi encontrado." };
    if (alvo.id === pipelineId) return { erro: "O lead já está neste funil — escolha outro funil de destino." };
    if (!alvo.is_active) return { erro: "O funil de destino está desligado. Religue-o antes." };
    if (!primeiraEtapa(orgId, alvo.id)) return { erro: "O funil de destino não tem etapa ativa para receber o lead." };
    config.mover_para_pipeline = alvo.id;
  }
  return { config };
}

const ERRO_ENTRADA_PERDIDO = "Uma etapa de perda não pode ser o início do processo comercial.";
const soUmaEntrada = (pipelineId, id) => db.prepare(
  "UPDATE pipeline_stages SET entrada_comercial = 0 WHERE pipeline_id = ? AND id <> ?").run(pipelineId, id);

/* Renomear mexe nos LEADS que estão na etapa, e é por isso que passa por aqui.

   `leads.stage` guarda o nome, então uma etapa renomeada sem atualizar os leads
   deixaria cada um deles apontando para um nome que não existe mais: some do
   kanban, some do relatório, e o `stage_id` continua certo — o que faz o
   defeito parecer coisa de outro lugar. É o custo conhecido da duplicação, e
   ele se paga aqui, num lugar só. */
export function editarEtapa(orgId, id, dados) {
  const atual = db.prepare("SELECT * FROM pipeline_stages WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!atual) return { erro: "Etapa não encontrada." };
  const nome = dados.name !== undefined ? String(dados.name).trim() || atual.name : atual.name;

  if (dados.is_active === false && atual.is_active) {
    const { n } = db.prepare("SELECT COUNT(*) n FROM pipeline_stages WHERE pipeline_id = ? AND is_active = 1 AND id <> ?")
      .get(atual.pipeline_id, id);
    if (!n) return { erro: "Esta é a única etapa ativa do pipeline. Um funil sem etapa não recebe lead." };
  }

  /* O INÍCIO DO PROCESSO COMERCIAL (01/10/2026). Uma etapa por funil; marcar
     outra desmarca a anterior. As recusas dizem o porquê: etapa de perda não
     é por onde um negócio começa, e etapa desativada não recebe ninguém. */
  const tipoFinal = dados.status_type !== undefined ? dados.status_type : atual.status_type;
  const ativaFinal = dados.is_active !== undefined ? !!dados.is_active : !!atual.is_active;
  let entrada = dados.entrada_comercial !== undefined ? !!dados.entrada_comercial : !!atual.entrada_comercial;
  if (dados.entrada_comercial === true) {
    if (tipoFinal === "perdido") return { erro: ERRO_ENTRADA_PERDIDO };
    if (!ativaFinal) return { erro: "Etapa desativada não pode ser o início do processo comercial. Ative-a antes." };
  } else if (entrada && tipoFinal === "perdido") {
    return { erro: ERRO_ENTRADA_PERDIDO };
  }
  // Desativar a etapa de início tira a marca: o funil volta a usar a primeira
  // etapa que conta como conversão, e a tela do funil diz isso.
  if (entrada && !ativaFinal) entrada = false;

  let automacao = null;
  if (dados.automation_config !== undefined) {
    const v = validarAutomacao(orgId, atual.pipeline_id, dados.automation_config);
    if (v.erro) return { erro: v.erro };
    automacao = v.config;
  }

  const rodar = db.transaction(() => {
    db.prepare("UPDATE pipeline_stages SET entrada_comercial = ? WHERE id = ?").run(entrada ? 1 : 0, id);
    if (entrada && !atual.entrada_comercial) soUmaEntrada(atual.pipeline_id, id);
    db.prepare(`UPDATE pipeline_stages SET name = ?, ordem = ?, color = ?, status_type = ?, is_active = ?,
      counts_as_conversion = ?, sla_minutes = ?, warning_before_minutes = ?, required_fields = ?,
      automation_config = ?, updated_at = ? WHERE id = ? AND org_id = ?`).run(
      nome,
      dados.ordem !== undefined ? Number(dados.ordem) : atual.ordem,
      dados.color !== undefined ? dados.color : atual.color,
      dados.status_type !== undefined ? dados.status_type : atual.status_type,
      dados.is_active !== undefined ? (dados.is_active ? 1 : 0) : atual.is_active,
      dados.counts_as_conversion !== undefined ? (dados.counts_as_conversion ? 1 : 0) : atual.counts_as_conversion,
      dados.sla_minutes !== undefined ? (dados.sla_minutes === null || dados.sla_minutes === "" ? null : Number(dados.sla_minutes)) : atual.sla_minutes,
      dados.warning_before_minutes !== undefined ? (dados.warning_before_minutes === null || dados.warning_before_minutes === "" ? null : Number(dados.warning_before_minutes)) : atual.warning_before_minutes,
      dados.required_fields !== undefined ? JSON.stringify(dados.required_fields || []) : atual.required_fields,
      automacao !== null ? JSON.stringify(automacao) : atual.automation_config,
      agora(), id, orgId);
    // Os leads acompanham o nome novo.
    if (nome !== atual.name)
      db.prepare("UPDATE leads SET stage = ? WHERE org_id = ? AND stage_id = ?").run(nome, orgId, id);
  });
  rodar();
  return { etapa: etapaPorId(orgId, id) };
}

// Reordenar em bloco: a tela arrasta várias de uma vez e manda a lista pronta.
export function reordenarEtapas(orgId, pipelineId, ids) {
  const rodar = db.transaction(() => {
    ids.forEach((id, i) =>
      db.prepare("UPDATE pipeline_stages SET ordem = ?, updated_at = ? WHERE id = ? AND org_id = ? AND pipeline_id = ?")
        .run(i, agora(), id, orgId, pipelineId));
  });
  rodar();
  return { etapas: etapasDoPipeline(orgId, pipelineId, { incluirInativas: true }) };
}

/* Apagar etapa: só vazia. Com lead dentro, o caminho é desativar — a etapa sai
   da tela e do fluxo, os leads continuam onde estão e visíveis, e ninguém
   descobre depois que uma parte da base evaporou. */
export function apagarEtapa(orgId, id) {
  const alvo = db.prepare("SELECT * FROM pipeline_stages WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!alvo) return { erro: "Etapa não encontrada." };
  const { n } = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND stage_id = ?").get(orgId, id);
  if (n) return { erro: `Esta etapa tem ${n} lead(s) dentro. Mova-os antes, ou desative a etapa — assim ela sai do fluxo sem sumir com ninguém.`, leads: n };
  db.prepare("DELETE FROM pipeline_stages WHERE id = ? AND org_id = ?").run(id, orgId);
  return { ok: true };
}

/* ONDE UM LEAD NOVO CAI.

   Os dois webhooks (Meta e WhatsApp) escreviam a palavra 'Lead' direto no
   INSERT. Isso presumia que toda imobiliaria tem uma etapa com esse nome, o
   que deixou de ser verdade quando o funil virou configuravel: uma operacao de
   locacao chama a primeira etapa de outra coisa, e o lead cairia numa etapa
   que nao existe — sem aparecer em coluna nenhuma do kanban.

   Devolve SEMPRE alguma coisa. O ultimo recurso e a palavra 'Lead' sem
   vinculo: conta recem-criada, com o bootstrap ainda por rodar, nao pode
   perder o lead que chegou no meio. Lead que entra e nao e gravado esta
   perdido para sempre; lead gravado numa etapa torta se conserta depois. */
export function entradaPadrao(orgId) {
  const pipeline = pipelinePadrao(orgId);
  if (!pipeline) return { pipeline_id: null, stage_id: null, nome: "Lead" };
  const etapa = primeiraEtapa(orgId, pipeline.id);
  return {
    pipeline_id: pipeline.id,
    stage_id: etapa ? etapa.id : null,
    nome: etapa ? etapa.name : "Lead",
  };
}

/* ONDE UM LEAD NOVO CAI **DEPENDENDO DE QUEM O RECEBE** (01/09/2026).

   O `entradaPadrao` acima responde "qual é o funil desta casa". A pergunta que
   faltava é outra: os leads que caem na ATENDENTE pertencem ao funil de
   pré-atendimento, e os do corretor ao comercial. Quem sabe qual é o funil de
   um lead é o dono dele — porque é ele quem vai trabalhá-lo.

   Sem isto, o Ali criou o funil de SDR, moveu os leads antigos da Vanessa para
   lá na mão, e os NOVOS continuaram caindo no comercial: a entrada olhava só o
   funil padrão da imobiliária e não tinha como saber de quem era o lead.

   `users.pipeline_entrada` vazio é o funil padrão — que é o que todo mundo era
   antes disto existir. Só quem for configurado muda de comportamento. */
export function entradaDe(orgId, userId) {
  const pessoa = userId
    ? db.prepare("SELECT role, pipeline_entrada FROM users WHERE id = ? AND org_id = ?").get(userId, orgId)
    : null;
  if (pessoa?.pipeline_entrada) {
    const p = pipelinePorId(orgId, pessoa.pipeline_entrada);
    // Funil apagado depois de configurado: cai na regra do papel em vez de
    // deixar o lead sem funil nenhum, que é onde ele some de todas as colunas.
    if (p) return { ...entradaEm(orgId, p.id), proprio: true };
  }
  /* O FUNIL VEM DO PAPEL DE QUEM RECEBE (01/10/2026, pedido do Ali: "chegou
     lead, a atendente que está ativa recebe e ele automaticamente cai no
     funil de SDR"). Atendente — e o lead SEM dono, que é o que a IA está
     cobrindo enquanto nenhuma atendente está ativa — vai para o funil de SDR
     da casa; corretor e gestor, para o comercial. Sem funil de SDR na conta,
     tudo continua no padrão, como sempre foi. */
  if (!pessoa || pessoa.role === "sdr") {
    const sdr = funilDeSdr(orgId);
    if (sdr) return { ...entradaEm(orgId, sdr.id), proprio: false };
    return { ...entradaPadrao(orgId), proprio: false };
  }
  const comercial = funilComercial(orgId);
  return comercial ? { ...entradaEm(orgId, comercial.id), proprio: false } : { ...entradaPadrao(orgId), proprio: false };
}

function entradaEm(orgId, pipelineId) {
  const etapa = primeiraEtapa(orgId, pipelineId);
  return { pipeline_id: pipelineId, stage_id: etapa ? etapa.id : null, nome: etapa ? etapa.name : "Lead" };
}

/* QUAL É O FUNIL DE SDR DA CASA (01/10/2026).

   O funil criado pelo modelo "SDR" tem `type = 'sdr'`. Mas há contas que
   montaram o próprio pré-atendimento do zero (Inbox → Aguardando interação →
   Qualificado) e o puseram como funil de entrada da atendente — e até aqui o
   sistema não sabia que aquilo era SDR: o lead repassado ao corretor ficava
   preso lá. Valem as duas marcas, nesta ordem: o modelo, e o funil que a
   própria atendente escolheu como entrada. */
export function funilDeSdr(orgId) {
  const doModelo = db.prepare(`SELECT id FROM pipelines WHERE org_id = ? AND type = 'sdr' AND is_active = 1
    ORDER BY is_default DESC, ordem, created_at LIMIT 1`).get(orgId);
  if (doModelo) return pipelinePorId(orgId, doModelo.id);
  const daAtendente = db.prepare(`SELECT u.pipeline_entrada AS id, COUNT(*) n FROM users u
    JOIN pipelines p ON p.id = u.pipeline_entrada AND p.org_id = u.org_id AND p.is_active = 1
    WHERE u.org_id = ? AND u.role = 'sdr' AND u.status = 'ativo' AND u.pipeline_entrada IS NOT NULL
    GROUP BY u.pipeline_entrada ORDER BY n DESC LIMIT 1`).get(orgId);
  return daAtendente ? pipelinePorId(orgId, daAtendente.id) : null;
}

export function ehFunilDeSdr(orgId, pipelineId) {
  if (!pipelineId) return false;
  const p = pipelinePorId(orgId, pipelineId);
  if (!p) return false;
  if (p.type === "sdr") return true;
  return funilDeSdr(orgId)?.id === pipelineId;
}

/* O FUNIL COMERCIAL: o padrão da casa — a não ser que o padrão SEJA o de SDR.
   É o segundo motivo de o lead não ir para o comercial no repasse: com o SDR
   marcado como padrão (para os leads novos caírem nele), o "funil do
   corretor" também era o SDR, e o sistema achava que o lead já estava no lugar
   certo. Aí vale o primeiro funil ativo que não é de SDR, de preferência um
   do modelo comercial. */
export function funilComercial(orgId) {
  const padrao = pipelinePadrao(orgId);
  if (padrao && !ehFunilDeSdr(orgId, padrao.id)) return padrao;
  const sdr = funilDeSdr(orgId);
  const outro = db.prepare(`SELECT id FROM pipelines WHERE org_id = ? AND is_active = 1 AND type != 'sdr' AND id != ?
    ORDER BY (type = 'commercial') DESC, ordem, created_at LIMIT 1`).get(orgId, sdr?.id || "");
  return outro ? pipelinePorId(orgId, outro.id) : padrao;
}

/* ===== CRIAR A PARTIR DE UM TEMPLATE ===== */
export function criarDoTemplate(orgId, templateId, { name, is_default = false } = {}) {
  const t = templatePorId(templateId);
  if (!t) return { erro: "Template não encontrado." };
  const criado = criarPipeline(orgId, {
    name: name || t.nome, description: t.descricao, type: t.tipo, is_default,
  });
  if (criado.erro) return criado;
  const rodar = db.transaction(() => {
    t.etapas.forEach((e, i) => inserirEtapa(orgId, criado.pipeline.id, {
      name: e.name, color: e.color, status_type: e.tipo || "aberto",
      counts_as_conversion: !!e.conversao,
      sla_minutes: e.sla ?? null, warning_before_minutes: e.aviso ?? null,
    }, i));
  });
  rodar();
  return { pipeline: criado.pipeline, etapas: etapasDoPipeline(orgId, criado.pipeline.id) };
}

/* ===== O PIPELINE PADRAO DE UMA CONTA QUE JA EXISTE =====

   Roda no start, para toda imobiliaria que ainda nao tem pipeline nenhum, e
   copia exatamente o funil que estava no codigo. A equipe abre o CRM no dia
   seguinte e ve o mesmo de sempre — agora editavel. Migracao que muda o que a
   pessoa ve na tela e migracao que gera chamado.

   Depois liga cada lead ao pipeline e a etapa pelo NOME que ele ja tinha. Lead
   com nome de etapa que nao existe na lista (base antiga, importacao torta)
   fica com pipeline e sem stage_id: aparece no funil pelo nome, como sempre
   apareceu, e o SLA simplesmente nao se aplica a ele ate alguem move-lo. E o
   contrario de descartar o que nao encaixa. */
export function garantirPipelinePadrao(orgId) {
  const { n } = db.prepare("SELECT COUNT(*) n FROM pipelines WHERE org_id = ?").get(orgId);
  if (n) return { criado: false, ...backfillLeads(orgId) };

  const criado = criarPipeline(orgId, {
    name: FUNIL_ATUAL.nome, description: FUNIL_ATUAL.descricao,
    type: FUNIL_ATUAL.tipo, is_default: true,
  });
  if (criado.erro) return { criado: false, erro: criado.erro };
  const rodar = db.transaction(() => {
    FUNIL_ATUAL.etapas.forEach((e, i) => inserirEtapa(orgId, criado.pipeline.id, {
      name: e.name, color: e.color, status_type: e.tipo || "aberto",
      counts_as_conversion: !!e.conversao,
    }, i));
  });
  rodar();
  return { criado: true, pipeline: criado.pipeline, ...backfillLeads(orgId) };
}

/* Liga os leads soltos ao pipeline padrao. Idempotente e em lote: so mexe em
   quem esta com pipeline_id nulo, entao rodar dez vezes da no mesmo. */
export function backfillLeads(orgId) {
  const padrao = pipelinePadrao(orgId);
  if (!padrao) return { ligados: 0 };
  const etapas = etapasDoPipeline(orgId, padrao.id, { incluirInativas: true });
  const porNome = new Map(etapas.map(e => [e.name, e.id]));
  const soltos = db.prepare("SELECT id, stage, created_at FROM leads WHERE org_id = ? AND pipeline_id IS NULL").all(orgId);
  if (!soltos.length) return { ligados: 0 };

  const rodar = db.transaction(() => {
    for (const l of soltos) {
      /* `stage_entered_at` sai do historico quando ele existe, e da criacao do
         lead quando nao existe. Nao e exato para o lead antigo — mas o SLA
         precisa de uma referencia, e "desde que entrou no CRM" e uma resposta
         honesta e verificavel, enquanto nulo faria todo lead antigo nascer
         fora de qualquer medicao. */
      const ultima = db.prepare(
        "SELECT MAX(created_at) q FROM lead_etapas WHERE lead_id = ? AND para = ?").get(l.id, l.stage)?.q;
      db.prepare("UPDATE leads SET pipeline_id = ?, stage_id = ?, stage_entered_at = COALESCE(stage_entered_at, ?) WHERE id = ?")
        .run(padrao.id, porNome.get(l.stage) || null, ultima || l.created_at, l.id);
    }
  });
  rodar();
  return { ligados: soltos.length };
}

export { TEMPLATES };
