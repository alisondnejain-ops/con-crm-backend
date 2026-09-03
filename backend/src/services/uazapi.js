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

async function call(orgId, path, payload, canalId = null) {
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
    });
  } catch (e) {
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
  // apareceria duas vezes na conversa.
  return { ok: true, data, bruto, messageid: idDaMensagem(data) };
}

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
    const res = await fetch(`${host}/instance/status`, { headers: { token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configurado: true, ok: false, erro: data.message || `HTTP ${res.status}` };
    const inst = data.instance || data;
    return {
      configurado: true, ok: true,
      status: inst.status || data.status || "desconhecido",
      numero: mascarar(inst.owner || inst.number || ""),
      nome: inst.profileName || inst.name || "",
    };
  } catch (e) {
    return { configurado: true, ok: false, erro: e.message };
  }
}

// Mostra só o suficiente para conferir que é o número certo: 5587****6848
const mascarar = (n) => {
  const d = String(n).replace(/\D/g, "");
  return d.length < 8 ? d : d.slice(0, 4) + "*".repeat(d.length - 8) + d.slice(-4);
};
