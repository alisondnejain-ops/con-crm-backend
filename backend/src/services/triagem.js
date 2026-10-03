/* ===== TRIAGEM DE NÚMEROS NOVOS (03/10/2026) =====

   Pedido do Ali: "colocar no CRM apenas as mensagens de leads… para não
   espelhar conversas pessoais". Até aqui TODO número que escrevia virava lead.
   No WhatsApp pessoal do corretor isso é sério: a mãe, o amigo e o fornecedor
   viravam "lead" na caixa dele, com a conversa inteira gravada no banco da
   imobiliária.

   Agora, numa linha com a triagem ligada, número que ainda não é lead vai para
   "Novos contatos" — só NOME e NÚMERO, nunca o texto —, e alguém decide:

     · É lead    → o lead nasce (mesma regra de sempre: lead-whatsapp.js) e a
                   conversa passa a ser espelhada dali em diante.
     · É pessoal → o número é ignorado para sempre NAQUELA linha. Tem volta
                   ("voltar a receber"), porque um clique errado tiraria um
                   cliente de verdade do CRM sem ninguém perceber.

   O preço, escrito na tela: as mensagens que chegaram antes da decisão não
   ficam no CRM. É de propósito — guardá-las "por via das dúvidas" seria gravar
   justamente a conversa pessoal que o recurso existe para não gravar.

   ONDE VALE (decisão do Ali):
     · linha pessoal do corretor — ligada por padrão;
     · número da casa de uma imobiliária — DESLIGADA por padrão: quem escreve
       para lá quase sempre é cliente, e um passo a mais em todo lead novo
       atrasaria o tempo de resposta da atendente;
     · número da casa de um CORRETOR AUTÔNOMO — também desligada por padrão,
       mesmo sendo, muitas vezes, o WhatsApp pessoal dele: é ali que a IA
       atende lead novo a qualquer hora, e a triagem seguraria todo lead novo
       antes de a IA vê-lo. Ele liga se quiser, e a tela avisa do efeito;
     · linha de disparo — nunca (quem responde a uma campanha é lead).
   `canais.triagem` nulo = esse padrão; 0/1 = escolha de alguém, que vale mais.

   QUEM DECIDE: na linha pessoal, só o DONO dela — nem a gestão vê os números
   que chegam no WhatsApp pessoal de alguém antes de virarem lead. No número da
   casa, quem supervisiona (gestor, atendente, dono da conta autônoma). */

import { randomUUID } from "crypto";
import db from "../db.js";
import { supervisiona, ehDonoAutonomo } from "../auth.js";
import { numeroAlternativo } from "./uazapi.js";
import { campanhaQueAlcancou } from "./disparo.js";
import { canalPorId, garantirCasa } from "./canais.js";
import { nascerLeadDoWhatsapp } from "./lead-whatsapp.js";
import { avisar } from "./push.js";
import { apagar as apagarArquivo, chaveDaUrl } from "./storage.js";
import { mascararTelefone } from "../seguranca.js";

export class ErroTriagem extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// '' é o número da casa — sentinela, e não NULL (ver db.js).
export const linhaDe = (canal) => (!canal || canal.tipo === "imobiliaria" ? "" : canal.id);
const canalDaLinha = (orgId, linha) => (linha ? canalPorId(linha) : garantirCasa(orgId));
const formas = (phone) => [phone, numeroAlternativo(phone)].filter(Boolean);
const tipoDaOrg = (orgId) => (db.prepare("SELECT tipo FROM orgs WHERE id = ?").get(orgId) || {}).tipo;

export function triagemLigada(canal) {
  if (!canal || canal.tipo === "disparo") return false;
  if (canal.triagem === 0 || canal.triagem === 1) return !!canal.triagem;
  return canal.tipo === "corretor";
}

