/* AS LINHAS DE WHATSAPP: quem liga a sua, quem vê as dos outros.

   A tela de conexão existia só para o gestor, e conectava a linha da CASA. O
   corretor agora tem a dele — e é ele quem a liga, porque o número é dele:
   ninguém pode parear o WhatsApp pessoal de outra pessoa.

   O que o gestor mantém é o CONTROLE DO CUSTO. Cada linha ligada é cobrada à
   parte, então o corretor não liga a dele sozinho: o gestor libera. Sem isso, a
   fatura da imobiliária cresceria por decisão de quem não paga a conta — e o
   gestor descobriria no extrato do mês seguinte. */

import { Router } from "express";
import db from "../db.js";
import { authRequired, roles, supervisiona } from "../auth.js";
import {
  canaisDaOrg, garantirCasa, canalDoUsuario, canalPorId,
  criarCanalDoCorretor, salvarConexao, salvarConexaoOficial, desligarCanal, limites,
} from "../services/canais.js";
import { instanceStatus, PROVEDORES } from "../services/uazapi.js";

const r = Router();
r.use(authRequired);

/* O que a tela precisa saber, do jeito que ela pergunta.

   Um endereço só para os dois papéis, e não dois: a linha do corretor e a
   lista do gestor são a mesma informação vista de alturas diferentes, e duas
   rotas divergiriam na primeira mudança. */
r.get("/", async (req, res) => {
  const orgId = req.user.org_id;
  const meu = canalDoUsuario(orgId, req.user.id);
  const casa = garantirCasa(orgId);
  const l = limites(orgId);

  const eu = db.prepare("SELECT canal_liberado FROM users WHERE id = ?").get(req.user.id) || {};
  const base = {
    limites: l,
    provedores: PROVEDORES,
    casa_conectada: !!(casa && casa.token),
    /* O corretor não escolhe provedor: ele segue o da CASA. Numa linha
       oficial, `/canais/meu/oficial` já recusa se a casa não estiver na
       Meta — mas a tela precisa saber ANTES de mostrar o formulário
       errado, senão o corretor preenche host+token da Uazapi numa conta
       que só aceita Phone Number ID, e só descobre no erro do envio. */
    casa_provider: casa?.provider || "uazapi",
    /* O corretor só pede a linha dele se o gestor tiver liberado. `liberado`
       é uma coluna do USUÁRIO e não uma conta feita aqui: é uma autorização
       nominal, e autorização que se deduz de um número é autorização que muda
       sozinha quando o número muda. */
    liberado: !!eu.canal_liberado,
    meu: meu ? enxuto(meu) : null,
  };

  if (!supervisiona(req.user)) return res.json(base);
  res.json({
    ...base,
    equipe: canaisDaOrg(orgId).map(enxuto),
    // Quem ainda pode ganhar uma linha — a lista que o gestor usa para liberar.
    podem: db.prepare(`SELECT u.id, u.name, u.role, u.canal_liberado FROM users u
      WHERE u.org_id = ? AND u.status = 'ativo' AND u.role IN ('corretor','sdr')
        AND u.id NOT IN (SELECT COALESCE(user_id,'') FROM canais WHERE org_id = ? AND ativo = 1)
      ORDER BY u.name`).all(orgId, orgId),
  });
});

/* O token NUNCA sai daqui. Ele é a credencial de envio da linha: quem o tiver
   manda mensagem pelo WhatsApp daquela pessoa, de fora do CRM. A tela precisa
   saber se está conectado, não com o quê. */
const enxuto = (c) => ({
  id: c.id, tipo: c.tipo, user_id: c.user_id, nome: c.nome, pessoa: c.pessoa || null,
  conectado: !!c.token, host: c.host || null, wa_number: c.wa_number || null,
  robo_ligado: !!c.robo_ligado, ativo: !!c.ativo, conectado_em: c.conectado_em || null,
});

// O estado da linha na Uazapi — pareada, esperando QR, caída.
r.get("/:id/status", async (req, res) => {
  const c = canalPorId(req.params.id);
  if (!c || c.org_id !== req.user.org_id) return res.status(404).json({ error: "Linha não encontrada." });
  if (!supervisiona(req.user) && c.user_id !== req.user.id)
    return res.status(403).json({ error: "Essa linha não é sua." });
  res.json({ ...enxuto(c), whatsapp: await instanceStatus(req.user.org_id, c.id) });
});

/* O gestor libera (ou tira) a permissão de alguém ligar o número pessoal.

   Fica no usuário, não numa contagem: "os 5 primeiros que pedirem" faria a
   autorização depender de quem clicou primeiro. O gestor escolhe os nomes. */
