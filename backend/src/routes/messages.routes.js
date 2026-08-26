import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db.js";
import { authRequired, supervisiona, podeVerLead } from "../auth.js";
import { sendText, sendMedia, sendLocation, editMessage } from "../services/uazapi.js";
import { salvar, limiteBytes, bytesDoArquivo } from "../services/storage.js";
import { pararPorGente } from "../services/robo.js";

// O tipo do arquivo pela extensão da URL guardada. Só serve para rotular o
// arquivo embutido no reenvio — o catálogo já limitou o que pode entrar.
const MIME_POR_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime",
};
const mimeDaUrl = (url) => MIME_POR_EXT[String(url || "").split(".").pop().toLowerCase()] || "application/octet-stream";
import { inferStage } from "../services/stages.js";

const r = Router();
r.use(authRequired);

// Envia mensagem ao lead pelo número único da Conecta, ASSINADA com o nome de quem envia.
// Depois, roda o avanço automático de etapa com base na conversa.
r.post("/:id/messages", async (req, res) => {
  const { text, reply_to } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Mensagem vazia" });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

  // O corretor só fala com o próprio lead; gestor e atendente falam em qualquer um.
  if (!podeVerLead(req.user, lead))
    return res.status(403).json({ error: "Este lead não está com você" });

  /* A mensagem citada tem que ser DESTA conversa. Sem esta checagem, dava para
     citar a mensagem de outro cliente pelo id e vazar o texto dela na tela. */
  const citada = reply_to
    ? db.prepare("SELECT id, wa_id, body FROM messages WHERE id = ? AND lead_id = ?").get(reply_to, lead.id)
    : null;
  if (reply_to && !citada) return res.status(400).json({ error: "A mensagem citada não é desta conversa." });

  const firstName = (req.user.name || "").split(" ")[0];

  let envio;
  try {
    envio = await sendText({ orgId: lead.org_id, toPhone: lead.phone, text: text.trim(), signedBy: firstName,
      // Sem `wa_id` (mensagem anterior a 09/08/2026) não dá para citar no
      // WhatsApp — mas a citação continua valendo dentro do CRM.
      replyTo: citada && citada.wa_id ? citada.wa_id : null, quotedText: citada ? citada.body : null });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  // `wa_id`: o webhook devolve esta mesma mensagem daqui a instantes, e e por
  // ele que ela e reconhecida como eco em vez de virar uma copia na conversa.
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,wa_id,reply_to,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName, text.trim(),
      envio?.messageid || null, citada ? citada.id : null, now);

  // primeira resposta do atendente -> marca tempo de 1ª resposta
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);
  pararPorGente(lead.id);   // gente atendeu: o robô sai desta conversa

  advanceStage(lead.id);
  res.json({ ok: true });
});

/* Editar uma mensagem já enviada, nas regras do WhatsApp.

   Três regras vêm de lá e não são nossas: só até 15 minutos, só texto, e só
   mensagem que saiu daqui. A quarta é da casa: a mensagem é assinada com o
   nome de quem a escreveu, então quem edita é o autor — ou a gestão, que
   responde pelo que sai no número da imobiliária.

   O ponto que sustenta tudo: o texto no CRM só muda DEPOIS que a Uazapi
   confirma a edição. Se ela não editar, o CRM continua mostrando o que o
   cliente tem no celular. Um CRM que mostra uma coisa e o cliente tem outra
   deixa de servir de registro — que é metade do valor deste sistema. */
const JANELA_EDICAO = 15 * 60000;

