/* AS LINHAS DE WHATSAPP DA IMOBILIÁRIA.

   O CRM nasceu com uma regra que atravessava tudo: **um número só**. Todo
   mundo atendia pelo WhatsApp da casa, e por isso toda mensagem que saía era
   assinada com o nome de quem escreveu (`*Marina:*`) — sem a assinatura o lead
   não teria como saber com quem estava falando.

   O corretor agora pode ligar o WhatsApp DELE. O que NÃO muda, e é o pedido
   inteiro numa frase: **ele continua falando pelo CRM**. A linha muda; o lugar
   onde a conversa acontece, não. Se a conversa saísse do CRM, o atendimento
   pararia de ser medido, o repasse pararia de existir e o histórico do cliente
   ficaria no celular de uma pessoa — que é o problema que este sistema foi
   feito para resolver.

   ===== O QUE É UM CANAL =====

   Uma linha por lugar de onde a mensagem sai e para onde ela chega:

     tipo 'imobiliaria'  — o número da casa. Existe uma por imobiliária, e é a
                           que o gestor conecta. Continua sendo o padrão de
                           tudo: lead novo, catraca, robô, assinatura.
     tipo 'corretor'     — o número pessoal, ligado pelo próprio corretor na
                           tela dele. Uma por pessoa.

   ===== POR QUE A LINHA DA CASA CONTINUA EM `orgs.uazapi_*` =====

   Porque há código demais lendo aquelas duas colunas, e trocar tudo de uma vez
   seria reescrever o envio, o webhook, o diagnóstico e o robô num commit só,
   com a operação da Conecta rodando em cima. É a mesma decisão de `leads.stage`
   continuar sendo escrito ao lado de `stage_id`.

   O preço da duplicação é o par poder se desencontrar. Ele se paga num lugar
   só: NADA fora deste arquivo escreve `orgs.uazapi_host/uazapi_token`, e toda
   escrita aqui é uma transação que mexe nos dois. */

import db from "../db.js";
import { randomUUID } from "crypto";

export const TIPOS = ["imobiliaria", "corretor"];

const limpaHost = (h) => String(h || "").trim().replace(/\/$/, "");

export const canalPorId = (id) => id ? db.prepare("SELECT * FROM canais WHERE id = ?").get(id) : null;

export function canalDaCasa(orgId) {
  return db.prepare("SELECT * FROM canais WHERE org_id = ? AND tipo = 'imobiliaria' LIMIT 1").get(orgId) || null;
}

export function canalDoUsuario(orgId, userId) {
  if (!userId) return null;
  return db.prepare("SELECT * FROM canais WHERE org_id = ? AND user_id = ? LIMIT 1").get(orgId, userId) || null;
}

export function canaisDaOrg(orgId) {
  return db.prepare(`SELECT c.*, u.name AS pessoa FROM canais c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.org_id = ? ORDER BY (c.tipo <> 'imobiliaria'), u.name`).all(orgId);
}

/* Quantas linhas estão LIGADAS (com token) — é o número que vira dinheiro.

   Canal criado e vazio não conta: o corretor abre a tela, o registro nasce e
   ele só cola o token depois. Cobrar por uma linha que nunca pareou seria
   cobrar por uma tela aberta. */
export function ligados(orgId) {
  return db.prepare("SELECT COUNT(*) n FROM canais WHERE org_id = ? AND ativo = 1 AND token IS NOT NULL AND token <> ''")
    .get(orgId).n;
}

/* O TETO, e por que ele é do plano e não uma conta que se faz aqui.

   O plano vendido hoje é "até 10 corretores", que em linhas são 11 (a da casa
   mais dez pessoais). O teto mora em `orgs.limite_canais` porque o dia em que
   existir um plano de 25 a regra não pode ser um número escrito no meio de uma
   função. E ele é TETO, não contratação: cada linha ligada é cobrada à parte. */
