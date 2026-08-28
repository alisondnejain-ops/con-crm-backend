/* Arrumar a base inteira de uma vez: temperatura e etapa do funil.

   Duas operações que mexem em centenas de leads ao mesmo tempo. Três regras
   valem para as duas, e elas existem porque desfazer isso na mão é inviável:

   1) CONFERIR ANTES DE APLICAR. Toda operação tem uma prévia que diz quantos
      leads seriam tocados, quem fica de fora e por quê — e, quando gasta
      dinheiro, quanto vai custar.
   2) TUDO FICA REGISTRADO. Mudança de etapa passa por `moverEtapa`, então
      cada lead guarda de onde veio, para onde foi e por qual motivo.
   3) QUEM ESTÁ COM A ATENDENTE FICA DE FORA. Ela faz o primeiro contato e
      repassa; o lead que ainda está com ela não é atendimento de corretor
      nenhum, e mexer na etapa dele sujaria o relatório de quem não o atendeu.

   Sobre a temperatura: todo lead do WhatsApp nascia "MORNO" — não era leitura
   de nada, era o padrão da coluna. A tela mostrava aquilo como se alguém
   tivesse avaliado o cliente. Tirar é devolver a verdade: quem sabe a
   temperatura é quem conversou. */

import db from "../db.js";
import { pipelinePorId, etapasDoPipeline } from "./pipelines.js";
import { LINEAR } from "./stages.js";
import { moverEtapa } from "./etapas.js";
import { etapaDaConversa, temperaturaDaConversa, iaConfigurada } from "./ia.js";
import { registrar as registrarUsoIA, custoEstimado } from "./iauso.js";

/* ===== TEMPERATURA ===== */

// Quem seria afetado por apagar uma temperatura. Só conta, não muda nada.
export function previaTemperatura(orgId, temperatura) {
  const n = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=? AND priority=?").get(orgId, temperatura).n;
  const total = db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id=?").get(orgId).n;
  const restam = db.prepare(
    `SELECT priority p, COUNT(*) n FROM leads WHERE org_id=? AND priority IS NOT NULL AND priority<>?
     GROUP BY priority`).all(orgId, temperatura);
  return { temperatura, leads: n, total, restam };
}

/* Apaga a marcação, não o lead. O campo fica nulo e a tela mostra "sem
   temperatura" — estado de verdade, e não um "morno" que ninguém escolheu. */
export function limparTemperatura(orgId, temperatura) {
  const info = db.prepare("UPDATE leads SET priority = NULL WHERE org_id=? AND priority=?").run(orgId, temperatura);
  console.log(`[lote] temperatura "${temperatura}" removida de ${info.changes} lead(s)`);
  return { limpos: info.changes };
}

/* ===== TEMPERATURA LIDA PELA IA, UM CORRETOR POR VEZ =====

   A temperatura voltou, mas por outro caminho. Antes ela nascia sozinha
   ("MORNO" era o padrão da coluna) e ninguém sabia de onde tinha vindo. Agora
   ela só existe quando o gestor PEDE, corretor por corretor, e cada marcação
   guarda quem a colocou (`priority_por`) e quando (`priority_em`).

   Por que um corretor por vez, e não a base inteira: a pergunta do Ali não é
   "como está a base", é "como este corretor está atendendo". Rodar por corretor
   deixa a leitura ao lado do nome de quem atendeu, custa pouco de cada vez e
   pode parar no meio sem estragar o resto. */

/* Os leads de UM corretor que podem ser lidos. Mesmas exclusões da etapa —
   sem dono/com a atendente, sem conversa, vendido, etapa marcada na mão. */
function elegiveisDoCorretor(orgId, corretorId) {
  return elegiveis(orgId).filter(l => l.assigned_to === corretorId);
}

/* Quem pode ser analisado, com quanto cada um tem na mão e o que já foi lido.
   É a lista que a tela mostra: o gestor escolhe um nome e vê o preço antes. */
