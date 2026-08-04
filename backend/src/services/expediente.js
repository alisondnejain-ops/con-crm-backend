/* Fim de expediente: a prontidão do corretor vale por UM dia.

   A regra que o Ali pediu: às 18:00 todo mundo cai para indisponível, e no dia
   seguinte cada um precisa se prontificar de novo. Sem isso, quem marcou
   "disponível" numa segunda continuava na catraca na terça sem ter dito nada —
   recebendo lead sem estar de prontidão, que é justamente o que a catraca
   existe para evitar.

   DECISÃO IMPORTANTE — o corte é CALCULADO, não confiado a um agendador.

   Um `setInterval` às 18:00 parece resolver, mas basta o servidor reiniciar às
   17:59 (deploy, queda, hibernação do plano) para o horário passar em branco e
   a equipe inteira amanhecer disponível. Aqui, `aplicarCorte()` pergunta "qual
   foi o último 18:00 que já passou, e ele já foi aplicado?" — a resposta é a
   mesma tenha o servidor ficado de pé ou não. O intervalo de um minuto existe
   só para o corte acontecer na hora certa com o sistema aberto; a correção não
   depende dele.

   O horário é por imobiliária (orgs.expediente_fim, padrão "18:00"). Vazio
   desliga a regra: quem tem plantão à noite não pode ficar refém dela. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { semMaster } from "../auth.js";

export const PADRAO = "18:00";

// "18:00" -> {h:18, m:0}. Qualquer coisa fora disso desliga a regra.
export function lerHorario(txt) {
  const m = String(txt ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

export const expedienteDa = (orgId) => {
  const org = db.prepare("SELECT expediente_fim FROM orgs WHERE id = ?").get(orgId);
  // Coluna nula (banco antigo) cai no padrão; string vazia é escolha de
  // desligar, e as duas coisas precisam continuar sendo diferentes.
  return org && org.expediente_fim !== null && org.expediente_fim !== undefined
    ? org.expediente_fim : PADRAO;
};

const emDia = (base, { h, m }) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d.getTime(); };

/* O último fim de expediente que já passou. Antes das 18:00 de hoje, é o de
   ontem — por isso quem se prontificou hoje de manhã continua valendo. */
export function ultimoCorte(horario, agora = Date.now()) {
  const hoje = emDia(agora, horario);
  return agora >= hoje ? hoje : emDia(agora - 86400000, horario);
}

// O próximo, que é o que a tela mostra para o corretor ("vale até as 18:00").
export function proximoCorte(horario, agora = Date.now()) {
  const hoje = emDia(agora, horario);
  return agora < hoje ? hoje : emDia(agora + 86400000, horario);
}

