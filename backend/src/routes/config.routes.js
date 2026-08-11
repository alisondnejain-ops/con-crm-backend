/* Configurações da imobiliária.

   Duas seções, e a divisão não é estética: são coisas de dono diferente.

   - MENSAGENS AUTOMÁTICAS: texto de abordagem. Muda toda semana conforme o
     que está convertendo, e quem sabe isso é quem atende — por isso gestor E
     atendente editam.
   - CONEXÃO: o WhatsApp da imobiliária. Mexer aqui derruba o atendimento de
     todo mundo, então é só do gestor. */

import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, roles } from "../auth.js";
import { instanceStatus, desconectarInstancia, uazapiConfigured, PROVEDORES } from "../services/uazapi.js";

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

/* ===== CONEXÃO =====

   Hoje só a Uazapi, e ela é API NÃO OFICIAL — isso fica escrito na tela, não
   escondido: quem assina a conta precisa saber que o número pode ser banido
   pelo WhatsApp. Quando entrar outro provedor, ele vira mais um item da mesma
   lista. */
r.get("/conexao", roles("adm", "sdr"), async (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.json({
    provedores: PROVEDORES,
    ativo: uazapiConfigured() ? "uazapi" : null,
    whatsapp: await instanceStatus(),
    webhook: {
      url: `${base}/webhooks/uazapi`,
      // O que precisa estar ligado do lado da Uazapi para a conversa chegar.
      eventos: ["Mensagens (messages)"],
      observacao: "Cole esta URL no campo de Webhook da instância. Sem ela, o CRM envia mas não recebe.",
    },
  });
});

/* Desconectar derruba o WhatsApp da imobiliária inteira: ninguém envia nem
   recebe até parear de novo. Por isso é só do gestor e pede confirmação
   escrita na tela. */
r.post("/conexao/desconectar", roles("adm"), async (req, res) => {
  if (String(req.body?.confirmar || "").toUpperCase() !== "DESCONECTAR")
    return res.status(400).json({ error: "Escreva DESCONECTAR para confirmar." });
  try {
    const out = await desconectarInstancia();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: "Não consegui desconectar", detail: e.message });
  }
});

export default r;
