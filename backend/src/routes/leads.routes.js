import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, roles, supervisiona, semMaster, podeVerLead } from "../auth.js";
import { STAGES, LINEAR, GATILHOS, normalizePhone, inferStage, gatilhosNaConversa } from "../services/stages.js";
import { salvar } from "../services/storage.js";
import { lerPrintSimulacao, iaConfigurada, resumirConversa, etapaDaConversa } from "../services/ia.js";
import { registrar as registrarUsoIA } from "../services/iauso.js";
import { sendText } from "../services/uazapi.js";
import { numero as numeroBR } from "./produtos.routes.js";
import { advanceStage } from "./messages.routes.js";
import { cutucar, limparCutucada } from "../services/alerta.js";
import { moverLead, transferenciasDoLead } from "../services/movimento.js";
import { slaDoLead } from "../services/etapas.js";
import { etapaPorId, pipelinePorId, formatarEtapa } from "../services/pipelines.js";
import { moverEtapa, etapaDesdePorLead, historicoDoLead } from "../services/etapas.js";
import { estadoNoLead, ligarNoLead } from "../services/robo.js";
import { previaTemperatura, limparTemperatura, previaEtapaIA, rodarEtapaIA,
  corretoresParaTemperatura, previaTemperaturaIA, rodarTemperaturaIA, previaMoverFunil, moverParaFunil } from "../services/lote.js";
import { tarefasAbertasPorLead, listar as listarTarefas } from "./tarefas.routes.js";

const r = Router();
r.use(authRequired);

// Colunas calculadas usadas nas listagens: quantas mensagens do lead ainda não
// foram lidas e qual foi a última mensagem da conversa.
const SELECT_LEAD = `
  SELECT l.*,
    (SELECT COUNT(*) FROM messages m
      WHERE m.lead_id = l.id AND m.direction = 'in'
        AND m.created_at > COALESCE(l.last_read_at, 0)) AS unread,
    (SELECT m.body FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
    (SELECT m.direction FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
    (SELECT m.created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
    (SELECT u.name FROM users u WHERE u.id = l.assigned_to) AS assigned_name
  FROM leads l`;

const parse = (l) => l && ({ ...l, qual: JSON.parse(l.qual_json || "{}"), unread: l.unread || 0 });

// A ADM enxerga tudo; corretor e SDR só o que está com eles.
// Filtros (pensados para a supervisão da ADM):
//   ?atendente=<id|fila>  ?etapa=<etapa>  ?prioridade=QUENTE  ?q=<nome ou telefone>
r.get("/", (req, res) => {
  const { id, org_id } = req.user;
  const where = [], args = [];

  if (supervisiona(req.user)) {
    where.push("l.org_id = ?"); args.push(org_id);
    // Caixa de atendimento da atendente: só o que está com ela e o que ainda não
    // tem dono. Sem isto ela enxerga a imobiliária inteira (é supervisora), e o
    // lead que ela acabou de repassar continuava na tela dela, atrapalhando o
    // próprio atendimento. A visão geral continua a um clique, no escopo "todos",
    // e os filtros abaixo seguem valendo dentro dos dois escopos.
    if (req.query.escopo === "meus") { where.push("(l.assigned_to = ? OR l.assigned_to IS NULL)"); args.push(id); }
    const { atendente, etapa, prioridade, q, de, ate } = req.query;
    if (atendente === "fila") where.push("l.assigned_to IS NULL");
    else if (atendente) { where.push("l.assigned_to = ?"); args.push(atendente); }
    if (etapa) { where.push("l.stage = ?"); args.push(etapa); }
    if (prioridade) { where.push("l.priority = ?"); args.push(prioridade); }
    if (q) { where.push("(l.name LIKE ? OR l.phone LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
    // Período de entrada do lead. O "até" cobre o dia inteiro, senão o filtro
    // exclui tudo que chegou depois da meia-noite da data escolhida.
    const inicio = de && new Date(`${de}T00:00:00`).getTime();
    const fim = ate && new Date(`${ate}T23:59:59.999`).getTime();
    if (inicio && isFinite(inicio)) { where.push("l.created_at >= ?"); args.push(inicio); }
    if (fim && isFinite(fim)) { where.push("l.created_at <= ?"); args.push(fim); }
  } else {
    where.push("l.assigned_to = ?"); args.push(id);
  }

  // Atendimento finalizado sai da caixa de entrada, mas continua no funil e nos
  // relatórios. ?finalizados=1 traz de volta, para reabrir ou consultar.
  if (req.query.finalizados !== "1") where.push("l.closed_at IS NULL");

  const rows = db.prepare(`${SELECT_LEAD} WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC`).all(...args);

  /* Duas informações que o FUNIL precisa em todo card: desde quando o lead está
     na etapa, e se tem tarefa marcada. Buscadas de uma vez para a imobiliária
     inteira — uma consulta por card deixaria o funil lento com a base
     crescendo, e é o funil que a gestão deixa aberto o dia todo. */
  const desde = etapaDesdePorLead(org_id);
  const tarefas = tarefasAbertasPorLead(org_id);
  /* O SLA de cada card, calculado com UMA consulta de etapas para a lista
     inteira. Uma por card deixaria a tela que recarrega de 10 em 10 segundos
     fazendo centenas de consultas — o custo que os índices de 27/08 vieram
     justamente tirar. */
  const etapasDaCasa = new Map(db.prepare(
    "SELECT * FROM pipeline_stages WHERE org_id = ?").all(org_id)
    .map(e => [e.id, formatarEtapa(e)]));
  const agoraMs = Date.now();
  res.json(rows.map(l => ({
    ...parse(l),
    sla: l.stage_id ? slaDoLead(etapasDaCasa.get(l.stage_id), l, agoraMs) : null,
    // null quando o lead nunca mudou de etapa desde que o histórico existe. A
    // tela mostra "—": inventar a data de criação seria dizer que ele está ali
    // desde que entrou, o que muitas vezes é falso.
    /* `stage_entered_at` primeiro, o histórico como reserva.

       A coluna é preenchida por `moverEtapa` e pela migração, então responde
       para TODO lead; o histórico só tem linha para quem se mexeu depois de
       13/08/2026. Na ordem inversa, a base inteira mostrava "nesta etapa há —"
       mesmo com a data disponível ao lado. */
    etapa_desde: l.stage_entered_at || desde.get(l.id) || null,
    tarefas: tarefas.get(l.id) || null,
  })));
});

/* Exportação da base de leads, para o gestor abrir no Excel.

   Sai como CSV com ponto e vírgula e BOM: é o que o Excel em português abre
   direto, sem a tela de importação em que todo mundo trava. Vírgula como
   separador quebraria os valores em reais, que já usam vírgula decimal. */
r.get("/export", roles("adm"), (req, res) => {
  const linhas = db.prepare(`
    SELECT l.*, (SELECT u.name FROM users u WHERE u.id = l.assigned_to) AS corretor
    FROM leads l WHERE l.org_id = ? ORDER BY l.created_at DESC`).all(req.user.org_id);

  const data = (ms) => ms ? new Date(ms).toLocaleString("pt-BR") : "";
  const cabecalho = ["Nome","Telefone","E-mail","Origem","Temperatura","Etapa","Corretor responsável",
    "Entrou em","1ª resposta em","Minutos até a 1ª resposta","Atendimento finalizado em",
    "Valor da venda","Data da venda","Imóvel vendido"];

  const campos = (l) => [
    l.name || "", l.phone || "", l.email || "", l.origem || "", l.priority || "", l.stage || "",
    // Sem corretor é estado real, não campo vazio: "na fila" evita a leitura de
    // que faltou preencher.
    l.corretor || "na fila",
    data(l.created_at), data(l.first_resp_at),
    l.first_resp_at ? Math.round((l.first_resp_at - l.created_at) / 60000) : "",
    data(l.closed_at),
    l.sale_value != null ? String(l.sale_value).replace(".", ",") : "",
    data(l.sale_date), l.sale_property || "",
  ];

  // Aspas dobradas e o campo entre aspas: nome com ponto e vírgula ou quebra de
  // linha não pode partir a planilha em duas colunas.
  const escapar = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cabecalho, ...linhas.map(campos)].map(l => l.map(escapar).join(";")).join("\r\n");

  const arquivo = `leads-conecta-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${arquivo}"`);
  res.send("\uFEFF" + csv);   // BOM: sem ele o Excel come os acentos
});