export function limites(orgId) {
  /* Realinha a linha da casa antes de contar. É uma escrita dentro de uma
     leitura, e vale a troca: `usados` vira dinheiro, e a linha da casa
     desencontrada de `orgs.uazapi_*` faria a conta dizer que a imobiliária tem
     um número a menos do que tem. Só escreve quando está fora do lugar. */
  garantirCasa(orgId);
  const o = db.prepare("SELECT limite_canais, canais_incluidos, valor_canal FROM orgs WHERE id = ?").get(orgId) || {};
  const limite = Number.isFinite(o.limite_canais) ? o.limite_canais : 11;
  const incluidos = Number.isFinite(o.canais_incluidos) ? o.canais_incluidos : 1;
  const usados = ligados(orgId);
  return {
    limite, incluidos,
    valor_canal: o.valor_canal ?? null,
    usados,
    /* Quantas linhas ligadas passam do que a mensalidade já cobre. É este
       número, e não `usados`, que multiplica o valor: a linha da casa já vinha
       com o plano antes de isto existir, e passar a cobrá-la seria aumentar o
       preço de quem já é cliente sem ninguém ter combinado. */
    cobrados: Math.max(0, usados - incluidos),
    restantes: Math.max(0, limite - usados),
    /* O QUE ISSO CUSTA POR MÊS, já calculado.

       A conta é uma multiplicação, e é justamente por isso que ela mora aqui e
       não em cada tela: repetida no painel do gestor, no hub do ConHub e na
       fatura, seriam três contas que um dia divergem — e divergência em conta
       de dinheiro o cliente descobre antes de nós.

       Nulo quando o ConHub ainda não definiu o preço por linha. Nulo é
       "não sei", e a tela escreve isso: mostrar R$ 0,00 para um preço não
       combinado seria prometer de graça o que vai ser cobrado. */
    valor_extra: o.valor_canal != null ? Math.max(0, usados - incluidos) * Number(o.valor_canal) : null,
  };
}

/* Grava a conexão de um canal. Token vazio DESLIGA a linha (não apaga).

   Desligar e apagar são coisas diferentes, e a diferença é a conversa: linha
   apagada deixaria os leads dela apontando para um canal que não existe, e o
   CRM não saberia mais por onde aquele atendimento aconteceu. Desligar para de
   enviar e para de cobrar; o histórico fica de pé. */
export function salvarConexao(canalId, { host, token, waNumber = null, quem = null }) {
  const c = canalPorId(canalId);
  if (!c) throw new Error("Canal não encontrado.");
  const h = limpaHost(host) || null;
  const t = String(token || "").trim() || null;

  const gravar = db.transaction(() => {
    db.prepare(`UPDATE canais SET host = ?, token = ?, wa_number = COALESCE(?, wa_number),
      conectado_em = CASE WHEN ? IS NULL THEN NULL ELSE ? END WHERE id = ?`)
      .run(h, t, waNumber, t, Date.now(), canalId);
    // O PAR. A linha da casa é lida por `orgs.uazapi_*` em dezenas de lugares
    // que ainda não sabem que canais existem — e é aqui, e só aqui, que os dois
    // andam juntos.
    if (c.tipo === "imobiliaria")
      db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ? WHERE id = ?").run(h, t, c.org_id);
  });
  gravar();
  console.log(`[canais] ${c.tipo === "imobiliaria" ? "linha da casa" : "linha de " + (c.nome || c.user_id)} ${t ? "conectada" : "desconectada"}`);
  return canalPorId(canalId);
}

/* Cria (ou devolve) a linha de uma pessoa.

   O TETO É CONFERIDO NA CRIAÇÃO E DE NOVO NA CONEXÃO. Não é zelo repetido: o
   registro nasce vazio e só vira linha paga quando o token entra, e entre uma
   coisa e outra o gestor pode ter mudado o plano. Conferir só na criação
   deixaria passar a décima segunda linha de quem abriu a tela antes. */
