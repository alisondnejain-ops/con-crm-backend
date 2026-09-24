/* PORTAIS DE IMÓVEIS (24/09/2026): o catálogo sai para a internet e o lead
   que o portal gera entra na catraca, sem ninguém digitar nada duas vezes.

   São dois caminhos, nos dois sentidos:

   1. ANÚNCIO SAI — um FEED XML por imobiliária, num endereço com token opaco,
      que a imobiliária cola no painel do portal. O portal lê o arquivo de
      tempos em tempos (algumas vezes por dia) e publica/atualiza/remove os
      anúncios sozinho. Não existe "enviar para o portal": quem busca é ele.
      Dois formatos, porque os portais não concordam entre si:
        - VRSync  — Grupo OLX (ZAP Imóveis, VivaReal e OLX).
        - Chaves na Mão — formato próprio (<Document>/<imoveis>/<imovel>,
          as 53 tags em minúsculo, todas presentes mesmo vazias).

   2. LEAD ENTRA — um webhook por imobiliária, com OUTRO token (ver o
      comentário da tabela `portais_config` em db.js), que cria o lead pela
      mesma regra do WhatsApp: atendente da vez, funil de quem recebe.

   ENTRA NO FEED SÓ O QUE ESTÁ PRONTO. Anúncio com pendência (sem foto, sem
   descrição, sem bairro) o portal recusa ou publica mal — e a imobiliária só
   descobre olhando o portal. Aqui ele fica FORA do arquivo, e a tela de
   Portais diz exatamente o que falta em cada um. */
import { randomBytes, randomUUID } from "crypto";
import db from "../db.js";
import { proximoAtendente } from "./catraca.js";
import { entradaDe } from "./pipelines.js";
import { normalizePhone } from "./stages.js";
import { avisar } from "./push.js";
import { mascararTelefone } from "../seguranca.js";

const novoToken = () => randomBytes(24).toString("hex");

export function configDaOrg(orgId) {
  let c = db.prepare("SELECT * FROM portais_config WHERE org_id = ?").get(orgId);
  if (!c) {
    db.prepare("INSERT INTO portais_config (org_id,token_feed,token_leads,created_at) VALUES (?,?,?,?)")
      .run(orgId, novoToken(), novoToken(), Date.now());
    c = db.prepare("SELECT * FROM portais_config WHERE org_id = ?").get(orgId);
  }
  return c;
}

export function salvarContato(orgId, { email, telefone }) {
  configDaOrg(orgId);
  db.prepare("UPDATE portais_config SET email = ?, telefone = ? WHERE org_id = ?")
    .run(String(email || "").trim() || null, String(telefone || "").trim() || null, orgId);
  return configDaOrg(orgId);
}

/* Trocar o token é o "tranca a porta" de quando o endereço vazou. O do feed
   obriga a colar o endereço novo em cada portal, por isso é um de cada vez. */
export function trocarToken(orgId, qual) {
  configDaOrg(orgId);
  const col = qual === "leads" ? "token_leads" : "token_feed";
  db.prepare(`UPDATE portais_config SET ${col} = ? WHERE org_id = ?`).run(novoToken(), orgId);
  return configDaOrg(orgId);
}

// Token só com hex, 48 caracteres: o que não tem essa forma nem chega ao banco.
const tokenValido = (t) => /^[a-f0-9]{48}$/.test(String(t || ""));
export const orgPorTokenFeed = (t) => tokenValido(t) ? db.prepare("SELECT org_id FROM portais_config WHERE token_feed = ?").get(t)?.org_id || null : null;
export const orgPorTokenLeads = (t) => tokenValido(t) ? db.prepare("SELECT org_id FROM portais_config WHERE token_leads = ?").get(t)?.org_id || null : null;

/* ===== O QUE FALTA EM CADA ANÚNCIO ===== */

export const MIN_DESCRICAO = 50;

const fotosDe = (id) => db.prepare("SELECT url FROM produto_midias WHERE produto_id = ? AND tipo = 'foto' ORDER BY ordem, created_at").all(id).map(f => f.url);

/* `bloqueia` tira do feed; `aviso` não tira, mas o anúncio sai pior (o
   portal posiciona pior quem tem poucas fotos, e sem CEP o mapa erra). */
