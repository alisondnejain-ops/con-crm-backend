/* ===== OS TOKENS DO WHATSAPP GUARDADOS FECHADOS (07/11/2026) =====

   O que fica pendente desde a auditoria de 02/09/2026: os tokens da Uazapi
   (`canais.token`, `orgs.uazapi_token`, `marketing_numero.token`) e o App
   Secret da Meta (`canais.app_secret`) moravam em claro no banco. Quem
   tivesse o arquivo do banco falava pelo WhatsApp de todas as imobiliárias.

   Pedido do Ali: "cuidado pra não quebrar nada no código nem desconectar
   ninguém". Por isso o desenho tem quatro travas:

   1. A BUSCA NÃO DEPENDE DA CHAVE. O webhook acha a linha pelo token que a
      Uazapi manda. Como o valor fechado muda a cada gravação (o cofre usa um
      número aleatório), a busca passou a ser pela IMPRESSÃO DIGITAL do token
      (`token_hash`, sha-256), que não precisa de chave nenhuma. E toda busca
      continua aceitando o valor EM CLARO (`token_hash = ? OR token = ?`):
      linha gravada por um caminho que esqueceu a impressão continua sendo
      reconhecida — a falha que este sistema mais teme é "parou de entrar lead".

   2. O TOKEN SÓ É ABERTO NA HORA DE USAR — no instante de falar com a Uazapi
      ou com a Meta (`lerSegredo`). Quem só pergunta "tem token?" continua
      perguntando do mesmo jeito: fechado também é "tem".

   3. A CHAVE ERRADA NÃO MISTURA DUAS CHAVES. Na primeira vez que o cofre
      fecha um token, ele grava um SELO (`config_plataforma.cofre_selo_wa`):
      um texto conhecido, fechado com a chave da época. Se um dia o servidor
      subir com outra `CRYPTO_KEY` (ou sem nenhuma), o selo não abre e o CRM
      para de FECHAR tokens novos — grava em claro e grita no
      `/integracoes`. Sem isso, cada token salvo depois do engano ficaria
      fechado com uma chave diferente, e consertar a variável só curaria
      metade das linhas.

   4. VOLTAR ATRÁS SEM DESCONECTAR. Com `WHATSAPP_TOKENS_EM_CLARO=1` no
      Railway, o start ABRE todos os tokens e grava em claro de novo (e não
      fecha mais nada). É o passo obrigatório ANTES de publicar uma versão
      anterior a esta: o código antigo não sabe abrir, e mandaria o texto
      fechado como token para a Uazapi — todo WhatsApp pararia de uma vez.

   Sem `CRYPTO_KEY` nada é fechado (o cofre devolve o valor como veio), e só
   a impressão digital é gravada: esta versão sobe igual numa instalação sem
   chave. O `verify_token` da Meta continua em claro de propósito: ele não é
   segredo (é colado na tela da Meta) e o webhook o procura por igualdade. */

import crypto from "crypto";
import db from "../db.js";
import { fechar, abrir, cofreLigado, PREFIXO } from "./cofre.js";

const SELO_TEXTO = "conhub-selo-whatsapp";
const SELO_CHAVE = "cofre_selo_wa";

export const emClaroPedido = () => process.env.WHATSAPP_TOKENS_EM_CLARO === "1";

// A impressão digital do token. Sem chave: a busca tem que funcionar sempre.
export function hashToken(t) {
  const s = String(t ?? "").trim();
  if (!s) return null;
  return crypto.createHash("sha256").update("conhub:wa:" + s).digest("hex");
}

/* Abre um segredo guardado. Valor em claro volta como veio; valor fechado
   que não abre (chave ausente ou trocada) volta como "" — o envio diz "sem
   conexão" em vez de mandar lixo para a Uazapi. */
export function lerSegredo(v) {
  if (v === null || v === undefined || v === "") return v ?? null;
  const s = String(v);
  if (!s.startsWith(PREFIXO)) return s;
  return abrir(s) ?? "";
}

