import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, roles, supervisiona, semMaster } from "../auth.js";
import { STAGES, LINEAR, normalizePhone, inferStage } from "../services/stages.js";
import { salvar } from "../services/storage.js";
import { lerPrintSimulacao, iaConfigurada } from "../services/ia.js";
import { sendText } from "../services/uazapi.js";
import { numero as numeroBR } from "./produtos.routes.js";
import { advanceStage } from "./messages.routes.js";
import { cutucar, limparCutucada } from "../services/alerta.js";

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
  res.json(rows.map(parse));
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
  const candidatos = db.prepare(`SELECT id,name,stage FROM leads
    WHERE org_id=? AND sale_value IS NULL AND stage IN (${vagas})`).all(orgId, ...LINEAR);

  const conta = (sql, ...args) => db.prepare(sql).get(orgId, ...args).n;
  const fora = {
    venda_registrada: conta("SELECT COUNT(*) n FROM leads WHERE org_id=? AND sale_value IS NOT NULL"),
    etapa_manual: conta(`SELECT COUNT(*) n FROM leads WHERE org_id=? AND stage NOT IN (${vagas})`, ...LINEAR),
    sem_conversa: 0,
  };

  const daConversa = db.prepare("SELECT direction,body FROM messages WHERE lead_id=? ORDER BY created_at ASC");
  const mudancas = [];
  let comConversa = 0;
  for (const l of candidatos) {
    const msgs = daConversa.all(l.id);
    if (!msgs.length) { fora.sem_conversa++; continue; }
    comConversa++;
    const novo = inferStage("Lead", msgs);
    if (novo !== l.stage) mudancas.push({ id: l.id, nome: l.name, de: l.stage, para: novo });
  }

  if (aplicar && mudancas.length) {
    const gravar = db.transaction(() => {
      const up = db.prepare("UPDATE leads SET stage=? WHERE id=?");
      for (const m of mudancas) up.run(m.para, m.id);
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
    com_conversa: comConversa,
    fora,
    mudam: mudancas.length,
    resumo: [...mapa.values()].sort((a, b) => b.quantos - a.quantos || ordem(a.de) - ordem(b.de)),
    exemplos: mudancas.slice(0, 15),
  };
}

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

// Gestor e atendente abrem a conversa de qualquer um. O corretor fica nos leads dele.
// Antes desta checagem, qualquer usuário logado lia qualquer lead pelo id.
function podeVer(user, lead) {
  if (!lead) return false;
  if (supervisiona(user)) return lead.org_id === user.org_id;
  return lead.assigned_to === user.id;
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
  res.json({ ...parse(lead), messages });
});

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
  db.prepare("INSERT INTO ligacoes (id,lead_id,user_id,created_at) VALUES (?,?,?,?)")
    .run("lig_" + randomUUID(), lead.id, req.user.id, Date.now());
  res.json({ ok: true });
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
    await sendText({ toPhone: lead.phone, text: texto, signedBy: firstName });
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

// Ajuste manual de etapa (o automático acontece no envio/recebimento de mensagem).
r.patch("/:id/stage", (req, res) => {
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ error: "Etapa inválida" });
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!podeVer(req.user, lead)) return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET stage = ? WHERE id = ?").run(stage, lead.id);
  res.json({ ok: true, stage });
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

  db.prepare("UPDATE leads SET sale_value=?, sale_date=?, sale_property=?, stage='Venda' WHERE id=?")
    .run(v, quando, (imovel || "").trim() || null, lead.id);
  res.json({ ok: true, stage: "Venda" });
});

export default r;
