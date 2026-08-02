/* Leitura do print da simulação da Caixa.

   O simulador roda no site da Caixa, em outra aba, e o navegador proíbe uma
   página de ler o conteúdo de outra — é trava de segurança, não limitação
   nossa. Não há API pública. Então o caminho é o corretor mandar o print e
   alguém ler os números da imagem.

   "Alguém ler" hoje significa modelo de visão. Usamos a API da Anthropic por
   HTTP puro, sem SDK, igual ao e-mail em services/mail.js.

   TRÊS CUIDADOS, e o primeiro é o que mais importa:

   1) O que sai daqui é RASCUNHO, nunca mensagem pronta. Número de
      financiamento errado indo para o cliente é estrago de verdade — some
      confiança e pode virar promessa que a Conecta não cumpre. Por isso a
      tela sempre mostra os valores para o corretor conferir e corrigir antes
      de enviar. O modelo lê bem, mas "bem" não é "sempre".

   2) Sem ANTHROPIC_API_KEY tudo aqui devolve `configurado:false` e a tela
      esconde o botão de ler. O registro manual continua funcionando.

   3) O modelo devolve JSON e nada mais. Se vier outra coisa, tratamos como
      falha em vez de tentar adivinhar — melhor o corretor digitar do que o
      sistema inventar. */

const CHAVE = process.env.ANTHROPIC_API_KEY || "";
// Haiku dá conta de ler números de uma tela e custa uma fração de centavo por
// print. Trocável por variável se um dia precisar de mais precisão.
const MODELO = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

export const iaConfigurada = () => !!CHAVE;

const INSTRUCAO = `Você recebe a captura de tela do resultado de uma simulação de
financiamento habitacional da Caixa Econômica Federal, em português do Brasil.

Extraia os valores e responda APENAS com um objeto JSON, sem texto antes ou depois,
sem cercas de código. Use este formato exato:

{"valor_imovel":numero|null,"entrada":numero|null,"subsidio":numero|null,
"financiado":numero|null,"prazo_meses":numero|null,"parcela":numero|null,
"juros_aa":numero|null,"renda":numero|null,"modalidade":texto|null,"confianca":"alta"|"media"|"baixa"}

Regras:
- Números em reais vão SEM símbolo, SEM ponto de milhar e com ponto decimal: 1180.55
- "parcela" é a PRIMEIRA prestação, a maior; se houver faixa, use a inicial
- "prazo_meses" em meses; se a tela mostrar anos, multiplique por 12
- "juros_aa" é a taxa ao ano em porcentagem: 8.99
- "modalidade" é o nome do programa quando aparecer (ex.: Minha Casa Minha Vida, SBPE)
- Campo que você não encontrar com certeza: null. NÃO estime, NÃO invente
- "confianca" é sua avaliação da leitura: "baixa" se a imagem estiver cortada,
  borrada ou se não parecer uma simulação da Caixa`;

/* Devolve { ok, dados } ou { ok:false, erro }. Nunca lança: o registro manual
   da simulação não pode quebrar porque a leitura automática falhou. */
export async function lerPrintSimulacao({ base64, mime }) {
  if (!iaConfigurada()) return { ok: false, erro: "Leitura automática não configurada." };
  if (!base64) return { ok: false, erro: "Sem imagem." };
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime || ""))
    return { ok: false, erro: "Mande o print como imagem (JPG ou PNG)." };

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CHAVE,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
            { type: "text", text: INSTRUCAO },
          ],
        }],
      }),
    });
  } catch (e) {
    return { ok: false, erro: "Não consegui falar com o serviço de leitura: " + e.message };
  }

  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = corpo?.error?.message || `HTTP ${res.status}`;
    console.warn("[ia] leitura falhou:", msg);
    return { ok: false, erro: res.status === 401 ? "Chave da IA inválida." : "A leitura falhou: " + msg };
  }

  const texto = (corpo.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  // O modelo às vezes envolve em ```json apesar da instrução; tiramos antes de ler.
  const limpo = texto.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let dados;
  try { dados = JSON.parse(limpo); }
  catch { return { ok: false, erro: "Não consegui ler os valores desse print. Digite na mão." }; }

  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  return {
    ok: true,
    dados: {
      valor_imovel: num(dados.valor_imovel),
      entrada: num(dados.entrada),
      subsidio: num(dados.subsidio),
      financiado: num(dados.financiado),
      prazo_meses: num(dados.prazo_meses),
      parcela: num(dados.parcela),
      juros_aa: num(dados.juros_aa),
      renda: num(dados.renda),
      modalidade: typeof dados.modalidade === "string" ? dados.modalidade.slice(0, 60) : null,
      confianca: ["alta", "media", "baixa"].includes(dados.confianca) ? dados.confianca : "media",
    },
  };
}