r.post("/liberar", roles("adm"), (req, res) => {
  const { user_id, liberado } = req.body || {};
  const u = db.prepare("SELECT id,name,status FROM users WHERE id = ? AND org_id = ?").get(user_id, req.user.org_id);
  if (!u) return res.status(404).json({ error: "Pessoa não encontrada nesta imobiliária." });
  if (u.status !== "ativo") return res.status(400).json({ error: "Essa conta não está ativa." });

  const ligar = liberado !== false;
  if (ligar) {
    /* O TETO É CONFERIDO NA LIBERAÇÃO, e é aqui que ele precisa doer.

       Liberar dez pessoas num plano de cinco linhas não daria erro nenhum na
       hora: o estouro só apareceria quando a sexta fosse conectar, com o
       corretor já com o token na mão e o gestor achando que tinha autorizado.
       A recusa vem antes, com o número escrito. */
    const l = limites(req.user.org_id);
    const jaLiberados = db.prepare(`SELECT COUNT(*) n FROM users
      WHERE org_id = ? AND status = 'ativo' AND canal_liberado = 1 AND id <> ?`).get(req.user.org_id, u.id).n;
    // +1 pela linha da casa, que ocupa uma das vagas do plano.
    if (jaLiberados + 1 + 1 > l.limite)
      return res.status(409).json({
        error: `O plano desta imobiliária permite ${l.limite} linha(s) de WhatsApp (a da imobiliária mais ${l.limite - 1} de corretores), e elas já estão liberadas. Tire a liberação de alguém ou fale com o ConHub para aumentar o plano.` });
  }

  db.prepare("UPDATE users SET canal_liberado = ? WHERE id = ?").run(ligar ? 1 : 0, u.id);
  /* Tirar a liberação DESLIGA a linha e devolve as conversas para o número da
     casa. Deixar a linha no ar depois de tirar a autorização seria uma
     autorização que não autoriza nada — e o custo continuaria correndo. */
  let devolvidos = 0;
  if (!ligar) {
    const c = canalDoUsuario(req.user.org_id, u.id);
    if (c) devolvidos = (desligarCanal(c.id).devolvidos) || 0;
  }
  res.json({ ok: true, liberado: ligar, devolvidos, limites: limites(req.user.org_id) });
});

/* Ligar a MINHA linha. Só a própria: parear o WhatsApp de outra pessoa não é
   uma permissão que exista, nem para o gestor. */
r.post("/meu", (req, res) => {
  const u = db.prepare("SELECT canal_liberado FROM users WHERE id = ?").get(req.user.id) || {};
  if (!u.canal_liberado)
    return res.status(403).json({ error: "O gestor da imobiliária ainda não liberou um número de WhatsApp para você. Cada número tem um custo mensal, por isso a liberação é dele." });
  const out = criarCanalDoCorretor(req.user.org_id, req.user.id, { quem: req.user.id });
  if (out.erro) return res.status(409).json({ error: out.erro });
  res.json({ ok: true, meu: enxuto(out.canal), limites: limites(req.user.org_id) });
});

