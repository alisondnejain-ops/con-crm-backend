/* CÓPIA DE SEGURANÇA DIÁRIA DO BANCO (27/08/2026, pedido do Ali).

   O banco é UM ARQUIVO no volume da hospedagem, e até aqui não havia cópia
   nenhuma — nem no código nem no DEPLOY.md. Perder o volume era perder a base
   de leads de todos os clientes de uma vez, sem volta. É um risco de outra
   natureza do "está lento": lentidão avisa antes, disco perdido não avisa nada.

   AS QUATRO REGRAS

   1. VAI PARA FORA DO SERVIDOR, ou não vai. Cópia gravada no disco da
      hospedagem fica no MESMO volume do banco que ela deveria proteger — some
      junto, e pior: dá a impressão de que existe. Sem R2 configurado, o backup
      não acontece e a tela diz isso com todas as letras. Ver `enviarAoR2`, que
      é a única função do storage.js que NÃO cai para o disco.

   2. É CONFERIDA ANTES DE SUBIR. Depois de copiar, o arquivo é aberto de novo
      e passa por `integrity_check` mais uma contagem de leads. Backup corrompido
      é pior que backup nenhum: com nenhum você sabe que está desprotegido; com
      um quebrado você descobre no dia em que precisa dele.

   3. NUNCA DERRUBA O CRM. Roda no mesmo batimento de um minuto do corte de
      expediente, e toda falha vira registro e log — jamais exceção que suba.
      Disco cheio, R2 fora do ar ou credencial trocada deixam o CRM funcionando
      e o problema visível na tela do hub.

   4. QUEM MANDA É O REGISTRO, NÃO O RELÓGIO. Mesmo princípio do
      `orgs.ultimo_corte` e do `ultimo_aviso_plantao`: o que decide se roda hoje
      é "já fiz hoje?", guardado em `config_plataforma`. Servidor que estava
      fora do ar às 03:00 faz a cópia quando voltar; servidor que reinicia
      cinco vezes não faz cinco.

   POR QUE `db.backup()` E NÃO COPIAR O ARQUIVO

   O banco roda em WAL: o arquivo .db no disco NÃO contém as escritas mais
   recentes, que estão no .db-wal ao lado. Copiar só o .db entregaria uma base
   sem os últimos atendimentos, e copiar os dois com o servidor escrevendo dá
   um par inconsistente. O `backup()` do better-sqlite3 é a API de cópia online
   do SQLite: sai um arquivo único e íntegro, sem travar quem está usando. */

import db from "../db.js";
import { unlink, readFile } from "fs/promises";
import { gzipSync } from "zlib";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { usandoR2, enviarAoR2, listarNoR2, apagarNoR2 } from "./storage.js";

const PREFIXO = "backups/";
// Hora do dia (0-23) em que a cópia roda. Madrugada: é quando ninguém atende.
const HORA = Number(process.env.BACKUP_HORA ?? 3);
// Quantas cópias diárias ficam guardadas. Trinta dias é o que dá para voltar
// de um estrago que ninguém percebeu na hora — apagar lead errado, importação
// torta. Guardar para sempre só acumula custo no R2 sem acrescentar segurança.
const QUANTAS = Math.max(2, Number(process.env.BACKUP_MANTER ?? 30));

const CHAVE_ESTADO = "backup_estado";

const lerEstado = () => {
  const l = db.prepare("SELECT valor FROM config_plataforma WHERE chave = ?").get(CHAVE_ESTADO);
  try { return l ? JSON.parse(l.valor) : {}; } catch (e) { return {}; }
};
const gravarEstado = (v) =>
  db.prepare(`INSERT INTO config_plataforma (chave,valor,atualizado_em) VALUES (?,?,?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`)
    .run(CHAVE_ESTADO, JSON.stringify(v), Date.now());

// "2026-08-27" no fuso do servidor. É a chave de "já fiz hoje".
const diaDe = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const caminhoDoBanco = () => db.name;