export function criarCanalDoCorretor(orgId, userId, { quem = null } = {}) {
  const existente = canalDoUsuario(orgId, userId);
  if (existente) return { canal: existente };

  const u = db.prepare("SELECT id, name, role, status FROM users WHERE id = ? AND org_id = ?").get(userId, orgId);
  if (!u) return { erro: "Pessoa não encontrada nesta imobiliária." };
  if (u.status !== "ativo") return { erro: "Essa conta não está ativa." };

  const l = limites(orgId);
  // Conta os registros, não os ligados: dez telas abertas e nenhuma pareada
  // ainda são dez pessoas prestes a ligar, e recusar depois de o corretor ter
  // pedido o token à Uazapi é pior do que recusar antes.
  const registrados = db.prepare("SELECT COUNT(*) n FROM canais WHERE org_id = ? AND ativo = 1").get(orgId).n;
  if (registrados >= l.limite)
    return { erro: `O plano desta imobiliária permite ${l.limite} número(s) de WhatsApp, e todos já estão em uso. Fale com o ConHub para aumentar o limite.` };

  const id = "cn_" + randomUUID();
  db.prepare(`INSERT INTO canais (id,org_id,tipo,user_id,nome,ativo,criado_por,created_at)
    VALUES (?,?,'corretor',?,?,1,?,?)`).run(id, orgId, userId, u.name, quem, Date.now());
  return { canal: canalPorId(id) };
}

/* Desliga a linha de alguém e devolve as conversas dela para a linha da casa.

   O segundo passo é o que não pode faltar. Um lead apontando para uma linha
   desligada é um lead ao qual ninguém consegue responder — o envio sairia sem
   credencial e falharia, e a tela diria "falha ao enviar" sem dizer por quê.
   Voltando para a casa, a conversa continua: é o número que a imobiliária
   sempre teve. */
export function desligarCanal(canalId) {
  const c = canalPorId(canalId);
  if (!c) return { erro: "Canal não encontrado." };
  if (c.tipo === "imobiliaria")
    return { erro: "A linha da imobiliária se desconecta em Configurações → Conexão." };

  const rodar = db.transaction(() => {
    /* O índice único de `phone_number_id` não olha `ativo` — igual ao de
       `token` da Uazapi. Sem limpar aqui, um número desligado ficaria
       "ocupado" para sempre, e reconectar o mesmo número (ou religar a linha)
       esbarraria numa constraint que ninguém entenderia olhando a tela. */
    if (c.provider === "meta")
      db.prepare("UPDATE canais SET token = NULL, phone_number_id = NULL, conectado_em = NULL WHERE id = ?").run(canalId);
    else
      salvarConexao(canalId, { host: c.host, token: null });
    db.prepare("UPDATE canais SET ativo = 0 WHERE id = ?").run(canalId);
    const n = db.prepare("UPDATE leads SET canal_id = NULL WHERE canal_id = ?").run(canalId).changes;
    return n;
  });
  const devolvidos = rodar();
  console.log(`[canais] linha de ${c.nome} desligada — ${devolvidos} conversa(s) voltaram para o número da imobiliária`);
  return { ok: true, devolvidos };
}

/* DE QUEM É a mensagem que chegou.

   O webhook é um endereço só para a plataforma inteira, e a Uazapi manda junto
   o token da instância. Ele identifica o canal, e o canal identifica a
   imobiliária.

   O CHUTE DE ANTES SAIU DE PROPÓSITO. A versão anterior tinha um consolo: "se
   só existe uma imobiliária conectada, é dela". Aquilo servia enquanto cada
   casa tinha um número; com várias linhas por casa ele passa a acertar por
   acaso e a errar em silêncio — e errar aqui é o pior erro do sistema, porque
   põe a conversa de um cliente na caixa de outra pessoa. Agora, não sabendo, a
   mensagem não entra e o diagnóstico diz o que chegou. */
