/* Configurações da imobiliária.

   Duas seções, e a divisão não é estética: são coisas de dono diferente.

   - MENSAGENS AUTOMÁTICAS: texto de abordagem. Muda toda semana conforme o
     que está convertendo, e quem sabe isso é quem atende — por isso gestor E
     atendente editam.
   - CONEXÃO: o WhatsApp da imobiliária. Mexer aqui derruba o atendimento de
     todo mundo, então é só do gestor. */

import { Router } from "express";
import { configDoRobo, dentroDaJanela, paraConferir, conferir, orientacoes } from "../services/robo.js";
import { lerHorario } from "../services/expediente.js";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, roles, soMaster } from "../auth.js";
import { instanceStatus, desconectarInstancia, uazapiConfigured, salvarCredenciais, PROVEDORES } from "../services/uazapi.js";
import { canalDaCasa, salvarConexao, salvarConexaoOficial, verificadorDaCasa, garantirCasa } from "../services/canais.js";
import { iaConfigurada, modeloIA } from "../services/ia.js";
import { resumoDeUso } from "../services/iauso.js";
import { marcaDaOrg, validarCor, COR_PADRAO } from "../services/marca.js";
import { salvar, apagar, tipoPermitido, ehVideo } from "../services/storage.js";

const r = Router();
r.use(authRequired);

/* ===== MENSAGENS RÁPIDAS =====

   Os textos que a Conecta já usava viram o ponto de partida da imobiliária na
   primeira vez que a tela abre. Assim ninguém começa com a lista vazia, e o
   que a equipe já conhecia continua ali — só que agora editável. */
const PADRAO = [
  { titulo: "Primeiro contato (forte)", corpo: "Oi {nome}! Aqui é o time da imobiliária e vou dar continuidade ao seu atendimento. Você se cadastrou pra realizar o sonho da casa própria e eu não quero que você perca as condições dessa fase. Posso te mostrar agora quanto ficaria a sua entrada e a parcela que cabe no seu bolso?" },
  { titulo: "Follow-up", corpo: "Oi {nome}, passando aqui rapidinho 🙂 As unidades dessa fase estão saindo. Quer que eu segure uma simulação no seu nome hoje?" },
  { titulo: "Agendar visita", corpo: "{nome}, que tal conhecer o imóvel de pertinho? Consigo te agendar essa semana. Prefere durante a semana ou no sábado?" },
  { titulo: "Pedir documentação", corpo: "{nome}, pra eu já adiantar a sua pasta e a simulação de crédito, consegue me enviar seus documentos (RG, CPF e comprovante de renda)?" },
];

function semear(orgId) {
  const tem = db.prepare("SELECT COUNT(*) n FROM mensagens_rapidas WHERE org_id = ?").get(orgId).n;
  if (tem) return;
  const gravar = db.transaction(() => {
    PADRAO.forEach((m, i) => db.prepare(
      `INSERT INTO mensagens_rapidas (id,org_id,titulo,corpo,ordem,ativo,created_at)
       VALUES (?,?,?,?,?,1,?)`).run("mr_" + randomUUID(), orgId, m.titulo, m.corpo, i, Date.now()));
  });
  gravar();
}

const listar = (orgId, todas) => db.prepare(
  `SELECT id,titulo,corpo,ordem,ativo FROM mensagens_rapidas
   WHERE org_id = ?${todas ? "" : " AND ativo = 1"} ORDER BY ordem, created_at`).all(orgId)
  .map(m => ({ ...m, ativo: !!m.ativo }));

/* A LISTA é para todo mundo: é o corretor que usa os botões na conversa.
   `?todas=1` traz também as desligadas — só a tela de configuração precisa. */
r.get("/mensagens", (req, res) => {
  semear(req.user.org_id);
  const todas = req.query.todas === "1" && ["adm", "sdr"].includes(req.user.role);
  res.json({ mensagens: listar(req.user.org_id, todas) });
});

const limpa = (t, max) => String(t || "").trim().slice(0, max);