let estado = { fecha: false, motivo: "" };

function conferirSelo() {
  if (emClaroPedido()) return { fecha: false, motivo: "WHATSAPP_TOKENS_EM_CLARO=1: os tokens estão sendo guardados em claro (passo para voltar a uma versão anterior)." };
  if (!cofreLigado()) {
    const selo = db.prepare("SELECT valor FROM config_plataforma WHERE chave = ?").get(SELO_CHAVE);
    return { fecha: false, motivo: selo
      ? "ERRO: existem tokens do WhatsApp fechados e a CRYPTO_KEY não está no servidor. Recoloque a mesma chave — sem ela essas linhas não enviam."
      : "CRYPTO_KEY ausente: os tokens do WhatsApp estão guardados em claro." };
  }
  const selo = db.prepare("SELECT valor FROM config_plataforma WHERE chave = ?").get(SELO_CHAVE);
  if (!selo) {
    db.prepare("INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES (?,?,?)")
      .run(SELO_CHAVE, fechar(SELO_TEXTO), Date.now());
    return { fecha: true, motivo: "" };
  }
  if (abrir(selo.valor) === SELO_TEXTO) return { fecha: true, motivo: "" };
  return { fecha: false, motivo: "ERRO: a CRYPTO_KEY do servidor não é a mesma que fechou os tokens do WhatsApp. Os tokens novos estão sendo guardados em claro até a chave certa voltar." };
}

/* Prepara um segredo para gravar: fechado quando dá, em claro quando não. */
export function guardarSegredo(t) {
  if (t === null || t === undefined || t === "") return t ?? null;
  const s = String(t);
  if (s.startsWith(PREFIXO)) return estado.fecha ? s : (lerSegredo(s) || s);
  return estado.fecha ? fechar(s) : s;
}

/* O par que vai para o banco: o valor guardado e a impressão digital. */
export function paraGravar(t) {
  const claro = lerSegredo(t);
  return { valor: guardarSegredo(t), hash: claro ? hashToken(claro) : null };
}

export const situacaoDosTokens = () => ({ ...estado,
  fechados: contar("enc"), em_claro: contar("claro") });

function contar(tipo) {
  const cond = tipo === "enc" ? "LIKE 'enc:v1:%'" : "NOT LIKE 'enc:v1:%'";
  try {
    return db.prepare(`SELECT COUNT(*) n FROM canais WHERE token IS NOT NULL AND token <> '' AND token ${cond}`).get().n
      + db.prepare(`SELECT COUNT(*) n FROM orgs WHERE uazapi_token IS NOT NULL AND uazapi_token <> '' AND uazapi_token ${cond}`).get().n;
  } catch { return null; }
}

/* ===== AS COLUNAS E A CONVERSÃO DO QUE JÁ ESTÁ GRAVADO ===== */
const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!colunas("canais").includes("token_hash")) db.exec("ALTER TABLE canais ADD COLUMN token_hash TEXT");
if (!colunas("orgs").includes("uazapi_token_hash")) db.exec("ALTER TABLE orgs ADD COLUMN uazapi_token_hash TEXT");
if (!colunas("marketing_numero").includes("token_hash")) db.exec("ALTER TABLE marketing_numero ADD COLUMN token_hash TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_canal_token_hash ON canais(token_hash)");
/* A garantia que o índice único de `token` dava (um token = uma linha da
   Uazapi) passa para a impressão digital. Se o banco tiver algo que a impeça,
   o start segue sem ela — as conferências das rotas continuam valendo. */
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_canal_token_hash_u ON canais(token_hash) WHERE token_hash IS NOT NULL AND provider = 'uazapi'"); }
catch (e) { console.error("[tokens-wa] índice único da impressão digital não foi criado:", e.message); }
db.exec("CREATE INDEX IF NOT EXISTS idx_orgs_token_hash ON orgs(uazapi_token_hash)");

