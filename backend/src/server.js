import "dotenv/config";
import "./tz.js";   // fuso da operação — antes de qualquer conta com data
import express from "express";
import cors from "cors";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.routes.js";
import leadsRoutes from "./routes/leads.routes.js";
import distRoutes from "./routes/distribution.routes.js";
import msgRoutes from "./routes/messages.routes.js";
import tarefasRoutes, { tarefasPorId } from "./routes/tarefas.routes.js";
import metaWebhook from "./routes/meta.webhook.js";
import uazapiWebhook from "./routes/uazapi.webhook.js";
import pushRoutes from "./routes/push.routes.js";
import assinaturaRoutes from "./routes/assinatura.routes.js";
import diagRoutes from "./routes/diag.routes.js";
import reportsRoutes from "./routes/reports.routes.js";
import produtosRoutes from "./routes/produtos.routes.js";
import pipelinesRoutes from "./routes/pipelines.routes.js";
import canaisRoutes from "./routes/canais.routes.js";
import publicoRoutes from "./routes/publico.routes.js";
import painelRoutes from "./routes/painel.routes.js";
import orgsRoutes, { fundoDoLogin } from "./routes/orgs.routes.js";
import plantaoRoutes from "./routes/plantao.routes.js";
import configRoutes from "./routes/config.routes.js";
import { pastaLocal, modoArmazenamento, conferirR2 } from "./services/storage.js";
import { ambienteConfere } from "./services/asaas.js";
import { mailConfigured } from "./services/mail.js";
import { uazapiConfigured } from "./services/uazapi.js";
import { bootstrap } from "./bootstrap.js";
import { authRequired } from "./auth.js";
import { porteiro } from "./services/assinatura.js";
import { agendarCorte } from "./services/expediente.js";
import { backupSePassouDaHora } from "./services/backup.js";
import { avisarPlantaoEmTodas } from "./services/plantao.js";
import { avisarSemRespostaEmTodas } from "./services/alerta.js";

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
  "hub-de-contas",        // o master escolhe em qual imobiliaria vai trabalhar
  "expediente",           // prontidao cai no fim do dia + historico de disponibilidade
  "ponto-atendente",      // a chave da atendente vira registro de ponto, com relatorio
  "crm-no-backend",       // o proprio servidor entrega o CRM (raiz e /app)
  "plantao",              // escala de plantao, lembrete no painel e aviso as 08:00
  "escala-xlsx",          // sobe a escala direto da planilha do Excel (.xlsx)
  "plantao-no-relatorio", // leads por dia + escala e prontidao no relatorio individual
  "escala-apagar",        // apagar a escala do mes inteiro pela tela
  "filtro-por-dia",       // leads por dia abre num dia so; historico conta dia de calendario
  "etapa-por-palavra",    // o funil so anda quando a palavra da etapa e dita na conversa
  "reanalise-funil",      // passa a regra nova nos leads que ja existem (conferir e aplicar)
  "catraca-do-gestor",    // o gestor enxerga a catraca, como a atendente
  "alerta-sem-resposta",  // avisa o corretor e deixa a gestao cutucar o atendimento parado
  "responder-mensagem",   // citar uma mensagem especifica, como o Responder do WhatsApp
  "editar-mensagem",      // editar em ate 15 min, e so se a Uazapi editar de verdade
  "link-nova-senha",      // gestor gera link de redefinicao, sem depender de e-mail
  "lead-clicavel",        // base de leads e relatorio abrem a conversa no clique
  "venda-por-data",       // KPI de venda conta pela data da venda, nao pela entrada do lead
  "sugestao-da-semana",   // recomendacao sai do desempenho da semana entre os 5 melhores
  "previa-da-colagem",    // imagem colada aparece antes de ir para o cliente
  "resultado-da-ligacao", // popup depois de ligar: o que aconteceu na chamada
  "configuracoes",        // aba Configuracoes: mensagens automaticas + conexao
];
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "con-crm",
  versao: (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || "desconhecida",
  no_ar_desde: new Date(NO_AR_DESDE).toISOString(),
  recursos: RECURSOS,
}));