/* Importação de leads vindos de outro CRM.

   O frontend lê a planilha e manda as linhas já separadas — assim o servidor
   não precisa adivinhar codificação nem separador, que é onde importação
   costuma quebrar.

   Três decisões que evitam estrago numa base que já está rodando:
   - telefone repetido é IGNORADO, não sobrescrito. Se o cliente já está no
     ConHub com histórico de conversa, uma planilha antiga não pode apagar isso
   - lead importado entra SEM dono por padrão. Quem distribui é a catraca ou o
     gestor; adivinhar corretor por nome parecido daria lead na mão errada
   - etapa desconhecida vira "Lead". Melhor entrar no começo do funil do que
     recusar a linha inteira por causa de um nome de coluna diferente */
/* Data vinda de planilha brasileira. O JS lê "10/03/2026" como OUTUBRO — é o
   padrão americano — e o lead de março entraria no sistema como de outubro,
   bagunçando relatório e antiguidade. Aqui dd/mm/aaaa é lido como dd/mm/aaaa. */
function dataBR(valor) {
  const t = String(valor || "").trim();
  if (!t) return NaN;
  const br = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (br) {
    const [, d, m, a] = br;
    const ms = new Date(Number(a), Number(m) - 1, Number(d)).getTime();
    return isFinite(ms) ? ms : NaN;
  }
  return new Date(t).getTime();   // 2026-03-10 e afins
}

r.post("/import", roles("adm"), (req, res) => {
  const { linhas, origem_fixa, corretores: mapaEnviado, rotulo, arquivo } = req.body || {};
  if (!Array.isArray(linhas) || !linhas.length)
    return res.status(400).json({ error: "Nenhuma linha recebida." });
  if (linhas.length > 5000)
    return res.status(413).json({ error: "Máximo de 5.000 leads por importação. Divida a planilha." });

  const corretores = db.prepare(`SELECT u.id,u.name FROM users u WHERE u.org_id=? AND u.status='ativo'${semMaster("u")}`).all(req.user.org_id);
  const porNome = {};
  for (const u of corretores) porNome[u.name.trim().toLowerCase()] = u.id;
  const idsValidos = new Set(corretores.map(u => u.id));

  /* Mapa "nome na planilha" → id do corretor, montado na tela antes de subir.
     Vale mais que o acerto automático por nome: a planilha do CRM antigo traz
     "Ana C.", "ana costa", "ANA" — tudo a mesma pessoa, e nenhum bate exato.
     Quem sabe quem é quem é o gestor, então quem decide é ele.

     "" (vazio) é uma escolha legítima: manda para a fila da catraca. */
  const mapa = {};
  if (mapaEnviado && typeof mapaEnviado === "object")
    for (const [nome, id] of Object.entries(mapaEnviado))
      mapa[String(nome).trim().toLowerCase()] = idsValidos.has(id) ? id : null;

  const origemFixa = String(origem_fixa || "").trim().slice(0, 80);

  const TEMPERATURAS = ["QUENTE", "MORNO", "FRIO"];
  const importId = "imp_" + randomUUID();
  const resultado = { criados: 0, ignorados: 0, motivos: {}, import_id: importId };
  const anota = (motivo) => { resultado.ignorados++; resultado.motivos[motivo] = (resultado.motivos[motivo] || 0) + 1; };

  const inserir = db.prepare(`INSERT INTO leads
    (id,org_id,name,phone,email,origem,priority,qual_json,stage,assigned_to,created_at,import_id)
    VALUES (?,?,?,?,?,?,?,'{}',?,?,?,?)`);

  const importar = db.transaction((lista) => {
    for (const l of lista) {
      const phone = normalizePhone(String(l.telefone || "").trim());
      if (!phone) { anota("sem telefone válido"); continue; }
      if (db.prepare("SELECT 1 FROM leads WHERE org_id=? AND phone=?").get(req.user.org_id, phone)) {
        anota("telefone já cadastrado"); continue;
      }
      const etapa = STAGES.includes(l.etapa) ? l.etapa : "Lead";
      const temperatura = TEMPERATURAS.includes(String(l.temperatura || "").toUpperCase())
        ? String(l.temperatura).toUpperCase() : "MORNO";
      /* Dono: primeiro o que o gestor decidiu na tela; se ele não decidiu
         aquele nome, o acerto exato pelo nome da equipe; senão, fila. */
      const chave = String(l.corretor || "").trim().toLowerCase();
      const dono = chave
        ? (Object.prototype.hasOwnProperty.call(mapa, chave) ? mapa[chave] : (porNome[chave] || null))
        : null;
      const entrada = dataBR(l.entrou_em);

      inserir.run("l_" + randomUUID(), req.user.org_id,
        String(l.nome || "Sem nome").trim().slice(0, 120), phone,
        String(l.email || "").trim() || null,
        // A origem digitada na tela manda em tudo: é ela que separa "Feirão de
        // março" de "Base antiga do RD" na hora de medir o que deu resultado.
        origemFixa || String(l.origem || "").trim() || "Importado",
        temperatura, etapa, dono,
        isFinite(entrada) ? entrada : Date.now(), importId);
      resultado.criados++;
    }
  });
  importar(linhas);

  db.prepare(`INSERT INTO importacoes (id,org_id,rotulo,origem,arquivo,total,criados,criado_por,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(importId, req.user.org_id,
    String(rotulo || "").trim().slice(0, 80) || null, origemFixa || null,
    String(arquivo || "").trim().slice(0, 120) || null,
    linhas.length, resultado.criados, req.user.id, Date.now());

  res.json(resultado);
});

/* Importações feitas, com quantos leads de cada uma ainda estão na base.

   `com_conversa` é o número que importa na hora de apagar: lead que já trocou
   mensagem não é mais "linha de planilha", é atendimento em andamento. */
r.get("/importacoes", roles("adm"), (req, res) => {
  const linhas = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM leads l WHERE l.import_id = i.id) AS na_base,
      (SELECT COUNT(*) FROM leads l WHERE l.import_id = i.id
         AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id)) AS com_conversa
    FROM importacoes i WHERE i.org_id = ? ORDER BY i.created_at DESC`).all(req.user.org_id);
  res.json(linhas);
});

/* Leads que entraram ANTES de a importação passar a registrar lote.

   Eles têm import_id nulo, e por isso não aparecem em /importacoes. Só que
   import_id nulo também é o caso de todo lead que chega pela Meta e pelo
   WhatsApp — apagar "tudo que não tem lote" levaria a operação junto.

   Por isso o agrupamento é por ORIGEM, com o período e quantos já têm
   conversa. Assim dá para enxergar "Importado de base-antiga" separado de
   "Meta Lead Ads" e apagar só o que é planilha velha. Quem escolhe é o gestor;
   o servidor não adivinha qual grupo é descartável. */
