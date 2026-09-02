/* Escala de plantão.

   Quem fica de sobreaviso em cada turno. Na Conecta são dois corretores por
   turno, manhã e tarde de segunda a sexta, e só manhã no sábado — mas nada
   disso está travado no código: a escala é uma linha por pessoa por turno, e o
   dia sem ninguém simplesmente não tem linha. Domingo, feriado e turno vazio
   são a mesma coisa aqui.

   O aviso das 08:00 segue o mesmo princípio do corte de expediente: em vez de
   confiar num alarme, guardamos ATÉ QUANDO já avisamos. Se o servidor estava
   fora do ar às 08:00, o aviso sai quando ele voltar; se reiniciar três vezes
   de manhã, ninguém recebe três notificações. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { semMaster } from "../auth.js";
import { avisar } from "./push.js";

export const TURNOS = ["manha", "tarde"];
export const ROTULO_TURNO = { manha: "manhã", tarde: "tarde" };
export const HORA_AVISO = 8;   // 08:00, no fuso da operação

export const meiaNoite = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* ===== A DATA DA PLANILHA =====

   Reescrito em 29/08/2026 depois de a escala do Ali "não salvar". Ela salvava:
   ia toda para JANEIRO DE 2001, e a tela de setembro ficava vazia.

   A causa era a última linha da versão anterior — um `new Date(t)` de
   consolo, que aceitava qualquer coisa que o JavaScript conseguisse
   interpretar. E o JavaScript interpreta muita coisa que não é data de escala:

     "01/09"      → 09/01/2001   (dia/mês sem ano, o formato mais comum de todos)
     "seg 01/09"  → 09/01/2001
     "Sábado"     → 01/01/2001
     "46235"      → ano 46235    (o número cru do Excel, quando o estilo da
                                  célula não é reconhecido como data)

   Nenhum desses virava erro. Viravam DIAS VÁLIDOS em anos errados, a
   importação respondia "30 dias lidos" e a escala sumia. E como o import apaga
   dia+turno antes de gravar, dois meses caindo no mesmo janeiro de 2001 faziam
   o segundo apagar o primeiro — que é o "o mês anterior sumiu".

   Agora:
   - dia/mês SEM ANO usa o mês de referência (o que está aberto na tela). É o
     formato mais comum numa escala mensal, e adivinhar o ano pelo relógio do
     servidor erraria em toda virada de ano;
   - ano de dois dígitos vira 20xx, na ordem brasileira (dd/mm/aa);
   - número solto na faixa do Excel vira data pelo serial;
   - e o que não casa com nenhum formato conhecido é INVÁLIDO. Devolver NaN faz
     a linha ser descartada e CONTADA como descartada — muito melhor que virar
     uma data qualquer que ninguém vai encontrar depois.

   `ref` é a data de referência para o que vier sem ano. */
const ANO_MIN = 2000, ANO_MAX = 2100;

