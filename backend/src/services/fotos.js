/* TRATAMENTO AUTOMÁTICO DAS FOTOS DOS IMÓVEIS (12/10/2026, pedido do Ali).

   O site mostrava a foto ORIGINAL que o corretor subiu, inclusive nas
   miniaturas: uma foto de celular tem de 3 a 6 MB, e uma vitrine com vinte
   imóveis baixava dezenas de MB. É a lentidão que se vê nos concorrentes, e o
   modelo minimalista do Cetrolab sofre mais que todos com foto ruim.

   A cada foto, o servidor faz quatro coisas:

   1. LIMPA O ORIGINAL. Gira conforme o celular gravou (EXIF), limita o maior
      lado a 2048px e regrava em JPEG SEM os metadados. O último ponto não é
      detalhe: a foto tirada com a localização do celular ligada leva a
      COORDENADA EXATA do imóvel dentro do arquivo — e o site esconde o
      endereço de propósito (decisão de 24/09/2026). É este arquivo limpo que
      vai para o site, para os portais (que pedem JPG) e para o WhatsApp.

   2. CRIA VERSÕES MENORES em WebP (480, 960 e 1600px de largura), e a página
      deixa o navegador escolher a que serve para a tela (`srcset`). Uma
      miniatura deixa de baixar a foto inteira.

   3. ACHA ONDE ESTÁ O ASSUNTO da foto (o recorte por "atenção" da biblioteca
      de imagem) e guarda como `foco_x/foco_y`, em porcentagem. Os cards
      recortam a foto; sem o foco, o recorte é sempre no meio, e a varanda à
      direita some.

   4. AVISA QUANDO A FOTO É RUIM — pequena, escura, desfocada ou em pé — e dá
      uma NOTA, para sugerir a melhor capa. Só sugere: a capa é escolha de
      quem captou (a primeira foto), e o sistema não troca sozinho.

   Os limites dos avisos foram calibrados com imagens sintéticas (uma cena
   nítida e a mesma desfocada em vários graus), não com fotos reais de
   imóvel — por isso são CONSERVADORES: melhor deixar de avisar uma foto meio
   ruim do que acusar uma foto boa. Ajusta-se aqui, num lugar só. */
import sharp from "sharp";

// Menos memória e nada guardado entre fotos: o servidor tem outras coisas a fazer.
sharp.cache(false);
sharp.concurrency(1);

export const LARGURAS = [480, 960, 1600];
const MAIOR_LADO = 2048;

export const LIMITES = {
  pequena: 800,        // maior lado abaixo disso: borra no site e os portais recusam
  escura: 60,          // brilho médio (0-255) abaixo disso
  desfocada: 35,       // variância do laplaciano (contraste esticado, cópia de 512px) abaixo disso
};

const avisoTexto = {
  pequena: (d) => `pequena (${d.largura}×${d.altura}) — no site e nos portais fica borrada`,
  escura: () => "escura — no anúncio parece ambiente fechado",
  desfocada: () => "parece desfocada ou tremida",
  em_pe: () => "em pé — nos cards ela é recortada; prefira foto deitada",
};

/* Recebe o arquivo como chegou. Devolve o original limpo, as versões e a
   análise. Lança erro se o arquivo não for uma imagem que a biblioteca abra. */
