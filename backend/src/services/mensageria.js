/* ===== O CAMINHO DE UMA MENSAGEM QUE CHEGA, PARA QUALQUER PROVEDOR (03/09/2026) =====

   Até aqui isto vivia inteiro dentro de routes/uazapi.webhook.js. A API
   oficial da Meta manda um payload completamente diferente — entry/changes/
   value/messages, em vez do formato solto da Uazapi —, mas o que ACONTECE
   depois de reconhecer a linha e extrair telefone+texto é o MESMO trabalho,
   provedor nenhum muda: criar o lead pela catraca certa, guardar a mídia,
   trocar de linha quando o cliente troca, religar o funil, avisar o
   corretor, chamar o robô.

   Por isso esta função é chamada pelos DOIS webhooks
   (routes/uazapi.webhook.js e routes/whatsapp-oficial.webhook.js), cada um
   só cuidando do que É diferente: o formato do payload, e como a
   identidade de quem mandou é conferida (token da instância × assinatura
   HMAC do app). Regra de negócio escrita duas vezes é regra que diverge —
   já aconteceu neste projeto (seis rotas fazendo o mesmo UPDATE antes de
   existir `trocarResponsavel`, documentado no CLAUDE.md em 01/09/2026), e é
   o motivo de este arquivo existir em vez de copiar o corpo do handler. */

import { registrarPedidoDeSaida } from "./marketing.js";
import { mensagemRecebida as respostaAoDisparo, ecoDeDisparo } from "./disparo.js";
import { ROTULO_DISPARO, ecoDoCrm } from "./marca-disparo.js";
import { randomUUID } from "crypto";
import db from "../db.js";
import { nascerLeadDoWhatsapp } from "./lead-whatsapp.js";
import { triarNumeroNovo } from "./triagem.js";
import { guardarMidiaRecebida } from "./midia.js";
import { atender, pararPorGente } from "./robo.js";
import { avisar } from "./push.js";
import { advanceStage } from "../routes/messages.routes.js";

// Guarda os últimos webhooks recebidos, dos DOIS provedores, só em memória,
// para diagnóstico. Não persiste e some a cada reinício — é ferramenta de
// instalação, não de operação.
export const ultimosEventos = [];
export const lembrar = (e) => { ultimosEventos.unshift(e); if (ultimosEventos.length > 15) ultimosEventos.pop(); };

/* `envelope` é o formato que os dois webhooks convertem o próprio payload
   para, ANTES de chamar esta função — é a fronteira entre "o que muda por
   provedor" e "o que não muda":

     phone     — já normalizado (services/stages.js → normalizePhone)
     texto     — o corpo da mensagem, ou a legenda de uma mídia
     tipo      — rótulo livre do tipo (a Uazapi manda um; a Meta, outro)
     content   — objeto de mídia, ou null. Quem sabe baixá-lo é
                 services/midia.js, que já entende os dois formatos.
     temMidia  — decidido por quem chama, porque só ele sabe reconhecer o
                 formato de mídia do próprio provedor.
     fromMe    — true quando a mensagem SAIU do número pela própria pessoa,
                 fora do CRM (só existe na Uazapi — a API oficial da Meta
                 nunca entrega de volta uma mensagem que ela mesma mandou).
     citada    — id (do WhatsApp) da mensagem respondida, ou "".
     messageid — id (do WhatsApp) desta mensagem, para dedup e citação futura.
     nome      — nome de exibição de quem mandou, quando o provedor manda. */
/* A mensagem já está gravada nesta imobiliária? O id vem em dois formatos na
   uazapiGO — "3EB0…" e "5587…:3EB0…" (o número da instância na frente) —, e
   a mesma mensagem pode chegar num e ficar gravada no outro. `direcao` nula
   vale para as duas (o eco do que o CRM enviou). */
