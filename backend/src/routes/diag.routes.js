import { Router } from "express";
import db from "../db.js";
import { instanceStatus } from "../services/uazapi.js";
import { mailConfigured } from "../services/mail.js";
import { ultimosEventos } from "./uazapi.webhook.js";

const r = Router();

// Painel de instalação: diz o que já está ligado, SEM devolver nenhum segredo.
// Tokens e senhas nunca aparecem aqui — só "configurado: true/false" e o estado da conexão.
r.get("/integracoes", async (_req, res) => {
  const org = db.prepare("SELECT name FROM orgs LIMIT 1").get();
  const n = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;

  res.json({
    org: org?.name || null,
    whatsapp: await instanceStatus(),
    meta: { configurado: !!(process.env.META_VERIFY_TOKEN && process.env.META_PAGE_ACCESS_TOKEN) },
    email: { configurado: mailConfigured() },
    banco: {
      caminho: process.env.DB_PATH ? "disco persistente" : "dentro do container (some no deploy)",
      usuarios: n("SELECT COUNT(*) n FROM users"),
      pendentes: n("SELECT COUNT(*) n FROM users WHERE status = 'pendente'"),
      leads: n("SELECT COUNT(*) n FROM leads"),
      leads_na_fila: n("SELECT COUNT(*) n FROM leads WHERE assigned_to IS NULL"),
      mensagens: n("SELECT COUNT(*) n FROM messages"),
    },
  });
});

// Últimos webhooks recebidos da Uazapi — para conferir a instalação.
// Mostra só o resultado do processamento, nunca o conteúdo das conversas.
r.get("/integracoes/webhooks", (_req, res) => res.json({ recebidos: ultimosEventos.length, eventos: ultimosEventos }));

export default r;
