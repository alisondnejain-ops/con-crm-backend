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

export const TIPOS_DE_GATILHO = ["manual", "formulario", "lead_novo", "etapa", "etiqueta", "campo"];
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
  if (g.tipo === "campo") {
    if (!g.campo) return ["Escolha o campo do gatilho."];
    if (!db.prepare("SELECT 1 FROM custom_fields WHERE key = ? AND org_id = ? AND is_active = 1").get(g.campo, orgId))
      return ["O campo do gatilho não existe mais ou foi desativado."];
  }
  return [];
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
    const fluxos = db.prepare(`SELECT id, nome, grafo, automacao_id, gatilho_ref FROM marketing_fluxos
      WHERE org_id = ? AND ativo = 1 AND apagado_em IS NULL AND gatilho_tipo = ? AND automacao_id IS NOT NULL`).all(orgId, tipo);
    if (!fluxos.length) return 0;
    if (!temRecurso(orgId, "marketing")) return 0;
    const lead = db.prepare("SELECT id, name, phone FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
    if (!lead) return 0;
    const f = formas(lead.phone);
    if (f.length && db.prepare(`SELECT 1 FROM marketing_bloqueio WHERE org_id = ? AND telefone IN (${f.map(() => "?").join(",")})`).get(orgId, ...f))
      return 0;

    let nasceram = 0;
    for (const fl of fluxos) {
      const camp = db.prepare("SELECT id, grafo, status FROM marketing_campanhas WHERE id = ? AND org_id = ?").get(fl.automacao_id, orgId);
      if (!camp || camp.status !== "rodando") continue;
      let grafo, g;
      try { grafo = JSON.parse(camp.grafo); g = gatilhoLimpo(grafo.nos.find(n => n.tipo === "inicio")?.dados?.gatilho); } catch { continue; }
      if (g.tipo !== tipo) continue;
      if (tipo === "lead_novo") { if (g.origens.length && !g.origens.includes(origem)) continue; }
      else if (tipo === "formulario") { if (!g.formularios.some(x => x.id === String(chave || ""))) continue; }
      else if (String(fl.gatilho_ref || "") !== String(chave || "")) continue;
      if (tipo === "campo" && !campoCasa(valor, g.valor)) continue;

      const anteriores = db.prepare(`SELECT estado, criado_em FROM marketing_execucoes WHERE campanha_id = ? AND lead_id = ?
        ORDER BY criado_em DESC`).all(camp.id, lead.id);
      if (anteriores.length) {
        if (!g.reentrada) continue;
        if (anteriores.some(a => ["ativa", "aguardando_resposta"].includes(a.estado))) continue;
        if (anteriores[0].criado_em > agora - 3600000) continue;
      }
      const recentes = db.prepare(`SELECT COUNT(*) n FROM marketing_execucoes e JOIN marketing_campanhas c ON c.id = e.campanha_id
        WHERE e.org_id = ? AND c.tipo = 'automacao' AND e.criado_em > ?`).get(orgId, agora - 60000).n;
      const quando = agora + Math.max(0, recentes - 20) * 3000;
      const inicio = grafo.nos.find(n => n.tipo === "inicio").id;
      db.prepare(`INSERT INTO marketing_execucoes (id,org_id,campanha_id,telefone,nome,lead_id,no_atual,estado,proxima_em,criado_em,atualizado_em)
        VALUES (?,?,?,?,?,?,?,'ativa',?,?,?)`)
        .run("me_" + randomUUID(), orgId, camp.id, lead.phone || "", lead.name || null, lead.id, inicio, quando, agora, agora);
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