function jaGravada(orgId, messageid, direcao) {
  const id = String(messageid);
  const suf = id.split(":").pop();
  return !!db.prepare(`SELECT 1 FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.org_id = ? AND (m.wa_id = ? OR m.wa_id = ? OR m.wa_id LIKE ?)${direcao ? " AND m.direction = ?" : ""} LIMIT 1`)
    .get(...[orgId, id, suf, "%:" + suf, ...(direcao ? [direcao] : [])]);
}
const emAndamento = new Set();

export async function processarMensagemRecebida({ canal, evento, phone, texto, tipo, content, temMidia, fromMe, citada, citadaTrecho = "", messageid, nome, enviadaPelaApi }) {
  const orgId = canal.org_id;
  /* A linha em que a conversa passa a acontecer: nula é a da CASA. A do
     disparo (marketing) conta como linha própria — quem respondeu a um
     disparo continua a conversa pelo número que recebeu, senão a resposta da
     equipe chegaria de um número que a pessoa nunca viu. Mas o lead que nasce
     ali NÃO é de ninguém em especial: vai pela catraca, igual ao da casa. */
  const linhaDaConversa = canal.tipo === "imobiliaria" ? null : canal.id;
  const ehDisparo = canal.tipo === "disparo";
  const provider = canal.provider || "uazapi";

  /* Mensagem que o CRM mandou volta como webhook. Ela já está na conversa —
     gravar de novo seria a mesma mensagem duas vezes. O `wa_id` é o que
     diferencia isso do corretor digitando no celular (só acontece na
     Uazapi; na Meta `fromMe` nunca é true, então este `if` nunca dispara
     ali — e não precisa disparar, porque o resto da função segue igual). */
  if (fromMe && messageid && jaGravada(orgId, messageid, null))
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: eco da mensagem enviada pelo próprio CRM" });

  /* O ECO QUE CHEGA ANTES DO REGISTRO, OU SEM ID QUE CASE (29/09/2026). O CRM
     grava o que enviou depois que a Uazapi responde; o eco pode chegar antes,
     ou a resposta pode não ter trazido id (localização, imóvel). Sem isto,
     cada mensagem do CRM aparecia duas vezes — a segunda como "Enviada pelo
     WhatsApp". O eco do DISPARO fica fora: ele tem regra própria lá embaixo
     (entra na conversa como mensagem do disparo). */
  if (fromMe && ecoDoCrm(orgId, phone, messageid, enviadaPelaApi) && !ecoDeDisparo(orgId, phone, messageid))
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: eco de uma mensagem enviada pelo próprio CRM (chegou antes do registro ou sem id)" });

  /* A MESMA MENSAGEM DO CLIENTE ENTREGUE DUAS VEZES (29/09/2026): webhook
     geral da Uazapi + webhook do número, ou a Uazapi reentregando. O id do
     WhatsApp é o da mensagem — o cliente mandar a mesma frase de novo gera
     outro. A conferência vem ANTES de qualquer espera (o download da mídia),
     e o `emAndamento` cobre a entrega irmã que chega enquanto a primeira
     ainda está baixando o arquivo: sem ele, as duas veriam o banco vazio e
     um lead novo nasceria duas vezes. */
  const chaveEntrega = messageid ? `${orgId}|${String(messageid).split(":").pop()}` : null;
  if (!fromMe && messageid && (jaGravada(orgId, messageid, "in") || emAndamento.has(chaveEntrega)))
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: a mesma mensagem chegou duas vezes (já está na conversa)" });
  if (chaveEntrega) emAndamento.add(chaveEntrega);
  try {
    return await processar();
  } finally {
    if (chaveEntrega) emAndamento.delete(chaveEntrega);
  }

  async function processar() {

  let lead = db.prepare("SELECT * FROM leads WHERE phone = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1").get(phone, orgId);
  const ehNovo = !lead;

  /* Saiu do celular para um número que ainda não é lead: não cria lead.
     O número da imobiliária também fala com colega, fornecedor e parente —
     e cada uma dessas conversas viraria um lead na fila da atendente.
     Quando for cliente de verdade, ele responde, e aí o lead nasce pelo
     caminho normal, na regra da catraca. (Só acontece na Uazapi.) */
  if (!lead && fromMe)
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: enviada para um número que ainda não é lead" });

  /* NÚMERO DESCONHECIDO PASSA PELA TRIAGEM ANTES DE QUALQUER COISA
     (03/10/2026, services/triagem.js). Antes de baixar a foto ou o áudio:
     se for conversa pessoal, nada dela pode ficar gravado — nem o arquivo.
     Número marcado como pessoal é ignorado; com a triagem ligada na linha,
     ele vai para "Novos contatos" (só nome e número) e espera alguém dizer
     se é lead. */
  if (!lead) {
    const t = triarNumeroNovo({ canal, phone, nome });
    if (t) return lembrar({ em: Date.now(), evento, provider, resultado: t });
  }

  // Foto, áudio ou documento: baixa e guarda o arquivo antes de gravar a
  // mensagem, para a conversa já nascer com a mídia. Se não der, `midia`
  // volta nulo e a mensagem entra como antes — o marcador de texto, sem
  // travar nada.
  const midia = temMidia ? await guardarMidiaRecebida({ content, messageid, tipo, canal }) : null;

  // Legenda da foto, ou o nome do documento. Sem nenhum dos dois, um rótulo
  // curto em português: é ele que aparece na prévia da lista de conversas
  // ("Foto" lê melhor que "[ImageMessage]"). O balão esconde esse rótulo, já
  // que a imagem está logo ali — mas a lista precisa de alguma palavra.
  const rotulo = midia
    ? (/^image\//.test(midia.mime) ? "Foto"
      : /^video\//.test(midia.mime) ? "Vídeo"
      : /^audio\//.test(midia.mime) ? "Áudio"
      : midia.nome || "Documento")
    : "";
  const corpo = texto || rotulo || (tipo ? `[${tipo}]` : "[mensagem sem texto]");

  if (temMidia) lembrar({ em: Date.now(), evento, provider, tipo, resultado: midia ? "mídia guardada" : "MÍDIA NÃO BAIXOU — ver log do servidor" });

  /* Eco de um envio do DISPARO que saiu pelo número da casa (ou chegou antes
     do registro). Entra como mensagem do disparo, não de gente: não carimba
     a primeira resposta, não tira o robô, não conta como atendimento. */
  const campanhaDoEco = fromMe ? (ecoDeDisparo(orgId, phone, messageid) || (ehDisparo ? "" : null)) : null;
  const doDisparo = campanhaDoEco !== null;

  /* Número desconhecido = lead novo entrando pelo WhatsApp (services/lead-whatsapp.js).
     SEM TEMPERATURA: quem sabe a temperatura é quem conversou. O lead pode já
     ter nascido enquanto a mídia baixava (a mesma pessoa mandou duas fotos
     seguidas): procura de novo antes de criar. */
  if (!lead) lead = db.prepare("SELECT * FROM leads WHERE phone = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1").get(phone, orgId)
    || nascerLeadDoWhatsapp({ canal, phone, nome });

  /* `from_name` fica vazio numa mensagem enviada pelo celular: o número é
     único e o WhatsApp não diz qual corretor digitou. A tela mostra
     "enviada pelo WhatsApp" — melhor um autor honesto em branco do que
     assinar com o nome errado. */
  /* O MESMO ID EM DOIS FORMATOS (25/09/2026). A uazapiGO dá a cada mensagem
     um `messageid` (o id do WhatsApp) e um `id` com o número da instância
     na frente ("5587…:3EB0…"). O que ficou guardado em `wa_id` e o que chega
     como citação podem estar cada um num formato — comparar só igual com
     igual deixava a resposta solta mesmo com os dois ids "certos". Compara
     também a parte depois dos dois-pontos, nos dois sentidos. */
  const curto = citada ? String(citada).split(":").pop() : "";
  const citadaLocal = citada
    ? (db.prepare(`SELECT id FROM messages WHERE lead_id = ? AND wa_id IS NOT NULL
        AND (wa_id = ? OR wa_id = ? OR wa_id LIKE ?) ORDER BY created_at DESC LIMIT 1`)
        .get(lead.id, citada, curto, "%:" + curto) || {}).id || null
    : null;
  // Sem a mensagem no CRM, guarda ao menos o texto que o WhatsApp mandou.
  const trechoReserva = !citadaLocal && citadaTrecho ? String(citadaTrecho).slice(0, 500) : null;
  /* O CAMPO FOI RECONHECIDO, MAS NÃO ACHOU A MENSAGEM. (17/09/2026)

     Duas causas possíveis, e são diferentes: (1) a mensagem citada é de
     ANTES de 08/08/2026, quando `wa_id` começou a ser gravado — aí não tem
     conserto, é limitação conhecida; (2) a mensagem citada foi ENVIADA por
     este CRM e a resposta da Uazapi para aquele envio não trouxe nenhum id
     reconhecido (ver `envioSemIdDiagnostico` em services/uazapi.js) — aí
     `wa_id` nunca foi gravado nela, e citar essa mensagem específica nunca
     vai casar. Registrar os dois lados (achou o id do WhatsApp, não achou
     a mensagem local) é o que separa "não reconheci o campo" de "reconheci
     o campo, mas o alvo nunca teve o dele guardado". */
  /* Sem id do WhatsApp não há como a trava do id pegar a entrega repetida:
     a mesma mensagem, igual, do mesmo cliente, no último minuto, é ela de novo. */
  if (!fromMe && !messageid && db.prepare(`SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'in'
      AND body = ? AND created_at > ? LIMIT 1`).get(lead.id, corpo, Date.now() - 60000))
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: a mesma mensagem, sem id, chegou duas vezes" });

  if (citada && !citadaLocal && !trechoReserva)
    lembrar({ em: Date.now(), evento, provider, resultado: "AVISO: a mensagem cita outra, mas nenhuma mensagem desta conversa tem esse id do WhatsApp guardado (mensagem antiga sem wa_id, ou o envio dela nunca recebeu id — ver 'envio_sem_id' em /integracoes)" });

  /* A CORRIDA DA MÍDIA (22/09/2026, relatado pelo Ali: mensagem duplicada
     no CRM, o cliente recebeu uma vez só). Entre o SELECT de eco lá em
     cima e este INSERT existe um `await` de verdade quando há mídia (o
     download do arquivo) — tempo suficiente para a Uazapi reentregar o
     MESMO evento e o segundo webhook rodar o próprio SELECT antes deste
     primeiro terminar de inserir. Os dois SELECTs vêm vazios; sem uma
     trava no BANCO, os dois inseriam.

     O índice único em `wa_id` (db.js) é essa trava. Se ele recusar,
     perdemos a corrida — não é erro, é a prova de que o eco de verdade
     já está gravado por um webhook irmão que chegou primeiro. */
  try {
    db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,wa_id,reply_to,reply_trecho,created_at,canal_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, fromMe ? "out" : "in", null,
        // Saiu do número de disparo sem passar pelo CRM: é o eco de um envio
        // do próprio disparo que chegou antes do registro dele.
        doDisparo ? (campanhaDoEco ? `${ROTULO_DISPARO} · ${campanhaDoEco}` : ROTULO_DISPARO) : null, corpo,
        midia?.url || null, midia?.mime || null, midia?.nome || null, messageid || null, citadaLocal, trechoReserva, Date.now(),
        /* NULO É A LINHA DA CASA, aqui como em `leads.canal_id`. Uma
           convenção só nas duas colunas. */
        linhaDaConversa);
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed.*wa_id/i.test(e.message)) {
      return lembrar({ em: Date.now(), evento, provider, resultado:
        "ignorado: eco reentregue pela Uazapi (mesmo wa_id de uma mensagem já gravada — perdeu a corrida do índice único)" });
    }
    throw e;
  }

  /* "SAIR" de quem está numa lista de marketing entra na lista de bloqueio da
     imobiliária (services/marketing.js). A conversa segue normal — isto só
     impede disparos futuros —, e a função nunca lança. */
  if (!fromMe) registrarPedidoDeSaida(orgId, lead.phone || phone, texto);

  /* Resposta a um disparo em massa: liga ao lead o que o disparo já tinha
     mandado e faz o fluxo seguir pelo caminho da resposta (services/disparo.js).
     Nunca lança. */
  if (!fromMe) respostaAoDisparo({ orgId, lead, texto: corpo });

  /* A CONVERSA PASSA A ACONTECER NA LINHA QUE O CLIENTE USOU.

     O cliente escreve para o número que ele tem salvo — se o CRM responder
     por outro, a resposta chega no celular dele como mensagem de um
     desconhecido, fora da conversa que ele estava tendo. */
  const canalAtual = lead.canal_id || null;
  const canalNovo = linhaDaConversa;
  if (canalAtual !== canalNovo) {
    db.prepare("UPDATE leads SET canal_id = ? WHERE id = ?").run(canalNovo, lead.id);
    lead.canal_id = canalNovo;
    console.log(`[mensageria] ${lead.name} agora fala pela linha ${canalNovo ? canal.nome : "da imobiliária"}`);
  }

  // Respondeu pelo celular? Continua sendo a primeira resposta — sem isto o
  // relatório contaria como "nunca atendido" quem atendeu fora do CRM.
  // (Só acontece na Uazapi — na Meta, `fromMe` nunca é true.)
  if (fromMe && !doDisparo && !lead.first_resp_at)
    db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(Date.now(), lead.id);

  // Cliente voltou a falar: atendimento finalizado reabre sozinho, senão a
  // mensagem cairia numa conversa escondida e ninguém responderia.
  if (lead.closed_at) {
    db.prepare("UPDATE leads SET closed_at = NULL WHERE id = ?").run(lead.id);
    console.log(`[mensageria] atendimento de ${lead.name} reaberto: o cliente respondeu`);
  }

  /* O funil NÃO anda enquanto o robô está atendendo — a regra da
     palavra-chave lê a conversa inteira, e bastaria o cliente escrever
     "quero agendar" às 3h da manhã para o lead amanhecer em Agendamento
     sem ninguém ter agendado nada. */
  const roboFalando = lead.robo_msgs > 0 && !lead.robo_parado;
  if (!roboFalando) advanceStage(lead.id);

  // Mensagem que saiu do celular é gente atendendo: o robô sai da conversa.
  if (fromMe && !doDisparo) pararPorGente(lead.id);

  // Aviso no celular de quem está com o lead.
  if (lead.assigned_to && !fromMe) {
    const resumo = corpo.length > 90 ? corpo.slice(0, 90) + "…" : corpo;
    avisar(lead.assigned_to, ehNovo
      ? { titulo: "Novo lead no WhatsApp", corpo: `${lead.name} acabou de chamar. Responda agora — os primeiros minutos decidem.`, leadId: lead.id }
      : { titulo: `${lead.name} respondeu`, corpo: resumo, leadId: lead.id });
  }

  lembrar({ em: Date.now(), evento, provider, resultado: fromMe ? "ok (enviada pelo celular)" : "ok", lead: lead.name, tipo });
  console.log(`[mensageria] mensagem ${fromMe ? "enviada pelo celular para" : "recebida de"} ${lead.name} (${provider})`);

  /* Primeiro atendimento automático, fora do expediente.

     SEM `await`, e é o ponto mais importante desta função. A resposta da IA
     leva alguns segundos; o webhook tem que responder na hora — se ele
     demorar, o provedor desiste de chamar de novo, e o CRM PARA DE RECEBER
     LEAD, que é o pior estrago possível aqui e já aconteceu uma vez por
     outro motivo. `atender` nunca lança: erro dele vira log, nunca derruba
     o processo. */
  if (!fromMe) atender(orgId, lead.id);
  }
}
