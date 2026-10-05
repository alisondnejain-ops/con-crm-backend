/* O ASSISTENTE (Claude) E A NUVEM DE SUPORTE (05/10/2026).

   `/assistente` — configurar a conta conversando. Só quem administra a conta
   (gestor, ou o dono da conta de autônomo): é configuração, e as ferramentas
   chamam rotas que já são da gestão. Fica atrás do porteiro da assinatura,
   como o resto do sistema.

   `/suporte` — a nuvem do canto da tela, para TODO mundo da equipe. Fica
   FORA do porteiro de propósito: conta travada por pagamento é justamente a
   que mais precisa falar com o suporte. Exige só estar logado.

   `/suporte/hub` — a configuração do suporte e a lista de chamados, no hub do
   master. */

import { Router } from "express";
import db from "../db.js";
import { authRequired, soMaster, ehDonoAutonomo } from "../auth.js";
import { daEquipeConHub } from "../services/interno.js";
import {
  conversar, conversaAtual, novaConversa, itensDa, disponibilidade,
  FERRAMENTAS_CONFIG, executorDeConfig, sistemaDeConfig,
  FERRAMENTAS_CONSULTA, executorDeConsulta, sistemaDeConsulta,
} from "../services/assistente.js";
import {
  sistemaDeSuporte, FERRAMENTAS_SUPORTE, executorDeSuporte,
  chamadoAberto, mensagensDo, abrirChamado, mensagemDoCliente, fecharChamado,
  respostaDoSuporte, configDoSuporte, salvarConfig, testarEnvio, chamadosParaOHub, chamadosEsperando,
} from "../services/suporte.js";

const orgDe = (orgId) => db.prepare("SELECT id, name, tipo FROM orgs WHERE id = ?").get(orgId);
const textoDoCorpo = (req) => String(req.body?.texto || "").trim().slice(0, 4000);

/* ===== O ASSISTENTE =====
   Dois modos, decididos AQUI e não na tela: quem administra a conta (gestor,
   ou o dono da conta de autônomo) configura; a atendente e o corretor só
   CONSULTAM (05/10/2026) — tiram dúvidas e pesquisam, sem nenhuma ferramenta
   que mude a conta. As conversas dos dois modos são separadas (`tipo`). */
export const assistente = Router();
const configura = (user) => user.role === "adm" || ehDonoAutonomo(user);
const modoDe = (user) => (configura(user) ? "config" : "consulta");

assistente.get("/", (req, res) => {
  const modo = modoDe(req.user);
  res.json({ ...disponibilidade(req.user, modo), modo, itens: itensDa(conversaAtual(req.user.id, modo)) });
});

assistente.post("/nova", (req, res) => {
  const modo = modoDe(req.user);
  novaConversa(req.user, modo);
  res.json({ ...disponibilidade(req.user, modo), modo, itens: [] });
});

assistente.post("/mensagem", async (req, res) => {
  const modo = modoDe(req.user);
  const texto = textoDoCorpo(req);
  if (!texto) return res.status(400).json({ error: modo === "config" ? "Escreva o que você quer configurar." : "Escreva a sua pergunta." });
  const disp = disponibilidade(req.user, modo);
  if (!disp.disponivel) return res.status(409).json({ error: disp.motivo });
  const conversa = conversaAtual(req.user.id, modo) || novaConversa(req.user, modo);
  const autorizacao = req.headers.authorization;
  const r = await conversar(modo === "config" ? {
    conversa, user: req.user, tipo: "config", texto, effort: "medium",
    system: sistemaDeConfig(req.user, orgDe(req.user.org_id)),
    tools: FERRAMENTAS_CONFIG,
    executar: executorDeConfig({ autorizacao, user: req.user, conversaId: conversa.id }),
  } : {
    conversa, user: req.user, tipo: "consulta", texto, effort: "medium",
    system: sistemaDeConsulta(req.user, orgDe(req.user.org_id)),
    tools: FERRAMENTAS_CONSULTA(),
    executar: executorDeConsulta({ autorizacao }),
  });
  res.json({ ...r, ...disponibilidade(req.user, modo), modo });
});

/* ===== NUVEM DE SUPORTE ===== */
export const suporte = Router();
suporte.use(authRequired);

function estado(user, { marcarLidas = false } = {}) {
  const ch = chamadoAberto(user.id)
    || db.prepare(`SELECT * FROM suporte_chamados WHERE user_id = ? AND status = 'fechado'
        AND fechado_em > ? ORDER BY fechado_em DESC LIMIT 1`).get(user.id, Date.now() - 6 * 3600000) || null;
  const naoLidas = ch ? db.prepare(`SELECT COUNT(*) n FROM suporte_mensagens
    WHERE chamado_id = ? AND de IN ('suporte','sistema') AND lida = 0`).get(ch.id).n : 0;
  if (ch && marcarLidas) db.prepare("UPDATE suporte_mensagens SET lida = 1 WHERE chamado_id = ? AND lida = 0").run(ch.id);
  return {
    ia: { ...disponibilidade(user, "suporte"), itens: itensDa(conversaAtual(user.id, "suporte")) },
    chamado: ch ? { numero: ch.numero, status: ch.status, mensagens: mensagensDo(ch.id) } : null,
    nao_lidas: naoLidas,
  };
}

suporte.get("/", (req, res) => res.json(estado(req.user, { marcarLidas: req.query.ler === "1" })));
suporte.get("/nao-lidas", (req, res) => res.json({ nao_lidas: estado(req.user).nao_lidas }));