export function canalDoWhatsapp({ token, numero }) {
  const t = String(token || "").trim();
  if (t) {
    const por = db.prepare("SELECT * FROM canais WHERE token = ? AND ativo = 1").get(t);
    if (por) return por;
  }
  /* A REDE DE SEGURANÇA DA LINHA DA CASA.

     Se o token bate com `orgs.uazapi_token` mas não existe canal, a linha da
     casa é criada AGORA e a mensagem entra. Parece zelo repetido — a migração
     do start já faz isso — e não é: entre um start e outro nascem imobiliárias,
     e uma org criada pelo hub depois do boot ficaria sem canal até o próximo
     restart. O sintoma seria o pior deste sistema inteiro: **para de entrar
     lead**, com o servidor de pé, a tela abrindo e nenhum erro em lugar
     nenhum. Já aconteceu uma vez, por outro motivo, e é o que a regra do
     `app.use` com caminho explícito existe para impedir.

     Aqui a cura é barata e o estrago é caro, então ela fica. */
  if (t) {
    const org = db.prepare("SELECT id, name FROM orgs WHERE uazapi_token = ?").get(t);
    if (org) return garantirCasa(org.id);
  }

  /* ===== O RECONHECIMENTO PELO NÚMERO SAIU DO PADRÃO (02/09/2026) =====

     Este era o furo mais sério da auditoria, e o mais fácil de explorar.

     Quando o token não batia, o webhook aceitava identificar a imobiliária
     pelos ÚLTIMOS OITO DÍGITOS do WhatsApp dela. Só que o WhatsApp de uma
     imobiliária é **informação pública** — está no site, no anúncio, na
     fachada. Ou seja, qualquer pessoa da internet podia mandar um POST para
     `/webhooks/uazapi` dizendo `{ owner: "8799991234", message: {...} }` e:

       - criar leads falsos na conta daquela imobiliária;
       - ESCREVER na conversa de um cliente real, se soubesse o telefone dele
         (e o histórico do CRM é o registro do atendimento, é o que sustenta a
         cobrança em reunião);
       - e, com o atendimento automático ligado, fazer a IA da imobiliária
         MANDAR UMA MENSAGEM DE WHATSAPP para um número escolhido pelo
         atacante, assinada com o nome dela.

     Pior: um token ERRADO caía aqui também. A conferência do token acontecia
     antes, mas não recusava — ela só "não achava", e a execução seguia para o
     número. Uma trava que não recusa não é uma trava.

     Agora o token é o único caminho, e ele é um segredo de verdade (é a
     credencial da instância na Uazapi). O reconhecimento pelo número continua
     existindo como SAÍDA DE EMERGÊNCIA, atrás de `UAZAPI_ACEITAR_POR_NUMERO=1`,
     porque a falha que este projeto mais teme é "parou de entrar lead" — se
     algum dia a Uazapi mandar um payload sem token, dá para religar em trinta
     segundos no painel da hospedagem, sem publicar nada.

     E a recusa NÃO é silenciosa: ela aparece em `/integracoes/webhooks` com o
     que fazer escrito. É a diferença entre "o lead sumiu" e "o lead foi
     recusado, e o motivo está na tela". */
  if (numero && process.env.UAZAPI_ACEITAR_POR_NUMERO === "1") {
    const so = String(numero).replace(/\D/g, "");
    if (so.length >= 8) {
      const por = db.prepare(`SELECT * FROM canais WHERE ativo = 1 AND token IS NOT NULL
        AND REPLACE(REPLACE(REPLACE(REPLACE(wa_number,'+',''),'-',''),' ',''),'(','') LIKE ?`).get(`%${so.slice(-8)}%`);
      if (por) { console.warn("[canais] linha reconhecida pelo NÚMERO (modo de emergência ligado) — o token não bateu"); return por; }
      const org = db.prepare(`SELECT id FROM orgs WHERE
        REPLACE(REPLACE(REPLACE(REPLACE(wa_number,'+',''),'-',''),' ',''),'(','') LIKE ?`).get(`%${so.slice(-8)}%`);
      if (org) { console.warn("[canais] imobiliária reconhecida pelo NÚMERO (modo de emergência ligado)"); return garantirCasa(org.id); }
    }
  }
  return null;
}

/* ===== CONEXÃO OFICIAL (META) — 03/09/2026 =====

   Na Uazapi cada linha é dona da própria credencial (host+token — é o par que
   `salvarConexao` grava). Na API oficial da Meta o TOKEN, o APP SECRET, o
   WABA ID e o VERIFY TOKEN são do "aplicativo" que o gestor criou na Meta —
   são os MESMOS em toda linha da imobiliária, casa e corretores. O que muda
   de linha para linha é só o `phone_number_id`, que a Meta atribui a cada
   número registrado.

   Por isso esta função tem dois caminhos, e não é o mesmo para os dois tipos:

   - Na linha da CASA, ela GRAVA as credenciais do WABA e as REPETE em toda
     linha pessoal já ligada da mesma imobiliária — copiar aqui é a mesma
     decisão de `orgs.uazapi_*` ao lado de `canais`: cada linha responde
     sozinha, sem JOIN, e o preço da cópia se paga NUM lugar só.
   - Na linha de um CORRETOR, ela recebe só o `phoneNumberId` dele e busca o
     resto na linha da casa — o corretor nunca vê nem digita o token que fala
     em nome da imobiliária inteira, do mesmo jeito que ele nunca via o token
     da Uazapi da casa. */
