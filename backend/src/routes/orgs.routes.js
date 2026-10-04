/* Hub de contas — a camada da PLATAFORMA, acima das imobiliárias.

   O ConHub deixou de ser o CRM de uma imobiliária só. Quem mantém a plataforma
   (o gestor master) entra e escolhe em qual cliente vai trabalhar; quem
   trabalha na imobiliária nem sabe que esta camada existe.

   A troca é feita no TOKEN: `POST /orgs/:id/entrar` devolve um crachá novo,
   da mesma pessoa, valendo para a imobiliária escolhida. Foi de propósito —
   todas as rotas do sistema já liam req.user.org_id, então nenhuma delas
   precisou mudar para virar multi-imobiliária.

   Tudo aqui exige master, conferido no banco (ver auth.js -> soMaster). */

import { Router } from "express";
import { randomUUID, randomBytes } from "crypto";
import db from "../db.js";
import { authRequired, soMaster, sign, semMaster, resumoDeConvite, encerrarSessoes } from "../auth.js";
import { situacaoDoBackup, rodarBackup } from "../services/backup.js";
import { situacao } from "../services/assinatura.js";
import { cancelarAssinatura } from "../services/asaas.js";
import { definirLiberacao } from "../services/marketing.js";
import { recursosDaOrg, definirPeloMaster, ehRecurso, RECURSOS } from "../services/recursos.js";
import { apagar as apagarArquivo, salvar, tipoPermitido, ehVideo } from "../services/storage.js";
import { marcaDaOrg } from "../services/marca.js";
import { dominiosDaPlataforma, definirDestino, verificarDominio } from "../services/site.js";
import { removerDominio, railwayPronto } from "../services/railway.js";
import { provedorDe, PROVEDORES, temCobrancaNoAsaas, pagarmePadrao } from "../services/cobranca.js";
import { pagarmeConfigurado, ambientePagarme } from "../services/pagarme.js";
import { cancelarTudoNoPagarme } from "./assinatura.routes.js";
import { codigoLivre } from "../services/codigo.js";
import { sendMail, mailConfigured, inviteEmail } from "../services/mail.js";
import { reseedDemo, ORG_ID as DEMO_ORG_ID, CREDENCIAIS as CREDENCIAIS_DEMO } from "../services/demo.js";

const r = Router();
r.use(authRequired, soMaster);

/* O endereço público do site. Vale para os dois links que saem daqui: o de
   cadastro da equipe e o de convite de sócio. Sai do SITE_URL/APP_URL porque o
   host da requisição pode ser o endereço interno da hospedagem, que não abre
   no celular de quem recebe o link. */
const siteUrl = (req) =>
  (process.env.SITE_URL || process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const linkCadastro = (req, code) => `${siteUrl(req)}/cadastro?c=${code}`;

/* Código da imobiliária: é a trava do cadastro e vai embutido no link, então
   precisa ser previsível e sem espaço. Maiúsculas, só letras, números e traço. */
const arrumarCodigo = (v) => String(v || "").trim().toUpperCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^A-Z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// Sugestão a partir do nome: "Conecta Imóveis" -> "CONECTA-IMOVEIS-2026"
const codigoSugerido = (nome) =>
  (arrumarCodigo(nome).split("-").slice(0, 2).join("-") || "IMOBILIARIA") + "-" + new Date().getFullYear();

import { limites as limitesDeCanais } from "../services/canais.js";

function resumo(req, org) {
  const n = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;
  const s = situacao(org.id);
  return {
    id: org.id,
    nome: org.name,
    codigo: org.adm_code,
    link_cadastro: linkCadastro(req, org.adm_code),
    // O master não conta como gente da imobiliária em lugar nenhum — nem aqui.
    equipe: n(`SELECT COUNT(*) n FROM users u WHERE u.org_id = ? AND u.status = 'ativo'${semMaster("u")}`, org.id),
    pendentes: n(`SELECT COUNT(*) n FROM users u WHERE u.org_id = ? AND u.status IN ('pendente','aguardando_aprovacao')${semMaster("u")}`, org.id),
    leads: n("SELECT COUNT(*) n FROM leads WHERE org_id = ?", org.id),
    na_fila: n("SELECT COUNT(*) n FROM leads WHERE org_id = ? AND assigned_to IS NULL", org.id),
    whatsapp: !!org.wa_connected,
    /* A marca entra no resumo porque é ele que o master recebe ao ENTRAR numa
       imobiliária. Sem isso o master trabalharia com a cor da casa anterior. */
    ...marcaDaOrg(org),
    assinatura: { status: s.status, cobranca: !!s.cobranca, vence_em: s.vence_em || null, valor: s.valor ?? null,
      liberado_ate: s.liberado_ate || null },
    /* Quantas linhas de WhatsApp esta conta tem ligadas, e o que elas somam por
       mês. É a resposta que o hub precisa dar de relance: o número extra é
       cobrado à parte, e sem ele na lista o master precisaria entrar em cada
       conta para saber quanto faturar. */
    canais: limitesDeCanais(org.id),
    criada_em: org.created_at || null,
    tipo: org.tipo || "imobiliaria",
    trial_ate: org.trial_ate || null,
    /* As ferramentas da conta e de onde cada uma vem (plano, avulso, você) —
       é o que o hub mostra ao lado dos botões de liberar e retirar. */
    recursos: recursosDaOrg(org.id),
    marketing_liberado: recursosDaOrg(org.id).find(x => x.id === "marketing").ativo,
    /* Por qual provedor esta conta é cobrada, e se foi escolha do master ou
       a regra padrão (04/10/2026). */
    cobranca: { provedor: provedorDe(org), escolhido: org.cobranca || null,
      tem_asaas: temCobrancaNoAsaas(org), tem_pagarme: !!org.pagarme_customer_id,
      padrao: pagarmePadrao() ? "pagarme" : "asaas",
      pagarme_ambiente: pagarmeConfigurado() ? ambientePagarme() : null },
  };
}

// As imobiliárias que existem. É a tela que abre quando o master entra.
r.get("/", (req, res) => {
  const orgs = db.prepare("SELECT * FROM orgs ORDER BY name").all().map(o => resumo(req, o));
  /* Duas listas, e não uma com um selo: no hub o master faz perguntas
     diferentes para cada uma. Imobiliária é cliente com equipe; autônomo é
     assinatura individual, quase sempre em teste, e nele o que importa é
     quantos dias faltam. Misturados, a segunda pergunta se perde no meio. */
  res.json({
    orgs: orgs.filter(o => o.tipo !== "autonomo"),
    autonomos: orgs.filter(o => o.tipo === "autonomo"),
    atual: req.user.org_id,
  });
});

/* Entrar numa imobiliária. Devolve um token novo — mesma pessoa, outra casa.
   O `master: true` viaja junto, então ele continua invisível para a equipe de
   lá e continua podendo voltar para o hub. */
r.post("/:id/entrar", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Imobiliária não encontrada." });
  const eu = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json({ token: sign(eu, { orgId: org.id }), org: resumo(req, org) });
});