// Onde ficam as páginas servidas pelo próprio backend: o CRM, o cadastro e a
// página de definir senha. Declarado aqui porque tudo abaixo depende dele.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/* O CRM servido pelo próprio backend, em /app.

   Rota de fuga: o site tem domínio e hospedagem próprios (Cloudflare), mas
   quando aquela publicação falha a equipe fica com a tela antiga e o servidor
   novo — e nada funciona. Aqui a tela vem do mesmo deploy que o servidor,
   então as duas pontas nunca ficam em versões diferentes.

   ANTES do express.static de propósito: o static responderia primeiro (ele
   resolve /app -> app.html pela opção `extensions`) e aplicaria o cache dele.
   E cache é exatamente o que esta rota existe para não ter — `cacheControl:
   false` porque o sendFile sobrescreve o cabeçalho se a gente não desligar. */
const semCache = { cacheControl: false, headers: { "Cache-Control": "no-store" } };

/* Servido daqui, o CRM precisa falar com ESTE servidor.

   O arquivo publicado no site aponta para o endereco fixo do backend, o que e
   certo la (origens diferentes). Aqui a origem e a mesma, entao injetamos o
   endereco na hora: sem isso a tela abria e o login dava "sem conexao com o
   servidor", porque ela procurava a API do lado de fora.

   Como bonus, some o CORS: mesma origem para tela e API. */
/* A pagina pronta fica guardada por endereco. Sem isto, cada abertura criava
   uma copia de 400 KB do arquivo so para injetar uma linha — 1000 aberturas
   somavam 20 MB de lixo esperando o coletor. Sao poucos enderecos (o do
   Railway e, quando houver, o dominio proprio), entao o mapa nao cresce. */
const paginaApp = new Map();
/* Vale para o CRM E para as páginas públicas (cadastro, definir senha).

   Elas traziam o endereço do backend escrito no código, com o do Railway como
   padrão. Enquanto a produção FOR o Railway isso funciona por coincidência —
   mas o link de cadastro ou de nova senha aberto por qualquer outro endereço
   (domínio próprio, teste local) ia falar com o servidor errado e dizer que o
   link é inválido. Servidas daqui, elas passam a falar com quem as entregou. */
function servirPagina(arquivo, req, res, erroSeFaltar) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const chave = `${arquivo}|${base}`;
  try {
    if (!paginaApp.has(chave)) {
      const bruto = readFileSync(path.join(publicDir, arquivo), "utf8");
      paginaApp.set(chave, bruto.replace("<script>",
        `<script>window.CON_CRM_API=${JSON.stringify(base)}</script>\n<script>`));
    }
    res.set("Cache-Control", "no-store").type("html").send(paginaApp.get(chave));
  } catch (e) {
    res.status(404).send(erroSeFaltar);
  }
}
const servirApp = (req, res) => servirPagina("app.html", req, res, "O CRM ainda nao foi publicado neste servidor.");
app.get(["/app", "/app.html"], servirApp);
// Qual versão do CRM este servidor está entregando.
app.get("/versao.txt", (_req, res) =>
  res.type("text/plain").sendFile(path.join(publicDir, "versao.txt"), semCache));

/* ANTES do express.static, pelo mesmo motivo do /app: com `extensions:
   ["html"]` o static resolve /definir-senha -> definir-senha.html e responde
   primeiro, servindo o arquivo cru — sem o endereco do servidor injetado. Foi
   o que fez o link de nova senha dizer "link invalido" fora da producao. */
app.get("/cadastro", (req, res) => servirPagina("cadastro.html", req, res, "Pagina de cadastro nao encontrada."));
app.get("/definir-senha", (req, res) => servirPagina("definir-senha.html", req, res, "Pagina de senha nao encontrada."));
/* A porta do DONO de imobiliária. O corretor entra pelo /cadastro com o código
   da casa dele no link; quem ainda não tem casa vem por aqui e sai com o
   código na mão. Dois endereços porque são duas pessoas diferentes. */