r.get("/grupos-antigos", roles("adm"), (req, res) => {
  const linhas = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(l.origem), ''), '(sem origem)') AS origem,
           COUNT(*) AS quantos,
           MIN(l.created_at) AS primeiro,
           MAX(l.created_at) AS ultimo,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id) THEN 1 ELSE 0 END) AS com_conversa
    FROM leads l
    WHERE l.org_id = ? AND l.import_id IS NULL
    GROUP BY origem ORDER BY quantos DESC`).all(req.user.org_id);
  res.json(linhas);
});

/* Apaga um grupo desses, pela origem exata. Mesmo cuidado do lote: por padrão
   poupa quem já tem conversa, e ?tudo=1 leva todos. */
r.delete("/grupos-antigos", roles("adm"), (req, res) => {
  const origem = String(req.query.origem ?? "");
  if (!origem) return res.status(400).json({ error: "Informe a origem do grupo." });
  const tudo = req.query.tudo === "1";
  // '(sem origem)' é rótulo da tela, não valor no banco: ali a origem é nula ou vazia.
  const filtroOrigem = origem === "(sem origem)"
    ? "(l.origem IS NULL OR TRIM(l.origem) = '')" : "TRIM(l.origem) = ?";
  const args = origem === "(sem origem)" ? [req.user.org_id] : [req.user.org_id, origem.trim()];

  const alvos = db.prepare(`SELECT l.id FROM leads l
    WHERE l.org_id = ? AND l.import_id IS NULL AND ${filtroOrigem}
    ${tudo ? "" : "AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id)"}`).all(...args);

  const apagar = db.transaction(() => {
    for (const { id } of alvos) {
      db.prepare("DELETE FROM messages WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM ligacoes WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM simulacoes WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM leads WHERE id = ?").run(id);
    }
  });
  apagar();

  const { n } = db.prepare(`SELECT COUNT(*) n FROM leads l
    WHERE l.org_id = ? AND l.import_id IS NULL AND ${filtroOrigem}`).get(...args);

  res.json({ ok: true, apagados: alvos.length, mantidos: n,
    aviso: n ? `${n} lead(s) foram mantidos porque já têm conversa.` : null });
});

/* Desfaz uma importação.

   Por padrão POUPA quem já tem conversa: apagar um lead que o corretor já
   atendeu joga fora o trabalho dele, e isso não tem volta. Para levar tudo,
   ?tudo=1 — a tela pergunta antes, mostrando quantos seriam.

   Os leads saem de vez, junto com mensagens, ligações e simulações. Deixar
   filho órfão no banco só cria contagem errada em relatório mais tarde. */
r.delete("/importacoes/:id", roles("adm"), (req, res) => {
  const imp = db.prepare("SELECT * FROM importacoes WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!imp) return res.status(404).json({ error: "Importação não encontrada." });
  const tudo = req.query.tudo === "1";

  const alvos = db.prepare(`SELECT l.id FROM leads l WHERE l.import_id = ?
    ${tudo ? "" : "AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id)"}`).all(imp.id);

  const apagar = db.transaction(() => {
    for (const { id } of alvos) {
      db.prepare("DELETE FROM messages WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM ligacoes WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM simulacoes WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM leads WHERE id = ?").run(id);
    }
    // A importação some do histórico só quando não sobrou lead dela.
    const { n } = db.prepare("SELECT COUNT(*) n FROM leads WHERE import_id = ?").get(imp.id);
    if (!n) db.prepare("DELETE FROM importacoes WHERE id = ?").run(imp.id);
    return n;
  });
  const sobraram = apagar();

  res.json({ ok: true, apagados: alvos.length, mantidos: sobraram,
    aviso: sobraram ? `${sobraram} lead(s) foram mantidos porque já têm conversa.` : null });
});

// Fila da catraca (leads sem dono). SDR e ADM.
r.get("/queue", roles("sdr", "adm"), (req, res) => {
  const rows = db.prepare(`${SELECT_LEAD} WHERE l.org_id = ? AND l.assigned_to IS NULL ORDER BY l.created_at DESC`).all(req.user.org_id);
  res.json(rows.map(parse));
});

/* ===== REANÁLISE DO FUNIL =====

   A regra de avanço mudou (agora é por palavra-chave), mas os leads que já
   estavam no sistema continuaram onde a regra ANTIGA os deixou — e a antiga
   era frouxa: abrir a conversa virava "Atendimento", um "sábado" solto virava
   "Agendamento". Sem passar a régua nova por cima, o funil ficaria metade
   numa regra e metade na outra, e o relatório não valeria para nada.

   Aqui a etapa é recalculada DO ZERO, a partir da etapa "Lead", lendo a
   conversa inteira. Por isso lead pode DESCER: é o ponto — tirar da frente do
   funil quem nunca deveria ter chegado lá.

   Três grupos ficam de fora, e cada um por um motivo diferente:

   - SEM CONVERSA. Se não há mensagem, não há palavra — a conversa não tem
     nada a dizer sobre esse lead. E como a regra antiga também não movia lead
     sem mensagem, uma etapa aí só pode ter sido posta por uma pessoa ou pela
     importação. Recalcular jogaria a base importada inteira para "Lead".
   - VENDA REGISTRADA. Tem valor e data lançados; é dinheiro, não palpite.
   - ETAPA MANUAL (Perdido, Recaptação, Transferido por ligação). Mesma regra
     de sempre: quem marcou sabe de algo que a conversa não mostra. */
function reanalisar(orgId, aplicar) {
  const vagas = LINEAR.map(() => "?").join(",");
  const candidatos = db.prepare(`SELECT id,name,stage,etapa_ia_json FROM leads
    WHERE org_id=? AND sale_value IS NULL AND stage IN (${vagas})`).all(orgId, ...LINEAR);

  const conta = (sql, ...args) => db.prepare(sql).get(orgId, ...args).n;
  const fora = {
    venda_registrada: conta("SELECT COUNT(*) n FROM leads WHERE org_id=? AND sale_value IS NOT NULL"),
    etapa_manual: conta(`SELECT COUNT(*) n FROM leads WHERE org_id=? AND stage NOT IN (${vagas})`, ...LINEAR),
    sem_conversa: 0,
    confirmado_na_mao: 0,
  };

  /* Etapa que uma PESSOA confirmou depois da leitura da IA não é recalculada
     aqui — seria o sistema desfazendo o que alguém decidiu.

     O caso é real e apareceu na primeira tela: a IA lê "me manda o RG /
     mandei os dois", o corretor confirma Pasta, e a palavra "documentação"
     nunca foi escrita. Na reanálise seguinte o lead voltava para Atendimento,
     em silêncio. Duas regras brigando no mesmo campo, e quem perde é sempre a
     pessoa que clicou. */
  const confirmadoNaMao = (l) => {
    if (!l.etapa_ia_json) return false;
    try { return JSON.parse(l.etapa_ia_json).etapa === l.stage; } catch { return false; }
  };

  const daConversa = db.prepare("SELECT direction,body,media_url FROM messages WHERE lead_id=? ORDER BY created_at ASC");
  const mudancas = [];
  let comConversa = 0;

  /* ===== POR QUE O FUNIL NÃO ANDA =====

     "O avanço por palavra-chave não está funcionando" pode ser três coisas bem
     diferentes, e o conserto de cada uma é outro:

     - a palavra nunca é dita na conversa (é treino de equipe, não é código);
     - a conversa acontece por ÁUDIO, e áudio não tem texto para procurar
       (aí nenhuma regra de palavra vai funcionar, hoje ou nunca);
     - o gatilho existe mas não casa com o jeito que a equipe escreve
       (aí é código, e dá para consertar aqui).

     Sem separar as três, a gente mexeria no regex torcendo para acertar. Estes
     contadores dizem qual das três é, antes de mexer em qualquer coisa. */
  const diag = { sem_gatilho: 0, so_midia: 0, mensagens: 0, mensagens_sem_texto: 0 };
  const porGatilho = new Map(GATILHOS.map(g => [g.etapa, { etapa: g.etapa, palavra: g.palavra, leads: 0 }]));
  // Rótulo que o próprio CRM grava quando a mensagem é só mídia: não é conversa,
  // é o nome do anexo. Contar isso como texto inflaria o diagnóstico.
  const soRotulo = /^(foto|video|vídeo|audio|áudio|documento|\[.*\])$/i;

  for (const l of candidatos) {
    if (confirmadoNaMao(l)) { fora.confirmado_na_mao++; continue; }
    const msgs = daConversa.all(l.id);
    if (!msgs.length) { fora.sem_conversa++; continue; }
    comConversa++;

    diag.mensagens += msgs.length;
    const semTexto = msgs.filter(m => !String(m.body || "").trim() || soRotulo.test(String(m.body).trim()));
    diag.mensagens_sem_texto += semTexto.length;
    if (semTexto.length === msgs.length) diag.so_midia++;

    const bateram = gatilhosNaConversa(msgs);
    if (!bateram.length) diag.sem_gatilho++;
    for (const g of bateram) porGatilho.get(g.etapa).leads++;

    const novo = inferStage("Lead", msgs);
    if (novo !== l.stage) mudancas.push({ id: l.id, nome: l.name, de: l.stage, para: novo });
  }

  /* APLICAR AQUI NÃO MOVE MAIS NADA: grava a RECOMENDAÇÃO em cada lead.

     Até 26/08/2026 este botão reposicionava centenas de leads de uma vez pela
     palavra-chave. Saiu junto com o avanço automático, e pelo mesmo motivo: o
     gestor não tinha como conferir 300 mudanças antes de aplicar, e depois não
     dava para separar o que era leitura de gente do que era palpite de regra.

     Agora cada lead recebe a sugestão e ela aparece na ficha e no popup do
     funil, para ser confirmada uma a uma por quem conhece o atendimento. */
  if (aplicar && mudancas.length) {
    const agora = Date.now();
    const gravar = db.transaction(() => {
      for (const m of mudancas)
        db.prepare("UPDATE leads SET sugestao_etapa=?, sugestao_de=?, sugestao_em=? WHERE id=? AND org_id=?")
          .run(m.para, m.de, agora, m.id, req.user.org_id);
    });
    gravar();
  }

  // Agrupado por "de → para": é assim que dá para conferir de bate-pronto se o
  // resultado faz sentido antes de aplicar.
  const mapa = new Map();
  for (const m of mudancas) {
    const k = `${m.de} ${m.para}`;
    if (!mapa.has(k)) mapa.set(k, { de: m.de, para: m.para, quantos: 0 });
    mapa.get(k).quantos++;
  }
  const ordem = (s) => LINEAR.indexOf(s);
  return {
    aplicado: !!aplicar,
    // O que "aplicado" quer dizer agora: recomendações gravadas, nada movido.
    so_recomendacao: true,
    com_conversa: comConversa,
    fora,
    mudam: mudancas.length,
    resumo: [...mapa.values()].sort((a, b) => b.quantos - a.quantos || ordem(a.de) - ordem(b.de)),
    exemplos: mudancas.slice(0, 15),
    diagnostico: {
      ...diag,
      // "Nenhuma palavra apareceu" só quer dizer alguma coisa comparado com o
      // total: 40 de 45 é problema de regra; 40 de 900 é ruído.
      com_gatilho: comConversa - diag.sem_gatilho,
      gatilhos: [...porGatilho.values()],
    },
  };
}

/* ===== ARRUMAR A BASE INTEIRA =====

   Duas operações de gestor, as duas com PRÉVIA antes de aplicar. Mexer em
   centenas de leads de uma vez é o tipo de coisa que não se desfaz na mão.

   Só ADM: é decisão sobre a base da imobiliária, e a segunda gasta dinheiro. */
/* ===== MOVER OS LEADS DE UMA PESSOA PARA OUTRO FUNIL =====

   Sem isto, ter vários funis não serve para nada: criar o funil do SDR não
   muda nada se os leads que deveriam estar nele continuam no comercial, e
   mover trezentos leads um a um não é uma opção que se ofereça a alguém.

   `soDono` não: é ADM como as outras operações em massa. Mexe na base inteira
   da imobiliária e não se desfaz na mão. */
r.get("/lote/mover-funil", roles("adm"), (req, res) => {
  const r1 = previaMoverFunil(req.user.org_id, {
    userId: req.query.user_id, pipelineId: req.query.pipeline_id,
    stageId: req.query.stage_id || null,
    manterEtapa: req.query.manter === "1" });
  if (r1.erro) return res.status(400).json({ error: r1.erro });
  res.json(r1);
});

r.post("/lote/mover-funil", roles("adm"), (req, res) => {
  const r1 = moverParaFunil(req.user.org_id, {
    userId: req.body?.user_id, pipelineId: req.body?.pipeline_id,
    stageId: req.body?.stage_id || null,
    manterEtapa: !!req.body?.manter_etapa, quemMandou: req.user.id });
  if (r1.erro) return res.status(400).json({ error: r1.erro });
  res.json(r1);
});

r.get("/lote/temperatura", roles("adm"), (req, res) =>
  res.json(previaTemperatura(req.user.org_id, String(req.query.t || "MORNO").toUpperCase())));

r.post("/lote/temperatura", roles("adm"), (req, res) => {
  const t = String(req.body?.temperatura || "").toUpperCase();
  if (!["QUENTE", "MORNO", "FRIO"].includes(t))
    return res.status(400).json({ error: "Temperatura inválida." });
  res.json(limparTemperatura(req.user.org_id, t));
});

// Prévia da leitura de etapa por IA: quantos leads, de quem, e quanto custa.
r.get("/lote/etapa-ia", roles("adm"), (req, res) => res.json(previaEtapaIA(req.user.org_id)));

/* Roda a IA num pedaço da fila. A tela chama de novo enquanto `restam > 0`.

   Em pedaços porque são centenas de conversas: uma requisição só levaria
   minutos e o navegador desistiria no meio, sem ninguém saber o que foi feito. */
r.post("/lote/etapa-ia", roles("adm"), async (req, res) => {
  const limite = Math.min(Math.max(Number(req.body?.limite) || 20, 1), 40);
  const out = await rodarEtapaIA(req.user.org_id, { limite, userId: req.user.id });
  if (out.erro) return res.status(503).json({ error: out.erro });
  res.json(out);
});

/* ===== TEMPERATURA LIDA PELA IA, UM CORRETOR POR VEZ =====

   A lista de quem pode ser analisado, com quantos leads cada um tem na mão. */
r.get("/lote/temperatura-ia", roles("adm"), (req, res) =>
  res.json(corretoresParaTemperatura(req.user.org_id)));

// Prévia de UM corretor: quantos seriam lidos, quantos já foram, e o preço.
r.get("/lote/temperatura-ia/:corretorId", roles("adm"), (req, res) => {
  const out = previaTemperaturaIA(req.user.org_id, req.params.corretorId);
  if (out.erro) return res.status(400).json({ error: out.erro });
  res.json(out);
});

// Roda um pedaço. A tela chama de novo enquanto `restam > 0`.
r.post("/lote/temperatura-ia/:corretorId", roles("adm"), async (req, res) => {
  const limite = Math.min(Math.max(Number(req.body?.limite) || 20, 1), 40);
  const out = await rodarTemperaturaIA(req.user.org_id,
    { corretorId: req.params.corretorId, limite, userId: req.user.id });
  if (out.erro) return res.status(400).json({ error: out.erro });
  res.json(out);
});

/* Religar o robô num lead específico. `POST /leads/:id/robo`

   Só a supervisão: é a mesma decisão de ligar o robô, tomada num atendimento
   só. O corretor não entra porque, se o lead está com ele, o robô não fala de
   qualquer jeito — a trava do dono continua valendo depois de religar. */
/* ===== OBSERVAÇÕES DO LEAD =====

   O quadro de recados do atendimento. Quem pode ABRIR a conversa pode ler e
   escrever: o corretor dono do lead e a supervisão. É de propósito que a
   atendente escreva na ficha de um lead que já é do corretor — o caso que
   motivou o recurso é exatamente esse, ela deixar o aviso antes de repassar.

   Apagar é mais restrito: o autor apaga o que escreveu, e a supervisão apaga
   qualquer um. O corretor não apaga o recado que a atendente deixou para ele. */
r.get("/:id/observacoes", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  res.json({ observacoes: observacoesDoLead(lead.id) });
});

r.post("/:id/observacoes", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "Escreva a observação." });

  db.prepare(`INSERT INTO observacoes (id,org_id,lead_id,texto,autor_id,created_at)
    VALUES (?,?,?,?,?,?)`).run("ob_" + randomUUID(), lead.org_id, lead.id,
      texto.slice(0, 1000), req.user.id, Date.now());
  res.json({ observacoes: observacoesDoLead(lead.id) });
});

r.delete("/:id/observacoes/:obsId", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const obs = db.prepare("SELECT * FROM observacoes WHERE id = ? AND lead_id = ?").get(req.params.obsId, lead.id);
  if (!obs) return res.status(404).json({ error: "Observação não encontrada" });
  // O recado que a atendente deixou para o corretor não é dele para apagar.
  if (obs.autor_id !== req.user.id && !supervisiona(req.user))
    return res.status(403).json({ error: "Só quem escreveu pode apagar esta observação." });

  db.prepare("DELETE FROM observacoes WHERE id = ?").run(obs.id);
  res.json({ observacoes: observacoesDoLead(lead.id) });
});

r.post("/:id/robo", roles("adm", "sdr"), (req, res) => {
  const out = ligarNoLead(req.user.org_id, req.params.id, req.body?.ativo !== false);
  if (out.erro) return res.status(404).json({ error: out.erro });
  res.json(out);
});

/* A gestão cutuca um atendimento parado: o corretor recebe o aviso no celular
   e o pedido fica marcado no lead. `POST /leads/:id/cutucar` */
r.post("/:id/cutucar", roles("adm", "sdr"), async (req, res) => {
  const out = await cutucar({ orgId: req.user.org_id, leadId: req.params.id,
    autor: req.user, recado: req.body && req.body.recado });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// O corretor dá o "vi". Só quem está com o lead — e a supervisão, para poder
// limpar um pedido feito por engano.
r.post("/:id/cutucar/vi", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(req.params.id, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: "Este lead não está com você" });
  limparCutucada(lead.id);
  res.json({ ok: true });
});

// Conferir antes (GET) e aplicar depois (POST). Mexer na etapa da base inteira
// de uma vez não é coisa para acontecer por engano num clique.
r.get("/reanalise", roles("adm"), (req, res) => res.json(reanalisar(req.user.org_id, false)));
r.post("/reanalise", roles("adm"), (req, res) => res.json(reanalisar(req.user.org_id, true)));

// Gestor e atendente abrem a conversa de qualquer um da PRÓPRIA imobiliária; o
// corretor fica nos leads dele. A regra mora em auth.js para valer igual aqui e
// nas rotas de mensagem — duas cópias da mesma regra é como uma delas fica para
// trás. Antes desta checagem, qualquer usuário logado lia qualquer lead pelo id.
const podeVer = podeVerLead;

/* As observações, da mais nova para a mais antiga: o recado de agora é o que
   interessa quando o corretor abre a conversa com o cliente esperando. */
function observacoesDoLead(leadId) {
  return db.prepare(`SELECT o.id, o.texto, o.autor_id, o.created_at, u.name AS autor
    FROM observacoes o LEFT JOIN users u ON u.id = o.autor_id
    WHERE o.lead_id = ? ORDER BY o.created_at DESC`).all(leadId);
}

/* A RECOMENDAÇÃO DE ETAPA, e quando ela deixa de valer.

   A palavra-chave não move mais o lead (ver `sugerirEtapa`). Ela recomenda, e
   a recomendação fica esperando alguém confirmar.

   `sugestao_de` é a etapa em que o lead estava quando a leitura foi feita. Se
   ele andou desde então — na mão, pela IA, por venda — a recomendação é velha
   e some. Confirmar uma leitura feita sobre outro estado moveria o lead para
   uma etapa que já foi superada, e ninguém entenderia o retrocesso. */
function sugestaoGuardada(lead) {
  if (!lead.sugestao_etapa || lead.sugestao_de !== lead.stage) return null;
  const g = GATILHOS.find(x => x.etapa === lead.sugestao_etapa);
  return {
    para: lead.sugestao_etapa,
    de: lead.sugestao_de,
    em: lead.sugestao_em || null,
    // A palavra que disparou: sem ela a tela diria "mude para Pasta" sem dizer
    // por quê, e uma recomendação sem motivo não dá para conferir.
    palavra: g ? g.palavra : null,
  };
}

r.get("/:id", (req, res) => {
  const lead = db.prepare(`${SELECT_LEAD} WHERE l.id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  /* A mensagem citada vem junto, já resolvida. Montar isso no navegador daria
     na mesma para uma conversa, mas o CRM recarrega a conversa aberta a cada
     dez segundos — é conta repetida à toa em todo aparelho da equipe. */
  const messages = db.prepare(`
    SELECT m.*,
      q.body AS reply_body, q.direction AS reply_direction,
      q.from_name AS reply_from_name, q.media_mime AS reply_media_mime,
      q.wa_id AS reply_wa_id
    FROM messages m
    LEFT JOIN messages q ON q.id = m.reply_to
    WHERE m.lead_id = ? ORDER BY m.created_at ASC`).all(lead.id);

  /* As ligações entram na MESMA linha do tempo da conversa.

     Ligação não é mensagem e não vai para a tabela de mensagens — mas para
     quem lê o atendimento é o mesmo fio: "mandei foto, liguei, não atendeu,
     mandei mensagem". Separadas em outro lugar, ninguém cruzaria as duas
     coisas de cabeça. A junção é só na leitura. */
  const ligacoes = db.prepare(`
    SELECT g.id, g.created_at, g.resultado, g.obs, u.name AS quem
    FROM ligacoes g LEFT JOIN users u ON u.id = g.user_id
    WHERE g.lead_id = ? ORDER BY g.created_at ASC`).all(lead.id)
    .map(g => ({ ...g, tipo: "ligacao", direction: "sys", body: "" }));

  const linhaDoTempo = [...messages, ...ligacoes].sort((a, b) => a.created_at - b.created_at);
  const etapas = historicoDoLead(lead.id);
  res.json({ ...parse(lead), messages: linhaDoTempo, resumo: resumoGuardado(lead, messages.length),
    etapa_ia: etapaIaGuardada(lead, messages.length),
    // A etapa que a CONVERSA sugere, e que ninguém aplicou ainda.
    sugestao_etapa: sugestaoGuardada(lead),
    // Nome diferente do resumo que a LISTA manda (`tarefas`): um é a lista
    // inteira, o outro é "quantas em aberto e qual a próxima". Mesmo nome para
    // formatos diferentes é armadilha para quem vier depois.
    lista_tarefas: listarTarefas(lead.id),
    historico_etapas: etapas,
    // Desde quando está na etapa atual — a última entrada que aponta para ela.
    etapa_desde: lead.stage_entered_at
      || [...etapas].reverse().find(e => e.para === lead.stage)?.created_at || null,
    /* ONDE ESTE LEAD ESTA, NO VOCABULARIO DA EMPRESA.

       A ficha mostrava só o nome da etapa. Com funil configurável isso deixou
       de bastar: a mesma tela atende uma imobiliária com cinco funis, e "está
       em Visita" não diz em qual deles. Vai junto o SLA — o cronômetro que
       responde "este atendimento está abandonado?" sem ninguém ter que
       procurar. */
    pipeline: lead.pipeline_id ? pipelinePorId(lead.org_id, lead.pipeline_id) : null,
    etapa: lead.stage_id ? etapaPorId(lead.org_id, lead.stage_id) : null,
    sla: lead.stage_id ? slaDoLead(etapaPorId(lead.org_id, lead.stage_id), lead) : null,
    // Por onde passou: funil e dono. Outra pergunta que o histórico de etapas
    // não responde.
    transferencias: transferenciasDoLead(lead.id),
    // O robô do fora-do-expediente, neste lead. Só a supervisão liga e desliga,
    // então só ela recebe o cartão.
    robo: supervisiona(req.user) ? estadoNoLead(lead.org_id, lead.id) : null,
    // Junto com o lead: a faixa de observações precisa aparecer no mesmo
    // instante em que a conversa abre, e não uma requisição depois.
    observacoes: observacoesDoLead(lead.id) });
});

