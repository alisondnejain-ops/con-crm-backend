/* O PAÍS PADRÃO DA CONTA (02/11/2026, pedido do Ali depois do Fabian, argentino,
   na VJ). Número que chega SEM o código do país era lido sempre como
   brasileiro: "11 2222-3333" de um argentino virava um número de São Paulo que
   não é de ninguém, e quando ele escrevia pelo WhatsApp (que traz o número de
   verdade) nascia um segundo lead.

   Uma conta que atende sobretudo gente de fora escolhe o país em
   Configurações → Atendimento, e ele passa a valer em todo lugar onde alguém
   (ou um formulário) escreve um número sem o "+": formulário do anúncio,
   portais, cadastro na mão, planilha, listas do Marketing. Número COM o código
   continua valendo como veio, e o que chega pelo WhatsApp sempre traz o
   código — esses não mudam.

   Nulo = Brasil. Nenhuma conta muda de comportamento sem escolher. */
import db from "../db.js";
import { paisPorIso } from "./telefone.js";

export function paisDaOrg(orgId) {
  if (!orgId) return "BR";
  const r = db.prepare("SELECT pais_padrao FROM orgs WHERE id = ?").get(orgId);
  return (r?.pais_padrao && paisPorIso(r.pais_padrao)) ? r.pais_padrao : "BR";
}

export function definirPaisDaOrg(orgId, iso) {
  const p = paisPorIso(iso);
  if (!p) return { erro: "País desconhecido." };
  db.prepare("UPDATE orgs SET pais_padrao = ? WHERE id = ?").run(p.iso === "BR" ? null : p.iso, orgId);
  return { pais: p.iso };
}
