// Armazenamento de arquivos (fotos e vídeos dos imóveis) com dois modos:
//
//   disco — padrão. Grava no volume da hospedagem e serve por /arquivos/...
//           Funciona hoje, sem contratar nada. Bom para fotos; vídeo grande
//           enche o volume rápido.
//   r2    — Cloudflare R2. Liga sozinho quando as variáveis R2_* existirem.
//           É o modo definitivo: barato, sem limite prático e fora do servidor.
//
// A troca de um para o outro não muda nada no resto do código: quem chama
// só conhece salvar() e apagar().

import { mkdir, writeFile, unlink, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const raiz = path.dirname(fileURLToPath(import.meta.url));
// Ao lado do banco: se o DB está no volume, os arquivos também ficam.
const PASTA = process.env.UPLOAD_DIR ||
  (process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), "uploads")
                       : path.join(raiz, "..", "..", "uploads"));

/* Limpa o que quase sempre vem junto quando alguém cola a chave no painel da
   hospedagem: espaço sobrando, aspas e os sinais < > que a gente usa em
   instrução para dizer "coloque seu valor aqui". Uma chave com um `<` na
   frente é recusada pela Cloudflare com um erro que não explica nada — melhor
   aceitar e avisar (ver conferirR2) do que quebrar em silêncio. */
