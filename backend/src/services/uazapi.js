// Integração com a uazapiGO v2 (WhatsApp não-oficial) — número ÚNICO da Conecta.
//
// Confirmado na API da Conecta (https://conectaimoveis.uazapi.com):
//   - autenticação: header `token` com o token DA INSTÂNCIA (não o Admin Token)
//   - texto:        POST /send/text      { number, text }
//   - mídia:        POST /send/media     { number, type, file, text? }
//   - localização:  POST /send/location  { number, latitude, longitude, ... }
// Sem token válido a API responde 401 {"message":"Invalid token."}.

/* A conexão é POR IMOBILIÁRIA, não do servidor.

   Isto era global: um HOST e um TOKEN em variável de ambiente, valendo para
   todo mundo que rodasse aqui. Enquanto existia uma imobiliária só, funcionou.
   Com duas virou defeito grave — a segunda imobiliária via o WhatsApp da
   primeira como se fosse dela: mandava mensagem pelo número dos outros e o
   botão Desconectar derrubava o atendimento da casa vizinha.

   Agora as credenciais moram na linha da imobiliária (orgs.uazapi_host /
   orgs.uazapi_token) e TODA função aqui exige saber de qual imobiliária se
   está falando. Sem org, não há envio — de propósito: um envio sem dono é
   exatamente o erro que se está corrigindo.

   As variáveis de ambiente continuam valendo para a instalação que já existia:
   o bootstrap copia UAZAPI_HOST/UAZAPI_TOKEN para a imobiliária dona delas na
   primeira subida (ver bootstrap.js). Ninguém precisa reconectar nada. */
import db from "../db.js";
import { canalPorId, canalDaCasa, canalDoWhatsapp } from "./canais.js";
import * as oficial from "./whatsapp_oficial.js";

/* ===== DESPACHO PARA A API OFICIAL DA META (03/09/2026) =====

   Este arquivo virou o PONTO ÚNICO de envio/diagnóstico — todo o resto do
   sistema (routes/messages.routes.js, o robô, o webhook) chama `sendText`,
   `sendMedia` etc. daqui, sem saber se a linha é Uazapi ou Meta. Cada função
   resolve o CANAL DE ENVIO primeiro e, se ele for `provider === 'meta'`,
   desvia para `services/whatsapp_oficial.js` sem tocar em `credenciais()` —
   que continua sendo só do mundo Uazapi (host+token), do jeito que já estava
   testado.

   Escolhida esta forma, e não reescrever `credenciais()` para entender os
   dois provedores, porque `credenciais()` é lida em vários pontos com uma
   suposição implícita (host+token da Uazapi) que não faz sentido para a
   Meta — misturar os dois mundos numa função só trocaria um caminho testado
   por um caminho novo em cima do fluxo que já está em produção. */
function resolverCanalDoEnvio(orgId, canalId) {
  if (canalId) return canalPorId(canalId);
  return orgId ? canalDaCasa(orgId) : null;
}

/* AS CREDENCIAIS SÃO DE UMA LINHA, NÃO DA IMOBILIÁRIA (31/08/2026).

   Desde que o corretor pode ligar o WhatsApp dele, "de qual imobiliária" parou
   de ser pergunta suficiente: a mesma casa tem a linha dela e as pessoais, e
   mandar pela errada faz a mensagem chegar ao cliente vindo de um número que
   ele não conhece.

   `canalId` opcional, e a ausência dele significa a LINHA DA CASA — que é o
   que todo chamador antigo quer dizer sem saber que está dizendo. Por isso a
   mudança não quebra nenhum ponto de envio que ainda não foi tocado. */