export function ehNumeroPessoal(orgId, linha, phone) {
  const f = formas(phone);
  return !!db.prepare(`SELECT 1 FROM numeros_pessoais WHERE org_id = ? AND linha = ?
    AND phone IN (${f.map(() => "?").join(",")}) LIMIT 1`).get(orgId, linha, ...f);
}

/* Chamado pela mensageria para todo número que ainda NÃO é lead, antes de
   baixar a mídia. Devolve o texto do diagnóstico quando a mensagem para aqui,
   ou null quando ela segue e o lead nasce como sempre. Nunca lança: falha
   aqui não pode impedir um lead de entrar. */
export function triarNumeroNovo({ canal, phone, nome }) {
  try {
    const orgId = canal.org_id;
    const linha = linhaDe(canal);
    if (ehNumeroPessoal(orgId, linha, phone))
      return "ignorado: número marcado como conversa pessoal nesta linha (nada foi guardado)";
    if (!triagemLigada(canal)) return null;
    // Quem recebeu uma campanha da imobiliária e respondeu é lead — não pessoal.
    if (campanhaQueAlcancou(orgId, phone)) return null;

    const f = formas(phone);
    const ja = db.prepare(`SELECT id FROM contatos_novos WHERE org_id = ? AND linha = ?
      AND phone IN (${f.map(() => "?").join(",")}) LIMIT 1`).get(orgId, linha, ...f);
    const agora = Date.now();
    if (ja) {
      db.prepare("UPDATE contatos_novos SET ultima_em = ?, quantas = quantas + 1, nome = COALESCE(?, nome) WHERE id = ?")
        .run(agora, nome || null, ja.id);
    } else {
      db.prepare(`INSERT INTO contatos_novos (id,org_id,linha,phone,nome,primeira_em,ultima_em,quantas)
        VALUES (?,?,?,?,?,?,?,1)`).run("cn_" + randomUUID(), orgId, linha, phone, nome || null, agora, agora);
      /* Um aviso só, na primeira mensagem — e só para o dono da linha. Sem ele
         o cliente de verdade esperaria até alguém abrir o Atender por acaso. */
      const dono = canal.tipo === "corretor" ? canal.user_id
        : tipoDaOrg(orgId) === "autonomo" ? (db.prepare("SELECT dono_user_id FROM orgs WHERE id = ?").get(orgId) || {}).dono_user_id
        : null;
      if (dono) avisar(dono, { titulo: "Número novo no WhatsApp",
        corpo: `${nome || "Alguém"} escreveu. É lead? Decida em Atender → Novos contatos.` }).catch(() => {});
      console.log(`[triagem] número novo (${mascararTelefone(phone)}) em Novos contatos — linha ${linha ? canal.nome : "da casa"}`);
    }
    return "aguardando triagem: número novo em Novos contatos (nada da conversa foi guardado)";
  } catch (e) {
    console.error("[triagem] falhou, a mensagem segue como antes:", e.message);
    return null;
  }
}

/* ===== Quem vê o quê ===== */

function linhasVisiveis(orgId, user) {
  const linhas = [];
  const minha = db.prepare("SELECT * FROM canais WHERE org_id = ? AND tipo = 'corretor' AND user_id = ? AND ativo = 1")
    .get(orgId, user.id);
  if (minha) linhas.push(minha.id);
  if (supervisiona(user)) linhas.push("");
  return linhas;
}

function podeDecidir(orgId, user, linha) {
  if (!linha) return supervisiona(user);
  const c = canalPorId(linha);
  return !!c && c.org_id === orgId && c.tipo === "corretor" && c.user_id === user.id;
}

// Mudar a chave: na casa, só o gestor (adm ou dono da conta autônoma); na linha pessoal, o dono.
function podeConfigurar(orgId, user, linha) {
  if (!linha) return user.role === "adm" || ehDonoAutonomo(user);
  return podeDecidir(orgId, user, linha);
}

