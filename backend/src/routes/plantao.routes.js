/* Escala de plantão.

   A LISTA é aberta a toda a equipe: saber quem está de plantão amanhã é
   informação de operação, não de gestão — o corretor precisa se planejar e o
   colega precisa saber para quem ligar.

   MEXER na escala é da gestão (gestor e atendente), que é quem monta o mês. */

import { Router } from "express";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";
import { escala, doDia, definirTurno, limpar, importarEscala, marcarPresenca,
  meiaNoite, lerDia, TURNOS } from "../services/plantao.js";
import { lerXlsx } from "../services/xlsx.js";

const r = Router();
r.use(authRequired);

const DIA = 86400000;

/* O MÊS QUE A TELA ESTÁ MOSTRANDO, para as datas que vêm sem ano.

   Numa escala mensal a coluna costuma dizer só "01/09" — o mês está no título
   da planilha, não na célula. Sem uma referência, o servidor teria que
   adivinhar pelo relógio, e erraria toda vez que a escala do mês que vem fosse
   montada no mês anterior (que é quando ela é montada). A tela manda o mês que
   está aberto; foi ele que a pessoa escolheu antes de subir o arquivo. */
const refDe = (body) => {
  const t = body && body.mes ? new Date(String(body.mes) + "T12:00:00").getTime() : NaN;
  return isFinite(t) ? t : Date.now();
};

// Escala de um período. Sem parâmetros, o mês corrente.
r.get("/", (req, res) => {
  const hoje = new Date();
  const de = req.query.de ? new Date(req.query.de + "T12:00:00").getTime()
    : new Date(hoje.getFullYear(), hoje.getMonth(), 1).getTime();
  const ate = req.query.ate ? new Date(req.query.ate + "T12:00:00").getTime()
    : new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getTime();
  if (!isFinite(de) || !isFinite(ate)) return res.status(400).json({ error: "Período inválido." });

  const linhas = escala(req.user.org_id, { de, ate });
  /* Agrupado por dia já daqui: a tela mostra a escala em forma de calendário,
     e montar isso no navegador para 31 dias seria repetir a mesma conta em
     todo aparelho da equipe. */
  const porDia = new Map();
  for (const l of linhas) {
    if (!porDia.has(l.dia)) porDia.set(l.dia, { dia: l.dia, manha: [], tarde: [] });
    porDia.get(l.dia)[l.turno].push({
      id: l.user_id, nome: l.nome,
      // null = ninguém conferiu ainda, que NÃO é o mesmo que não ter vindo.
      presente: l.presente === null || l.presente === undefined ? null : !!l.presente,
      presenca_obs: l.presenca_obs || null,
      conferido_por: l.conferido_por || null,
      conferido_em: l.marcado_em || null,
    });
  }
  res.json({
    de: meiaNoite(de), ate: meiaNoite(ate),
    dias: [...porDia.values()].sort((a, b) => a.dia - b.dia),
    hoje: doDia(req.user.org_id),
    // O próximo plantão de quem está olhando — é o que vira lembrete no painel.
    meu: proximoMeu(req.user.org_id, req.user.id),
  });
});

/* O próximo plantão da pessoa, olhando 30 dias à frente. Devolve também se é
   HOJE, que é o caso que merece destaque na tela. */
function proximoMeu(orgId, userId) {
  const hoje = meiaNoite(Date.now());
  const linhas = db.prepare(`SELECT dia, turno FROM plantoes
    WHERE org_id = ? AND user_id = ? AND dia >= ? ORDER BY dia, turno LIMIT 8`)
    .all(orgId, userId, hoje);
  if (!linhas.length) return null;
  const dia = linhas[0].dia;
  const turnos = linhas.filter(l => l.dia === dia).map(l => l.turno);
  return { dia, turnos, hoje: dia === hoje, faltam: Math.round((dia - hoje) / DIA) };
}

/* Atalho leve para o painel: quem está de plantão hoje e qual é o SEU próximo.
   Consultado a cada login e de hora em hora, então não pode carregar o mês
   inteiro só para desenhar uma faixa de aviso. */
r.get("/hoje", (req, res) => res.json({
  ...doDia(req.user.org_id),
  meu: proximoMeu(req.user.org_id, req.user.id),
}));

// Define quem fica num turno. Substitui a lista daquele dia+turno.
r.put("/", roles("adm", "sdr"), (req, res) => {
  const { dia, turno, user_ids } = req.body || {};
  const out = definirTurno(req.user.org_id, { dia, turno, userIds: user_ids, autorId: req.user.id });
  if (!out.ok) return res.status(400).json(out);
  res.json({ ...out, dia_completo: doDia(req.user.org_id, out.dia) });
});

/* Confere quem veio ao plantão.

   É da ATENDENTE (e do gestor): ela é quem está na imobiliária durante o turno
   e sabe quem apareceu. O corretor não confere a própria presença — o número
   vira relatório individual dele, e nota que a própria pessoa se dá não é
   conferência, é declaração.

   `presente: null` desmarca — volta a ser "não conferido". */
r.put("/presenca", roles("adm", "sdr"), (req, res) => {
  const { dia, turno, user_id, presente, obs } = req.body || {};
  const out = marcarPresenca(req.user.org_id, {
    dia, turno, userId: user_id, presente, obs, autorId: req.user.id });
  if (!out.ok) return res.status(400).json(out);
  res.json({ ...out, dia_completo: doDia(req.user.org_id, out.dia) });
});

// Limpa um período (usado antes de subir a escala do mês seguinte).
r.delete("/", roles("adm", "sdr"), (req, res) => {
  const { de, ate } = req.query;
  if (!de || !ate) return res.status(400).json({ error: "Informe o período (de e ate)." });
  const d = new Date(de + "T12:00:00").getTime(), a = new Date(ate + "T12:00:00").getTime();
  if (!isFinite(d) || !isFinite(a)) return res.status(400).json({ error: "Período inválido." });
  res.json({ ok: true, apagados: limpar(req.user.org_id, { de: d, ate: a }) });
});