export function pendencias(p, fotos = fotosDe(p.id)) {
  const bloqueia = [], aviso = [];
  if (!p.titulo || p.titulo.trim().length < 10) bloqueia.push("título com pelo menos 10 letras");
  const desc = (p.descricao || "").trim();
  if (desc.length < MIN_DESCRICAO) bloqueia.push(desc ? `descrição com pelo menos ${MIN_DESCRICAO} letras (tem ${desc.length})` : "descrição do anúncio");
  if (!(p.valor > 0)) bloqueia.push(p.finalidade === "aluguel" ? "valor do aluguel" : "valor do imóvel");
  if (!p.uf) bloqueia.push("estado (UF)");
  if (!p.cidade) bloqueia.push("cidade");
  if (!p.bairro) bloqueia.push("bairro");
  if (!fotos.length) bloqueia.push("pelo menos uma foto");
  if (p.tipo === "casa") {
    if (!(p.area_util > 0)) bloqueia.push("área construída (m²)");
    if (!(p.quartos > 0)) bloqueia.push("quartos");
    if (!(p.banheiros > 0)) bloqueia.push("banheiros");
  } else if (!(p.metragem > 0)) bloqueia.push("área do terreno (m²)");
  if (!p.cep) aviso.push("CEP (sem ele o mapa do portal pode errar o ponto)");
  if (!p.endereco) aviso.push("rua");
  if (fotos.length && fotos.length < 5) aviso.push(`mais fotos (tem ${fotos.length}; anúncio com 5+ aparece melhor)`);
  return { bloqueia, aviso, pronto: bloqueia.length === 0 };
}

export function produtosPublicaveis(orgId) {
  return db.prepare("SELECT * FROM produtos WHERE org_id = ? AND status = 'ativo' AND publicar_portais = 1 ORDER BY created_at")
    .all(orgId);
}

/* Resumo para a tela: cada imóvel marcado para publicar, com o que falta. E
   os ativos NÃO marcados contados à parte — o gestor precisa saber que eles
   existem, senão "3 no portal" parece o catálogo inteiro. */
export function situacaoDaOrg(orgId) {
  const marcados = produtosPublicaveis(orgId).map(p => {
    const fotos = fotosDe(p.id);
    return { id: p.id, titulo: p.titulo, finalidade: p.finalidade, tipo: p.tipo, fotos: fotos.length, ...pendencias(p, fotos) };
  });
  const naoMarcados = db.prepare("SELECT COUNT(*) n FROM produtos WHERE org_id = ? AND status = 'ativo' AND COALESCE(publicar_portais,0) = 0").get(orgId).n;
  return { marcados, prontos: marcados.filter(m => m.pronto).length, nao_marcados: naoMarcados };
}

/* ===== XML ===== */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// CDATA não aceita "]]>" dentro; partir em dois blocos é o jeito padrão.
const cdata = (s) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const num = (v) => (v == null || v === "" || !isFinite(Number(v)) ? "" : String(Math.round(Number(v) * 100) / 100));

