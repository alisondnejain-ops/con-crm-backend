/* O CÓDIGO DE ACESSO DE CADA CONTA (14/10/2026, pedido do Ali: "token de
   segurança para cada conta criada no ConHub… instantâneo, até 1 minuto, e
   quando zerar o contador o token renumera… protege imobiliárias grandes
   inclusive do acesso que um master pode fazer").

   Cada conta (imobiliária ou corretor autônomo) tem um código de 6 dígitos
   que muda a cada 60 segundos. Só a GESTÃO da conta o vê, dentro do CRM. O
   master do ConHub só entra na conta digitando o código daquele minuto — ou
   seja, só entra quando o cliente passa o código, e o cliente sabe quando.

   COMO O CÓDIGO NASCE: uma semente aleatória por conta (`orgs.acesso_segredo`,
   fechada pelo cofre quando há CRYPTO_KEY) e o minuto atual, passados por um
   HMAC — a mesma ideia dos aplicativos autenticadores. Nada é guardado por
   minuto: o código do minuto se calcula, e o do minuto seguinte é outro.

   A ENTRADA VALE POR UM TEMPO (`ACESSO_HORAS`) e fica registrada
   (`acessos_master`). Passado o prazo, o crachá do master deixa de valer
   naquela conta e ele volta ao hub; para entrar de novo, um código novo. A
   gestão vê a lista de entradas e pode encerrar a que estiver aberta.

   O QUE ISTO NÃO COBRE, e precisa ser dito: quem administra o servidor e o
   banco (a hospedagem) continua tendo como ler os dados por fora do sistema.
   O código fecha a porta do SISTEMA — o hub e o botão "Entrar". */
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import db from "../db.js";
import { fechar, abrir } from "./cofre.js";

export const JANELA_MS = 60 * 1000;
/* Folga depois da virada: o código passado no WhatsApp aos 58 segundos chega
   já no minuto seguinte. Sem ela, quase todo código passado no fim do minuto
   falharia. Curta de propósito — o código continua sendo "do minuto". */
export const FOLGA_MS = 15 * 1000;
export const ACESSO_HORAS = Number(process.env.MASTER_ACESSO_HORAS) || 2;
/* A EXCEÇÃO DE CONTA CONHECIDA (15/10/2026, pedido do Ali: "Conecta, Eleandro,
   VJ… clientes que a gente está fazendo a implementação… pelo menos 4 horas de
   uso para depois renovar"). O master marca a conta no hub e entra SEM código;
   cada entrada vale estas horas e, vencida, renova-se clicando em Entrar de
   novo. Continua registrada na lista que a gestão da conta vê, marcada "sem
   código", e a gestão pode desligar a exceção. */
export const ACESSO_LIVRE_HORAS = Number(process.env.MASTER_ACESSO_LIVRE_HORAS) || 4;
export const acessoLivre = (org) => !!(org && org.acesso_livre);

/* AS 4 HORAS SÃO UM SALDO POR DIA, NÃO POR ENTRADA (15/10/2026, pedido do
   Ali: "se eu entrei, passei 10 minutos na Conecta, diminui esses 10 minutos
   do saldo de 4 horas diárias… se usei as 4 horas, só amanhã… não cumulativas").

   O saldo é DA CONTA, somando todos os sócios: a exceção é uma concessão a
   ela, e dois sócios não podem fazer de 4 horas oito.

   O QUE CONTA COMO USO: o tempo em que a conta está aberta e o sistema está
   falando com o servidor (a tela pede novidades de 10 em 10 segundos). Cada
   pedido soma o tempo desde o anterior; intervalo maior que 2 minutos não
   conta — é a aba fechada ou o computador dormindo. O hub (`/orgs`) não conta:
   voltar ao hub para de gastar. O dia é o de Brasília. */
const LIVRE_MS = () => ACESSO_LIVRE_HORAS * 3600000;
const LACUNA_MAX = 2 * 60 * 1000;
const FUSO_MS = 3 * 3600000; // Brasília, UTC-3 (sem horário de verão)
export const diaDe = (ms) => new Date(ms - FUSO_MS).toISOString().slice(0, 10);
export const fimDoDia = (ms) => Date.parse(diaDe(ms) + "T00:00:00Z") + FUSO_MS + 86400000;

export function usadoHoje(orgId, agora = Date.now()) {
  return db.prepare("SELECT usado_ms FROM acesso_livre_uso WHERE org_id = ? AND dia = ?").get(orgId, diaDe(agora))?.usado_ms || 0;
}
export const saldoLivreHoje = (orgId, agora = Date.now()) => Math.max(0, LIVRE_MS() - usadoHoje(orgId, agora));