export function credenciais(orgId, canalId = null) {
  if (!orgId && !canalId) return { host: "", token: "" };
  const canal = canalId ? canalPorId(canalId) : null;
  if (canal && canal.ativo && canal.token)
    return { host: limpar(canal.host), token: String(canal.token || ""), canal };

  /* Cai para a casa lendo `orgs`, e não o canal da casa, de propósito: é a
     coluna que o resto do sistema escreve, e numa divergência é ela que está
     certa. `migrarCanais` realinha o canal no start seguinte. */
  const o = db.prepare("SELECT uazapi_host, uazapi_token FROM orgs WHERE id = ?").get(orgId || (canal && canal.org_id)) || {};
  return { host: limpar(o.uazapi_host), token: String(o.uazapi_token || ""), canal: canalDaCasa(orgId) };
}

const limpar = (h) => String(h || "").replace(/\/$/, "");

export function uazapiConfigured(orgId, canalId = null) {
  const { host, token } = credenciais(orgId, canalId);
  return !!(host && token);
}

/* Guarda (ou apaga) a conexão de uma imobiliária. Token vazio desliga. */
export function salvarCredenciais(orgId, { host, token }) {
  db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ? WHERE id = ?")
    .run(String(host || "").trim().replace(/\/$/, "") || null, String(token || "").trim() || null, orgId);
}

/* De quem é este WhatsApp? Quem responde isso agora é `canalDoWhatsapp`, em
   services/canais.js: com várias linhas por imobiliária, a pergunta certa
   deixou de ser "de qual casa" e passou a ser "de qual LINHA" — a casa vem
   junto, pelo canal. Esta função ficou como ponte para quem só precisa da
   imobiliária, e sem o antigo chute de "só existe uma conectada, então é ela",
   que agora acertaria por acaso. */
export function orgDoWhatsapp({ token, numero }) {
  const c = canalDoWhatsapp({ token, numero });
  return c ? c.org_id : null;
}

/* Provedores de conexão do WhatsApp.

   Uma lista, e não um valor fixo, porque a Conecta vai testar outros. O campo
   `oficial: false` não é detalhe: API não oficial fere os termos do WhatsApp e
   o número pode ser banido. Quem assina a conta tem que ler isso na tela — não
   descobrir depois que o número da imobiliária caiu. */
export const PROVEDORES = [
  {
    id: "uazapi",
    nome: "Uazapi",
    oficial: false,
    descricao: "Conecta o WhatsApp comum lendo um QR Code, como o WhatsApp Web.",
    risco: "API não oficial: fere os termos do WhatsApp e o número pode ser bloqueado. Use um número dedicado da imobiliária, nunca o pessoal, e não dispare mensagem em massa igual.",
    site: "https://uazapi.com",
    disponivel: true,
  },
  {
    id: "meta",
    nome: "API oficial da Meta (WhatsApp Cloud API)",
    oficial: true,
    descricao: "Conecta direto com a Meta, dona do WhatsApp — sem QR Code, sem risco de bloqueio. Exige verificar a empresa no Gerenciador de Negócios e criar um aplicativo.",
    risco: null,
    /* O que é verdade aqui e não é verdade na Uazapi: mensagem enviada fora
       das 24h desde a última mensagem do cliente só sai como MODELO
       aprovado pela Meta, e não existe editar mensagem já enviada — são
       limitações da própria plataforma, e a tela precisa dizer isso antes de
       alguém trocar de provedor achando que ganha tudo que já tinha. */
    aviso: "Fora de 24h desde a última mensagem do cliente, só sai mensagem de modelo (aprovado antes pela Meta) — texto livre é recusado. Também não dá para editar mensagem já enviada.",
    site: "https://business.facebook.com",
    disponivel: true,
  },
];

/* Desconecta a instância — o WhatsApp da imobiliária inteira sai do ar.

   Mesma estratégia da edição de mensagem: os endereços variam por versão, e
   endereço que não existe devolve 404, então dá para tentar em ordem sem
   estrago. O que NÃO se faz aqui é fingir sucesso: se nenhum existir, a tela
   diz que não conseguiu, e o gestor desconecta pelo painel da Uazapi. */
const CAMINHOS_DESCONECTAR = ["/instance/disconnect", "/instance/logout", "/instance/close"];

