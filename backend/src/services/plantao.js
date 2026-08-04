/* Escala de plantão.

   Quem fica de sobreaviso em cada turno. Na Conecta são dois corretores por
   turno, manhã e tarde de segunda a sexta, e só manhã no sábado — mas nada
   disso está travado no código: a escala é uma linha por pessoa por turno, e o
   dia sem ninguém simplesmente não tem linha. Domingo, feriado e turno vazio
   são a mesma coisa aqui.

   O aviso das 08:00 segue o mesmo princípio do corte de expediente: em vez de
   confiar num alarme, guardamos ATÉ QUANDO já avisamos. Se o servidor estava
   fora do ar às 08:00, o aviso sai quando ele voltar; se reiniciar três vezes
   de manhã, ninguém recebe três notificações. */

import db from "../db.js";
import { randomUUID } from "crypto";
import { semMaster } from "../auth.js";
import { avisar } from "./push.js";

export const TURNOS = ["manha", "tarde"];
export const ROTULO_TURNO = { manha: "manhã", tarde: "tarde" };
export const HORA_AVISO = 8;   // 08:00, no fuso da operação

export const meiaNoite = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* Data vinda da tela ou da planilha. Aceita "2026-08-01" e "01/08/2026" — o
   segundo formato é o que sai do Excel em português, e lido pelo JS puro
   viraria janeiro de 2026 em vez de agosto. */
export function lerDia(valor) {
  const t = String(valor ?? "").trim();
  if (!t) return NaN;
  const br = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1])).getTime();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  const ms = new Date(t).getTime();
  return isFinite(ms) ? meiaNoite(ms) : NaN;
}

// A escala de um período, já com o nome de quem está escalado.
export function escala(orgId, { de, ate }) {
  return db.prepare(`
    SELECT p.id, p.dia, p.turno, p.user_id, u.name AS nome, u.role
    FROM plantoes p LEFT JOIN users u ON u.id = p.user_id
    WHERE p.org_id = ? AND p.dia BETWEEN ? AND ?
    ORDER BY p.dia, p.turno, u.name`).all(orgId, meiaNoite(de), meiaNoite(ate));
}

// Quem está de plantão num dia, separado por turno.
export function doDia(orgId, dia = Date.now()) {
  const linhas = escala(orgId, { de: dia, ate: dia });
  return {
    dia: meiaNoite(dia),
    manha: linhas.filter(l => l.turno === "manha"),
    tarde: linhas.filter(l => l.turno === "tarde"),
  };
}

/* Define QUEM fica num turno. Substitui a lista inteira daquele dia+turno —
   é como a gestão pensa ("hoje de manhã são fulano e beltrano"), e evita o
   vaivém de adicionar e remover um a um. */
export function definirTurno(orgId, { dia, turno, userIds, autorId }) {
  if (!TURNOS.includes(turno)) return { ok: false, error: "Turno inválido." };
  const d = lerDia(dia);
  if (!isFinite(d)) return { ok: false, error: "Data inválida." };

  // Só entra quem é da imobiliária e está ativo — nome de gente que saiu não
  // pode continuar aparecendo na escala do mês que vem.
  const validos = new Set(db.prepare(
    `SELECT u.id FROM users u WHERE u.org_id = ? AND u.status = 'ativo'
     AND u.role IN ('corretor','sdr')${semMaster("u")}`).all(orgId).map(u => u.id));

  const escolhidos = [...new Set((userIds || []).filter(id => validos.has(id)))];
  const gravar = db.transaction(() => {
    db.prepare("DELETE FROM plantoes WHERE org_id = ? AND dia = ? AND turno = ?").run(orgId, d, turno);
    for (const id of escolhidos)
      db.prepare(`INSERT INTO plantoes (id,org_id,dia,turno,user_id,criado_por,created_at)
                  VALUES (?,?,?,?,?,?,?)`).run("pl_" + randomUUID(), orgId, d, turno, id, autorId, Date.now());
  });
  gravar();
  return { ok: true, dia: d, turno, quantos: escolhidos.length };
}

// Limpa um período inteiro. Usado antes de subir uma escala nova do mês.
export function limpar(orgId, { de, ate }) {
  const info = db.prepare("DELETE FROM plantoes WHERE org_id = ? AND dia BETWEEN ? AND ?")
    .run(orgId, meiaNoite(de), meiaNoite(ate));
  return info.changes;
}

