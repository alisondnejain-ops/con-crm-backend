/* A NUVEM DE SUPORTE (05/10/2026, pedido do Ali: "o sistema faz um filtro da
   necessidade do cliente e vê se dá pra resolver sem direcionar pro suporte
   humano; se não tiver solução vai pro suporte e na própria nuvem abre uma
   conversa comigo, pelo meu WhatsApp, igual a função Atender").

   DOIS MOMENTOS:
   1. TRIAGEM pela IA, com o manual do sistema (services/ajuda.js). Ela
      responde o que é de uso e, quando não dá (cobrança, erro, algo que só
      olhando a conta), oferece a pessoa do suporte.
   2. CHAMADO com uma pessoa do ConHub. Ele cai na aba Suporte do ambiente
      interno do ConHub, a equipe é avisada no celular e responde por lá
      (05/10/2026). Opcional, no hub: repassar também ao WhatsApp do suporte
      (`suporte_destino`), pela linha de uma conta (`suporte_org`) — aí a
      resposta dada no WhatsApp volta para a nuvem do cliente.

   COMO A RESPOSTA ACHA O CHAMADO CERTO — várias conversas chegam no MESMO
   WhatsApp do suporte, então cada mensagem que sai leva "#número". A
   resposta é ligada assim, nesta ordem:
   (a) citando a mensagem do chamado no WhatsApp (o id dela está guardado);
   (b) começando com "#12";
   (c) sem nada disso, o chamado aberto mais recente — e, havendo mais de um
       aberto, o suporte recebe a confirmação de para qual foi.
   "/fechar" (ou "#12 /fechar") encerra o chamado.

   A INTERCEPTAÇÃO É ANTES DE TUDO no webhook (`mensagemDoSuporte`): na linha
   do suporte, o número do suporte NUNCA vira lead — senão o próprio Ali
   apareceria como cliente na caixa da conta que empresta a linha. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { sendText, numeroAlternativo } from "./uazapi.js";
import { avisar } from "./push.js";
import { MANUAL_CONHUB } from "./ajuda.js";
import { TELAS, abrirTela } from "./assistente.js";

const agora = () => Date.now();
const DESTINO_PADRAO = "5581999353988"; // (81) 99935-3988 — o WhatsApp do Ali, por enquanto

/* ===== CONFIGURAÇÃO (hub do master) ===== */
const lerCfg = (chave) => db.prepare("SELECT valor FROM config_plataforma WHERE chave = ?").get(chave)?.valor || null;
const gravarCfg = (chave, valor) => db.prepare(
  "INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES (?, ?, ?)").run(chave, valor, agora());

export const soDigitos = (t) => String(t || "").replace(/\D/g, "");
export function destinoDoSuporte() { return lerCfg("suporte_destino") || DESTINO_PADRAO; }

/* A conta cuja linha da casa manda as mensagens. Sem escolha no hub: a conta
   do primeiro master (é a do ConHub), e na falta dela a mais antiga. */
export function orgDoSuporte() {
  const escolhida = lerCfg("suporte_org");
  if (escolhida && db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(escolhida)) return escolhida;
  /* Sem escolha no hub, a linha é a do AMBIENTE INTERNO do ConHub
     (05/10/2026). Antes caía na conta do master — que é a Conecta, e o
     chamado de um cliente saía pelo WhatsApp de outro cliente. */
  const interna = db.prepare("SELECT id FROM orgs WHERE tipo = 'interna' ORDER BY created_at LIMIT 1").get()?.id;
  if (interna) return interna;
  return db.prepare("SELECT org_id FROM users WHERE master = 1 ORDER BY created_at LIMIT 1").get()?.org_id
    || db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get()?.id || null;
}
/* ENCAMINHAR AO WHATSAPP É OPÇÃO, NÃO O CAMINHO (05/10/2026, pedido do Ali:
   "a nuvem de suporte, quando o cliente solicitar, cai no atendimento dentro
   do sistema interno do ConHub… sem intermediação"). Com o ambiente interno
   criado, o chamado mora LÁ: a equipe é avisada no celular e responde pela
   aba Suporte, e a resposta aparece na nuvem do cliente. Repassar cada
   mensagem para um WhatsApp pessoal vira escolha do hub (`suporte_whatsapp`).
   Sem ambiente interno, continua como era — senão o chamado não chegaria a
   ninguém. */
const temAmbienteInterno = () => !!db.prepare("SELECT 1 FROM orgs WHERE tipo = 'interna' LIMIT 1").get();
export function encaminhaAoWhatsapp() {
  const escolha = lerCfg("suporte_whatsapp");
  if (escolha === "1") return true;
  if (escolha === "0") return false;
  return !temAmbienteInterno();
}