export function corretoresParaTemperatura(orgId) {
  const lista = elegiveis(orgId);
  const por = new Map();
  for (const l of lista) {
    const a = por.get(l.assigned_to) || { id: l.assigned_to, nome: l.corretor, leads: 0, lidos: 0 };
    a.leads++;
    if (temperaturaDaIA(l.id)) a.lidos++;
    por.set(l.assigned_to, a);
  }
  return {
    configurada: iaConfigurada(),
    corretores: [...por.values()].sort((a, b) => b.leads - a.leads || a.nome.localeCompare(b.nome)),
  };
}

export function previaTemperaturaIA(orgId, corretorId) {
  const u = db.prepare("SELECT id, name, role FROM users WHERE id=? AND org_id=?").get(corretorId, orgId);
  if (!u) return { erro: "Corretor não encontrado nesta imobiliária." };
  if (u.role !== "corretor") return { erro: "A leitura é do atendimento do corretor. A atendente faz o primeiro contato e repassa — os leads dela não são atendimento de corretor nenhum." };

  const lista = elegiveisDoCorretor(orgId, corretorId);
  const faltam = lista.filter(l => !jaTemperado(l.id));
  return {
    configurada: iaConfigurada(),
    corretor: { id: u.id, nome: u.name },
    leads: lista.length,
    a_ler: faltam.length,
    ja_lidos: lista.length - faltam.length,
    custo: custoEstimado(faltam.length),
  };
}

/* Roda a IA num pedaço da fila deste corretor. Mesmo desenho da etapa: em
   pedaços, com o que já foi feito gravado, e devolvendo quantos faltam.

   A leitura grava direto em `leads.priority` — aqui a IA ESCREVE, e é a única
   coisa em que ela escreve. É temperatura, não etapa: temperatura não vira
   relatório de cobrança, é uma ordenação de quem chamar primeiro, e o corretor
   corrige na ficha com um clique. Etapa continua sendo sugestão. */
export async function rodarTemperaturaIA(orgId, { corretorId, limite = 20, userId = null } = {}) {
  if (!iaConfigurada()) return { erro: "A IA não está ligada nesta instalação." };
  const previa = previaTemperaturaIA(orgId, corretorId);
  if (previa.erro) return { erro: previa.erro };

  const fila = elegiveisDoCorretor(orgId, corretorId).filter(l => !jaTemperado(l.id));
  const lote = fila.slice(0, limite);
  const leituras = [], erros = [];
  const contagem = { QUENTE: 0, MORNO: 0, FRIO: 0 };

  for (const l of lote) {
    const msgs = db.prepare("SELECT direction, body FROM messages WHERE lead_id=? ORDER BY created_at ASC").all(l.id);
    const r = await temperaturaDaConversa({
      nome: l.name,
      mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "imobiliaria", texto: m.body })),
    });

    if (!r.ok) { erros.push({ lead: l.name, erro: r.erro }); continue; }
    registrarUsoIA({ orgId, userId, leadId: l.id, recurso: "temperatura", uso: r.uso });

    db.prepare("UPDATE leads SET priority=?, priority_por='ia', priority_em=? WHERE id=?")
      .run(r.leitura.temperatura, Date.now(), l.id);
    contagem[r.leitura.temperatura]++;
    leituras.push({ nome: l.name, temperatura: r.leitura.temperatura,
      confianca: r.leitura.confianca, porque: r.leitura.porque });
  }

  /* `marcados` é diferente de `analisados`, e a diferença é o ponto: conversa
     que a IA não conseguiu ler foi tentada e NÃO foi marcada. Com um número
     só, uma rodada em que tudo falhou aparecia na tela como "4 lidos" — o
     mesmo texto de quando tudo deu certo. */
  const restam = fila.length - lote.length;
  console.log(`[lote] IA leu a temperatura de ${leituras.length} de ${lote.length} conversa(s) de ${previa.corretor.nome}, faltam ${restam}`);
  return {
    corretor: previa.corretor, analisados: lote.length, marcados: leituras.length,
    restam, contagem, leituras: leituras.slice(0, 20), erros,
  };
}

/* Já foi lida por IA, e há pouco tempo? Mesma janela da etapa: parar no meio e
   continuar depois não paga duas vezes pela mesma conversa. Temperatura posta
   na mão pelo corretor NÃO conta como lida — a IA reescreve por cima só quando
   o gestor manda rodar, e a leitura mais nova é a que vale. */
