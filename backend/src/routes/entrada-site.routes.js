/* POST /publico/leads — o formulário do site da imobiliária manda o lead
   (11/11/2026; regras em services/entrada-site.js).

   Montado em server.js ANTES do `cors()` global, com caminho explícito: o
   CORS daqui é próprio (só os sites cadastrados por alguma conta) e o corpo é
   lido aqui mesmo, com teto pequeno. Rota pública: sem crachá, só o token da
   conta no cabeçalho Authorization. */
import express, { Router } from "express";
import { ipDe } from "../seguranca.js";
import { contaDoToken, configDaEntrada, origemPermitidaEmAlguma, limparOrigem, receberDoSite, ErroEntrada } from "../services/entrada-site.js";

const r = Router();

/* Freio em memória (some no reinício — o objetivo é segurar a enxurrada, não
   guardar cadastro de infrator): 20 por IP a cada 10 minutos, 300 por conta
   por hora. */
const porIp = new Map(), porConta = new Map();
function passou(mapa, chave, teto, janela) {
  const agora = Date.now();
  const l = (mapa.get(chave) || []).filter(t => agora - t < janela);
  if (l.length >= teto) { mapa.set(chave, l); return false; }
  l.push(agora); mapa.set(chave, l);
  if (mapa.size > 5000) for (const [k, v] of mapa) if (!v.some(t => agora - t < janela)) mapa.delete(k);
  return true;
}
const TETO_IP = Number(process.env.SITE_LEADS_POR_IP || 20);
const TETO_CONTA = Number(process.env.SITE_LEADS_POR_CONTA || 300);

function cabecalhosCors(res, origem) {
  res.setHeader("Access-Control-Allow-Origin", origem);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

// Preflight: não leva o token, então vale o site estar cadastrado em alguma conta.
r.options("/", (req, res) => {
  const origem = req.headers.origin;
  if (origem && origemPermitidaEmAlguma(origem)) { cabecalhosCors(res, limparOrigem(origem)); return res.sendStatus(204); }
  return res.sendStatus(403);
});

r.post("/", express.json({ limit: "64kb" }), (req, res) => {
  const origem = req.headers.origin ? limparOrigem(req.headers.origin) : null;
  if (!passou(porIp, ipDe(req), TETO_IP, 10 * 60000))
    return res.status(429).json({ error: "Muitos envios seguidos deste endereço. Espere alguns minutos e tente de novo." });

  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  const conta = m ? contaDoToken(m[1]) : null;
  if (!conta) return res.status(401).json({ error: "Token de integração ausente ou inválido. Gere o token em Configurações → Atendimento → Formulário do seu site." });
  if (!conta.ativo) return res.status(403).json({ error: "O recebimento de leads do site está desligado nesta conta." });

  // De navegador, o site precisa estar na lista desta conta.
  const cfg = configDaEntrada(conta.org_id);
  if (origem) {
    if (!cfg.origens.includes(origem)) return res.status(403).json({ error: `O site ${origem} não está liberado para esta conta.` });
    cabecalhosCors(res, origem);
  }
  if (!passou(porConta, conta.org_id, TETO_CONTA, 60 * 60000))
    return res.status(429).json({ error: "Limite de envios por hora desta conta atingido. Tente de novo mais tarde." });

  try {
    const out = receberDoSite(conta.org_id, req.body);
    return res.status(201).json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof ErroEntrada) return res.status(e.status).json({ error: e.message });
    console.error("[site] lead do formulário falhou:", e.message);
    return res.status(500).json({ error: "Não deu para registrar o lead agora. Tente de novo." });
  }
});

// Corpo que não é JSON válido: resposta em JSON, não a página de erro do Express.
r.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large"))
    return res.status(err.type === "entity.too.large" ? 413 : 400).json({ error: err.type === "entity.too.large" ? "Corpo grande demais." : "O corpo precisa ser um JSON válido." });
  next(err);
});

export default r;