export function configDoSuporte() {
  const orgId = orgDoSuporte();
  const org = orgId ? db.prepare("SELECT id, name FROM orgs WHERE id = ?").get(orgId) : null;
  const casa = orgId ? db.prepare("SELECT host, token, provider, wa_number FROM canais WHERE org_id = ? AND tipo = 'imobiliaria' LIMIT 1").get(orgId) : null;
  return {
    destino: destinoDoSuporte(), destino_padrao: !lerCfg("suporte_destino"),
    org: org ? { id: org.id, nome: org.name } : null, org_escolhida: !!lerCfg("suporte_org"),
    linha_ligada: !!(casa && casa.token),
    // O número que envia é o mesmo que recebe: a mensagem cairia em "conversa
    // com você", que não toca, e a resposta digitada lá voltaria como eco.
    mesmo_numero: !!(casa && casa.wa_number && mesmoNumero(casa.wa_number, destinoDoSuporte())),
    whatsapp: encaminhaAoWhatsapp(), whatsapp_escolhido: lerCfg("suporte_whatsapp") !== null,
    ambiente_interno: temAmbienteInterno(),
  };
}
export function salvarConfig({ destino, org_id, whatsapp }) {
  if (whatsapp !== undefined) gravarCfg("suporte_whatsapp", whatsapp ? "1" : "0");
  if (destino !== undefined) {
    let d = soDigitos(destino);
    if (d.length === 10 || d.length === 11) d = "55" + d; // com DDD, sem o 55
    if (d && !/^55\d{10,11}$/.test(d)) return { erro: "Número do suporte inválido. Use com DDD, ex.: (81) 99935-3988." };
    if (d) gravarCfg("suporte_destino", d);
    else db.prepare("DELETE FROM config_plataforma WHERE chave = 'suporte_destino'").run();
  }
  if (org_id !== undefined) {
    if (org_id && !db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(org_id)) return { erro: "Conta não encontrada." };
    if (org_id) gravarCfg("suporte_org", org_id);
    else db.prepare("DELETE FROM config_plataforma WHERE chave = 'suporte_org'").run();
  }
  return { ok: true, config: configDoSuporte() };
}

// As duas formas do celular brasileiro (com e sem o 9) são o mesmo número.
const mesmoNumero = (a, b) => {
  const x = soDigitos(a), y = soDigitos(b);
  return !!x && !!y && (x === y || numeroAlternativo(x) === y);
};

/* ===== ENVIO PARA O WHATSAPP DO SUPORTE ===== */
async function mandarAoSuporte(texto, { forcar = false } = {}) {
  // Sem encaminhamento, nada sai para WhatsApp nenhum: o chamado é atendido
  // de dentro do sistema. `forcar` é só o "Enviar teste" do hub.
  if (!forcar && !encaminhaAoWhatsapp()) return { ok: false, desligado: true };
  const orgId = orgDoSuporte();
  if (!orgId) return { ok: false, erro: "Nenhuma conta escolhida para enviar o suporte." };
  const casa = db.prepare("SELECT wa_number FROM canais WHERE org_id = ? AND tipo = 'imobiliaria' LIMIT 1").get(orgId);
  if (casa && casa.wa_number && mesmoNumero(casa.wa_number, destinoDoSuporte()))
    return { ok: false, erro: "O número que envia é o mesmo que recebe o suporte. Conecte outro número na linha que envia (ex.: o (87)) ou troque o número que recebe." };
  try {
    const r = await sendText({ orgId, toPhone: destinoDoSuporte(), text: texto });
    if (r && r.simulated) return { ok: false, erro: "A linha de WhatsApp do suporte não está conectada." };
    return { ok: true, waId: r?.messageid || null };
  } catch (e) {
    console.warn("[suporte] não consegui mandar ao WhatsApp do suporte:", e.message);
    return { ok: false, erro: e.message };
  }
}

// O botão "Enviar teste" do hub.
export const testarEnvio = () => mandarAoSuporte("✅ Teste do suporte ConHub: as mensagens da nuvem de suporte vão chegar aqui.", { forcar: true });

/* Quem atende o suporte: a equipe ativa do ambiente interno e os masters.
   É a eles que vai o aviso no celular de chamado novo e de mensagem nova. */
function avisarEquipe({ titulo, corpo }) {
  const ids = db.prepare(`SELECT u.id FROM users u LEFT JOIN orgs o ON o.id = u.org_id
    WHERE u.status = 'ativo' AND (u.master = 1 OR o.tipo = 'interna')`).all().map(r => r.id);
  for (const id of ids) avisar(id, { titulo, corpo: String(corpo || "").slice(0, 140) }).catch(() => {});
}