/* O resumo que já está no banco, com a informação que muda tudo: quantas
   mensagens entraram DEPOIS dele. Resumo de ontem mostrado como se fosse de
   agora é pior do que resumo nenhum — o corretor age com base em algo que já
   mudou. */
function resumoGuardado(lead, quantasMensagens) {
  if (!lead.resumo_json) return { disponivel: iaConfigurada(), gerado: null };
  let dados = null;
  try { dados = JSON.parse(lead.resumo_json); } catch { return { disponivel: iaConfigurada(), gerado: null }; }
  return {
    disponivel: iaConfigurada(),
    gerado: { ...dados, em: lead.resumo_em || null },
    novas: Math.max(0, quantasMensagens - (lead.resumo_msgs || 0)),
  };
}

/* Resumir a conversa (IA).

   Só quem já pode abrir a conversa pode pedir o resumo — é o mesmo conteúdo,
   lido de outro jeito. O texto sai do servidor e vai para o provedor de IA:
   por isso a chamada é sob demanda, num clique consciente, e nunca automática
   em toda conversa aberta. */
r.post("/:id/resumo", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  if (!iaConfigurada()) return res.status(503).json({ error: "O resumo automático não está ligado nesta instalação." });

  const msgs = db.prepare("SELECT direction, body FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id);
  const r2 = await resumirConversa({
    nome: lead.name,
    mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "imobiliaria", texto: m.body })),
  });
  if (!r2.ok) return res.status(422).json({ error: r2.erro });

  db.prepare("UPDATE leads SET resumo_json = ?, resumo_em = ?, resumo_msgs = ? WHERE id = ?")
    .run(JSON.stringify(r2.resumo), Date.now(), msgs.length, lead.id);
  /* Fica registrado quem clicou: é dinheiro saindo, e a gestão precisa poder
     responder "quanto já usamos e quem usou" sem caçar linha de log. */
  registrarUsoIA({ orgId: lead.org_id, userId: req.user.id, leadId: lead.id, recurso: "resumo", uso: r2.uso });
  if (r2.uso) console.log(`[ia] resumo de ${lead.name}: ${r2.uso.entrada} tokens de entrada, ${r2.uso.saida} de saída`);
  res.json({ ok: true, resumo: { ...r2.resumo, em: Date.now() }, novas: 0 });
});