/* ===== A CONTA DE DEMONSTRAÇÃO =====

   Renova sozinha de madrugada (ver services/demo.js), mas antes de uma
   reunião comercial o Ali não pode depender do relógio — este botão faz o
   mesmo trabalho na hora, sob pedido. */
r.post("/demo/atualizar", (req, res) => {
  const out = reseedDemo();
  res.json({ ok: true, ...out, org_id: DEMO_ORG_ID, credenciais: CREDENCIAIS_DEMO });
});

/* ===== SÓCIOS E ADMINISTRADORES DA PLATAFORMA =====

   O convite de MASTER, que é uma coisa diferente do convite de corretor.

   Até 26/08/2026 só existiam duas portas: `/cadastro?c=CODIGO`, que põe alguém
   dentro de UMA imobiliária, e a variável `MASTER_EMAIL` no servidor, que
   promove uma conta que já existe. Para um sócio novo entrar, alguém tinha que
   mexer na configuração da hospedagem — o que é pedir ao Ali exatamente o tipo
   de coisa que ele não faz sozinho.

   POR QUE NÃO É UM LINK COM CÓDIGO, como o dos corretores.

   O link do corretor pode ser repassado no grupo: quem entra por ele cai numa
   imobiliária só, com papel limitado, e ainda passa por aprovação. O master vê
   TODAS as imobiliárias, os clientes de todas elas e o que cada uma paga. Um
   link que possa ser encaminhado e usado por quem o receber cria um
   super-administrador da plataforma inteira — outra categoria de estrago.

   Por isso o convite é NOMINAL e de uso único: nasce preso a um e-mail, vale
   48h e morre quando a senha é definida. É o mesmo mecanismo do link de nova
   senha, que já existia e já era assim.

   O e-mail já cadastrado em qualquer imobiliária é RECUSADO em vez de virar
   master. Promover em silêncio a conta de um corretor porque alguém digitou o
   e-mail errado é o pior desfecho possível desta tela. */
const MASTER_CONVITE_HORAS = 48;
const novoToken = () => randomBytes(24).toString("hex");

r.get("/masters", (req, res) => {
  const linhas = db.prepare(`
    SELECT u.id, u.name, u.email, u.status, u.created_at, u.invite_expires,
           (SELECT o.name FROM orgs o WHERE o.id = u.org_id) AS org_nome
    FROM users u WHERE u.master = 1 ORDER BY u.created_at`).all();
  res.json({ masters: linhas.map(m => ({ ...m, eu: m.id === req.user.id })) });
});