export async function desconectarInstancia(orgId, canalId = null) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") return oficial.desconectarInstanciaOficial();
  if (!uazapiConfigured(orgId, canalId)) throw new Error("Esta linha não tem WhatsApp conectado.");
  const tentativas = [];
  for (const caminho of CAMINHOS_DESCONECTAR) {
    try {
      const r = await call(orgId, caminho, {}, canalId);
      return { caminho, resposta: String(r.bruto || "").slice(0, 300) };
    } catch (e) {
      tentativas.push({ caminho, erro: e.message.slice(0, 140) });
      if (!/\b404\b/.test(e.message)) throw e;
    }
  }
  throw new Error("Esta conta da Uazapi não tem endereço de desconexão (tentei "
    + CAMINHOS_DESCONECTAR.join(", ") + "). Desconecte pelo painel da Uazapi.");
}

/* A Uazapi devolve o QR Code como base64, às vezes já com o prefixo
   `data:image/png;base64,` e às vezes sem. A tela precisa sempre do prefixo. */
function imagemDoQr(qr) {
  const s = String(qr || "").trim();
  if (!s) return "";
  return s.startsWith("data:") ? s : `data:image/png;base64,${s}`;
}

/* CONECTAR PELO QR CODE, DE DENTRO DO CRM (24/09/2026).

   Até aqui o CRM não tinha tela de QR Code nenhuma: parear o número só era
   possível no painel da própria Uazapi. Quem desconectava pelo CRM ficava
   sem caminho de volta — foi o caso do Alberto, com a sessão travada em
   "session is not reconnectable" e nenhum lugar no CRM para reconectar.

   `forcar` derruba a sessão velha ANTES de pedir o QR novo, e ignora a falha
   dessa derrubada: numa sessão já quebrada, desconectar pode falhar
   justamente porque não há o que desconectar — e isso não pode impedir a
   única saída, que é parear de novo. */
export async function conectarInstancia(orgId, canalId = null, { forcar = false, telefone = "" } = {}) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") throw new Error("A API oficial da Meta não usa QR Code.");
  if (!uazapiConfigured(orgId, canalId)) throw new Error("Cole primeiro o endereço e o token da instância da Uazapi.");
  if (forcar) {
    try { await desconectarInstancia(orgId, canalId); }
    catch (e) { console.warn("[uazapi] reconexão: não consegui derrubar a sessão velha (seguindo assim mesmo):", e.message); }
  }
  const tel = String(telefone || "").replace(/\D/g, "");
  const r = await call(orgId, "/instance/connect", tel ? { phone: tel } : {}, canalId);
  const data = r.data || {};
  const inst = data.instance || {};
  const flags = (data.status && typeof data.status === "object") ? data.status : data;
  const conectado = !!(flags.connected && flags.loggedIn !== false) || String(inst.status || "").toLowerCase() === "connected";
  return {
    conectado,
    qrcode: conectado ? "" : imagemDoQr(inst.qrcode || data.qrcode),
    paircode: conectado ? "" : String(inst.paircode || data.paircode || ""),
  };
}

/* NENHUMA chamada à Uazapi tinha teto de tempo — achado em 24/09/2026, num
   cliente cuja sessão o próprio provedor já descrevia como "session is not
   reconnectable" (confirmado num envio real, que voltou com esse erro na
   hora). Pedir para DESCONECTAR uma sessão nesse estado é o caso em que a API
   remota mais provavelmente está travada por dentro, e um `fetch` sem `signal`
   fica pendurado esperando para sempre — provado num teste com um servidor
   que nunca responde: a requisição fica parada indefinidamente, sem erro e
   sem sucesso, exatamente a cara do relato ("cliquei em Desconectar e
   simplesmente não vai"). É a mesma família de defeito que `services/video.js`
   já documentou para o `ffmpeg`: "melhor um erro claro do que uma espera sem
   fim". 20s é generoso para uma API de WhatsApp responder e curto o bastante
   para o botão nunca ficar preso além disso. */
