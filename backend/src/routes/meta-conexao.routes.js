/* "CONECTAR COM FACEBOOK" (01/10/2026, pedido do Ali: "cada cliente poder
   fazer essa conexão na própria conta sem muita dificuldade").

   O cliente clica no botão, entra com o Facebook dele, escolhe a página, e
   todo formulário de anúncio daquela página passa a cair NA CONTA DELE. São
   duas portas, e moram juntas porque uma só funciona com a outra:

   - `gestao` (logado, gestor): começa a conexão, mostra as páginas que a
     pessoa administra, liga e desliga cada uma.
   - `retorno` (SEM login): é para onde a janela do Facebook devolve a pessoa.
     Navegação comum não leva o crachá do CRM, então quem diz de qual conta é
     o pedido é o `state` — assinado, com prazo de 15 minutos e escopo próprio.

   UMA PÁGINA, UMA CONTA. A página é a chave de `meta_paginas`: conectá-la numa
   segunda conta é recusado dizendo isso. Sem a trava, a mesma página em duas
   imobiliárias faria o lead de uma aparecer na outra. */
import { Router } from "express";
import { randomBytes } from "crypto";
import db from "../db.js";
import { roles, emitirTokenCurto, verificarTokenCurto } from "../auth.js";
import { fechar, abrir } from "../services/cofre.js";
import {
  botaoConfigurado, urlDeLogin, trocarCodigo, paginasDoUsuario, assinarPagina, desassinarPagina, PERMISSOES,
} from "../services/meta.js";
import { avisosDaMeta } from "./meta.webhook.js";
import { listarFormularios, definirFunil, definirCatraca, ErroFormulario } from "../services/formularios.js";
import { ligarFichaAoFormulario, ErroFicha } from "../services/ia-produtos.js";

const ESCOPO = "meta-conectar";
const baseDe = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const retornoDe = (req) => `${baseDe(req)}/conectar-facebook/retorno`;

/* As páginas que voltaram do Facebook ficam aqui alguns minutos, com os
   tokens, enquanto a pessoa escolhe. Em memória de propósito: token de página
   só vai para o banco da página que ALGUÉM ESCOLHEU conectar. */
const escolhas = new Map();
const PRAZO = 15 * 60_000;
function guardarEscolha(dados) {
  const agora = Date.now();
  for (const [k, v] of escolhas) if (v.ate < agora) escolhas.delete(k);
  const chave = randomBytes(18).toString("hex");
  escolhas.set(chave, { ...dados, ate: agora + PRAZO });
  return chave;
}

/* ===== Retorno do Facebook (sem login) ===== */
export const retorno = Router();
retorno.get("/retorno", async (req, res) => {
  const voltar = (q) => res.redirect(`${baseDe(req)}/app?${new URLSearchParams(q)}`);
  const st = verificarTokenCurto(req.query.state, ESCOPO);
  if (!st) return voltar({ meta: "erro", motivo: "A conexão demorou demais ou o link não é válido. Clique em Conectar de novo." });
  if (req.query.error || !req.query.code) return voltar({ meta: "cancelado" });
  try {
    const userToken = await trocarCodigo(String(req.query.code), retornoDe(req));
    const paginas = await paginasDoUsuario(userToken);
    const chave = guardarEscolha({ orgId: st.o, userId: st.u, paginas });
    voltar({ meta: "escolher", k: chave });
  } catch (e) {
    console.error("[meta] conectar com Facebook falhou:", e.message);
    voltar({ meta: "erro", motivo: "O Facebook não liberou o acesso: " + String(e.message).slice(0, 160) });
  }
});

/* ===== Tela (logado, gestor) ===== */
export const gestao = Router();
gestao.use(roles("adm"));

const listaDaConta = (orgId) => db.prepare(`
  SELECT p.page_id, p.nome, p.conectado_em, p.ultimo_lead_em, p.ultimo_erro, p.ultimo_erro_em, u.name AS conectado_por
  FROM meta_paginas p LEFT JOIN users u ON u.id = p.conectado_por
  WHERE p.org_id = ? ORDER BY p.conectado_em`).all(orgId);

gestao.get("/", (req, res) => {
  const paginas = listaDaConta(req.user.org_id);
  res.json({
    configurado: botaoConfigurado(),
    paginas,
    permissoes: PERMISSOES,
    avisos: avisosDaMeta(paginas.map(p => p.page_id), !!req.user.master),
  });
});

/* Os formulários da página, com o funil próprio e as catracas de cada um —
   a lista que o editor da catraca e o gatilho de formulário dos fluxos
   mostram. Só gestor, como o resto desta tela. */