const temperaturaDaIA = (id) => {
  const l = db.prepare("SELECT priority, priority_por FROM leads WHERE id=?").get(id);
  return !!(l && l.priority && l.priority_por === "ia");
};
const jaTemperado = (id) => {
  const l = db.prepare("SELECT priority_por, priority_em FROM leads WHERE id=?").get(id);
  return !!(l && l.priority_por === "ia" && l.priority_em && Date.now() - l.priority_em < JANELA);
};
/* Conversa que a IA não conseguiu ler NÃO fica marcada.

   A primeira versão marcava, para não repetir a tentativa. Só que o motivo da
   falha costuma ser a instalação (chave errada, provedor fora do ar), não a
   conversa: o gestor consertava a chave, mandava rodar de novo e não
   acontecia nada por 12 horas, sem explicação. Quem impede o laço de repetir
   para sempre é o lado de lá — a tela para quando um bloco inteiro falha e
   mostra o erro. */

/* ===== ETAPA DO FUNIL, LIDA PELA IA ===== */

/* Quem entra na reanálise por IA.

   Fica de fora, e cada motivo tem uma razão diferente:
   - SEM DONO ou COM A ATENDENTE: não é atendimento de corretor;
   - SEM CONVERSA: não há o que a IA ler — ela inventaria;
   - VENDA REGISTRADA: tem valor e data lançados, é dinheiro e não palpite;
   - ETAPA MANUAL (Perdido, Recaptação, Transferido): quem marcou sabe de algo
     que a conversa não mostra. */
export function elegiveis(orgId) {
  const vagas = LINEAR.map(() => "?").join(",");
  return db.prepare(`
    SELECT l.id, l.name, l.stage, l.assigned_to, u.name AS corretor
    FROM leads l JOIN users u ON u.id = l.assigned_to
    WHERE l.org_id = ? AND u.role = 'corretor' AND u.status = 'ativo'
      AND l.sale_value IS NULL AND l.stage IN (${vagas})
      AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id)
    ORDER BY u.name, l.created_at`).all(orgId, ...LINEAR);
}

export function previaEtapaIA(orgId) {
  const vagas = LINEAR.map(() => "?").join(",");
  const conta = (sql, ...a) => db.prepare(sql).get(orgId, ...a).n;
  const lista = elegiveis(orgId);
  const porCorretor = new Map();
  for (const l of lista) porCorretor.set(l.corretor, (porCorretor.get(l.corretor) || 0) + 1);

  return {
    configurada: iaConfigurada(),
    leads: lista.length,
    por_corretor: [...porCorretor].map(([nome, n]) => ({ nome, leads: n })).sort((a, b) => b.leads - a.leads),
    fora: {
      com_atendente_ou_sem_dono: conta(`SELECT COUNT(*) n FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
        WHERE l.org_id=? AND (l.assigned_to IS NULL OR u.role <> 'corretor')`),
      sem_conversa: conta(`SELECT COUNT(*) n FROM leads l WHERE l.org_id=?
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id=l.id)`),
      venda_registrada: conta("SELECT COUNT(*) n FROM leads WHERE org_id=? AND sale_value IS NOT NULL"),
      etapa_manual: conta(`SELECT COUNT(*) n FROM leads WHERE org_id=? AND stage NOT IN (${vagas})`, ...LINEAR),
    },
    custo: custoEstimado(lista.length),
  };
}

/* Roda a IA num PEDAÇO da fila e devolve quantos faltam.

   Em pedaços de propósito: são centenas de conversas, cada chamada leva alguns
   segundos, e uma requisição só levaria minutos — o navegador desiste no meio e
   ninguém sabe quanto foi feito. Assim a tela mostra o avanço e o trabalho já
   feito fica gravado mesmo se pararem no meio.

   `motivo: "ia_lote"` distingue esta análise no histórico. Não é a palavra-
   chave (que é chute) nem o clique do corretor num lead — é uma leitura em
   massa que o gestor autorizou, e dá para separar as três depois. */