const paginaImobiliaria = (req, res) => servirPagina("criar-imobiliaria.html", req, res, "Pagina de cadastro da imobiliaria nao encontrada.");
app.get("/criar-imobiliaria", paginaImobiliaria);
// Apelido curto: é o que cabe num card de anúncio e o que as pessoas chutam.
app.get("/nova-imobiliaria", paginaImobiliaria);

/* A PORTA DO CORRETOR AUTÔNOMO — o botão "Testar 14 dias grátis" do site.

   Ela existe como PÁGINA, e não como um formulário dentro do site de vendas,
   por um motivo prático que vale mais do que parece: assim o botão do site é
   um link simples (`href`), sem código, sem chave de API, sem CORS. O dia em
   que o texto do cadastro mudar, muda aqui — sem tocar no site, sem depender
   de crédito de ferramenta nenhuma.

   Três endereços para a mesma página porque são três palpites de gente: o que
   escrevo no anúncio, o que a pessoa digita e o que o site linka. */
const paginaComecar = (req, res) => servirPagina("comecar.html", req, res, "Pagina de cadastro nao encontrada.");
app.get("/comecar", paginaComecar);
app.get("/teste-gratis", paginaComecar);
app.get("/sou-corretor", paginaComecar);

/* A FOTO DA TELA DE ENTRADA, sem exigir login.

   O CSS do login pede `/login-fundo.jpg` e a tela é desenhada antes de existir
   sessão — então este caminho precisa responder para qualquer visitante. O
   arquivo em si vive no armazenamento (R2 ou disco), como as fotos dos
   imóveis: aqui só redirecionamos para ele.

   Sem foto escolhida a resposta é 404, e o navegador simplesmente não pinta a
   camada — o verde profundo que está embaixo continua ali. É por isso que a
   tela de entrada nunca depende deste arquivo existir.

   Fica ANTES do express.static de propósito: se um dia alguém puser um
   login-fundo.jpg dentro de public/, o static responderia primeiro e a escolha
   feita na tela deixaria de valer, sem nenhum erro aparecer. */
app.get("/login-fundo.jpg", (_req, res) => {
  const fundo = fundoDoLogin();
  if (!fundo || !fundo.url) return res.status(404).end();
  res.redirect(302, fundo.url);
});

app.use(express.static(publicDir, { extensions: ["html"] }));
/* A raiz abre o CRM.

   Antes ela redirecionava para o cadastro, o que fazia sentido quando este
   servidor era só a API e o site morava em outro lugar. Com o domínio próprio
   apontando para cá, a porta da frente tem que ser o sistema — quem vai se
   cadastrar chega pelo link com o código (/cadastro?c=...), que continua igual. */
app.get("/", (req, res) => servirApp(req, res));

/* Assinatura e webhook do Asaas entram ANTES do porteiro: é esta rota que
   desenha a tela de bloqueio e é por este webhook que o desbloqueio chega.
   Trancá-las junto seria trancar a chave do lado de dentro. */
/* A PORTA DO SITE, e ela vem ANTES do porteiro da assinatura.

   Quem chega aqui não tem conta nenhuma — é justamente o que ele vem criar.
   Montada depois de qualquer middleware de cobrança ou de login, esta rota
   responderia 401 ou 402 para todo visitante do site, e o sintoma seria o pior
   possível: o botão "Testar 14 dias grátis" falhando calado, sem ninguém de
   dentro perceber que parou de entrar cliente.

   Caminho explícito no `app.use`, como manda a regra desta casa. */
app.use("/", publicoRoutes);

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
app.use("/plantoes", cobrando, plantaoRoutes);
app.use("/config", cobrando, configRoutes);
app.use("/produtos", cobrando, produtosRoutes);
/* O core de gestão: funis, etapas e campos personalizados. Caminho explícito,
   como todo o resto — a regra de 13/08/2026 que já custou os webhooks uma vez. */
