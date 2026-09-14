// Converte vídeo para H.264 quando o codec não é o que o WhatsApp aceita.
//
// (14/09/2026, relatado pelo Ali: "o vídeo que estão tentando enviar é em
// formato HEVC e não tá carregando; preciso que suporte mais formatos.")
//
// HEVC (H.265) é o formato padrão de gravação do iPhone desde o iOS 11 — e
// o WhatsApp, oficial ou não, aceita mensagem de vídeo só em H.264/AAC
// dentro de MP4. Isso não é falha do nosso código: o CRM já aceitava o
// arquivo sem reclamar (o filtro é "começa com video/", não o codec por
// dentro) e o servidor já subia o arquivo certinho — quem recusava era o
// WhatsApp do outro lado, silenciosamente, e o corretor via exatamente o
// "carrega e não vai" que este arquivo já documentou duas vezes por outros
// motivos.
//
// SÓ CONVERTE QUANDO PRECISA. Rodar `ffmpeg` custa CPU e tempo de verdade —
// de segundos a minutos, dependendo do vídeo — e a maioria dos vídeos que
// chegam já está em H.264 (Android, ou iPhone com "Mais compatível"
// ligado). Gastar esse tempo em todo envio penalizaria o caso comum para
// cobrir o raro. `ffprobe` lê o codec de verdade antes de decidir; só quem
// não é h264 passa pelo `ffmpeg`.
import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const ffprobePath = ffprobeStatic.path;

/* 5 minutos. Vídeo de celular comum recodifica em segundos com este preset;
   isto é uma rede de segurança contra um arquivo corrompido ou gigante
   demais travando o processo do servidor indefinidamente — melhor devolver
   um erro claro ao corretor do que deixar a requisição pendurada para
   sempre (a mesma régua do resto deste arquivo: falha que não avisa que
   aconteceu é a pior categoria de defeito). */
const TIMEOUT_MS = 5 * 60 * 1000;

function rodar(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let erro = "", saida = "";
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Demorou demais para processar o vídeo."));
    }, TIMEOUT_MS);
    proc.stdout.on("data", (d) => { saida += d; });
    proc.stderr.on("data", (d) => { erro += d; });
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ saida, erro });
      else reject(new Error(erro.trim().slice(-400) || `saiu com código ${code}`));
    });
  });
}

async function codecDeVideo(caminho) {
  const { saida } = await rodar(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name",
    "-of", "csv=p=0", caminho,
  ]);
  return saida.trim();
}

/* Recebe o vídeo cru (Buffer) e devolve o que vai para o WhatsApp:
   {buffer, mime, convertido, codecOriginal}.

   Codec já h264: devolve o MESMO buffer, sem tocar em nada — é o caminho
   comum, e precisa ser rápido (é por isso que a checagem de codec vem
   ANTES de qualquer trabalho de conversão).

   Qualquer outro codec (hevc do iPhone, e o que mais aparecer): recodifica
   para H.264/AAC num MP4 com `+faststart` (o vídeo começa a tocar antes de
   baixar tudo — importa para quem for assistir pelo celular). */
export async function garantirH264(buffer) {
  const entrada = path.join(os.tmpdir(), `concrm-video-${randomUUID()}`);
  await writeFile(entrada, buffer);
  try {
    let codec;
    try {
      codec = await codecDeVideo(entrada);
    } catch (e) {
      throw new Error(`Não consegui ler este vídeo — o arquivo pode estar corrompido ou não é um vídeo de verdade (${e.message}).`);
    }
    if (!codec) throw new Error("Não encontrei uma trilha de vídeo neste arquivo.");
    if (codec === "h264") return { buffer, mime: "video/mp4", convertido: false, codecOriginal: codec };

    const saida = `${entrada}-h264.mp4`;
    try {
      await rodar(ffmpegPath, [
        "-y", "-i", entrada,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        saida,
      ]);
      const convertido = await readFile(saida);
      return { buffer: convertido, mime: "video/mp4", convertido: true, codecOriginal: codec };
    } catch (e) {
      throw new Error(`Não consegui converter este vídeo (formato "${codec}"). Tente mandar em outro formato.`);
    } finally {
      await unlink(saida).catch(() => {});
    }
  } finally {
    await unlink(entrada).catch(() => {});
  }
}

// Para o diagnóstico em /integracoes: confere que os binários existem e
// respondem, sem gastar tempo convertendo nada.
export async function ffmpegConfigurado() {
  try {
    await rodar(ffmpegPath, ["-version"]);
    await rodar(ffprobePath, ["-version"]);
    return true;
  } catch {
    return false;
  }
}