const TIMEOUT_MS = 20000;

/* O NONO DÍGITO (26/09/2026, print da Vanessa: "the number 5587996695813
   @s.whatsapp.net is not on WhatsApp").

   Todo celular brasileiro ganhou o 9 na frente em 2012–2016, mas o WhatsApp
   NÃO migrou as contas antigas: quem tem WhatsApp desde antes disso,
   sobretudo fora de SP, continua registrado SEM o 9 (55 87 9669-5813). O CRM
   grava sempre COM o 9 (`normalizePhone`), que é o formato certo para a
   pessoa e o que casa as mensagens que chegam. Quando o cliente escreve
   primeiro, a Uazapi acha o contato sozinha; quando o lead nasce digitado na
   mão, portal ou planilha e a imobiliária fala primeiro, ela procura a forma
   com o 9, não acha, e o envio falha.

   Então: recusou por "não tem WhatsApp", tenta a outra forma (sem o 9, ou com
   ele) UMA vez. Deu certo, a forma que funciona fica lembrada para aquele
   número e os próximos envios vão direto. O número gravado no lead não muda —
   é ele que casa a resposta do cliente com a conversa. As duas falharam, o
   erro diz isso em português e manda conferir o número com o cliente. */
const formaQueFunciona = new Map();
const naoTemWhatsapp = (msg) => /not on whatsapp|n[aã]o (est[aá]|possui|tem)[^.]{0,20}whatsapp|not registered|invalid (whatsapp )?number/i.test(String(msg || ""));
export function numeroAlternativo(numero) {
  const d = String(numero || "").replace(/\D/g, "");
  if (/^55\d{2}9\d{8}$/.test(d)) return d.slice(0, 4) + d.slice(5);   // tira o 9
  if (/^55\d{2}[6-9]\d{7}$/.test(d)) return d.slice(0, 4) + "9" + d.slice(4); // põe o 9
  return null;
}
const telLegivel = (d) => {
  d = String(d || "").replace(/\D/g, "");
  return d.length === 13 ? `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`
    : d.length === 12 ? `(${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}` : d;
};

async function call(orgId, path, payload, canalId = null) {
  const numero = payload && payload.number ? String(payload.number) : null;
  if (!numero || !path.startsWith("/send")) return chamar(orgId, path, payload, canalId);
  const conhecida = formaQueFunciona.get(numero);
  const primeiro = conhecida || numero;
  try {
    return await chamar(orgId, path, { ...payload, number: primeiro }, canalId);
  } catch (e) {
    if (!naoTemWhatsapp(e.message)) throw e;
    const outra = numeroAlternativo(primeiro);
    if (!outra) throw new Error(`Este número não está no WhatsApp: ${telLegivel(primeiro)}. Confira o número com o cliente e corrija na ficha.`);
    try {
      const r = await chamar(orgId, path, { ...payload, number: outra }, canalId);
      formaQueFunciona.set(numero, outra);
      console.log(`[uazapi] ${numero.slice(0, 4)}**** respondeu na forma ${outra.length === 12 ? "sem" : "com"} o 9 — lembrado para os próximos envios.`);
      return r;
    } catch (e2) {
      if (!naoTemWhatsapp(e2.message)) throw e2;
      throw new Error(`Este número não está no WhatsApp — conferimos ${telLegivel(primeiro)} e ${telLegivel(outra)}. Confira o número com o cliente e corrija na ficha.`);
    }
  }
}