r.patch("/:id/messages/:msgId", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "A mensagem não pode ficar vazia." });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVerLead(req.user, lead))
    return res.status(403).json({ error: "Este lead não está com você" });

  const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND lead_id = ?").get(req.params.msgId, lead.id);
  if (!msg) return res.status(404).json({ error: "Mensagem não encontrada nesta conversa." });
  if (msg.direction !== "out") return res.status(400).json({ error: "Só dá para editar mensagem enviada por vocês." });
  if (msg.media_url) return res.status(400).json({ error: "O WhatsApp não deixa editar foto, áudio nem vídeo — apague e mande de novo." });
  if (!msg.wa_id) return res.status(400).json({ error: "Esta mensagem é antiga demais: foi enviada antes de o CRM guardar o identificador do WhatsApp, então não dá para editá-la lá." });

  const idade = Date.now() - msg.created_at;
  if (idade > JANELA_EDICAO)
    return res.status(400).json({ error: `O WhatsApp só deixa editar nos primeiros 15 minutos. Esta tem ${Math.floor(idade / 60000)} minutos.` });

  if (msg.from_user_id && msg.from_user_id !== req.user.id && !supervisiona(req.user))
    return res.status(403).json({ error: "Esta mensagem foi assinada por outra pessoa." });

  try {
    await editMessage({ orgId: lead.org_id, messageid: msg.wa_id, text: text.trim() });
  } catch (e) {
    // De propósito: NADA muda no banco quando a edição não sai no WhatsApp.
    return res.status(502).json({ error: "Não consegui editar no WhatsApp — a mensagem continua como está", detail: e.message });
  }

  db.prepare(`UPDATE messages SET body = ?, edited_at = ?, edited_by = ?,
    body_original = COALESCE(body_original, ?) WHERE id = ?`)
    .run(text.trim(), Date.now(), req.user.id, msg.body, msg.id);

  // O texto mudou, e é o texto que move o funil.
  advanceStage(lead.id);
  res.json({ ok: true });
});

/* Anexos que o CORRETOR manda: áudio gravado, fotos e vídeo.

   Limites combinados com o Ali (30/07/2026): até 10 fotos por envio, 1 vídeo,
   1 áudio. Não é capricho — cada arquivo vira uma requisição para a Uazapi e
   ocupa disco, e disparo em rajada num número não-oficial é o que mais chama
   atenção do WhatsApp.

   O arquivo é guardado primeiro porque a Uazapi envia a partir de uma URL
   pública: sem guardar, não há o que mandar. Como o arquivo fica salvo, ele
   também aparece no balão da conversa, igual ao que o cliente manda. */
const LIMITES = { image: 10, video: 1, audio: 1 };
const familia = (mime) => (/^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "");

r.post("/:id/anexo", async (req, res) => {
  const { arquivos } = req.body || {};
  if (!Array.isArray(arquivos) || !arquivos.length) return res.status(400).json({ error: "Nenhum arquivo recebido." });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVerLead(req.user, lead))
    return res.status(403).json({ error: "Este lead não está com você" });

  // Confere os limites antes de gravar qualquer coisa: melhor recusar tudo do
  // que mandar 10 fotos e falhar na 11ª, deixando o envio pela metade.
  const contagem = {};
  for (const a of arquivos) {
    const f = familia(a.mime || "");
    if (!f) return res.status(400).json({ error: `Tipo de arquivo não aceito: ${a.mime || "desconhecido"}` });
    contagem[f] = (contagem[f] || 0) + 1;
    if (contagem[f] > LIMITES[f])
      return res.status(400).json({ error: `Máximo de ${LIMITES[f]} ${f === "image" ? "fotos" : f === "video" ? "vídeo" : "áudio"} por envio.` });
  }

  const firstName = (req.user.name || "").split(" ")[0];
  const enviados = [];
  try {
    for (const [i, a] of arquivos.entries()) {
      const buffer = Buffer.from(String(a.base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
      if (!buffer.length) return res.status(400).json({ error: "Arquivo vazio." });
      if (buffer.length > limiteBytes(a.mime))
        return res.status(413).json({ error: `"${a.nome || "arquivo"}" passa do limite de ${Math.round(limiteBytes(a.mime) / 1048576)} MB.` });

      const { url } = await salvar({ buffer, mime: a.mime, prefixo: "conversas" });
      const f = familia(a.mime);
      // "ptt" é o áudio de voz do WhatsApp — aparece como mensagem de voz, e não
      // como arquivo de música anexado.
      const tipoUazapi = f === "audio" ? "ptt" : f;
      // A legenda vai só na primeira: repetida em 10 fotos, vira spam.
      const legenda = i === 0 && req.body.texto ? String(req.body.texto).trim() : "";
      // `bytes` é o mesmo arquivo que acabou de subir: se a Uazapi não
      // conseguir baixar pela URL, ele vai embutido, sem reler nada.
      const envio = await sendMedia({ orgId: lead.org_id, toPhone: lead.phone, type: tipoUazapi, file: url, bytes: buffer, mime: a.mime,
        caption: legenda || undefined, signedBy: legenda ? firstName : undefined });
      enviados.push({ url, mime: a.mime, nome: a.nome || "", legenda, wa_id: envio?.messageid || null });
    }
  } catch (e) {
    // Parte pode ter ido. Registramos o que saiu para a conversa não mentir.
    for (const m of enviados) gravarSaida(lead, req.user, firstName, m);
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message, enviados: enviados.length });
  }

  for (const m of enviados) gravarSaida(lead, req.user, firstName, m);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(Date.now(), lead.id);
  pararPorGente(lead.id);   // gente atendeu: o robô sai desta conversa
  advanceStage(lead.id);
  res.json({ ok: true, enviados: enviados.length });
});

