// Busca os dados completos de um lead na Graph API a partir do leadgen_id do webhook.

const VERSION = process.env.META_GRAPH_VERSION || "v19.0";
const PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || "";

export async function fetchLead(leadgenId) {
  if (!PAGE_TOKEN) throw new Error("META_PAGE_ACCESS_TOKEN não configurado");
  /* OS CAMPOS DE ATRIBUICAO PRECISAM SER PEDIDOS PELO NOME.

     A Graph API devolve um conjunto minimo quando ninguem pede nada, e campanha,
     conjunto, anuncio e formulario NAO estao nele. Era por isso que essa
     informacao se perdia: nao e que o codigo jogasse fora, e que nunca chegou.

     E dado que nao volta. Lead que entrou ontem sem a campanha gravada perdeu a
     atribuicao para sempre — nao ha de onde reprocessar. Por isso isto entra
     antes de qualquer tela que va usar.

     `platform` diz se veio do Facebook ou do Instagram, que e a pergunta que a
     gestao faz antes mesmo de olhar campanha. */
  const campos = [
    "id", "created_time", "field_data", "platform",
    "campaign_id", "campaign_name", "adset_id", "adset_name",
    "ad_id", "ad_name", "form_id",
  ].join(",");
  const url = `https://graph.facebook.com/${VERSION}/${leadgenId}?fields=${campos}&access_token=${PAGE_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Graph API falhou (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();

  // field_data: [{ name, values: [...] }]
  const field = {};
  (data.field_data || []).forEach(f => { field[f.name] = (f.values && f.values[0]) || ""; });

  const pick = (frag) => {
    const key = Object.keys(field).find(k => k.toLowerCase().includes(frag));
    return key ? field[key] : "";
  };

  return {
    meta_lead_id: data.id,
    /* A origem em duas camadas: `source` e de onde o lead entrou no CRM (e o
       que o relatorio agrupa), e os demais dizem exatamente qual anuncio o
       trouxe. Guardar os ids ALEM dos nomes e o que permite reconciliar com o
       Gerenciador depois — nome de campanha muda, id nao. */
    source: "meta",
    platform: data.platform || null,
    campaign_id: data.campaign_id || null,
    campaign_name: data.campaign_name || null,
    adset_id: data.adset_id || null,
    adset_name: data.adset_name || null,
    ad_id: data.ad_id || null,
    ad_name: data.ad_name || null,
    form_id: data.form_id || null,
    // O nome do formulario nao vem no mesmo pedido; fica para quando alguem
    // precisar dele, em vez de custar uma segunda chamada em todo lead.
    form_name: null,
    name: field.full_name || field.nome_completo || pick("nome") || "",
    phone: field.phone_number || pick("telefone") || pick("phone") || "",
    email: field.email || pick("email") || "",
    qual: {
      renda: pick("renda"),
      entrada: pick("entrada") || pick("disponível") || pick("disponivel"),
      situacao: pick("situação") || pick("situacao") || pick("profissional"),
      cpf: pick("cpf") || pick("restrição") || pick("restricao"),
      prazo: pick("tempo") || pick("prazo"),
    },
  };
}