export function registrar({ orgId, userId, ativo, origem, autor, local = null, observacao = null, plantao = null, quando = Date.now() }) {
  db.prepare(`INSERT INTO disponibilidade_log (id,org_id,user_id,ativo,origem,autor_id,autor_nome,local,observacao,plantao,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("dp_" + randomUUID(), orgId, userId,
    ativo ? 1 : 0, origem, autor?.id || null, autor?.name || null, local, observacao, plantao, quando);
}

/* PONTO DA ATENDENTE

   Para o corretor, a chave significa "estou de prontidão para receber lead" —
   ele escolhe se quer entrar na fila do dia. Para a atendente não existe essa
   escolha: ela atende o expediente inteiro por definição. O que a chave dela
   registra é PRESENÇA, e por isso vira ponto.

   A trava está aqui, no servidor, e não só na tela: a marcação de entrada só
   é aceita com o local declarado, e "fora da imobiliária" exige o motivo
   escrito. Deixar isso a cargo do popup seria deixar a porta aberta — bastaria
   chamar a rota direto para bater um ponto em branco. */
export const LOCAIS = ["imobiliaria", "fora"];
export const ehPonto = (role) => role === "sdr";

export function validarPonto({ role, ativo, local, observacao }) {
  if (!ehPonto(role) || !ativo) return null;   // saída e corretor não pedem nada
  if (!LOCAIS.includes(local))
    return "Diga se você já está na imobiliária ou ainda está fora antes de iniciar o atendimento.";
  if (local === "fora" && String(observacao || "").trim().length < 3)
    return "Escreva o motivo de estar fora da imobiliária.";
  return null;
}

/* Derruba quem ficou de ontem. Idempotente: rodar dez vezes seguidas não muda
   nada e não gera dez linhas no histórico.

   Só desliga quem se prontificou ANTES do último corte. Quem marcou depois
   (ex.: 19h de ontem, com o expediente às 18h) continua valendo até o próximo
   — senão o clique dele seria engolido no mesmo segundo. */
export function aplicarCorte(orgId, agora = Date.now()) {
  const horario = lerHorario(expedienteDa(orgId));
  if (!horario) return { aplicado: false, motivo: "expediente sem horário de fim" };

  const corte = ultimoCorte(horario, agora);
  const org = db.prepare("SELECT ultimo_corte FROM orgs WHERE id = ?").get(orgId);
  if (org && org.ultimo_corte >= corte) return { aplicado: false, desligados: 0 };

  const alvos = db.prepare(`SELECT u.id FROM users u
    WHERE u.org_id = ? AND u.available = 1 AND COALESCE(u.available_desde, 0) < ?${semMaster("u")}`)
    .all(orgId, corte);

  const rodar = db.transaction(() => {
    for (const { id } of alvos) {
      db.prepare("UPDATE users SET available = 0, available_desde = NULL WHERE id = ?").run(id);
      /* A hora registrada é a do CORTE, não a de agora. Se o servidor só
         percebeu às 23h, o histórico ainda tem que dizer 18:00 — é a hora em
         que o corretor deixou de receber lead. */
      db.prepare(`INSERT INTO disponibilidade_log (id,org_id,user_id,ativo,origem,autor_id,autor_nome,created_at)
                  VALUES (?,?,?,0,'sistema',NULL,NULL,?)`).run("dp_" + randomUUID(), orgId, id, corte);
    }
    db.prepare("UPDATE orgs SET ultimo_corte = ? WHERE id = ?").run(corte, orgId);
  });
  rodar();
  return { aplicado: true, desligados: alvos.length, corte };
}

// Passa em todas as imobiliárias. É o que o intervalo e o start do servidor chamam.
export function aplicarCorteEmTodas(agora = Date.now()) {
  let total = 0;
  for (const { id } of db.prepare("SELECT id FROM orgs").all()) {
    try { total += aplicarCorte(id, agora).desligados || 0; }
    catch (e) { console.error("[expediente] erro ao aplicar o corte:", e.message); }
  }
  return total;
}

/* Ligado no relógio, mas sem depender dele: quem garante a regra é o cálculo
   acima, chamado também nas rotas que leem disponibilidade. Isto aqui só faz o
   corte acontecer às 18:00 em ponto para quem está com a tela aberta. */
export function agendarCorte() {
  aplicarCorteEmTodas();
  return setInterval(() => aplicarCorteEmTodas(), 60000);
}

/* Ponto por pessoa e por dia, para o relatório do gestor.

   Uma linha por DIA trabalhado: primeira entrada, última saída, total somado e
   como a saída aconteceu. Se o dia terminou sem a pessoa marcar a saída, o
   corte das 18:00 fecha por ela — e o relatório diz isso, porque "esqueceu de
   sair" e "trabalhou até as 18:00" não são a mesma coisa. */
export function ponto(orgId, { de, ate, userId = null, roles = ["sdr"] } = {}) {
  const inicio = new Date(de); inicio.setHours(0, 0, 0, 0);
  const fim = new Date(ate); fim.setHours(23, 59, 59, 999);

  const filtroPapel = roles.length ? ` AND u.role IN (${roles.map(() => "?").join(",")})` : "";
  const args = [orgId, ...roles];
  let filtroUser = "";
  if (userId) { filtroUser = " AND u.id = ?"; args.push(userId); }

  const pessoas = db.prepare(`SELECT u.id,u.name,u.role FROM users u
    WHERE u.org_id = ?${filtroPapel}${filtroUser} AND u.status = 'ativo'${semMaster("u")}
    ORDER BY u.name`).all(...args);

  const eventos = db.prepare(`SELECT * FROM disponibilidade_log
    WHERE org_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at`)
    .all(orgId, inicio.getTime(), fim.getTime());

  const diaDe = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const agora = Date.now();

  return pessoas.map(p => {
    const meus = eventos.filter(e => e.user_id === p.id);
    const porDia = new Map();
    for (const e of meus) {
      const k = diaDe(e.created_at);
      if (!porDia.has(k)) porDia.set(k, []);
      porDia.get(k).push(e);
    }

    const dias = [...porDia.entries()].sort((a, b) => a[0] - b[0]).map(([dia, evs]) => {
      let ligado = null, total = 0;
      for (const e of evs) {
        if (e.ativo && ligado === null) ligado = e.created_at;
        else if (!e.ativo && ligado !== null) { total += e.created_at - ligado; ligado = null; }
      }
      // Ainda marcado no fim da janela do dia: conta até agora (se é hoje) ou
      // até a meia-noite, para um dia esquecido não virar 40 horas.
      if (ligado !== null) total += Math.min(agora, dia + 86399999) - ligado;

      const entrada = evs.find(e => e.ativo);
      const saida = [...evs].reverse().find(e => !e.ativo);
      return {
        dia,
        entrada: entrada ? entrada.created_at : null,
        saida: saida ? saida.created_at : null,
        minutos: Math.round(total / 60000),
        local: entrada ? entrada.local : null,
        observacao: entrada ? entrada.observacao : null,
        fechado_pelo_sistema: !!(saida && saida.origem === "sistema"),
        marcacoes: evs.length,
      };
    });

    return {
      id: p.id, nome: p.name, role: p.role, dias,
      total_minutos: dias.reduce((s, d) => s + d.minutos, 0),
      dias_com_registro: dias.length,
      dias_fora: dias.filter(d => d.local === "fora").length,
      dias_sem_saida: dias.filter(d => d.fechado_pelo_sistema).length,
    };
  });
}

/* Histórico para a atendente e a gestão: quem ligou, quem desligou, a que
   horas e por quem. `dias` limita a janela — a tela pede 7 por padrão.

   A janela conta DIAS DE CALENDÁRIO, começando na meia-noite. Antes era
   "as últimas 24 horas": às 15h do dia 04, o filtro "hoje" ainda trazia a
   tarde do dia 03 junto, e parecia que o filtro não tinha sido aplicado.
   Filtro de dia tem que casar com o dia do calendário — 1 = hoje, 7 = hoje e
   os seis anteriores. */
export function historico(orgId, { dias = 7, userId = null, limite = 400 } = {}) {
  const zero = new Date(); zero.setHours(0, 0, 0, 0);
  const desde = zero.getTime() - (Math.max(1, Number(dias) || 7) - 1) * 86400000;
  const args = [orgId, desde];
  let filtro = "";
  if (userId) { filtro = " AND d.user_id = ?"; args.push(userId); }
  args.push(Math.min(1000, Number(limite) || 400));

  return db.prepare(`
    SELECT d.*, u.name AS pessoa, u.role
    FROM disponibilidade_log d
    LEFT JOIN users u ON u.id = d.user_id
    WHERE d.org_id = ? AND d.created_at >= ?${filtro}
    ORDER BY d.created_at DESC LIMIT ?`).all(...args);
}

/* Resumo por pessoa no dia: primeira ativação, último desligamento, quanto
   tempo somou disponível e se ela chegou a se prontificar.

   O total é a soma dos intervalos ligado→desligado. Um "ligado" sem par
   (ainda disponível agora) conta até este instante. */
export function resumoDoDia(orgId, dia = Date.now()) {
  const inicio = new Date(dia); inicio.setHours(0, 0, 0, 0);
  const fim = inicio.getTime() + 86400000;

  const pessoas = db.prepare(`SELECT u.id,u.name,u.role,u.available FROM users u
    WHERE u.org_id = ? AND u.role IN ('corretor','sdr') AND u.status = 'ativo'${semMaster("u")}
    ORDER BY u.name`).all(orgId);

  const eventos = db.prepare(`SELECT * FROM disponibilidade_log
    WHERE org_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`)
    .all(orgId, inicio.getTime(), fim);

  const agora = Date.now();
  return pessoas.map(p => {
    const meus = eventos.filter(e => e.user_id === p.id);
    let ligadoEm = null, total = 0;
    for (const e of meus) {
      if (e.ativo && ligadoEm === null) ligadoEm = e.created_at;
      else if (!e.ativo && ligadoEm !== null) { total += e.created_at - ligadoEm; ligadoEm = null; }
    }
    if (ligadoEm !== null) total += Math.min(agora, fim) - ligadoEm;

    const ativou = meus.find(e => e.ativo);
    const ultimoOff = [...meus].reverse().find(e => !e.ativo);
    return {
      id: p.id, nome: p.name, role: p.role, disponivel_agora: !!p.available,
      prontificou: !!ativou,
      primeira_ativacao: ativou ? ativou.created_at : null,
      ultimo_desligamento: ultimoOff ? ultimoOff.created_at : null,
      desligado_pelo_sistema: !!(ultimoOff && ultimoOff.origem === "sistema"),
      minutos_disponivel: Math.round(total / 60000),
      eventos: meus.length,
    };
  });
}
