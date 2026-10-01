import { Router } from "express";
import crypto, { randomUUID } from "crypto";
import { segredoConfere, mascararTelefone } from "../seguranca.js";
import db from "../db.js";
import { buscarLead, paginaDoTokenAntigo } from "../services/meta.js";
import { lerLead, receberLead } from "../services/portais.js";
import { abrir } from "../services/cofre.js";

const r = Router();

// 1) Verificação do webhook (a Meta chama com GET ao configurar).
r.get("/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

/* A META ASSINA O QUE MANDA — e a gente passou a conferir. (02/09/2026)

   Esta rota não tinha conferência nenhuma: qualquer pessoa podia mandar um
   POST fingindo ser a Meta. O estrago era limitado porque o passo seguinte é
   buscar o lead na Graph API com o nosso token, e um `leadgen_id` inventado
   não existe lá — mas "limitado" é diferente de "nenhum": dava para fazer o
   servidor martelar a Graph API à vontade, de graça, até a Meta nos limitar.

   A conferência é a que a Meta documenta: ela assina o corpo da requisição com
   o segredo do app (`META_APP_SECRET`) e manda o resultado em
   `x-hub-signature-256`. Só quem tem o segredo consegue produzir a assinatura.

   Sem o segredo configurado a rota CONTINUA aceitando, e aqui a decisão é o
   contrário da do Asaas — de propósito. Lá, aceitar sem conferir liberava
   dinheiro; aqui, recusar sem conferir faz PARAR DE ENTRAR LEAD, que é a falha
   mais cara deste sistema e a que ninguém percebe. Então o padrão erra para o
   lado de receber, e o `/integracoes` avisa em letras claras que a conferência
   está desligada. */
function assinaturaConfere(req) {
  const segredo = String(process.env.META_APP_SECRET || "").trim();
  if (!segredo) return true;                       // ver o parágrafo acima
  const veio = String(req.get("x-hub-signature-256") || "");
  if (!veio.startsWith("sha256=")) return false;
  /* O corpo já foi transformado em objeto pelo express.json, e a assinatura é
     sobre os BYTES originais. `JSON.stringify` reproduz o texto da Meta na
     prática (ela manda JSON compacto), e se um dia deixar de reproduzir, o
     sintoma é a recusa — visível em `/integracoes`, não silenciosa. */
  // Sobre os BYTES que chegaram (req.rawBody, guardado em server.js). O
  // JSON.stringify fica só de reserva, para o caso de o corpo cru faltar.
  const esperado = "sha256=" + crypto.createHmac("sha256", segredo)
    .update(req.rawBody || JSON.stringify(req.body || {})).digest("hex");
  return segredoConfere(veio, esperado);
}

/* O QUE A META MANDOU — visível na tela, não só no log (01/10/2026).

   No primeiro teste real a pergunta "a Meta está chamando? foi recusado? por
   quê?" só se respondia caçando linhas no log do Railway. Agora cada aviso
   fica numa lista curta em memória (zera a cada publicação, como o
   /integracoes/webhooks) e a tela de Anúncios do Meta mostra os da página da
   conta. Guarda o resultado, nunca o conteúdo do lead. */
const AVISOS = [];
export const iniciadoEm = Date.now();
function registrar(pageIds, resultado, detalhe) {
  const em = Date.now();
  for (const page_id of (pageIds.length ? pageIds : [""])) AVISOS.unshift({ em, page_id, resultado, detalhe: detalhe || null });
  AVISOS.length = Math.min(AVISOS.length, 60);
}
/* `master` vê também o último aviso de QUALQUER página (só hora e resultado):
   o botão "Teste" do painel da Meta manda um aviso de uma página de mentira,
   que nunca aparece na lista de página nenhuma — e é justamente ele que
   responde "a Meta chega até aqui e a assinatura passa?". Para quem não é
   master fica de fora: seria a hora do aviso de página de outro cliente. */
export function avisosDaMeta(pageIds, master = false) {
  const meus = new Set(pageIds.map(String));
  const ultimo = AVISOS[0];
  const conectadas = master ? new Set(db.prepare("SELECT page_id FROM meta_paginas").all().map(x => x.page_id)) : null;
  return {
    desde: iniciadoEm,
    ultimo_qualquer: master && ultimo ? { em: ultimo.em, resultado: ultimo.resultado } : null,
    // Para o master: os últimos avisos de QUALQUER página, com o id e se é de
    // uma página conectada — é o que separa "a Meta manda da página errada"
    // de "a Meta não manda".
    ultimos: master ? AVISOS.slice(0, 8).map(a => ({ em: a.em, page_id: a.page_id, resultado: a.resultado, detalhe: a.detalhe,
      conectada: conectadas.has(a.page_id) })) : undefined,
    lista: AVISOS.filter(a => meus.has(a.page_id)).slice(0, 10),
  };
}
const paginasDoCorpo = (b) => [...new Set((b?.entry || []).flatMap(e =>
  [e?.id, ...(e?.changes || []).map(c => c?.value?.page_id)]).filter(Boolean).map(String))];

/* DE QUEM É ESTE LEAD? (01/10/2026)

   A Meta manda o `page_id` em todo aviso. A página conectada pelo botão
   aponta para UMA conta (`meta_paginas`), e o lead vai para ela com o token
   dela. Antes do botão, todo aviso ia para a imobiliária mais antiga com o
   token do servidor — certo enquanto só a página da Conecta existia, e
   errado no dia em que houvesse outra.

   A página antiga continua valendo, mas SÓ ela: o servidor descobre qual é a
   página do META_PAGE_ACCESS_TOKEN (ou lê META_PAGE_ID) e recusa qualquer
   outra. Página que não é de ninguém não é entregue a ninguém. */
async function destinoDoLead(pageId) {
  const conectada = db.prepare("SELECT * FROM meta_paginas WHERE page_id = ?").get(pageId);
  if (conectada) {
    const token = abrir(conectada.page_token);
    if (!token) return { erro: "token da página não abre (CRYPTO_KEY trocada?)", pagina: conectada };
    return { orgId: conectada.org_id, token, pagina: conectada };
  }
  if (!process.env.META_PAGE_ACCESS_TOKEN) return null;
  const antiga = await paginaDoTokenAntigo();
  /* `undefined` = não deu para saber (o token do servidor não é de página).
     Aí vale o comportamento de antes, que é o que estava em produção: a busca
     do lead só funciona se o token tiver acesso àquela página. */
  if (antiga !== undefined && antiga !== pageId) return null;
  const org = db.prepare("SELECT id FROM orgs ORDER BY created_at, name LIMIT 1").get();
  return org ? { orgId: org.id, token: process.env.META_PAGE_ACCESS_TOKEN, antiga: true } : null;
}

// 2) Recebimento em tempo real.
r.post("/meta", async (req, res) => {
  if (!assinaturaConfere(req)) {
    console.warn("[meta] webhook recusado: assinatura não confere (confira META_APP_SECRET)");
    registrar(paginasDoCorpo(req.body), "assinatura",
      `${req.rawBody ? "corpo de " + req.rawBody.length + " bytes" : "sem corpo cru"} · ${String(req.get("content-type") || "sem tipo").slice(0, 60)}` +
      ` · ${String(req.get("x-hub-signature-256") || "").startsWith("sha256=") ? "com assinatura" : "SEM assinatura"}`);
    return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rápido; processa depois
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") { registrar([String(entry.id || "")], "outro_campo", String(change.field || "?")); continue; }
        const leadgenId = change.value?.leadgen_id;
        const pageId = String(change.value?.page_id || entry.id || "");
        if (!leadgenId || !pageId) continue;
        const destino = await destinoDoLead(pageId);
        if (!destino) {
          console.warn(`[meta] lead de uma página que nenhuma conta conectou (${pageId}) — descartado`);
          registrar([pageId], "sem_conta");
          continue;
        }
        if (destino.erro) {
          console.error("[meta]", destino.erro);
          registrar([pageId], "erro", destino.erro);
          db.prepare("UPDATE meta_paginas SET ultimo_erro = ?, ultimo_erro_em = ? WHERE page_id = ?").run(destino.erro, Date.now(), pageId);
          continue;
        }
        try {
          const dados = await buscarLead(leadgenId, destino.token);
          // O MESMO caminho do lead que chega pelo Zapier/Make: catraca, funil
          // de quem recebe, ficha, observação com as respostas e campanha.
          const lido = lerLead(dados, "meta");
          const out = receberLead(destino.orgId, lido);
          // Quando nada foi reconhecido, os NOMES dos campos que vieram (nunca
          // os valores) dizem na tela qual campo do formulário faltou ler.
          if (!out.ok) throw new Error(out.erro + (lido.campos?.length ? ` Campos que vieram: ${lido.campos.join(", ")}.` : ""));
          if (destino.pagina) db.prepare("UPDATE meta_paginas SET ultimo_lead_em = ?, ultimo_erro = NULL WHERE page_id = ?").run(Date.now(), pageId);
          console.log(`[meta] lead entregue (página ${pageId})`);
          registrar([pageId], "entregue");
        } catch (e) {
          console.error("[meta] erro ao buscar lead", leadgenId, e.message);
          registrar([pageId], "erro", String(e.message).slice(0, 200));
          if (destino.pagina) db.prepare("UPDATE meta_paginas SET ultimo_erro = ?, ultimo_erro_em = ? WHERE page_id = ?")
            .run(String(e.message).slice(0, 300), Date.now(), pageId);
        }
      }
    }
  } catch (e) {
    console.error("[meta] webhook erro:", e.message);
  }
});

export default r;