const rotuloDaLinha = (orgId, linha, user) => {
  if (!linha) return "Número da imobiliária";
  const c = canalPorId(linha);
  return c && c.user_id === user.id ? "Seu WhatsApp" : (c?.nome || "Outro número");
};

export function estado(orgId, user) {
  const linhas = linhasVisiveis(orgId, user);
  if (!linhas.length) return { novos: [], pessoais: [], linhas: [] };
  const marc = linhas.map(() => "?").join(",");
  const novos = db.prepare(`SELECT id, linha, phone, nome, primeira_em, ultima_em, quantas FROM contatos_novos
    WHERE org_id = ? AND linha IN (${marc}) ORDER BY ultima_em DESC LIMIT 200`).all(orgId, ...linhas)
    .map(n => ({ ...n, linha_nome: rotuloDaLinha(orgId, n.linha, user) }));
  const pessoais = db.prepare(`SELECT linha, phone, nome, marcado_em FROM numeros_pessoais
    WHERE org_id = ? AND linha IN (${marc}) ORDER BY marcado_em DESC LIMIT 300`).all(orgId, ...linhas)
    .map(n => ({ ...n, linha_nome: rotuloDaLinha(orgId, n.linha, user) }));
  const chaves = linhas.map(l => {
    const c = canalDaLinha(orgId, l);
    /* `robo`: a IA atende nesta linha? Com a triagem ligada, ela só fala depois
       do "É lead" — a tela avisa, senão parece que a IA parou. */
    const robo = !!c && (c.tipo === "corretor" ? !!c.robo_ligado
      : !!(db.prepare("SELECT robo_ativo FROM orgs WHERE id = ?").get(orgId) || {}).robo_ativo);
    return { linha: l, nome: rotuloDaLinha(orgId, l, user), ligada: triagemLigada(c), robo,
             escolhida: c && (c.triagem === 0 || c.triagem === 1), pode_mudar: podeConfigurar(orgId, user, l) };
  });
  return { novos, pessoais, linhas: chaves };
}

/* ===== Decisões ===== */

