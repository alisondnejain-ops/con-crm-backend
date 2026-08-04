/* Leitor de planilha .xlsx, sem biblioteca externa.

   Um .xlsx é um ZIP com XMLs dentro. O Node já traz o descompactador (zlib),
   então dá para ler sem instalar nada — e instalar dependência aqui teria
   custo real: mais uma coisa para quebrar no `npm install` da hospedagem, que
   já deu trabalho com o better-sqlite3.

   Lê o suficiente para uma escala: a primeira planilha, as células com texto,
   número e data. Não interpreta fórmula — usa o último valor calculado que o
   Excel gravou, que é o que aparece na tela de quem montou. */

import { inflateRawSync } from "zlib";

// ── ZIP ──────────────────────────────────────────────────────────────────────
/* Lê pelo "central directory", no fim do arquivo, em vez de varrer de frente.
   É o índice oficial do ZIP: diz onde cada arquivo começa e como está
   comprimido, sem depender de adivinhar tamanhos pelo caminho. */
function arquivosDoZip(buf) {
  let fim = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error("Arquivo não parece um .xlsx válido.");

  const total = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const saida = new Map();

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comentLen = buf.readUInt16LE(p + 32);
    const inicio = buf.readUInt32LE(p + 42);
    const nome = buf.toString("utf8", p + 46, p + 46 + nomeLen);

    // No cabeçalho local os campos de tamanho variável têm OUTROS valores —
    // usar os do índice aqui apontaria para o lugar errado dentro do arquivo.
    const nomeLocal = buf.readUInt16LE(inicio + 26);
    const extraLocal = buf.readUInt16LE(inicio + 28);
    const dados = buf.subarray(inicio + 30 + nomeLocal + extraLocal,
      inicio + 30 + nomeLocal + extraLocal + tamComp);

    saida.set(nome, metodo === 0 ? dados : inflateRawSync(dados));
    p += 46 + nomeLen + extraLen + comentLen;
  }
  return saida;
}

// ── XML ──────────────────────────────────────────────────────────────────────
const semTags = (t) => t.replace(/<[^>]*>/g, "");
const desescapa = (t) => t
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, "&");

/* Data do Excel: número de dias desde 30/12/1899. O ano 1900 é tratado como
   bissexto por um bug histórico do Lotus que o Excel manteve — por isso a base
   é 30/12 e não 31/12. Devolvemos dd/mm/aaaa, que é o que o resto do sistema
   já sabe ler. */
function dataDoExcel(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

const colunaDe = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

/* Quais estilos são de DATA. Sem isso, 01/08/2026 volta como "46235" — o
   número cru que o Excel guarda — e a escala inteira cai num dia inválido. */
function estilosDeData(styles) {
  const formatos = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  for (const m of styles.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))
    if (/[dmy]/i.test(m[2]) && !/[hs]/i.test(m[2].replace(/\[[^\]]*\]/g, ""))) formatos.add(+m[1]);

  const bloco = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  if (!bloco) return new Set();
  const daData = new Set();
  let i = 0;
  for (const xf of bloco[1].matchAll(/<xf[^>]*>/g)) {
    const id = /numFmtId="(\d+)"/.exec(xf[0]);
    if (id && formatos.has(+id[1])) daData.add(i);
    i++;
  }
  return daData;
}

/* Devolve a primeira planilha como matriz de linhas (array de arrays de
   texto). Buracos viram string vazia, para a coluna 3 continuar sendo a
   coluna 3 mesmo quando a célula está em branco. */
export function lerXlsx(buffer) {
  const zip = arquivosDoZip(buffer);
  const texto = (nome) => { const b = zip.get(nome); return b ? b.toString("utf8") : ""; };

  const partilhadas = [...texto("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => desescapa(semTags(m[1])));
  const daData = estilosDeData(texto("xl/styles.xml"));

  // A primeira planilha nem sempre é sheet1.xml; o workbook diz qual é.
  let alvo = "xl/worksheets/sheet1.xml";
  const rel = /<sheet[^>]*r:id="([^"]+)"/.exec(texto("xl/workbook.xml"));
  if (rel) {
    const alvoRel = new RegExp(`Id="${rel[1]}"[^>]*Target="([^"]+)"`).exec(texto("xl/_rels/workbook.xml.rels"));
    if (alvoRel) alvo = "xl/" + alvoRel[1].replace(/^\/?xl\//, "").replace(/^\//, "");
  }
  const folha = texto(alvo) || texto("xl/worksheets/sheet1.xml");
  if (!folha) throw new Error("Não encontrei nenhuma planilha dentro do arquivo.");

  const linhas = [];
  for (const linha of folha.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celulas = [];
    for (const c of linha[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], corpo = c[2] || "";
      const col = colunaDe((/r="([A-Z]+\d+)"/.exec(attrs) || [])[1]);
      const tipo = (/t="(\w+)"/.exec(attrs) || [])[1];
      const estilo = +((/s="(\d+)"/.exec(attrs) || [])[1] ?? -1);

      let v = "";
      if (tipo === "inlineStr") v = desescapa(semTags(corpo));
      else {
        const bruto = (/<v>([\s\S]*?)<\/v>/.exec(corpo) || [])[1];
        if (bruto == null) v = "";
        else if (tipo === "s") v = partilhadas[+bruto] ?? "";
        else if (tipo === "str" || tipo === "e") v = desescapa(bruto);
        else v = daData.has(estilo) && Number(bruto) > 1 ? dataDoExcel(Number(bruto)) : desescapa(bruto);
      }
      while (celulas.length < col) celulas.push("");
      celulas[col] = v;
    }
    linhas.push(celulas);
  }
  return linhas;
}
