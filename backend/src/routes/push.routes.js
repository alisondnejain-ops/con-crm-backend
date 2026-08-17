import { Router } from "express";
import { authRequired } from "../auth.js";
import { chavePublica, configurado, inscrever, cancelar, inscricoesDe, avisar, trocar } from "../services/push.js";

const r = Router();

// A chave pública é pública mesmo — o navegador precisa dela para se inscrever.
// Fica fora do login porque a tela consulta antes de mostrar o botão de ativar.
// Se `configurado` vier false, a tela nem oferece a opção.
r.get("/push/chave", (_req, res) => res.json({ configurado: configurado(), chave: chavePublica() }));

/* CUIDADO: aqui havia um `r.use(authRequired)`. Como este roteador é montado
   na raiz ("/"), ele não trancava só as rotas de push: trancava tudo que fosse
   registrado DEPOIS dele no server.js — e /integracoes vem depois. O
   diagnóstico das integrações respondia "Não autenticado" para o navegador, o
   que fazia parecer erro de configuração do R2 quando o problema era este.
   Mesma armadilha já documentada em assinatura.routes.js. Login rota a rota. */

r.post("/push/inscrever", authRequired, (req, res) => {
  if (!configurado()) return res.status(503).json({ error: "Notificações não configuradas no servidor." });
  try {
    inscrever(req.user.id, req.body && req.body.subscription);
    res.json({ ok: true, aparelhos: inscricoesDe(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* Renovação automática da inscrição, feita pelo service worker.

   SEM `authRequired` de propósito: o service worker roda com a página
   fechada e não tem o token. Quem prova ser o dono é o endereço antigo, que
   só o navegador daquele aparelho conhece — e o serviço só TRANSFERE uma
   inscrição existente, nunca cria uma nova para alguém. */
r.post("/push/trocar", (req, res) => {
  const { antigo, nova } = req.body || {};
  const out = trocar(antigo, nova);
  if (!out.trocada) return res.status(404).json({ error: "Inscrição não encontrada." });
  res.json({ ok: true });
});

r.post("/push/cancelar", authRequired, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) cancelar(endpoint);
  res.json({ ok: true, aparelhos: inscricoesDe(req.user.id) });
});

// Quantos aparelhos deste usuário estão ativos — a tela usa para dizer
// "ativado neste aparelho" em vez de deixar o corretor no escuro.
r.get("/push/situacao", authRequired, (req, res) =>
  res.json({ configurado: configurado(), aparelhos: inscricoesDe(req.user.id) }));

// Manda uma notificação de teste para o próprio usuário. Sem isto, a única
// forma de saber se funcionou seria esperar um lead chegar de verdade.
r.post("/push/teste", authRequired, async (req, res) => {
  const { enviados } = await avisar(req.user.id, {
    titulo: "ConHub", corpo: "Notificação de teste — está funcionando! 🎉",
  });
  res.json({ ok: true, enviados });
});

export default r;