// Localização de onde o corretor está agora (GPS do celular). Vai como ponto no
// mapa, não como link — o cliente abre direto no aplicativo de mapas dele.
r.post("/:id/localizacao", async (req, res) => {
  const { latitude, longitude } = req.body || {};
  const lat = Number(latitude), lon = Number(longitude);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return res.status(400).json({ error: "Coordenadas inválidas." });

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVerLead(req.user, lead))
    return res.status(403).json({ error: "Este lead não está com você" });

  const firstName = (req.user.name || "").split(" ")[0];
  try {
    await sendLocation({ orgId: lead.org_id, toPhone: lead.phone, latitude: lat, longitude: lon, name: `${firstName} — Conecta Imóveis` });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName,
      `📍 Localização enviada (https://maps.google.com/?q=${lat},${lon})`, now);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);
  pararPorGente(lead.id);   // gente atendeu: o robô sai desta conversa
  res.json({ ok: true });
});

function gravarSaida(lead, user, firstName, m) {
  const rotulo = /^image\//.test(m.mime) ? "Foto" : /^video\//.test(m.mime) ? "Vídeo" : /^audio\//.test(m.mime) ? "Áudio" : (m.nome || "Arquivo");
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,media_url,media_mime,media_name,wa_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", user.id, firstName,
      m.legenda || rotulo, m.url, m.mime, m.nome || null, m.wa_id || null, Date.now());
}

// Monta a apresentação do imóvel do jeito que o cliente quer ler: o essencial
// primeiro, sem jargão interno. Comissão e captador NUNCA entram aqui.
export function textoDoProduto(p) {
  const moeda = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const linhas = [`*${p.titulo}*`];
  const local = [p.bairro, p.cidade].filter(Boolean).join(" · ");
  if (local) linhas.push(`📍 ${local}`);
  if (p.tipo === "casa") {
    const comodos = [p.quartos && `${p.quartos} quarto(s)`, p.banheiros && `${p.banheiros} banheiro(s)`].filter(Boolean).join(" · ");
    if (comodos) linhas.push(`🛏 ${comodos}`);
  }
  if (p.metragem) linhas.push(`📐 ${p.metragem} m² de terreno`);
  if (p.tipo === "casa" && p.construtor) linhas.push(`🏗 ${p.construtor}`);
  if (p.modalidade) linhas.push(`🏡 Financiamento: ${p.modalidade}`);
  else if (p.morar_bem) linhas.push("🏡 Faz parte do programa Morar Bem Pernambuco");
  if (p.valor) linhas.push(`💰 ${moeda(p.valor)}`);
  if (p.observacoes) linhas.push("", p.observacoes);
  return linhas.join("\n");
}

