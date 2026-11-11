/* ===== O AGENTE APRENDE SOZINHO A CADA ATENDIMENTO (07/11/2026) =====

   Pedido do Ali: "nosso agente do conhub aprende e se qualifica a cada
   atendimento que ele fizer". Ele escolheu: aprende SOZINHO, sem aprovação.

   Quando a IA encerra um atendimento (se despede), ela relê a conversa e grava
   até 3 orientações novas em `robo_ensino`, com `origem = 'ia'`. A partir da
   próxima conversa elas entram no pedido à IA, numa seção PRÓPRIA, abaixo das
   regras da equipe — e o pedido diz que as da equipe valem mais.

   As travas, porque o que ela aprende passa a ser dito a TODOS os clientes:
   - o gestor VÊ tudo que ela aprendeu (Configurações → Autoatendimento,
     "Aprendido pela IA"), apaga ou desliga uma a uma, e desliga o aprendizado
     inteiro (`orgs.robo_aprender = 0`);
   - texto com cara de dado pessoal (4+ dígitos seguidos, e-mail, R$, o nome
     do cliente) não é gravado, mesmo que a IA mande;
   - no máximo `ROBO_APRENDIDAS_MAX` (padrão 30) ativas: passou, a mais antiga
     sai. Cada linha entra em toda resposta e vira custo em toda conversa;
   - repetida (sem olhar maiúscula nem acento) não entra de novo;
   - cada lead ensina UMA vez (`leads.robo_aprendido_em`);
   - gasta o crédito de IA da conta (recurso `aprendizado`), e não roda sem
     crédito.

   Nunca lança: aprender é bônus, não pode atrapalhar o atendimento. */

import { randomUUID } from "crypto";
import db from "../db.js";
import { aprenderComAtendimento, iaConfigurada } from "./ia.js";
import { registrar as registrarUsoIA } from "./iauso.js";
import { temCredito } from "./ia-creditos.js";
import { temRecurso } from "./recursos.js";
import { corpoParaIA } from "./leitura-midia.js";

const colsEnsino = db.prepare("PRAGMA table_info(robo_ensino)").all().map(c => c.name);
if (!colsEnsino.includes("origem")) db.exec("ALTER TABLE robo_ensino ADD COLUMN origem TEXT");
if (!colsEnsino.includes("lead_id")) db.exec("ALTER TABLE robo_ensino ADD COLUMN lead_id TEXT");
const colsOrg = db.prepare("PRAGMA table_info(orgs)").all().map(c => c.name);
if (!colsOrg.includes("robo_aprender")) db.exec("ALTER TABLE orgs ADD COLUMN robo_aprender INTEGER");
const colsLead = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
if (!colsLead.includes("robo_aprendido_em")) db.exec("ALTER TABLE leads ADD COLUMN robo_aprendido_em INTEGER");

export const maxAprendidas = () => Math.max(1, Number(process.env.ROBO_APRENDIDAS_MAX) || 30);
// NULO = ligado: aprender é o que foi pedido para todo agente.
export const aprendeLigado = (orgId) => (db.prepare("SELECT robo_aprender FROM orgs WHERE id = ?").get(orgId)?.robo_aprender ?? 1) !== 0;

const chave = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/* Texto com cara de dado de uma pessoa não vira regra para todos. */
export function pareceDadoPessoal(texto, nomeDoCliente = "") {
  const t = String(texto || "");
  if (/\d{4,}/.test(t.replace(/[\s.\-()/]/g, ""))) return true;           // telefone, CPF, valor
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return true;                       // e-mail
  if (/R\$\s*\d/i.test(t)) return true;                                     // valor
  const nome = chave(nomeDoCliente).split(" ").filter(p => p.length >= 4);
  const k = " " + chave(t) + " ";
  return nome.some(p => k.includes(" " + p + " "));
}

export async function aprenderDoAtendimento(orgId, leadId) {
  try {
    if (!iaConfigurada() || !aprendeLigado(orgId) || !temRecurso(orgId, "autoatendimento") || !temCredito(orgId)) return { aprendeu: 0 };
    const lead = db.prepare("SELECT id, name, robo_aprendido_em FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
    if (!lead || lead.robo_aprendido_em) return { aprendeu: 0 };
    db.prepare("UPDATE leads SET robo_aprendido_em = ? WHERE id = ?").run(Date.now(), leadId);

    const msgs = db.prepare(`SELECT direction, ${corpoParaIA()} AS body FROM messages WHERE lead_id = ? AND apagada_em IS NULL
      AND body IS NOT NULL AND body <> '' ORDER BY created_at`).all(leadId);
    if (msgs.filter(m => m.direction === "in").length < 2) return { aprendeu: 0 };   // conversa curta não ensina

    const linhas = db.prepare("SELECT id, texto, origem, ativo FROM robo_ensino WHERE org_id = ? ORDER BY created_at").all(orgId);
    const regras = linhas.filter(l => l.origem !== "ia" && l.ativo).map(l => l.texto);
    const aprendidas = linhas.filter(l => l.origem === "ia");
    const imobiliaria = db.prepare("SELECT name FROM orgs WHERE id = ?").get(orgId)?.name || "";

    const r = await aprenderComAtendimento({ regras, aprendidas: aprendidas.filter(l => l.ativo).map(l => l.texto), imobiliaria,
      mensagens: msgs.map(m => ({ de: m.direction === "in" ? "cliente" : "empresa", texto: m.body })) });
    if (!r.ok) { console.warn(`[aprendizado] não aprendi com ${lead.name}: ${r.erro}`); return { aprendeu: 0, erro: r.erro }; }
    if (r.uso) registrarUsoIA({ orgId, userId: null, leadId, recurso: "aprendizado", uso: r.uso });

    const existentes = new Set(linhas.map(l => chave(l.texto)));
    let n = 0;
    for (const texto of r.novas || []) {
      if (existentes.has(chave(texto)) || pareceDadoPessoal(texto, lead.name)) continue;
      existentes.add(chave(texto));
      db.prepare(`INSERT INTO robo_ensino (id,org_id,texto,ordem,ativo,criado_por,created_at,origem,lead_id)
        VALUES (?,?,?,?,1,NULL,?,'ia',?)`).run("en_" + randomUUID(), orgId, texto, 1000000 + n, Date.now() + n, leadId);
      n++;
    }
    // O teto: passou, saem as mais antigas (ativas) aprendidas.
    const ativas = db.prepare("SELECT id FROM robo_ensino WHERE org_id = ? AND origem = 'ia' AND ativo = 1 ORDER BY created_at DESC").all(orgId);
    for (const x of ativas.slice(maxAprendidas())) db.prepare("DELETE FROM robo_ensino WHERE id = ?").run(x.id);
    if (n) console.log(`[aprendizado] ${n} orientação(ões) nova(s) aprendida(s) com ${lead.name}`);
    return { aprendeu: n };
  } catch (e) {
    console.error("[aprendizado] falhou:", e.message);
    return { aprendeu: 0, erro: e.message };
  }
}
