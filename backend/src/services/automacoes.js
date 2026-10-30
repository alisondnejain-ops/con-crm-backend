/* GATILHOS DOS FLUXOS (03/10/2026, pedido do Ali: "os fluxos hoje funcionam
   apenas para envio de mensagens… esquecemos de trabalhar a parte de gatilho;
   preciso ter várias opções de gatilhos prontos, e um deles ser formulário
   preenchido" — e o exemplo do construtor da Hommio/Clint/Pipedrive).

   Um fluxo passa a ter um GATILHO no bloco de início:

     manual      → "Disparo em massa": ninguém entra sozinho; o fluxo é usado
                   num disparo, como sempre foi. É o que todo fluxo antigo é.
     formulario  → um dos formulários de anúncio escolhidos foi preenchido
                   (vários desde 08/10/2026).
     lead_novo   → um lead novo entrou (WhatsApp, formulário, portal, cadastro
                   na mão — planilha importada fica de fora de propósito).
     etapa       → um lead entrou numa etapa do funil.
     etiqueta    → uma etiqueta foi colocada num lead.
     campo       → um campo personalizado ganhou um valor (08/10/2026).

   Este arquivo só faz uma coisa: quando o evento acontece, coloca o lead na
   automação (uma EXECUÇÃO, a mesma tabela do disparo). Quem anda pelo fluxo
   é o batimento de sempre (services/disparo.js → processarDisparos). Por isso
   ele NÃO importa o motor: é chamado de dentro de moverEtapa, marcarTag,
   receberLead e do nascimento do lead pelo WhatsApp, e precisa ser barato e
   sem ciclo de import. E NUNCA LANÇA: uma automação com problema não pode
   impedir um lead de nascer nem de mudar de etapa.

   AS TRAVAS DE ENTRADA:
   - o fluxo precisa estar ATIVO e a conta com o Marketing liberado;
   - a pessoa que pediu para sair (lista de bloqueio) não entra;
   - por padrão, o mesmo lead entra numa automação UMA vez só. Com "pode
     entrar de novo" ligado, só depois de terminar a anterior e com pelo
     menos 1 hora entre uma e outra. É o que impede dois fluxos de ficarem
     se chamando (um move para a etapa X, o outro tira dela) para sempre;
   - freio da conta: mais de 20 entradas no mesmo minuto vão sendo espaçadas
     de 3 em 3 segundos. As mensagens de automação não seguem o ritmo do
     disparo (são conversa de um a um, como o robô), e este é o freio que
     sobra para um evento em massa não virar rajada no número. */
import { randomUUID } from "crypto";
import db from "../db.js";
import { temRecurso } from "./recursos.js";
import { campoCasa } from "./campos-lead.js";

export const TIPOS_DE_GATILHO = ["manual", "formulario", "lead_novo", "etapa", "etiqueta", "campo", "palavra"];
export const ORIGENS_DE_LEAD = ["whatsapp", "formulario", "portal", "manual"];

/* O gatilho que vem do navegador, limpo. Os campos de funil e catraca do
   formulário (pipeline_id/stage_id/catraca_id) passam por aqui só de
   carona: são gravados no formulário (services/formularios.js), não no
   fluxo — uma verdade só sobre "em que funil nasce o lead deste formulário". */