/* ===== CHAMADOS ===== */
const papelTexto = (u) => (u.gestor || u.role === "adm" ? "Gestor(a)" : u.role === "sdr" ? "Atendente" : "Corretor(a)");
export const chamadoAberto = (userId) => db.prepare(
  "SELECT * FROM suporte_chamados WHERE user_id = ? AND status = 'aberto' ORDER BY created_at DESC LIMIT 1").get(userId) || null;
export const mensagensDo = (chamadoId) => db.prepare(
  "SELECT id, de, texto, entregue, created_at FROM suporte_mensagens WHERE chamado_id = ? ORDER BY created_at, rowid").all(chamadoId);
function gravarMsg(chamadoId, de, texto, { waId = null, entregue = 1 } = {}) {
  const id = "sm_" + randomUUID();
  db.prepare(`INSERT INTO suporte_mensagens (id,chamado_id,de,texto,wa_id,entregue,lida,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, chamadoId, de, String(texto).slice(0, 4000), waId, entregue ? 1 : 0, de === "cliente" ? 1 : 0, agora());
  db.prepare("UPDATE suporte_chamados SET updated_at = ? WHERE id = ?").run(agora(), chamadoId);
  return id;
}

/* Abre o chamado e manda o primeiro aviso ao WhatsApp do suporte, com quem é,
   de qual conta, o resumo da triagem e o pedido. */
export async function abrirChamado(user, { resumo, contato }) {
  const ja = chamadoAberto(user.id);
  if (ja) return { chamado: ja };
  const org = db.prepare("SELECT name, tipo FROM orgs WHERE id = ?").get(user.org_id) || {};
  const pessoa = db.prepare("SELECT name, email, phone FROM users WHERE id = ?").get(user.id) || {};
  const numero = (db.prepare("SELECT MAX(numero) m FROM suporte_chamados").get().m || 0) + 1;
  const id = "sc_" + randomUUID();
  const res = String(resumo || "").trim().slice(0, 1500) || "Pediu para falar com o suporte.";
  db.prepare(`INSERT INTO suporte_chamados (id,numero,org_id,user_id,status,resumo,entregue,created_at,updated_at)
    VALUES (?,?,?,?, 'aberto', ?, 0, ?, ?)`).run(id, numero, user.org_id, user.id, res, agora(), agora());

  const linhas = [
    `🆘 *Suporte #${numero}*`,
    `${org.name || "Conta"} (${org.tipo === "autonomo" ? "autônomo" : "imobiliária"}) · ${pessoa.name || user.name} · ${papelTexto(user)}`,
    [pessoa.email, contato || pessoa.phone].filter(Boolean).join(" · "),
    "",
    res,
    "",
    `_Responda citando esta mensagem ou começando com #${numero}. "/fechar" encerra._`,
  ].filter((l, i) => l !== "" || i > 2);
  const envio = await mandarAoSuporte(linhas.join("\n"));
  avisarEquipe({ titulo: `Suporte #${numero} · ${org.name || "Conta"}`, corpo: `${pessoa.name || user.name}: ${res}` });
  // Sem encaminhamento, "entregue" é ter chegado à fila da equipe — e chegou.
  const entregue = envio.ok || !!envio.desligado;
  gravarMsg(id, "sistema", "Chamado aberto. " + (entregue
    ? "O suporte foi avisado e responde por aqui."
    : "Não consegui avisar o suporte pelo WhatsApp agora, mas o pedido ficou registrado e o suporte vê no painel."),
  { waId: envio.waId, entregue });
  if (entregue) db.prepare("UPDATE suporte_chamados SET entregue = 1 WHERE id = ?").run(id);
  return { chamado: db.prepare("SELECT * FROM suporte_chamados WHERE id = ?").get(id), entregue };
}

// O cliente escreveu na nuvem com o chamado aberto.
export async function mensagemDoCliente(user, texto) {
  const ch = chamadoAberto(user.id);
  if (!ch) return { erro: "Nenhuma conversa com o suporte aberta." };
  const t = String(texto || "").trim().slice(0, 4000);
  if (!t) return { erro: "Escreva a mensagem." };
  const envio = await mandarAoSuporte(`*#${ch.numero}* · ${user.name}: ${t}`);
  avisarEquipe({ titulo: `Suporte #${ch.numero} · nova mensagem`, corpo: `${user.name}: ${t}` });
  const entregue = envio.ok || !!envio.desligado;
  gravarMsg(ch.id, "cliente", t, { waId: envio.waId, entregue });
  return { ok: true, entregue, aviso: entregue ? null : "Não consegui entregar pelo WhatsApp agora; ficou registrado para o suporte." };
}