async function chamar(orgId, path, payload, canalId = null) {
  const { host, token } = credenciais(orgId, canalId);
  if (!host || !token) {
    console.warn(`[uazapi] imobiliária sem WhatsApp conectado — ${path} não foi enviado de verdade.`);
    return { ok: false, simulated: true };
  }
  let res;
  try {
    res = await fetch(`${host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token },
      // track_source identifica no painel da Uazapi o que saiu pelo CRM.
      body: JSON.stringify({ track_source: "con-crm", ...payload }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError")
      throw new Error(`O WhatsApp (Uazapi) não respondeu em ${TIMEOUT_MS / 1000}s — a instância pode estar travada do lado de lá. Tente de novo em alguns minutos ou confira pelo painel da Uazapi.`);
    throw new Error(`Não consegui falar com o WhatsApp (rede): ${e.message}`);
  }
  /* Lê como TEXTO antes de tentar o JSON.
     Com `res.json()` direto, uma resposta que não fosse JSON — página de erro
     em HTML, texto solto — virava objeto vazio e o motivo real da falha
     evaporava. Foi o que aconteceu no 500 do /send/media em 06/08/2026: a
     tela dizia "Uazapi respondeu 500" e ninguém, nem o servidor, sabia o que
     ela tinha dito de verdade. */
  const bruto = await res.text().catch(() => "");
  let data = {};
  try { data = bruto ? JSON.parse(bruto) : {}; } catch { data = {}; }

  if (!res.ok) {
    console.error(`[uazapi] ${path} respondeu ${res.status}:`, bruto.slice(0, 800) || "(corpo vazio)");
    if (res.status === 401) throw new Error("Token da Uazapi inválido ou vencido. Refaça a conexão em Configurações → Conexão.");
    // A Uazapi devolve mensagem em português quando o próprio WhatsApp recusa.
    const explicacao = data.message_ptbr || data.message || data.error;
    if (explicacao) throw new Error(explicacao);
    // Sem mensagem no corpo, vai o que veio — nem que seja "(sem resposta)".
    // Um trecho do corpo cru diz mais do que o número do erro sozinho.
    const trecho = bruto.replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`Uazapi respondeu ${res.status} em ${path}${trecho ? `: ${trecho}` : " sem dizer o motivo (resposta vazia)"}`);
  }
  // O id que o WhatsApp deu à mensagem. É com ele que o webhook de volta é
  // reconhecido como eco do próprio CRM — sem isso, toda mensagem enviada
  // apareceria duas vezes na conversa, E o cliente nunca conseguirá citar
  // esta mensagem depois (o webhook de resposta chega com o id do WhatsApp,
  // e sem `wa_id` guardado aqui não há com o que casar — ver `envioDiagnostico`).
  const messageid = idDaMensagem(data);
  if (!messageid && path.startsWith("/send")) {
    /* NENHUM dos nomes conhecidos apareceu na resposta. Isto não é "erro" —
       a Uazapi respondeu 200 —, é a mesma categoria de falha silenciosa da
       citação: sem guardar a FORMA da resposta (nomes de campo, nunca
       conteúdo), não há como descobrir o nome certo depois. Sobrescreve a
       cada envio de propósito — só a ÚLTIMA tentativa importa aqui. */
    ultimoEnvioSemId = { em: Date.now(), path, campos: Object.keys(data || {}),
      campos_message: Object.keys((data && (data.message || data.data)) || {}) };
  }
  return { ok: true, data, bruto, messageid };
}

// Registro da última vez que a Uazapi respondeu SEM nenhum id reconhecido —
// ver o comentário acima de `idDaMensagem`. Só nomes de campo, nunca conteúdo.
let ultimoEnvioSemId = null;
export const envioSemIdDiagnostico = () => ultimoEnvioSemId;

/* Registro da última tentativa de citação, para o diagnóstico.

   A citação falha CALADA: a Uazapi responde 200 e simplesmente ignora o campo
   que ela não conhece. Sem guardar o que foi enviado e o que voltou, não há
   como descobrir qual é o nome certo do campo nem qual formato de id ela
   espera — e foi exatamente aí que a primeira tentativa parou.

   Guarda só dado técnico: nomes de campo, o id da mensagem e a resposta da
   API. Nada do conteúdo da conversa. */
let ultimaCitacao = null;
export const citacaoDiagnostico = () => ultimaCitacao;

/* Onde vem o id na resposta muda conforme a versão e o tipo de mensagem, e
   nenhum dos caminhos é garantido — por isso a lista, e por isso o resto do
   sistema trata o id como opcional. */
function idDaMensagem(d) {
  const m = (d && (d.message || d.data)) || d || {};
  return d?.messageid || d?.id || m.messageid || m.id || m.key?.id || d?.key?.id || null;
}

/* Editar uma mensagem já enviada.

   Aqui o risco da citação NÃO se repete, e a diferença importa: campo
   desconhecido a Uazapi engole calada, mas endereço que não existe devolve
   404. Ou seja, se esta conta não souber editar, a gente FICA SABENDO — e é
   por isso que a edição no CRM só acontece depois que esta função responde ok.

   Cada provedor batiza o endereço de um jeito, então tentamos os conhecidos em
   ordem, parando no primeiro que não for "não existe". São todos endereços de
   EDIÇÃO: nenhum deles manda mensagem nova se estiver errado — no pior caso
   responde 404 e seguimos para o próximo. */
const CAMINHOS_EDICAO = ["/message/edit", "/send/edit", "/message/update"];

let ultimaEdicao = null;
export const edicaoDiagnostico = () => ultimaEdicao;

export async function editMessage({ orgId, canalId = null, messageid, text }) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") return oficial.editMessage();
  if (!uazapiConfigured(orgId, canalId)) return { ok: false, simulated: true };
  const tentativas = [];

  for (const caminho of CAMINHOS_EDICAO) {
    try {
      // `id` e `text` são os nomes mais comuns; os apelidos vão junto porque
      // campo a mais é ignorado, como esta conta já demonstrou.
      const r = await call(orgId, caminho, { id: messageid, messageid, text, newText: text, message: text }, canalId);
      ultimaEdicao = { quando: new Date().toISOString(), caminho, status: "aceito", tentativas,
        resposta: String(r.bruto || "").slice(0, 400) };
      return { ok: true, caminho, data: r.data };
    } catch (e) {
      tentativas.push({ caminho, erro: e.message.slice(0, 160) });
      // 404 = este endereço não existe nesta conta; tenta o próximo.
      // Qualquer outro erro é resposta de verdade e vale parar: insistir só
      // repetiria a mesma recusa em endereços diferentes.
      if (!/\b404\b/.test(e.message)) {
        ultimaEdicao = { quando: new Date().toISOString(), caminho, status: "recusado", tentativas, resposta: e.message.slice(0, 400) };
        throw e;
      }
    }
  }

  ultimaEdicao = { quando: new Date().toISOString(), status: "sem endereço de edição", tentativas };
  throw new Error("Esta conta da Uazapi não tem como editar mensagem enviada (nenhum dos endereços conhecidos existe).");
}

/* A ASSINATURA EXISTE POR CAUSA DO NÚMERO ÚNICO — e some quando ele não é único.

   `*Marina:*` na frente da mensagem nasceu de uma necessidade só: todo mundo
   fala pelo mesmo WhatsApp, e sem o nome o lead não sabe com quem está
   falando. Numa linha PESSOAL isso deixa de ser verdade e passa a ser
   estranho: o cliente salvou o número da Marina, está conversando com a
   Marina, e recebe "*Marina:* oi" — que é a pessoa se anunciando na própria
   casa.

   A decisão fica AQUI, e não em cada lugar que envia, porque são cinco pontos
   de envio hoje e o sexto que alguém escrever depois. O esquecido não daria
   erro nenhum: só mandaria uma mensagem esquisita para o cliente, e ninguém
   de dentro veria. */
function assinar(text, signedBy, canal) {
  if (!signedBy) return text;
  if (canal && canal.tipo === "corretor") return text;
  return `*${signedBy}:*\n${text}`;
}

/* Texto, com citação opcional.

   `replyTo` é o id da mensagem citada NO WHATSAPP. Quando ele vai junto, o
   cliente vê a citação de verdade no aplicativo dele, igual ao Responder do
   WhatsApp.

   Se a conta não aceitar o campo, não travamos o envio: a mensagem sai com o
   trecho citado escrito em cima. Fica mais feio, mas o cliente continua
   sabendo do que se está falando — e o corretor não perde a mensagem por
   causa de um recurso que a API não tem. */
export async function sendText({ orgId, canalId = null, toPhone, text, signedBy, replyTo, quotedText }) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") return oficial.sendText({ canal: canalAlvo, toPhone, text, signedBy, replyTo });

  const assinado = assinar(text, signedBy, credenciais(orgId, canalId).canal);
  if (!replyTo) return call(orgId, "/send/text", { number: toPhone, text: assinado }, canalId);

  /* Vários nomes para o mesmo campo, na mesma requisição.

     Cada provedor batiza a citação de um jeito, e esta conta aceitou o envio
     com `replyid` sem reclamar — mas sem citar nada, o que prova que ela
     ignora campo que não conhece em vez de recusar. Como ignora, mandar os
     apelidos conhecidos juntos não quebra nada: o que ela entender, ela usa.

     Não é elegante, e o certo é ler a documentação da conta. É o melhor que
     dá para fazer sem ela, e o diagnóstico abaixo mostra o que voltou. */
  const apelidos = {
    replyid: replyTo,
    quotedMessageId: replyTo,
    quotedMsgId: replyTo,
    replyMessageId: replyTo,
    reply_to: replyTo,
  };

  try {
    const r = await call(orgId, "/send/text", { number: toPhone, text: assinado, ...apelidos }, canalId);
    ultimaCitacao = {
      quando: new Date().toISOString(),
      id_citado: replyTo,
      campos_enviados: Object.keys(apelidos),
      status: "aceito (200)",
      resposta: String(r.bruto || "").slice(0, 500),
      atencao: "Se a citação não apareceu no WhatsApp, a Uazapi aceitou e ignorou os campos — o nome certo está na documentação da conta.",
    };
    return r;
  } catch (e) {
    console.warn(`[uazapi] citação recusada (${e.message}); reenviando com o trecho escrito.`);
    ultimaCitacao = {
      quando: new Date().toISOString(),
      id_citado: replyTo,
      campos_enviados: Object.keys(apelidos),
      status: "recusado",
      resposta: e.message.slice(0, 500),
      atencao: "A mensagem foi reenviada com o trecho citado escrito no texto.",
    };
    const trecho = String(quotedText || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const citacao = trecho ? `> ${trecho}\n\n` : "";
    return call(orgId, "/send/text", { number: toPhone, text: citacao + assinado }, canalId);
  }
}

// type: image | video | audio | ptt | document. `file` aceita URL pública ou base64.
/* Manda mídia. `file` é uma URL pública OU o arquivo em base64.

   A URL é o caminho normal e o mais barato: a Uazapi baixa o arquivo sozinha.
   Só que isso põe o envio na dependência de a URL estar alcançável DE FORA —
   e ela deixa de estar por motivos que nada têm a ver com o WhatsApp: domínio
   fora do ar, APP_URL apontando para o endereço errado, bucket do R2 sem
   acesso público. Foi o que aconteceu em 06/08/2026: texto saindo normal e
   toda foto e vídeo falhando com "Falha ao enviar pelo WhatsApp".

   Por isso o `bytes`: se a URL falhar, o arquivo vai embutido na requisição.
   Fica mais pesado, mas não depende de ninguém conseguir abrir um endereço.
   `bytes` pode ser o Buffer ou uma função que devolve o Buffer — assim o
   arquivo só é lido do disco/R2 se a primeira tentativa falhar. */
export async function sendMedia({ orgId, canalId = null, toPhone, type, file, caption, signedBy, docName, bytes, mime }) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") return oficial.sendMedia({ canal: canalAlvo, toPhone, type, caption, signedBy, docName, bytes, mime });

  const canal = credenciais(orgId, canalId).canal;
  const corpo = (arquivo) => ({
    number: toPhone, type, file: arquivo,
    ...(caption ? { text: assinar(caption, signedBy, canal) } : {}),
    ...(docName ? { docName } : {}),
  });

  try {
    return await call(orgId, "/send/media", corpo(file), canalId);
  } catch (e) {
    if (!bytes) throw e;
    let buffer;
    try { buffer = typeof bytes === "function" ? await bytes() : bytes; }
    catch (lendo) { throw new Error(`${e.message} (e não consegui reler o arquivo: ${lendo.message})`); }
    if (!buffer || !buffer.length) throw e;

    console.warn(`[uazapi] a URL falhou (${e.message}); reenviando o arquivo embutido.`);
    try {
      return await call(orgId, "/send/media", corpo(`data:${mime || "application/octet-stream"};base64,${buffer.toString("base64")}`), canalId);
    } catch (e2) {
      throw new Error(`${e.message} — e o envio direto do arquivo também falhou: ${e2.message}`);
    }
  }
}

export function sendLocation({ orgId, canalId = null, toPhone, latitude, longitude, name, address }) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") return oficial.sendLocation({ canal: canalAlvo, toPhone, latitude, longitude, name, address });
  return call(orgId, "/send/location", { number: toPhone, latitude, longitude, name, address }, canalId);
}

// Estado da instância — usado pelo diagnóstico, para conferir a conexão sem expor o token.
// Reporta endereço e token separadamente: "não configurado" sozinho não diz qual faltou.
export async function instanceStatus(orgId, canalId = null) {
  const canalAlvo = resolverCanalDoEnvio(orgId, canalId);
  if (canalAlvo?.provider === "meta") return oficial.instanceStatus(canalAlvo);

  const { host, token } = credenciais(orgId, canalId);
  if (!host || !token) {
    return {
      configurado: false,
      endereco: host ? `definido (${host})` : "FALTANDO",
      token: token ? `definido (${token.length} caracteres)` : "FALTANDO",
      dica: "Esta imobiliária ainda não conectou um WhatsApp. Siga o tutorial da Uazapi aqui na tela e cole o endereço e o token da instância DELA — nunca os de outra imobiliária.",
    };
  }
  try {
    const res = await fetch(`${host}/instance/status`, { headers: { token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configurado: true, ok: false, erro: data.message || `HTTP ${res.status}` };
    const inst = data.instance || data;
    const status = String(inst.status || (typeof data.status === "string" ? data.status : "") || "desconhecido");
    /* `ok` diz só que a Uazapi RESPONDEU — não que o WhatsApp está pareado.
       A tela usava `ok` para pintar "WhatsApp conectado", e por isso uma
       instância desconectada (ou recém-desconectada pelo botão) continuava
       aparecendo como conectada (24/09/2026). `conectado` é a resposta de
       verdade; `null` quando a Uazapi não diz, e aí a tela cai no `ok`. */
    const flags = (data.status && typeof data.status === "object") ? data.status : {};
    let conectado = null;
    if (typeof flags.connected === "boolean") conectado = flags.connected && flags.loggedIn !== false;
    else if (status !== "desconhecido") conectado = ["connected", "open", "online"].includes(status.toLowerCase());
    return {
      configurado: true, ok: true, conectado, status,
      numero: mascarar(inst.owner || inst.number || ""),
      nome: inst.profileName || inst.name || "",
      qrcode: conectado ? "" : imagemDoQr(inst.qrcode || data.qrcode),
      paircode: conectado ? "" : String(inst.paircode || data.paircode || ""),
    };
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError")
      return { configurado: true, ok: false, erro: `A instância não respondeu em ${TIMEOUT_MS / 1000}s (pode estar travada do lado da Uazapi).` };
    return { configurado: true, ok: false, erro: e.message };
  }
}

// Mostra só o suficiente para conferir que é o número certo: 5587****6848
const mascarar = (n) => {
  const d = String(n).replace(/\D/g, "");
  return d.length < 8 ? d : d.slice(0, 4) + "*".repeat(d.length - 8) + d.slice(-4);
};
