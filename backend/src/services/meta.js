// Busca os dados completos de um lead na Graph API a partir do leadgen_id do webhook.

const VERSION = process.env.META_GRAPH_VERSION || "v19.0";
const PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || "";

export async function fetchLead(leadgenId) {
  if (!PAGE_TOKEN) throw new Error("META_PAGE_ACCESS_TOKEN não configurado");
  const url = `https://graph.facebook.com/${VERSION}/${leadgenId}?access_token=${PAGE_TOKEN}`;
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