const ESTADOS = { AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
  PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins" };

/* Coordenadas: as colunas, se alguém preencheu; senão, o link do Google
   Maps que o captador já colava ("@-9.39,-40.50" ou "q=-9.39,-40.50"). Sem
   isso o portal geolocaliza pelo endereço — pior, mas funciona. */
export function coordenadas(p) {
  if (p.latitude != null && p.longitude != null) return { lat: p.latitude, lng: p.longitude };
  const m = String(p.maps_url || "").match(/[@=](-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

// URL de foto antiga pode estar sem domínio; o portal precisa dela absoluta.
const absoluta = (url, base) => (/^https?:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`);

const dataVR = (ms) => new Date(ms || Date.now()).toISOString().slice(0, 19);
const dataCNM = (ms) => {
  const d = new Date(ms || Date.now()), z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};

function contatoDaOrg(orgId) {
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId) || {};
  const cfg = configDaOrg(orgId);
  const dono = db.prepare(`SELECT name, email, phone FROM users WHERE org_id = ? AND status = 'ativo'
    AND (id = ? OR role = 'adm') ORDER BY (id = ?) DESC LIMIT 1`).get(orgId, org.dono_user_id || "", org.dono_user_id || "") || {};
  return { nome: org.name || "Imobiliária", email: cfg.email || dono.email || "", telefone: cfg.telefone || dono.phone || "" };
}

/* VRSync — Grupo OLX (ZAP Imóveis, VivaReal, OLX). */
export function feedVRSync(orgId, base) {
  const c = contatoDaOrg(orgId);
  const itens = produtosPublicaveis(orgId).map(p => ({ p, fotos: fotosDe(p.id) })).filter(({ p, fotos }) => pendencias(p, fotos).pronto);
  const listings = itens.map(({ p, fotos }) => {
    const aluguel = p.finalidade === "aluguel";
    const geo = coordenadas(p);
    const exibir = { bairro: "Neighborhood", rua: "Street", completo: "All" }[p.exibir_endereco] || "Neighborhood";
    const tipo = p.tipo === "terreno" ? "Residential / Land Lot" : "Residential / Home";
    return `    <Listing>
      <ListingID>${esc(p.id)}</ListingID>
      <Title>${cdata(p.titulo.slice(0, 100))}</Title>
      <TransactionType>${aluguel ? "For Rent" : "For Sale"}</TransactionType>
      <PublicationType>STANDARD</PublicationType>
      <Media>
${fotos.slice(0, 50).map((u, i) => `        <Item medium="image"${i === 0 ? ' primary="true"' : ""}>${esc(absoluta(u, base))}</Item>`).join("\n")}
      </Media>
      <Details>
        <UsageType>Residential</UsageType>
        <PropertyType>${tipo}</PropertyType>
        <Description>${cdata(p.descricao)}</Description>
        ${aluguel ? `<RentalPrice currency="BRL" period="Monthly">${num(p.valor)}</RentalPrice>` : `<ListPrice currency="BRL">${num(p.valor)}</ListPrice>`}
${p.condominio > 0 ? `        <PropertyAdministrationFee currency="BRL">${num(p.condominio)}</PropertyAdministrationFee>\n` : ""}${p.iptu > 0 ? `        <YearlyTax currency="BRL">${num(p.iptu)}</YearlyTax>\n` : ""}${p.tipo === "casa" && p.area_util > 0 ? `        <LivingArea unit="square metres">${num(p.area_util)}</LivingArea>\n` : ""}${p.metragem > 0 ? `        <LotArea unit="square metres">${num(p.metragem)}</LotArea>\n` : ""}${p.tipo === "casa" ? `        <Bedrooms>${num(p.quartos)}</Bedrooms>
        <Bathrooms>${num(p.banheiros)}</Bathrooms>
${p.suites > 0 ? `        <Suites>${num(p.suites)}</Suites>\n` : ""}${p.vagas > 0 ? `        <Garage type="Parking Space">${num(p.vagas)}</Garage>\n` : ""}` : ""}      </Details>
      <Location displayAddress="${exibir}">
        <Country abbreviation="BR">Brasil</Country>
        <State abbreviation="${esc(p.uf)}">${esc(ESTADOS[p.uf] || p.uf)}</State>
        <City>${esc(p.cidade)}</City>
        <Neighborhood>${esc(p.bairro)}</Neighborhood>
${p.endereco ? `        <Address>${esc(p.endereco)}</Address>\n` : ""}${p.numero_end ? `        <StreetNumber>${esc(p.numero_end)}</StreetNumber>\n` : ""}${p.complemento ? `        <Complement>${esc(p.complemento)}</Complement>\n` : ""}${p.cep ? `        <PostalCode>${esc(p.cep)}</PostalCode>\n` : ""}${geo ? `        <Latitude>${geo.lat}</Latitude>\n        <Longitude>${geo.lng}</Longitude>\n` : ""}      </Location>
      <ContactInfo>
        <Name>${esc(c.nome)}</Name>
        <Email>${esc(c.email)}</Email>
        <Telephone>${esc(c.telefone)}</Telephone>
      </ContactInfo>
    </Listing>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListingDataFeed xmlns="http://www.vivareal.com/schemas/1.0/VRSync" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.vivareal.com/schemas/1.0/VRSync  http://xml.vivareal.com/vrsync.xsd">
  <Header>
    <Provider>${esc(c.nome)}</Provider>
    <Email>${esc(c.email)}</Email>
    <ContactName>${esc(c.nome)}</ContactName>
    <PublishDate>${dataVR()}</PublishDate>
    <Telephone>${esc(c.telefone)}</Telephone>
  </Header>
  <Listings>
${listings.join("\n")}
  </Listings>
</ListingDataFeed>
`;
}

/* Chaves na Mão — as 53 tags, NESTA ordem e todas presentes mesmo vazias
   (é o que o validador deles exige). Foto: até 30, sem PNG, URL com extensão;
   vídeo só do YouTube — os nossos são arquivos enviados, então vai vazio. */
const TAGS_CNM = ["referencia", "codigo_cliente", "link_cliente", "titulo", "transacao", "transacao2", "finalidade", "finalidade2",
  "destaque", "tipo", "tipo2", "valor", "valor_locacao", "valor_iptu", "valor_condominio", "area_total", "area_util", "conservacao",
  "quartos", "suites", "garagem", "banheiro", "closet", "salas", "despensa", "bar", "cozinha", "quarto_empregada", "escritorio",
  "area_servico", "lareira", "varanda", "lavanderia", "aceita_pet", "estado", "cidade", "bairro", "cep", "endereco", "numero",
  "complemento", "esconder_endereco_imovel", "descritivo", "fotos_imovel", "data_atualizacao", "latitude", "longitude", "video",
  "tour_360", "area_comum", "area_privativa", "aceita_troca", "periodo_locacao"];

export function feedChavesNaMao(orgId, base) {
  const itens = produtosPublicaveis(orgId).map(p => ({ p, fotos: fotosDe(p.id) })).filter(({ p, fotos }) => pendencias(p, fotos).pronto);
  const imoveis = itens.map(({ p, fotos }) => {
    const aluguel = p.finalidade === "aluguel";
    const geo = coordenadas(p);
    const quando = dataCNM(p.atualizado_em || p.created_at);
    const fotosOk = fotos.map(u => absoluta(u, base)).filter(u => /\.(jpe?g|webp|gif)(\?|$)/i.test(u)).slice(0, 30);
    const v = {
      referencia: esc(p.id), codigo_cliente: esc(p.id), titulo: cdata(p.titulo),
      transacao: aluguel ? "L" : "V", finalidade: "RE", destaque: "0",
      tipo: p.tipo === "terreno" ? "Terreno" : "Casa",
      valor: aluguel ? "" : num(p.valor), valor_locacao: aluguel ? num(p.valor) : "",
      valor_iptu: p.iptu > 0 ? num(p.iptu) : "", valor_condominio: p.condominio > 0 ? num(p.condominio) : "",
      area_total: num(p.metragem), area_util: p.tipo === "casa" ? num(p.area_util) : "",
      quartos: p.tipo === "casa" ? num(p.quartos) : "", suites: num(p.suites), garagem: num(p.vagas),
      banheiro: p.tipo === "casa" ? num(p.banheiros) : "",
      estado: esc(p.uf), cidade: esc(p.cidade), bairro: esc(p.bairro), cep: esc(p.cep || ""),
      endereco: esc(p.endereco || ""), numero: esc(p.numero_end || ""), complemento: esc(p.complemento || ""),
      // O Chaves na Mão só sabe esconder ou mostrar a rua inteira.
      esconder_endereco_imovel: p.exibir_endereco === "bairro" || !p.exibir_endereco ? "1" : "0",
      descritivo: cdata(p.descricao),
      fotos_imovel: "\n" + fotosOk.map(u => `        <foto>\n          <url>${esc(u)}</url>\n          <data_atualizacao>${quando}</data_atualizacao>\n        </foto>`).join("\n") + "\n      ",
      data_atualizacao: quando,
      latitude: geo ? String(geo.lat) : "", longitude: geo ? String(geo.lng) : "",
      periodo_locacao: aluguel ? "Mensal" : "",
    };
    return `    <imovel>\n${TAGS_CNM.map(t => `      <${t}>${v[t] ?? ""}</${t}>`).join("\n")}\n    </imovel>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document>
  <imoveis>
${imoveis.join("\n")}
  </imoveis>
</Document>
`;
}

/* ===== LEAD QUE CHEGA DO PORTAL ===== */

/* Nome amigável do portal. O Grupo OLX manda `leadOrigin` ("ZAP",
   "VivaReal", "OLX"); os outros, quando mandam alguma coisa, mandam no nome
   que quiserem — e o `?portal=` do endereço é a saída para eles. */
export function nomeDoPortal(bruto) {
  const s = String(bruto || "").toLowerCase();
  if (s.includes("zap")) return "ZAP Imóveis";
  if (s.includes("viva")) return "VivaReal";
  if (s.includes("olx")) return "OLX";
  if (s.includes("chaves")) return "Chaves na Mão";
  if (s.includes("imovelweb")) return "Imovelweb";
  return String(bruto || "").trim().slice(0, 40) || "Portal de imóveis";
}

/* Os campos que o Grupo OLX manda (name, email, ddd, phone, phoneNumber,
   message, clientListingId, originLeadId, leadOrigin), mais os nomes em
   português que outros portais e integradores usam. Um formulário cada, e o
   lead não pode se perder porque um deles chamou "telefone" de "fone". */
export function lerLead(b, portalDoEndereco) {
  const pegar = (...chaves) => {
    for (const k of chaves) {
      const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), b);
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return "";
  };
  let tel = pegar("phoneNumber", "phone", "telefone", "celular", "fone", "cliente.telefone", "lead.phone");
  const ddd = pegar("ddd", "cliente.ddd");
  if (ddd && tel && tel.replace(/\D/g, "").length <= 9) tel = ddd + tel;
  return {
    portal: nomeDoPortal(pegar("leadOrigin", "portal", "origem", "source") || portalDoEndereco),
    externo: pegar("originLeadId", "leadId", "lead_id", "id"),
    nome: pegar("name", "nome", "cliente.nome", "lead.name").slice(0, 120),
    email: pegar("email", "cliente.email", "lead.email").slice(0, 160),
    telefone: tel ? normalizePhone(tel) : "",
    mensagem: pegar("message", "mensagem", "comentario", "observacao", "lead.message").slice(0, 2000),
    codigo: pegar("clientListingId", "codigo_cliente", "referencia", "codigo", "listingId", "imovel.codigo"),
  };
}

export function receberLead(orgId, dados) {
  const { portal, externo, nome, email, telefone, mensagem, codigo } = dados;
  if (!telefone && !email) return { ok: false, status: 400, erro: "O lead chegou sem telefone e sem e-mail — não há como falar com ele." };

  if (externo) {
    const ja = db.prepare("SELECT lead_id FROM portais_leads WHERE org_id = ? AND portal = ? AND externo_id = ?").get(orgId, portal, externo);
    if (ja) return { ok: true, repetido: true, lead_id: ja.lead_id };
  }

  const produto = codigo ? db.prepare("SELECT id, titulo FROM produtos WHERE org_id = ? AND id = ?").get(orgId, codigo) : null;
  const texto = [
    `Veio do ${portal}${produto ? ` — interessado em: ${produto.titulo}` : codigo ? ` — anúncio ${codigo}` : ""}.`,
    mensagem ? `Mensagem do cliente: "${mensagem}"` : null,
    email ? `E-mail: ${email}` : null,
  ].filter(Boolean).join("\n");

  // Mesmo telefone = mesma pessoa: um lead só, com a história inteira.
  let lead = telefone ? db.prepare("SELECT * FROM leads WHERE org_id = ? AND phone = ?").get(orgId, telefone) : null;
  if (!lead && email) lead = db.prepare("SELECT * FROM leads WHERE org_id = ? AND LOWER(email) = LOWER(?)").get(orgId, email);
  const agora = Date.now();
  let novo = false;

  db.transaction(() => {
    if (!lead) {
      novo = true;
      const id = "l_" + randomUUID();
      const dono = proximoAtendente(orgId);
      const entrada = entradaDe(orgId, dono);
      db.prepare(`INSERT INTO leads (id,org_id,name,phone,email,origem,priority,qual_json,stage,assigned_to,created_at,
                  pipeline_id,stage_id,stage_entered_at,last_interaction_at,source,assigned_at)
        VALUES (?,?,?,?,?,?,NULL,'{}',?,?,?, ?,?,?,?, 'portal',?)`)
        .run(id, orgId, nome || `Contato do ${portal}`, telefone || null, email || null, portal,
             entrada.nome, dono, agora, entrada.pipeline_id, entrada.stage_id, agora, agora, dono ? agora : null);
      lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
    }
    // Observação e não mensagem: o cliente não escreveu no WhatsApp, e o
    // texto na conversa pareceria enviado por ele ali. A faixa âmbar acima
    // da conversa é o que quem vai atender lê antes de falar.
    db.prepare("INSERT INTO observacoes (id,org_id,lead_id,texto,autor_id,created_at) VALUES (?,?,?,?,NULL,?)")
      .run("o_" + randomUUID(), orgId, lead.id, texto, agora);
    if (externo) db.prepare("INSERT OR IGNORE INTO portais_leads (org_id,portal,externo_id,lead_id,created_at) VALUES (?,?,?,?,?)")
      .run(orgId, portal, externo, lead.id, agora);
  })();

  if (lead.assigned_to)
    avisar(lead.assigned_to, {
      titulo: novo ? `Lead novo do ${portal}` : `${lead.name} voltou pelo ${portal}`,
      corpo: produto ? produto.titulo : (mensagem || "Abra o CRM para atender."),
      leadId: lead.id,
    }).catch(() => {});
  console.log(`[portais] lead ${novo ? "NOVO" : "existente"} do ${portal} (${mascararTelefone(telefone || "")})${
    novo ? (lead.assigned_to ? " — para a atendente da vez" : " — sem atendente, foi para a fila") : ""}`);
  return { ok: true, novo, lead_id: lead.id };
}
