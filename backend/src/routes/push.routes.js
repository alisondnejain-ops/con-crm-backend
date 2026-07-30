import { Router } from "express";
import { authRequired } from "../auth.js";
import { chavePublica, configurado, inscrever, cancelar, inscricoesDe, avisar } from "../services/push.js";

const r = Router();

// A chave pública é pública mesmo — o navegador precisa dela para se inscrever.
// Fica fora do login porque a tela consulta antes de mostrar o botão de ativar.
// Se `configurado` vier false, a tela nem oferece a opção.
r.get("/push/chave", (_req, res) => res.json({ configurado: configurado(), chave: chavePublica() }));

r.use(authRequired);

r.post("/push/inscrever", (req, res) => {
  if (!configurado()) return res.status(503).json({ error: "Notificações não configuradas no servidor." });
  try {
    inscrever(req.user.id, req.body && req.body.subscription);
    res.json({ ok: true, aparelhos: inscricoesDe(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/push/cancelar", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) cancelar(endpoint);
  res.json({ ok: true, aparelhos: inscricoesDe(req.user.id) });
});

// Quantos aparelhos deste usuário estão ativos — a tela usa para dizer
// "ativado neste aparelho" em vez de deixar o corretor no escuro.
r.get("/push/situacao", (req, res) =>
  res.json({ configurado: configurado(), aparelhos: inscricoesDe(req.user.id) }));

// Manda uma notificação de teste para o próprio usuário. Sem isto, a única
// forma de saber se funcionou seria esperar um lead chegar de verdade.
r.post("/push/teste", async (req, res) => {
  const { enviados } = await avisar(req.user.id, {
    titulo: "ConHub", corpo: "Notificação de teste — está funcionando! 🎉",
  });
  res.json({ ok: true, enviados });
});

export default r;