// Envia o imóvel para o lead: texto + fotos + vídeo, conforme o corretor marcar.
// A localização é opcional DE PROPÓSITO — mandar endereço sem querer é o tipo de
// erro que não dá para desfazer no WhatsApp.
r.post("/:id/produto", async (req, res) => {
  const { produto_id, fotos = true, video = false, localizacao = false, fotos_ids } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVerLead(req.user, lead))
    return res.status(403).json({ error: "Este lead não está com você" });

  const p = db.prepare("SELECT * FROM produtos WHERE id = ? AND org_id = ?").get(produto_id, req.user.org_id);
  if (!p) return res.status(404).json({ error: "Produto não encontrado" });

  const firstName = (req.user.name || "").split(" ")[0];
  const midias = db.prepare("SELECT id,tipo,url,chave FROM produto_midias WHERE produto_id=? ORDER BY ordem").all(p.id);

  /* Quais fotos vão. Sem `fotos_ids` continua indo o anúncio inteiro, que é o
     que já acontecia e o que o corretor faz na maior parte das vezes.

     Com a lista, vão só as escolhidas — o captador sobe dez fotos do
     empreendimento e o corretor quer mandar as três do apartamento que
     interessa àquele cliente. Mandar as dez é o jeito rápido de o cliente
     parar de olhar.

     A ordem é sempre a do anúncio, não a da escolha: a primeira foto é a capa
     que o captador definiu, e é ela que leva a legenda. */
  const escolhidas = Array.isArray(fotos_ids) ? new Set(fotos_ids.map(String)) : null;
  const fotosParaEnviar = midias.filter(m => m.tipo === "foto" &&
    (!escolhidas || escolhidas.has(String(m.id))));
  let texto = textoDoProduto(p);
  if (localizacao && p.maps_url) texto += `\n\n📍 Localização: ${p.maps_url}`;

  try {
    await sendText({ orgId: lead.org_id, toPhone: lead.phone, text: texto, signedBy: firstName });
    /* A foto do catálogo já está guardada, então aqui não temos o arquivo em
       mãos. `bytes` é uma função: só lê do disco/R2 se a URL falhar — assim o
       envio normal continua tão leve quanto era. */
    if (fotos) for (const m of fotosParaEnviar)
      await sendMedia({ orgId: lead.org_id, toPhone: lead.phone, type: "image", file: m.url,
        bytes: () => bytesDoArquivo(m.chave), mime: mimeDaUrl(m.url) });
    if (video) for (const m of midias.filter(m => m.tipo === "video"))
      await sendMedia({ orgId: lead.org_id, toPhone: lead.phone, type: "video", file: m.url,
        bytes: () => bytesDoArquivo(m.chave), mime: mimeDaUrl(m.url) });
  } catch (e) {
    return res.status(502).json({ error: "Falha ao enviar pelo WhatsApp", detail: e.message });
  }

  const now = Date.now();
  /* O registro na conversa diz QUANTAS fotos foram quando não foram todas.
     Sem isso, olhando o histórico dois dias depois, ninguém sabe se o cliente
     viu o anúncio inteiro ou três fotos escolhidas — e é essa a diferença que
     explica por que ele não se animou. */
  const todasAsFotos = midias.filter(m => m.tipo === "foto").length;
  const parcial = fotos && fotosParaEnviar.length > 0 && fotosParaEnviar.length < todasAsFotos;
  const registro = `[Imóvel enviado] ${p.titulo}`
    + (parcial ? ` (${fotosParaEnviar.length} de ${todasAsFotos} fotos)` : "")
    + (localizacao && p.maps_url ? " (com localização)" : "");
  db.prepare(`INSERT INTO messages (id,lead_id,direction,from_user_id,from_name,body,created_at)
    VALUES (?,?,?,?,?,?,?)`).run("m_" + randomUUID(), lead.id, "out", req.user.id, firstName, registro, now);
  if (!lead.first_resp_at) db.prepare("UPDATE leads SET first_resp_at = ? WHERE id = ?").run(now, lead.id);
  pararPorGente(lead.id);   // gente atendeu: o robô sai desta conversa
  // Guarda como imóvel de interesse, se ainda não houver outro marcado.
  if (!lead.produto_id) db.prepare("UPDATE leads SET produto_id = ? WHERE id = ?").run(p.id, lead.id);

  advanceStage(lead.id);
  res.json({ ok: true, enviadas: (fotos ? fotosParaEnviar.length : 0) + (video ? midias.filter(m => m.tipo === "video").length : 0) });
});