suporte.post("/mensagem", async (req, res) => {
  const texto = textoDoCorpo(req);
  if (!texto) return res.status(400).json({ error: "Escreva a sua dúvida." });

  // Conversa com o suporte aberta: vai direto para a pessoa.
  if (chamadoAberto(req.user.id)) {
    const r = await mensagemDoCliente(req.user, texto);
    if (r.erro) return res.status(400).json({ error: r.erro });
    return res.json({ ...estado(req.user, { marcarLidas: true }), aviso: r.aviso });
  }
  /* Sem IA (chave ausente ou teto do mês): a dúvida vai para uma pessoa —
     a nuvem nunca fica sem resposta por causa da IA. */
  const disp = disponibilidade(req.user, "suporte");
  if (!disp.disponivel) {
    await abrirChamado(req.user, { resumo: texto });
    return res.json(estado(req.user, { marcarLidas: true }));
  }
  const conversa = conversaAtual(req.user.id, "suporte") || novaConversa(req.user, "suporte");
  const r = await conversar({
    conversa, user: req.user, tipo: "suporte", texto, effort: "low",
    system: sistemaDeSuporte(req.user, orgDe(req.user.org_id)),
    tools: FERRAMENTAS_SUPORTE, executar: executorDeSuporte(),
  });
  res.json({ ...estado(req.user), navegar: r.navegar, humano: r.humano });
});

// "Falar com o suporte" — com o resumo da triagem, ou com o que a pessoa escreveu.
suporte.post("/humano", async (req, res) => {
  let resumo = String(req.body?.resumo || "").trim();
  if (!resumo) {
    const ditas = itensDa(conversaAtual(req.user.id, "suporte")).filter(i => i.de === "voce").slice(-5).map(i => "• " + i.texto);
    resumo = ditas.length ? "O cliente escreveu:\n" + ditas.join("\n") : "";
  }
  const r = await abrirChamado(req.user, { resumo, contato: req.body?.contato });
  res.json({ ...estado(req.user, { marcarLidas: true }), entregue: r.entregue });
});

suporte.post("/fechar", async (req, res) => {
  await fecharChamado(chamadoAberto(req.user.id), "cliente");
  res.json(estado(req.user, { marcarLidas: true }));
});

// Recomeçar a conversa com a IA (a anterior fica guardada).
suporte.post("/nova", (req, res) => {
  novaConversa(req.user, "suporte");
  res.json(estado(req.user));
});

/* ===== HUB DO MASTER E TELA DE SUPORTE DO AMBIENTE INTERNO =====

   A configuração (número que recebe, linha que envia) continua só do master.
   A FILA de chamados abre também para a equipe do ConHub — quem está ativo
   no ambiente interno (05/10/2026): o suporte vai ser um time, e cada pessoa
   dele responde de dentro do sistema, com o próprio login. */
const equipeDeSuporte = (req, res, next) => {
  const master = db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id)?.master;
  if (master || daEquipeConHub(req.user.id)) return next();
  res.status(403).json({ error: "Área restrita à equipe do ConHub." });
};

suporte.get("/chamados", equipeDeSuporte, (req, res) => res.json({ chamados: chamadosParaOHub(), config: configDoSuporte(), esperando: chamadosEsperando() }));
// O número ao lado de "Suporte" no menu do ambiente interno.
suporte.get("/chamados/esperando", equipeDeSuporte, (req, res) => res.json({ esperando: chamadosEsperando() }));

suporte.get("/hub", soMaster, (req, res) => res.json({
  config: configDoSuporte(), chamados: chamadosParaOHub(),
  contas: db.prepare(`SELECT o.id, o.name, (SELECT COUNT(*) FROM canais c WHERE c.org_id = o.id
      AND c.tipo = 'imobiliaria' AND c.token IS NOT NULL AND c.token <> '') AS linha
    FROM orgs o ORDER BY o.name`).all().map(o => ({ id: o.id, nome: o.name, linha_ligada: !!o.linha })),
}));

suporte.patch("/hub/config", soMaster, (req, res) => {
  const r = salvarConfig(req.body || {});
  if (r.erro) return res.status(400).json({ error: r.erro });
  res.json(r);
});

suporte.post("/hub/teste", soMaster, async (req, res) => {
  const r = await testarEnvio();
  if (!r.ok) return res.status(502).json({ error: r.erro });
  res.json({ ok: true });
});

const chamadoDoHub = (req, res) => {
  const ch = db.prepare("SELECT * FROM suporte_chamados WHERE id = ?").get(req.params.id);
  if (!ch) { res.status(404).json({ error: "Chamado não encontrado." }); return null; }
  return ch;
};
suporte.get("/hub/chamados/:id", equipeDeSuporte, (req, res) => {
  const ch = chamadoDoHub(req, res); if (!ch) return;
  res.json({ numero: ch.numero, status: ch.status, resumo: ch.resumo, mensagens: mensagensDo(ch.id) });
});
suporte.post("/hub/chamados/:id/responder", equipeDeSuporte, async (req, res) => {
  const ch = chamadoDoHub(req, res); if (!ch) return;
  const r = await respostaDoSuporte(ch, textoDoCorpo(req), { viaPainel: true, por: req.user.name || null });
  if (r.erro) return res.status(400).json({ error: r.erro });
  res.json({ ok: true, mensagens: mensagensDo(ch.id) });
});
suporte.post("/hub/chamados/:id/fechar", equipeDeSuporte, async (req, res) => {
  const ch = chamadoDoHub(req, res); if (!ch) return;
  await fecharChamado(ch, "suporte");
  res.json({ ok: true });
});