export function salvarConexaoOficial(canalId, { phoneNumberId, wabaId, token, appSecret, verifyToken, waNumber = null } = {}) {
  const c = canalPorId(canalId);
  if (!c) throw new Error("Canal não encontrado.");

  let waba = wabaId, tok = token, secret = appSecret, verify = verifyToken;

  if (c.tipo === "corretor") {
    const casa = canalDaCasa(c.org_id);
    if (!casa || casa.provider !== "meta" || !casa.token)
      throw new Error("A imobiliária ainda não conectou a API oficial da Meta. Isso é feito pelo gestor, em Configurações → Conexão.");
    waba = casa.waba_id; tok = casa.token; secret = casa.app_secret; verify = casa.verify_token;
  } else {
    if (!waba || !tok || !secret)
      throw new Error("Faltam dados da conexão com a Meta (WABA ID, token ou app secret).");
    /* Reaproveita o verify_token que JÁ EXISTE na linha, e só gera um novo se
       não houver nenhum. Gerar de novo a cada troca de token/app secret
       derrubaria um webhook que a Meta já validou: a Meta só confere o
       verify_token na hora da verificação (o GET com hub.challenge) — não a
       cada mensagem — e trocá-lo por baixo faria a PRÓXIMA reverificação
       (o gestor mexendo no app, por exemplo) falhar sem ele ter mudado nada
       na tela do ConHub. */
    if (!verify) verify = c.verify_token || gerarVerifyToken();
  }

  const pnid = String(phoneNumberId || "").trim() || null;

  const gravar = db.transaction(() => {
    db.prepare(`UPDATE canais SET provider = 'meta', phone_number_id = ?, waba_id = ?, token = ?,
      app_secret = ?, verify_token = ?, host = NULL, wa_number = COALESCE(?, wa_number),
      conectado_em = CASE WHEN ? IS NULL THEN NULL ELSE ? END WHERE id = ?`)
      .run(pnid, waba, tok, secret, verify, waNumber, pnid, Date.now(), canalId);

    if (c.tipo === "imobiliaria")
      db.prepare(`UPDATE canais SET waba_id = ?, token = ?, app_secret = ?, verify_token = ?
        WHERE org_id = ? AND tipo = 'corretor' AND provider = 'meta'`).run(waba, tok, secret, verify, c.org_id);
  });
  gravar();
  console.log(`[canais] ${c.tipo === "imobiliaria" ? "linha da casa" : "linha de " + (c.nome || c.user_id)} conectada à API oficial da Meta`);
  return canalPorId(canalId);
}

// A linha que aquele número da Meta (`phone_number_id`) representa — é assim
// que o webhook oficial identifica de quem é a mensagem que chegou.
export function canalPorPhoneNumberId(phoneNumberId) {
  const id = String(phoneNumberId || "").trim();
  if (!id) return null;
  return db.prepare("SELECT * FROM canais WHERE phone_number_id = ? AND ativo = 1").get(id) || null;
}

// Gerado uma vez, na primeira conexão da casa, e colado na tela de
// configuração do webhook lá na Meta — é o que prova que a chamada de
// verificação (`hub.verify_token`) veio de quem configurou, e não de um chute.
export function gerarVerifyToken() {
  return "vt_" + randomUUID().replace(/-/g, "");
}

/* O verificador da casa, pronto ANTES de a Meta pedir credencial nenhuma.

   A ordem real de quem configura é: primeiro cola a URL do webhook e um
   verify_token NA TELA DA META — e só depois (ou antes, tanto faz) preenche
   token/app secret/WABA aqui. Se o token só nascesse dentro de
   `salvarConexaoOficial`, o gestor não teria o que colar na Meta até ter
   terminado de preencher tudo, e a verificação do lado de lá aconteceria às
   cegas. Por isso a tela de conexão pode chamar isto a qualquer momento —
   inclusive antes de qualquer dado da Meta existir — e sempre recebe um
   token estável (gerado uma vez, guardado, nunca trocado sozinho). */
