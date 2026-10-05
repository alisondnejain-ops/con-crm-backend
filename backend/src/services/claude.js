/* A CONVERSA COM O CLAUDE QUE USA FERRAMENTAS (05/10/2026).

   O assistente de configuração e a triagem da nuvem de suporte falam com a
   API da Anthropic por aqui — HTTP puro, sem SDK, como o resto do projeto
   (services/ia.js, services/mail.js): cada dependência nova é mais uma coisa
   que pode quebrar o `npm install` numa hospedagem que o Ali administra
   sozinho.

   O que é diferente de `ia.js`: aqui a conversa vai e volta com FERRAMENTAS,
   e o modelo padrão é outro. A leitura do print da Caixa é um pedido só, com
   resposta fixa — o Haiku dá conta. Configurar uma conta é um pedido de vários
   passos ("cria o funil de locação com cinco etapas e liga a roleta na
   terceira"), e quem erra um passo deixa a conta pela metade. Por isso o
   padrão é o Claude Opus 5.5; `ASSISTENTE_MODELO` troca (ex.:
   claude-sonnet-5-5, metade do preço), se o Ali decidir.

   TRÊS REGRAS DA API que não podem ser esquecidas:
   - A resposta do modelo volta para a próxima chamada EXATAMENTE como veio
     (inclusive os blocos de raciocínio, mesmo vazios). Editar o histórico faz
     a API recusar o pedido.
   - `stop_reason: "refusal"` é resposta normal (HTTP 200): o conteúdo pode vir
     vazio. Quem chama confere o motivo antes de ler o texto.
   - Nunca lança. Quem chama sempre tem um caminho sem IA (o suporte humano, as
     telas de sempre). */

const URL_API = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const chave = () => process.env.ANTHROPIC_API_KEY || "";
export const MODELO_ASSISTENTE = () => process.env.ASSISTENTE_MODELO || "claude-opus-5-5";
export const claudeConfigurado = () => !!chave();

/* Modelos com o retry automático do lado da Anthropic quando um filtro de
   segurança recusa o pedido por engano (`fallbacks: "default"`). Nos outros
   o parâmetro não existe e o pedido seria recusado. */
const COM_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5"]);
// O Haiku 4.5 não tem `effort`: mandar o campo dá erro.
const SEM_EFFORT = (m) => /haiku/.test(m);

/* Preço por milhão de tokens, em dólar (tabela pública da Anthropic). A
   leitura do cache custa uma fração da entrada; a escrita, 25% a mais. Modelo
   fora da tabela vira custo nulo — o painel diz que não sabe, em vez de
   inventar. */
const PRECOS = {
  "claude-opus-5-5": { entrada: 4, saida: 20, cache: 0.2 },
  "claude-sonnet-5-5": { entrada: 2, saida: 10, cache: 0.2 },
};
export function custoDaChamada(modelo, u) {
  const p = PRECOS[modelo];
  if (!p || !u) return null;
  return ((u.input_tokens || 0) * p.entrada
    + (u.cache_creation_input_tokens || 0) * p.entrada * 1.25
    + (u.cache_read_input_tokens || 0) * p.cache
    + (u.output_tokens || 0) * p.saida) / 1e6;
}

/* Uma chamada. Devolve { ok, resposta, uso, custo } ou { ok:false, erro }.

   O cache é automático (`cache_control` no topo do pedido): as instruções e a
   lista de ferramentas são iguais em toda chamada, e é isso que torna uma
   conversa de dez idas e voltas barata — da segunda chamada em diante, quase
   toda a entrada é lida do cache. */
export async function chamarClaude({ system, messages, tools, max_tokens = 8000, effort = "medium", timeoutMs = 120000 }) {
  if (!claudeConfigurado()) return { ok: false, erro: "A IA não está configurada neste servidor." };
  const model = MODELO_ASSISTENTE();
  const corpo = {
    model, max_tokens, system, messages,
    cache_control: { type: "ephemeral" },
    ...(tools && tools.length ? { tools } : {}),
    ...(SEM_EFFORT(model) ? {} : { output_config: { effort } }),
    ...(COM_FALLBACK.has(model) ? { fallbacks: "default" } : {}),
  };
  const headers = {
    "content-type": "application/json",
    "x-api-key": chave(),
    "anthropic-version": "2023-06-01",
    ...(COM_FALLBACK.has(model) ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
  };
  let res;
  try {
    res = await fetch(`${URL_API}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const tempo = e.name === "TimeoutError" || e.name === "AbortError";
    return { ok: false, erro: tempo ? "A IA demorou demais para responder. Tente de novo." : "Não consegui falar com o serviço de IA agora." };
  }
  const resposta = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = resposta?.error?.message || `HTTP ${res.status}`;
    console.warn(`[claude] chamada falhou (${res.status}):`, msg);
    if (res.status === 401) return { ok: false, erro: "A chave da IA do servidor é inválida." };
    if (res.status === 429 || res.status === 529) return { ok: false, erro: "A IA está sobrecarregada agora. Tente de novo em um minuto." };
    return { ok: false, erro: "A IA não conseguiu responder agora." };
  }
  const u = resposta.usage || {};
  return {
    ok: true, resposta, modelo: resposta.model || model,
    uso: { entrada: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), saida: u.output_tokens || 0 },
    custo: custoDaChamada(model, u),
  };
}

// O texto que o modelo escreveu para a pessoa ler.
export const textoDe = (resposta) => (resposta?.content || [])
  .filter(b => b.type === "text").map(b => b.text).join("\n").trim();