r.post("/masters", async (req, res) => {
  const nome = String(req.body?.nome || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (nome.length < 2) return res.status(400).json({ error: "Escreva o nome da pessoa." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "E-mail inválido." });

  const jaExiste = db.prepare("SELECT id, name, master, status FROM users WHERE email = ?").get(email);
  if (jaExiste && !jaExiste.master)
    return res.status(409).json({
      error: `Esse e-mail já é de ${jaExiste.name}, que tem conta de equipe numa imobiliária. Use outro e-mail para a conta de sócio.` });
  if (jaExiste && jaExiste.master && jaExiste.status === "ativo")
    return res.status(409).json({ error: `${jaExiste.name} já é sócio e tem conta ativa.` });

  const token = novoToken();
  const expira = Date.now() + MASTER_CONVITE_HORAS * 3600000;
  /* A imobiliária do convidado é a de quem convidou. O master enxerga todas de
     qualquer jeito; o `org_id` existe porque toda conta precisa de uma casa, e
     `semMaster` já o mantém fora da lista de equipe dessa imobiliária. */
  if (jaExiste) {
    db.prepare("UPDATE users SET name=?, invite_hash=?, invite_expires=?, invite_tipo='convite', status='pendente' WHERE id=?")
      .run(nome, resumoDeConvite(token), expira, jaExiste.id);
  } else {
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master,invite_hash,invite_expires,invite_tipo)
      VALUES (?,?,?,?,'','adm',0,?,'pendente',1,?,?,'convite')`)
      .run("u_" + randomUUID(), req.user.org_id, nome, email, Date.now(), resumoDeConvite(token), expira);
  }

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  let enviado = false;
  if (mailConfigured()) {
    try {
      const { subject, html } = inviteEmail({ name: nome, link, orgName: "ConHub" });
      const out = await sendMail({ to: email, subject, html });
      enviado = !!out.sent;
    } catch (e) { console.error("[master] não consegui enviar o e-mail:", e.message); }
  }
  console.log(`[master] convite de sócio para ${email}: ${link}`);
  // O link volta SEMPRE, mesmo com e-mail configurado: é ele que o Ali manda no
  // WhatsApp enquanto o Resend não está ligado.
  res.json({ ok: true, nome, email, link, email_enviado: enviado, horas: MASTER_CONVITE_HORAS });
});

/* Tirar o crachá de sócio DESATIVA a conta junto.

   Antes só o `master` caía, e a pessoa virava gestora comum da imobiliária
   onde a conta dela nasceu — aparecendo na Equipe, com acesso total aos leads
   daquela casa. Era o contrário do que a conta de sócio é: um acesso que
   ninguém da operação enxerga. Quem deixa de ser sócio do ConHub não vira, por
   tabela, gestor de um cliente do ConHub.

   Desativar e não apagar: o histórico do que a pessoa fez enquanto era sócia
   continua de pé, e a conta pode ser reativada pela tela Equipe se um dia for
   o caso. */
r.delete("/masters/:id", (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: "Você não pode tirar o próprio acesso de sócio." });
  const alvo = db.prepare("SELECT id,name,master FROM users WHERE id = ?").get(req.params.id);
  if (!alvo || !alvo.master) return res.status(404).json({ error: "Sócio não encontrado." });
  const quantos = db.prepare("SELECT COUNT(*) n FROM users WHERE master = 1 AND status = 'ativo'").get().n;
  /* Sem esta trava dá para a plataforma ficar sem NENHUM sócio ativo — e aí
     ninguém cria imobiliária, ninguém convida sócio e ninguém volta atrás,
     porque as duas coisas exigem ser master. */
  if (quantos <= 1 && alvo.status === "ativo")
    return res.status(409).json({ error: "É o único sócio ativo. Convide outro antes de tirar este." });
  db.prepare("UPDATE users SET master = 0, status = 'removido', available = 0 WHERE id = ?").run(alvo.id);
  /* E o cracha dele morre agora. Este e o caso mais grave dos tres: o cracha
     de um master abre TODAS as imobiliarias da plataforma, e durava 30 dias.
     Tirar o acesso de socio sem derrubar a sessao era escrever "removido" no
     banco enquanto a pessoa continuava com a plataforma inteira aberta. */
  encerrarSessoes(alvo.id);
  console.log(`[master] ${req.user.name} tirou o acesso de sócio de ${alvo.name} — a conta foi desativada`);
  res.json({ ok: true, nome: alvo.name });
});

/* ===== CORRETOR AUTÔNOMO =====

   A conta de quem trabalha sozinho. Por dentro é uma org como qualquer outra —
   e é justamente por isso que ela sai barata: WhatsApp próprio, kanban, funil,
   IA, expediente, importação de leads e mensalidade já existiam.

   O que muda é o TAMANHO, e são duas regras:

   - a catraca some. Fila de distribuição com uma pessoa não é fila;
   - a equipe aceita no máximo UM atendente, que pode ser gente ou a própria IA
     do fora-do-expediente fazendo a qualificação.

   O TESTE COMEÇA QUANDO A CONTA É EFETIVADA (pedido do Ali), não aqui. Criar a
   conta e o relógio já correr antes de o corretor sequer abrir o link seria
   vender 14 dias e entregar menos — ver `set-password` em auth.routes.js.

   O corretor entra como GESTOR da própria casa: é ele quem conecta o WhatsApp,
   sobe a lista de leads, escolhe a logo e a cor. Controle total da conta, que
   é o que ele está pagando. */
const TRIAL_DIAS = 14;

r.post("/autonomos", async (req, res) => {
  const nome = String(req.body?.nome || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const marca = String(req.body?.marca || "").trim().slice(0, 80) || nome;
  /* O preço é combinado na venda e gravado AQUI, na criação. Sem isso o
     corretor abre a tela de assinatura e não tem o que ativar — e você
     precisaria voltar em cada conta para digitar o valor depois. */
  const valor = Number(req.body?.valor) || null;
  if (nome.length < 2) return res.status(400).json({ error: "Escreva o nome do corretor." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "E-mail inválido." });

  const jaExiste = db.prepare("SELECT id,name,status FROM users WHERE email = ?").get(email);
  if (jaExiste && jaExiste.status === "ativo")
    return res.status(409).json({ error: `Esse e-mail já é de ${jaExiste.name}, que tem conta ativa na plataforma.` });

  const token = novoToken();
  const expira = Date.now() + 7 * 86400000;
  const orgId = "org_" + randomUUID().slice(0, 8);
  const userId = jaExiste ? jaExiste.id : "u_" + randomUUID();

  const criar = db.transaction(() => {
    db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at,tipo)
      VALUES (?,?,?,'',0,0,?,'autonomo')`).run(orgId, marca, codigoLivre(marca), Date.now());
    if (valor) db.prepare("UPDATE orgs SET valor_mensal = ? WHERE id = ?").run(valor, orgId);
    /* `corretor`, e não `adm` — mesma decisão de `publico.routes.js`: é o papel
       que faz a catraca entregar lead a ele e o nome dele aparecer no score e
       no relatório de produtividade. O acesso de gestor vem de ser o DONO,
       resolvido em `auth.js` → `roles`/`ehDonoAutonomo`. */
    if (jaExiste) {
      db.prepare(`UPDATE users SET org_id=?, name=?, role='corretor', available=1, status='pendente',
        invite_hash=?, invite_expires=?, invite_tipo='fundador' WHERE id=?`)
        .run(orgId, nome, resumoDeConvite(token), expira, userId);
    } else {
      db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,invite_hash,invite_expires,invite_tipo)
        VALUES (?,?,?,?,'','corretor',1,?,'pendente',?,?,'fundador')`)
        .run(userId, orgId, nome, email, Date.now(), resumoDeConvite(token), expira);
    }
    // Dono da conta: é quem responde pela mensalidade e vê a cobrança.
    db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(userId, orgId);
  });
  criar();

  const link = `${siteUrl(req)}/definir-senha?token=${token}`;
  let enviado = false;
  if (mailConfigured()) {
    try {
      const { subject, html } = inviteEmail({ name: nome, link, orgName: marca });
      enviado = !!(await sendMail({ to: email, subject, html })).sent;
    } catch (e) { console.error("[autonomo] e-mail não saiu:", e.message); }
  }
  console.log(`[autonomo] conta de ${nome} criada — link: ${link}`);
  res.json({ ok: true, nome, email, link, email_enviado: enviado, dias: TRIAL_DIAS,
    org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId)) });
});

/* Liberar ou travar na mão, sem esperar vencimento.

   É o "pagou libera, não pagou trava" do Ali, com um botão. Não mexe no
   histórico de pagamentos nem na cobrança do Asaas.

   LIBERAR PELO TEMPO QUE O MASTER QUISER (27/09/2026): `dias` (1 a 3650) ou
   `ate` (data AAAA-MM-DD, vale até o fim daquele dia). Grava `liberado_ate` —
   que segura a conta aberta em qualquer situação, inclusive quando já houve
   pagamento ou falta o cartão, casos em que empurrar o teste não fazia nada
   (ver `situacao()`) — e continua empurrando `trial_ate` junto, para a conta
   em teste mostrar os dias certos e a primeira cobrança não vir antes da data
   liberada.

   TRAVAR puxa o teste para ontem e desfaz a liberação. */
const MAX_DIAS_LIBERADOS = 3650;
r.post("/autonomos/:id/liberar", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ? AND tipo = 'autonomo'").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Conta não encontrada." });
  const dias = Number(req.body?.dias);
  const dataTexto = String(req.body?.ate || "").trim();

  if (!dataTexto && Number.isFinite(dias) && dias < 0) {
    db.prepare("UPDATE orgs SET trial_ate = ?, liberado_ate = NULL WHERE id = ?").run(Date.now() - 86400000, org.id);
    console.log(`[autonomo] ${req.user.name} travou ${org.name}`);
    return res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
  }

  let ate;
  if (dataTexto) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataTexto)) return res.status(400).json({ error: "Data inválida." });
    // Fim do dia no horário local: "liberado até 10/10" vale o dia 10 inteiro.
    ate = new Date(`${dataTexto}T23:59:59`).getTime();
    if (!Number.isFinite(ate)) return res.status(400).json({ error: "Data inválida." });
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    if (ate < hoje.getTime()) return res.status(400).json({ error: "Escolha uma data de hoje em diante." });
  } else {
    const n = Number.isFinite(dias) ? Math.round(dias) : TRIAL_DIAS;
    if (n < 1 || n > MAX_DIAS_LIBERADOS)
      return res.status(400).json({ error: `Escolha de 1 a ${MAX_DIAS_LIBERADOS} dias.` });
    ate = Date.now() + n * 86400000;
  }
  if (ate > Date.now() + MAX_DIAS_LIBERADOS * 86400000)
    return res.status(400).json({ error: "Data longe demais — o máximo é 10 anos." });

  db.prepare("UPDATE orgs SET trial_ate = ?, liberado_ate = ? WHERE id = ?").run(ate, ate, org.id);
  console.log(`[autonomo] ${req.user.name} liberou ${org.name} até ${new Date(ate).toLocaleDateString("pt-BR")}`);
  res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
});

/* LIBERAR O MARKETING (disparo em massa) PARA UMA CONTA — 27/09/2026.

   Desligado por padrão, para toda conta. É o primeiro degrau da proteção do
   ConHub: o recurso só existe para quem o master decidiu liberar, e a data e
   quem liberou ficam gravadas. Desligar esconde a seção e trava as rotas, mas
   NÃO apaga nada — termo aceito, listas, declarações e bloqueios continuam
   guardados, porque são a prestação de contas. */
r.post("/:id/marketing", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Conta não encontrada." });
  if (typeof req.body?.liberado !== "boolean") return res.status(400).json({ error: "Diga se o marketing fica liberado ou não." });
  definirLiberacao(org.id, req.body.liberado, req.user.id);
  console.log(`[master] ${req.user.name} ${req.body.liberado ? "liberou" : "desligou"} o marketing de ${org.name}`);
  res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
});

/* LIBERAR OU RETIRAR UMA FERRAMENTA (29/09/2026, pedido do Ali: "assim como a
   função marketing eu também possa liberar se eu quiser a função
   autoatendimento e retirar também da conta de qualquer cliente").

   `estado`: "liberado" (vale mesmo fora do plano), "retirado" (some mesmo
   estando no plano ou contratada avulsa) ou null (volta a seguir o plano).
   Retirar NÃO cancela cobrança avulsa no Asaas: isso é do cliente, na tela
   dele — a resposta devolve a situação, e o hub avisa quando há avulso pago. */
r.post("/:id/recursos/:recurso", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Conta não encontrada." });
  if (!ehRecurso(req.params.recurso)) return res.status(404).json({ error: "Ferramenta desconhecida." });
  const estado = req.body?.estado ?? null;
  if (estado !== null && estado !== "liberado" && estado !== "retirado")
    return res.status(400).json({ error: "Escolha liberar, retirar ou seguir o plano." });
  definirPeloMaster(org.id, req.params.recurso, estado, req.user.id);
  console.log(`[master] ${req.user.name} → ${RECURSOS[req.params.recurso].nome} de ${org.name}: ${estado || "segue o plano"}`);
  res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
});

/* POR QUAL PROVEDOR ESTA CONTA É COBRADA (04/10/2026) — Asaas ou Pagar.me.

   É a troca conta por conta que permite ligar o Pagar.me primeiro numa conta
   de teste, e depois cliente por cliente, sem mexer em quem já paga. Trocar
   NÃO cancela nada no provedor antigo: a cobrança de lá só sai quando o
   cliente contratar o plano no novo (aí a assinatura antiga é cancelada
   junto). `null` devolve a conta à regra padrão. */
r.post("/:id/cobranca", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Conta não encontrada." });
  const provedor = req.body?.provedor ?? null;
  if (provedor !== null && !PROVEDORES.includes(provedor))
    return res.status(400).json({ error: "Escolha Asaas ou Pagar.me." });
  if (provedor === "pagarme" && !pagarmeConfigurado())
    return res.status(409).json({ error: "O Pagar.me não está configurado no servidor (PAGARME_SECRET_KEY e PAGARME_PUBLIC_KEY)." });
  db.prepare("UPDATE orgs SET cobranca = ? WHERE id = ?").run(provedor, org.id);
  console.log(`[master] ${req.user.name} → cobrança de ${org.name}: ${provedor || "regra padrão"}`);
  res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
});

/* MIGRAR O TIPO DA CONTA — imobiliária ⇄ autônomo (22/09/2026, pedido do Ali:
   um cliente se cadastrou como imobiliária, mas é corretor autônomo).

   `tipo` não é um rótulo solto: ele decide o PAPEL de quem manda na casa
   (dono vira corretor ou gestor — ver `ehDonoAutonomo`, auth.js), o que
   aparece no menu (catraca e plantão somem no autônomo), as travas da porta
   de cadastro (autônomo não aceita corretor novo, só um atendente) e o
   padrão do robô fora do expediente. Virar só a coluna sem acertar o resto
   deixaria a conta num estado que não é nem um nem outro — por isso a
   conversão é UMA função que mexe nas duas pontas juntas, não um PATCH solto.

   IMOBILIÁRIA → AUTÔNOMO exige escolher QUEM é o corretor titular
   (`dono_user_id`, obrigatório — o master decide, não tem como adivinhar) e
   trava se a equipe for grande demais para caber no plano: mesma régua da
   porta de cadastro (`auth.routes.js`) — nenhum outro gestor, nenhum outro
   corretor, no máximo um atendente. Sem essa conferência a conta converteria
   com gente sobrando, e "o" corretor autônomo ficaria ambíguo.

   AUTÔNOMO → IMOBILIÁRIA devolve o dono ao papel de gestor (`adm`) — sem
   isso ele ficaria preso no único papel que o autônomo usa (`corretor`),
   numa casa que agora tem catraca e espera um `adm` de verdade em dezenas
   de rotas.

   Mensalidade (`valor_mensal`/`plano_id`/`trial_ate`) NÃO é tocada — é
   correção de categoria, não venda nova; o que já foi combinado com o
   cliente continua valendo, e o master ajusta preço à parte se precisar.

   `encerrarSessoes` no dono: ele estava numa tela pensada para o papel
   ANTIGO (menu, botões, rotas). Deixar o crachá de 30 dias valendo faria a
   tela dele ficar num estado misto até o próximo login sozinho — mesma
   régua já usada para quem perde acesso de sócio. */
r.post("/:id/tipo", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Imobiliária não encontrada." });
  const tipoAtual = org.tipo || "imobiliaria";
  const pedido = req.body?.tipo;
  const tipoNovo = pedido === "autonomo" ? "autonomo" : pedido === "imobiliaria" ? "imobiliaria" : null;
  if (!tipoNovo) return res.status(400).json({ error: "Escolha 'autonomo' ou 'imobiliaria'." });
  if (tipoNovo === tipoAtual)
    return res.status(409).json({ error: `Esta conta já é ${tipoNovo === "autonomo" ? "autônoma" : "imobiliária"}.` });

  if (tipoNovo === "autonomo") {
    const donoId = String(req.body?.dono_user_id || "").trim();
    if (!donoId) return res.status(400).json({ error: "Escolha qual pessoa da equipe é o corretor titular." });
    const alvo = db.prepare("SELECT id,name,role,status FROM users WHERE id = ? AND org_id = ?").get(donoId, org.id);
    if (!alvo || alvo.status !== "ativo")
      return res.status(400).json({ error: "Escolha uma pessoa ativa desta conta para ser o corretor titular." });

    // Mesma régua da porta de cadastro (auth.routes.js): sem ela a conta
    // converteria com gente sobrando, e "o" corretor autônomo seria ambíguo.
    const outros = db.prepare(`SELECT role, COUNT(*) n FROM users
      WHERE org_id = ? AND id <> ? AND status IN ('ativo','pendente','aguardando_aprovacao') AND COALESCE(master,0) = 0
      GROUP BY role`).all(org.id, alvo.id);
    const conta = (papel) => outros.find(o => o.role === papel)?.n || 0;
    const outrosAdm = conta("adm"), outrosCorretor = conta("corretor"), atendentes = conta("sdr");
    const problemas = [];
    if (outrosAdm) problemas.push(`${outrosAdm} outro(s) gestor(es)`);
    if (outrosCorretor) problemas.push(`${outrosCorretor} outro(s) corretor(es)`);
    if (atendentes > 1) problemas.push(`${atendentes} atendentes (o plano de autônomo aceita só 1)`);
    if (problemas.length)
      return res.status(409).json({ error:
        `Esta equipe é grande demais para virar conta autônoma: ${problemas.join(", ")}. Remova ou transfira essas pessoas antes de converter.` });

    db.transaction(() => {
      db.prepare("UPDATE orgs SET tipo = 'autonomo', dono_user_id = ? WHERE id = ?").run(alvo.id, org.id);
      db.prepare("UPDATE users SET role = 'corretor', available = 1 WHERE id = ?").run(alvo.id);
    })();
    encerrarSessoes(alvo.id);
    console.log(`[master] ${req.user.name} converteu "${org.name}" para conta autônoma — titular: ${alvo.name}`);
    return res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
  }

  // AUTÔNOMO → IMOBILIÁRIA: o dono volta a ser gestor da própria casa.
  const dono = org.dono_user_id ? db.prepare("SELECT id,name,role FROM users WHERE id = ?").get(org.dono_user_id) : null;
  db.transaction(() => {
    db.prepare("UPDATE orgs SET tipo = 'imobiliaria' WHERE id = ?").run(org.id);
    if (dono && dono.role === "corretor") db.prepare("UPDATE users SET role = 'adm' WHERE id = ?").run(dono.id);
  })();
  if (dono) encerrarSessoes(dono.id);
  console.log(`[master] ${req.user.name} converteu "${org.name}" para imobiliária` + (dono ? ` — ${dono.name} voltou a gestor` : ""));
  res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
});

/* ===== A FOTO DA TELA DE ENTRADA =====

   Uma imagem só, igual para todo mundo que abre o sistema — inclusive para
   quem ainda não tem conta. Por isso ela não mora em `orgs`: não é de
   imobiliária nenhuma.

   Sobe pela tela porque quem troca é o dono da plataforma, não a hospedagem.
   Colocar o arquivo dentro do projeto exigiria mexer no GitHub a cada troca, e
   ele se perderia no próximo deploy: o disco do container é descartável. Aqui
   ela vai para o mesmo armazenamento das fotos dos imóveis, que é persistente,
   e o endereço fica guardado no banco.

   O caminho público continua sendo `/login-fundo.jpg` (ver server.js): a tela
   de login não tem sessão e não pode consultar nada antes de desenhar. */
const CHAVE_FUNDO = "login_fundo";
const lerConfig = (chave) => {
  const l = db.prepare("SELECT valor FROM config_plataforma WHERE chave = ?").get(chave);
  try { return l ? JSON.parse(l.valor) : null; } catch (e) { return null; }
};
const gravarConfig = (chave, valor) =>
  db.prepare(`INSERT INTO config_plataforma (chave,valor,atualizado_em) VALUES (?,?,?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, atualizado_em=excluded.atualizado_em`)
    .run(chave, valor ? JSON.stringify(valor) : null, Date.now());

/* DOMÍNIOS DOS SITES (04/10/2026). A imobiliária cadastra o domínio no site
   dela; quem ATIVA na hospedagem é o ConHub (é a hospedagem que emite o
   certificado do https). Aqui o master vê quem está esperando, ativa o domínio
   no painel da hospedagem e anota o destino de DNS que ela deu — é esse
   destino que a imobiliária passa a ver na tela dela para apontar o DNS. */
const listaDeDominios = () => ({ dominios: dominiosDaPlataforma(), automatico: railwayPronto().ok, falta: railwayPronto().falta });
r.get("/dominios", (_req, res) => res.json(listaDeDominios()));
r.patch("/dominios/:orgId", async (req, res) => {
  const x = definirDestino(req.params.orgId, (req.body || {}).destino);
  if (x.erro) return res.status(400).json({ error: x.erro });
  try { await verificarDominio(req.params.orgId); } catch (e) { console.warn("[site] conferência:", e.message); }
  res.json(listaDeDominios());
});

r.get("/login-fundo", (req, res) => res.json({ fundo: lerConfig(CHAVE_FUNDO) }));

r.post("/login-fundo", async (req, res) => {
  const { mime, base64 } = req.body || {};
  if (!mime || !base64) return res.status(400).json({ error: "Escolha uma imagem." });
  if (ehVideo(mime) || !tipoPermitido(mime))
    return res.status(400).json({ error: "Use uma imagem JPG, PNG ou WEBP." });

  const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  /* 6 MB porque é uma foto de fundo em tela cheia e comprimir demais aparece —
     mas ela é baixada por TODO MUNDO que abre o login, inclusive no 4G do
     corretor, então também não pode ser um arquivo de câmera sem tratamento. */
  if (buffer.length > 6 * 1024 * 1024)
    return res.status(413).json({ error: "Imagem muito grande. O limite é 6 MB." });

  const anterior = lerConfig(CHAVE_FUNDO);
  try {
    const { url, chave } = await salvar({ buffer, mime, prefixo: "plataforma/login" });
    gravarConfig(CHAVE_FUNDO, { url, chave, em: Date.now() });
    if (anterior && anterior.chave) apagarArquivo(anterior.chave);
    console.log(`[login] ${req.user.name} trocou a foto da tela de entrada`);
    res.json({ ok: true, fundo: lerConfig(CHAVE_FUNDO) });
  } catch (e) {
    console.error("[login] falha ao guardar a foto:", e.message);
    res.status(500).json({ error: "Não consegui guardar a imagem. Tente de novo." });
  }
});

r.delete("/login-fundo", (req, res) => {
  const atual = lerConfig(CHAVE_FUNDO);
  if (atual && atual.chave) apagarArquivo(atual.chave);
  gravarConfig(CHAVE_FUNDO, null);
  res.json({ ok: true, fundo: null });
});

/* O endereço público da foto, para o `server.js` responder sem exigir login. */
export const fundoDoLogin = () => lerConfig(CHAVE_FUNDO);

/* Cadastra uma imobiliária nova.

   Cria só a casa e a chave (nome + código). Quem entra depois é a equipe dela,
   pelo link de cadastro — e o próprio master aprova o primeiro gestor de
   dentro. Sem isso haveria um impasse: gestor precisa de aprovação, e não há
   ninguém para aprovar numa imobiliária recém-criada. */
r.post("/", (req, res) => {
  const nome = String(req.body?.nome || "").trim();
  if (nome.length < 2) return res.status(400).json({ error: "Informe o nome da imobiliária." });

  const codigo = arrumarCodigo(req.body?.codigo) || codigoSugerido(nome);
  if (codigo.length < 4) return res.status(400).json({ error: "O código precisa ter ao menos 4 caracteres." });
  if (db.prepare("SELECT 1 FROM orgs WHERE adm_code = ?").get(codigo))
    return res.status(409).json({ error: `O código ${codigo} já está em uso por outra imobiliária.` });

  const id = "org_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at)
              VALUES (?,?,?,'',0,0,?)`).run(id, nome, codigo, Date.now());
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(id);
  res.json({ ok: true, org: resumo(req, org) });
});

