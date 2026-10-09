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
// Lido a cada chamada: trocar a variável no Railway vale no próximo start, e o
// teste consegue trocar de modelo sem reimportar o arquivo.
const modeloAtual = () => (process.env.ANTHROPIC_MODEL || "").trim() || "claude-haiku-4-5-20251001";

export const iaConfigurada = () => !!CHAVE;
// Qual modelo está atendendo. Só para o diagnóstico — a chave nunca sai daqui.
export const modeloIA = () => modeloAtual();

/* OS MODELOS DA FAMÍLIA 5 PENSAM ANTES DE RESPONDER, POR PADRÃO (09/10/2026,
   relato do Ali depois de trocar ANTHROPIC_MODEL para o Sonnet 5.5: "só envia
   a primeira mensagem"). O raciocínio sai do MESMO limite (`max_tokens`) que a
   resposta: com 500, o "Oi" cabia, e na segunda mensagem — mais conversa para
   pensar — o raciocínio comia o limite, o JSON saía cortado e o robô ficava
   calado ("a IA respondeu fora do formato"), sem nada na tela.

   Para estes modelos: limite folgado (só se paga o que é usado) e esforço
   baixo — são respostas de uma ou duas frases, e cada segundo pensando é um
   segundo a mais com o cliente esperando. No Sonnet 5.5 o raciocínio é
   desligado (`between_tools`, o modo sem pensar dele). O Haiku 4.5, padrão
   daqui, não tem nada disso e mandar os campos daria erro. */
const PENSA_POR_PADRAO = (m) => /claude-(opus|sonnet|haiku|fable)-5/.test(m);
const LIMITE_COM_RACIOCINIO = 4000;

/* Uma chamada ao modelo, sem SDK — do mesmo jeito que o e-mail fala com o
   Resend. Fica separada porque agora tem mais de um uso (ler o print da
   simulação e resumir a conversa), e conversa com API tem sempre os mesmos
   três tropeços: rede caída, chave errada e resposta que não é o que se
   esperava. Um lugar só para tratar os três.

   Nunca lança: quem chama sempre tem um caminho manual, e recurso automático
   que derruba o manual é pior do que não existir. */