export async function rodarEtapaIA(orgId, { limite = 20, userId = null } = {}) {
  if (!iaConfigurada()) return { erro: "A IA não está ligada nesta instalação." };

  const fila = elegiveis(orgId).filter(l => !jaAnalisado(l.id));
  const lote = fila.slice(0, limite);
  const mudancas = [], erros = [];

  for (const l of lote) {
    const msgs = db.prepare("SELECT direction, body FROM messages WHERE lead_id=? ORDER BY created_at ASC").all(l.id);
    const r = await etapaDaConversa({
      nome: l.name,
      mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "imobiliaria", texto: m.body })),
    });

    // Falhou: não marca. Ver a nota em `rodarTemperaturaIA` — marcar a falha
    // deixava o lead 12h fora da fila por um problema que era da instalação.
    if (!r.ok) { erros.push({ lead: l.name, erro: r.erro }); continue; }
    registrarUsoIA({ orgId, userId, leadId: l.id, recurso: "etapa", uso: r.uso });
    db.prepare("UPDATE leads SET etapa_ia_json=?, etapa_ia_em=?, etapa_ia_msgs=? WHERE id=?")
      .run(JSON.stringify(r.sugestao), Date.now(), msgs.length, l.id);

    if (r.sugestao.etapa !== l.stage) {
      moverEtapa({ leadId: l.id, para: r.sugestao.etapa, motivo: "ia_lote", userId });
      mudancas.push({ nome: l.name, corretor: l.corretor, de: l.stage, para: r.sugestao.etapa, confianca: r.sugestao.confianca });
    }
  }

  const restam = fila.length - lote.length;
  const lidos = lote.length - erros.length;
  console.log(`[lote] IA leu ${lidos} de ${lote.length} conversa(s), ${mudancas.length} mudaram de etapa, faltam ${restam}`);
  return { analisados: lote.length, lidos, mudaram: mudancas.length, restam, mudancas: mudancas.slice(0, 20), erros };
}

/* Já foi lido nesta rodada? Marcamos pela data da leitura: lead com
   `etapa_ia_em` recente não é relido, então parar e continuar depois não paga
   duas vezes pela mesma conversa. */
const JANELA = 12 * 3600000;
const jaAnalisado = (id) => {
  const l = db.prepare("SELECT etapa_ia_em FROM leads WHERE id=?").get(id);
  return !!(l && l.etapa_ia_em && Date.now() - l.etapa_ia_em < JANELA);
};

/* ===== MOVER LEADS DE UMA PESSOA PARA OUTRO FUNIL ===== (28/08/2026)

   Pedido do Ali: "todos os contatos atribuídos à Vanessa no funil de SDR".

   É a operação que faltava para os múltiplos funis servirem para alguma coisa.
   Criar o funil do SDR não adianta nada se os leads que deveriam estar nele
   continuam no comercial, e mover trezentos leads um a um não é uma opção que
   se ofereça a alguém.

   DUAS DECISOES QUE MUDAM O RESULTADO, E POR ISSO SAO ESCOLHA DE QUEM MANDA:

   1. EM QUAL ETAPA ELES CAEM. Os funis são diferentes por natureza — o
      comercial tem "Pasta" e "Aprovação", o de SDR tem "Tentativa 2". Quase
      nada casa por nome. Por isso o padrão é a PRIMEIRA etapa do destino, que
      é o começo honesto de um fluxo novo; quem quiser preservar o que casar
      pede `manterEtapa`, e o que não casar cai na primeira do mesmo jeito.

      Dito na prévia, sempre: a etapa é o que a gestão lê no relatório, e
      mover a base inteira para "Lead novo" sem avisar zeraria um funil que
      alguém passou meses construindo.

   2. O QUE ACONTECE COM QUEM JA ESTA LA. Nada: lead que já está no funil de
      destino não é tocado nem contado. Rodar duas vezes dá no mesmo.

   O que NAO muda: o responsável. Mover de funil é mudar o fluxo, não tirar o
   lead da pessoa — quem quiser repassar usa a catraca, que é outra decisão. */