export function lerDia(valor, ref = Date.now()) {
  if (valor instanceof Date) return isFinite(valor.getTime()) ? meiaNoite(valor.getTime()) : NaN;
  const t = String(valor ?? "").trim();
  if (!t) return NaN;

  const monta = (ano, mes, dia) => {
    if (!(mes >= 1 && mes <= 12) || !(dia >= 1 && dia <= 31)) return NaN;
    if (!(ano >= ANO_MIN && ano <= ANO_MAX)) return NaN;
    const d = new Date(ano, mes - 1, dia);
    // 31/02 vira 03/03 no JS. Data que "escorrega" não é data válida.
    return (d.getMonth() === mes - 1 && d.getDate() === dia) ? d.getTime() : NaN;
  };

  // dd/mm/aaaa e dd/mm/aa — o que sai do Excel em português.
  const br = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/);
  if (br) {
    const ano = br[3].length === 2 ? 2000 + Number(br[3]) : Number(br[3]);
    return monta(ano, Number(br[2]), Number(br[1]));
  }

  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return monta(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  /* SÓ DIA E MÊS. O caso que quebrou a escala do Ali.

     Numa planilha mensal é o normal — a coluna diz "01/09" e o mês está no
     título. Sem ano, o ano vem da referência: o mês que a gestão está vendo na
     tela quando sobe o arquivo. Usar o ano do relógio erraria em dezembro
     subindo a escala de janeiro. */
  const so = t.match(/(?:^|\s)(\d{1,2})[\/\-.](\d{1,2})(?:\s|$)/);
  if (so) {
    const base = new Date(isFinite(ref) ? ref : Date.now());
    const mes = Number(so[2]), dia = Number(so[1]);
    let ano = base.getFullYear();
    /* A virada de ano: escala de janeiro subida em dezembro. Se o mês da
       planilha está muito atrás do mês de referência, é o ano que vem. */
    const distancia = mes - (base.getMonth() + 1);
    if (distancia <= -6) ano++;
    else if (distancia >= 6) ano--;
    return monta(ano, mes, dia);
  }

  /* Número solto: o serial do Excel (dias desde 30/12/1899). Chega assim
     quando o estilo da célula não é reconhecido como data — o leitor de xlsx
     converte o que reconhece, e o que escapa vinha parar aqui como "46235".
     A faixa cobre 1980–2100; fora dela não é data de escala. */
  if (/^\d+([.,]\d+)?$/.test(t)) {
    const n = Number(t.replace(",", "."));
    if (n >= 29000 && n <= 73500) {
      const d = new Date(Math.round((n - 25569) * 86400000));
      return monta(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    /* Carimbo de tempo do próprio sistema (milissegundos). Quem chama de
       dentro do código passa o número que já tem na mão, e exigir que ele
       converta para texto antes seria uma armadilha em todo chamador novo —
       a recusa sairia como "Data inválida" numa data perfeitamente válida.
       Não é ambíguo: um serial do Excel não passa de 73.500 e um carimbo de
       tempo destes anos está na casa dos bilhões. A faixa de anos continua
       sendo conferida pelo `monta`. */
    if (n > 73500) {
      const d = new Date(n);
      return isFinite(d.getTime()) ? monta(d.getFullYear(), d.getMonth() + 1, d.getDate()) : NaN;
    }
    return NaN;
  }

  /* E acabou. NÃO existe mais o `new Date(t)` de consolo.

     Era ele que transformava "Sábado", "seg 01/09" e qualquer texto solto numa
     data de 2001. Uma linha que não casa com nenhum formato conhecido é uma
     linha que o sistema NÃO ENTENDEU, e dizer isso é a única resposta honesta:
     inventar uma data faz a escala sumir num lugar onde ninguém vai procurar. */
  return NaN;
}

// A escala de um período, já com o nome de quem está escalado e com a
// conferência de presença, quando ela existe.
export function escala(orgId, { de, ate }) {
  return db.prepare(`
    SELECT p.id, p.dia, p.turno, p.user_id, u.name AS nome, u.role,
           pr.presente, pr.obs AS presenca_obs, pr.marcado_em, pr.marcado_por,
           a.name AS conferido_por
    FROM plantoes p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN plantao_presencas pr
      ON pr.org_id = p.org_id AND pr.dia = p.dia AND pr.turno = p.turno AND pr.user_id = p.user_id
    LEFT JOIN users a ON a.id = pr.marcado_por
    WHERE p.org_id = ? AND p.dia BETWEEN ? AND ?
    ORDER BY p.dia, p.turno, u.name`).all(orgId, meiaNoite(de), meiaNoite(ate));
}

/* ===== QUEM VEIO AO PLANTÃO =====

   A atendente confere depois que o turno passou. Três regras, e as três
   existem para o número não descrever coisa que ninguém viu acontecer:

   1. SÓ DEPOIS DO DIA. Marcar "veio" no plantão de amanhã é afirmar um fato
      que ainda não existe — e no relatório ele seria indistinguível de uma
      presença conferida de verdade.

   2. SÓ QUEM ESTÁ ESCALADO naquele dia e turno. Presença de quem não estava na
      escala não responde pergunta nenhuma, e faria "presenças" passar de
      "turnos escalados" — número impossível é número que derruba a confiança
      na tela inteira.

   3. DÁ PARA DESMARCAR. `presente = null` apaga a conferência e o turno volta
      a ser "não conferido". Clique errado precisa ter volta, e voltar não pode
      significar registrar o contrário. */
export function marcarPresenca(orgId, { dia, turno, userId, presente, obs = null, autorId = null, agora = Date.now() }) {
  if (!TURNOS.includes(turno)) return { ok: false, error: "Turno inválido." };
  const d = lerDia(dia);
  if (!isFinite(d)) return { ok: false, error: "Data inválida." };
  if (d > meiaNoite(agora))
    return { ok: false, error: "Esse plantão ainda não aconteceu — dá para conferir a partir do próprio dia." };

  const escalado = db.prepare(
    "SELECT 1 FROM plantoes WHERE org_id=? AND dia=? AND turno=? AND user_id=?").get(orgId, d, turno, userId);
  if (!escalado) return { ok: false, error: "Essa pessoa não está escalada nesse turno." };

  if (presente === null || presente === undefined || presente === "") {
    db.prepare("DELETE FROM plantao_presencas WHERE org_id=? AND dia=? AND turno=? AND user_id=?")
      .run(orgId, d, turno, userId);
    return { ok: true, dia: d, turno, user_id: userId, presente: null };
  }

  const veio = (presente === true || presente === 1 || presente === "1" || presente === "veio") ? 1 : 0;
  const texto = String(obs || "").trim().slice(0, 200) || null;
  db.prepare(`INSERT INTO plantao_presencas (id,org_id,dia,turno,user_id,presente,obs,marcado_por,marcado_em)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(org_id,dia,turno,user_id) DO UPDATE SET
       presente=excluded.presente, obs=excluded.obs,
       marcado_por=excluded.marcado_por, marcado_em=excluded.marcado_em`)
    .run("pp_" + randomUUID(), orgId, d, turno, userId, veio, texto, autorId, Date.now());
  return { ok: true, dia: d, turno, user_id: userId, presente: veio, obs: texto };
}

/* O resumo por pessoa, que é o que entra no relatório individual.

   Conta TURNOS, não dias: dá para vir de manhã e faltar à tarde, e somar os
   dois no mesmo dia esconderia justamente a metade que faltou.

   `nao_conferidos` só olha turno que JÁ ACONTECEU. Turno de amanhã não está
   pendente de conferência — ele ainda não é nada. Sem esse corte, abrir o
   relatório do mês corrente mostraria uma pilha de "não conferidos" que é só o
   resto do mês, e a atendente iria procurar trabalho que não existe. */
export function resumoPresenca(orgId, { de, ate }, agora = Date.now()) {
  const hoje = meiaNoite(agora);
  const linhas = db.prepare(`
    SELECT p.user_id, p.dia, pr.presente
    FROM plantoes p
    LEFT JOIN plantao_presencas pr
      ON pr.org_id = p.org_id AND pr.dia = p.dia AND pr.turno = p.turno AND pr.user_id = p.user_id
    WHERE p.org_id = ? AND p.dia BETWEEN ? AND ?`).all(orgId, meiaNoite(de), meiaNoite(ate));

  const por = new Map();
  for (const l of linhas) {
    if (!por.has(l.user_id))
      por.set(l.user_id, { turnos_escalado: 0, turnos_passados: 0, presencas: 0, faltas: 0, nao_conferidos: 0 });
    const x = por.get(l.user_id);
    x.turnos_escalado++;
    if (l.dia > hoje) continue;             // ainda não aconteceu
    x.turnos_passados++;
    if (l.presente === 1) x.presencas++;
    else if (l.presente === 0) x.faltas++;
    else x.nao_conferidos++;
  }
  return por;
}

/* ===== O RELATÓRIO DE PLANTÕES ===== (02/09/2026, pedido do Ali)

   O bloco de presença já existia no relatório INDIVIDUAL de cada corretor. O
   que faltava é a outra pergunta, que é da gestão: "como foi a escala do mês?"
   — quem veio mais, quem faltou, e se a manhã é pior que a tarde.

   ===== APROVEITAMENTO SÓ DIVIDE PELO QUE FOI CONFERIDO =====

   `aproveitamento = presenças ÷ (presenças + faltas)`, e NÃO por turnos
   passados. É a mesma regra que sustenta o resto deste arquivo: turno que
   ninguém conferiu não é falta, é ausência de informação. Dividir pelos turnos
   passados transformaria o esquecimento da atendente na nota do corretor — o
   relatório inventaria faltas, e num mês de conferência fraca ele reprovaria a
   equipe inteira por um trabalho que ela fez.

   E quando NADA foi conferido o valor é `null`, nunca 0. Zero por cento lê-se
   como "não apareceu nenhuma vez", que é a acusação mais grave que esta tela
   pode fazer — e ela estaria sendo feita justamente onde não se sabe de nada.

   ===== POR TURNO, PORQUE A PERGUNTA É OPERACIONAL =====

   Manhã e tarde separados: se a falta se concentra num turno, o problema é de
   escala (horário ruim, plantão vazio) e não de pessoa. Somados, essa diferença
   desaparece dentro da média e a conversa vira sobre gente. */
export function relatorio(orgId, { de, ate }, agora = Date.now()) {
  const hoje = meiaNoite(agora);
  const inicio = meiaNoite(de), fim = meiaNoite(ate);

  const linhas = db.prepare(`
    SELECT p.dia, p.turno, p.user_id, u.name AS nome, u.role, pr.presente
    FROM plantoes p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN plantao_presencas pr
      ON pr.org_id = p.org_id AND pr.dia = p.dia AND pr.turno = p.turno AND pr.user_id = p.user_id
    WHERE p.org_id = ? AND p.dia BETWEEN ? AND ?
    ORDER BY p.dia, p.turno`).all(orgId, inicio, fim);

  const zero = () => ({ turnos_escalado: 0, turnos_passados: 0, presencas: 0, faltas: 0, nao_conferidos: 0 });
  /* `aproveitamento` fica fora de `zero()` de propósito: ele é calculado no
     fim, e um campo pré-zerado viraria 0% em quem não teve nada conferido —
     exatamente o que o comentário acima diz para não fazer. */
  const juntar = (alvo, l) => {
    alvo.turnos_escalado++;
    if (l.dia > hoje) return;                 // ainda não aconteceu
    alvo.turnos_passados++;
    if (l.presente === 1) alvo.presencas++;
    else if (l.presente === 0) alvo.faltas++;
    else alvo.nao_conferidos++;
  };
  const aproveitar = (x) => {
    const conferidos = x.presencas + x.faltas;
    return { ...x, conferidos, aproveitamento: conferidos ? Math.round((x.presencas / conferidos) * 100) : null };
  };

  const pessoas = new Map(), porTurno = new Map(), porDia = new Map();
  const totais = zero();

  for (const l of linhas) {
    if (!pessoas.has(l.user_id))
      pessoas.set(l.user_id, { user_id: l.user_id, nome: l.nome || "—", role: l.role || null, ...zero() });
    juntar(pessoas.get(l.user_id), l);

    if (!porTurno.has(l.turno)) porTurno.set(l.turno, { turno: l.turno, rotulo: ROTULO_TURNO[l.turno] || l.turno, ...zero() });
    juntar(porTurno.get(l.turno), l);

    if (!porDia.has(l.dia)) porDia.set(l.dia, { dia: l.dia, ...zero() });
    juntar(porDia.get(l.dia), l);

    juntar(totais, l);
  }

  return {
    de: inicio, ate: fim,
    /* Mais faltas primeiro, e não melhor aproveitamento: quem abre este
       relatório está procurando problema. Ordenar pelo melhor faria a gestão
       rolar a lista até o fim para achar o que veio ver. */
    pessoas: [...pessoas.values()].map(aproveitar)
      .sort((a, b) => b.faltas - a.faltas || b.turnos_escalado - a.turnos_escalado
        || String(a.nome).localeCompare(String(b.nome), "pt-BR")),
    por_turno: TURNOS.map(t => aproveitar(porTurno.get(t) || { turno: t, rotulo: ROTULO_TURNO[t], ...zero() })),
    por_dia: [...porDia.values()].map(aproveitar).sort((a, b) => a.dia - b.dia),
    totais: aproveitar(totais),
  };
}

// Quem está de plantão num dia, separado por turno.
export function doDia(orgId, dia = Date.now()) {
  const linhas = escala(orgId, { de: dia, ate: dia });
  return {
    dia: meiaNoite(dia),
    manha: linhas.filter(l => l.turno === "manha"),
    tarde: linhas.filter(l => l.turno === "tarde"),
  };
}

/* Define QUEM fica num turno. Substitui a lista inteira daquele dia+turno —
   é como a gestão pensa ("hoje de manhã são fulano e beltrano"), e evita o
   vaivém de adicionar e remover um a um. */
export function definirTurno(orgId, { dia, turno, userIds, autorId }) {
  if (!TURNOS.includes(turno)) return { ok: false, error: "Turno inválido." };
  const d = lerDia(dia);
  if (!isFinite(d)) return { ok: false, error: "Data inválida." };

  // Só entra quem é da imobiliária e está ativo — nome de gente que saiu não
  // pode continuar aparecendo na escala do mês que vem.
  const validos = new Set(db.prepare(
    `SELECT u.id FROM users u WHERE u.org_id = ? AND u.status = 'ativo'
     AND u.role IN ('corretor','sdr')${semMaster("u")}`).all(orgId).map(u => u.id));

  const pedidos = [...new Set(userIds || [])];
  const escolhidos = pedidos.filter(id => validos.has(id));
  /* QUEM FOI RECUSADO É DITO, e não descartado em silêncio.

     A peneira existe por um motivo bom — nome de quem saiu da equipe não pode
     continuar na escala do mês que vem. Mas ela também barra o gestor, que não
     tem papel de corretor nem de atendente, e barrava calado: a tela mandava
     dois nomes, o servidor gravava zero e respondia "ok". Do lado de quem
     usa, isso é exatamente "a escala não está salvando". */
  const recusados = pedidos.filter(id => !validos.has(id));
  const gravar = db.transaction(() => {
    db.prepare("DELETE FROM plantoes WHERE org_id = ? AND dia = ? AND turno = ?").run(orgId, d, turno);
    for (const id of escolhidos)
      db.prepare(`INSERT INTO plantoes (id,org_id,dia,turno,user_id,criado_por,created_at)
                  VALUES (?,?,?,?,?,?,?)`).run("pl_" + randomUUID(), orgId, d, turno, id, autorId, Date.now());
  });
  gravar();
  const nomes = recusados.length
    ? db.prepare(`SELECT name, role, status FROM users WHERE id IN (${recusados.map(() => "?").join(",")})`).all(...recusados)
    : [];
  return {
    ok: true, dia: d, turno, quantos: escolhidos.length,
    recusados: nomes.map(n => ({
      nome: n.name,
      motivo: n.status !== "ativo" ? "não está mais ativo na equipe"
        : "só corretor e atendente entram na escala",
    })),
  };
}

// Limpa um período inteiro. Usado antes de subir uma escala nova do mês.
export function limpar(orgId, { de, ate }) {
  const info = db.prepare("DELETE FROM plantoes WHERE org_id = ? AND dia BETWEEN ? AND ?")
    .run(orgId, meiaNoite(de), meiaNoite(ate));
  return info.changes;
}

/* Importa a escala de uma planilha no formato que a Conecta já usa:
   Data | Dia | Manhã 1 | Manhã 2 | Tarde 1 | Tarde 2

   Os nomes vêm escritos à mão, então o casamento é tolerante: nome completo,
   primeiro nome, sem acento, sem diferenciar maiúscula. O que não casar volta
   na resposta — melhor a gestão saber quem ficou de fora do que o sistema
   inventar uma pessoa parecida. */
const chave = (t) => String(t || "").trim().toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function importarEscala(orgId, linhas, autorId, { ref = Date.now(), simular = false } = {}) {
  const pessoas = db.prepare(
    `SELECT u.id, u.name FROM users u WHERE u.org_id = ? AND u.status = 'ativo'
     AND u.role IN ('corretor','sdr')${semMaster("u")}`).all(orgId);

  /* O CASAMENTO DOS NOMES, EM DUAS PASSADAS.

     A versão anterior fazia tudo num laço só, e por isso NUNCA reconhecia
     alguém cadastrado com uma palavra só:

       "Marina" → grava porNome["marina"] = id
                → primeiro nome também é "marina"
                → já existe no mapa, logo marca "__ambiguo__"

     Ela ficava ambígua consigo mesma. Numa equipe cadastrada por primeiro nome
     — que é como quase toda equipe é cadastrada — isso significava a planilha
     inteira voltar em "não identifiquei ninguém", com zero escalas gravadas.
     Do lado de quem usa: a escala não salva.

     Agora o NOME COMPLETO tem prioridade e é imune: quem se chama "Marina"
     casa com "Marina", ponto. A ambiguidade só existe entre PRIMEIROS NOMES de
     pessoas diferentes — com duas Anas, adivinhar continua sendo pior do que
     avisar que não deu para identificar. */
  const porNome = new Map();
  const nomesCompletos = new Set();
  for (const p of pessoas) {
    const inteiro = chave(p.name);
    porNome.set(inteiro, p.id);
    nomesCompletos.add(inteiro);
  }
  for (const p of pessoas) {
    const primeiro = chave(p.name).split(" ")[0];
    if (nomesCompletos.has(primeiro)) continue;      // é o nome inteiro de alguém: não se mexe
    if (!porNome.has(primeiro)) porNome.set(primeiro, p.id);
    else if (porNome.get(primeiro) !== p.id) porNome.set(primeiro, "__ambiguo__");
  }

  const naoEncontrados = new Set();
  const datasIgnoradas = [];
  const diasGravados = [];
  const amostra = [];
  const nomeDe = new Map(pessoas.map(p => [p.id, p.name]));
  let dias = 0, escalados = 0, substitui = 0;

  const rodar = db.transaction(() => {
    for (const l of linhas) {
      const d = lerDia(l.data, ref);
      /* Linha com data que o sistema NÃO entendeu é contada e devolvida.

         Antes ela era pulada em silêncio, e o resultado dizia "30 dias lidos"
         contando só as que passaram — o gestor não tinha como saber que dez
         linhas tinham ficado para trás. */
      if (!isFinite(d)) {
        const bruto = String(l.data ?? "").trim();
        if (bruto && datasIgnoradas.length < 20) datasIgnoradas.push(bruto);
        continue;
      }
      dias++;
      diasGravados.push(d);
      const doDiaAmostra = { dia: d, manha: [], tarde: [] };
      for (const turno of TURNOS) {
        const nomes = (l[turno] || []).map(n => String(n || "").trim()).filter(Boolean);
        const ids = [];
        for (const n of nomes) {
          const achou = porNome.get(chave(n));
          if (achou && achou !== "__ambiguo__") ids.push(achou);
          else naoEncontrados.add(n);
        }
        /* O QUE VAI SER SUBSTITUÍDO. A importação apaga o dia+turno antes de
           gravar — é assim que refazer o mês funciona. Na prévia isso precisa
           estar escrito: subir a planilha certa por cima da errada é rotina,
           mas subir a de outubro com setembro aberto na tela apagaria setembro
           em silêncio, e o número "30 dias importados" pareceria vitória. */
        substitui += db.prepare(
          "SELECT COUNT(*) n FROM plantoes WHERE org_id=? AND dia=? AND turno=?").get(orgId, d, turno).n;
        const unicos = [...new Set(ids)];
        for (const id of unicos) doDiaAmostra[turno].push(nomeDe.get(id) || "?");
        escalados += unicos.length;
        if (simular) continue;
        db.prepare("DELETE FROM plantoes WHERE org_id = ? AND dia = ? AND turno = ?").run(orgId, d, turno);
        for (const id of unicos)
          db.prepare(`INSERT INTO plantoes (id,org_id,dia,turno,user_id,criado_por,created_at)
                      VALUES (?,?,?,?,?,?,?)`).run("pl_" + randomUUID(), orgId, d, turno, id, autorId, Date.now());
      }
      // Uns poucos dias inteiros na prévia: total sem conteúdo não dá para
      // conferir, e é justamente conferir que o botão Salvar existe para permitir.
      if (amostra.length < 4) amostra.push(doDiaAmostra);
    }
  });
  rodar();

  /* O QUE FOI GRAVADO, E EM QUE MÊS.

     É a informação que faltava para o defeito ter sido visto no primeiro dia:
     a importação respondia um número e nada mais, então uma escala que caiu em
     janeiro de 2001 parecia ter dado certo. Agora ela devolve o intervalo e os
     meses tocados, e a tela compara com o mês que está aberto. */
  diasGravados.sort((a, b) => a - b);
  const meses = [...new Set(diasGravados.map(d => {
    const x = new Date(d);
    return `${String(x.getMonth() + 1).padStart(2, "0")}/${x.getFullYear()}`;
  }))];
  return {
    dias, escalados, nao_encontrados: [...naoEncontrados],
    datas_ignoradas: datasIgnoradas,
    de: diasGravados[0] ?? null,
    ate: diasGravados[diasGravados.length - 1] ?? null,
    meses, simulado: !!simular, substitui, amostra,
  };
}

/* Aviso das 08:00 para quem está de plantão hoje.

   `ultimo_aviso_plantao` guarda o dia já avisado. É o que impede a notificação
   repetida a cada reinício do servidor — e o que faz o aviso ainda sair, um
   pouco atrasado, se às 08:00 o servidor estava fora do ar. */
export async function avisarPlantaoDeHoje(orgId, agora = Date.now()) {
  const hoje = meiaNoite(agora);
  const d = new Date(agora);
  if (d.getHours() < HORA_AVISO) return { enviados: 0, motivo: "ainda não deu a hora" };

  const org = db.prepare("SELECT ultimo_aviso_plantao FROM orgs WHERE id = ?").get(orgId);
  if (org && org.ultimo_aviso_plantao >= hoje) return { enviados: 0, motivo: "já avisado hoje" };

  const escalados = doDia(orgId, hoje);
  const porPessoa = new Map();
  for (const t of TURNOS)
    for (const p of escalados[t]) {
      if (!porPessoa.has(p.user_id)) porPessoa.set(p.user_id, []);
      porPessoa.get(p.user_id).push(ROTULO_TURNO[t]);
    }

  // Marca ANTES de enviar: push que falha não pode virar aviso repetido no
  // minuto seguinte, e a escala do dia não muda por causa disso.
  db.prepare("UPDATE orgs SET ultimo_aviso_plantao = ? WHERE id = ?").run(hoje, orgId);

  let enviados = 0;
  for (const [userId, turnos] of porPessoa) {
    try {
      const r = await avisar(userId, {
        titulo: "Hoje é seu dia de plantão",
        corpo: `Você está na escala de ${turnos.join(" e ")}. Fique de prontidão para os leads que entrarem.`,
      });
      enviados += (r && r.enviados) || 0;
    } catch (e) { console.error("[plantao] falha ao avisar:", e.message); }
  }
  return { enviados, pessoas: porPessoa.size };
}

export async function avisarPlantaoEmTodas(agora = Date.now()) {
  for (const { id } of db.prepare("SELECT id FROM orgs").all()) {
    try { await avisarPlantaoDeHoje(id, agora); }
    catch (e) { console.error("[plantao] erro no aviso:", e.message); }
  }
}