async function perguntar({ content, max_tokens = 600, system }) {
  if (!iaConfigurada()) return { ok: false, erro: "IA não configurada." };
  const MODELO = modeloAtual();
  const pensa = PENSA_POR_PADRAO(MODELO);
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
        max_tokens: pensa ? Math.max(max_tokens, LIMITE_COM_RACIOCINIO) : max_tokens,
        ...(pensa ? { output_config: { effort: "low" } } : {}),
        ...(/claude-sonnet-5-5/.test(MODELO) ? { thinking: { type: "between_tools" } } : {}),
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
  /* Resposta cortada ou recusada vem com HTTP 200. Sem conferir o motivo, o
     pedaço de JSON virava "fora do formato" e ninguém sabia que era o limite. */
  if (corpo.stop_reason === "max_tokens") {
    console.warn(`[ia] resposta cortada pelo limite de tamanho (${MODELO}, max_tokens ${pensa ? Math.max(max_tokens, LIMITE_COM_RACIOCINIO) : max_tokens})`);
    return { ok: false, erro: "A resposta da IA saiu cortada (limite de tamanho)." };
  }
  if (corpo.stop_reason === "refusal") {
    console.warn(`[ia] o modelo recusou responder (${MODELO})`);
    return { ok: false, erro: "A IA recusou responder a esta conversa." };
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

/* ===== EM QUE ETAPA DO FUNIL ESTE LEAD ESTÁ =====

   A regra por palavra-chave (services/stages.js) é boa quando a palavra é
   dita. Ela não tem como acertar quando a equipe fala "vou precisar dos seus
   comprovantes" em vez de "documentação", ou quando o cliente já visitou e
   ninguém escreveu "visita". A IA lê a conversa inteira e diz onde o
   atendimento está de verdade.

   A REGRA DA CASA CONTINUA VALENDO: isto é LEITURA. O que sai daqui é uma
   SUGESTÃO, mostrada ao corretor com o motivo. Quem grava a etapa é o clique
   dele, pela mesma rota manual de sempre. Etapa move relatório, relatório vira
   cobrança em reunião — não é lugar para o sistema decidir sozinho e a pessoa
   descobrir depois.

   Por isso a resposta traz `porque` e `trecho`: sugestão sem a frase que a
   sustenta é palpite, e ninguém confirma palpite sobre o próprio trabalho. */
const INSTRUCAO_ETAPA = `Você é assistente de uma imobiliária brasileira. Leia a conversa
de WhatsApp entre a equipe e um cliente e diga em que ETAPA do funil o atendimento está.

As etapas, em ordem, e o que cada uma significa DE FATO:
- "Lead": só chegou. Nenhum contato de verdade ainda, ou só saudação
- "Atendimento": a equipe iniciou a conversa e o cliente respondeu; estão conversando
- "Pasta": documentos foram pedidos ou enviados (RG, CPF, comprovante de renda, extrato)
- "Aprovação": a análise de crédito está em andamento, saiu aprovada ou reprovada
- "Agendamento": ficou combinado conhecer o imóvel — dia, hora ou "vou levar você lá"
- "Visita": o cliente JÁ VISITOU o imóvel; falam do que ele achou depois de ver
- "Proposta": há negociação de valor, oferta, contraproposta ou pedido de desconto
- "Venda": negócio fechado — contrato, assinatura, pagamento de sinal

Responda APENAS com um objeto JSON, sem texto antes ou depois, sem cercas de código:

{"etapa":"<uma das etapas acima>","confianca":"alta"|"media"|"baixa","porque":texto,"trecho":texto|null}

Regras:
- Escolha a etapa MAIS ADIANTADA que a conversa comprove ter acontecido
- Comprovar é diferente de mencionar: "depois a gente vê a documentação" NÃO é Pasta;
  "me manda o RG" ou "segue meu comprovante" é Pasta
- Falar em conhecer o imóvel é "Agendamento". Só é "Visita" se o cliente JÁ FOI
- "porque": uma frase curta em português dizendo o que na conversa comprova a etapa
- "trecho": a frase da conversa que mais sustenta a escolha, copiada tal como está
  (até 160 caracteres). null se não houver uma frase clara
- "confianca": "baixa" quando a conversa é curta, confusa ou quase toda por áudio/foto
- Na dúvida entre duas etapas, escolha a MENOS adiantada. Empurrar o funil para
  frente sem prova é o erro caro aqui
- NÃO invente. Se a conversa não mostrar nada além de saudação, responda "Lead"`;

const ETAPAS_IA = ["Lead", "Atendimento", "Pasta", "Aprovação", "Agendamento", "Visita", "Proposta", "Venda"];

/* Devolve { ok, sugestao:{etapa,confianca,porque,trecho,mensagens_lidas}, uso }.

   `mensagens` chega na ordem da conversa, cada uma { de, texto }. Mesma janela
   do resumo: as últimas 120. */
export async function etapaDaConversa({ mensagens, nome }) {
  if (!iaConfigurada()) return { ok: false, erro: "Leitura da etapa por IA não configurada." };
  const uteis = (mensagens || []).filter(m => (m.texto || "").trim());
  if (uteis.length < 2) return { ok: false, erro: "Conversa curta demais para saber a etapa." };

  const linhas = uteis.slice(-120)
    .map(m => `${m.de === "cliente" ? "CLIENTE" : "IMOBILIÁRIA"}: ${String(m.texto).replace(/\s+/g, " ").trim().slice(0, 600)}`)
    .join("\n");

  const r = await perguntar({
    max_tokens: 400,
    content: [{ type: "text", text: `${INSTRUCAO_ETAPA}\n\nCliente: ${nome || "sem nome"}\n\nCONVERSA:\n${linhas}` }],
  });
  if (!r.ok) return { ok: false, erro: r.erro };

  let d;
  try { d = JSON.parse(limparCercas(r.texto)); }
  catch { return { ok: false, erro: "A IA respondeu fora do formato. Tente de novo." }; }

  // Etapa fora da lista é resposta inútil: melhor falhar do que gravar um nome
  // que o funil não conhece.
  const etapa = ETAPAS_IA.find(e => e.toLowerCase() === String(d.etapa || "").trim().toLowerCase());
  if (!etapa) return { ok: false, erro: "A IA respondeu uma etapa que não existe no funil." };

  const txt = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    ok: true,
    uso: r.uso,
    sugestao: {
      etapa,
      confianca: ["alta", "media", "baixa"].includes(d.confianca) ? d.confianca : "baixa",
      porque: txt(d.porque, 300) || "A IA não explicou a escolha.",
      trecho: txt(d.trecho, 160),
      mensagens_lidas: Math.min(uteis.length, 120),
    },
  };
}

/* ===== A TEMPERATURA DO LEAD, LIDA NA CONVERSA =====

   Temperatura é a pergunta "quão perto de comprar este cliente está?". Ela
   vinha de um chute: todo lead do WhatsApp nascia "morno", e a tela mostrava
   isso como se alguém tivesse avaliado.

   Aqui a IA lê o que o cliente disse e responde. Como o resto, ela devolve o
   MOTIVO — temperatura sem justificativa é a mesma marcação sem dono que já
   existia, só que mais cara. */
const INSTRUCAO_TEMPERATURA = `Você é assistente de uma imobiliária brasileira. Leia a
conversa de WhatsApp entre a equipe e um cliente e diga o quanto ele está PERTO DE COMPRAR.

- "QUENTE": demonstra intenção clara e prazo curto. Pede visita, manda documento, fala em
  valor de entrada, pergunta como fechar, responde rápido e puxa a conversa
- "MORNO": tem interesse real mas sem urgência. Faz perguntas, pede informação, some e volta,
  diz que "está pesquisando" ou "mais pra frente"
- "FRIO": não avança. Só cumprimentou, sumiu depois da primeira resposta, disse que não tem
  interesse, não tem condição agora, ou o número não é de um comprador

Responda APENAS com um objeto JSON, sem texto antes ou depois, sem cercas de código:

{"temperatura":"QUENTE"|"MORNO"|"FRIO","confianca":"alta"|"media"|"baixa","porque":texto}

Regras:
- "porque": uma frase curta em português dizendo o que na conversa levou a essa leitura
- Olhe o que o CLIENTE fez, não o que a imobiliária escreveu. Corretor animado não
  esquenta lead
- Cliente que parou de responder há muitas mensagens é FRIO, por mais que o começo
  tenha sido bom
- "confianca": "baixa" quando a conversa é curta, confusa ou quase toda por áudio e foto
- Na dúvida entre dois, escolha o MENOS quente. Lead superestimado tira o corretor de
  quem estava pronto para comprar`;

const TEMPERATURAS_IA = ["QUENTE", "MORNO", "FRIO"];

export async function temperaturaDaConversa({ mensagens, nome }) {
  if (!iaConfigurada()) return { ok: false, erro: "Leitura de temperatura por IA não configurada." };
  const uteis = (mensagens || []).filter(m => (m.texto || "").trim());
  if (uteis.length < 2) return { ok: false, erro: "Conversa curta demais para avaliar." };

  const linhas = uteis.slice(-120)
    .map(m => `${m.de === "cliente" ? "CLIENTE" : "IMOBILIÁRIA"}: ${String(m.texto).replace(/\s+/g, " ").trim().slice(0, 600)}`)
    .join("\n");

  const r = await perguntar({
    max_tokens: 300,
    content: [{ type: "text", text: `${INSTRUCAO_TEMPERATURA}\n\nCliente: ${nome || "sem nome"}\n\nCONVERSA:\n${linhas}` }],
  });
  if (!r.ok) return { ok: false, erro: r.erro };

  let d;
  try { d = JSON.parse(limparCercas(r.texto)); }
  catch { return { ok: false, erro: "A IA respondeu fora do formato." }; }

  const t = TEMPERATURAS_IA.find(x => x === String(d.temperatura || "").trim().toUpperCase());
  if (!t) return { ok: false, erro: "A IA respondeu uma temperatura que não existe." };

  const txt = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return { ok: true, uso: r.uso, leitura: {
    temperatura: t,
    confianca: ["alta", "media", "baixa"].includes(d.confianca) ? d.confianca : "baixa",
    porque: txt(d.porque, 240) || "A IA não explicou a leitura.",
    mensagens_lidas: Math.min(uteis.length, 120),
  } };
}

/* ===== PRIMEIRO ATENDIMENTO FORA DO EXPEDIENTE =====

   Este é o único lugar do CRM em que a IA FALA COM O CLIENTE. Todo o resto —
   resumo, etapa, temperatura — é leitura para gente de dentro ler. Aqui o
   texto sai pelo WhatsApp da imobiliária, com o nome dela, e não tem desfazer.

   O que ela pode e não pode dizer é definido por CADA CONTA, nas orientações
   (Configurações → Autoatendimento). O texto fixo daqui só ensina a conversar
   e a não inventar o que não está escrito. */

// Os cinco campos da ficha — os mesmos que o formulário do Meta preenche.
/* Os campos mudam conforme a pessoa quer COMPRAR ou ALUGAR.

   Até 16/08/2026 só existia o conjunto da compra, e o robô perguntava
   "quanto você tem de entrada?" para quem tinha acabado de dizer que queria
   alugar. Três dos cinco campos são os mesmos nos dois casos; os outros dois
   é que trocam — entrada vira orçamento de aluguel, e restrição no CPF vira
   a garantia (fiador, depósito, seguro-fiança). */
export const CAMPOS_SIMULACAO = ["renda", "entrada", "situacao", "cpf", "prazo"];
export const CAMPOS_ALUGUEL = ["renda", "orcamento", "situacao", "garantia", "prazo"];
export const camposDa = (finalidade) =>
  String(finalidade || "").toLowerCase().startsWith("alug") ? CAMPOS_ALUGUEL : CAMPOS_SIMULACAO;
// Tudo que a IA pode devolver, incluindo a própria finalidade.
const CAMPOS_ROBO = [...new Set([...CAMPOS_SIMULACAO, ...CAMPOS_ALUGUEL, "finalidade"])];

/* O NOME DA IMOBILIÁRIA ENTRA AQUI, e não fica escrito no prompt.

   Este texto sai pelo WhatsApp, para o cliente. Enquanto a plataforma teve uma
   casa só, o nome dela no meio da instrução era inofensivo; com outras
   imobiliárias assinando, seria a IA se apresentando com o nome do concorrente
   na primeira mensagem do primeiro contato — o erro mais caro possível, no
   lugar mais visível possível.

   A cidade saiu junto, pelo mesmo motivo: dizer a região errada a quem mora
   em outra é pior do que não dizer região nenhuma. */
/* AS REGRAS SÃO DE CADA CLIENTE (08/10/2026, pedido do Ali: "a regra ali vai
   ser definida por cada cliente que se cadastrar"). Até aqui este texto trazia
   um roteiro (comprar ou alugar primeiro, renda/entrada/CPF/prazo, "a equipe
   volta amanhã") e uma lista de proibições fixas (preço, aprovação, visita,
   imóvel num bairro) que valiam mais que tudo o que a equipe escrevesse. Agora
   fica só o JEITO DE CONVERSAR — o que vale para qualquer negócio — e o que a
   IA faz, pergunta e não pode fazer vem das orientações da conta. As
   proibições antigas viraram sugestões de um clique na tela (SUGESTOES_ENSINO,
   em app.jsx). */
const instrucaoAtendimento = (imobiliaria) => `Você atende o WhatsApp da ${imobiliaria || "imobiliária"}.
Seu trabalho é receber bem a pessoa, ENTENDER o que ela precisa e anotar as informações para a
equipe, seguindo as ORIENTAÇÕES DA EQUIPE abaixo — são elas que dizem o que você faz, o que
pergunta e o que não pode fazer.

A REGRA MAIS IMPORTANTE: RESPONDA ANTES DE PERGUNTAR.
Você é uma conversa, não um formulário. A cada mensagem:
1. reaja ao que a pessoa acabou de dizer, com as palavras dela;
2. se ela fez uma pergunta, responda — ou diga com honestidade que quem responde é a equipe;
3. só então, se couber, faça UMA pergunta.
Nunca emende uma pergunta nova por cima de algo que a pessoa disse e você ignorou.

NÃO INVENTE: só diga o que estiver nas orientações, na ficha do produto ou na própria conversa.
Endereço, valor, disponibilidade ou condição que não está escrito aqui, diga que a equipe confirma.

COMO FALAR
- Português do Brasil, informal e caloroso, como um atendente no WhatsApp
- Mensagens CURTAS: uma ou duas frases. Ninguém lê parágrafo no WhatsApp
- UMA pergunta por mensagem, no máximo
- Pode usar no máximo um emoji, e só quando couber
- Trate a pessoa pelo primeiro nome depois que ela disser
- Não repita fórmulas ("perfeito!", "ótimo!") em toda mensagem: ninguém fala assim
- Se ela perguntar se você é um robô ou um sistema, diga a verdade em uma frase, sem drama,
  e siga a conversa

ÁUDIO E FOTO: você recebe só o rótulo ("Áudio", "Foto"), não o conteúdo. Se vier áudio, peça
com jeito para a pessoa mandar por escrito, dizendo que agora você não consegue ouvir.

QUANDO ENCERRAR (encerrar: true):
- Quando tiver entendido o que a pessoa precisa (e o que as orientações mandam colher), OU a
  pessoa não quiser mais responder, OU ela só quiser deixar recado. Na despedida diga, com suas
  palavras, que anotou tudo e que a equipe dá continuidade. Sem prometer horário.
- Uma despedida NÃO tem pergunta no fim. Se você está encerrando, encerre.

Responda APENAS com um objeto JSON, sem texto antes ou depois, sem cercas de código:

{"texto":"a mensagem que vai para o cliente","coletado":{"finalidade":"comprar|alugar","renda":"...","entrada":"...","orcamento":"...","situacao":"...","cpf":"...","garantia":"...","prazo":"..."},"encerrar":true|false}

Em "coletado", inclua SÓ o que a pessoa realmente disse, com as palavras dela. "situacao" é o
resumo do que ela procura e contou. Campo que ela não respondeu fica fora do objeto. Nunca
deduza, nunca preencha por educação.`;

const FORMATO_EXTRA = `

No JSON da resposta, acrescente também (quando couber): "campos":{"chave":"valor"}, "resumo":"...", "interessado":true|false.`;

export async function atenderPrimeiroContato({ mensagens, nome, coletado = {}, restantes = null, orientacoes = [], imobiliaria = "",
  produto = null, campos = [], resumo = false }) {
  if (!iaConfigurada()) return { ok: false, erro: "Atendimento automático por IA não configurado." };

  const linhas = (mensagens || []).slice(-40)
    .map(m => `${m.de === "cliente" ? "CLIENTE" : "VOCÊ"}: ${String(m.texto || "").replace(/\s+/g, " ").trim().slice(0, 600)}`)
    .join("\n");

  /* Quantas mensagens ainda cabem nesta conversa.

     Sem isto, o robô batia o teto no meio de uma pergunta e sumia — o cliente
     ficava falando sozinho depois de "e qual a sua renda?". Agora ele sabe
     quando está chegando ao fim e se despede como gente se despede. */
  const aviso = restantes == null ? ""
    : restantes <= 1
      ? `\n\nATENÇÃO: esta é a SUA ÚLTIMA MENSAGEM nesta conversa. Não faça mais nenhuma
pergunta. Encerre agora com uma despedida calorosa: agradeça, diga que anotou tudo, e explique
que o corretor responsável vai dar continuidade em breve com as opções. Devolva encerrar: true.`
      : restantes <= 2
        ? `\n\nATENÇÃO: só cabem mais ${restantes} mensagens suas nesta conversa. Comece a fechar:
pergunte no máximo mais uma coisa, a mais importante que ainda falta, e prepare a despedida.`
        : "";

  /* O que a equipe ensinou (Configurações → Fora do expediente).

     Desde 08/10/2026 são AS regras do atendimento: não existe mais lista de
     proibições fixa no código acima delas (pedido do Ali — cada cliente define
     as suas). Sem nenhuma orientação, vale o mínimo: acolher e passar adiante. */
  const ensino = (orientacoes || []).filter(t => String(t || "").trim()).slice(0, 30);
  const bloco = ensino.length ? `

ORIENTAÇÕES DA EQUIPE DESTA IMOBILIÁRIA — as regras deste atendimento. Siga-as no jeito de
conversar, no que perguntar e no que NÃO fazer. Se alguma proíbe algo, não faça, nem se a pessoa
insistir.
${ensino.map(t => `- ${String(t).trim().slice(0, 500)}`).join("\n")}` : `

A EQUIPE AINDA NÃO ESCREVEU ORIENTAÇÕES: acolha, entenda o que a pessoa procura e diga que a
equipe dá continuidade. Não prometa nada que não esteja escrito aqui.`;

  /* O PRODUTO DESTE ATENDIMENTO (08/10/2026): a ficha que a equipe escreveu
     para o empreendimento do anúncio ou da catraca. Também entra DEPOIS das
     proibições, pelo mesmo motivo do ensino — é texto escrito fora do código. */
  const blocoProduto = produto && produto.texto ? `

O PRODUTO DESTE ATENDIMENTO — a pessoa chegou pelo anúncio ou pela fila deste produto: ${produto.nome}.
Use estas informações para responder sobre ELE (localização, características, diferenciais, o que
a equipe explicou). Fale só do que está escrito aqui; o que não estiver, diga que o corretor
responde. As orientações da equipe continuam valendo.
${String(produto.texto).slice(0, 5000)}` : "";

  /* OS CAMPOS QUE ELA PODE PREENCHER (08/10/2026, escolhidos pelo gestor). */
  const listaCampos = (campos || []).slice(0, 15);
  const blocoCampos = listaCampos.length ? `

CAMPOS DA FICHA QUE VOCÊ PODE PREENCHER — devolva em "campos" só os que a pessoa deixou claros na
conversa, com a chave exata. Em campo com opções, use exatamente uma das opções.
${listaCampos.map(c => `- ${c.chave} (${c.nome})${c.opcoes && c.opcoes.length ? `: uma de ${c.opcoes.join(" | ")}` : ""}${c.tipo === "boolean" ? ": sim ou não" : ""}${c.valor !== undefined && c.valor !== null && c.valor !== "" ? ` — já preenchido: ${Array.isArray(c.valor) ? c.valor.join(", ") : c.valor}` : ""}`).join("\n")}` : "";

  const blocoResumo = resumo ? `

QUANDO VOCÊ ENCERRAR, escreva também em "resumo" um resumo do atendimento para a equipe (o que a
pessoa quer, o que ela contou, o que ficou combinado e o que falta), seguindo o formato que as
orientações da equipe pedirem, se pedirem. E diga em "interessado" se a pessoa quer seguir com o
atendimento (true) ou não (false — só deixou recado, desistiu ou não quis responder).` : "";

  const jaTem = Object.keys(coletado || {}).filter(k => coletado[k]);
  const contexto = jaTem.length
    ? `\n\nVOCÊ JÁ ANOTOU (não pergunte de novo): ${jaTem.map(k => `${k} = ${coletado[k]}`).join("; ")}`
    : "";

  const r = await perguntar({
    max_tokens: 500,
    content: [{ type: "text", text:
      `${instrucaoAtendimento(imobiliaria)}${bloco}${blocoProduto}${blocoCampos}${blocoResumo}${listaCampos.length || resumo ? FORMATO_EXTRA : ""}\n\nNome que aparece no WhatsApp: ${nome || "não sei"}${contexto}${aviso}\n\nCONVERSA ATÉ AGORA:\n${linhas}` }],
  });
  if (!r.ok) return { ok: false, erro: r.erro };

  let d;
  try { d = JSON.parse(limparCercas(r.texto)); }
  catch { return { ok: false, erro: "A IA respondeu fora do formato." }; }

  const texto = typeof d.texto === "string" ? d.texto.trim() : "";
  // Sem texto não há o que enviar. Melhor a conversa ficar parada para a
  // atendente ver amanhã do que sair um balão vazio no WhatsApp do cliente.
  if (!texto) return { ok: false, erro: "A IA não devolveu mensagem para enviar." };

  const limpo = {};
  for (const c of CAMPOS_ROBO) {
    const v = d.coletado && d.coletado[c];
    if (typeof v === "string" && v.trim()) limpo[c] = v.trim().slice(0, 200);
  }

  // Campos da ficha: só as chaves que foram oferecidas.
  const chaves = new Set(listaCampos.map(c => c.chave));
  const camposOut = {};
  if (d.campos && typeof d.campos === "object" && !Array.isArray(d.campos))
    for (const [k, v] of Object.entries(d.campos)) if (chaves.has(k) && v !== null && v !== "") camposOut[k] = Array.isArray(v) ? v.slice(0, 10).map(String) : typeof v === "boolean" || typeof v === "number" ? v : String(v).slice(0, 200);
  return { ok: true, uso: r.uso, resposta: {
    texto: texto.slice(0, 900),
    coletado: limpo,
    campos: camposOut,
    resumo: resumo && typeof d.resumo === "string" ? d.resumo.trim().slice(0, 2000) : "",
    interessado: d.interessado === true,
    // Na última mensagem o encerramento não é opinião da IA: a conversa acabou
    // de qualquer jeito, e marcar isso mantém a tela dizendo a verdade.
    encerrar: d.encerrar === true || (restantes != null && restantes <= 1),
  } };
}
