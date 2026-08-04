/* Escala de plantão.

   A LISTA é aberta a toda a equipe: saber quem está de plantão amanhã é
   informação de operação, não de gestão — o corretor precisa se planejar e o
   colega precisa saber para quem ligar.

   MEXER na escala é da gestão (gestor e atendente), que é quem monta o mês. */

import { Router } from "express";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";
import { escala, doDia, definirTurno, limpar, importarEscala, meiaNoite, TURNOS } from "../services/plantao.js";

const r = Router();
r.use(authRequired);

const DIA = 86400000;

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
    porDia.get(l.dia)[l.turno].push({ id: l.user_id, nome: l.nome });
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
  res.json(importarEscala(req.user.org_id, linhas, req.user.id));
});

export default r;