export async function fecharChamado(chamado, quem) {
  if (!chamado || chamado.status !== "aberto") return { ok: true };
  db.prepare("UPDATE suporte_chamados SET status = 'fechado', fechado_em = ?, updated_at = ? WHERE id = ?").run(agora(), agora(), chamado.id);
  gravarMsg(chamado.id, "sistema", quem === "suporte" ? "O suporte encerrou a conversa." : "Conversa encerrada.");
  if (quem === "cliente") await mandarAoSuporte(`*#${chamado.numero}* foi encerrado pelo cliente.`);
  return { ok: true };
}

/* O suporte respondeu (pelo WhatsApp, ou pelo painel do hub). */
export async function respostaDoSuporte(chamado, texto, { viaPainel = false, por = null } = {}) {
  const t = String(texto || "").trim();
  if (!t) return { erro: "Escreva a resposta." };
  if (/^\/fechar\b/i.test(t)) return fecharChamado(chamado, "suporte");
  if (chamado.status !== "aberto") db.prepare("UPDATE suporte_chamados SET status = 'aberto', fechado_em = NULL WHERE id = ?").run(chamado.id);
  gravarMsg(chamado.id, "suporte", t);
  avisar(chamado.user_id, { titulo: "Suporte ConHub respondeu", corpo: t.slice(0, 120) }).catch(() => {});
  if (viaPainel) await mandarAoSuporte(`↪ (respondido pelo painel${por ? " por " + por : ""}) *#${chamado.numero}*: ${t}`);
  return { ok: true };
}

/* ===== O WEBHOOK: a linha do suporte recebeu algo do número do suporte =====
   Devolve o texto do registro (para o log de webhooks) ou null quando a
   mensagem não é do suporte — aí ela segue o caminho normal de lead. */