/* Faz a cópia, confere e sobe. Devolve o que aconteceu — nunca lança.

   `motivo` só entra no registro, para a tela separar a cópia automática da que
   alguém pediu no botão. */
export async function rodarBackup({ motivo = "automatico" } = {}) {
  const comecou = Date.now();
  if (!usandoR2())
    return falhou(comecou, motivo, "O Cloudflare R2 não está configurado. Sem ele a cópia ficaria no mesmo disco do banco, que é o disco que ela existe para proteger.");

  const temporario = path.join(os.tmpdir(), `concrm-backup-${Date.now()}.db`);
  try {
    // 1. Cópia online: consistente mesmo com o CRM sendo usado agora.
    await db.backup(temporario);

    // 2. Conferência. Um arquivo que não abre, ou que abre e não tem os leads,
    //    não pode subir como se fosse cópia boa.
    const conferido = conferir(temporario);
    if (!conferido.ok) return falhou(comecou, motivo, `A cópia saiu com defeito e não foi enviada: ${conferido.erro}`);

    // 3. Compacta. Banco é texto e índice repetidos — costuma cair bastante, e
    //    o que se paga no R2 é por byte guardado.
    const cru = await readFile(temporario);
    const zip = gzipSync(cru, { level: 6 });

    const chave = `${PREFIXO}concrm-${diaDe(comecou)}.db.gz`;
    await enviarAoR2(chave, zip, "application/gzip");

    // 4. Joga fora as mais antigas. Falhar aqui não invalida a cópia que acabou
    //    de subir — é limpeza, não é o backup.
    let apagadas = 0;
    try { apagadas = await limparAntigas(); }
    catch (e) { console.warn("[backup] não consegui limpar as cópias antigas:", e.message); }

    const estado = {
      ...lerEstado(),
      ultimo_dia: diaDe(comecou), ultimo_em: comecou, ultimo_motivo: motivo,
      ultimo_erro: null, chave, bytes: zip.length, bytes_banco: cru.length,
      leads: conferido.leads, mensagens: conferido.mensagens,
      duracao_ms: Date.now() - comecou,
    };
    gravarEstado(estado);
    console.log(`[backup] ${chave} — ${(zip.length / 1048576).toFixed(1)} MB (banco ${(cru.length / 1048576).toFixed(1)} MB), ${conferido.leads} leads, ${((Date.now() - comecou) / 1000).toFixed(1)}s${apagadas ? `, ${apagadas} antiga(s) apagada(s)` : ""}`);
    return { ok: true, ...estado };
  } catch (e) {
    return falhou(comecou, motivo, emPortugues(e));
  } finally {
    // Sempre: o temporário tem o tamanho do banco inteiro, e deixá-lo para trás
    // enche o disco em poucos dias — quebrando o CRM por causa do backup.
    try { await unlink(temporario); } catch (e) {}
  }
}

function falhou(comecou, motivo, erro) {
  gravarEstado({ ...lerEstado(), ultimo_erro: { quando: comecou, motivo, erro } });
  console.error("[backup] falhou:", erro);
  return { ok: false, erro };
}

/* O erro do jeito que o Ali consegue agir sobre ele.

   O SDK da Amazon devolve coisas como "@aws-sdk XML parse error: unexpected
   content. Deserialization error: to see the raw response, inspect the hidden
   field {error}.$response" — que é verdade e não serve para nada. Quem lê esta
   tela é quem administra a plataforma, não quem escreveu o cliente HTTP.

   Mesma ideia do `chamar()` do asaas.js: traduzir os casos que a gente sabe
   nomear e deixar o resto passar cru, em vez de esconder o que não conhece. */