r.post("/meu/credenciais", async (req, res) => {
  const host = String(req.body?.host || "").trim();
  const token = String(req.body?.token || "").trim();
  if (!host || !token) return res.status(400).json({ error: "Informe o endereço (host) e o token da sua instância." });
  if (!/^https?:\/\//i.test(host))
    return res.status(400).json({ error: "O endereço precisa começar com https:// (é o que a Uazapi mostra no painel)." });

  const u = db.prepare("SELECT canal_liberado FROM users WHERE id = ?").get(req.user.id) || {};
  if (!u.canal_liberado) return res.status(403).json({ error: "O gestor ainda não liberou um número de WhatsApp para você." });

  let meu = canalDoUsuario(req.user.org_id, req.user.id);
  if (!meu) {
    const criado = criarCanalDoCorretor(req.user.org_id, req.user.id, { quem: req.user.id });
    if (criado.erro) return res.status(409).json({ error: criado.erro });
    meu = criado.canal;
  }

  /* Token repetido é quase sempre o da instância da CASA, copiado da tela do
     gestor. Deixar passar seria o pior desfecho possível desta tela: as duas
     linhas apontariam para o mesmo WhatsApp, o webhook entregaria a mensagem à
     primeira que casasse e o corretor acharia que estava falando pelo número
     dele. O índice do banco já barra; a mensagem é que precisa dizer o quê. */
  const jaUsado = db.prepare("SELECT id, org_id, tipo, nome FROM canais WHERE token = ? AND id <> ?").get(token, meu.id);
  if (jaUsado) return res.status(409).json({
    error: jaUsado.tipo === "imobiliaria" && jaUsado.org_id === req.user.org_id
      ? "Esse é o token do WhatsApp da imobiliária. Você precisa de uma instância só sua na Uazapi — com o seu número."
      : "Esse token já está em uso por outra linha. Cada número precisa da própria instância na Uazapi." });

  salvarConexao(meu.id, { host, token, quem: req.user.id });
  const whatsapp = await instanceStatus(req.user.org_id, meu.id);
  // O número pareado, quando a Uazapi souber dizer: é o que a tela mostra para
  // a pessoa conferir que ligou o telefone certo.
  if (whatsapp && whatsapp.numero)
    db.prepare("UPDATE canais SET wa_number = ? WHERE id = ?").run(whatsapp.numero, meu.id);

  res.json({
    ok: true, meu: enxuto(canalPorId(meu.id)), whatsapp,
    aviso: whatsapp.ok ? null : "Salvei, mas a Uazapi não respondeu com esses dados. Confira o endereço e o token da SUA instância.",
  });
});

/* A MINHA linha, na API oficial da Meta.

   Aqui o corretor digita SÓ o Phone Number ID dele — nunca o token do
   aplicativo, que fala em nome da imobiliária inteira. O resto
   (WABA/token/app secret/verify token) vem sozinho da linha da casa, dentro
   de `salvarConexaoOficial`; se a casa ainda não estiver na API oficial, a
   própria função recusa com a explicação. */
r.post("/meu/oficial", async (req, res) => {
  const phoneNumberId = String(req.body?.phone_number_id || "").trim();
  if (!phoneNumberId) return res.status(400).json({ error: "Informe o Phone Number ID da sua linha (cadastrado no mesmo aplicativo da Meta que a imobiliária usa)." });

  const u = db.prepare("SELECT canal_liberado FROM users WHERE id = ?").get(req.user.id) || {};
  if (!u.canal_liberado)
    return res.status(403).json({ error: "O gestor da imobiliária ainda não liberou um número de WhatsApp para você. Cada número tem um custo mensal, por isso a liberação é dele." });

  let meu = canalDoUsuario(req.user.org_id, req.user.id);
  if (!meu) {
    const criado = criarCanalDoCorretor(req.user.org_id, req.user.id, { quem: req.user.id });
    if (criado.erro) return res.status(409).json({ error: criado.erro });
    meu = criado.canal;
  }

  const jaUsado = db.prepare("SELECT id FROM canais WHERE phone_number_id = ? AND id <> ?").get(phoneNumberId, meu.id);
  if (jaUsado) return res.status(409).json({ error: "Esse Phone Number ID já está em uso por outra linha." });

  try {
    salvarConexaoOficial(meu.id, { phoneNumberId });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const whatsapp = await instanceStatus(req.user.org_id, meu.id);
  res.json({
    ok: true, meu: enxuto(canalPorId(meu.id)), whatsapp, limites: limites(req.user.org_id),
    aviso: whatsapp.ok ? null : "Salvei, mas a Meta não respondeu com esses dados. Confira o Phone Number ID.",
  });
});

/* O robô fora do expediente NESTA linha. Nasce desligado, e quem liga é o dono
   do número — decidir que existe uma IA falando pelo seu WhatsApp pessoal não
   é decisão de gestão. */
r.post("/meu/robo", (req, res) => {
  const meu = canalDoUsuario(req.user.org_id, req.user.id);
  if (!meu) return res.status(404).json({ error: "Você ainda não tem um número ligado." });
  const ligar = req.body?.ligado !== false;
  db.prepare("UPDATE canais SET robo_ligado = ? WHERE id = ?").run(ligar ? 1 : 0, meu.id);
  res.json({ ok: true, meu: enxuto(canalPorId(meu.id)) });
});

// Desligar a própria linha. As conversas voltam para o número da imobiliária —
// nenhuma fica sem caminho de resposta.
r.delete("/meu", (req, res) => {
  const meu = canalDoUsuario(req.user.org_id, req.user.id);
  if (!meu) return res.status(404).json({ error: "Você não tem um número ligado." });
  const out = desligarCanal(meu.id);
  if (out.erro) return res.status(400).json({ error: out.erro });
  res.json(out);
});

// O gestor também desliga a linha de alguém — é ele quem paga por ela.
r.delete("/:id", roles("adm"), (req, res) => {
  const c = canalPorId(req.params.id);
  if (!c || c.org_id !== req.user.org_id) return res.status(404).json({ error: "Linha não encontrada." });
  const out = desligarCanal(c.id);
  if (out.erro) return res.status(400).json({ error: out.erro });
  if (c.user_id) db.prepare("UPDATE users SET canal_liberado = 0 WHERE id = ?").run(c.user_id);
  res.json(out);
});

export default r;