const limpar = (v) => String(v ?? "").trim().replace(/^["'<]+|["'>]+$/g, "").trim();

const CRU = {
  conta: process.env.R2_ACCOUNT_ID,
  chave: process.env.R2_ACCESS_KEY_ID,
  segredo: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
  publico: process.env.R2_PUBLIC_URL,
};
const R2 = {
  conta: limpar(CRU.conta),
  chave: limpar(CRU.chave),
  segredo: limpar(CRU.segredo),
  bucket: limpar(CRU.bucket),
  publico: limpar(CRU.publico).replace(/\/$/, ""),
};
export const usandoR2 = () => !!(R2.conta && R2.chave && R2.segredo && R2.bucket && R2.publico);
export const modoArmazenamento = () => (usandoR2() ? "Cloudflare R2" : "disco da hospedagem");

/* Conferência das variáveis do R2, para o painel de integrações.

   Existe porque "não funciona" no R2 é sempre erro de digitação, e o erro que
   a Cloudflare devolve não diz qual campo está errado. Aqui a gente diz.

   NUNCA devolve o valor de nada — só o diagnóstico. Este endereço é público. */
const VARS = [
  { env: "R2_ACCOUNT_ID", campo: "conta", ajuda: "São 32 caracteres (números e letras de a-f). Está na página do R2, no quadro Account ID — ou no meio do endereço do navegador: dash.cloudflare.com/AQUI/r2/overview." },
  { env: "R2_ACCESS_KEY_ID", campo: "chave", ajuda: "É o Access Key ID que a Cloudflare mostrou ao criar o token do R2." },
  { env: "R2_SECRET_ACCESS_KEY", campo: "segredo", ajuda: "É o Secret Access Key, mostrado uma única vez ao criar o token. Se perdeu, crie outro token." },
  { env: "R2_BUCKET", campo: "bucket", ajuda: "O nome exato do bucket, como aparece na lista do R2." },
  { env: "R2_PUBLIC_URL", campo: "publico", ajuda: "O endereço público do bucket, começando com https://. Ou o domínio que você ligou em Settings > Custom Domains, ou o pub-xxxx.r2.dev de Public Development URL." },
];

export function conferirR2() {
  const problemas = [];
  const campos = {};

  for (const { env, campo, ajuda } of VARS) {
    const cru = CRU[campo];
    // A barra no fim da URL pública é legítima — comparamos antes de tirá-la,
    // senão ela vira falso alarme de "valor sujo".
    const val = campo === "publico" ? limpar(cru) : R2[campo];
    if (!val) {
      campos[env] = "faltando";
      problemas.push(`${env} está vazia. ${ajuda}`);
      continue;
    }
    campos[env] = "preenchida";
    if (String(cru).trim() !== val)
      problemas.push(`${env} veio com aspas, espaço ou os sinais < > em volta. Eu limpei para funcionar, mas corrija no painel: o valor vai sozinho, sem nada em volta.`);
  }

  // Erros de campo trocado — os que mais custaram tempo na instalação.
  if (R2.conta) {
    if (/^cfat[_-]/i.test(R2.conta))
      problemas.push("R2_ACCOUNT_ID está com o ID do TOKEN (começa com cfat_), não com o ID da CONTA. " + VARS[0].ajuda);
    /* O endpoint inteiro colado no lugar do Account ID. A tela do R2 mostra os
       dois juntos ("Use this S3 endpoint: https://<conta>.r2.cloudflarestorage.com"),
       e o endereço é o que parece mais com "a configuração". O sintoma é feio e
       não aponta para cá: a conexão TLS é recusada com "SSL alert number 40",
       porque o endereço montado fica com o endpoint duas vezes. */
    else if (/^https?:\/\//i.test(R2.conta) || R2.conta.includes("/") || /r2\.cloudflarestorage\.com/i.test(R2.conta))
      problemas.push("R2_ACCOUNT_ID está com o ENDEREÇO do R2, não com o ID da conta. O sistema monta o endereço sozinho — aqui vai só o identificador. " + VARS[0].ajuda);
    else if (R2.conta.includes("."))
      problemas.push("R2_ACCOUNT_ID tem ponto, e um Account ID não tem. Parece que veio um pedaço do endereço junto. " + VARS[0].ajuda);
    else if (!/^[0-9a-f]{32}$/i.test(R2.conta))
      problemas.push(`R2_ACCOUNT_ID tem ${R2.conta.length} caracteres e o esperado são 32 (números e letras de a-f). ` + VARS[0].ajuda);
  }
  /* AS DUAS CHAVES TÊM FORMA FIXA, e conferi-la aqui evita a pior mensagem
     possível: "o R2 não reconheceu a chave", que manda procurar defeito sem
     dizer onde. As credenciais do S3 do R2 são derivadas do token:

       R2_ACCESS_KEY_ID     = 32 caracteres hexadecimais (o ID do token)
       R2_SECRET_ACCESS_KEY = 64 caracteres hexadecimais

     Os dois erros que essa conferência pega, e que custam uma tarde cada:

     1. colar o TOKEN da API do Cloudflare (aquele texto de ~40 caracteres com
        hífen e sublinhado) no lugar do Access Key ID. Acontece porque a tela
        do Cloudflare mostra os dois juntos, e o token é o que fica em destaque;
     2. colar o segredo pela metade. Ele tem 64 caracteres e sai numa caixinha
        que rola — selecionar com o mouse corta o fim, e o R2 recusa com a
        mesma cara de "chave errada".

     NUNCA imprime o valor: esta rota é pública. Só o tamanho e a forma. */
  const chaveOk = (v) => /^[0-9a-f]{32}$/i.test(v);
  if (R2.chave && !chaveOk(R2.chave)) {
    if (/^[A-Za-z0-9_-]{35,}$/.test(R2.chave) && /[-_]/.test(R2.chave))
      problemas.push("R2_ACCESS_KEY_ID parece ser o TOKEN da API do Cloudflare, não o Access Key ID do R2. Na tela em que o token foi criado, o Access Key ID é o campo de 32 caracteres (só números e letras de a-f).");
    else
      problemas.push(`R2_ACCESS_KEY_ID tem ${R2.chave.length} caracteres; o esperado são 32 (só números e letras de a-f). Copie de novo o Access Key ID, inteiro.`);
  }
  if (R2.segredo && !/^[0-9a-f]{64}$/i.test(R2.segredo)) {
    if (/^[0-9a-f]+$/i.test(R2.segredo) && R2.segredo.length < 64)
      problemas.push(`R2_SECRET_ACCESS_KEY tem ${R2.segredo.length} caracteres; o esperado são 64. Ele provavelmente foi cortado ao copiar — o campo rola, e a seleção com o mouse perde o fim. Se o token já foi fechado, o segredo não aparece mais: crie outro token.`);
    else
      problemas.push("R2_SECRET_ACCESS_KEY não tem a cara de um Secret Access Key do R2 (64 caracteres, só números e letras de a-f). Confira se não trocou de campo.");
  }

  if (R2.publico && !/^https?:\/\//i.test(R2.publico))
    problemas.push("R2_PUBLIC_URL precisa começar com https://.");
  if (R2.bucket && /[^a-z0-9.-]/.test(R2.bucket))
    problemas.push("R2_BUCKET tem caractere estranho (espaço, maiúscula ou acento). Copie o nome exato da lista de buckets.");

  return {
    ligado: usandoR2(),
    campos,
    problemas,
    tudo_certo: usandoR2() && problemas.length === 0,
  };
}

// Cadastro de imóveis: só foto e vídeo. É esta lista que `tipoPermitido` guarda.
const EXTENSOES = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "video/mp4": ".mp4", "video/quicktime": ".mov",
};
// O que chega do cliente pelo WhatsApp é mais variado: áudio de voz e a papelada
// da pasta (RG, comprovante de renda). Vale para guardar e exibir na conversa,
// mas NÃO libera esses tipos no catálogo de imóveis — são listas separadas.
const EXTENSOES_RECEBIDAS = {
  ...EXTENSOES,
  "image/gif": ".gif", "video/3gpp": ".3gp", "video/webm": ".webm",
  // audio/webm é o que o navegador do Android grava; audio/mp4, o do iPhone.
  // Sem os dois, o áudio gravado no CRM não teria extensão e não tocaria.
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/amr": ".amr",
  "audio/wav": ".wav", "audio/webm": ".webm",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",
};
export const tipoPermitido = (mime) => !!EXTENSOES[mime];
export const ehVideo = (mime) => String(mime).startsWith("video/");

// Limites por tipo de mídia. Vídeo no disco é o que mais dói, então é mais apertado
// enquanto o R2 não estiver ligado.
export const limiteBytes = (mime) =>
  ehVideo(mime) ? (usandoR2() ? 60 * 1024 * 1024 : 20 * 1024 * 1024) : 8 * 1024 * 1024;

let clienteR2 = null;
async function s3() {
  if (clienteR2) return clienteR2;
  const { S3Client } = await import("@aws-sdk/client-s3");
  clienteR2 = new S3Client({
    region: "auto",
    endpoint: `https://${R2.conta}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2.chave, secretAccessKey: R2.segredo },
  });
  return clienteR2;
}

/* Última falha do R2, para o diagnóstico. Credencial errada não avisa: o
   sintoma é o corretor não conseguir subir foto, e o motivo fica só no log. */
let ultimaFalhaR2 = null;
export const falhaR2 = () => ultimaFalhaR2;

async function gravarNoDisco(chave, buffer) {
  const destino = path.join(PASTA, chave);
  await mkdir(path.dirname(destino), { recursive: true });
  await writeFile(destino, buffer);
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  return { url: `${base}/arquivos/${chave}`, chave };
}

// Devolve { url, chave }. A url é pública — é ela que vai para o WhatsApp.
export async function salvar({ buffer, mime, prefixo = "produtos" }) {
  // Aceita tanto os tipos do catálogo quanto os recebidos na conversa. Quem
  // decide o que pode entrar é o chamador; aqui só resolvemos a extensão.
  const ext = EXTENSOES_RECEBIDAS[mime] || "";
  /* O NOME DO ARQUIVO É A ÚNICA FECHADURA QUE ELE TEM. (02/09/2026)

     Era `Date.now()-<8 caracteres>`. Oito caracteres hexadecimais são 32 bits,
     e o resto do nome é o RELÓGIO — quem sabe mais ou menos quando uma foto
     foi enviada reduz a busca a algumas horas de milissegundos vezes 4 bilhões.
     É pouco para chutar de primeira e é MUITO pouco para o que está guardado
     ali: em `conversas/` moram os arquivos que o CLIENTE mandou no WhatsApp —
     print de simulação da Caixa (renda, CPF), foto de documento, áudio com a
     voz da pessoa. Nada disso pede senha para abrir, porque o R2 é público e o
     `/arquivos` é servido estático (e precisa ser: é assim que o WhatsApp
     busca a mídia que o corretor envia).

     Enquanto a lista de endereços não vazar, um nome curto parece seguro — e é
     exatamente esse "enquanto" que não é uma garantia. O UUID inteiro custa
     nada e leva a adivinhação de "difícil" para "impossível": 122 bits de
     aleatório de verdade.

     Vale só para arquivo NOVO. Os antigos continuam com o nome curto — trocar
     exigiria mover tudo e reescrever cada endereço já gravado em `messages`,
     com risco de perder mídia de conversa antiga. Está na lista do que ficou
     pendente, com o porquê. */
  const chave = `${prefixo}/${Date.now()}-${randomUUID().replace(/-/g, "")}${ext}`;

  if (usandoR2()) {
    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const cliente = await s3();
      await cliente.send(new PutObjectCommand({
        Bucket: R2.bucket, Key: chave, Body: buffer, ContentType: mime,
      }));
      ultimaFalhaR2 = null;
      return { url: `${R2.publico}/${chave}`, chave };
    } catch (e) {
      /* R2 configurado errado NÃO pode impedir o corretor de cadastrar imóvel.
         Cai para o disco e grita no log: a foto entra, a operação continua, e
         o problema fica visível em /integracoes em vez de virar "deu erro".
         Mesmo princípio do e-mail, do push e da IA — serviço externo fora do ar
         degrada, não derruba. */
      // O `name` vai junto: é ele que separa "chave errada" de "sem permissão",
      // e sem ele o diagnóstico só tem a mensagem para adivinhar.
      ultimaFalhaR2 = { quando: Date.now(), erro: e.message, nome: e.name || null };
      console.error("[storage] R2 recusou o arquivo, gravando no disco:", e.message);
      clienteR2 = null;   // credencial pode ter mudado; força refazer na próxima
      return gravarNoDisco(chave, buffer);
    }
  }

  return gravarNoDisco(chave, buffer);
}

export async function apagar(chave) {
  if (!chave) return;
  try {
    if (usandoR2()) {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const cliente = await s3();
      await cliente.send(new DeleteObjectCommand({ Bucket: R2.bucket, Key: chave }));
      return;
    }
    const destino = path.join(PASTA, chave);
    if (existsSync(destino)) await unlink(destino);
  } catch (e) {
    // Arquivo órfão não pode derrubar a exclusão do cadastro.
    console.warn("[storage] não consegui apagar", chave, e.message);
  }
}

/* Lê o arquivo de volta, do disco ou do R2.

   Existe para o envio pelo WhatsApp não depender de a URL pública estar
   alcançável de fora: quando a Uazapi não consegue baixar pelo link, o
   arquivo vai embutido na requisição (ver sendMedia). Aqui o servidor lê o
   próprio arquivo, o que funciona mesmo com o domínio fora do ar. */
export async function bytesDoArquivo(chave) {
  if (!chave) throw new Error("sem a chave do arquivo");
  if (usandoR2()) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const cliente = await s3();
    const saida = await cliente.send(new GetObjectCommand({ Bucket: R2.bucket, Key: chave }));
    const pedacos = [];
    for await (const p of saida.Body) pedacos.push(p);
    return Buffer.concat(pedacos);
  }
  return readFile(path.join(PASTA, chave));
}

export const pastaLocal = () => PASTA;

/* ===== R2 DIRETO, SEM REDE DE SEGURANÇA =====

   `salvar()` cai para o disco quando o R2 recusa, e está certo: foto que não
   sobe não pode impedir o corretor de cadastrar imóvel.

   O BACKUP É O CONTRÁRIO. Um backup gravado no disco da hospedagem fica no
   MESMO volume do banco que ele deveria proteger — e o cenário que o backup
   existe para cobrir é justamente perder esse volume. Ele não seria uma cópia
   pior; seria uma cópia que some junto, dando a impressão de que existe.

   Por isso estas três funções falham alto: quem chama precisa saber que não
   subiu, para dizer isso na tela em vez de mostrar um backup que não existe. */
export async function enviarAoR2(chave, buffer, mime = "application/octet-stream") {
  if (!usandoR2()) throw new Error("O Cloudflare R2 não está configurado neste servidor.");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const cliente = await s3();
  await cliente.send(new PutObjectCommand({ Bucket: R2.bucket, Key: chave, Body: buffer, ContentType: mime }));
  return { chave, bytes: buffer.length };
}

/* Lista o que está guardado sob um prefixo. É o que responde "o último backup
   foi quando?" olhando o R2, e não um registro nosso — registro nosso diz o
   que o servidor ACHA que aconteceu; isto diz o que está lá. */
export async function listarNoR2(prefixo) {
  if (!usandoR2()) throw new Error("O Cloudflare R2 não está configurado neste servidor.");
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const cliente = await s3();
  const itens = [];
  let token;
  do {
    const saida = await cliente.send(new ListObjectsV2Command({
      Bucket: R2.bucket, Prefix: prefixo, ContinuationToken: token }));
    for (const o of saida.Contents || [])
      itens.push({ chave: o.Key, bytes: o.Size, quando: new Date(o.LastModified).getTime() });
    token = saida.IsTruncated ? saida.NextContinuationToken : null;
  } while (token);
  return itens.sort((a, b) => b.quando - a.quando);
}

export async function apagarNoR2(chave) {
  if (!usandoR2()) throw new Error("O Cloudflare R2 não está configurado neste servidor.");
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const cliente = await s3();
  await cliente.send(new DeleteObjectCommand({ Bucket: R2.bucket, Key: chave }));
}