export async function mensagemDoSuporte({ canal, phone, fromMe, texto, citada }) {
  // Sem encaminhamento ao WhatsApp, ninguém responde chamado por lá: a
  // mensagem segue o caminho normal da linha.
  if (!encaminhaAoWhatsapp()) return null;
  if (!canal || canal.tipo !== "imobiliaria" || canal.org_id !== orgDoSuporte()) return null;
  if (!mesmoNumero(phone, destinoDoSuporte())) return null;
  if (fromMe) return "suporte: eco do que saiu para o WhatsApp do suporte (não vira lead)";
  let t = String(texto || "").trim();
  if (!t) return "suporte: mensagem sem texto do WhatsApp do suporte (ignorada)";

  let chamado = null;
  if (citada) {
    const cauda = String(citada).split(":").pop();
    const m = db.prepare(`SELECT chamado_id FROM suporte_mensagens WHERE wa_id IS NOT NULL
      AND (wa_id = ? OR wa_id LIKE ? OR ? LIKE '%' || wa_id) ORDER BY created_at DESC LIMIT 1`).get(citada, "%" + cauda, citada);
    if (m) chamado = db.prepare("SELECT * FROM suporte_chamados WHERE id = ?").get(m.chamado_id);
  }
  const marcado = t.match(/^#(\d+)\s*[:\-–]?\s*/);
  if (!chamado && marcado) {
    chamado = db.prepare("SELECT * FROM suporte_chamados WHERE numero = ?").get(Number(marcado[1]));
    if (!chamado) { await mandarAoSuporte(`Não achei o chamado #${marcado[1]}.`); return "suporte: chamado citado não existe"; }
  }
  if (marcado && chamado && chamado.numero === Number(marcado[1])) t = t.slice(marcado[0].length).trim();

  let adivinhado = false;
  if (!chamado) {
    chamado = db.prepare("SELECT * FROM suporte_chamados WHERE status = 'aberto' ORDER BY updated_at DESC LIMIT 1").get();
    adivinhado = true;
    if (!chamado) { await mandarAoSuporte("Nenhum chamado aberto agora — a mensagem não foi para ninguém."); return "suporte: nenhum chamado aberto"; }
  }
  if (!t) return "suporte: resposta vazia";
  await respostaDoSuporte(chamado, t);
  if (adivinhado) {
    const abertos = db.prepare("SELECT COUNT(*) n FROM suporte_chamados WHERE status = 'aberto'").get().n;
    if (abertos > 1) {
      const org = db.prepare("SELECT name FROM orgs WHERE id = ?").get(chamado.org_id);
      await mandarAoSuporte(`↪ Foi para o *#${chamado.numero}* (${org?.name || "conta"}). Para outro chamado, cite a mensagem dele ou comece com #número.`);
    }
  }
  return `suporte: resposta levada ao chamado #${chamado.numero}`;
}

/* ===== TRIAGEM PELA IA ===== */
const INSTRUCOES_SUPORTE = `Você é o suporte do ConHub, um CRM de imobiliárias, e conversa em português do Brasil com quem usa o sistema (gestor, atendente ou corretor).

Seu trabalho é resolver a dúvida AGORA, pelo manual abaixo, com o caminho exato na tela ("Configurações → Conexão → Conectar"). Respostas curtas, em passos numerados quando houver mais de um, sem jargão técnico e sem markdown pesado.

Quando chamar uma pessoa (ferramenta encaminhar_para_suporte):
- o assunto está em "Coisas que só o suporte humano resolve";
- a pessoa já seguiu os passos e não funcionou, ou relata um erro;
- você não sabe a resposta com segurança — não invente tela, botão nem regra que não estejam no manual;
- a pessoa pede para falar com alguém.
Antes de encaminhar, se faltar, pergunte o essencial (o que tentou, o que apareceu na tela). Ao encaminhar, escreva um resumo objetivo para o suporte, e diga à pessoa que ela pode tocar em "Falar com o suporte" logo abaixo.

Você não vê nem altera a conta da pessoa. Para levá-la a uma tela, use abrir_tela.

${MANUAL_CONHUB}`;

export function sistemaDeSuporte(user, org) {
  return [
    { type: "text", text: INSTRUCOES_SUPORTE },
    { type: "text", text: `Conta: ${org?.name || "—"} (${org?.tipo === "autonomo" ? "corretor autônomo" : "imobiliária"}). Quem pergunta: ${user.name}, ${papelTexto(user)}. Hoje: ${new Date().toLocaleDateString("pt-BR")}.` },
  ];
}

export const FERRAMENTAS_SUPORTE = [
  {
    name: "encaminhar_para_suporte",
    description: "Mostra à pessoa o botão de falar com o suporte humano, já com o resumo do caso. Use quando o manual não resolve.",
    input_schema: { type: "object", additionalProperties: false, required: ["resumo"],
      properties: { resumo: { type: "string", description: "Resumo objetivo para o suporte: o que a pessoa quer, o que já tentou, o que aparece na tela." } } },
  },
  {
    name: "abrir_tela",
    description: "Leva a pessoa até uma tela do ConHub.",
    input_schema: { type: "object", additionalProperties: false, required: ["tela", "motivo"],
      properties: { tela: { type: "string", enum: Object.keys(TELAS) }, motivo: { type: "string" } } },
  },
];

export const executorDeSuporte = () => async (nome, e, efeitos) => {
  if (nome === "encaminhar_para_suporte") {
    efeitos.humano = { resumo: String(e.resumo || "").slice(0, 1500) };
    return { dados: { ok: true, botao_mostrado: true } };
  }
  if (nome === "abrir_tela") return abrirTela(e, efeitos);
  return { erro: "Ferramenta desconhecida." };
};

/* ===== LISTA DO HUB ===== */
export function chamadosParaOHub(limite = 50) {
  return db.prepare(`SELECT c.*, o.name AS conta, u.name AS pessoa, u.email,
      (SELECT COUNT(*) FROM suporte_mensagens m WHERE m.chamado_id = c.id) AS mensagens
    FROM suporte_chamados c LEFT JOIN orgs o ON o.id = c.org_id LEFT JOIN users u ON u.id = c.user_id
    ORDER BY (c.status = 'aberto') DESC, c.updated_at DESC LIMIT ?`).all(limite)
    .map(c => ({ id: c.id, numero: c.numero, status: c.status, conta: c.conta, pessoa: c.pessoa, email: c.email,
      resumo: c.resumo, entregue: !!c.entregue, mensagens: c.mensagens, criado_em: c.created_at, atualizado_em: c.updated_at,
      aguardando: c.status === "aberto" && aguardaSuporte(c.id) }));
}

/* O chamado espera a equipe quando a última fala de gente é do cliente (a
   mensagem automática de "chamado aberto" conta como pedido ainda sem
   resposta). É o número do menu Suporte. */
const aguardaSuporte = (chamadoId) => db.prepare(`SELECT de FROM suporte_mensagens
  WHERE chamado_id = ? AND de IN ('cliente','suporte') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(chamadoId)?.de !== "suporte";
export const chamadosEsperando = () => db.prepare("SELECT id FROM suporte_chamados WHERE status = 'aberto'").all()
  .filter(c => aguardaSuporte(c.id)).length;
