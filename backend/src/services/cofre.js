/* O COFRE — criptografia dos segredos guardados no banco e das cópias.
   (02/09/2026, pedido do Ali: "criptografe tudo e aumente a segurança")

   ===== O QUE CRIPTOGRAFAR RESOLVE, E O QUE NÃO RESOLVE =====

   Vale dizer com todas as letras, porque "está criptografado" é a frase que
   mais gera falsa sensação de segurança num sistema.

   A senha do trânsito JÁ é criptografada: o CRM só responde por HTTPS, então
   ninguém no meio do caminho lê nada. Isso não muda aqui.

   O que ESTE arquivo resolve é o dado PARADO: o arquivo do banco no volume da
   hospedagem, e principalmente a CÓPIA DE SEGURANÇA, que sai do nosso servidor
   e vai dormir num armazenamento de terceiros (Cloudflare R2). Uma cópia sem
   criptografia é o CRM inteiro de todos os clientes num arquivo só — leads,
   telefones, conversas, tokens de WhatsApp — e quem puser a mão nela tem tudo.

   O que ele NÃO resolve, e nenhuma criptografia resolveria: quem entra com uma
   senha válida vê o que aquela senha pode ver. Contra isso o que vale é
   permissão, expiração de sessão e trava de força bruta — que estão em
   `auth.js` e `seguranca.js`, não aqui.

   ===== A CHAVE =====

   `CRYPTO_KEY`, 64 caracteres hexadecimais (32 bytes). Gera-se uma com:

       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   Ela é SEPARADA do `JWT_SECRET` de propósito. O JWT_SECRET pode (e deve) ser
   trocado quando houver suspeita de vazamento — trocá-lo só derruba as sessões
   abertas, e todo mundo entra de novo. Se a mesma chave abrisse os dados,
   trocá-la destruiria o banco: os segredos guardados ficariam ilegíveis para
   sempre. Uma chave que não se pode trocar é uma chave que nunca vai ser
   trocada.

   PERDER A CHAVE É PERDER O QUE ELA FECHA. Está escrito no DEPLOY.md e o
   painel de integrações avisa. Por isso o cofre é HONESTO sobre estar
   desligado: sem chave ele não finge que criptografou — devolve o valor como
   está e diz, em vermelho, que a cópia de segurança está em claro. Sistema que
   mente sobre a própria proteção é pior do que sistema sem proteção, porque
   ninguém procura o problema.

   ===== O FORMATO =====

   `enc:v1:<iv em base64>:<tag em base64>:<texto cifrado em base64>`

   O prefixo é o que permite a migração ser invisível: `abrir()` devolve
   qualquer valor SEM o prefixo do jeito que veio. Assim o token do WhatsApp
   que já está gravado em claro continua funcionando no minuto em que esta
   versão sobe, e passa a ser guardado fechado na primeira vez que for
   reescrito — sem nenhuma janela em que o CRM pare de mandar mensagem.

   AES-256-GCM porque ele AUTENTICA além de cifrar: um byte trocado no arquivo
   da cópia faz a abertura falhar em vez de devolver lixo silencioso. Numa
   cópia de segurança isso é a diferença entre "o backup está corrompido" e
   "restauramos um banco com dados embaralhados sem ninguém perceber". */

import crypto from "crypto";

const ALGO = "aes-256-gcm";
export const PREFIXO = "enc:v1:";

function lerChave() {
  const cru = String(process.env.CRYPTO_KEY || "").trim();
  if (!cru) return null;
  if (!/^[0-9a-f]{64}$/i.test(cru)) {
    /* Chave com formato errado é pior que chave ausente: o servidor subiria
       "com criptografia" e falharia na primeira gravação, ou pior, gravaria
       com uma chave derivada de um valor errado. Melhor recusar e dizer o
       tamanho que chegou — é o mesmo remédio da conferência do R2, e pelo
       mesmo motivo: o erro é sempre de colar. */
    console.error(`[cofre] CRYPTO_KEY tem ${cru.length} caracteres e o esperado são 64 (números e letras de a-f). ` +
      `Gere uma com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))". ` +
      `Enquanto isso, os segredos e a cópia de segurança ficam SEM criptografia.`);
    return null;
  }
  return Buffer.from(cru, "hex");
}

let CHAVE = lerChave();
export const cofreLigado = () => !!CHAVE;

/* Só para os testes: troca a chave em memória sem mexer no ambiente. Em
   produção ninguém chama isto — a chave vem da variável, uma vez, no start. */
export function _usarChaveDeTeste(hex) {
  CHAVE = hex ? Buffer.from(hex, "hex") : null;
}

