import { Router } from "express";
import db from "../db.js";
import { authRequired, roles, semMaster } from "../auth.js";
import { avisar, configurado as pushConfigurado, inscricoesDe } from "../services/push.js";
import { aplicarCorte, registrar, historico, resumoDoDia, expedienteDa,
  lerHorario, proximoCorte, PADRAO, validarPonto, ehPonto } from "../services/expediente.js";
import { doDia as plantaoDoDia, TURNOS as TURNOS_PLANTAO } from "../services/plantao.js";
import { esperando, minutosDaOrg, definirMinutos } from "../services/alerta.js";

const r = Router();
r.use(authRequired);

/* O corte do fim do expediente roda ANTES de qualquer leitura ou escrita de
   disponibilidade. É o que garante a regra mesmo se o servidor tiver ficado
   fora do ar às 18:00: a primeira pessoa que abrir a tela no dia seguinte já
   encontra todo mundo desligado. É idempotente e custa uma consulta. */
r.use((req, _res, next) => { try { aplicarCorte(req.user.org_id); } catch (e) {} next(); });

// Quem atende (corretores + SDR) com o status de disponibilidade de hoje.
/* Quem entra na catraca: só CORRETOR.
   A atendente saía nesta lista como se fosse mais um de prontidão, e de lá
   dava para ligar a chave dela com um clique — pulando o ponto. Ela não
   disputa lead na catraca; o que ela marca é presença. */
r.get("/attendants", roles("sdr", "adm"), (req, res) => {
  const rows = db.prepare(
    `SELECT u.id,u.name,u.role,u.available FROM users u WHERE u.org_id = ? AND u.role = 'corretor'${semMaster("u")} ORDER BY u.name`
  ).all(req.user.org_id);
  res.json(rows.map(u => ({ ...u, available: !!u.available })));
});

// Catraca dos ATENDENTES — só o gestor. É a fila de quem recebe os leads que
// entram, com quantos cada uma já pegou e quem é a próxima da vez. Com uma
// atendente só, a lista tem uma linha; a tela existe para quando entrar a segunda.
r.get("/atendentes", roles("adm"), (req, res) => {
  const fila = db.prepare(
    `SELECT u.id,u.name,u.available,u.status FROM users u WHERE u.org_id = ? AND u.role = 'sdr' AND u.status = 'ativo'${semMaster("u")} ORDER BY u.created_at, u.name`
  ).all(req.user.org_id);
  const org = db.prepare("SELECT atendente_ptr FROM orgs WHERE id = ?").get(req.user.org_id);
  const ptr = (org && org.atendente_ptr) || 0;
  const emAberto = db.prepare(
    "SELECT COUNT(*) n FROM leads WHERE assigned_to = ? AND closed_at IS NULL AND stage NOT IN ('Venda','Perdido')"
  );
  res.json({
    proximo: fila.length ? fila[ptr % fila.length].id : null,
    atendentes: fila.map((u, i) => ({
      ...u,
      available: !!u.available,
      proximo_da_vez: fila.length ? i === ptr % fila.length : false,
      em_aberto: emAberto.get(u.id).n,
    })),
  });
});

/* Prontidão do dia. O próprio usuário pode se prontificar; SDR/ADM ajustam a
   de qualquer um.
   Toda mudança vira uma linha no histórico, com a hora e quem fez — é o que
   permite separar "ele se prontificou" de "o sistema desligou no fim do dia". */
r.post("/availability", (req, res) => {
  const { user_id, available } = req.body || {};
  const target = user_id || req.user.id;
  if (target !== req.user.id && !["sdr", "adm"].includes(req.user.role))
    return res.status(403).json({ error: "Só a SDR/ADM altera a disponibilidade de outros" });

  const alvo = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(target, req.user.org_id);
  if (!alvo) return res.status(404).json({ error: "Pessoa não encontrada" });

  const ligar = !!available;
  /* Ponto da atendente: entrada só é aceita com o local declarado, e "fora da
     imobiliária" exige o motivo. A conferência é aqui, no servidor — deixar
     isso só no popup permitiria bater ponto em branco chamando a rota direto.
     Vale inclusive quando é o gestor quem marca por ela. */
  const impedimento = validarPonto({ role: alvo.role, ativo: ligar,
    local: req.body?.local, observacao: req.body?.observacao });
  if (impedimento) return res.status(400).json({ error: impedimento, precisa_local: true });

  // Clicar duas vezes no mesmo estado não vira duas linhas no histórico.
  if (!!alvo.available === ligar) return res.json({ ok: true, sem_mudanca: true, available: ligar });

  db.prepare("UPDATE users SET available = ?, available_desde = ? WHERE id = ?")
    .run(ligar ? 1 : 0, ligar ? Date.now() : null, alvo.id);
  /* Se a pessoa está escalada hoje, isso entra no registro. É a mesma ideia
     do ponto da atendente: a marcação passa a dizer em que condição ela foi
     feita, e não só a hora. Depois dá para separar "se prontificou num dia
     comum" de "se prontificou no dia do plantão dele". */
  const escalaHoje = plantaoDoDia(req.user.org_id);
  const meusTurnos = TURNOS_PLANTAO.filter(t => escalaHoje[t].some(x => x.user_id === alvo.id));

  registrar({ orgId: req.user.org_id, userId: alvo.id, ativo: ligar,
    plantao: meusTurnos.length ? meusTurnos.join(",") : null,
    origem: target === req.user.id ? "proprio" : "gestor",
    autor: target === req.user.id ? null : { id: req.user.id, name: req.user.name },
    local: ligar && ehPonto(alvo.role) ? req.body.local : null,
    observacao: ligar && ehPonto(alvo.role) && req.body.local === "fora"
      ? String(req.body.observacao).trim().slice(0, 400) : null });

  const horario = lerHorario(expedienteDa(req.user.org_id));
  res.json({ ok: true, available: ligar, ponto: ehPonto(alvo.role),
    plantao: meusTurnos, vale_ate: ligar && horario ? proximoCorte(horario) : null });
});

