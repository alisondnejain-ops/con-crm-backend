import "dotenv/config";
import "./tz.js";   // fuso da operação — antes de qualquer conta com data
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.routes.js";
import leadsRoutes from "./routes/leads.routes.js";
import distRoutes from "./routes/distribution.routes.js";
import msgRoutes from "./routes/messages.routes.js";
import metaWebhook from "./routes/meta.webhook.js";
import uazapiWebhook from "./routes/uazapi.webhook.js";
import pushRoutes from "./routes/push.routes.js";
import assinaturaRoutes from "./routes/assinatura.routes.js";
import diagRoutes from "./routes/diag.routes.js";
import reportsRoutes from "./routes/reports.routes.js";
import produtosRoutes from "./routes/produtos.routes.js";
import { pastaLocal, modoArmazenamento, conferirR2 } from "./services/storage.js";
import { ambienteConfere } from "./services/asaas.js";
import { mailConfigured } from "./services/mail.js";
import { uazapiConfigured } from "./services/uazapi.js";
import { bootstrap } from "./bootstrap.js";
import { authRequired } from "./auth.js";
import { porteiro } from "./services/assinatura.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
// 30mb porque as fotos e vídeos dos imóveis sobem em base64 no corpo da requisição.
app.use(express.json({ limit: "30mb" }));

// Três vezes hoje a gente perdeu tempo sem saber se o servidor já estava
// rodando o código novo ou ainda o antigo. A lista de recursos responde isso
// em cinco segundos, sem precisar do painel da hospedagem: se o recurso não
// está aqui, o deploy não chegou — não adianta procurar erro na tela.
const NO_AR_DESDE = Date.now();
const RECURSOS = [
  "catraca-atendentes",   // lead novo cai direto na atendente da vez
  "finalizar-conversa",   // botões Finalizar / Marcar como lida
  "midia-recebida",       // foto, áudio e documento do cliente aparecem no chat
  "anexos-enviados",      // clipe: fotos, vídeo, áudio gravado
  "localizacao",          // envio do ponto no mapa
  "push",                 // notificação no celular
  "score",                // ranking e recomendação de direcionamento
  "base-leads",           // exportação e importação da base
  "simulacoes",           // simulação de financiamento na ficha do lead
  "assinatura",           // mensalidade e bloqueio por atraso (Asaas)
  "conferencia-r2",       // /integracoes aponta qual variável do R2 está errada
  "pagamentos",           // histórico da mensalidade: apagar, corrigir, reorganizar
  "titular-assinatura",   // mensalidade só para o dono da conta
  "importacao-em-lote",   // conferir antes de subir e desfazer a lista inteira
  "gestor-master",        // dono da plataforma, invisivel para a equipe da imobiliaria
];
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "con-crm",
  versao: (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || "desconhecida",
  no_ar_desde: new Date(NO_AR_DESDE).toISOString(),
  recursos: RECURSOS,
}));

// Páginas públicas do cadastro (servidas pelo próprio backend, para o link ser um só).
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir, { extensions: ["html"] }));
app.get("/", (_req, res) => res.redirect("/cadastro"));
app.get("/cadastro", (_req, res) => res.sendFile(path.join(publicDir, "cadastro.html")));
app.get("/definir-senha", (_req, res) => res.sendFile(path.join(publicDir, "definir-senha.html")));

/* Assinatura e webhook do Asaas entram ANTES do porteiro: é esta rota que
   desenha a tela de bloqueio e é por este webhook que o desbloqueio chega.
   Trancá-las junto seria trancar a chave do lado de dentro. */
app.use("/", assinaturaRoutes);

app.use("/auth", authRoutes);
/* Porteiro da mensalidade. Fica só nas rotas de TRABALHO.

   Precisa rodar DEPOIS da autenticação: sem saber quem é o usuário, não há
   como saber de qual imobiliária é a cobrança — e ele deixava tudo passar.
   Por isso autentica aqui antes de conferir.

   De fora, de propósito: os webhooks da Meta e da Uazapi (lead que chega
   bloqueado e não é gravado está perdido para sempre) e /leads/export
   (bloquear alguém dos próprios dados de clientes é problema jurídico). */
const cobrando = (req, res, next) => authRequired(req, res, () => porteiro(req, res, next));

app.use("/leads", (req, res, next) => (req.path === "/export" ? next() : cobrando(req, res, next)));
app.use("/leads", leadsRoutes);
app.use("/distribution", cobrando, distRoutes);
app.use("/reports", cobrando, reportsRoutes);
app.use("/produtos", cobrando, produtosRoutes);
// Fotos e vídeos dos imóveis enquanto o armazenamento é o disco da hospedagem.
// Com o Cloudflare R2 ligado, as URLs passam a apontar direto para lá e esta
// rota deixa de ser usada sozinha.
app.use("/arquivos", express.static(pastaLocal(), { maxAge: "7d" }));
// Montado no mesmo prefixo de leadsRoutes — os dois routers se completam.
// Antes ficava em "/", e como ele exige login, bloqueava toda rota registrada depois.
app.use("/leads", msgRoutes);         // POST /leads/:id/messages
app.use("/webhooks", metaWebhook);    // GET/POST /webhooks/meta
app.use("/webhooks", uazapiWebhook);  // POST /webhooks/uazapi
app.use("/", pushRoutes);        // GET /push/chave, POST /push/inscrever
app.use("/", diagRoutes);             // GET /integracoes

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  const org = bootstrap();
  const base = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
  console.log(`Con CRM backend rodando — org: ${org.name}`);
  console.log(`Link de cadastro dos corretores: ${base}/cadastro?c=${org.adm_code}`);
  if (!mailConfigured()) console.log("Atenção: e-mail não configurado (RESEND_API_KEY/MAIL_FROM). Os links de confirmação vão aparecer aqui no log.");
  console.log(`WhatsApp (Uazapi): ${uazapiConfigured() ? "configurado" : "NÃO configurado — defina UAZAPI_HOST e UAZAPI_TOKEN"}`);
  console.log(`Fotos e vídeos dos imóveis: ${modoArmazenamento()}`);
  // Erro de digitação nas variáveis é o que mais trava a instalação, e o erro
  // que Cloudflare e Asaas devolvem não diz qual campo está errado. Aqui diz.
  const r2 = conferirR2();
  // Só reclama de quem tentou ligar o R2. Quem roda no disco não preencheu
  // nada de propósito, e não precisa ver cinco linhas de "está vazia".
  if (Object.values(r2.campos).some(v => v === "preenchida"))
    for (const p of r2.problemas) console.log(`Atenção (R2): ${p}`);
  const asaas = ambienteConfere();
  if (asaas) console.log(`Atenção (Asaas): ${asaas}`);
  console.log(`Diagnóstico das integrações: ${base}/integracoes`);
});