export function previaMoverFunil(orgId, { userId, pipelineId, manterEtapa = false }) {
  const destino = pipelinePorId(orgId, pipelineId);
  if (!destino) return { erro: "Funil de destino não encontrado." };
  const etapas = etapasDoPipeline(orgId, pipelineId);
  if (!etapas.length) return { erro: "O funil de destino não tem etapas ativas. Crie ao menos uma antes de mover." };

  const dono = userId === "fila"
    ? { id: null, name: "sem dono (na fila)" }
    : db.prepare("SELECT id,name FROM users WHERE id=? AND org_id=?").get(userId, orgId);
  if (!dono) return { erro: "Pessoa não encontrada nesta imobiliária." };

  const alvos = db.prepare(`SELECT l.*, p.name AS pipeline_nome FROM leads l
    LEFT JOIN pipelines p ON p.id = l.pipeline_id
    WHERE l.org_id = ? AND ${userId === "fila" ? "l.assigned_to IS NULL" : "l.assigned_to = ?"}
      AND (l.pipeline_id IS NULL OR l.pipeline_id <> ?)`)
    .all(...(userId === "fila" ? [orgId, pipelineId] : [orgId, userId, pipelineId]));

  const porNome = new Map(etapas.map(e => [e.name, e]));
  const primeira = etapas[0];
  // De onde eles vêm, para a prévia dizer o tamanho do estrago antes do clique.
  const origem = new Map();
  let casam = 0;
  for (const l of alvos) {
    const chave = l.pipeline_nome || "(sem funil)";
    origem.set(chave, (origem.get(chave) || 0) + 1);
    if (manterEtapa && porNome.has(l.stage)) casam++;
  }

  return {
    pessoa: dono.name, destino: destino.name,
    leads: alvos.length,
    ja_estao_la: db.prepare(`SELECT COUNT(*) n FROM leads WHERE org_id=? AND pipeline_id=?
      AND ${userId === "fila" ? "assigned_to IS NULL" : "assigned_to = ?"}`)
      .get(...(userId === "fila" ? [orgId, pipelineId] : [orgId, pipelineId, userId])).n,
    de: [...origem.entries()].map(([nome, n]) => ({ funil: nome, leads: n })),
    etapa_destino: primeira ? primeira.name : null,
    manter_etapa: !!manterEtapa,
    // Quantos conservariam a etapa atual, se a opção estiver ligada.
    etapa_preservada: manterEtapa ? casam : 0,
    etapa_para_a_primeira: manterEtapa ? alvos.length - casam : alvos.length,
  };
}

export function moverParaFunil(orgId, { userId, pipelineId, manterEtapa = false, quemMandou = null }) {
  const previa = previaMoverFunil(orgId, { userId, pipelineId, manterEtapa });
  if (previa.erro) return previa;
  if (!previa.leads) return { movidos: 0, ...previa };

  const etapas = etapasDoPipeline(orgId, pipelineId);
  const porNome = new Map(etapas.map(e => [e.name, e]));
  const primeira = etapas[0];

  const alvos = db.prepare(`SELECT id, stage FROM leads
    WHERE org_id = ? AND ${userId === "fila" ? "assigned_to IS NULL" : "assigned_to = ?"}
      AND (pipeline_id IS NULL OR pipeline_id <> ?)`)
    .all(...(userId === "fila" ? [orgId, pipelineId] : [orgId, userId, pipelineId]));

  let movidos = 0;
  /* Um `moverEtapa` por lead, e não um UPDATE em massa. Custa mais e é o certo:
     é ele que grava o histórico de etapa e o registro de transferência entre
     funis. Um UPDATE direto moveria os leads sem deixar rastro, e "por onde
     este lead passou" é justamente a pergunta que a mudança de funil cria. */
  const rodar = db.transaction(() => {
    for (const l of alvos) {
      const destinoEtapa = (manterEtapa && porNome.get(l.stage)) || primeira;
      if (!destinoEtapa) continue;
      if (moverEtapa({ leadId: l.id, paraEtapaId: destinoEtapa.id,
        motivo: "mao", userId: quemMandou })) movidos++;
    }
  });
  rodar();
  console.log(`[lote] ${movidos} lead(s) de ${previa.pessoa} movidos para o funil "${previa.destino}"`);
  return { movidos, ...previa };
}
