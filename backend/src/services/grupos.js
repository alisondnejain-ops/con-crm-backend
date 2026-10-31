/* ===== GRUPOS DO WHATSAPP NO CRM (31/10/2026) =====

   Pedido do Fernando; eu tinha recomendado não fazer (grupo mistura conversa
   pessoal com atendimento) e o Ali decidiu: "numa aba própria". Por isso:

   - LIGADO POR LINHA, e nasce desligado (`canais.grupos`): quem não ligar não
     vê grupo nenhum, exatamente como antes;
   - GRUPO NÃO É LEAD: tabelas próprias (`wa_grupos`, `wa_grupo_mensagens`),
     fora de relatório, funil, catraca, robô e disparo;
   - QUEM VÊ é quem vê aquela linha: o grupo do número da casa, a supervisão;
     o do WhatsApp pessoal de um corretor, só ele — nem a gestão;
   - mídia entra como rótulo ("Foto", "Áudio"): baixar arquivo de grupo
     encheria o armazenamento com o que não é atendimento.

   Nada aqui lança para o webhook: grupo com problema não pode impedir a
   mensagem de um lead de entrar. */
import db from "../db.js";
import { randomUUID } from "crypto";
import { supervisiona } from "../auth.js";
import { canalPorId } from "./canais.js";
import { sendText } from "./uazapi.js";

export class ErroGrupo extends Error { constructor(status, m) { super(m); this.status = status; } }

const ROTULOS = [[/image/i, "Foto"], [/video/i, "Vídeo"], [/audio|ptt/i, "Áudio"], [/document/i, "Documento"], [/sticker/i, "Figurinha"], [/location/i, "Localização"]];
const rotuloDe = (tipo) => (ROTULOS.find(([re]) => re.test(String(tipo || ""))) || [null, ""])[1];

// A linha liga os grupos? (só Uazapi; a API oficial da Meta não entrega grupo)
export const linhaComGrupos = (canal) => !!(canal && canal.ativo && canal.grupos === 1 && canal.tipo !== "disparo" && canal.provider !== "meta");