export function emPortugues(e, operacao = "enviar") {
  const m = String(e && e.message || e);
  const nome = String(e && e.name || "");
  const codigo = (e && e.$metadata && e.$metadata.httpStatusCode) || 0;
  if (/ENOSPC/.test(m))
    return "Faltou espaço em disco para montar a cópia. O arquivo temporário ocupa o mesmo tamanho do banco.";
  /* CHAVE ERRADA E FALTA DE PERMISSÃO SÃO PROBLEMAS DIFERENTES, e os dois
     chegam como 403. Confundi-los custa caro nos dois sentidos:

     - `InvalidAccessKeyId` / `SignatureDoesNotMatch` é chave errada: o token
       não existe ou o segredo foi copiado torto;
     - `AccessDenied` é a chave CERTA sem direito àquela operação. No R2 isso
       acontece com token criado como "Object Read only", ou preso a outro
       bucket. Mandar trocar a chave nesse caso é mandar consertar o que não
       está quebrado — e, pior, arrisca derrubar o envio de fotos, que usa as
       MESMAS credenciais e está funcionando.

     O sintoma que separa os dois na prática: se a foto do imóvel sobe e só o
     backup reclama, a chave está certa e falta permissão. */
  /* Só `AccessDenied` mesmo — "Forbidden" solto na mensagem não distingue
     falta de permissão de chave errada, e cair aqui por causa dele mandaria o
     gestor no caminho de permissão sem base para isso. Sem nome reconhecido, o
     403 genérico logo abaixo cita as duas causas. */
  // "Access Denied" com espaço é como o SDK escreve na mensagem; "AccessDenied"
  // sem espaço é o `name` do erro. Os dois precisam casar, senão a tradução só
  // funciona quando o objeto de erro chega inteiro.
  if (/Access ?Denied/i.test(nome + m))
    return operacao === "listar"
      ? "O Cloudflare R2 aceitou a chave mas não deixou LISTAR o bucket. O token foi criado sem permissão de leitura da lista, ou está preso a outro bucket. No painel do R2, em Manage R2 API Tokens, o token precisa ser \"Object Read & Write\" no bucket " + "informado em R2_BUCKET. Não troque a chave: ela é a mesma das fotos dos imóveis, que estão funcionando."
      : "O Cloudflare R2 aceitou a chave mas não deixou GRAVAR no bucket. O token está como somente leitura, ou preso a outro bucket. Em Manage R2 API Tokens, ele precisa ser \"Object Read & Write\".";
  if (/InvalidAccessKeyId|SignatureDoesNotMatch/i.test(nome + m))
    return "O Cloudflare R2 não reconheceu a chave. Confira R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY — o segredo só aparece uma vez, ao criar o token.";
  /* 403 que não se identificou: as duas causas continuam de pé, então a frase
     cita as duas em vez de escolher uma e mandar o gestor no caminho errado. */
  if (codigo === 403)
    return "O Cloudflare R2 respondeu \"proibido\". Ou a chave está errada (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY), ou o token não tem permissão sobre este bucket. Se as fotos dos imóveis sobem normalmente, é a permissão do token.";
  if (/NoSuchBucket/i.test(nome + m) || codigo === 404)
    return "O bucket informado em R2_BUCKET não existe nesta conta do R2.";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m))
    return "Não consegui alcançar o Cloudflare R2 pela rede. Confira R2_ACCOUNT_ID — ele é parte do endereço do servidor.";
  /* TLS que nem chega a começar. O erro vem cru do OpenSSL — "sslv3 alert
     handshake failure … SSL alert number 40" — e não há nada nele que um não
     programador possa fazer.

     O que ele significa aqui é bem específico: o servidor do outro lado
     RECUSOU a conexão segura para o endereço pedido, o que acontece quando o
     endereço não é um endereço válido do R2. E o endereço é montado com o
     R2_ACCOUNT_ID (`https://<conta>.r2.cloudflarestorage.com`), então é ele o
     suspeito — em especial quando alguém cola ali o endpoint inteiro em vez de
     só o identificador da conta.

     Repare que isto acontece ANTES de qualquer autenticação: se este erro
     aparece, a chave e o segredo nem foram olhados. */
  if (/EPROTO|handshake failure|alert number 40|ERR_TLS|ERR_SSL|wrong version number/i.test(nome + m))
    return "Não consegui abrir conexão segura com o endereço do R2 — ele foi recusado antes de a chave ser conferida. O endereço é montado com o R2_ACCOUNT_ID, então é quase sempre ele: precisa ser SÓ o Account ID (32 caracteres, números e letras de a-f), sem https:// e sem o resto do endereço.";
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i.test(m))
    return "A conexão com o Cloudflare R2 caiu no meio do envio. Tente de novo; se repetir, é rede da hospedagem.";
  if (/XML parse error|Deserialization/i.test(m))
    return "O R2 respondeu algo que não é uma resposta de armazenamento. Quase sempre é R2_ACCOUNT_ID errado — o endereço montado com ele não é o da sua conta.";
  return m;
}