/* Até quando a prontidão de hoje vale. A tela do corretor usa para dizer
   "sua disponibilidade cai às 18:00" em vez de ele descobrir sozinho. */
r.get("/expediente", (req, res) => {
  const txt = expedienteDa(req.user.org_id);
  const horario = lerHorario(txt);
  res.json({ fim: horario ? txt : null, padrao: PADRAO,
    proximo_corte: horario ? proximoCorte(horario) : null });
});

// Só o gestor muda o horário. Vazio desliga o corte automático.
/* Clientes esperando resposta, e o tempo combinado para o aviso.
   Aberto a quem supervisiona: é material de cobrança. */
r.get("/sem-resposta", roles("adm", "sdr"), (req, res) => {
  const minutos = minutosDaOrg(req.user.org_id);
  res.json({ minutos, leads: esperando(req.user.org_id, { minutos }) });
});

r.patch("/sem-resposta", roles("adm"), (req, res) =>
  res.json({ minutos: definirMinutos(req.user.org_id, req.body && req.body.minutos) }));

r.patch("/expediente", roles("adm"), (req, res) => {
  const bruto = req.body?.fim == null ? PADRAO : String(req.body.fim).trim();
  if (bruto && !lerHorario(bruto))
    return res.status(400).json({ error: "Informe o horário como HH:MM (ex.: 18:00), ou deixe em branco para desligar." });
  db.prepare("UPDATE orgs SET expediente_fim = ? WHERE id = ?").run(bruto, req.user.org_id);
  const horario = lerHorario(bruto);
  res.json({ ok: true, fim: bruto || null, proximo_corte: horario ? proximoCorte(horario) : null });
});

/* Histórico de disponibilidade — para a atendente e a gestão.
   Fora do alcance do corretor de propósito: é material de cobrança, e quem
   cobra é quem supervisiona. Cada um vê o próprio pelo ?eu=1. */
r.get("/disponibilidade/historico", (req, res) => {
  const supervisiona = ["sdr", "adm"].includes(req.user.role);
  const userId = supervisiona ? (req.query.user_id || null) : req.user.id;
  if (!supervisiona && req.query.user_id && req.query.user_id !== req.user.id)
    return res.status(403).json({ error: "Você vê apenas o seu próprio histórico." });
  res.json({
    eventos: historico(req.user.org_id, { dias: req.query.dias, userId }),
    resumo: supervisiona ? resumoDoDia(req.user.org_id) : null,
    expediente_fim: expedienteDa(req.user.org_id) || null,
  });
});

// Catraca manual: transfere um lead da fila para um atendente específico (disponível).
r.post("/transfer", roles("sdr", "adm"), (req, res) => {
  const { lead_id, user_id } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ?").get(user_id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Atendente não encontrado" });
  if (!u.available) return res.status(409).json({ error: "Atendente indisponível — não entra na catraca" });
  const info = db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ? AND org_id = ?").run(user_id, Date.now(), lead_id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  res.json({ ok: true, assigned_to: user_id, aviso: avisarNovoLead(user_id, lead_id) });
});

// Catraca automática (rodízio): entrega ao próximo atendente disponível.
r.post("/next", roles("sdr", "adm"), (req, res) => {
  const { lead_id } = req.body || {};
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
  const avl = db.prepare(
    `SELECT u.id FROM users u WHERE u.org_id = ? AND u.role IN ('corretor','sdr') AND u.available = 1${semMaster("u")} ORDER BY u.name`
  ).all(req.user.org_id);
  if (!avl.length) return res.status(409).json({ error: "Ninguém disponível na catraca" });
  const ptr = org.distribution_ptr % avl.length;
  const chosen = avl[ptr].id;
  const info = db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ? AND org_id = ?").run(chosen, Date.now(), lead_id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  db.prepare("UPDATE orgs SET distribution_ptr = ? WHERE id = ?").run(org.distribution_ptr + 1, org.id);
  res.json({ ok: true, assigned_to: chosen, aviso: avisarNovoLead(chosen, lead_id) });
});

