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

import { randomUUID } from "crypto";
import db from "../db.js";
import { proximoAtendente } from "./catraca.js";
import { entradaDe } from "./pipelines.js";
import { guardarMidiaRecebida } from "./midia.js";
import { atender, pararPorGente } from "./robo.js";
import { avisar } from "./push.js";
import { advanceStage } from "../routes/messages.routes.js";
import { mascararTelefone } from "../seguranca.js";

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
export async function processarMensagemRecebida({ canal, evento, phone, texto, tipo, content, temMidia, fromMe, citada, messageid, nome }) {
  const orgId = canal.org_id;
  const ehPessoal = canal.tipo === "corretor";
  const provider = canal.provider || "uazapi";

  /* Mensagem que o CRM mandou volta como webhook. Ela já está na conversa —
     gravar de novo seria a mesma mensagem duas vezes. O `wa_id` é o que
     diferencia isso do corretor digitando no celular (só acontece na
     Uazapi; na Meta `fromMe` nunca é true, então este `if` nunca dispara
     ali — e não precisa disparar, porque o resto da função segue igual). */
  if (fromMe && messageid && db.prepare(`SELECT 1 FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.wa_id = ? AND l.org_id = ?`).get(messageid, orgId))
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: eco da mensagem enviada pelo próprio CRM" });

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

  let lead = db.prepare("SELECT * FROM leads WHERE phone = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1").get(phone, orgId);
  const ehNovo = !lead;

  /* Saiu do celular para um número que ainda não é lead: não cria lead.
     O número da imobiliária também fala com colega, fornecedor e parente —
     e cada uma dessas conversas viraria um lead na fila da atendente.
     Quando for cliente de verdade, ele responde, e aí o lead nasce pelo
     caminho normal, na regra da catraca. (Só acontece na Uazapi.) */
  if (!lead && fromMe)
    return lembrar({ em: Date.now(), evento, provider, resultado: "ignorado: enviada para um número que ainda não é lead" });

  /* Número desconhecido = lead novo entrando pelo WhatsApp. Vai direto para
     a atendente da vez, exatamente como um lead vindo da Meta Lead Ads.

     SEM TEMPERATURA. Todo lead do WhatsApp nascia "MORNO", e isso não era
     leitura de nada — era o padrão da coluna. Lead sem temperatura é
     honesto: quem sabe a temperatura é quem conversou. */
  if (!lead) {
    const id = "l_" + randomUUID();
    /* LEAD QUE CHEGA NUMA LINHA PESSOAL JÁ NASCE DO DONO DA LINHA.

       A catraca das atendentes existe para repartir o que chega no número
       da CASA, que é de todo mundo e de ninguém. O cliente que escreveu
       para o número da Marina escolheu a Marina — sortear esse lead para
       outra pessoa seria o CRM desfazendo uma decisão do cliente. */
    const dono = ehPessoal ? canal.user_id : proximoAtendente(orgId);
    /* O FUNIL DE ENTRADA É O DE QUEM RECEBE, e não o padrão da casa. Os
       leads que caem na atendente pertencem ao funil de pré-atendimento;
       os do corretor, ao comercial. */
    const entrada = entradaDe(orgId, dono);
    const quando = Date.now();
    db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,qual_json,stage,assigned_to,created_at,
                pipeline_id,stage_id,stage_entered_at,last_interaction_at,source,canal_id,assigned_at)
      VALUES (?,?,?,?,'WhatsApp',NULL,'{}',?,?,?, ?,?,?,?, 'whatsapp',?,?)`)
      .run(id, orgId, nome || "Contato do WhatsApp", phone, entrada.nome, dono, quando,
           entrada.pipeline_id, entrada.stage_id, quando, quando,
           ehPessoal ? canal.id : null, dono ? quando : null);
    lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
    console.log(`[mensageria] lead NOVO pelo WhatsApp/${provider} (${mascararTelefone(phone)}) — ${
      ehPessoal ? `chegou no número pessoal de ${canal.nome}` :
      dono ? "para a atendente da vez" : "sem atendente cadastrado, foi para a fila"}`);
  }

  /* `from_name` fica vazio numa mensagem enviada pelo celular: o número é
     único e o WhatsApp não diz qual corretor digitou. A tela mostra
     "enviada pelo WhatsApp" — melhor um autor honesto em branco do que
     assinar com o nome errado. */
  const citadaLocal = citada
    ? (db.prepare("SELECT id FROM messages WHERE wa_id = ? AND lead_id = ?").get(citada, lead.id) || {}).id || null
    : null;

  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,wa_id,reply_to,created_at,canal_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, fromMe ? "out" : "in", null, null, corpo,
      midia?.url || null, midia?.mime || null, midia?.nome || null, messageid || null, citadaLocal, Date.now(),
      /* NULO É A LINHA DA CASA, aqui como em `leads.canal_id`. Uma
         convenção só nas duas colunas. */
      canal.tipo === "corretor" ? canal.id : null);

  /* A CONVERSA PASSA A ACONTECER NA LINHA QUE O CLIENTE USOU.

     O cliente escreve para o número que ele tem salvo — se o CRM responder
     por outro, a resposta chega no celular dele como mensagem de um
     desconhecido, fora da conversa que ele estava tendo. */
  const canalAtual = lead.canal_id || null;
  const canalNovo = canal.tipo === "corretor" ? canal.id : null;
  if (canalAtual !== canalNovo) {
    db.prepare("UPDATE leads SET canal_id = ? WHERE id = ?").run(canalNovo, lead.id);
    lead.canal_id = canalNovo;
    console.log(`[mensageria] ${lead.name} agora fala pela linha ${canalNovo ? canal.nome : "da imobiliária"}`);
  }

  // Respondeu pelo celular? Continua sendo a primeira resposta — sem isto o
  // relatório contaria como "nunca atendido" quem atendeu fora do CRM.
  // (Só acontece na Uazapi — na Meta, `fromMe` nunca é true.)
  if (fromMe && !lead.first_resp_at)
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
  if (fromMe) pararPorGente(lead.id);

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