/* Abre a cópia e pergunta duas coisas: o SQLite consegue lê-la inteira, e os
   dados estão lá? A segunda importa tanto quanto a primeira — arquivo vazio
   passa em qualquer verificação de integridade. */
function conferir(arquivo) {
  let copia;
  try {
    copia = new Database(arquivo, { readonly: true, fileMustExist: true });
    const check = copia.pragma("integrity_check", { simple: true });
    if (check !== "ok") return { ok: false, erro: `integrity_check devolveu "${check}"` };
    const leads = copia.prepare("SELECT COUNT(*) n FROM leads").get().n;
    const mensagens = copia.prepare("SELECT COUNT(*) n FROM messages").get().n;
    const orgs = copia.prepare("SELECT COUNT(*) n FROM orgs").get().n;
    /* Zero imobiliária é impossível num banco em uso — o bootstrap cria uma no
       start. Se a cópia diz zero, ela não é do banco que está rodando. */
    if (!orgs) return { ok: false, erro: "a cópia não tem nenhuma imobiliária dentro" };
    return { ok: true, leads, mensagens, orgs };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { if (copia) copia.close(); } catch (e) {}
  }
}

async function limparAntigas() {
  const todas = await listarNoR2(PREFIXO);
  const sobrando = todas.slice(QUANTAS);
  for (const b of sobrando) await apagarNoR2(b.chave);
  return sobrando.length;
}

/* O que a tela do hub mostra. Lê a lista do R2 de verdade — o registro nosso
   diz o que o servidor ACHA que aconteceu; a lista diz o que está guardado. */
export async function situacaoDoBackup() {
  const estado = lerEstado();
  const base = {
    ligado: usandoR2(), hora: HORA, manter: QUANTAS,
    ultimo_em: estado.ultimo_em || null, ultimo_erro: estado.ultimo_erro || null,
    bytes: estado.bytes || null, leads: estado.leads ?? null, mensagens: estado.mensagens ?? null,
  };
  if (!usandoR2()) return { ...base, copias: [] };
  try {
    const copias = await listarNoR2(PREFIXO);
    return { ...base, copias: copias.slice(0, 40),
      total: copias.length, ocupado: copias.reduce((s, c) => s + c.bytes, 0) };
  } catch (e) {
    return { ...base, copias: [], erro_listagem: emPortugues(e, "listar") };
  }
}

/* Chamado a cada minuto, junto do corte de expediente e do aviso de plantão.

   Não é o relógio que garante a cópia: é o "já fiz hoje" guardado. Servidor
   fora do ar às 03:00 faz assim que voltar, e servidor que reinicia dez vezes
   no mesmo dia continua fazendo uma. */
let rodando = false;
export async function backupSePassouDaHora(agora = Date.now()) {
  if (rodando) return;                       // uma cópia de cada vez
  if (!usandoR2()) return;                   // sem destino, não há o que fazer
  const hoje = diaDe(agora);
  const estado = lerEstado();
  if (estado.ultimo_dia === hoje) return;    // já foi feita hoje
  if (new Date(agora).getHours() < HORA) return;
  rodando = true;
  try { await rodarBackup({ motivo: "automatico" }); }
  finally { rodando = false; }
}
