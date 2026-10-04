/* O DOMÍNIO DA IMOBILIÁRIA CADASTRADO NA HOSPEDAGEM SEM NINGUÉM DO CONHUB
   (04/10/2026, pedido do Ali: "isso tudo precisa ser feito pelo próprio
   cliente").

   O Railway só serve um domínio que esteja cadastrado no serviço — é ele quem
   emite o certificado (o cadeado do https). Até aqui isso era um passo do
   master no painel do Railway. Agora o servidor cadastra o domínio pela API
   pública do Railway (a mesma que o painel usa) e devolve à imobiliária os
   registros de DNS que ELA cria no Registro.br / GoDaddy / Hostinger:

     - o de ROTA (em geral um CNAME `www` → algo.up.railway.app), em
       `status.dnsRecords`;
     - o de VERIFICAÇÃO (um TXT), em `status.verificationDnsHost` +
       `status.verificationToken`. Sem ele o Railway não libera o domínio.

   Precisa de UM token no servidor: `RAILWAY_API_TOKEN` (token de conta ou de
   time, vai como Bearer) ou `RAILWAY_PROJECT_TOKEN` (token do projeto, vai no
   cabeçalho Project-Access-Token). Projeto, ambiente e serviço o próprio
   Railway injeta no servidor (`RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
   `RAILWAY_SERVICE_ID`). Sem o token, nada muda: o domínio continua esperando
   o passo manual do master no hub.

   O QUE NÃO FOI CONFERIDO CONTRA O RAILWAY DE VERDADE: este ambiente não
   alcança a API nem a documentação dele. Os nomes dos campos vêm da
   documentação pública citada em buscas, e as perguntas são feitas de forma a
   sobreviver a um campo que não exista (a pergunta é refeita só com o
   essencial). O primeiro domínio real é o teste — e a tela mostra o erro do
   Railway escrito, em vez de engolir. */

const API = () => process.env.RAILWAY_API_URL || "https://backboard.railway.com/graphql/v2";

export function railwayPronto() {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_PROJECT_TOKEN;
  const falta = [];
  if (!token) falta.push("RAILWAY_API_TOKEN");
  for (const v of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"]) if (!process.env[v]) falta.push(v);
  return { ok: !falta.length, falta };
}

async function gql(query, variables) {
  const headers = { "content-type": "application/json" };
  if (process.env.RAILWAY_API_TOKEN) headers.authorization = `Bearer ${process.env.RAILWAY_API_TOKEN}`;
  else headers["project-access-token"] = process.env.RAILWAY_PROJECT_TOKEN;
  const r = await fetch(API(), { method: "POST", headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (j && j.errors && j.errors.length) throw new Error(j.errors.map(e => e.message).join("; "));
  if (!r.ok || !j || !j.data) throw new Error(`o Railway respondeu ${r.status}`);
  return j.data;
}

const ids = () => ({
  projectId: process.env.RAILWAY_PROJECT_ID,
  environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
  serviceId: process.env.RAILWAY_SERVICE_ID,
});

const CAMPO_INEXISTENTE = /Cannot query field|Unknown argument|not defined by type/i;

/* Lê o estado do domínio no Railway. Primeiro com tudo; se o Railway disser
   que algum campo não existe, de novo só com o essencial (o CNAME). */
async function lerStatus(id) {
  const essencial = "dnsRecords { hostlabel recordType requiredValue currentValue status zone }";
  const tentativas = [
    `${essencial} verificationDnsHost verificationToken verified certificateStatus`,
    `${essencial} verificationToken`,
    essencial,
  ];
  let ultimo;
  for (const campos of tentativas) {
    try {
      const d = await gql(`query($id: String!, $projectId: String!) { customDomain(id: $id, projectId: $projectId) { id domain status { ${campos} } } }`,
        { id, projectId: ids().projectId });
      return d.customDomain;
    } catch (e) {
      ultimo = e;
      if (!CAMPO_INEXISTENTE.test(e.message)) throw e;
    }
  }
  throw ultimo;
}

const tipoDoRegistro = (t) => String(t || "").replace(/^DNS_RECORD_TYPE_/i, "").toUpperCase() || "CNAME";

/* O registrador pede o NOME relativo ao domínio ("www", "_railway-verify.www");
   o Railway pode devolver o endereço inteiro. */
function nomeRelativo(host, zona) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  const z = String(zona || "").toLowerCase().replace(/\.$/, "");
  if (z && h === z) return "@";
  if (z && h.endsWith("." + z)) return h.slice(0, -(z.length + 1));
  return h;
}

/* Registros que a imobiliária precisa criar, no formato da tela:
   [{tipo, nome, valor, ok}] — `ok` é o que o Railway já enxerga propagado. */
export function registrosDaResposta(cd, dominio) {
  const st = (cd && cd.status) || {};
  const zona = (st.dnsRecords || []).map(r => r.zone).find(Boolean) || String(dominio || "").replace(/^www\./, "");
  const lista = (st.dnsRecords || []).filter(r => r && r.requiredValue).map(r => ({
    tipo: tipoDoRegistro(r.recordType),
    nome: nomeRelativo(r.hostlabel || "", zona) || "@",
    valor: String(r.requiredValue).replace(/\.$/, ""),
    ok: /PROPAGATED/i.test(String(r.status || "")),
  }));
  if (st.verificationToken) {
    // Sem o host no retorno, o nome antigo que o Railway usava.
    const rotulo = (lista[0] && lista[0].nome !== "@") ? lista[0].nome : "";
    const host = st.verificationDnsHost || `_railway-verify${rotulo ? "." + rotulo : ""}`;
    lista.push({ tipo: "TXT", nome: nomeRelativo(host, zona), valor: String(st.verificationToken), ok: st.verified === true });
  }
  return lista;
}

/* Cadastra o domínio no serviço. Já cadastrado (o mesmo domínio salvo de
   novo, ou um cadastro que ficou pela metade) não é erro: é procurado na
   lista do serviço e reaproveitado. Devolve {id, registros, certificado}. */
export async function cadastrarDominio(dominio) {
  let id = null;
  try {
    const d = await gql(`mutation($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain } }`,
      { input: { domain: dominio, ...ids() } });
    id = d.customDomainCreate && d.customDomainCreate.id;
  } catch (e) {
    if (!/already|exist|taken|in use/i.test(e.message)) throw e;
    id = await procurar(dominio);
    if (!id) throw new Error(`o Railway diz que ${dominio} já está em uso em outro projeto`);
  }
  if (!id) throw new Error("o Railway não devolveu o cadastro do domínio");
  return { id, ...(await estadoDoDominio(id, dominio)) };
}

async function procurar(dominio) {
  const d = await gql(`query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { customDomains { id domain } } }`, ids());
  const achado = ((d.domains && d.domains.customDomains) || []).find(c => String(c.domain).toLowerCase() === dominio);
  return achado ? achado.id : null;
}

export async function estadoDoDominio(id, dominio) {
  const cd = await lerStatus(id);
  if (!cd) throw new Error("o Railway não encontrou mais este domínio");
  const st = cd.status || {};
  return { registros: registrosDaResposta(cd, dominio), certificado: st.certificateStatus || null };
}

/* Tirar o domínio do serviço quando a imobiliária troca ou apaga. Cortesia: se
   falhar, o domínio só fica sobrando no Railway, sem apontar para ninguém. */
export async function removerDominio(id) {
  if (!id || !railwayPronto().ok) return;
  try { await gql(`mutation($id: String!) { customDomainDelete(id: $id) }`, { id }); }
  catch (e) { console.warn("[railway] remover domínio:", e.message); }
}
