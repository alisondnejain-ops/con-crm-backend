/* PRIMEIRO ATENDIMENTO AUTOMÁTICO, FORA DO EXPEDIENTE.

   O problema que ele resolve: lead que chama no sábado à noite. A Vanessa não
   está, ninguém responde, e na segunda o cliente já falou com outra
   imobiliária. Não é o CRM que falha — é que não tem gente às 21h de sábado.

   A regra do Ali, em três partes, e cada uma existe por um motivo diferente:

   1) SÓ FORA DO EXPEDIENTE (18:00 → 09:00). Às 09:00 a atendente assume e o
      robô cala. Isso não é só cortesia: é o que mantém o tempo de resposta
      DELA mensurável. Robô respondendo às 10h da manhã zeraria o número que o
      gestor usa para avaliar a equipe.

   2) SÓ LEAD QUE NÃO ESTÁ COM CORRETOR. Lead já repassado é atendimento de
      alguém, com nome e cobrança em cima. O robô cobre a fila e o que está
      com a atendente — o pedaço que ainda não tem dono de verdade.

   3) SÓ QUEM ESTÁ SEM RETORNO. A última mensagem da conversa tem que ser do
      cliente. É a mesma definição que o aviso de espera usa (`alerta.js`), e
      ela garante sozinha que o robô nunca fale por cima de gente.

   E uma quarta, que é minha e não do Ali: GENTE ENTROU, ROBÔ SAIU PARA SEMPRE
   (`robo_parado`). Sem isso, a atendente responde às 19h, o cliente treplica
   às 19h05 e o robô volta a falar no meio de um atendimento humano.

   NADA AQUI ENTRA NO CAMINHO DO WEBHOOK. O webhook grava a mensagem e
   responde; o robô roda depois, por fora. Webhook lento é webhook que a
   Uazapi desiste de chamar — e aí para de entrar lead, que é o pior estrago
   possível neste sistema. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { atenderPrimeiroContato, iaConfigurada, camposDa } from "./ia.js";
import { registrar as registrarUsoIA } from "./iauso.js";
import { sendText } from "./uazapi.js";
import { lerHorario } from "./expediente.js";

export const TETO_PADRAO = 12;

/* Como as mensagens do robô ficam assinadas na conversa.

   É por este nome que ele se reconhece depois. Mensagem enviada do celular
   não tem autor (`from_user_id` nulo) — o número é único e o WhatsApp não diz
   quem digitou — então "tem autor?" NÃO serve para separar gente de robô: a
   Vanessa respondendo pelo WhatsApp Web cairia do lado errado. O que separa é
   a assinatura. */
export const ASSINATURA_ROBO = "Atendimento automático";

/* ATRASO ANTES DE RESPONDER — e ele faz duas coisas.

   A visível: resposta em dois segundos às 23h de sábado grita "robô" mais
   alto do que qualquer texto. Gente lê, pensa e digita.

   A invisível, e é a que conserta um defeito de verdade: o cliente manda "oi"
   e, três segundos depois, "tenho interesse nas casas". São dois webhooks,
   duas chamadas ao mesmo tempo — as duas veem uma conversa esperando resposta
   e as duas respondem. O cliente receberia duas mensagens quase iguais. A
   trava embaixo segura a segunda, e o atraso faz a primeira já ler as duas
   frases juntas, que é como uma pessoa responderia. */
const ATRASO_MIN = 8000, ATRASO_MAX = 20000;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/* Conversas sendo atendidas AGORA, neste processo. Um Set na memória basta:
   o CRM roda num processo só, e uma trava no banco para um caso que dura
   quinze segundos seria mais peça para dar errado do que proteção. */
const atendendoAgora = new Set();

// 0=domingo … 6=sábado, como o JavaScript conta em `getDay()`.
export const DIAS_PADRAO = [1, 2, 3, 4, 5];
export const lerDias = (txt) => {
  if (txt === null || txt === undefined) return DIAS_PADRAO;
  const d = String(txt).split(",").map(x => Number(x.trim()))
    .filter(x => Number.isInteger(x) && x >= 0 && x <= 6);
  // Texto vazio é escolha de dizer "não tem expediente nenhum dia" — e isso é
  // diferente de coluna nunca preenchida, que cai no padrão.
  return String(txt).trim() === "" ? [] : (d.length ? [...new Set(d)].sort() : DIAS_PADRAO);
};