// Renomear ou trocar o código. Trocar o código invalida os links já enviados.
r.patch("/:id", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Imobiliária não encontrada." });

  const nome = req.body?.nome != null ? String(req.body.nome).trim() : org.name;
  if (nome.length < 2) return res.status(400).json({ error: "Informe o nome da imobiliária." });

  let codigo = org.adm_code;
  if (req.body?.codigo != null) {
    codigo = arrumarCodigo(req.body.codigo);
    if (codigo.length < 4) return res.status(400).json({ error: "O código precisa ter ao menos 4 caracteres." });
    const outro = db.prepare("SELECT id FROM orgs WHERE adm_code = ? AND id <> ?").get(codigo, org.id);
    if (outro) return res.status(409).json({ error: `O código ${codigo} já está em uso por outra imobiliária.` });
  }

  db.prepare("UPDATE orgs SET name = ?, adm_code = ? WHERE id = ?").run(nome, codigo, org.id);
  res.json({ ok: true, org: resumo(req, db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id)) });
});

/* Apagar uma imobiliária. Exige o nome digitado por extenso.

   É a única ação do sistema que destrói dados de uma operação inteira, e sem
   volta. A confirmação por digitação existe porque um clique errado no lugar
   errado apagaria a base de um cliente pagante. */
r.get("/:id/apagar", (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Imobiliária não encontrada." });
  const n = (sql) => db.prepare(sql).get(org.id)?.n ?? 0;
  res.json({
    nome: org.name,
    unica: db.prepare("SELECT COUNT(*) n FROM orgs").get().n <= 1,
    /* O que exatamente vai sumir. A tela mostra estes números ANTES de pedir a
       confirmação: "apagar tudo" é abstrato, "apagar 127 leads e 2.753
       mensagens" é uma decisão. */
    equipe: n(`SELECT COUNT(*) n FROM users u WHERE u.org_id = ?${semMaster("u")}`),
    leads: n("SELECT COUNT(*) n FROM leads WHERE org_id = ?"),
    mensagens: n("SELECT COUNT(*) n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.org_id = ?"),
    imoveis: n("SELECT COUNT(*) n FROM produtos WHERE org_id = ?"),
    pagamentos: n("SELECT COUNT(*) n FROM pagamentos WHERE org_id = ?"),
    tipo: org.tipo || "imobiliaria",
    // Tem cobrança recorrente no Asaas? A exclusão tenta cancelar — a tela avisa antes.
    asaas: !!org.asaas_subscription_id,
  });
});