// Imóvel de interesse do lead (opcional, marcado pelo corretor na ficha).
r.patch("/:id/interesse", (req, res) => {
  const { produto_id } = req.body || {};
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
  if (!podeVerLead(req.user, lead))
    return res.status(403).json({ error: "Este lead não está com você" });
  db.prepare("UPDATE leads SET produto_id = ? WHERE id = ?").run(produto_id || null, lead.id);
  res.json({ ok: true });
});

/* A CONVERSA SUGERE UMA ETAPA — E NÃO MOVE NADA.

   Isto já foi `advanceStage`, e movia o lead sozinho quando a palavra da etapa
   aparecia na conversa. Saiu a pedido do Ali (26/08/2026), e o motivo não é a
   regra ter errado muito: é que ela e a gestão escreviam no MESMO lugar. O
   funil andava pela palavra, a pessoa corrigia na mão, a palavra aparecia de
   novo na mensagem seguinte e empurrava outra vez — e no fim ninguém sabia
   dizer, olhando o relatório, qual etapa era leitura de gente e qual era
   palpite de regex. Número que ninguém reconhece não sustenta reunião.

   A leitura continua: é de graça, é instantânea e acerta quando a palavra é
   dita mesmo. Só que agora ela vira RECOMENDAÇÃO, guardada ao lado do lead, e
   quem grava a etapa é uma pessoa no botão — pela rota manual de sempre, com
   `motivo='mao'`. É a mesma regra que já valia para a etapa lida pela IA: a
   máquina lê, quem escreve é gente.

   Nunca lança: é chamada de dentro de webhook e de envio de mensagem, e
   sugestão que falha não pode derrubar a entrada de lead. */
export function sugerirEtapa(leadId) {
  try {
    const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
    if (!lead) return;
    const msgs = db.prepare("SELECT direction,body FROM messages WHERE lead_id = ? ORDER BY created_at ASC").all(leadId);
    const sugerida = inferStage(lead.stage, msgs);
    /* `inferStage` só anda para a frente, então "igual à atual" quer dizer que
       não há nada a recomendar. Nesse caso a sugestão antiga é limpa — deixá-la
       na tela depois de a pessoa já ter movido o lead seria pedir a mesma
       confirmação duas vezes. */
    if (sugerida === lead.stage) {
      if (lead.sugestao_etapa)
        db.prepare("UPDATE leads SET sugestao_etapa=NULL, sugestao_de=NULL, sugestao_em=NULL WHERE id=?").run(leadId);
      return;
    }
    db.prepare("UPDATE leads SET sugestao_etapa=?, sugestao_de=?, sugestao_em=? WHERE id=?")
      .run(sugerida, lead.stage, Date.now(), leadId);
  } catch (e) {
    console.warn("[etapa] não consegui sugerir para", leadId, e.message);
  }
}

/* Nome antigo, mantido porque o webhook e as rotas de envio o chamam em quatro
   lugares. Aponta para a versão que NÃO move — se algum caminho voltar a
   chamar `advanceStage` esperando que ele mova, ele vai apenas sugerir. */
export const advanceStage = sugerirEtapa;

export default r;