/* O que a equipe ensinou ao robô, na ordem em que foi escrito.

   Só as linhas ligadas. Desligar em vez de apagar importa: a atendente testa
   uma orientação num fim de semana, não gosta, desliga — e não perde o texto
   para voltar a ligar depois. */
export function orientacoes(orgId, todas = false) {
  return db.prepare(`SELECT id, texto, ativo, ordem, created_at FROM robo_ensino
    WHERE org_id = ?${todas ? "" : " AND ativo = 1"} ORDER BY ordem, created_at`).all(orgId);
}

export function configDoRobo(orgId) {
  const o = db.prepare(
    "SELECT robo_ativo, robo_inicio, robo_fim, robo_teto, robo_dias FROM orgs WHERE id = ?").get(orgId) || {};
  return {
    ativo: !!o.robo_ativo,
    inicio: o.robo_inicio || "18:00",
    fim: o.robo_fim || "09:00",
    teto: Number(o.robo_teto) > 0 ? Number(o.robo_teto) : TETO_PADRAO,
    dias: lerDias(o.robo_dias),
    configurada: iaConfigurada(),
  };
}

/* O robô fala AGORA?

   Duas perguntas, nesta ordem, e a primeira é a que o Ali pediu em 16/08/2026:

   1) HOJE TEM EXPEDIENTE? No sábado e no domingo não tem — e aí não existe
      "fora do expediente", existe "não tem expediente". Ele atende o dia
      inteiro, sem olhar a hora.

   2) SE TEM, ESTAMOS FORA DELE? A janela 18:00 → 09:00 atravessa a
      meia-noite: é "depois das 18 OU antes das 9", não "entre 18 e 9", que
      nunca seria verdade. Errar isto deixa o robô mudo a noite inteira sem
      nenhum erro aparecer em lugar nenhum.

   Sexta 18h até segunda 9h vira um bloco contínuo sem nenhum caso especial:
   sexta cai na regra 2, sábado e domingo na regra 1, segunda de novo na 2. */
export function dentroDaJanela(cfg, agora = Date.now()) {
  const d = new Date(agora);
  const dias = cfg.dias || DIAS_PADRAO;
  if (!dias.includes(d.getDay())) return true;

  const ini = lerHorario(cfg.inicio), fim = lerHorario(cfg.fim);
  if (!ini || !fim) return false;
  const min = d.getHours() * 60 + d.getMinutes();
  const a = ini.h * 60 + ini.m, b = fim.h * 60 + fim.m;
  return a === b ? true : a < b ? (min >= a && min < b) : (min >= a || min < b);
}

/* Palavras que fazem o funil andar sozinho (`services/stages.js` → GATILHOS).

   A resposta da IA pode estar ótima e ainda assim conter "podemos agendar sua
   visita" — e aí o lead pula duas etapas às 3h da manhã sem ninguém ter feito
   nada. Barrar é mais seguro do que reescrever: a conversa fica parada para a
   atendente ver de manhã, que é exatamente onde ela estaria sem o robô. */
const PROIBIDAS = [
  { palavra: "atendimento", padrao: /\batendiment/i },
  { palavra: "documentação", padrao: /\bdocumenta/i },
  { palavra: "documentos", padrao: /\bdocumentos?\b/i },
  { palavra: "aprovação", padrao: /\baprova/i },
  { palavra: "visita", padrao: /\bvisita/i },
  { palavra: "agendar", padrao: /\bagend/i },
  { palavra: "proposta", padrao: /\bproposta\b/i },
  { palavra: "fechar", padrao: /\bfech(ar|amos|ou)\b/i },
  { palavra: "contrato", padrao: /\bcontrato/i },
];
/* Devolve a palavra POR EXTENSO, não o regex. O nome dela vai para o log e
   para a tela do gestor: "contém vsta" não explica nada a ninguém. */