r.delete("/:id", async (req, res) => {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "Imobiliária não encontrada." });
  if (String(req.body?.confirmar || "").trim() !== org.name)
    return res.status(400).json({ error: `Para apagar, digite o nome exato: ${org.name}` });
  if (db.prepare("SELECT COUNT(*) n FROM orgs").get().n <= 1)
    return res.status(409).json({ error: "Esta é a única imobiliária cadastrada." });

  /* As fotos e vídeos ficam fora do banco (R2 ou disco), então saem por fora —
     e ANTES, porque depois de apagar as linhas ninguém mais sabe quais arquivos
     eram desta imobiliária. Falha aqui não impede a exclusão: arquivo órfão se
     limpa depois, cliente que pediu para sair não pode ficar preso. */
  const arquivos = db.prepare(`SELECT m.chave FROM produto_midias m
    JOIN produtos p ON p.id = m.produto_id WHERE p.org_id = ? AND m.chave IS NOT NULL`).all(org.id);
  let arquivosApagados = 0;
  for (const { chave } of arquivos) {
    try { await apagarArquivo(chave); arquivosApagados++; }
    catch (e) { console.warn(`[orgs] não consegui apagar o arquivo ${chave}: ${e.message}`); }
  }

  const contagem = {
    equipe: db.prepare(`SELECT COUNT(*) n FROM users u WHERE u.org_id = ?${semMaster("u")}`).get(org.id).n,
    leads: db.prepare("SELECT COUNT(*) n FROM leads WHERE org_id = ?").get(org.id).n,
    arquivos: arquivosApagados,
  };

  /* A cobrança no Asaas é cancelada ANTES de apagar: depois disso ninguém mais
     sabe qual assinatura era desta conta, e o cliente que saiu continuaria
     sendo cobrado todo mês. Falha aqui não impede a exclusão — vira aviso na
     tela, para o master cancelar no painel do Asaas. */
  let asaasAviso = null;
  if (org.asaas_subscription_id) {
    try {
      // Teto de 15s: Asaas fora do ar não pode deixar o botão pendurado.
      await Promise.race([cancelarAssinatura(org.asaas_subscription_id),
        new Promise((_, nao) => setTimeout(() => nao(new Error("o Asaas não respondeu")), 15000))]);
    }
    catch (e) {
      console.warn(`[orgs] não consegui cancelar a assinatura ${org.asaas_subscription_id} no Asaas: ${e.message}`);
      asaasAviso = "Não consegui cancelar a assinatura no Asaas — cancele por lá para o cliente não continuar sendo cobrado.";
    }
  } else if (org.asaas_customer_id && org.plano_id) {
    // O plano anual é parcelado (/payments), não assinatura: não há o que cancelar por aqui.
    asaasAviso = "Esta conta tem cobrança no Asaas sem assinatura recorrente (plano parcelado). Confira no painel do Asaas se sobrou alguma parcela.";
  }
  /* As ferramentas contratadas avulsas têm assinatura PRÓPRIA no Asaas — sem
     cancelá-las, o cliente que saiu continuaria pagando a IA todo mês. */
  for (const l of db.prepare(`SELECT recurso, avulso_sub_id FROM org_recursos
      WHERE org_id = ? AND avulso_sub_id IS NOT NULL AND avulso_status IN ('aguardando','ativo')`).all(org.id)) {
    try {
      await Promise.race([cancelarAssinatura(l.avulso_sub_id),
        new Promise((_, nao) => setTimeout(() => nao(new Error("o Asaas não respondeu")), 15000))]);
    } catch (e) {
      console.warn(`[orgs] não consegui cancelar a ferramenta ${l.recurso} (${l.avulso_sub_id}) no Asaas: ${e.message}`);
      asaasAviso = [asaasAviso, `Não consegui cancelar a ferramenta ${RECURSOS[l.recurso]?.nome || l.recurso} no Asaas — cancele por lá.`].filter(Boolean).join(" ");
    }
  }

  /* E no Pagar.me (04/10/2026): a mensalidade e as ferramentas avulsas de lá
     também são canceladas antes de a conta sumir. */
  const falhasPagarme = await cancelarTudoNoPagarme(org);
  if (falhasPagarme.length)
    asaasAviso = [asaasAviso, `Não consegui cancelar ${falhasPagarme.length} cobrança(s) no Pagar.me — cancele pelo painel da Stone.`].filter(Boolean).join(" ");

  // O domínio próprio do site sai também do Railway — senão ficaria
  // cadastrado lá, servindo uma conta que não existe mais.
  const site = db.prepare("SELECT dominio_railway_id FROM sites WHERE org_id = ?").get(org.id);
  if (site && site.dominio_railway_id) await removerDominio(site.dominio_railway_id);

  const apagar = db.transaction(() => {
    const leads = db.prepare("SELECT id FROM leads WHERE org_id = ?").all(org.id).map(l => l.id);
    /* Todas as tabelas da conta, descobertas pelo próprio banco, e não uma
       lista escrita à mão. A lista antiga parou no tempo: canais, tags,
       funis, tarefas, observações, site, portais… ficavam para trás a cada
       tabela nova — e a linha de WhatsApp de uma conta apagada continuava
       podendo receber mensagem. `users` e `orgs` ficam de fora: saem abaixo,
       com a trava do master. */
    const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    const colunas = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    for (const t of tabelas) {
      if (t === "users" || t === "orgs" || t === "leads") continue;
      const cols = colunas(t);
      if (cols.includes("lead_id") && !cols.includes("org_id"))
        for (const id of leads) db.prepare(`DELETE FROM "${t}" WHERE lead_id = ?`).run(id);
    }
    const prods = db.prepare("SELECT id FROM produtos WHERE org_id = ?").all(org.id);
    for (const { id } of prods) db.prepare("DELETE FROM produto_midias WHERE produto_id = ?").run(id);
    for (const t of tabelas) {
      if (t === "users" || t === "orgs") continue;
      if (colunas(t).includes("org_id")) db.prepare(`DELETE FROM "${t}" WHERE org_id = ?`).run(org.id);
    }
    // O master pertence à primeira org e não pode ser removido junto com um cliente.
    db.prepare(`DELETE FROM push_subs WHERE user_id IN
      (SELECT u.id FROM users u WHERE u.org_id = ?${semMaster("u")})`).run(org.id);
    db.prepare(`DELETE FROM users WHERE id IN
      (SELECT u.id FROM users u WHERE u.org_id = ?${semMaster("u")})`).run(org.id);
    db.prepare("DELETE FROM orgs WHERE id = ?").run(org.id);
  });
  apagar();
  console.log(`[orgs] imobiliária APAGADA: ${org.name} (${contagem.leads} leads, ${contagem.equipe} pessoas, ${contagem.arquivos} arquivos)`);
  res.json({ ok: true, apagada: org.name, ...contagem, asaas_aviso: asaasAviso });
});

/* ===== CÓPIA DE SEGURANÇA DO BANCO =====

   Mora aqui porque é da PLATAFORMA, não de uma imobiliária: o arquivo é um só
   e guarda todo mundo dentro. Este roteador já exige master no topo
   (`r.use(authRequired, soMaster)`), que é a permissão certa — a cópia carrega
   os leads de todos os clientes.

   O botão de rodar agora existe para o dia em que você vai mexer em algo
   grande: importar planilha, apagar imobiliária, publicar mudança de banco.
   Cópia de ontem serve para desastre; para susto, a de cinco minutos atrás. */
r.get("/backup", async (_req, res) => {
  res.json(await situacaoDoBackup());
});

r.post("/backup", async (_req, res) => {
  const r1 = await rodarBackup({ motivo: "manual" });
  if (!r1.ok) return res.status(502).json({ error: r1.erro });
  res.json({ ...r1, ...(await situacaoDoBackup()) });
});

export default r;