/* Fecha um texto. Sem chave, devolve o texto como veio — e é de propósito:
   travar a gravação faria a falta de uma variável de ambiente derrubar o
   cadastro do WhatsApp, que é o oposto de segurança. Quem avisa que está
   desligado é o painel. */
export function fechar(texto) {
  if (texto === null || texto === undefined || texto === "") return texto;
  if (!CHAVE) return texto;
  const s = String(texto);
  if (s.startsWith(PREFIXO)) return s;              // já está fechado
  const iv = crypto.randomBytes(12);                // 96 bits, o tamanho que o GCM quer
  const c = crypto.createCipheriv(ALGO, CHAVE, iv);
  const cifrado = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return PREFIXO + [iv, c.getAuthTag(), cifrado].map(b => b.toString("base64")).join(":");
}

/* Abre um texto fechado. Valor SEM o prefixo volta como veio — é o que faz a
   migração acontecer sozinha, sem uma janela de indisponibilidade. */
export function abrir(valor) {
  if (valor === null || valor === undefined || valor === "") return valor;
  const s = String(valor);
  if (!s.startsWith(PREFIXO)) return s;
  if (!CHAVE) {
    /* Dado fechado e chave ausente é o pior caso operacional: o WhatsApp para
       de mandar mensagem e nada na tela explica. O log precisa dizer a causa
       exata, porque o sintoma vai chegar como "parou de enviar". */
    console.error("[cofre] existe dado criptografado no banco e a CRYPTO_KEY não está no servidor. " +
      "Sem ela o WhatsApp não envia e a cópia de segurança não abre. Recoloque a chave que foi usada para gravar.");
    return null;
  }
  try {
    const [, , iv, tag, dados] = s.split(":");
    const d = crypto.createDecipheriv(ALGO, CHAVE, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return d.update(Buffer.from(dados, "base64"), undefined, "utf8") + d.final("utf8");
  } catch (e) {
    // Chave trocada, ou arquivo adulterado. Nos dois casos o valor não serve —
    // devolver lixo seria pior do que devolver nada.
    console.error("[cofre] não consegui abrir um valor: " + e.message + " (a CRYPTO_KEY é a mesma que gravou?)");
    return null;
  }
}

/* Fecha e abre ARQUIVO (a cópia de segurança). Igual ao de texto, mas em
   bytes e com o cabeçalho na frente, para o arquivo se identificar sozinho:
   quem for restaurar daqui a um ano precisa saber, olhando o arquivo, se ele
   está fechado e com qual versão do formato. */
const MARCA = Buffer.from("CONHUB1\n");   // 8 bytes

export const arquivoFechado = (buf) =>
  Buffer.isBuffer(buf) && buf.length > MARCA.length && buf.subarray(0, MARCA.length).equals(MARCA);

export function fecharArquivo(buffer) {
  if (!CHAVE) return { buffer, criptografado: false };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, CHAVE, iv);
  const dados = Buffer.concat([c.update(buffer), c.final()]);
  return { buffer: Buffer.concat([MARCA, iv, c.getAuthTag(), dados]), criptografado: true };
}

export function abrirArquivo(buffer) {
  if (!arquivoFechado(buffer)) return buffer;      // cópia antiga, gravada em claro
  if (!CHAVE) throw new Error("Esta cópia está criptografada e a CRYPTO_KEY não está configurada neste servidor.");
  const iv = buffer.subarray(8, 20);
  const tag = buffer.subarray(20, 36);
  const d = crypto.createDecipheriv(ALGO, CHAVE, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buffer.subarray(36)), d.final()]);
}

/* ===== TOKEN DE LINK GUARDADO COMO IMPRESSÃO DIGITAL =====

   O token do link de "criar senha" NÃO é criptografado — é RESUMIDO (hash), e
   a diferença é a que importa: criptografia é reversível, e um segredo que o
   servidor consegue reverter é um segredo que alguém com acesso ao banco
   também reverte. O resumo não volta.

   Ninguém precisa ler esse token de volta: o link chega pelo e-mail, o
   servidor resume o que chegou e compara com o que está gravado. Guardá-lo em
   claro fazia da CÓPIA DE SEGURANÇA uma lista de links prontos para trocar a
   senha de qualquer conta pendente.

   SHA-256 puro, sem bcrypt de propósito: o token tem 24 bytes de aleatório de
   verdade (não é uma senha que alguém escolheu), então não há dicionário a
   proteger — e ele é conferido em toda abertura do link, onde o custo do
   bcrypt apareceria sem comprar nada. */
export const resumoDeToken = (t) =>
  t ? crypto.createHash("sha256").update(String(t)).digest("hex") : null;