export const palavraProibida = (texto) => {
  const t = String(texto || "");
  const achou = PROIBIDAS.find(p => p.padrao.test(t));
  return achou ? achou.palavra : null;
};

/* Quem o robô pode atender AGORA. Devolve o motivo quando não pode: sem isso,
   "o robô não respondeu" é indistinguível de "o robô está quebrado", e essa
   dúvida custa mais tempo do que o recurso economiza. */
export function podeAtender(orgId, leadId, agora = Date.now()) {
  const cfg = configDoRobo(orgId);
  if (!cfg.ativo) return { pode: false, motivo: "desligado" };
  if (!cfg.configurada) return { pode: false, motivo: "ia_nao_configurada" };
  if (!dentroDaJanela(cfg, agora)) return { pode: false, motivo: "dentro_do_expediente" };

  const lead = db.prepare(`SELECT l.*, u.role AS dono_papel FROM leads l
    LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = ? AND l.org_id = ?`).get(leadId, orgId);
  if (!lead) return { pode: false, motivo: "lead_nao_encontrado" };
  /* Neutro de propósito: aqui só interessa que ele está fora da conversa. POR
     QUE ele saiu — gente respondeu, ele se despediu, bateu o teto, a atendente
     conferiu — é conta de `estadoNoLead`, que é quem escreve na tela. Dizer
     "alguém já respondeu" neste ponto fazia a ficha culpar uma pessoa que
     nunca falou. */
  if (lead.robo_parado) return { pode: false, motivo: "robo_encerrado" };
  /* A trava é o CORRETOR, e só ele. Lead na fila, com a atendente OU com o
     gestor é tudo a mesma situação: ainda não tem dono de verdade, ninguém
     tem esse atendimento no nome para ser cobrado por ele. Lead repassado a
     corretor é o contrário disso, e é o único caso em que o robô se cala. */
  if (lead.dono_papel === "corretor") return { pode: false, motivo: "ja_com_corretor" };
  if ((lead.robo_msgs || 0) >= cfg.teto) return { pode: false, motivo: "teto_de_mensagens" };

  // Sem retorno = a última mensagem da conversa é do cliente. Uma linha de SQL
  // que substitui três regras: não fala sozinho, não fala por cima de gente e
  // não fala duas vezes seguidas.
  const ultima = db.prepare(
    "SELECT direction FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId);
  if (!ultima || ultima.direction !== "in") return { pode: false, motivo: "nao_esta_esperando" };

  return { pode: true, lead, cfg };
}

/* Gente falou nesta conversa: o robô sai e não volta.

   Chamado de todo lugar em que um humano manda mensagem — pelo CRM ou pelo
   celular. Só marca quem o robô estava atendendo: marcar lead nenhum tocado
   pelo robô encheria a coluna de 1 sem significar nada. */
export function pararPorGente(leadId) {
  const l = db.prepare("SELECT robo_msgs, robo_parado FROM leads WHERE id = ?").get(leadId);
  if (!l || l.robo_parado || !(l.robo_msgs > 0)) return false;
  db.prepare("UPDATE leads SET robo_parado = 1 WHERE id = ?").run(leadId);
  console.log(`[robo] gente entrou na conversa ${leadId} — o robô não fala mais neste lead`);
  return true;
}

const lerColetado = (lead) => { try { return JSON.parse(lead.robo_json || "{}") || {}; } catch { return {}; } };

/* Atende uma vez: lê a conversa, escreve a resposta, confere e envia.

   Nunca lança. É chamado sem `await` pelo webhook — uma exceção aqui viraria
   um `unhandledRejection` que derruba o processo inteiro, e o processo inteiro
   é o CRM da Conecta. */
export async function atender(orgId, leadId, { agora = Date.now(), atraso = null } = {}) {
  // Já tem uma resposta a caminho para esta conversa: a segunda mensagem do
  // cliente não vira uma segunda resposta. Ela vai ser lida pela primeira.
  if (atendendoAgora.has(leadId)) return { atendeu: false, motivo: "ja_respondendo" };
  atendendoAgora.add(leadId);
  try {
    // `agora` existe para o teste poder ser 21h de sábado a qualquer hora do
    // dia. Em produção é sempre o relógio.
    if (!podeAtender(orgId, leadId, agora).pode)
      return { atendeu: false, motivo: podeAtender(orgId, leadId, agora).motivo };

    const espera = atraso == null ? ATRASO_MIN + Math.random() * (ATRASO_MAX - ATRASO_MIN) : atraso;
    if (espera > 0) await esperar(espera);

    /* Confere DE NOVO depois de esperar. Nesses segundos a Vanessa pode ter
       respondido pelo celular, ou o gestor pode ter desligado o robô. Decidir
       antes de esperar e agir depois é como um recurso automático atropela uma
       pessoa que estava trabalhando. */
    const t = podeAtender(orgId, leadId, agora);
    if (!t.pode) return { atendeu: false, motivo: t.motivo };
    const { lead, cfg } = t;

    const msgs = db.prepare(
      "SELECT direction, body FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(leadId);
    const coletado = lerColetado(lead);

    const r = await atenderPrimeiroContato({
      nome: lead.name,
      coletado,
      // Quantas ainda cabem, contando esta. É o que permite a última ser uma
      // despedida em vez de um silêncio no meio de uma pergunta.
      restantes: cfg.teto - (lead.robo_msgs || 0),
      // O jeito de falar que a atendente ensinou.
      orientacoes: orientacoes(orgId).map(o => o.texto),
      mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "imobiliaria", texto: m.body })),
    });
    if (!r.ok) { console.warn(`[robo] não atendi ${lead.name}: ${r.erro}`); return { atendeu: false, motivo: "ia_falhou", erro: r.erro }; }
    registrarUsoIA({ orgId, userId: null, leadId, recurso: "atendimento", uso: r.uso });

    const proibida = palavraProibida(r.resposta.texto);
    if (proibida) {
      console.warn(`[robo] mensagem barrada para ${lead.name}: contém "${proibida}", que move o funil`);
      return { atendeu: false, motivo: "palavra_que_move_o_funil", palavra: proibida };
    }

    /* Grava o que ele apurou ANTES de enviar. Se o envio falhar, o CRM perdeu
       uma mensagem; se a ordem fosse a outra e a gravação falhasse, o cliente
       teria recebido uma resposta que a Conecta não tem registro de ter
       mandado — e é o registro que sustenta o atendimento de segunda-feira. */
    const juntado = { ...coletado, ...r.resposta.coletado };
    db.prepare("UPDATE leads SET robo_json = ?, robo_msgs = COALESCE(robo_msgs,0) + 1, robo_em = ? WHERE id = ?")
      .run(JSON.stringify(juntado), Date.now(), leadId);

    /* Sem assinatura. Toda mensagem do CRM sai com "*Nome:*" do corretor; esta
       não tem corretor e não vai fingir um. Sai como a Conecta falando. */
    const envio = await sendText({ orgId, toPhone: lead.phone, text: r.resposta.texto });

    /* A mensagem entra na conversa SEM autor (`from_user_id` nulo) e com
       `from_name` dizendo que foi o atendimento automático. Duas consequências
       de propósito: a tela mostra quem falou, e o score não conta isso como
       resposta de ninguém — o tempo de primeira resposta continua sendo o da
       Vanessa, que é o número que o gestor usa. */
    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,wa_id,created_at)
      VALUES (?,?,'out',NULL,?,?,?,?)`)
      .run("m_" + randomUUID(), leadId, ASSINATURA_ROBO, r.resposta.texto, envio?.messageid || null, Date.now());

    /* `first_resp_at` NÃO é carimbado aqui. Ele é o relógio da equipe: se o
       robô o marcasse, um lead atendido só por robô apareceria no relatório
       como respondido, e a Conecta acharia que atendeu quem ninguém atendeu. */

    if (r.resposta.encerrar) db.prepare("UPDATE leads SET robo_parado = 1 WHERE id = ?").run(leadId);

    console.log(`[robo] respondeu ${lead.name} (${(lead.robo_msgs || 0) + 1}/${cfg.teto})` +
      `${r.resposta.encerrar ? " — encerrou" : ""}`);
    return { atendeu: true, texto: r.resposta.texto, coletado: juntado, encerrou: r.resposta.encerrar };
  } catch (e) {
    console.error("[robo] erro ao atender:", e.message);
    return { atendeu: false, motivo: "erro", erro: e.message };
  } finally {
    atendendoAgora.delete(leadId);
  }
}

/* ===== LIGAR E DESLIGAR NUM LEAD ESPECÍFICO =====

   O robô sai de uma conversa em três situações: gente respondeu, ele mesmo se
   despediu, ou a atendente conferiu. Até aqui isso não tinha volta — e tem que
   ter: a Vanessa responde às 19h, vai jantar, e o cliente continua escrevendo.
   Quem decide se vale a pena o robô assumir de novo é ela, olhando a conversa.

   Devolver o estado JUNTO com o botão não é enfeite. As regras gerais
   continuam valendo depois de religar (a janela de horário, o dono do lead, o
   interruptor da imobiliária), então religar num lead que já está com corretor
   é um clique que não faz nada. Um botão que não faz nada e não diz por quê é
   pior do que botão nenhum. */
export function estadoNoLead(orgId, leadId, agora = Date.now()) {
  const cfg = configDoRobo(orgId);
  const lead = db.prepare("SELECT robo_msgs, robo_parado, robo_conferido_em FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) return null;
  const t = podeAtender(orgId, leadId, agora);

  /* O motivo MOSTRADO prefere a causa deste lead à causa do relógio.

     `podeAtender` confere o horário primeiro, porque é a conta mais barata. Só
     que, para quem está olhando a ficha às duas da tarde, "agora é horário de
     expediente" é uma resposta que muda sozinha às 18h — e esconde a que
     interessa e não muda: alguém já respondeu, ou o lead é de um corretor. É
     essa que o botão resolve. */
  /* POR QUE ele está fora desta conversa. São quatro causas diferentes, e
     dizer "alguém já respondeu" quando na verdade ele se despediu sozinho é o
     tipo de frase que faz a atendente procurar uma mensagem que não existe.

     Gente responder é o único caso que precisa ser conferido no histórico: as
     outras três estão no próprio lead. */
  const teveGente = !!db.prepare(`SELECT 1 FROM messages
    WHERE lead_id = ? AND direction = 'out' AND COALESCE(from_name,'') <> ? LIMIT 1`)
    .get(leadId, ASSINATURA_ROBO);
  const doLead =
      lead.robo_conferido_em ? "ja_conferido"
    : teveGente ? "gente_assumiu"
    // Bater o teto é causa deste lead, e não do relógio: às 14h a ficha diria
    // "agora é expediente" e esconderia o motivo que o botão resolve.
    : (lead.robo_msgs || 0) >= cfg.teto ? "teto_de_mensagens"
    : lead.robo_parado ? "ele_se_despediu"
    : null;
  return {
    // Ligado NESTE lead. Diferente de `cfg.ativo`, que é da imobiliária toda.
    ligado: !lead.robo_parado,
    mensagens: lead.robo_msgs || 0,
    teto: cfg.teto,
    org_ativo: cfg.ativo,
    configurada: cfg.configurada,
    janela: `${cfg.inicio} às ${cfg.fim}`,
    dias: cfg.dias,
    dentro_da_janela: dentroDaJanela(cfg),
    // O que aconteceria se o cliente escrevesse AGORA, e por quê.
    responderia: t.pode,
    motivo: t.pode ? null : (doLead || t.motivo),
  };
}

/* Religa (ou desliga) o robô neste lead.

   Religar ZERA a contagem de mensagens. "Ativar de novo" tem que significar
   que ele volta a poder conversar — religar um lead que já bateu o teto e
   deixá-lo mudo seria o mesmo botão que não faz nada, com outra roupa. */
export function ligarNoLead(orgId, leadId, ativo) {
  const lead = db.prepare("SELECT id, name FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) return { erro: "Lead não encontrado." };
  if (ativo) db.prepare("UPDATE leads SET robo_parado = 0, robo_msgs = 0, robo_conferido_em = NULL WHERE id = ?").run(leadId);
  else db.prepare("UPDATE leads SET robo_parado = 1 WHERE id = ?").run(leadId);
  console.log(`[robo] ${ativo ? "religado" : "desligado"} no lead ${lead.name}`);
  return { ok: true, estado: estadoNoLead(orgId, leadId) };
}

/* A lista de segunda-feira: quem o robô atendeu e ninguém conferiu ainda.

   Este é o par obrigatório do robô, não um extra. Sem ela, a conversa do
   sábado tem a última mensagem da imobiliária — e some da fila de "cliente
   esperando", que é onde a atendente olha. O robô trocaria "ninguém
   respondeu" por "ninguém percebeu que ainda faltava responder". */
export function paraConferir(orgId) {
  const linhas = db.prepare(`
    SELECT l.id, l.name, l.phone, l.robo_json, l.robo_msgs, l.robo_em, l.assigned_to,
           u.name AS dono,
           (SELECT COUNT(*) FROM messages m WHERE m.lead_id = l.id) AS mensagens
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE l.org_id = ? AND l.robo_msgs > 0 AND l.robo_conferido_em IS NULL
    ORDER BY l.robo_em DESC`).all(orgId);

  return linhas.map(l => {
    let coletado = {}; try { coletado = JSON.parse(l.robo_json || "{}") || {}; } catch {}
    return {
      id: l.id, nome: l.name, telefone: l.phone, dono: l.dono || null,
      mensagens: l.mensagens, respostas_do_robo: l.robo_msgs, quando: l.robo_em,
      coletado,
      /* Compra e aluguel têm cinco campos cada, mas não os mesmos. Contar pela
         lista da compra num lead de aluguel daria "1 de 5" numa conversa
         completa — e a atendente ligaria à toa. */
      finalidade: coletado.finalidade || null,
      completos: camposDa(coletado.finalidade).filter(c => coletado[c]).length,
      total_campos: camposDa(coletado.finalidade).length,
    };
  });
}

/* A atendente conferiu. Sai da lista e, se ela quiser, o que o robô apurou
   entra na ficha do lead — a mesma `qual_json` que o formulário do Meta
   preenche, para o corretor não ter que ler a conversa inteira. */
export function conferir(orgId, leadId, { gravarNaFicha = true, userId = null } = {}) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) return { erro: "Lead não encontrado." };

  if (gravarNaFicha) {
    let atual = {}; try { atual = JSON.parse(lead.qual_json || "{}") || {}; } catch {}
    let doRobo = {}; try { doRobo = JSON.parse(lead.robo_json || "{}") || {}; } catch {}

    /* A ficha do lead tem os campos da COMPRA — são os do formulário do Meta.
       Num lead de aluguel, "orçamento" e "garantia" não têm onde caber, e
       jogá-los em "entrada" e "cpf" seria escrever mentira num campo com nome.
       Então eles entram na SITUAÇÃO, que é texto livre e é o primeiro campo
       que o corretor lê. Sem isto, o que o robô apurou no aluguel sumiria
       exatamente na hora de virar atendimento de gente. */
    const alugando = String(doRobo.finalidade || "").toLowerCase().startsWith("alug");
    if (alugando) {
      const extras = [
        "ALUGUEL",
        doRobo.orcamento ? `orçamento ${doRobo.orcamento}` : null,
        doRobo.garantia ? `garantia: ${doRobo.garantia}` : null,
        doRobo.situacao || null,
      ].filter(Boolean);
      doRobo = { renda: doRobo.renda, prazo: doRobo.prazo, situacao: extras.join(" · ") };
    }
    // O que já estava na ficha ganha: alguém digitou aquilo olhando o cliente.
    const junto = { ...doRobo, ...atual };
    db.prepare("UPDATE leads SET qual_json = ? WHERE id = ?").run(JSON.stringify(junto), leadId);
  }
  db.prepare("UPDATE leads SET robo_conferido_em = ?, robo_parado = 1 WHERE id = ?").run(Date.now(), leadId);
  console.log(`[robo] ${lead.name} conferido${userId ? " por " + userId : ""}`);
  return { ok: true };
}
