/* Move para o Cloudflare R2 os arquivos que já estão no disco da hospedagem.

   Ligar o R2 sozinho só muda o destino dos arquivos NOVOS. As fotos dos imóveis,
   os áudios das conversas e os prints das simulações que já existem continuam no
   disco do Railway — e no dia em que esse disco for trocado, some tudo. Este
   script fecha esse buraco.

   Como rodar (dentro de backend/, com as variáveis R2_* configuradas):

       npm run migrar-r2            # mostra o que faria, sem alterar nada
       npm run migrar-r2 -- --vai   # move de verdade

   Dois cuidados de propósito:
   - NÃO apaga o arquivo local. Se algo der errado no meio, o original está lá.
     A limpeza é decisão sua, depois de conferir que tudo abre
   - roda de novo sem estragar nada: o que já foi migrado é reconhecido pela URL
     e pulado, então dá para rodar em partes ou repetir se cair a conexão */

import "dotenv/config";
import { readFile } from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import db from "./db.js";
import { usandoR2, salvar, pastaLocal } from "./services/storage.js";

const VAI = process.argv.includes("--vai");

const MIMES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp",
  ".webm": "video/webm", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".amr": "audio/amr", ".wav": "audio/wav", ".pdf": "application/pdf", ".txt": "text/plain",
};

// Onde há URL de arquivo guardada. Cada linha vira um UPDATE quando a migração
// acontece — de nada adianta subir o arquivo se o banco continua apontando para
// o endereço antigo.
const LUGARES = [
  { tabela: "produto_midias", coluna: "url", id: "id" },
  { tabela: "messages", coluna: "media_url", id: "id" },
  { tabela: "simulacoes", coluna: "print_url", id: "id" },
  { tabela: "users", coluna: "avatar_url", id: "id" },
];

function arquivosLocais(raiz) {
  const achados = [];
  const andar = (dir) => {
    if (!existsSync(dir)) return;
    for (const nome of readdirSync(dir)) {
      const cheio = path.join(dir, nome);
      if (statSync(cheio).isDirectory()) andar(cheio);
      else achados.push(cheio);
    }
  };
  andar(raiz);
  return achados;
}

async function principal() {
  if (!usandoR2()) {
    console.error("R2 não está configurado. Preencha R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,");
    console.error("R2_SECRET_ACCESS_KEY, R2_BUCKET e R2_PUBLIC_URL antes de migrar.");
    process.exit(1);
  }

  const raiz = pastaLocal();
  const arquivos = arquivosLocais(raiz);
  if (!arquivos.length) {
    console.log("Nenhum arquivo no disco local. Nada a migrar.");
    return;
  }

  console.log(`${arquivos.length} arquivo(s) no disco local (${raiz}).`);
  if (!VAI) console.log("MODO DE CONFERÊNCIA — nada será alterado. Use --vai para migrar de verdade.\n");

  let migrados = 0, pulados = 0, falhas = 0, bytes = 0;

  for (const cheio of arquivos) {
    // A "chave" é o caminho relativo, que é exatamente o que aparece na URL
    // depois de /arquivos/ — é por ela que achamos o registro no banco.
    const chave = path.relative(raiz, cheio).split(path.sep).join("/");
    const ext = path.extname(chave).toLowerCase();
    const mime = MIMES[ext];
    if (!mime) { console.log(`  ? ${chave} — extensão não reconhecida, pulado`); pulados++; continue; }

    // Já migrado? A URL no banco já apontaria para o R2.
    const jaNoR2 = LUGARES.some(({ tabela, coluna }) =>
      db.prepare(`SELECT 1 FROM ${tabela} WHERE ${coluna} LIKE ?`).get(`%${process.env.R2_PUBLIC_URL}/${chave}`));
    if (jaNoR2) { pulados++; continue; }

    const linhas = LUGARES.flatMap(({ tabela, coluna, id }) =>
      db.prepare(`SELECT ${id} AS id, ${coluna} AS url FROM ${tabela} WHERE ${coluna} LIKE ?`)
        .all(`%/arquivos/${chave}`).map(r => ({ tabela, coluna, ...r })));

    if (!linhas.length) {
      // Arquivo órfão: existe no disco mas nada no banco aponta para ele.
      // Não migramos — só ocuparia espaço no R2 sem ninguém para exibir.
      console.log(`  ~ ${chave} — sem registro no banco (órfão), pulado`);
      pulados++; continue;
    }

    if (!VAI) { console.log(`  → ${chave} (${linhas.length} registro(s))`); migrados++; continue; }

    try {
      const buffer = await readFile(cheio);
      const { url } = await salvar({ buffer, mime, prefixo: path.dirname(chave) === "." ? "" : path.dirname(chave) });
      for (const l of linhas)
        db.prepare(`UPDATE ${l.tabela} SET ${l.coluna} = ? WHERE id = ?`).run(url, l.id);
      bytes += buffer.length; migrados++;
      console.log(`  ✓ ${chave} → ${url}`);
    } catch (e) {
      falhas++;
      console.error(`  ✗ ${chave} — ${e.message}`);
    }
  }

  console.log(`\n${migrados} migrado(s), ${pulados} pulado(s), ${falhas} falha(s)` +
    (VAI ? ` — ${(bytes / 1048576).toFixed(1)} MB enviados.` : "."));
  if (VAI && migrados)
    console.log("Os arquivos locais continuam no disco. Confira se tudo abre no CRM antes de apagá-los.");
}

principal().catch(e => { console.error("Erro na migração:", e.message); process.exit(1); });
