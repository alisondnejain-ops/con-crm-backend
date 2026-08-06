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
    else if (!/^[0-9a-f]{32}$/i.test(R2.conta))
      problemas.push("R2_ACCOUNT_ID não tem a cara de um Account ID. " + VARS[0].ajuda);
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
  const chave = `${prefixo}/${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;

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
      ultimaFalhaR2 = { quando: Date.now(), erro: e.message };
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
