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
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, soMaster, sign, semMaster } from "../auth.js";
import { situacao } from "../services/assinatura.js";
import { apagar as apagarArquivo } from "../services/storage.js";

const r = Router();
r.use(authRequired, soMaster);

const linkCadastro = (req, code) => {
  const base = (process.env.SITE_URL || process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}/cadastro?c=${code}`;
};

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
