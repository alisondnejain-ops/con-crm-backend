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
import { authRequired, soMaster, sign, semMaster } from "../auth.js";
import { situacao } from "../services/assinatura.js";
import { apagar as apagarArquivo, salvar, tipoPermitido, ehVideo } from "../services/storage.js";
import { marcaDaOrg } from "../services/marca.js";
import { sendMail, mailConfigured, inviteEmail } from "../services/mail.js";

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
    assinatura: { status: s.status, cobranca: !!s.cobranca, vence_em: s.vence_em || null, valor: s.valor ?? null },
    criada_em: org.created_at || null,
  };
}

// As imobiliárias que existem. É a tela que abre quando o master entra.
r.get("/", (req, res) => {
  const orgs = db.prepare("SELECT * FROM orgs ORDER BY name").all();
  res.json({ orgs: orgs.map(o => resumo(req, o)), atual: req.user.org_id });
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
    db.prepare("UPDATE users SET name=?, invite_token=?, invite_expires=?, invite_tipo='convite', status='pendente' WHERE id=?")
      .run(nome, token, expira, jaExiste.id);
  } else {
    db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master,invite_token,invite_expires,invite_tipo)
      VALUES (?,?,?,?,'','adm',0,?,'pendente',1,?,?,'convite')`)
      .run("u_" + randomUUID(), req.user.org_id, nome, email, Date.now(), token, expira);
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
  console.log(`[master] ${req.user.name} tirou o acesso de sócio de ${alvo.name} — a conta foi desativada`);
  res.json({ ok: true, nome: alvo.name });
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

  const apagar = db.transaction(() => {
    const leads = db.prepare("SELECT id FROM leads WHERE org_id = ?").all(org.id);
    for (const { id } of leads) {
      db.prepare("DELETE FROM messages WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM ligacoes WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM simulacoes WHERE lead_id = ?").run(id);
    }
    db.prepare("DELETE FROM leads WHERE org_id = ?").run(org.id);
    db.prepare("DELETE FROM importacoes WHERE org_id = ?").run(org.id);
    db.prepare("DELETE FROM pagamentos WHERE org_id = ?").run(org.id);
    /* Tabelas que nasceram depois desta rota e ficavam para trás: a escala de
       plantão, o histórico de disponibilidade e os textos prontos da conversa.
       Não davam erro — só deixavam o dado de um cliente que pediu para sair
       morando no banco. */
    db.prepare("DELETE FROM plantoes WHERE org_id = ?").run(org.id);
    db.prepare("DELETE FROM disponibilidade_log WHERE org_id = ?").run(org.id);
    db.prepare("DELETE FROM mensagens_rapidas WHERE org_id = ?").run(org.id);
    const prods = db.prepare("SELECT id FROM produtos WHERE org_id = ?").all(org.id);
    for (const { id } of prods) db.prepare("DELETE FROM produto_midias WHERE produto_id = ?").run(id);
    db.prepare("DELETE FROM produtos WHERE org_id = ?").run(org.id);
    // O master pertence à primeira org e não pode ser removido junto com um cliente.
    db.prepare(`DELETE FROM push_subs WHERE user_id IN
      (SELECT u.id FROM users u WHERE u.org_id = ?${semMaster("u")})`).run(org.id);
    db.prepare(`DELETE FROM users WHERE id IN
      (SELECT u.id FROM users u WHERE u.org_id = ?${semMaster("u")})`).run(org.id);
    db.prepare("DELETE FROM orgs WHERE id = ?").run(org.id);
  });
  apagar();
  console.log(`[orgs] imobiliária APAGADA: ${org.name} (${contagem.leads} leads, ${contagem.equipe} pessoas, ${contagem.arquivos} arquivos)`);
  res.json({ ok: true, apagada: org.name, ...contagem });
});

export default r;