/* ===== A IA LÊ A CONVERSA E DIZ EM QUE ETAPA O LEAD ESTÁ =====

   A palavra-chave só acerta quando a palavra é dita. "Me manda seus
   comprovantes" é Pasta e nenhum gatilho pega; "já fui lá ver ontem" é Visita
   e nenhum gatilho pega. Quem lê a conversa inteira entende.

   O QUE ESTA ROTA NÃO FAZ: gravar a etapa. Ela devolve a sugestão com o motivo
   e o trecho que a sustenta, e para por aí. Quem muda o funil é o corretor,
   no botão, pela rota manual de sempre — a mesma que registra que foi ele.

   Não é preciosismo: a etapa alimenta o relatório que vira cobrança em
   reunião. Se o número mudar sozinho, o corretor descobre na reunião que o
   sistema disse uma coisa que ele não fez, e aí ninguém confia em nada. */
r.post("/:id/etapa-ia", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  if (!iaConfigurada()) return res.status(503).json({ error: "A leitura de etapa por IA não está ligada nesta instalação." });

  const msgs = db.prepare("SELECT direction, body FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id);
  const r2 = await etapaDaConversa({
    nome: lead.name,
    mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "imobiliaria", texto: m.body })),
  });
  if (!r2.ok) return res.status(422).json({ error: r2.erro });

  db.prepare("UPDATE leads SET etapa_ia_json = ?, etapa_ia_em = ?, etapa_ia_msgs = ? WHERE id = ?")
    .run(JSON.stringify(r2.sugestao), Date.now(), msgs.length, lead.id);
  registrarUsoIA({ orgId: lead.org_id, userId: req.user.id, leadId: lead.id, recurso: "etapa", uso: r2.uso });
  if (r2.uso) console.log(`[ia] etapa de ${lead.name}: ${r2.sugestao.etapa} (${r2.sugestao.confianca}) — ${r2.uso.entrada} tokens de entrada, ${r2.uso.saida} de saída`);
  res.json({ ok: true, sugestao: { ...r2.sugestao, em: Date.now() }, atual: lead.stage, novas: 0 });
});