app.use("/pipelines", cobrando, pipelinesRoutes);
app.use("/canais", cobrando, canaisRoutes);
app.use("/painel", cobrando, painelRoutes);
// Fotos e vídeos dos imóveis enquanto o armazenamento é o disco da hospedagem.
// Com o Cloudflare R2 ligado, as URLs passam a apontar direto para lá e esta
// rota deixa de ser usada sozinha.
app.use("/arquivos", express.static(pastaLocal(), { maxAge: "7d" }));
// Montado no mesmo prefixo de leadsRoutes — os dois routers se completam.
// Antes ficava em "/", e como ele exige login, bloqueava toda rota registrada depois.
app.use("/leads", msgRoutes);         // POST /leads/:id/messages
/* Tarefas, com CAMINHO EXPLÍCITO nos dois casos.

   Estava como `app.use(cobrando, tarefasRoutes)` — sem caminho. Sem caminho, o
   `cobrando` vale para toda rota registrada DEPOIS, e as que vinham depois eram
   os webhooks da Meta e da Uazapi: todo lead que chegava pelo WhatsApp levava
   401 e ia para o lixo. É o mesmo tropeço que o comentário acima já descreve. */
app.use("/leads", cobrando, tarefasRoutes);      // /leads/:id/tarefas
app.use("/tarefas", cobrando, tarefasPorId);     // /tarefas/:id
app.use("/webhooks", metaWebhook);    // GET/POST /webhooks/meta
app.use("/webhooks", uazapiWebhook);  // POST /webhooks/uazapi
app.use("/", pushRoutes);        // GET /push/chave, POST /push/inscrever
app.use("/orgs", orgsRoutes);         // hub de contas (só o master)
app.use("/", diagRoutes);             // GET /integracoes

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  const org = bootstrap();
  const base = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
  console.log(`Con CRM backend rodando — org: ${org.name}`);
  console.log(`Link de cadastro dos corretores: ${base}/cadastro?c=${org.adm_code}`);
  if (!mailConfigured()) console.log("Atenção: e-mail não configurado (RESEND_API_KEY/MAIL_FROM). Os links de confirmação vão aparecer aqui no log.");
  console.log(`WhatsApp (Uazapi) de ${org.name}: ${uazapiConfigured(org.id) ? "conectado" : "NÃO conectado — ligue em Configurações → Conexão"}`);
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
  /* Fim de expediente: derruba a prontidão de quem ficou de ontem. Roda aqui
     no start (cobre o servidor que estava fora do ar às 18:00) e a cada minuto
     (para o corte acontecer na hora certa com o sistema em uso). */
  agendarCorte();
  /* Aviso das 08:00 de quem está de plantão. No mesmo minuto do corte de
     expediente, e pelo mesmo motivo: o que garante o disparo é o registro de
     "até quando já avisei", não o relógio — servidor que reiniciou às 07:59
     ainda avisa, e servidor que reinicia três vezes não avisa três. */
  avisarPlantaoEmTodas();
  /* Cliente esperando resposta. Mesmo batimento e mesmo princípio: quem
     controla a repetição é o carimbo no lead, não o relógio. */
  avisarSemRespostaEmTodas();
  /* Cópia de segurança diária do banco, para o Cloudflare R2. Entra no mesmo
     batimento pelo mesmo motivo dos dois acima: quem decide se roda hoje é o
     registro de "já fiz hoje" (config_plataforma), não o relógio — servidor
     que estava fora do ar às 03:00 faz a cópia quando voltar, e servidor que
     reinicia dez vezes no mesmo dia continua fazendo uma.

     Sem R2 configurado ela não acontece, de propósito: cópia gravada no disco
     da hospedagem fica no mesmo volume do banco que ela deveria proteger. */
  backupSePassouDaHora().catch(e => console.error("[backup] erro no start:", e.message));
  setInterval(() => {
    avisarPlantaoEmTodas(); avisarSemRespostaEmTodas();
    // `catch` explícito: é async, e promessa rejeitada solta derruba o Node.
    backupSePassouDaHora().catch(e => console.error("[backup] erro no ciclo:", e.message));
  }, 60000);
  console.log(`Diagnóstico das integrações: ${base}/integracoes`);
});
