import { Router } from "express";
import crypto, { randomUUID } from "crypto";
import { segredoConfere, mascararTelefone } from "../seguranca.js";
import db from "../db.js";
import { fetchLead } from "../services/meta.js";
import { normalizePhone } from "../services/stages.js";
import { proximoAtendente } from "../services/catraca.js";
import { entradaDe } from "../services/pipelines.js";

const r = Router();

// 1) Verificação do webhook (a Meta chama com GET ao configurar).
r.get("/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

/* A META ASSINA O QUE MANDA — e a gente passou a conferir. (02/09/2026)

   Esta rota não tinha conferência nenhuma: qualquer pessoa podia mandar um
   POST fingindo ser a Meta. O estrago era limitado porque o passo seguinte é
   buscar o lead na Graph API com o nosso token, e um `leadgen_id` inventado
   não existe lá — mas "limitado" é diferente de "nenhum": dava para fazer o
   servidor martelar a Graph API à vontade, de graça, até a Meta nos limitar.

   A conferência é a que a Meta documenta: ela assina o corpo da requisição com
   o segredo do app (`META_APP_SECRET`) e manda o resultado em
   `x-hub-signature-256`. Só quem tem o segredo consegue produzir a assinatura.

   Sem o segredo configurado a rota CONTINUA aceitando, e aqui a decisão é o
   contrário da do Asaas — de propósito. Lá, aceitar sem conferir liberava
   dinheiro; aqui, recusar sem conferir faz PARAR DE ENTRAR LEAD, que é a falha
   mais cara deste sistema e a que ninguém percebe. Então o padrão erra para o
   lado de receber, e o `/integracoes` avisa em letras claras que a conferência
   está desligada. */
function assinaturaConfere(req) {
  const segredo = process.env.META_APP_SECRET;
  if (!segredo) return true;                       // ver o parágrafo acima
  const veio = String(req.get("x-hub-signature-256") || "");
  if (!veio.startsWith("sha256=")) return false;
  /* O corpo já foi transformado em objeto pelo express.json, e a assinatura é
     sobre os BYTES originais. `JSON.stringify` reproduz o texto da Meta na
     prática (ela manda JSON compacto), e se um dia deixar de reproduzir, o
     sintoma é a recusa — visível em `/integracoes`, não silenciosa. */
  const esperado = "sha256=" + crypto.createHmac("sha256", segredo)
    .update(JSON.stringify(req.body || {})).digest("hex");
  return segredoConfere(veio, esperado);
}

// 2) Recebimento em tempo real. Cada novo lead cai na fila da catraca (assigned_to = NULL).
r.post("/meta", async (req, res) => {
  if (!assinaturaConfere(req)) {
    console.warn("[meta] webhook recusado: assinatura não confere (confira META_APP_SECRET)");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rápido; processa depois
  try {
    const org = db.prepare("SELECT * FROM orgs LIMIT 1").get(); // 1 org (Conecta) neste MVP
    if (!org) return;
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value.leadgen_id;
        try {
          const info = await fetchLead(leadgenId);
          const phone = normalizePhone(info.phone);
          const dup = db.prepare("SELECT 1 FROM leads WHERE org_id = ? AND (meta_lead_id = ? OR phone = ?)").get(org.id, info.meta_lead_id, phone);
          if (dup) continue;
          const dono = proximoAtendente(org.id);
          /* Nasce SEM temperatura, como o lead do WhatsApp (14/08/2026).

             Aqui havia uma nota de corte sobre as respostas do formulário
             (renda, entrada, prazo) que devolvia QUENTE / MORNO / FRIO. As
             respostas são reais e continuam na ficha, em `qual_json` — o que
             saiu foi transformá-las em temperatura sozinha. A régua do meio
             devolvia "MORNO" para quase todo mundo, e era esse morno de
             ninguém que enchia o funil e que o Ali mandou tirar.

             Temperatura agora tem uma origem só: alguém a colocou — o corretor
             na ficha, ou a IA na análise por corretor que o gestor pediu. */
          /* O lead nasce JA dentro de um pipeline. Antes a etapa era a
             palavra 'Lead' escrita aqui, e isso presumia que toda imobiliaria
             tem uma etapa com esse nome — o que deixou de ser verdade no dia
             em que o funil virou configuravel. Agora o destino e a primeira
             etapa do pipeline padrao da casa, seja ela qual for.

             E desde 01/09/2026 o funil e o de QUEM RECEBE: os leads que caem
             na atendente pertencem ao funil de pre-atendimento, e os do
             corretor ao comercial. Quem nao configurou nada segue no padrao. */
          const entrada = entradaDe(org.id, dono);
          const agora = Date.now();
          db.prepare(`INSERT INTO leads
            (id,org_id,name,phone,email,origem,priority,qual_json,stage,assigned_to,created_at,
             pipeline_id,stage_id,stage_entered_at,
             source,platform,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,form_id,form_name)
            VALUES (?,?,?,?,?,?,NULL,?,?,?,?, ?,?,?, ?,?,?,?,?,?,?,?,?,?)`).run(
            "l_" + randomUUID(), org.id, info.name, phone, info.email, "Meta Ads",
            JSON.stringify(info.qual), entrada.nome, dono, agora,
            entrada.pipeline_id, entrada.stage_id, agora,
            info.source || "meta", info.platform, info.campaign_id, info.campaign_name,
            info.adset_id, info.adset_name, info.ad_id, info.ad_name, info.form_id, info.form_name
          );
          if (info.campaign_name) console.log(`[meta] campanha: ${info.campaign_name} · anúncio: ${info.ad_name || "—"}`);
          console.log("[meta] novo lead entrou", mascararTelefone(phone), dono ? "— para a atendente da vez" : "— sem atendente, foi para a fila");
        } catch (e) {
          console.error("[meta] erro ao buscar lead", leadgenId, e.message);
        }
      }
    }
  } catch (e) {
    console.error("[meta] webhook erro:", e.message);
  }
});

export default r;
