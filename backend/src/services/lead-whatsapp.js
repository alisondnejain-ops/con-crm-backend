/* ===== O LEAD QUE NASCE DE UMA CONVERSA DE WHATSAPP =====

   Morava inteiro dentro de `processarMensagemRecebida` (services/mensageria.js).
   Saiu para cá em 03/10/2026 porque passou a ter DOIS caminhos de nascimento:
   a mensagem que chega de um número desconhecido (como sempre) e o "É lead"
   da triagem de números novos (services/triagem.js). Duas cópias da regra de
   quem recebe o lead e em que funil ele nasce iam divergir — é a armadilha
   que este projeto já documentou com as seis rotas de repasse. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { proximoAtendente } from "./catraca.js";
import { entradaDe } from "./pipelines.js";
import { campanhaQueAlcancou } from "./disparo.js";
import { mascararTelefone } from "../seguranca.js";
import { dispararGatilho } from "./automacoes.js";

export function nascerLeadDoWhatsapp({ canal, phone, nome, quando = Date.now() }) {
  const orgId = canal.org_id;
  const ehPessoal = canal.tipo === "corretor";
  const ehDisparo = canal.tipo === "disparo";
  // Nula é a linha da casa — a mesma convenção de `leads.canal_id` em todo o sistema.
  const linhaDaConversa = canal.tipo === "imobiliaria" ? null : canal.id;
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
  /* Respondeu a um disparo: origem "Disparo" E a campanha gravada, como o
     lead da Meta vem com a campanha do anúncio. É o que põe este lead na
     linha certa de Operação → Campanhas e nos filtros de campanha. */
  const campanha = campanhaQueAlcancou(orgId, phone);
  const veioDoDisparo = ehDisparo || !!campanha;
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,qual_json,stage,assigned_to,created_at,
              pipeline_id,stage_id,stage_entered_at,last_interaction_at,source,canal_id,assigned_at,platform,campaign_name)
    VALUES (?,?,?,?,?,NULL,'{}',?,?,?, ?,?,?,?, 'whatsapp',?,?,?,?)`)
    .run(id, orgId, nome || "Contato do WhatsApp", phone, veioDoDisparo ? "Disparo" : "WhatsApp", entrada.nome, dono, quando,
         entrada.pipeline_id, entrada.stage_id, quando, quando,
         linhaDaConversa, dono ? quando : null, veioDoDisparo ? "disparo" : null, campanha);
  console.log(`[mensageria] lead NOVO pelo WhatsApp/${canal.provider || "uazapi"} (${mascararTelefone(phone)}) — ${
    ehPessoal ? `chegou no número pessoal de ${canal.nome}` :
    ehDisparo ? "respondeu a um disparo — foi para a atendente da vez" :
    dono ? "para a atendente da vez" : "sem atendente ativa — ficou na fila do SDR (a IA cobre, se estiver ligada)"}`);
  // Quem nasce respondendo a um disparo já está num fluxo: não entra no "lead novo".
  if (!veioDoDisparo) dispararGatilho(orgId, "lead_novo", { leadId: id, origem: "whatsapp" });
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
}