/* A sugestão guardada, com a informação que decide se ela ainda vale: quantas
   mensagens entraram depois dela, e se o lead já se mexeu desde então. */
function etapaIaGuardada(lead, quantasMensagens) {
  if (!lead.etapa_ia_json) return { disponivel: iaConfigurada(), sugestao: null };
  let dados = null;
  try { dados = JSON.parse(lead.etapa_ia_json); } catch { return { disponivel: iaConfigurada(), sugestao: null }; }
  return {
    disponivel: iaConfigurada(),
    sugestao: { ...dados, em: lead.etapa_ia_em || null },
    novas: Math.max(0, quantasMensagens - (lead.etapa_ia_msgs || 0)),
    // Sugestão que aponta para onde o lead já está não é sugestão: a tela some
    // com ela em vez de pedir para confirmar o que já está feito.
    igual_a_atual: dados.etapa === lead.stage,
  };
}

// Marca a conversa como lida até agora. A ADM supervisionando NÃO marca:
// senão ela apagaria o aviso de "cliente aguardando" do corretor.
r.post("/:id/read", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Sem acesso a este lead" });
  if (supervisiona(req.user) && lead.assigned_to !== req.user.id)
    return res.json({ ok: true, ignorado: "supervisão não marca como lida" });
  db.prepare("UPDATE leads SET last_read_at = ? WHERE id = ?").run(Date.now(), lead.id);
  res.json({ ok: true });
});

// Marca como NÃO lida: abrir a conversa marca como lida sozinho, então sem isto
// o botão de leitura seria um clique sem efeito. Serve para o atendente deixar
// o aviso vermelho de propósito e voltar depois. Recua a leitura para logo antes
// da última mensagem do cliente — volta a pendência, sem inventar mensagem nova.
r.post("/:id/nao-lida", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Sem acesso a este lead" });
  const ultima = db.prepare(
    "SELECT created_at FROM messages WHERE lead_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1"
  ).get(lead.id);
  if (!ultima) return res.json({ ok: true, ignorado: "o cliente ainda não mandou mensagem" });
  db.prepare("UPDATE leads SET last_read_at = ? WHERE id = ?").run(ultima.created_at - 1, lead.id);
  res.json({ ok: true });
});

// Finaliza o atendimento: a conversa sai da caixa de entrada e para de cobrar
// resposta. A etapa do funil NÃO muda — encerra o atendimento, não o negócio.
// Se o lead voltar a mandar mensagem, o webhook reabre sozinho (ver messages).
r.post("/:id/finalizar", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET closed_at = ?, last_read_at = ? WHERE id = ?").run(Date.now(), Date.now(), lead.id);
  res.json({ ok: true, finalizado: true });
});

