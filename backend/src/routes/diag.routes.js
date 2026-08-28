import { Router } from "express";
import db from "../db.js";
import { instanceStatus, citacaoDiagnostico, edicaoDiagnostico } from "../services/uazapi.js";
import { mailConfigured } from "../services/mail.js";
import { iaConfigurada, modeloIA } from "../services/ia.js";
import { ultimosEventos } from "./uazapi.webhook.js";
import { modoArmazenamento, usandoR2, salvar, apagar, conferirR2, falhaR2 } from "../services/storage.js";
/* A tradução dos erros do R2 mora no backup.js porque foi lá que ela nasceu.
   Aqui ela vale igual: este teste é a prova de fogo do armazenamento, e devolver
   "@aws-sdk XML parse error… inspect the hidden field {error}.$response" numa
   tela feita para diagnóstico é entregar o problema sem a pista. */
import { emPortugues } from "../services/backup.js";

const r = Router();
// Quando este processo subiu — a lista de webhooks abaixo só vale a partir daqui.
const inicio = Date.now();

// Painel de instalação: diz o que já está ligado, SEM devolver nenhum segredo.
// Tokens e senhas nunca aparecem aqui — só "configurado: true/false" e o estado da conexão.
r.get("/integracoes", async (_req, res) => {
  /* Painel da INSTALAÇÃO: mostra a imobiliária mais antiga, que é a dona deste
     servidor. Com várias na plataforma, cada uma vê a sua conexão na própria
     tela de Configurações — aqui não daria para escolher, porque esta página
     não pede login. */
  const org = db.prepare("SELECT id,name FROM orgs ORDER BY created_at, name LIMIT 1").get();
  const n = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;

  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  res.json({
    org: org?.name || null,
    imobiliarias: db.prepare("SELECT COUNT(*) n FROM orgs").get().n,
    cole_este_webhook_na_uazapi: `${base}/webhooks/uazapi`,
    whatsapp: await instanceStatus(org?.id),
    meta: { configurado: !!(process.env.META_VERIFY_TOKEN && process.env.META_PAGE_ACCESS_TOKEN) },
    email: { configurado: mailConfigured() },
    /* IA: liga a leitura do print da Caixa e o resumo da conversa. A chave
       nunca aparece aqui — só se ela chegou e qual modelo está em uso, que é
       o bastante para saber se falta configurar ou se o problema é outro. */
    ia: { configurada: iaConfigurada(), modelo: iaConfigurada() ? modeloIA() : null,
      recursos: iaConfigurada() ? ["resumo da conversa", "leitura do print da Caixa"] : [] },
    arquivos: { modo: modoArmazenamento(), r2: usandoR2(), conferencia: conferirR2(), ultima_falha: falhaR2() },
    // Última tentativa de citar uma mensagem: o que foi mandado e o que voltou.
    // A citação falha calada, então é aqui que se descobre o motivo.
    citacao: citacaoDiagnostico() || "nenhuma tentativa desde que o servidor subiu",
    edicao: edicaoDiagnostico() || "nenhuma tentativa desde que o servidor subiu",
    /* QUANDO foi a última vez que entrou alguma coisa.

       É a pergunta que se faz quando alguém diz "parou de chegar lead", e o
       painel não respondia: dava para ver quantos leads existem, não quando o
       último chegou. Sem isso, "parou agora" e "parou há três dias" são
       indistinguíveis — e são problemas completamente diferentes.

       A mensagem RECEBIDA é o sinal mais sensível: ela chega pelo mesmo
       webhook do lead novo. Se as mensagens continuam entrando e leads não,
       o WhatsApp está de pé e o problema é outro. Se as duas pararam na mesma
       hora, o caminho até aqui é que caiu. */
    ultima_entrada: (() => {
      const q = (sql) => db.prepare(sql).get()?.q || null;
      const desde = (ms) => ms ? { em: new Date(ms).toISOString(), ha_minutos: Math.round((Date.now() - ms) / 60000) } : null;
      return {
        lead: desde(q("SELECT MAX(created_at) q FROM leads")),
        mensagem_recebida: desde(q("SELECT MAX(created_at) q FROM messages WHERE direction='in'")),
        mensagem_enviada: desde(q("SELECT MAX(created_at) q FROM messages WHERE direction='out'")),
      };
    })(),
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
r.get("/integracoes/webhooks", (_req, res) => res.json({
  /* A lista vive na memória e zera a cada publicação. Dizer isso junto evita a
     leitura errada mais provável: lista vazia logo depois de um deploy não
     significa que a Uazapi parou de chamar — significa que ainda não chamou
     DESDE o deploy. */
  no_ar_desde: new Date(inicio).toISOString(),
  ha_minutos: Math.round((Date.now() - inicio) / 60000),
  observacao: "Esta lista zera a cada publicação. Vazia logo após um deploy não quer dizer que a Uazapi parou — quer dizer que ela ainda não chamou desde então.",
  recebidos: ultimosEventos.length,
  eventos: ultimosEventos,
}));

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
      erro: caiu ? "O R2 recusou o arquivo: " + emPortugues({ message: caiu.erro, name: caiu.nome }) : undefined,
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
    responder({ modo: modoArmazenamento(), tudo_certo: false, erro: emPortugues(e), passos }, 500);
  }
});

export default r;