export function gravarMensagemDeGrupo({ canal, jid, nomeGrupo, autorNumero, autorNome, fromMe, texto, tipo, messageid, quando = Date.now(), fromUserId = null }) {
  try {
    if (!linhaComGrupos(canal) || !jid) return { gravou: false };
    let g = db.prepare("SELECT * FROM wa_grupos WHERE canal_id = ? AND jid = ?").get(canal.id, jid);
    if (!g) {
      const id = "gr_" + randomUUID();
      db.prepare("INSERT INTO wa_grupos (id,org_id,canal_id,jid,nome,ultima_em,nao_lidas,created_at) VALUES (?,?,?,?,?,?,0,?)")
        .run(id, canal.org_id, canal.id, jid, nomeGrupo || null, quando, Date.now());
      g = db.prepare("SELECT * FROM wa_grupos WHERE id = ?").get(id);
    } else if (nomeGrupo && nomeGrupo !== g.nome) db.prepare("UPDATE wa_grupos SET nome = ? WHERE id = ?").run(nomeGrupo, g.id);
    const corpo = String(texto || "").trim() || rotuloDe(tipo) || "Mensagem";
    try {
      db.prepare(`INSERT INTO wa_grupo_mensagens (id,grupo_id,org_id,direction,autor_nome,autor_numero,from_user_id,body,wa_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run("gm_" + randomUUID(), g.id, canal.org_id, fromMe ? "out" : "in",
        autorNome || null, autorNumero || null, fromUserId, corpo.slice(0, 4000), messageid || null, quando);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return { gravou: false, eco: true };   // a mesma mensagem duas vezes (ou o eco do que o CRM mandou)
      throw e;
    }
    db.prepare(`UPDATE wa_grupos SET ultima_em = MAX(COALESCE(ultima_em,0), ?), nao_lidas = nao_lidas + ? WHERE id = ?`)
      .run(quando, fromMe ? 0 : 1, g.id);
    return { gravou: true, grupo_id: g.id };
  } catch (e) {
    console.warn("[grupos] mensagem de grupo não gravada:", e.message);
    return { gravou: false };
  }
}

/* As linhas cujos grupos esta pessoa vê. */
function linhasVisiveis(user) {
  const linhas = db.prepare("SELECT * FROM canais WHERE org_id = ? AND ativo = 1 AND grupos = 1").all(user.org_id);
  return linhas.filter(c => c.tipo === "imobiliaria" ? supervisiona(user) : c.tipo === "corretor" && c.user_id === user.id);
}
function grupoDaPessoa(user, grupoId) {
  const g = db.prepare("SELECT * FROM wa_grupos WHERE id = ? AND org_id = ?").get(grupoId, user.org_id);
  if (!g || !linhasVisiveis(user).some(c => c.id === g.canal_id)) throw new ErroGrupo(404, "Grupo não encontrado.");
  return g;
}

export function gruposVisiveis(user) {
  const linhas = linhasVisiveis(user);
  if (!linhas.length) return { ligado: false, grupos: [] };
  const nomeLinha = new Map(linhas.map(c => [c.id, c.tipo === "imobiliaria" ? "Imobiliária" : (c.nome || "Meu WhatsApp")]));
  const grupos = db.prepare(`SELECT g.*, (SELECT body FROM wa_grupo_mensagens m WHERE m.grupo_id = g.id ORDER BY created_at DESC LIMIT 1) ultima
    FROM wa_grupos g WHERE g.org_id = ? AND g.canal_id IN (${linhas.map(() => "?").join(",")}) ORDER BY g.ultima_em DESC LIMIT 300`)
    .all(user.org_id, ...linhas.map(c => c.id))
    .map(g => ({ id: g.id, nome: g.nome || "Grupo sem nome", ultima: g.ultima ? String(g.ultima).slice(0, 140) : "",
      ultima_em: g.ultima_em, nao_lidas: g.nao_lidas || 0, linha: nomeLinha.get(g.canal_id) }));
  return { ligado: true, grupos };
}

export function mensagensDoGrupo(user, grupoId) {
  const g = grupoDaPessoa(user, grupoId);
  db.prepare("UPDATE wa_grupos SET nao_lidas = 0 WHERE id = ?").run(g.id);
  const msgs = db.prepare(`SELECT id, direction, autor_nome, autor_numero, body, created_at FROM wa_grupo_mensagens
    WHERE grupo_id = ? ORDER BY created_at DESC LIMIT 200`).all(g.id).reverse();
  return { grupo: { id: g.id, nome: g.nome || "Grupo sem nome" }, mensagens: msgs };
}

export async function enviarAoGrupo(user, grupoId, texto) {
  const g = grupoDaPessoa(user, grupoId);
  const t = String(texto || "").trim();
  if (!t) throw new ErroGrupo(400, "Escreva a mensagem.");
  if (t.length > 4000) throw new ErroGrupo(400, "A mensagem passou de 4.000 letras.");
  const canal = canalPorId(g.canal_id);
  const casa = canal.tipo === "imobiliaria";
  // No número da casa a mensagem sai assinada, como no atendimento.
  const r = await sendText({ orgId: user.org_id, canalId: casa ? null : canal.id, toPhone: g.jid, text: t, signedBy: casa ? user.name : undefined });
  gravarMensagemDeGrupo({ canal, jid: g.jid, fromMe: true, texto: casa ? `*${user.name}:* ${t}` : t, messageid: r?.messageid || null,
    autorNome: user.name, fromUserId: user.id });
  return mensagensDoGrupo(user, g.id);
}

/* Ligar ou desligar os grupos de uma linha. A da casa, só o gestor; a pessoal,
   só o dono. Desligar não apaga o que já foi gravado — só para de mostrar. */
export function ligarGrupos(user, { canalId, ligado, gestor }) {
  const c = canalPorId(canalId);
  if (!c || c.org_id !== user.org_id || !c.ativo) throw new ErroGrupo(404, "Linha não encontrada.");
  if (c.tipo === "disparo") throw new ErroGrupo(400, "A linha de disparo não mostra grupos.");
  if (c.provider === "meta") throw new ErroGrupo(400, "A API oficial da Meta não entrega mensagens de grupo.");
  if (c.tipo === "imobiliaria" && !gestor) throw new ErroGrupo(403, "Só o gestor liga os grupos do número da imobiliária.");
  if (c.tipo === "corretor" && c.user_id !== user.id) throw new ErroGrupo(403, "Só o dono do número liga os grupos dele.");
  db.prepare("UPDATE canais SET grupos = ? WHERE id = ?").run(ligado ? 1 : 0, c.id);
  return { ok: true, grupos: !!ligado };
}
