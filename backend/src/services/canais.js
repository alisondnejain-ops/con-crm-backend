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

  if (numero) {
    const so = String(numero).replace(/\D/g, "");
    if (so.length >= 8) {
      const por = db.prepare(`SELECT * FROM canais WHERE ativo = 1 AND token IS NOT NULL
        AND REPLACE(REPLACE(REPLACE(REPLACE(wa_number,'+',''),'-',''),' ',''),'(','') LIKE ?`).get(`%${so.slice(-8)}%`);
      if (por) return por;
      // Mesma rede de segurança, pelo número que a imobiliária cadastrou.
      const org = db.prepare(`SELECT id FROM orgs WHERE
        REPLACE(REPLACE(REPLACE(REPLACE(wa_number,'+',''),'-',''),' ',''),'(','') LIKE ?`).get(`%${so.slice(-8)}%`);
      if (org) return garantirCasa(org.id);
    }
  }
  return null;
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
    if ((casa.token || null) !== (o.uazapi_token || null) || (casa.host || null) !== (o.uazapi_host || null))
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