export function verificadorDaCasa(orgId) {
  const casa = garantirCasa(orgId);
  if (!casa) return null;
  if (casa.verify_token) return casa.verify_token;
  const vt = gerarVerifyToken();
  db.prepare("UPDATE canais SET verify_token = ? WHERE id = ?").run(vt, casa.id);
  return vt;
}

/* A linha da casa desta imobiliária, criada agora se ainda não existir e sempre
   alinhada com `orgs.uazapi_*`. É a função que impede o pior desfecho: uma
   imobiliária criada entre dois starts ficaria sem canal e PARARIA DE RECEBER
   LEAD, com o servidor de pé e nenhum erro em lugar nenhum. */
export function garantirCasa(orgId) {
  const o = db.prepare("SELECT id, name, uazapi_host, uazapi_token, wa_number FROM orgs WHERE id = ?").get(orgId);
  if (!o) return null;
  const casa = canalDaCasa(orgId);
  if (casa) {
    /* O realinhamento com `orgs.uazapi_*` só vale para uma linha Uazapi —
       são exatamente as duas colunas que `salvarConexao` mantém em par. Numa
       linha oficial da Meta, `orgs.uazapi_token` fica para sempre vazio (a
       Meta não escreve ali; ver `salvarConexaoOficial`), e sincronizar aqui
       apagaria o token de verdade a cada leitura — foi o bug real que
       apareceu ao testar isto: conectar a Meta funcionava, e a PRÓXIMA
       leitura de status (que passa por aqui) devolvia a linha desconectada,
       sem erro nenhum aparecer. */
    if (casa.provider !== "meta" &&
        ((casa.token || null) !== (o.uazapi_token || null) || (casa.host || null) !== (o.uazapi_host || null)))
      db.prepare("UPDATE canais SET host = ?, token = ? WHERE id = ?").run(o.uazapi_host || null, o.uazapi_token || null, casa.id);
    if (!casa.wa_number && o.wa_number)
      db.prepare("UPDATE canais SET wa_number = ? WHERE id = ?").run(o.wa_number, casa.id);
    return canalPorId(casa.id);
  }
  const id = "cn_" + randomUUID();
  db.prepare(`INSERT INTO canais (id,org_id,tipo,user_id,nome,host,token,wa_number,ativo,created_at,conectado_em)
    VALUES (?,?,'imobiliaria',NULL,?,?,?,?,1,?,?)`)
    .run(id, orgId, `WhatsApp de ${o.name}`, o.uazapi_host || null, o.uazapi_token || null, o.wa_number || null,
         Date.now(), o.uazapi_token ? Date.now() : null);
  console.log(`[canais] linha da casa de ${o.name} criada na hora, a partir da conexão que já existia`);
  return canalPorId(id);
}

/* A linha por onde ESTE lead está falando agora.

   `leads.canal_id` nulo é a linha da casa — que é o que toda conversa que já
   existe é, sem precisar de migração de dados. Linha desligada também cai para
   a casa: é isso ou uma mensagem que não sai. */
export function canalDoLead(lead) {
  if (!lead) return null;
  if (lead.canal_id) {
    const c = canalPorId(lead.canal_id);
    if (c && c.ativo && c.token) return c;
  }
  return canalDaCasa(lead.org_id);
}

/* Migração invisível, a cada start.

   Toda imobiliária ganha a linha da casa com exatamente a conexão que ela já
   usava. Idempotente: reiniciar o servidor dez vezes faz o trabalho uma. */
export function migrarCanais() {
  let criados = 0;
  for (const { id } of db.prepare("SELECT id FROM orgs").all()) {
    const antes = canalDaCasa(id);
    garantirCasa(id);
    if (!antes) criados++;
  }
  if (criados) console.log(`[canais] ${criados} linha(s) da casa criadas a partir da conexão que já existia`);
  return { criados };
}