r.post("/:id/reabrir", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET closed_at = NULL WHERE id = ?").run(lead.id);
  res.json({ ok: true, finalizado: false });
});

// Registro de tentativa de ligação. O botão "Ligar" abre o discador do
// aparelho e o navegador não fica sabendo se atenderam — então guardamos a
// TENTATIVA. Serve ao score: mostra quem está correndo atrás do lead.
r.post("/:id/ligacao", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  const id = "lig_" + randomUUID();
  db.prepare("INSERT INTO ligacoes (id,lead_id,user_id,created_at) VALUES (?,?,?,?)")
    .run(id, lead.id, req.user.id, Date.now());
  // Devolve o id: é com ele que a tela grava, logo depois, o que aconteceu.
  res.json({ ok: true, ligacao_id: id });
});

/* O que aconteceu na ligação, respondido no popup depois da chamada.

   Sem isto o relatório contava toques no botão. "Fez 20 ligações" e "falou com
   3 pessoas" são coisas muito diferentes na hora de cobrar, e só a segunda diz
   alguma coisa sobre o atendimento.

   Fica separado do registro da tentativa de propósito: a chamada é registrada
   na hora do clique (senão o corretor sai para o discador e nunca volta), e o
   resultado entra quando ele volta. Se não voltar, a tentativa continua lá,
   como era antes. */
const RESULTADOS = {
  falou: "Falei com o cliente",
  nao_atendeu: "Não atendeu",
  caixa_postal: "Caiu na caixa postal",
  numero_errado: "Número errado ou não existe",
};

r.patch("/:id/ligacao/:ligId", (req, res) => {
  const { resultado, obs } = req.body || {};
  if (!RESULTADOS[resultado]) return res.status(400).json({ error: "Resultado inválido." });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const lig = db.prepare("SELECT * FROM ligacoes WHERE id = ? AND lead_id = ?").get(req.params.ligId, lead.id);
  if (!lig) return res.status(404).json({ error: "Ligação não encontrada." });
  // Quem ligou é quem diz o que aconteceu — a gestão não adivinha por ele.
  if (lig.user_id !== req.user.id) return res.status(403).json({ error: "Essa ligação foi de outra pessoa." });

  db.prepare("UPDATE ligacoes SET resultado=?, obs=?, respondido_em=? WHERE id=?")
    .run(resultado, String(obs || "").trim().slice(0, 300) || null, Date.now(), lig.id);
  res.json({ ok: true, rotulo: RESULTADOS[resultado] });
});

/* ── Simulação de financiamento ─────────────────────────────────────────────
   A simulação acontece no site da Caixa; aqui a gente registra o resultado,
   guarda no histórico do lead e manda o resumo para o cliente.

   Fica no lead, e não no catálogo de imóveis, porque simulação é de PESSOA:
   os números dependem da renda e do subsídio de quem vai comprar. */

r.get("/:id/simulacoes", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  res.json({
    ia: iaConfigurada(),
    simulacoes: db.prepare("SELECT * FROM simulacoes WHERE lead_id = ? ORDER BY created_at DESC").all(lead.id),
  });
});

/* Lê o print e devolve um RASCUNHO. Não grava nada de propósito: o corretor
   confere na tela antes. Número de financiamento errado indo para o cliente é
   estrago que não se desfaz com pedido de desculpas. */
r.post("/:id/simulacao/ler", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  const { base64, mime } = req.body || {};
  const r1 = await lerPrintSimulacao({ base64, mime });
  if (!r1.ok) return res.status(422).json({ error: r1.erro });
  registrarUsoIA({ orgId: lead.org_id, userId: req.user.id, leadId: lead.id, recurso: "print_simulacao", uso: r1.uso });
  res.json({ rascunho: r1.dados });
});

const numero = (v) => { const n = Number(v); return isFinite(n) && n >= 0 ? n : null; };

