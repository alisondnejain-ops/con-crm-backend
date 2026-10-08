/* ANEXOS NA CONVERSA COM O CLAUDE — SÓ DO GESTOR (07/10/2026, pedido do Ali:
   "poder acrescentar arquivos: fotos, vídeos, prints e tudo mais… essa
   liberdade maior é apenas para gestores").

   O que a IA consegue ler, e é isso que a tela promete:
   - foto e print: ela VÊ a imagem;
   - PDF: lê o texto e as imagens das páginas;
   - planilha (.xlsx/.csv) e texto: lê o conteúdo (a planilha vira tabela em
     texto, primeira aba);
   - vídeo: ela NÃO assiste. O navegador tira alguns quadros do vídeo e é isso
     que vai — ela vê as cenas, não ouve o som nem acompanha o movimento. A
     tela diz isso antes de enviar, senão "mandei o vídeo" vira a expectativa
     de que ela ouviu o que o cliente falou nele.
   - áudio: não. A recusa diz o que fazer (escrever ou colar a transcrição).

   Nada disto fica guardado no armazenamento de arquivos do CRM: vai na
   pergunta e fica só no histórico da conversa, que é resumido quando os
   arquivos pesam (`compactar`, em assistente.js). */

import { lerXlsx, lerCSV } from "./xlsx.js";

const MB = 1024 * 1024;
export const LIMITES_ANEXO = {
  porMensagem: 10,              // arquivos por pergunta
  imagens: 20,                  // imagens por pergunta (quadros de vídeo contam)
  quadrosPorVideo: 8,
  imagem: 4 * MB,               // a API recusa imagem acima de 5 MB
  pdf: 12 * MB,
  texto: 400 * 1024,            // planilha e texto, depois de virar texto
  total: 16 * MB,               // somando tudo (a API aceita até 32 MB por pedido, em base64)
};
const IMAGEM = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXTO = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "text/tab-separated-values"]);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const limpaNome = (n) => String(n || "arquivo").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || "arquivo";
const tamanho = (b64) => Math.floor(String(b64 || "").length * 3 / 4);
const base64Valido = (b) => typeof b === "string" && b.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b);
const mb = (n) => (n / MB).toFixed(1).replace(".", ",") + " MB";

/* Converte o que a tela mandou em blocos da API. Devolve { blocos, resumo }
   ou { erro } com a frase para a pessoa. Cada arquivo vem precedido de uma
   linha com o nome: é por ela que a IA se refere a "o print 2", e é ela que
   fica no lugar do arquivo quando o histórico é aliviado. */