/* Importa a escala de uma planilha no formato que a Conecta já usa:
   Data | Dia | Manhã 1 | Manhã 2 | Tarde 1 | Tarde 2

   Os nomes vêm escritos à mão, então o casamento é tolerante: nome completo,
   primeiro nome, sem acento, sem diferenciar maiúscula. O que não casar volta
   na resposta — melhor a gestão saber quem ficou de fora do que o sistema
   inventar uma pessoa parecida. */
const chave = (t) => String(t || "").trim().toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function importarEscala(orgId, linhas, autorId) {
  const pessoas = db.prepare(
    `SELECT u.id, u.name FROM users u WHERE u.org_id = ? AND u.status = 'ativo'
     AND u.role IN ('corretor','sdr')${semMaster("u")}`).all(orgId);

  const porNome = new Map();
  for (const p of pessoas) {
    porNome.set(chave(p.name), p.id);
    const primeiro = chave(p.name).split(" ")[0];
    // Primeiro nome só entra se for único — com duas Anas, adivinhar é pior
    // do que avisar que não deu para identificar.
    if (!porNome.has(primeiro)) porNome.set(primeiro, p.id);
    else porNome.set(primeiro, "__ambiguo__");
  }

  const naoEncontrados = new Set();
  let dias = 0, escalados = 0;

  const rodar = db.transaction(() => {
    for (const l of linhas) {
      const d = lerDia(l.data);
      if (!isFinite(d)) continue;
      dias++;
      for (const turno of TURNOS) {
        const nomes = (l[turno] || []).map(n => String(n || "").trim()).filter(Boolean);
        const ids = [];
        for (const n of nomes) {
          const achou = porNome.get(chave(n));
          if (achou && achou !== "__ambiguo__") ids.push(achou);
          else naoEncontrados.add(n);
        }
        db.prepare("DELETE FROM plantoes WHERE org_id = ? AND dia = ? AND turno = ?").run(orgId, d, turno);
        for (const id of [...new Set(ids)]) {
          db.prepare(`INSERT INTO plantoes (id,org_id,dia,turno,user_id,criado_por,created_at)
                      VALUES (?,?,?,?,?,?,?)`).run("pl_" + randomUUID(), orgId, d, turno, id, autorId, Date.now());
          escalados++;
        }
      }
    }
  });
  rodar();
  return { dias, escalados, nao_encontrados: [...naoEncontrados] };
}

/* Aviso das 08:00 para quem está de plantão hoje.

   `ultimo_aviso_plantao` guarda o dia já avisado. É o que impede a notificação
   repetida a cada reinício do servidor — e o que faz o aviso ainda sair, um
   pouco atrasado, se às 08:00 o servidor estava fora do ar. */
export async function avisarPlantaoDeHoje(orgId, agora = Date.now()) {
  const hoje = meiaNoite(agora);
  const d = new Date(agora);
  if (d.getHours() < HORA_AVISO) return { enviados: 0, motivo: "ainda não deu a hora" };

  const org = db.prepare("SELECT ultimo_aviso_plantao FROM orgs WHERE id = ?").get(orgId);
  if (org && org.ultimo_aviso_plantao >= hoje) return { enviados: 0, motivo: "já avisado hoje" };

  const escalados = doDia(orgId, hoje);
  const porPessoa = new Map();
  for (const t of TURNOS)
    for (const p of escalados[t]) {
      if (!porPessoa.has(p.user_id)) porPessoa.set(p.user_id, []);
      porPessoa.get(p.user_id).push(ROTULO_TURNO[t]);
    }

  // Marca ANTES de enviar: push que falha não pode virar aviso repetido no
  // minuto seguinte, e a escala do dia não muda por causa disso.
  db.prepare("UPDATE orgs SET ultimo_aviso_plantao = ? WHERE id = ?").run(hoje, orgId);

  let enviados = 0;
  for (const [userId, turnos] of porPessoa) {
    try {
      const r = await avisar(userId, {
        titulo: "Hoje é seu dia de plantão",
        corpo: `Você está na escala de ${turnos.join(" e ")}. Fique de prontidão para os leads que entrarem.`,
      });
      enviados += (r && r.enviados) || 0;
    } catch (e) { console.error("[plantao] falha ao avisar:", e.message); }
  }
  return { enviados, pessoas: porPessoa.size };
}

export async function avisarPlantaoEmTodas(agora = Date.now()) {
  for (const { id } of db.prepare("SELECT id FROM orgs").all()) {
    try { await avisarPlantaoDeHoje(id, agora); }
    catch (e) { console.error("[plantao] erro no aviso:", e.message); }
  }
}
