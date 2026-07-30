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

import { mkdir, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const raiz = path.dirname(fileURLToPath(import.meta.url));
// Ao lado do banco: se o DB está no volume, os arquivos também ficam.
const PASTA = process.env.UPLOAD_DIR ||
  (process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), "uploads")
                       : path.join(raiz, "..", "..", "uploads"));

const R2 = {
  conta: process.env.R2_ACCOUNT_ID,
  chave: process.env.R2_ACCESS_KEY_ID,
  segredo: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
  publico: (process.env.R2_PUBLIC_URL || "").replace(/\/$/, ""),
};
export const usandoR2 = () => !!(R2.conta && R2.chave && R2.segredo && R2.bucket && R2.publico);
export const modoArmazenamento = () => (usandoR2() ? "Cloudflare R2" : "disco da hospedagem");

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
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/amr": ".amr", "audio/wav": ".wav",
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

// Devolve { url, chave }. A url é pública — é ela que vai para o WhatsApp.
export async function salvar({ buffer, mime, prefixo = "produtos" }) {
  // Aceita tanto os tipos do catálogo quanto os recebidos na conversa. Quem
  // decide o que pode entrar é o chamador; aqui só resolvemos a extensão.
  const ext = EXTENSOES_RECEBIDAS[mime] || "";
  const chave = `${prefixo}/${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;

  if (usandoR2()) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const cliente = await s3();
    await cliente.send(new PutObjectCommand({
      Bucket: R2.bucket, Key: chave, Body: buffer, ContentType: mime,
    }));
    return { url: `${R2.publico}/${chave}`, chave };
  }

  const destino = path.join(PASTA, chave);
  await mkdir(path.dirname(destino), { recursive: true });
  await writeFile(destino, buffer);
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  return { url: `${base}/arquivos/${chave}`, chave };
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

export const pastaLocal = () => PASTA;