export async function tratarFoto(buffer) {
  const base = () => sharp(buffer, { failOn: "none" }).rotate();

  // Original limpo: girado, até 2048px, JPEG, sem metadados (sharp não copia
  // EXIF/GPS para a saída a menos que se peça). PNG com transparência ganha
  // fundo branco — JPEG não tem transparência.
  const { data: original, info } = await base()
    .resize({ width: MAIOR_LADO, height: MAIOR_LADO, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const largura = info.width, altura = info.height;

  const variantes = [];
  for (const w of LARGURAS) {
    // Não aumenta foto pequena: a maior versão é a largura que a foto tem.
    const alvo = Math.min(w, largura);
    const data = await sharp(original).resize({ width: alvo }).webp({ quality: 76 }).toBuffer();
    variantes.push({ largura: alvo, buffer: data });
    if (alvo === largura) break;
  }

  const analise = await analisar(original, largura, altura);
  return { original, largura, altura, variantes, ...analise };
}

async function analisar(jpeg, largura, altura) {
  // Brilho e nitidez numa cópia pequena em cinza: rápido, e o tamanho fixo
  // deixa a medida de nitidez comparável entre fotos de resoluções diferentes.
  const cinza = () => sharp(jpeg).resize(512, 512, { fit: "inside" }).greyscale();
  const claro = await cinza().raw().toBuffer();
  let brilho = 0;
  for (let i = 0; i < claro.length; i++) brilho += claro[i];
  brilho /= claro.length;
  // A nitidez é medida com o contraste esticado: foto escura tem pouco
  // contraste e, sem isso, apareceria também como "desfocada" sem estar.
  const { data, info } = await cinza().normalise().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
    s += v; s2 += v * v; n++;
  }
  const nitidez = n ? s2 / n - (s / n) ** 2 : 0;

  const foco = await focoDaFoto(jpeg, largura, altura);

  const chaves = [];
  if (Math.max(largura, altura) < LIMITES.pequena) chaves.push("pequena");
  if (brilho < LIMITES.escura) chaves.push("escura");
  if (nitidez < LIMITES.desfocada) chaves.push("desfocada");
  if (altura > largura * 1.1) chaves.push("em_pe");
  const d = { largura, altura };
  const avisos = chaves.map(k => ({ tipo: k, texto: avisoTexto[k](d) }));

  // A nota serve para COMPARAR as fotos do mesmo imóvel na hora de sugerir a
  // capa — não é uma avaliação para mostrar ao cliente.
  let nota = 100;
  if (chaves.includes("pequena")) nota -= 30;
  if (chaves.includes("escura")) nota -= 25;
  if (chaves.includes("desfocada")) nota -= 30;
  if (chaves.includes("em_pe")) nota -= 20;
  nota -= Math.min(15, Math.abs(brilho - 130) / 6);            // longe do meio-tom
  nota += Math.min(10, Math.log10(Math.max(1, nitidez)) * 3);  // um pouco de crédito pela nitidez
  return {
    brilho: Math.round(brilho), nitidez: Math.round(nitidez),
    foco_x: foco.x, foco_y: foco.y, avisos, nota: Math.max(0, Math.min(100, Math.round(nota))),
  };
}

/* Onde o card deve centrar o recorte, já no formato do `object-position` do
   CSS (0% = encosta à esquerda/topo, 100% = à direita/base). Faz dois recortes
   por "atenção" — um quadrado, que só anda na horizontal, e um bem largo, que
   só anda na vertical — e lê de quanto cada um se deslocou. Imagem que já é
   do formato do recorte não tem para onde andar: fica no meio. */
async function focoDaFoto(jpeg, largura, altura) {
  const lado = 300;
  const eixo = async (cw, ch, campo, total) => {
    const { info } = await sharp(jpeg).resize(cw, ch, { fit: "cover", position: sharp.strategy.attention })
      .toBuffer({ resolveWithObject: true });
    const sobra = total - (campo === "x" ? cw : ch);
    if (sobra <= 1) return 50;
    const desloc = Math.abs(campo === "x" ? info.cropOffsetLeft : info.cropOffsetTop);
    return Math.max(0, Math.min(100, Math.round((desloc / sobra) * 100)));
  };
  try {
    const x = largura > altura ? await eixo(lado, lado, "x", largura * lado / altura) : 50;
    const y = await eixo(lado * 2, lado / 2, "y", altura * (lado * 2) / largura);
    return { x, y };
  } catch { return { x: 50, y: 50 }; }
}

/* A sugestão de capa: a foto de maior nota, se ela não for a capa atual e for
   CLARAMENTE melhor (15 pontos). Diferença pequena não vale mexer na escolha
   de quem captou. */
export function sugestaoDeCapa(fotos) {
  const tratadas = fotos.filter(f => f.nota != null);
  if (tratadas.length < 2 || fotos[0]?.nota == null) return null;
  const melhor = tratadas.reduce((a, b) => (b.nota > a.nota ? b : a));
  return melhor.id !== fotos[0].id && melhor.nota - fotos[0].nota >= 15 ? melhor.id : null;
}
