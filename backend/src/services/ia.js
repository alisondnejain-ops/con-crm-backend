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
// Qual modelo está atendendo. Só para o diagnóstico — a chave nunca sai daqui.
export const modeloIA = () => MODELO;

/* Uma chamada ao modelo, sem SDK — do mesmo jeito que o e-mail fala com o
   Resend. Fica separada porque agora tem mais de um uso (ler o print da
   simulação e resumir a conversa), e conversa com API tem sempre os mesmos
   três tropeços: rede caída, chave errada e resposta que não é o que se
   esperava. Um lugar só para tratar os três.

   Nunca lança: quem chama sempre tem um caminho manual, e recurso automático
   que derruba o manual é pior do que não existir. */
async function perguntar({ content, max_tokens = 600, system }) {
  if (!iaConfigurada()) return { ok: false, erro: "IA não configurada." };
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
        max_tokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content }],
      }),
    });
  } catch (e) {
    return { ok: false, erro: "Não consegui falar com o serviço de IA: " + e.message };
  }

  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = corpo?.error?.message || `HTTP ${res.status}`;
    console.warn("[ia] chamada falhou:", msg);
    return { ok: false, erro: res.status === 401 ? "Chave da IA inválida." : "A IA falhou: " + msg };
  }
  const texto = (corpo.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  // Quanto custou. Vai para o log e para o diagnóstico: gasto de IA que
  // ninguém mede vira surpresa na fatura.
  const uso = corpo.usage ? { entrada: corpo.usage.input_tokens, saida: corpo.usage.output_tokens } : null;
  return { ok: true, texto, uso };
}

// O modelo às vezes envolve o JSON em ```json apesar da instrução.
const limparCercas = (t) => String(t || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

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

  const r = await perguntar({
    max_tokens: 600,
    content: [
      { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
      { type: "text", text: INSTRUCAO },
    ],
  });
  if (!r.ok) return { ok: false, erro: r.erro };

  let dados;
  try { dados = JSON.parse(limparCercas(r.texto)); }
  catch { return { ok: false, erro: "Não consegui ler os valores desse print. Digite na mão." }; }

  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  return {
    ok: true,
    uso: r.uso,
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

/* ===== RESUMO DA CONVERSA =====

   Para que serve: a atendente repassa um lead com 40 mensagens e o corretor
   precisa saber, em dez segundos, o que já foi conversado. Hoje ele rola a
   tela inteira — ou, o que acontece de verdade, não rola e pergunta de novo
   coisas que o cliente já respondeu.

   Três decisões que valem estar escritas:

   1) É LEITURA, não escrita. O resumo aparece na ficha, para o corretor.
      Nada daqui vai para o cliente, então um erro do modelo custa um
      desentendimento interno, não uma promessa falsa feita à Conecta.

   2) O modelo responde JSON com campos curtos, e não um texto corrido. Texto
      corrido convida o modelo a floreio e o corretor a não ler. Campo curto
      obriga os dois a serem objetivos — e deixa a tela mostrar "não disse"
      quando o cliente não disse, que é uma informação e tanto.

   3) O que o cliente NÃO disse é tão útil quanto o que disse. Por isso o
      campo `faltando`: é a lista do que o corretor ainda precisa perguntar. */

const INSTRUCAO_RESUMO = `Você é assistente de uma imobiliária brasileira e vai ler a
conversa de WhatsApp entre a equipe e um cliente que quer comprar imóvel.

Responda APENAS com um objeto JSON, sem texto antes ou depois, sem cercas de código:

{"situacao":texto,"quer":texto|null,"pode_pagar":texto|null,"combinado":texto|null,
"proximo_passo":texto,"faltando":[texto],"atencao":texto|null}

Regras:
- Escreva em português do Brasil, direto, como um colega passando o caso para outro
- "situacao": 1 ou 2 frases sobre em que pé está o atendimento
- "quer": que tipo de imóvel o cliente procura (bairro, quartos, finalidade). null se não deu para saber
- "pode_pagar": renda, entrada, parcela ou financiamento que o cliente mencionou, com os números que ele falou. null se não falou
- "combinado": o que ficou acertado (visita marcada, documento pedido, retorno prometido). null se nada
- "proximo_passo": a ação mais útil AGORA, começando com um verbo
- "faltando": até 4 informações importantes que o cliente ainda não disse
- "atencao": só preencha se houver risco real — cliente irritado, falando com outra
  imobiliária, prazo apertado, negócio esfriando. Caso contrário, null
- NÃO invente nada. Se a conversa não disser, use null ou deixe fora
- Nunca repita dados sensíveis como CPF ou documento`;

/* Devolve { ok, resumo, uso } ou { ok:false, erro }.

   `mensagens` chega na ordem da conversa, cada uma { de, texto, quando }.
   Mandamos as últimas 120: conversa de imobiliária raramente passa disso, e o
   começo de uma muito longa quase nunca muda o que fazer agora. */
export async function resumirConversa({ mensagens, nome }) {
  if (!iaConfigurada()) return { ok: false, erro: "Resumo automático não configurado." };
  const uteis = (mensagens || []).filter(m => (m.texto || "").trim());
  if (uteis.length < 2) return { ok: false, erro: "Conversa curta demais para resumir." };

  const linhas = uteis.slice(-120)
    .map(m => `${m.de === "cliente" ? "CLIENTE" : "IMOBILIÁRIA"}: ${String(m.texto).replace(/\s+/g, " ").trim().slice(0, 600)}`)
    .join("\n");

  const r = await perguntar({
    max_tokens: 700,
    content: [{ type: "text", text: `${INSTRUCAO_RESUMO}\n\nCliente: ${nome || "sem nome"}\n\nCONVERSA:\n${linhas}` }],
  });
  if (!r.ok) return { ok: false, erro: r.erro };

  let d;
  try { d = JSON.parse(limparCercas(r.texto)); }
  catch { return { ok: false, erro: "A IA respondeu fora do formato. Tente de novo." }; }

  const txt = (v, max = 400) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    ok: true,
    uso: r.uso,
    resumo: {
      situacao: txt(d.situacao) || "Sem leitura clara da conversa.",
      quer: txt(d.quer, 200),
      pode_pagar: txt(d.pode_pagar, 200),
      combinado: txt(d.combinado, 300),
      proximo_passo: txt(d.proximo_passo, 200),
      faltando: Array.isArray(d.faltando) ? d.faltando.map(f => txt(f, 90)).filter(Boolean).slice(0, 4) : [],
      atencao: txt(d.atencao, 200),
      mensagens_lidas: Math.min(uteis.length, 120),
    },
  };
}