/* Soma ao saldo do dia o tempo desde o último pedido desta entrada. */
export function registrarUso(acessoId, agora = Date.now()) {
  if (!acessoId) return;
  const a = db.prepare("SELECT id, org_id, sem_codigo, visto_em FROM acessos_master WHERE id = ?").get(String(acessoId));
  if (!a || !a.sem_codigo) return;
  const delta = agora - (a.visto_em || agora);
  if (delta > 0 && delta <= LACUNA_MAX) {
    const soma = Math.min(delta, saldoLivreHoje(a.org_id, agora));
    if (soma > 0) db.prepare(`INSERT INTO acesso_livre_uso (org_id, dia, usado_ms) VALUES (?,?,?)
        ON CONFLICT(org_id, dia) DO UPDATE SET usado_ms = usado_ms + excluded.usado_ms`).run(a.org_id, diaDe(agora), soma);
  }
  db.prepare("UPDATE acessos_master SET visto_em = ? WHERE id = ?").run(agora, a.id);
}

/* As contas que NÃO pedem código: a do próprio ConHub (ambiente interno) e a
   de demonstração — nenhuma das duas tem dado de cliente de verdade. */
export function contaPedeCodigo(org) {
  if (!org) return false;
  return org.tipo !== "interna" && !org.demo;
}

function semente(orgId) {
  const o = db.prepare("SELECT acesso_segredo FROM orgs WHERE id = ?").get(orgId);
  if (!o) return null;
  let s = o.acesso_segredo ? abrir(o.acesso_segredo) : null;
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    db.prepare("UPDATE orgs SET acesso_segredo = ? WHERE id = ?").run(fechar(s), orgId);
  }
  return s;
}

const codigoDaJanela = (s, janela) => {
  const h = crypto.createHmac("sha256", s).update(String(janela)).digest();
  const n = h.readUInt32BE(h[h.length - 1] & 0x0f) & 0x7fffffff;
  return String(n % 1000000).padStart(6, "0");
};

/* O código de agora e até quando ele vale (para a tela mostrar o contador). */
export function codigoAtual(orgId, agora = Date.now()) {
  const s = semente(orgId);
  if (!s) return null;
  const janela = Math.floor(agora / JANELA_MS);
  return { codigo: codigoDaJanela(s, janela), muda_em: (janela + 1) * JANELA_MS, segundos: JANELA_MS / 1000 };
}

export function codigoConfere(orgId, digitado, agora = Date.now()) {
  const d = String(digitado || "").replace(/\D/g, "");
  if (d.length !== 6) return false;
  const s = semente(orgId);
  if (!s) return false;
  const janela = Math.floor(agora / JANELA_MS);
  const validos = [codigoDaJanela(s, janela)];
  if (agora - janela * JANELA_MS < FOLGA_MS) validos.push(codigoDaJanela(s, janela - 1));
  return validos.some(c => crypto.timingSafeEqual(Buffer.from(c), Buffer.from(d)));
}

export function abrirAcesso(orgId, userId, agora = Date.now(), { semCodigo = false } = {}) {
  const id = "am_" + randomUUID();
  /* Sem código, a entrada vale até a meia-noite; quem a corta antes é o
     saldo do dia (conferido a cada pedido em `acessoValido`). */
  const ate = semCodigo ? fimDoDia(agora) : agora + ACESSO_HORAS * 3600000;
  db.prepare("INSERT INTO acessos_master (id, org_id, user_id, inicio, ate, sem_codigo, visto_em) VALUES (?,?,?,?,?,?,?)")
    .run(id, orgId, userId, agora, ate, semCodigo ? 1 : 0, agora);
  return id;
}

/* O crachá do master numa conta alheia só vale com uma entrada aberta: a do
   próprio crachá, desta conta, deste master, dentro do prazo e não encerrada. */
export function acessoValido(acessoId, orgId, userId, agora = Date.now()) {
  if (!acessoId) return false;
  const a = db.prepare("SELECT * FROM acessos_master WHERE id = ?").get(String(acessoId));
  if (!a || a.org_id !== orgId || a.user_id !== userId || a.encerrado_em || a.ate <= agora) return false;
  return !a.sem_codigo || saldoLivreHoje(orgId, agora) > 0;
}
export const acessoSemCodigo = (acessoId) =>
  !!(acessoId && db.prepare("SELECT sem_codigo FROM acessos_master WHERE id = ?").get(String(acessoId))?.sem_codigo);

export function acessosDaConta(orgId) {
  const agora = Date.now();
  return db.prepare(`SELECT a.id, a.inicio, a.ate, a.encerrado_em, a.sem_codigo, u.name AS quem
      FROM acessos_master a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.org_id = ? ORDER BY a.inicio DESC LIMIT 20`).all(orgId)
    .map(a => ({ ...a, aberto: !a.encerrado_em && a.ate > agora }));
}

/* A gestão encerra as entradas abertas do ConHub na conta dela. */
export function encerrarAcessos(orgId) {
  return db.prepare("UPDATE acessos_master SET encerrado_em = ? WHERE org_id = ? AND encerrado_em IS NULL AND ate > ?")
    .run(Date.now(), orgId, Date.now()).changes;
}
