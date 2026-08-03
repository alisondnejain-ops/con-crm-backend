import { Router } from "express";
import db from "../db.js";
import { instanceStatus } from "../services/uazapi.js";
import { mailConfigured } from "../services/mail.js";
import { ultimosEventos } from "./uazapi.webhook.js";
import { modoArmazenamento, usandoR2, salvar, apagar, conferirR2, falhaR2 } from "../services/storage.js";

const r = Router();

// Painel de instalação: diz o que já está ligado, SEM devolver nenhum segredo.
// Tokens e senhas nunca aparecem aqui — só "configurado: true/false" e o estado da conexão.
r.get("/integracoes", async (_req, res) => {
  const org = db.prepare("SELECT name FROM orgs LIMIT 1").get();
  const n = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;

  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  res.json({
    org: org?.name || null,
    cole_este_webhook_na_uazapi: `${base}/webhooks/uazapi`,
    whatsapp: await instanceStatus(),
    meta: { configurado: !!(process.env.META_VERIFY_TOKEN && process.env.META_PAGE_ACCESS_TOKEN) },
    email: { configurado: mailConfigured() },
    arquivos: { modo: modoArmazenamento(), r2: usandoR2(), conferencia: conferirR2(), ultima_falha: falhaR2() },
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

/* Teste do armazenamento: grava um arquivo de verdade, confere que ele abre
   pela URL pública e apaga. Vale mais que "as variáveis estão preenchidas" —
   chave certa com bucket sem acesso público passa na conferência e falha na
   hora de o corretor abrir a foto.

   Fica FORA do login de propósito: é um teste de instalação, e exigir token
   aqui obrigava a abrir o console do navegador — o que na prática significava
   ninguém conseguir rodar. Não devolve segredo nenhum, só o resultado dos três
   passos, e a espera de 30s abaixo impede que alguém fique chamando em série. */
let ultimoTeste = { quando: 0, resposta: null };
const ESPERA_TESTE = 30000;

r.get("/integracoes/armazenamento/teste", async (_req, res) => {
  if (ultimoTeste.resposta && Date.now() - ultimoTeste.quando < ESPERA_TESTE)
    return res.json({ ...ultimoTeste.resposta, nota: "resultado dos últimos 30 segundos" });
  // PNG de 1 pixel, o menor arquivo válido possível.
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const passos = [];
  const conferencia = conferirR2();
  const responder = (corpo, status = 200) => {
    const resposta = { ...corpo, conferencia };
    ultimoTeste = { quando: Date.now(), resposta };
    res.status(status).json(resposta);
  };

  // Erro de digitação na variável é o motivo de quase toda falha aqui, e a
  // mensagem que a Cloudflare devolve não diz qual campo está errado. Melhor
  // parar antes e apontar o campo.
  if (usandoR2() && conferencia.problemas.length)
    return responder({ modo: modoArmazenamento(), tudo_certo: false, passos,
      erro: "Tem variável do R2 com problema — veja a conferência abaixo. Corrija no painel da hospedagem e faça o deploy de novo." });

  let chave = null;
  try {
    const r1 = await salvar({ buffer, mime: "image/png", prefixo: "teste" });
    chave = r1.chave;
    /* salvar() cai para o disco quando o R2 recusa — de propósito, para o
       corretor não ficar travado. Aqui isso NÃO pode passar como sucesso: é
       justamente o que este teste existe para revelar. */
    const caiu = usandoR2() && falhaR2();
    passos.push({ passo: "gravar", ok: !caiu, url: r1.url,
      erro: caiu ? "O R2 recusou o arquivo: " + caiu.erro : undefined,
      dica: caiu ? "As fotos estão sendo salvas no disco da hospedagem, que some quando o servidor é trocado. Confira as variáveis R2_* na conferência abaixo." : undefined });

    let leitura;
    try {
      const resp = await fetch(r1.url);
      leitura = { ok: resp.ok, status: resp.status, tipo: resp.headers.get("content-type") };
    } catch (e) { leitura = { ok: false, erro: e.message }; }
    passos.push({ passo: "abrir pela URL pública", ...leitura,
      dica: leitura.ok ? undefined : "O arquivo subiu mas não abre. No R2, isso quase sempre é o bucket sem domínio público ligado (R2_PUBLIC_URL)." });

    await apagar(chave);
    passos.push({ passo: "apagar", ok: true });
    responder({ modo: modoArmazenamento(), tudo_certo: passos.every(p => p.ok !== false), passos });
  } catch (e) {
    if (chave) await apagar(chave).catch(() => {});
    responder({ modo: modoArmazenamento(), tudo_certo: false, erro: e.message, passos }, 500);
  }
});

export default r;