export function decidir(orgId, user, id, decisao) {
  const n = db.prepare("SELECT * FROM contatos_novos WHERE id = ? AND org_id = ?").get(id, orgId);
  if (!n) throw new ErroTriagem(404, "Esse contato já foi decidido ou não existe.");
  if (!podeDecidir(orgId, user, n.linha)) throw new ErroTriagem(403, "Só quem cuida deste número decide sobre ele.");

  if (decisao === "pessoal") {
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO numeros_pessoais (org_id,linha,phone,nome,marcado_por,marcado_em)
        VALUES (?,?,?,?,?,?)`).run(orgId, n.linha, n.phone, n.nome, user.id, Date.now());
      db.prepare("DELETE FROM contatos_novos WHERE id = ?").run(n.id);
    })();
    return { ok: true, decisao };
  }
  if (decisao !== "lead") throw new ErroTriagem(400, "Decisão inválida.");

  const canal = canalDaLinha(orgId, n.linha);
  if (!canal) throw new ErroTriagem(409, "Esse número do WhatsApp não está mais conectado.");
  const f = formas(n.phone);
  let lead = db.prepare(`SELECT * FROM leads WHERE org_id = ? AND phone IN (${f.map(() => "?").join(",")})
    ORDER BY created_at DESC LIMIT 1`).get(orgId, ...f);
  const novo = !lead;
  db.transaction(() => {
    if (!lead) lead = nascerLeadDoWhatsapp({ canal, phone: n.phone, nome: n.nome });
    db.prepare("DELETE FROM contatos_novos WHERE id = ?").run(n.id);
  })();
  // Caiu na mão de outra pessoa (a catraca do número da casa): ela precisa saber.
  if (novo && lead.assigned_to && lead.assigned_to !== user.id)
    avisar(lead.assigned_to, { titulo: "Novo lead no WhatsApp", corpo: `${lead.name} acabou de chamar.`, leadId: lead.id }).catch(() => {});
  return { ok: true, decisao, lead_id: lead.id, novo };
}

export function voltarAReceber(orgId, user, linha, phone) {
  linha = String(linha || "");
  if (!podeDecidir(orgId, user, linha)) throw new ErroTriagem(403, "Só quem cuida deste número pode desfazer.");
  const r = db.prepare("DELETE FROM numeros_pessoais WHERE org_id = ? AND linha = ? AND phone = ?").run(orgId, linha, String(phone || ""));
  if (!r.changes) throw new ErroTriagem(404, "Esse número não está na lista de pessoais.");
  return { ok: true };
}

export function definirTriagem(orgId, user, linha, ligada) {
  linha = String(linha || "");
  if (!podeConfigurar(orgId, user, linha))
    throw new ErroTriagem(403, linha ? "Só o dono deste WhatsApp muda isto." : "Só o gestor muda isto no número da imobiliária.");
  const c = canalDaLinha(orgId, linha);
  if (!c || c.org_id !== orgId) throw new ErroTriagem(404, "Linha não encontrada.");
  db.prepare("UPDATE canais SET triagem = ? WHERE id = ?").run(ligada ? 1 : 0, c.id);
  // Desligar a triagem não pode deixar gente esperando para sempre: o que
  // estava em "Novos contatos" continua lá até alguém decidir.
  return { ok: true, ligada: !!ligada };
}

/* "Isto é conversa pessoal", na ficha de um lead que já entrou.

   Apaga a conversa do CRM (o lead e tudo que pende dele, inclusive os
   arquivos) e marca o número como pessoal naquela linha. Recusado com venda
   registrada — aí já é cliente, e apagar mudaria o relatório de dinheiro. */
export async function marcarLeadComoPessoal(orgId, user, leadId) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  if (!lead) throw new ErroTriagem(404, "Lead não encontrado.");
  const canal = lead.canal_id ? canalPorId(lead.canal_id) : null;
  const linha = canal && canal.tipo === "corretor" ? canal.id : canal && canal.tipo === "disparo" ? canal.id : "";
  const pode = supervisiona(user) || (canal && canal.tipo === "corretor" && canal.user_id === user.id);
  if (!pode) throw new ErroTriagem(403, "No número da imobiliária, só a gestão e a atendente marcam uma conversa como pessoal.");
  if (lead.sale_value || lead.sale_date) throw new ErroTriagem(409, "Este lead tem venda registrada — não dá para tratá-lo como conversa pessoal.");

  const arquivos = db.prepare("SELECT media_url FROM messages WHERE lead_id = ? AND media_url IS NOT NULL").all(lead.id).map(m => m.media_url);
  let mensagens = 0;
  db.transaction(() => {
    mensagens = db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ?").get(lead.id).n;
    // Toda tabela que pende do lead, descoberta pelo próprio banco — a mesma
    // régua da exclusão de conta: lista escrita à mão para no tempo.
    const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    for (const t of tabelas) {
      if (t === "leads") continue;
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
      if (cols.includes("lead_id")) db.prepare(`DELETE FROM "${t}" WHERE lead_id = ?`).run(lead.id);
    }
    db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
    if (lead.phone) db.prepare(`INSERT OR REPLACE INTO numeros_pessoais (org_id,linha,phone,nome,marcado_por,marcado_em)
      VALUES (?,?,?,?,?,?)`).run(orgId, linha, lead.phone, lead.name, user.id, Date.now());
  })();
  // Os arquivos saem depois, fora da transação: falha aqui não desfaz nada.
  for (const url of arquivos) {
    const chave = chaveDaUrl(url);
    if (chave) apagarArquivo(chave).catch(() => {});
  }
  console.log(`[triagem] conversa marcada como pessoal e apagada (${mascararTelefone(lead.phone || "")}, ${mensagens} mensagens)`);
  return { ok: true, mensagens, arquivos: arquivos.length };
}