r.post("/:id/simulacao", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  const b = req.body || {};
  if (numero(b.parcela) == null && numero(b.valor_imovel) == null)
    return res.status(400).json({ error: "Informe ao menos o valor do imóvel ou a parcela." });

  // O print fica guardado junto: dá para conferir de onde veio o número meses depois.
  let printUrl = null;
  if (b.print_base64 && b.print_mime) {
    try {
      const buffer = Buffer.from(String(b.print_base64).replace(/^data:[^;]+;base64,/, ""), "base64");
      if (buffer.length) ({ url: printUrl } = await salvar({ buffer, mime: b.print_mime, prefixo: "simulacoes" }));
    } catch (e) { console.warn("[simulacao] print não foi guardado:", e.message); }
  }

  const id = "sim_" + randomUUID();
  db.prepare(`INSERT INTO simulacoes
    (id,lead_id,org_id,user_id,valor_imovel,entrada,subsidio,financiado,prazo_meses,parcela,juros_aa,renda,
     modalidade,observacoes,print_url,origem,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, lead.id, req.user.org_id, req.user.id,
    numero(b.valor_imovel), numero(b.entrada), numero(b.subsidio), numero(b.financiado),
    numero(b.prazo_meses), numero(b.parcela), numero(b.juros_aa), numero(b.renda),
    (b.modalidade || "").trim().slice(0, 60) || null, (b.observacoes || "").trim().slice(0, 400) || null,
    printUrl, b.origem === "print" ? "print" : "manual", Date.now());

  /* A simulação preenche a qualificação do lead. Renda e entrada estavam
     vazias na ficha e o corretor teria que digitar duas vezes a mesma coisa.
     Só preenche o que está em branco: informação conferida por pessoa não
     pode ser sobrescrita por leitura de imagem. */
  const qual = JSON.parse(lead.qual_json || "{}");
  const moeda = (v) => v == null ? null : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  if (!qual.renda && numero(b.renda) != null) qual.renda = moeda(numero(b.renda));
  if (!qual.entrada && numero(b.entrada) != null) qual.entrada = moeda(numero(b.entrada));
  db.prepare("UPDATE leads SET qual_json = ? WHERE id = ?").run(JSON.stringify(qual), lead.id);

  res.json({ ok: true, simulacao: db.prepare("SELECT * FROM simulacoes WHERE id = ?").get(id) });
});

// Monta o resumo do jeito que o cliente lê — sem jargão e sem prometer nada
// que a análise de crédito ainda pode mudar.
export function textoDaSimulacao(s, nomeImovel) {
  const moeda = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const l = ["*Simulação de financiamento*"];
  if (nomeImovel) l.push(`🏠 ${nomeImovel}`);
  if (s.valor_imovel) l.push(`Valor do imóvel: ${moeda(s.valor_imovel)}`);
  if (s.entrada) l.push(`Entrada: ${moeda(s.entrada)}`);
  if (s.subsidio) l.push(`Subsídio: ${moeda(s.subsidio)}`);
  if (s.financiado) l.push(`Financiado: ${moeda(s.financiado)}`);
  if (s.prazo_meses) l.push(`Prazo: ${s.prazo_meses} meses`);
  if (s.parcela) l.push(`*Primeira parcela: ${moeda(s.parcela)}*`);
  if (s.juros_aa) l.push(`Juros: ${String(s.juros_aa).replace(".", ",")}% ao ano`);
  if (s.modalidade) l.push(`Programa: ${s.modalidade}`);
  if (s.observacoes) l.push("", s.observacoes);
  l.push("", "_Simulação feita no site oficial da Caixa. Os valores podem mudar conforme a análise de crédito._");
  return l.join("\n");
}

r.post("/:id/simulacao/:simId/enviar", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  const sim = db.prepare("SELECT * FROM simulacoes WHERE id = ? AND lead_id = ?").get(req.params.simId, lead.id);
  if (!sim) return res.status(404).json({ error: "Simulação não encontrada" });

  const produto = lead.produto_id ? db.prepare("SELECT titulo FROM produtos WHERE id = ?").get(lead.produto_id) : null;
  const texto = textoDaSimulacao(sim, produto?.titulo);
  const firstName = (req.user.name || "").split(" ")[0];
  try {
    await sendText({ orgId: lead.org_id, toPhone: lead.phone, text: texto, signedBy: firstName });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const agora = Date.now();
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName, texto, agora);
  db.prepare("UPDATE simulacoes SET enviada_em = ? WHERE id = ?").run(agora, sim.id);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(agora, lead.id);
  advanceStage(lead.id);
  res.json({ ok: true });
});

r.delete("/:id/simulacao/:simId", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("DELETE FROM simulacoes WHERE id = ? AND lead_id = ?").run(req.params.simId, lead.id);
  res.json({ ok: true });
});

/* Qualificação do lead editável na mão. Os campos existiam na ficha mas eram
   só leitura: vinham do formulário da Meta e, se o cliente contasse a renda na
   conversa, não havia onde anotar. */
r.patch("/:id/qualificacao", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  const permitidos = ["renda", "entrada", "situacao", "cpf", "prazo"];
  const qual = JSON.parse(lead.qual_json || "{}");
  for (const campo of permitidos) {
    if (!(campo in (req.body || {}))) continue;
    const v = String(req.body[campo] ?? "").trim().slice(0, 80);
    if (v) qual[campo] = v; else delete qual[campo];
  }
  db.prepare("UPDATE leads SET qual_json = ? WHERE id = ?").run(JSON.stringify(qual), lead.id);
  res.json({ ok: true, qual });
});

// Ajuste manual de etapa. NÃO existe mais avanço automático: desde 26/08/2026 a
// palavra na conversa apenas recomenda (ver `sugerirEtapa`), e quem grava a
// etapa é sempre uma pessoa — aqui, na confirmação da recomendação, ou no
// registro da venda.
r.patch("/:id/stage", (req, res) => {
  const { stage, stage_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  if (!stage && !stage_id) return res.status(400).json({ error: "Diga para qual etapa." });
  /* `motivo` separa a mudança feita na mão da que veio da leitura da IA. As
     duas são cliques de gente — mas saber que a segunda partiu de uma sugestão
     é o que permite, depois, medir se a IA está acertando. */
  const motivo = req.body?.origem === "ia" ? "ia" : "mao";

  /* A validação saiu da lista fixa STAGES e passou a ser o funil DA
     IMOBILIÁRIA. Com etapa configurável, recusar o que não está na lista do
     código recusaria justamente as etapas que a empresa criou.

     Quem responde agora é o moverLead: ele resolve o destino no funil do lead,
     confere os campos que a etapa exige e roda a automação. Etapa que não
     existe volta como erro de destino. */
  const r1 = moverLead({ leadId: lead.id, para: stage || null, paraEtapaId: stage_id || null,
    motivo, userId: req.user.id });

  if (r1.erro) return res.status(400).json({ error: r1.erro });
  /* 422 e não 400: o pedido está bem formado, o que falta é dado do lead. A
     tela usa isso para abrir os campos em vez de mostrar "deu erro". */
  if (r1.bloqueado) return res.status(422).json(r1);
  res.json(r1);
});

/* Corrigir o nome do lead.

   O nome que entra pelo WhatsApp é o que a PESSOA escolheu no aparelho dela:
   às vezes é "Jr 🏡", às vezes é o número puro, às vezes é o nome do marido. O
   CRM guardava aquilo e não havia como arrumar — e é esse nome que aparece na
   lista de conversas, no relatório e na assinatura da mensagem.

   Quem atende corrige, e a supervisão também. Não precisa ser só do gestor:
   quem descobre o nome verdadeiro é justamente quem está conversando.

   O nome só é gravado quando o lead nasce (ver uazapi.webhook.js), nunca
   atualizado depois — então a correção feita aqui não corre risco de ser
   desfeita pela próxima mensagem que chegar. */
/* CONFIRMAR OU DISPENSAR A RECOMENDAÇÃO DE ETAPA.

   Confirmar grava com `motivo='mao'` — porque foi mesmo uma pessoa que
   decidiu. É o que faz a etapa contar como confirmada no score (as visitas do
   relatório só contam quando alguém confirmou) e o que permite, meses depois,
   separar o funil que a equipe leu do funil que a máquina chutou.

   Dispensar apaga a recomendação sem mexer na etapa. Não é "ignorar por
   enquanto": é dizer que a leitura estava errada. Se a conversa continuar e a
   palavra aparecer de novo, a recomendação volta — e aí é uma pergunta nova
   sobre uma conversa nova, não a mesma insistindo.

   Quem confirma é quem pode abrir a conversa: dono e supervisão. */
r.post("/:id/sugestao-etapa", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  const limpar = () => db.prepare(
    "UPDATE leads SET sugestao_etapa=NULL, sugestao_de=NULL, sugestao_em=NULL WHERE id=?").run(lead.id);

  if (req.body?.acao === "dispensar") { limpar(); return res.json({ ok: true, etapa: lead.stage }); }

  const para = lead.sugestao_etapa;
  if (!para) return res.status(400).json({ error: "Não há recomendação para este lead." });
  /* A recomendação foi feita sobre a etapa em que o lead estava naquele
     momento. Se ele andou desde então, aplicar agora seria movê-lo para trás
     sem ninguém ter pedido. */
  if (lead.sugestao_de !== lead.stage) {
    limpar();
    return res.status(409).json({ error: "O lead mudou de etapa depois desta leitura — a recomendação foi descartada." });
  }
  if (!STAGES.includes(para)) { limpar(); return res.status(400).json({ error: "Etapa inválida." }); }

  moverEtapa({ leadId: lead.id, para, motivo: "mao", userId: req.user.id, de: lead.stage });
  limpar();
  console.log(`[etapa] ${req.user.name} confirmou "${lead.name}": ${lead.stage} -> ${para}`);
  res.json({ ok: true, etapa: para });
});

r.patch("/:id/nome", (req, res) => {
  const nome = String(req.body?.nome || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!nome) return res.status(400).json({ error: "Escreva o nome do cliente." });
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET name = ? WHERE id = ?").run(nome, lead.id);
  console.log(`[lead] ${req.user.name} renomeou "${lead.name}" para "${nome}"`);
  res.json({ ok: true, nome });
});

// Registro da venda: valor do imóvel, data e qual unidade. Registrar a venda
// também move o lead para a etapa "Venda" — as duas coisas andam juntas.
r.patch("/:id/venda", (req, res) => {
  const { valor, data, imovel } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });

  // Valor vazio desfaz o registro (correção de engano).
  if (valor === null || valor === "") {
    db.prepare("UPDATE leads SET sale_value=NULL, sale_date=NULL, sale_property=NULL WHERE id=?").run(lead.id);
    return res.json({ ok: true, removido: true });
  }
  // Mesmo tratamento do catálogo: aceita 285000 e "285.000,50" sem virar 285.
  const v = numeroBR(valor);
  if (!v || v <= 0) return res.status(400).json({ error: "Informe um valor de venda válido." });

  const quando = data ? new Date(data).getTime() : Date.now();
  if (!isFinite(quando)) return res.status(400).json({ error: "Data da venda inválida." });

  db.prepare("UPDATE leads SET sale_value=?, sale_date=?, sale_property=? WHERE id=?")
    .run(v, quando, (imovel || "").trim() || null, lead.id);
  // A etapa vai junto, mas pelo caminho que deixa rastro — registrar venda é a
  // mudança de etapa que mais importa no histórico.
  moverEtapa({ leadId: lead.id, para: "Venda", motivo: "venda", userId: req.user.id });
  res.json({ ok: true, stage: "Venda" });
});

export default r;