/* Importa a escala da planilha que a Conecta já monta todo mês.
   O frontend lê o arquivo e manda as linhas prontas — mesma decisão da
   importação de leads: assim o servidor não precisa adivinhar codificação nem
   separador, que é onde importação costuma quebrar. */
r.post("/importar", roles("adm", "sdr"), (req, res) => {
  const { linhas } = req.body || {};
  if (!Array.isArray(linhas) || !linhas.length)
    return res.status(400).json({ error: "Nenhuma linha recebida." });
  if (linhas.length > 400)
    return res.status(413).json({ error: "Máximo de 400 dias por importação." });
  res.json(importarEscala(req.user.org_id, linhas, req.user.id,
    { ref: refDe(req.body), simular: !!req.body.previa }));
});

/* Sobe a escala a partir do arquivo, .xlsx ou .csv.

   COM `previa: true` ela LÊ e não grava: devolve os mesmos números, mais os
   primeiros dias com os nomes de cada turno e quantas escalas já existentes
   seriam substituídas. É o que o botão "Salvar escala" precisa para existir —
   sem uma leitura antes, o botão seria só um clique a mais no mesmo caminho
   cego. E o caminho era cego de verdade: a importação APAGA dia+turno antes de
   gravar, então subir a planilha de outubro com setembro aberto na tela
   apagava setembro, respondia "30 dias importados" e ninguém via nada.

   O arquivo inteiro vem em base64 e a leitura é AQUI, não no navegador. O
   .xlsx é um ZIP: o Node descompacta com a zlib que já tem, enquanto no
   navegador seria preciso embutir uma biblioteca no HTML — e o CRM é um
   arquivo só, sem rede.

   Aceitar o .xlsx direto importa mais do que parece: a gestão monta a escala
   no Excel. Exigir "salve como CSV" antes é um passo a mais todo mês, e é onde
   se perde acento, se troca o separador e a planilha chega quebrada. */
r.post("/importar-arquivo", roles("adm", "sdr"), (req, res) => {
  const { base64, nome } = req.body || {};
  if (!base64) return res.status(400).json({ error: "Envie o arquivo." });

  let matriz;
  try {
    const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: "Arquivo muito grande." });
    // PK\x03\x04 é a assinatura do ZIP, e todo .xlsx é um ZIP.
    matriz = (buf[0] === 0x50 && buf[1] === 0x4b) ? lerXlsx(buf) : lerCSV(buf.toString("utf8"));
  } catch (e) {
    return res.status(400).json({ error: "Não consegui ler o arquivo: " + e.message });
  }

  const achado = acharCabecalho(matriz);
  if (!achado) return res.status(400).json({
    error: "Não achei a linha de cabeçalho com 'Data' e as colunas de Manhã/Tarde. Confira se é a aba da escala." });

  const { linha: iCab, data: iData, manha, tarde } = achado;

  /* A tabela da escala termina onde a data deixa de ser data.

     A planilha da Conecta tem um resumo por corretor no rodapé, e a primeira
     coluna dele traz NOME, não data. Sem este corte essas linhas entravam na
     contagem do que foi "lido" — não viravam escala (data inválida é
     descartada), mas o número na tela mentia sobre o tamanho da importação. */
  const linhas = [];
  for (const l of matriz.slice(iCab + 1)) {
    const bruto = String(l[iData] || "").trim();
    if (!bruto) continue;                       // linha em branco no meio: pula
    if (!isFinite(lerDia(bruto))) { if (linhas.length) break; else continue; }
    linhas.push({ data: bruto, manha: manha.map(i => l[i]), tarde: tarde.map(i => l[i]) });
  }

  if (!linhas.length) return res.status(400).json({ error: "Nenhuma linha com data abaixo do cabeçalho." });
  res.json({ ...importarEscala(req.user.org_id, linhas, req.user.id,
      { ref: refDe(req.body), simular: !!req.body.previa }),
    arquivo: nome || null, lidas: linhas.length });
});

/* Acha o cabeçalho em qualquer linha das primeiras 15.

   A planilha da Conecta tem título e subtítulo antes: fixar "a primeira linha
   é o cabeçalho" faria a importação falhar em toda planilha com enfeite em
   cima — que é como planilha de verdade costuma vir. */
function acharCabecalho(matriz) {
  for (let i = 0; i < Math.min(15, matriz.length); i++) {
    const cab = (matriz[i] || []).map(c => String(c || "").trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    const data = cab.findIndex(c => c === "data" || c.startsWith("data"));
    const manha = cab.map((c, k) => c.includes("manha") ? k : -1).filter(k => k >= 0);
    const tarde = cab.map((c, k) => c.includes("tarde") ? k : -1).filter(k => k >= 0);
    if (data >= 0 && (manha.length || tarde.length)) return { linha: i, data, manha, tarde };
  }
  return null;
}

// CSV simples, para quem preferir mandar nesse formato. Aceita ; e , como
// separador — o Excel em português usa ponto e vírgula.
function lerCSV(texto) {
  const limpo = texto.replace(/^\uFEFF/, "");
  const sep = (limpo.split("\n")[0].match(/;/g) || []).length >= (limpo.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  return limpo.split(/\r?\n/).filter(l => l.trim()).map(linha => {
    const campos = []; let atual = "", aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (c === '"') { if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas; }
      else if (c === sep && !aspas) { campos.push(atual); atual = ""; }
      else atual += c;
    }
    campos.push(atual);
    return campos.map(c => c.trim());
  });
}

export default r;