export function montarAnexos(lista) {
  if (!Array.isArray(lista) || !lista.length) return { blocos: [], resumo: [] };
  if (lista.length > LIMITES_ANEXO.porMensagem) return { erro: `Mande até ${LIMITES_ANEXO.porMensagem} arquivos por vez.` };
  const blocos = [], resumo = [];
  let total = 0, imagens = 0;
  for (const [i, a] of lista.entries()) {
    const nome = limpaNome(a?.nome);
    const tipo = String(a?.tipo || "").toLowerCase().split(";")[0].trim();
    const cabeca = (extra = "") => ({ type: "text", text: `Anexo ${i + 1}: “${nome}”${extra}` });

    if (tipo.startsWith("video/")) {
      const quadros = Array.isArray(a.quadros) ? a.quadros.slice(0, LIMITES_ANEXO.quadrosPorVideo) : [];
      if (!quadros.length) return { erro: `Não consegui tirar as cenas do vídeo “${nome}” neste aparelho. Tente outro vídeo ou mande prints.` };
      const dur = Number(a.duracao) > 0 ? ` (${Math.round(Number(a.duracao))} s)` : "";
      blocos.push(cabeca(` — vídeo${dur}. Você NÃO assiste ao vídeo nem ouve o som: abaixo vão ${quadros.length} quadros tirados dele, em ordem.`));
      for (const q of quadros) {
        if (!base64Valido(q?.dados)) return { erro: `O vídeo “${nome}” chegou incompleto. Tente de novo.` };
        const t = tamanho(q.dados);
        if (t > LIMITES_ANEXO.imagem) return { erro: `As cenas do vídeo “${nome}” ficaram grandes demais.` };
        total += t; imagens++;
        const em = Number(q.em) >= 0 ? `${Math.floor(q.em / 60)}:${String(Math.round(q.em % 60)).padStart(2, "0")}` : "";
        if (em) blocos.push({ type: "text", text: `(quadro em ${em})` });
        blocos.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: q.dados } });
      }
      resumo.push({ nome, tipo: "video", quadros: quadros.length });
      continue;
    }
    if (tipo.startsWith("audio/"))
      return { erro: `Ainda não consigo ouvir áudio (“${nome}”). Escreva o que ele diz, ou cole a transcrição.` };
    if (!base64Valido(a?.dados)) return { erro: `O arquivo “${nome}” chegou incompleto. Tente de novo.` };
    const t = tamanho(a.dados);

    if (IMAGEM.has(tipo)) {
      if (t > LIMITES_ANEXO.imagem) return { erro: `A imagem “${nome}” tem ${mb(t)}; o máximo é ${mb(LIMITES_ANEXO.imagem)}.` };
      total += t; imagens++;
      blocos.push(cabeca(), { type: "image", source: { type: "base64", media_type: tipo, data: a.dados } });
      resumo.push({ nome, tipo: "imagem" });
    } else if (tipo === "application/pdf") {
      if (t > LIMITES_ANEXO.pdf) return { erro: `O PDF “${nome}” tem ${mb(t)}; o máximo é ${mb(LIMITES_ANEXO.pdf)}.` };
      total += t;
      blocos.push(cabeca(), { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.dados }, title: nome });
      resumo.push({ nome, tipo: "pdf" });
    } else if (TEXTO.has(tipo) || tipo === XLSX || /\.(csv|txt|md|json|xlsx)$/i.test(nome)) {
      let texto;
      try {
        const buf = Buffer.from(a.dados, "base64");
        if (tipo === XLSX || /\.xlsx$/i.test(nome)) {
          const linhas = lerXlsx(buf).filter(l => l.some(c => String(c).trim()));
          texto = linhas.slice(0, 3000).map(l => l.map(c => String(c ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n")
            + (linhas.length > 3000 ? `\n… (mais ${linhas.length - 3000} linhas não foram lidas)` : "");
        } else if (tipo === "text/csv" || /\.csv$/i.test(nome)) {
          const linhas = lerCSV(buf.toString("utf8"));
          texto = linhas.slice(0, 3000).map(l => l.join("\t")).join("\n")
            + (linhas.length > 3000 ? `\n… (mais ${linhas.length - 3000} linhas não foram lidas)` : "");
        } else texto = buf.toString("utf8");
      } catch (e) {
        return { erro: `Não consegui ler “${nome}”: ${e.message}` };
      }
      if (Buffer.byteLength(texto) > LIMITES_ANEXO.texto) return { erro: `“${nome}” é grande demais para ler de uma vez. Mande só a parte que interessa.` };
      if (!texto.trim()) return { erro: `“${nome}” está vazio.` };
      total += Buffer.byteLength(texto);
      blocos.push(cabeca(), { type: "document", source: { type: "text", media_type: "text/plain", data: texto }, title: nome });
      resumo.push({ nome, tipo: "texto" });
    } else {
      return { erro: `Não consigo ler “${nome}” desse tipo. Mande como foto, print, PDF, planilha (.xlsx/.csv) ou texto.` };
    }
  }
  if (imagens > LIMITES_ANEXO.imagens) return { erro: `São ${imagens} imagens nesta mensagem (contando as cenas dos vídeos); o máximo é ${LIMITES_ANEXO.imagens}.` };
  if (total > LIMITES_ANEXO.total) return { erro: `Os arquivos somam ${mb(total)}; o máximo por mensagem é ${mb(LIMITES_ANEXO.total)}.` };
  return { blocos, resumo };
}

/* O HISTÓRICO NÃO É MAIS "ALIVIADO" AQUI (08/10/2026): trocar o arquivo de
   uma pergunta antiga por um aviso EDITAVA o histórico — a API recusa (ou
   ignora o raciocínio de) histórico editado, e o cache do pedido se perdia,
   pagando tudo de novo. Quando os arquivos pesam, a conversa é RESUMIDA
   (`compactar`, em assistente.js), que é a forma que a API aceita. */