gestao.get("/formularios", async (req, res) => {
  try { res.json(await listarFormularios(req.user.org_id)); }
  catch (e) { console.error("[formularios]", e.message); res.status(500).json({ error: "Não consegui montar a lista de formulários." }); }
});
// As catracas de um formulário (03/10/2026; um formulário pode estar em
// várias). Rota própria, para escolher a catraca não mexer no funil.
gestao.post("/formularios/:formId/catraca", (req, res) => {
  try { res.json({ ok: true, ...definirCatraca(req.user.org_id, req.user.id, req.params.formId, req.body || {}) }); }
  catch (e) {
    if (e instanceof ErroFormulario) return res.status(e.status).json({ error: e.message });
    console.error("[formularios]", e.message); res.status(500).json({ error: "Não consegui salvar." });
  }
});
/* A ficha de produto da IA para os leads deste formulário (08/10/2026). */
gestao.post("/formularios/:formId/produto", (req, res) => {
  try {
    ligarFichaAoFormulario(req.user.org_id, req.user.id, req.params.formId, req.body?.ia_produto_id || null, req.body?.nome);
    res.json({ ok: true, ia_produto_id: req.body?.ia_produto_id || null });
  } catch (e) {
    if (e instanceof ErroFicha) return res.status(e.status).json({ error: e.message });
    console.error("[formularios]", e.message); res.status(500).json({ error: "Não consegui salvar." });
  }
});
gestao.post("/formularios/:formId", (req, res) => {
  try { res.json({ ok: true, ...definirFunil(req.user.org_id, req.user.id, req.params.formId, req.body || {}) }); }
  catch (e) {
    if (e instanceof ErroFormulario) return res.status(e.status).json({ error: e.message });
    console.error("[formularios]", e.message); res.status(500).json({ error: "Não consegui salvar." });
  }
});

gestao.post("/iniciar", (req, res) => {
  if (!botaoConfigurado()) return res.status(503).json({ error: "A conexão com o Facebook ainda não foi ativada no servidor do ConHub." });
  const state = emitirTokenCurto({ o: req.user.org_id, u: req.user.id }, ESCOPO, "15m");
  res.json({ url: urlDeLogin(state, retornoDe(req)) });
});

function escolhaDe(req) {
  const e = escolhas.get(String(req.params.chave || ""));
  // A escolha é de quem começou a conexão, nesta conta — não de quem souber a chave.
  if (!e || e.ate < Date.now() || e.orgId !== req.user.org_id || e.userId !== req.user.id) return null;
  return e;
}

gestao.get("/escolha/:chave", (req, res) => {
  const e = escolhaDe(req);
  if (!e) return res.status(404).json({ error: "Essa lista de páginas venceu. Clique em Conectar com Facebook de novo." });
  const donos = new Map(db.prepare("SELECT page_id, org_id FROM meta_paginas").all().map(x => [x.page_id, x.org_id]));
  res.json({ paginas: e.paginas.map(p => ({
    id: p.id, nome: p.nome,
    nesta_conta: donos.get(p.id) === req.user.org_id,
    em_outra_conta: donos.has(p.id) && donos.get(p.id) !== req.user.org_id,
  })) });
});

gestao.post("/escolha/:chave", async (req, res) => {
  const e = escolhaDe(req);
  if (!e) return res.status(404).json({ error: "Essa lista de páginas venceu. Clique em Conectar com Facebook de novo." });
  const ids = [...new Set((Array.isArray(req.body?.page_ids) ? req.body.page_ids : []).map(String))];
  if (!ids.length) return res.status(400).json({ error: "Escolha pelo menos uma página." });
  const resultado = [];
  for (const id of ids) {
    const p = e.paginas.find(x => x.id === id);
    if (!p) { resultado.push({ id, ok: false, erro: "Esta página não veio do Facebook nesta conexão." }); continue; }
    const dono = db.prepare("SELECT org_id FROM meta_paginas WHERE page_id = ?").get(id);
    if (dono && dono.org_id !== req.user.org_id) {
      resultado.push({ id, nome: p.nome, ok: false, erro: "Esta página já está conectada em outra conta do ConHub. Desconecte lá primeiro." });
      continue;
    }
    try {
      await assinarPagina(id, p.token);
      db.prepare(`INSERT INTO meta_paginas (page_id,org_id,nome,page_token,conectado_por,conectado_em)
                  VALUES (?,?,?,?,?,?)
                  ON CONFLICT(page_id) DO UPDATE SET nome = excluded.nome, page_token = excluded.page_token,
                    conectado_por = excluded.conectado_por, ultimo_erro = NULL`)
        .run(id, req.user.org_id, p.nome, fechar(p.token), req.user.id, Date.now());
      resultado.push({ id, nome: p.nome, ok: true });
    } catch (err) {
      resultado.push({ id, nome: p.nome, ok: false, erro: "O Facebook recusou ligar os avisos de lead desta página: " + String(err.message).slice(0, 160) });
    }
  }
  if (resultado.some(r => r.ok)) escolhas.delete(String(req.params.chave));
  res.json({ resultado, paginas: listaDaConta(req.user.org_id) });
});

gestao.delete("/paginas/:pageId", async (req, res) => {
  const p = db.prepare("SELECT * FROM meta_paginas WHERE page_id = ? AND org_id = ?").get(String(req.params.pageId), req.user.org_id);
  if (!p) return res.status(404).json({ error: "Página não encontrada nesta conta." });
  // Desligar os avisos no Facebook é cortesia: se falhar, a página sai daqui do
  // mesmo jeito — e lead de página que ninguém conectou não é entregue a ninguém.
  const token = abrir(p.page_token);
  if (token) await desassinarPagina(p.page_id, token).catch(e => console.warn("[meta] desassinar falhou:", e.message));
  db.prepare("DELETE FROM meta_paginas WHERE page_id = ?").run(p.page_id);
  res.json({ ok: true, paginas: listaDaConta(req.user.org_id) });
});