const ref = (v) => String(v || "").replace(/[^\w:.-]/g, "").slice(0, 80);
export function gatilhoLimpo(g) {
  const tipo = TIPOS_DE_GATILHO.includes(g?.tipo) ? g.tipo : "manual";
  const out = { tipo, reentrada: !!g?.reentrada };
  /* VÁRIOS FORMULÁRIOS NUM GATILHO SÓ (08/10/2026, pedido do Ali: "o ideal é
     que um fluxo criado possa ser usado para vários formulários"). A lista
     é `formularios: [{id, nome}]`; fluxo salvo antes disto só tem `form_id`,
     e vira uma lista de um. `form_id`/`form_nome` continuam saindo com o
     PRIMEIRO da lista, para quem ainda lê o campo antigo. */
  if (tipo === "formulario") {
    const brutos = Array.isArray(g.formularios) ? g.formularios : g.form_id ? [{ id: g.form_id, nome: g.form_nome }] : [];
    const vistos = new Set();
    out.formularios = [];
    for (const f of brutos) {
      const id = ref(typeof f === "string" ? f : f?.id);
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      out.formularios.push({ id, nome: String((typeof f === "object" && f?.nome) || "").slice(0, 160) });
      if (out.formularios.length >= 30) break;
    }
    out.form_id = out.formularios[0]?.id || "";
    out.form_nome = out.formularios[0]?.nome || "";
  }
  if (tipo === "lead_novo") out.origens = (Array.isArray(g.origens) ? g.origens : []).filter(o => ORIGENS_DE_LEAD.includes(o));
  if (tipo === "etapa") out.etapa_id = ref(g.etapa_id);
  if (tipo === "etiqueta") out.tag_id = ref(g.tag_id);
  /* CAMPO PREENCHIDO COM UM VALOR (08/10/2026): um campo personalizado
     ganhou um valor — qualquer um, ou o escrito em `valor` (sem olhar
     maiúscula nem acento). Vale quando alguém preenche na ficha e quando a
     IA do Autoatendimento preenche na conversa. */
  if (tipo === "campo") { out.campo = String(g.campo || "").replace(/[^\w-]/g, "").slice(0, 60); out.valor = String(g.valor ?? "").slice(0, 120); }
  /* Parar o fluxo quando o cliente responder (08/10/2026): uma mensagem do
     cliente encerra a execução que está esperando um tempo ou ainda não
     chegou a um bloco que espera resposta. Vale para qualquer gatilho. */
  /* MENSAGEM DO CLIENTE (30/10/2026, lista do Fernando): o cliente escreveu
     uma palavra ou frase ('contem'), começou a mensagem com ela ('comeca'),
     ou mandou o código de um imóvel do catálogo ('codigo' — o "cód. A1B2C3"
     do site). Palavra inteira, sem olhar maiúscula nem acento. */
  if (tipo === "palavra") {
    out.modo = ["contem", "comeca", "codigo"].includes(g.modo) ? g.modo : "contem";
    const brutas = Array.isArray(g.palavras) ? g.palavras : String(g.palavras || "").split(/[,;\n]/);
    out.palavras = out.modo === "codigo" ? [] : [...new Set(brutas.map(p => String(p || "").replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  }
  out.parar_ao_responder = !!g?.parar_ao_responder;
  return out;
}

/* A chave de busca do gatilho (`marketing_fluxos.gatilho_ref`): o que o
   evento precisa casar. Nulo = qualquer um (lead novo sem filtro de origem). */
export function refDoGatilho(g) {
  /* Formulário: a lista entre vírgulas, com vírgula nas pontas (",a,b,"),
     para casar um id inteiro e não um pedaço de outro. Fluxo ligado antes de
     08/10/2026 guarda só "a" — formulariosDaRef lê os dois jeitos. */
  if (g.tipo === "formulario") return g.formularios?.length ? "," + g.formularios.map(f => f.id).join(",") + "," : null;
  if (g.tipo === "etapa") return g.etapa_id || null;
  if (g.tipo === "etiqueta") return g.tag_id || null;
  if (g.tipo === "campo") return g.campo || null;
  return null;
}
export const formulariosDaRef = (r) => String(r || "").split(",").filter(Boolean);

/* VÁRIOS GATILHOS NUM FLUXO (16/10/2026, pedido do Ali: "seja possível
   colocar mais de um gatilho no fluxo… um não pode se sobrepor ao outro… o
   gatilho seja específico para cada ação que o lead tomar").

   Cada gatilho é um bloco de início no fluxo, com a PRÓPRIA saída: o lead
   que preencheu o formulário segue um caminho, o que ganhou a etiqueta
   segue outro. As regras:
   - nenhuma ação do lead pode casar com dois gatilhos do mesmo fluxo
     (`sobreposicoes`) — senão não daria para dizer por qual caminho ele vai;
   - um lead está em UM caminho do fluxo por vez: enquanto ele anda por um,
     outro gatilho do mesmo fluxo não o coloca de novo (dispararGatilho);
   - "uma vez só" e "pode entrar de novo" valem por gatilho.
   Fluxo antigo tem um início só e continua igual. */
export const MAX_GATILHOS = 10;
export function gatilhosDoGrafo(grafo) {
  return (grafo?.nos || []).filter(n => n.tipo === "inicio").map(n => ({ no_id: n.id, ...gatilhoLimpo(n.dados?.gatilho) }));
}
/* O nome curto de um gatilho, para as frases de erro e o histórico. */
const NOME_TIPO = { manual: "Disparo em massa", formulario: "Formulário preenchido", lead_novo: "Lead novo",
  etapa: "Entrou na etapa", etiqueta: "Etiqueta adicionada", campo: "Campo preenchido", palavra: "Mensagem do cliente" };
export const nomeDoTipoDeGatilho = (t) => NOME_TIPO[t] || t;
const semAcento = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
/* Duas ações iguais em dois gatilhos do mesmo fluxo. Devolve as frases. */
export function sobreposicoes(lista) {
  const erros = [];
  const n = (i) => `o gatilho ${i + 1}`;
  for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
    const a = lista[i], b = lista[j];
    let motivo = null;
    if (a.tipo === "manual" && b.tipo === "manual") motivo = "os dois são “Disparo em massa”";
    if (a.tipo === b.tipo && a.tipo === "formulario") {
      const comum = a.formularios.find(x => b.formularios.some(y => y.id === x.id));
      if (comum) motivo = `o formulário “${comum.nome || comum.id}” está nos dois`;
    }
    if (a.tipo === b.tipo && a.tipo === "etapa" && a.etapa_id && a.etapa_id === b.etapa_id) motivo = "os dois são a mesma etapa";
    if (a.tipo === b.tipo && a.tipo === "etiqueta" && a.tag_id && a.tag_id === b.tag_id) motivo = "os dois são a mesma etiqueta";
    if (a.tipo === b.tipo && a.tipo === "campo" && a.campo && a.campo === b.campo
      && (!a.valor || !b.valor || semAcento(a.valor) === semAcento(b.valor)))
      motivo = a.valor && b.valor ? "os dois são o mesmo campo com o mesmo valor" : "os dois são o mesmo campo, e um deles vale para qualquer valor";
    if (a.tipo === b.tipo && a.tipo === "palavra") {
      if (a.modo === "codigo" && b.modo === "codigo") motivo = "os dois pegam o código do imóvel";
      const comum = a.palavras.find(x => b.palavras.some(y => semAcento(y) === semAcento(x)));
      if (comum) motivo = `a palavra “${comum}” está nos dois`;
    }
    if (a.tipo === b.tipo && a.tipo === "lead_novo") {
      const oa = a.origens.length ? a.origens : ORIGENS_DE_LEAD, ob = b.origens.length ? b.origens : ORIGENS_DE_LEAD;
      if (oa.some(o => ob.includes(o))) motivo = "os dois pegam lead novo da mesma origem";
    }
    /* Lead novo vindo de formulário e "formulário preenchido" são a MESMA
       ação do lead: ele nasce preenchendo o formulário. */
    const [ln, fm] = a.tipo === "lead_novo" && b.tipo === "formulario" ? [a, b] : b.tipo === "lead_novo" && a.tipo === "formulario" ? [b, a] : [];
    if (ln && fm && (!ln.origens.length || ln.origens.includes("formulario")))
      motivo = "um lead novo de formulário entraria pelos dois (tire “Formulário” das origens do “Lead novo”)";
    if (motivo) erros.push(`${n(i)[0].toUpperCase() + n(i).slice(1)} e ${n(j)} se sobrepõem: ${motivo}. Cada ação do lead pode ligar um gatilho só.`);
  }
  return erros;
}
/* O que fica gravado no fluxo para a busca rápida do evento
   (`marketing_fluxos.gatilho_tipo/gatilho_ref`): com um gatilho, o tipo puro
   (como sempre foi); com vários, a lista ",formulario,etapa,". A ref só
   guarda os formulários (é o que a trava "um formulário, uma automação" lê). */
export function chavesDoFluxo(grafo) {
  const auto = gatilhosDoGrafo(grafo).filter(g => g.tipo !== "manual");
  const tipos = [...new Set(auto.map(g => g.tipo))];
  const forms = [...new Set(auto.filter(g => g.tipo === "formulario").flatMap(g => g.formularios.map(f => f.id)))];
  if (auto.length <= 1) return { tipo: auto[0]?.tipo || "manual", ref: auto[0] ? refDoGatilho(auto[0]) : null };
  return { tipo: "," + tipos.join(",") + ",", ref: forms.length ? "," + forms.join(",") + "," : null };
}

/* O que falta para um gatilho poder ser ligado — conferido contra o banco,
   porque etapa e etiqueta são desta conta e podem ter sido apagadas. */
export function problemasDoGatilho(orgId, g) {
  if (!g || g.tipo === "manual") return ["Escolha um gatilho no bloco de início — “Disparo em massa” não liga sozinho."];
  if (g.tipo === "formulario" && !g.formularios?.length) return ["Escolha pelo menos um formulário no gatilho."];
  if (g.tipo === "etapa") {
    if (!g.etapa_id) return ["Escolha a etapa do gatilho."];
    const e = db.prepare(`SELECT 1 FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
      WHERE s.id = ? AND s.org_id = ? AND COALESCE(s.is_active,1) = 1 AND COALESCE(p.is_active,1) = 1`).get(g.etapa_id, orgId);
    if (!e) return ["A etapa do gatilho não existe mais ou foi desativada."];
  }
  if (g.tipo === "etiqueta") {
    if (!g.tag_id) return ["Escolha a etiqueta do gatilho."];
    if (!db.prepare("SELECT 1 FROM tags WHERE id = ? AND org_id = ?").get(g.tag_id, orgId)) return ["A etiqueta do gatilho não existe mais."];
  }
  if (g.tipo === "palavra" && g.modo !== "codigo" && !g.palavras?.length) return ["Escreva a palavra ou frase do gatilho."];
  if (g.tipo === "campo") {
    if (!g.campo) return ["Escolha o campo do gatilho."];
    if (!db.prepare("SELECT 1 FROM custom_fields WHERE key = ? AND org_id = ? AND is_active = 1").get(g.campo, orgId))
      return ["O campo do gatilho não existe mais ou foi desativado."];
  }
  return [];
}

/* A mensagem casa com o gatilho "Mensagem do cliente"? */
const palavrasDe = (t) => " " + semAcento(t).replace(/[^a-z0-9]+/g, " ").trim() + " ";
export function palavraCasa(orgId, g, texto) {
  const t = String(texto || "");
  if (!t.trim()) return false;
  if (g.modo === "codigo") {
    const codigos = (t.toUpperCase().match(/\b[0-9A-F]{6}\b/g) || []);
    return codigos.some(c => db.prepare("SELECT 1 FROM produtos WHERE org_id = ? AND UPPER(SUBSTR(REPLACE(SUBSTR(id,3),'-',''),1,6)) = ? LIMIT 1").get(orgId, c));
  }
  const msg = palavrasDe(t);
  return (g.palavras || []).some(p => {
    const w = palavrasDe(p);
    if (w.trim() === "") return false;
    return g.modo === "comeca" ? msg.startsWith(w) : msg.includes(w);
  });
}

const formas = (t) => {
  const d = String(t || "").replace(/\D/g, "");
  if (!d) return [];
  const f = [d];
  if (/^55\d{11}$/.test(d) && d[4] === "9") f.push(d.slice(0, 4) + d.slice(5));
  if (/^55\d{10}$/.test(d)) f.push(d.slice(0, 4) + "9" + d.slice(4));
  return f;
};

/* O evento aconteceu. Coloca o lead em toda automação ativa que casa com
   ele. Devolve quantas execuções nasceram (para o teste e para o log). */
export function dispararGatilho(orgId, tipo, { leadId, ref: chave = null, origem = null, valor, agora = Date.now() } = {}) {
  try {
    if (!orgId || !leadId || !TIPOS_DE_GATILHO.includes(tipo) || tipo === "manual") return 0;
    const fluxos = db.prepare(`SELECT id, nome, grafo, automacao_id FROM marketing_fluxos
      WHERE org_id = ? AND ativo = 1 AND apagado_em IS NULL AND (gatilho_tipo = ? OR gatilho_tipo LIKE ?) AND automacao_id IS NOT NULL`)
      .all(orgId, tipo, `%,${tipo},%`);
    if (!fluxos.length) return 0;
    if (!temRecurso(orgId, "marketing")) return 0;
    const lead = db.prepare("SELECT id, name, phone FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
    if (!lead) return 0;
    /* A palavra do cliente no MEIO de uma conversa com gente não liga fluxo:
       "valor" dito numa negociação não pode disparar as boas-vindas. Só vale
       quando ninguém da equipe escreveu para ele nas últimas 12 horas. */
    if (tipo === "palavra" && db.prepare(`SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'out'
        AND from_user_id IS NOT NULL AND created_at > ? LIMIT 1`).get(lead.id, agora - 12 * 3600000)) return 0;
    // Nem quando ele já está andando por outro fluxo: dois automáticos se atropelariam.
    if (tipo === "palavra" && db.prepare(`SELECT 1 FROM marketing_execucoes WHERE lead_id = ? AND estado IN ('ativa','aguardando_resposta') LIMIT 1`).get(lead.id)) return 0;
    const f = formas(lead.phone);
    if (f.length && db.prepare(`SELECT 1 FROM marketing_bloqueio WHERE org_id = ? AND telefone IN (${f.map(() => "?").join(",")})`).get(orgId, ...f))
      return 0;

    let nasceram = 0;
    for (const fl of fluxos) {
      const camp = db.prepare("SELECT id, grafo, status FROM marketing_campanhas WHERE id = ? AND org_id = ?").get(fl.automacao_id, orgId);
      if (!camp || camp.status !== "rodando") continue;
      let gatilhos;
      try { gatilhos = gatilhosDoGrafo(JSON.parse(camp.grafo)); } catch { continue; }
      const casa = (g) => {
        if (g.tipo !== tipo) return false;
        if (tipo === "lead_novo") return !g.origens.length || g.origens.includes(origem);
        if (tipo === "formulario") return g.formularios.some(x => x.id === String(chave || ""));
        if (tipo === "campo") return g.campo === String(chave || "") && campoCasa(valor, g.valor);
        if (tipo === "palavra") return palavraCasa(orgId, g, valor);
        return String(refDoGatilho(g) || "") === String(chave || "");
      };
      // Os gatilhos não se sobrepõem (`sobreposicoes` trava o ligar), então
      // no máximo um casa; o primeiro é o que vale, por garantia.
      const g = gatilhos.find(casa);
      if (!g) continue;
      const primeiro = gatilhos[0]?.no_id;
      const anteriores = db.prepare(`SELECT estado, criado_em, COALESCE(gatilho_no, ?) AS gatilho_no FROM marketing_execucoes
        WHERE campanha_id = ? AND lead_id = ? ORDER BY criado_em DESC`).all(primeiro, camp.id, lead.id);
      // Um caminho por vez: quem está andando por este fluxo não entra de novo.
      if (anteriores.some(x => ["ativa", "aguardando_resposta"].includes(x.estado))) continue;
      const deste = anteriores.filter(x => x.gatilho_no === g.no_id);
      if (deste.length) {
        if (!g.reentrada) continue;
        if (deste[0].criado_em > agora - 3600000) continue;
      }
      const recentes = db.prepare(`SELECT COUNT(*) n FROM marketing_execucoes e JOIN marketing_campanhas c ON c.id = e.campanha_id
        WHERE e.org_id = ? AND c.tipo = 'automacao' AND e.criado_em > ?`).get(orgId, agora - 60000).n;
      const quando = agora + Math.max(0, recentes - 20) * 3000;
      db.prepare(`INSERT INTO marketing_execucoes (id,org_id,campanha_id,telefone,nome,lead_id,no_atual,gatilho_no,estado,proxima_em,criado_em,atualizado_em)
        VALUES (?,?,?,?,?,?,?,?,'ativa',?,?,?)`)
        .run("me_" + randomUUID(), orgId, camp.id, lead.phone || "", lead.name || null, lead.id, g.no_id, g.no_id, quando, agora, agora);
      db.prepare("UPDATE marketing_campanhas SET total = total + 1 WHERE id = ?").run(camp.id);
      nasceram++;
      console.log(`[automacao] lead entrou em "${fl.nome}" (${tipo}) em ${orgId}`);
    }
    return nasceram;
  } catch (err) {
    console.warn("[automacao] gatilho não aplicado:", err.message);
    return 0;
  }
}