estado = conferirSelo();

/* Roda a cada start e é idempotente: só toca linha que precisa (sem
   impressão digital, ou com o valor no estado errado). Uma linha cujo valor
   fechado não abre NÃO é tocada — mexer nela apagaria o único rastro. */
function converter() {
  const mudou = { canais: 0, orgs: 0, numeros: 0, nao_abre: 0 };
  const alvo = (v) => {
    const claro = lerSegredo(v);
    if (String(v).startsWith(PREFIXO) && !claro) { mudou.nao_abre++; return null; }
    // Já fechado com a chave certa e devendo ficar fechado: não reescreve.
    if (estado.fecha && String(v).startsWith(PREFIXO)) return { claro, guardado: v };
    return { claro, guardado: guardarSegredo(claro) };
  };
  db.transaction(() => {
    for (const c of db.prepare("SELECT id, token, token_hash, app_secret FROM canais WHERE (token IS NOT NULL AND token <> '') OR (app_secret IS NOT NULL AND app_secret <> '')").all()) {
      let token = c.token, hash = c.token_hash, secret = c.app_secret;
      if (c.token) { const a = alvo(c.token); if (a) { token = a.guardado; hash = hashToken(a.claro); } }
      if (c.app_secret) { const a = alvo(c.app_secret); if (a) secret = a.guardado; }
      if (token !== c.token || hash !== c.token_hash || secret !== c.app_secret) {
        db.prepare("UPDATE canais SET token = ?, token_hash = ?, app_secret = ? WHERE id = ?").run(token, hash, secret, c.id);
        mudou.canais++;
      }
    }
    for (const o of db.prepare("SELECT id, uazapi_token, uazapi_token_hash FROM orgs WHERE uazapi_token IS NOT NULL AND uazapi_token <> ''").all()) {
      const a = alvo(o.uazapi_token); if (!a) continue;
      const hash = hashToken(a.claro);
      if (a.guardado !== o.uazapi_token || hash !== o.uazapi_token_hash) {
        db.prepare("UPDATE orgs SET uazapi_token = ?, uazapi_token_hash = ? WHERE id = ?").run(a.guardado, hash, o.id);
        mudou.orgs++;
      }
    }
    for (const n of db.prepare("SELECT org_id, token, token_hash FROM marketing_numero WHERE token IS NOT NULL AND token <> ''").all()) {
      const a = alvo(n.token); if (!a) continue;
      const hash = hashToken(a.claro);
      if (a.guardado !== n.token || hash !== n.token_hash) {
        db.prepare("UPDATE marketing_numero SET token = ?, token_hash = ? WHERE org_id = ?").run(a.guardado, hash, n.org_id);
        mudou.numeros++;
      }
    }
  })();
  return mudou;
}

try {
  const m = converter();
  if (m.canais || m.orgs || m.numeros)
    console.log(`[tokens-wa] ${estado.fecha ? "fechados" : "em claro"}: ${m.canais} linha(s), ${m.orgs} imobiliária(s), ${m.numeros} número(s) de disparo`);
  if (m.nao_abre) console.error(`[tokens-wa] ${m.nao_abre} token(s) fechado(s) não abrem com a CRYPTO_KEY atual — essas linhas não enviam até a chave certa voltar.`);
  if (estado.motivo) (estado.motivo.startsWith("ERRO") ? console.error : console.log)(`[tokens-wa] ${estado.motivo}`);
} catch (e) {
  // A conversão nunca derruba o start: com ela falhando, tudo continua como estava.
  console.error("[tokens-wa] conversão dos tokens falhou (nada foi alterado):", e.message);
}

/* Só para os testes: refaz a conferência do selo e a conversão depois de
   trocar a chave em memória. */
export function _reconferir() { estado = conferirSelo(); return converter(); }