// Repasse da SDR: ela faz o 1º atendimento e passa o lead para o CORRETOR da vez
// (rodízio entre corretores disponíveis) ou para um corretor específico. O lead deixa de ser dela.
r.post("/handoff", roles("sdr", "adm"), (req, res) => {
  const { lead_id, user_id } = req.body || {};
  let chosen = user_id;
  if (chosen) {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role = 'corretor'").get(chosen, req.user.org_id);
    if (!u) return res.status(404).json({ error: "Corretor não encontrado" });
    if (!u.available) return res.status(409).json({ error: "Corretor indisponível" });
  } else {
    const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.user.org_id);
    const corr = db.prepare(`SELECT u.id FROM users u WHERE u.org_id = ? AND u.role = 'corretor' AND u.available = 1${semMaster("u")} ORDER BY u.name`).all(req.user.org_id);
    if (!corr.length) return res.status(409).json({ error: "Nenhum corretor disponível" });
    chosen = corr[org.distribution_ptr % corr.length].id;
    db.prepare("UPDATE orgs SET distribution_ptr = ? WHERE id = ?").run(org.distribution_ptr + 1, org.id);
  }
  const info = db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ? AND org_id = ?").run(chosen, Date.now(), lead_id, req.user.org_id);
  if (!info.changes) return res.status(404).json({ error: "Lead não encontrado" });
  res.json({ ok: true, assigned_to: chosen, aviso: avisarNovoLead(chosen, lead_id) });
});

// A ADM assume a negociação: o lead passa a ser dela e sai da lista do corretor.
// Sem checagem de disponibilidade — a ADM não entra no rodízio da catraca, ela
// intervém quando quer (atendimento travado, cliente importante, corretor ausente).
r.post("/assumir", roles("adm", "sdr"), (req, res) => {
  const { lead_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(lead_id, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (lead.assigned_to === req.user.id) return res.json({ ok: true, ja_era_seu: true });

  const anterior = lead.assigned_to
    ? db.prepare("SELECT name FROM users WHERE id = ?").get(lead.assigned_to)
    : null;
  db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ?").run(req.user.id, Date.now(), lead.id);
  res.json({ ok: true, tirado_de: anterior ? anterior.name : "fila" });
});

// Devolve o lead: para um corretor específico, ou de volta à fila da catraca
// (sem user_id). Contrapartida do "assumir" — a ADM não fica com o lead preso.
r.post("/devolver", roles("adm", "sdr"), (req, res) => {
  const { lead_id, user_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(lead_id, req.user.org_id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

  if (!user_id) {
    db.prepare("UPDATE leads SET assigned_to = NULL, assigned_at = NULL WHERE id = ?").run(lead.id);
    return res.json({ ok: true, destino: "fila" });
  }
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role IN ('corretor','sdr')").get(user_id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Atendente não encontrado" });
  db.prepare("UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ?").run(u.id, Date.now(), lead.id);
  res.json({ ok: true, destino: u.name });
});

/* Aviso de lead novo na mão do corretor.

   O DISPARO fica fora do fluxo da resposta de propósito: se o push demorar ou
   falhar, a transferência já aconteceu e não pode ser desfeita por causa disso.

   Mas a RESPOSTA agora diz se ele vai mesmo ser avisado, e isso é outra coisa.
   Antes o repasse respondia "ok" tanto para o corretor que recebe push no
   celular quanto para o que não recebe nada — e a atendente passava o lead
   achando que alguém tinha sido chamado. Lead entregue para quem não sabe que
   recebeu fica parado exatamente como se não tivesse sido entregue.

   A conferência é barata e imediata: o servidor tem chave VAPID? e este
   corretor cadastrou algum aparelho? Não é promessa de entrega — o celular
   pode estar sem sinal —, é a resposta honesta para "ele vai ser avisado?". */
function avisarNovoLead(userId, leadId) {
  const lead = db.prepare("SELECT name FROM leads WHERE id = ?").get(leadId);
  avisar(userId, {
    titulo: "Novo lead com você",
    corpo: `${lead?.name || "Um lead"} acabou de entrar na sua lista. Fale agora — os primeiros minutos decidem.`,
    leadId,
  });
  if (!pushConfigurado()) return { push: false, motivo: "sem_push_no_servidor" };
  if (!inscricoesDe(userId)) return { push: false, motivo: "corretor_sem_notificacao" };
  return { push: true };
}

export default r;