r.post("/mensagens", roles("adm", "sdr"), (req, res) => {
  const titulo = limpa(req.body?.titulo, 40), corpo = limpa(req.body?.corpo, 1200);
  if (!titulo || !corpo) return res.status(400).json({ error: "Preencha o nome do botão e o texto." });
  const ordem = (db.prepare("SELECT MAX(ordem) m FROM mensagens_rapidas WHERE org_id=?").get(req.user.org_id).m ?? -1) + 1;
  db.prepare(`INSERT INTO mensagens_rapidas (id,org_id,titulo,corpo,ordem,ativo,criado_por,created_at)
    VALUES (?,?,?,?,?,1,?,?)`).run("mr_" + randomUUID(), req.user.org_id, titulo, corpo, ordem, req.user.id, Date.now());
  res.json({ ok: true, mensagens: listar(req.user.org_id, true) });
});

r.patch("/mensagens/:id", roles("adm", "sdr"), (req, res) => {
  const m = db.prepare("SELECT * FROM mensagens_rapidas WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!m) return res.status(404).json({ error: "Mensagem não encontrada." });

  const titulo = req.body?.titulo !== undefined ? limpa(req.body.titulo, 40) : m.titulo;
  const corpo = req.body?.corpo !== undefined ? limpa(req.body.corpo, 1200) : m.corpo;
  if (!titulo || !corpo) return res.status(400).json({ error: "O nome do botão e o texto não podem ficar vazios." });
  const ativo = req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : m.ativo;
  // `ordem` chega quando a gestão sobe ou desce a mensagem na lista.
  const ordem = req.body?.ordem !== undefined ? Number(req.body.ordem) : m.ordem;

  db.prepare("UPDATE mensagens_rapidas SET titulo=?, corpo=?, ativo=?, ordem=? WHERE id=?")
    .run(titulo, corpo, ativo, ordem, m.id);
  res.json({ ok: true, mensagens: listar(req.user.org_id, true) });
});

r.delete("/mensagens/:id", roles("adm", "sdr"), (req, res) => {
  const info = db.prepare("DELETE FROM mensagens_rapidas WHERE id=? AND org_id=?").run(req.params.id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Mensagem não encontrada." });
  res.json({ ok: true, mensagens: listar(req.user.org_id, true) });
});

// Troca a posição de duas mensagens — é como a gestão pensa a ordem dos botões.
r.post("/mensagens/:id/mover", roles("adm", "sdr"), (req, res) => {
  const lista = listar(req.user.org_id, true);
  const i = lista.findIndex(m => m.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Mensagem não encontrada." });
  const j = req.body?.direcao === "cima" ? i - 1 : i + 1;
  if (j < 0 || j >= lista.length) return res.json({ ok: true, mensagens: lista });

  const trocar = db.transaction(() => {
    db.prepare("UPDATE mensagens_rapidas SET ordem=? WHERE id=?").run(j, lista[i].id);
    db.prepare("UPDATE mensagens_rapidas SET ordem=? WHERE id=?").run(i, lista[j].id);
  });
  trocar();
  res.json({ ok: true, mensagens: listar(req.user.org_id, true) });
});

/* ===== CONSUMO DA IA — SÓ DO MASTER (02/09/2026, pedido do Ali) =====

   Quem paga a conta pergunta duas coisas: quanto já usamos, e quem usou. A
   questão é QUEM paga: a chave da IA é uma só, do ConHub (`ANTHROPIC_API_KEY`
   no servidor), e não existe chave por imobiliária. O dólar que aparece aqui
   nunca foi despesa do cliente — é a nossa, e cobrá-la dele não está no plano
   que ele assinou.

   Mostrá-la ao cliente fazia duas coisas ruins ao mesmo tempo: dava a ele um
   número de custo que não é dele (e que ele naturalmente leria como conta a
   pagar, ou como argumento de desconto), e abria a estrutura de custo da
   plataforma para quem assina a plataforma. No corretor autônomo, que foi o
   caso que o Ali levantou, ficava ainda mais estranho: uma tela de controle de
   gasto de IA na conta de quem só quer que a IA responda o lead dele.

   Fica com o master, que é quem paga a Anthropic e quem precisa saber se o
   recurso pegou na equipe ou está parado. Para o cliente a régua continua
   sendo a de sempre: o custo estimado aparece ANTES do botão, nas rodadas em
   lote, que é onde ele decide gastar.

   O SALDO da conta não sai daqui: ele mora no painel do provedor de IA, e o
   CRM não tem como consultá-lo. A tela diz isso em vez de inventar um número. */
r.get("/ia", soMaster, (req, res) => {
  if (!iaConfigurada())
    return res.json({ configurada: false, modelo: null });
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  res.json({ configurada: true, ...resumoDeUso(req.user.org_id, dias) });
});

/* ===== CONEXÃO =====

   Uazapi (não oficial) e, desde 03/09/2026, a API oficial da Meta — os dois
   ficam na mesma lista de provedores, cada um com o próprio risco escrito na
   tela: quem assina a conta precisa saber que o número da Uazapi pode ser
   banido pelo WhatsApp, e que na Meta oficial não dá para editar mensagem
   nem mandar texto livre fora da janela de 24h. */
r.get("/conexao", roles("adm", "sdr"), async (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const casa = garantirCasa(req.user.org_id);
  res.json({
    provedores: PROVEDORES,
    ativo: (casa?.provider === "meta" && casa.token) ? "meta" : (uazapiConfigured(req.user.org_id) ? "uazapi" : null),
    whatsapp: await instanceStatus(req.user.org_id),
    webhook: {
      uazapi: {
        url: `${base}/webhooks/uazapi`,
        // O que precisa estar ligado do lado da Uazapi para a conversa chegar.
        eventos: ["Mensagens (messages)"],
        observacao: "Cole esta URL no campo de Webhook da instância. Sem ela, o CRM envia mas não recebe.",
      },
      meta: {
        url: `${base}/webhooks/whatsapp-oficial`,
        /* Gerado (e guardado) na hora, mesmo que a linha ainda não tenha
           nenhum outro dado da Meta preenchido — é o que o gestor precisa
           colar na tela de Webhook do aplicativo ANTES de acabar de
           preencher o resto, porque a Meta pede os dois juntos para
           verificar. */
        verify_token: verificadorDaCasa(req.user.org_id),
        observacao: "Cole esta URL e este Verify Token na tela de Webhook do seu aplicativo (Configurações do WhatsApp, no Gerenciador de Negócios da Meta) e marque o campo \"messages\" para inscrever.",
      },
    },
  });
});

/* Conectar a API OFICIAL da Meta, na linha da casa.

   Diferente da Uazapi: aqui não há endereço para conferir formato, e sim
   quatro campos que só a própria Meta valida de verdade (o primeiro envio,
   ou o `instanceStatus` logo abaixo, é quem avisa se algum está errado).
   Só o gestor — é quem assina o aplicativo na Meta e responde pela conta. */
r.post("/conexao/oficial", roles("adm"), async (req, res) => {
  const phoneNumberId = String(req.body?.phone_number_id || "").trim();
  const wabaId = String(req.body?.waba_id || "").trim();
  const token = String(req.body?.token || "").trim();
  const appSecret = String(req.body?.app_secret || "").trim();
  if (!phoneNumberId || !wabaId || !token || !appSecret)
    return res.status(400).json({ error: "Preencha o Phone Number ID, o WABA ID, o token de acesso permanente e o App Secret." });

  const casa = garantirCasa(req.user.org_id);
  /* Phone Number ID repetido apontaria duas linhas do ConHub para o MESMO
     número da Meta — o índice do banco já barra a gravação; a mensagem aqui
     é só para dizer o motivo, em vez de um erro genérico de banco. */
  const emUso = db.prepare(`SELECT o.name AS imobiliaria FROM canais c JOIN orgs o ON o.id = c.org_id
    WHERE c.phone_number_id = ? AND c.id <> ?`).get(phoneNumberId, casa.id);
  if (emUso) return res.status(409).json({ error: `Esse Phone Number ID já está ligado a outra conta (${emUso.imobiliaria}). Cada imobiliária precisa do próprio número registrado na Meta.` });

  try {
    salvarConexaoOficial(casa.id, { phoneNumberId, wabaId, token, appSecret });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const whatsapp = await instanceStatus(req.user.org_id);
  res.json({
    ok: true, whatsapp,
    aviso: whatsapp.ok ? null : "Salvei, mas a Meta não respondeu com esses dados. Confira o Phone Number ID e o token de acesso.",
  });
});

/* Conectar o WhatsApp DESTA imobiliária.

   O endereço e o token vêm da instância que a própria imobiliária contratou na
   Uazapi (o tutorial da tela ensina onde achar). Ficam guardados na linha dela
   — nunca em variável do servidor, que era o que fazia uma imobiliária enxergar
   o WhatsApp da outra.

   Só o gestor: é ele quem assina a conta da Uazapi e quem responde se o número
   for bloqueado. */
r.post("/conexao/credenciais", roles("adm"), async (req, res) => {
  const host = String(req.body?.host || "").trim();
  const token = String(req.body?.token || "").trim();
  if (!host || !token)
    return res.status(400).json({ error: "Informe o endereço (host) e o token da instância." });
  if (!/^https?:\/\//i.test(host))
    return res.status(400).json({ error: "O endereço precisa começar com https:// (é o que a Uazapi mostra no painel)." });

  /* Token repetido é quase sempre o mesmo da imobiliária vizinha, copiado por
     engano. Deixar passar recria o problema que esta mudança veio corrigir:
     duas casas mandando pelo mesmo número. */
  /* Token repetido: agora a conferência é contra TODAS as linhas, não só
     contra as outras imobiliárias. Desde que o corretor pode ligar a dele,
     colar aqui o token da linha pessoal de alguém faria o número da casa e o
     dele apontarem para a mesma instância — e o webhook entregaria a mensagem
     à primeira que casasse, sem erro nenhum aparecer. */
  const casa = canalDaCasa(req.user.org_id);
  const jaUsado = db.prepare(`SELECT c.tipo, c.nome, o.name AS imobiliaria FROM canais c
    JOIN orgs o ON o.id = c.org_id WHERE c.token = ? AND c.id <> COALESCE(?, '')`)
    .get(token, casa ? casa.id : null);
  if (jaUsado)
    return res.status(409).json({ error: jaUsado.tipo === "corretor"
      ? `Esse token já é o da linha pessoal de ${jaUsado.nome}. O número da imobiliária precisa da própria instância na Uazapi.`
      : `Esse token já é usado por outra imobiliária (${jaUsado.imobiliaria}). Cada uma precisa da sua própria instância na Uazapi.` });

  /* Grava PELO CANAL, e não direto em `orgs`. É o único lugar que mantém as
     duas cópias em par — `orgs.uazapi_*`, que o resto do sistema lê, e a linha
     da casa em `canais`, que é por onde o webhook reconhece a mensagem que
     chega. Escrever só numa das duas deixaria o CRM enviando por um número e
     recebendo por outro. */
  if (casa) salvarConexao(casa.id, { host, token, quem: req.user.id });
  else salvarCredenciais(req.user.org_id, { host, token });
  const whatsapp = await instanceStatus(req.user.org_id);
  // Token errado só aparece na hora de perguntar o estado — e é melhor dizer
  // agora do que na primeira mensagem que não sair.
  res.json({ ok: true, whatsapp, aviso: whatsapp.ok ? null : "Salvei, mas a Uazapi não respondeu com esses dados. Confira o endereço e o token da instância." });
});

/* Desconectar derruba o WhatsApp da imobiliária inteira: ninguém envia nem
   recebe até parear de novo. Por isso é só do gestor e pede confirmação
   escrita na tela. */
r.post("/conexao/desconectar", roles("adm"), async (req, res) => {
  if (String(req.body?.confirmar || "").toUpperCase() !== "DESCONECTAR")
    return res.status(400).json({ error: "Escreva DESCONECTAR para confirmar." });
  try {
    const casa = canalDaCasa(req.user.org_id);
    const out = await desconectarInstancia(req.user.org_id, casa ? casa.id : null);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: "Não consegui desconectar", detail: e.message });
  }
});

/* ===== PRIMEIRO ATENDIMENTO AUTOMÁTICO =====

   Ligar e desligar o robô que atende fora do expediente, e a janela dele.

   LIGAR É SÓ DO ADM. A atendente edita as mensagens rápidas porque o texto de
   abordagem é o trabalho dela; um robô conversando sozinho com cliente no
   WhatsApp da imobiliária é decisão de quem responde pela empresa. Ver, a
   supervisão inteira vê. */
r.get("/robo", roles("adm", "sdr"), (req, res) => {
  const cfg = configDoRobo(req.user.org_id);
  res.json({ ...cfg, agora_atenderia: cfg.ativo && cfg.configurada && dentroDaJanela(cfg) });
});

r.post("/robo", roles("adm"), (req, res) => {
  const b = req.body || {};
  const hora = (v, padrao) => (lerHorario(v) ? String(v).trim() : padrao);
  const atual = configDoRobo(req.user.org_id);

  /* Atender a qualquer hora, sem janela nenhuma. (02/09/2026)

     Vem ANTES da conferência da janela de propósito: quem escolheu "a qualquer
     hora" não tem janela para validar, e recusar o salvamento por causa de dois
     horários que não valem mais seria barrar a pessoa por um campo que a
     própria escolha dela desligou. */
  const sempre = b.sempre === undefined ? atual.sempre : !!b.sempre;

  const inicio = hora(b.inicio, atual.inicio), fim = hora(b.fim, atual.fim);
  // Janela de tamanho zero deixaria o robô ligado e mudo — e "ligado e mudo" é
  // exatamente o estado que ninguém consegue diagnosticar olhando a tela.
  if (!sempre && inicio === fim) return res.status(400).json({ error: "O início e o fim da janela não podem ser o mesmo horário." });

  const teto = Math.min(Math.max(Number(b.teto) || atual.teto, 2), 30);
  /* Dias de expediente. Lista vazia é escolha válida ("não temos expediente
     fixo"), e aí o robô atende o dia inteiro, todo dia — por isso a string
     vazia é gravada de propósito em vez de virar nulo, que cairia no padrão. */
  const dias = Array.isArray(b.dias)
    ? [...new Set(b.dias.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort()
    : atual.dias;

  /* `robo_sempre` sai de nulo no primeiro salvamento e nunca mais volta: a
     partir daqui a escolha é de quem mexeu, não do tipo da conta. Um corretor
     autônomo que ligou a janela não pode voltar a atender 24h porque alguém
     mexeu noutro campo qualquer da tela. */
  db.prepare("UPDATE orgs SET robo_ativo=?, robo_inicio=?, robo_fim=?, robo_teto=?, robo_dias=?, robo_sempre=? WHERE id=?")
    .run(b.ativo ? 1 : 0, inicio, fim, teto, dias.join(","), sempre ? 1 : 0, req.user.org_id);

  const cfg = configDoRobo(req.user.org_id);
  console.log(`[robo] ${cfg.ativo ? "LIGADO" : "desligado"} por ${req.user.name} — ${cfg.sempre ? "a QUALQUER hora" : `janela ${cfg.inicio}→${cfg.fim} nos dias [${cfg.dias}]`}, teto ${cfg.teto}`);
  res.json({ ...cfg, agora_atenderia: cfg.ativo && cfg.configurada && dentroDaJanela(cfg) });
});

/* ===== O QUE A EQUIPE ENSINA AO ROBÔ =====

   A ATENDENTE EDITA, e não só o gestor. É a mesma razão das mensagens rápidas:
   quem sabe como se fala com o cliente da Conecta é quem fala com ele todo
   dia. O robô cobre a ausência dela — se as duas não soam iguais, o cliente
   percebe a troca de turno.

   Ligar o robô continua sendo só do ADM. Ensinar o que dizer é do trabalho de
   quem atende; decidir que existe um robô falando, não. */
r.get("/robo/ensino", roles("adm", "sdr"), (req, res) =>
  res.json({ linhas: orientacoes(req.user.org_id, true) }));

r.post("/robo/ensino", roles("adm", "sdr"), (req, res) => {
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "Escreva a orientação." });
  /* Teto de 30 linhas, e não é economia besta: cada uma entra no pedido de
     TODA mensagem que o robô responde, então o texto acumulado vira dinheiro
     em toda conversa. Trinta orientações curtas descrevem um jeito de falar;
     duzentas descrevem um manual que ninguém leu. */
  const quantas = db.prepare("SELECT COUNT(*) n FROM robo_ensino WHERE org_id=?").get(req.user.org_id).n;
  if (quantas >= 30) return res.status(400).json({ error: "São no máximo 30 orientações. Apague ou junte alguma antes de criar outra." });

  const ordem = (db.prepare("SELECT MAX(ordem) m FROM robo_ensino WHERE org_id=?").get(req.user.org_id).m || 0) + 1;
  const id = "en_" + randomUUID();
  db.prepare(`INSERT INTO robo_ensino (id,org_id,texto,ordem,ativo,criado_por,created_at)
    VALUES (?,?,?,?,1,?,?)`).run(id, req.user.org_id, texto.slice(0, 500), ordem, req.user.id, Date.now());
  console.log(`[robo] ${req.user.name} ensinou: "${texto.slice(0, 60)}"`);
  res.json({ linhas: orientacoes(req.user.org_id, true) });
});

r.patch("/robo/ensino/:id", roles("adm", "sdr"), (req, res) => {
  const linha = db.prepare("SELECT * FROM robo_ensino WHERE id=? AND org_id=?").get(req.params.id, req.user.org_id);
  if (!linha) return res.status(404).json({ error: "Orientação não encontrada." });
  const texto = req.body?.texto === undefined ? linha.texto : String(req.body.texto).trim().slice(0, 500);
  if (!texto) return res.status(400).json({ error: "A orientação não pode ficar vazia." });
  const ativo = req.body?.ativo === undefined ? linha.ativo : (req.body.ativo ? 1 : 0);
  db.prepare("UPDATE robo_ensino SET texto=?, ativo=? WHERE id=?").run(texto, ativo, linha.id);
  res.json({ linhas: orientacoes(req.user.org_id, true) });
});

r.delete("/robo/ensino/:id", roles("adm", "sdr"), (req, res) => {
  db.prepare("DELETE FROM robo_ensino WHERE id=? AND org_id=?").run(req.params.id, req.user.org_id);
  res.json({ linhas: orientacoes(req.user.org_id, true) });
});

/* A lista de segunda-feira. É o par obrigatório do robô: a conversa que ele
   atendeu tem a última mensagem da imobiliária, e por isso SAI da fila de
   "cliente esperando". Sem esta lista, o robô trocaria "ninguém respondeu"
   por "ninguém percebeu que ainda faltava responder". */
r.get("/robo/conferir", roles("adm", "sdr"), (req, res) =>
  res.json({ leads: paraConferir(req.user.org_id) }));

r.post("/robo/conferir/:leadId", roles("adm", "sdr"), (req, res) => {
  const out = conferir(req.user.org_id, req.params.leadId,
    { gravarNaFicha: req.body?.gravar_na_ficha !== false, userId: req.user.id });
  if (out.erro) return res.status(404).json({ error: out.erro });
  res.json(out);
});

/* ===== A MARCA DA IMOBILIÁRIA =====

   Logo e cor da barra. É do GESTOR, não da atendente: identidade visual não é
   decisão de quem atende, e trocar a logo mexe no que a equipe inteira vê ao
   abrir o sistema. A regra de contraste mora em services/marca.js. */

const orgAtual = (req) => db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);

r.get("/marca", roles("adm", "sdr"), (req, res) =>
  res.json({ ...marcaDaOrg(orgAtual(req)), padrao: COR_PADRAO }));

r.post("/marca/logo", roles("adm"), async (req, res) => {
  const { mime, base64 } = req.body || {};
  if (!mime || !base64) return res.status(400).json({ error: "Escolha uma imagem." });
  if (ehVideo(mime) || !tipoPermitido(mime))
    return res.status(400).json({ error: "Use uma imagem PNG, JPG ou WEBP." });

  const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  if (buffer.length > 2 * 1024 * 1024)
    return res.status(413).json({ error: "Imagem muito grande. O limite é 2 MB." });

  const org = orgAtual(req);
  try {
    const { url, chave } = await salvar({ buffer, mime, prefixo: `marca/${org.id}` });
    /* A logo antiga sai do armazenamento na troca. Sem isto, cada ajuste de
       marca deixaria um arquivo pago para sempre, sem nada apontando para ele. */
    if (org.logo_key) apagar(org.logo_key);
    db.prepare("UPDATE orgs SET logo_url=?, logo_key=? WHERE id=?").run(url, chave, org.id);
    res.json({ ok: true, ...marcaDaOrg(orgAtual(req)) });
  } catch (e) {
    console.error("[marca] falha ao salvar a logo:", e.message);
    res.status(500).json({ error: "Não consegui guardar a logo. Tente de novo." });
  }
});

r.delete("/marca/logo", roles("adm"), (req, res) => {
  const org = orgAtual(req);
  if (org.logo_key) apagar(org.logo_key);
  db.prepare("UPDATE orgs SET logo_url=NULL, logo_key=NULL WHERE id=?").run(org.id);
  res.json({ ok: true, ...marcaDaOrg(orgAtual(req)) });
});

/* Cor clara volta 400 COM a versão escura da mesma cor. A recusa seca faria o
   gestor abandonar a cor da marca dele; com a sugestão, ele aceita num clique. */
r.patch("/marca", roles("adm"), (req, res) => {
  const { cor, erro, sugestao } = validarCor(req.body?.cor);
  if (erro) return res.status(400).json({ error: erro, sugestao });
  db.prepare("UPDATE orgs SET cor_barra=? WHERE id=?").run(cor, req.user.org_id);
  res.json({ ok: true, ...marcaDaOrg(orgAtual(req)) });
});

export default r;
