#!/usr/bin/env node
// Importa conversas antigas do Claude para o cofre, em "09 Conversas".
//
//   node importar.mjs <exportação do claude.ai>   → o manifest-….json (com os .zip baixados ao lado), um .zip, uma pasta ou o conversations.json
//   node importar.mjs --claude-code               → o histórico do Claude Code deste computador (~/.claude/projects)
//   ... --cofre "C:/caminho/do/cofre"             → outro cofre (sem isto, usa o do instalador)
//
// Uma nota por conversa, com o texto de você e do Claude. Rodar de novo é seguro:
// conversa já importada é pulada, e só é refeita se ganhou mensagens desde então.
// Notas que você criou no cofre nunca são tocadas.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const LIMITE_MSG = 12000;   // caracteres por mensagem: código colado inteiro deixa a nota ilegível
const LIMITE_NOTA = 120000; // e a busca lê todas as notas a cada pedido

// ------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const iCofre = args.indexOf("--cofre");
const cofreArg = iCofre >= 0 ? args.splice(iCofre, 2)[1] : null;
const doClaudeCode = args.includes("--claude-code");
const fonte = args.find((a) => !a.startsWith("--"));

function cofreInstalado() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "settings.json"), "utf8"));
    for (const ev of Object.values(s.hooks || {}))
      for (const m of ev || []) for (const h of m.hooks || []) {
        const r = String(h.command || "").match(/"([^"]*cerebro\.mjs)"/);
        if (r) return path.resolve(path.dirname(r[1]), "..", "..");
      }
  } catch { /* sem instalação */ }
  return null;
}
const COFRE_ALVO = cofreArg ? path.resolve(cofreArg) : cofreInstalado();
if (!COFRE_ALVO || !fs.existsSync(COFRE_ALVO)) {
  console.error("\n✖ Não achei o cofre. Rode antes: node ferramentas/segundo-cerebro/instalar.mjs\n  (ou indique: --cofre \"C:/caminho/do/cofre\")\n");
  process.exit(1);
}
if (!fonte && !doClaudeCode) {
  console.log(`Uso:
  node importar.mjs <manifest-….json, .zip, pasta ou conversations.json da exportação do claude.ai>
  node importar.mjs --claude-code`);
  process.exit(1);
}
process.env.SEGUNDO_CEREBRO = COFRE_ALVO;
const { COFRE, TIPOS, lerNota, escreverNota, reindexar } = await import(pathToFileURL(path.join(AQUI, "cerebro.mjs")).href);

// ------------------------------------------------------------- utilidades
const pad = (n) => String(n).padStart(2, "0");
const dataDe = (t) => { const d = new Date(t); return isNaN(d) ? null : d; };
const dia = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const quando = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const corta = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const nomeArquivo = (t) => String(t).replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Sem título";
const limpar = (s) => String(s || "")
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  .replace(/<(command|local-command)[a-z-]*>[\s\S]*?<\/\1[a-z-]*>/g, "")
  .trim();

const PASTA = path.join(COFRE, TIPOS.conversa.pasta);
fs.mkdirSync(PASTA, { recursive: true });

// id → { arquivo, mensagens } das conversas já importadas
const jaImportadas = new Map();
for (const f of fs.readdirSync(PASTA)) {
  if (!f.endsWith(".md")) continue;
  try {
    const { fm } = lerNota(path.join(PASTA, f));
    if (fm.id) jaImportadas.set(String(fm.id), { arquivo: path.join(PASTA, f), mensagens: Number(fm.mensagens) || 0 });
  } catch { /* nota ilegível fica como está */ }
}

const conta = { novas: 0, atualizadas: 0, puladas: 0, vazias: 0 };
function gravar({ id, titulo, origem, inicio, projeto, msgs }) {
  msgs = msgs.filter((m) => m.texto.trim());
  if (!msgs.length || !msgs.some((m) => m.quem === "voce")) { conta.vazias++; return; }
  const antes = jaImportadas.get(id);
  if (antes && antes.mensagens >= msgs.length) { conta.puladas++; return; }

  const d = inicio || msgs.find((m) => m.data)?.data || new Date();
  const primeira = msgs.find((m) => m.quem === "voce").texto;
  titulo = nomeArquivo(titulo || corta(primeira, 70));
  let corpo = `# ${titulo}\n\n> 💬 Conversa importada do ${origem}${projeto ? ` · projeto ${projeto}` : ""} · ${quando(d)} · ${msgs.length} mensagens\n`;
  let cortou = false;
  for (const m of msgs) {
    let t = m.texto.trim();
    if (t.length > LIMITE_MSG) t = t.slice(0, LIMITE_MSG) + "\n\n_[…mensagem cortada na importação]_";
    const bloco = `\n## ${m.quem === "voce" ? "🧑 Você" : "🤖 Claude"}${m.data ? ` · ${quando(m.data)}` : ""}\n\n${t}\n`;
    if (corpo.length + bloco.length > LIMITE_NOTA) { cortou = true; break; }
    corpo += bloco;
  }
  if (cortou) corpo += `\n---\n_Conversa longa demais: o resto ficou de fora da nota._\n`;

  const fm = {
    tipo: "conversa",
    tags: ["conversa", origem === "claude.ai" ? "claude-ai" : "claude-code"],
    resumo: corta(primeira, 200),
    origem,
    projeto: projeto || undefined,
    id,
    data: dia(d),
    mensagens: msgs.length,
    importado: dia(new Date()),
  };
  let abs = antes?.arquivo;
  if (!abs) {
    abs = path.join(PASTA, `${dia(d)} ${titulo}.md`);
    for (let i = 2; fs.existsSync(abs); i++) abs = path.join(PASTA, `${dia(d)} ${titulo} (${i}).md`);
  }
  escreverNota(abs, fm, corpo);
  jaImportadas.set(id, { arquivo: abs, mensagens: msgs.length });
  antes ? conta.atualizadas++ : conta.novas++;
}

// --------------------------------------------------- exportação do claude.ai
// A exportação já veio em dois formatos: um .zip com conversations.json, e (out/2026) um
// "manifest-….json" que só lista vários .zip para baixar. Os dois são aceitos: o que se procura
// dentro deles é qualquer .json com conversas (lista de objetos com "chat_messages").
const semAspas = (p) => path.resolve(String(p).replace(/^["']|["']$/g, "").replace(/^~(?=$|[\\/])/, HOME));

function extrair(zip) {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "claude-export-"));
  // tar abre .zip no Windows 10+ e no Mac; no Linux, unzip
  let r = spawnSync("tar", ["-xf", zip, "-C", destino], { encoding: "utf8" });
  if (r.status !== 0) r = spawnSync("unzip", ["-q", "-o", zip, "-d", destino], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Não consegui abrir "${path.basename(zip)}". Clique nele com o botão direito → Extrair tudo, e passe a pasta extraída.`);
  return destino;
}
function arquivosDe(dir, nivel = 0, saida = []) {
  if (nivel > 5) return saida;
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) arquivosDe(p, nivel + 1, saida);
    else saida.push(p);
  }
  return saida;
}
// manifest → os .zip listados nele, procurados ao lado do manifest (e na pasta Downloads)
function zipsDoManifest(manifest, dados) {
  const pastas = [...new Set([path.dirname(manifest), path.join(HOME, "Downloads")])];
  const achados = [], faltam = [];
  for (const f of dados.data_files || []) {
    const nome = f.filename || "";
    const base = nome.replace(/\.zip$/i, "");
    let achou = null;
    for (const d of pastas) {
      if (!fs.existsSync(d)) continue;
      const exato = path.join(d, nome);
      if (nome && fs.existsSync(exato)) { achou = exato; break; }
      // o navegador às vezes renomeia: "conversations-000 (1).zip"
      const parecido = fs.readdirSync(d).find((x) => x.toLowerCase().endsWith(".zip") && x.startsWith(base));
      if (base && parecido) { achou = path.join(d, parecido); break; }
    }
    if (achou) achados.push({ ...f, arquivo: achou }); else faltam.push(f);
  }
  return { achados, faltam };
}
function ehConversa(c) { return c && typeof c === "object" && Array.isArray(c.chat_messages); }
function conversasDoJson(arq) {
  let dados;
  try { dados = JSON.parse(fs.readFileSync(arq, "utf8")); } catch { return []; }
  if (Array.isArray(dados)) return dados.filter(ehConversa);
  if (ehConversa(dados)) return [dados];
  for (const v of Object.values(dados || {})) if (Array.isArray(v) && v.some(ehConversa)) return v.filter(ehConversa);
  return [];
}
function juntarFontes(entrada) {
  const abs = semAspas(entrada);
  if (!fs.existsSync(abs)) throw new Error(`Não achei "${abs}".`);
  if (fs.statSync(abs).isDirectory()) {
    // pasta: os .json soltos e os .zip dentro dela
    const tudo = arquivosDe(abs);
    return [...tudo.filter((f) => !/\.zip$/i.test(f)), ...tudo.filter((f) => /\.zip$/i.test(f)).flatMap((z) => arquivosDe(extrair(z)))];
  }
  if (/\.zip$/i.test(abs)) return arquivosDe(extrair(abs));
  if (/\.json$/i.test(abs)) {
    let dados = null;
    try { dados = JSON.parse(fs.readFileSync(abs, "utf8")); } catch { /* não é JSON */ }
    if (dados && Array.isArray(dados.data_files)) {
      const { achados, faltam } = zipsDoManifest(abs, dados);
      console.log(`Manifest com ${dados.data_files.length} arquivos: ${achados.length} baixados, ${faltam.length} faltando.`);
      if (faltam.length) {
        console.log("\n  Ainda faltam baixar (abra cada link no navegador, com o claude.ai logado; vencem em 24h):");
        for (const f of faltam) console.log(`   • ${f.filename} (${f.category})\n     ${f.export_url}`);
        console.log("");
      }
      return achados.flatMap((f) => arquivosDe(extrair(f.arquivo)));
    }
    return [abs];
  }
  throw new Error(`"${path.basename(abs)}" não é .zip, .json nem pasta.`);
}
function textoClaudeAi(m) {
  const partes = [];
  if (Array.isArray(m.content) && m.content.length) {
    for (const b of m.content) if (b?.type === "text" && b.text) partes.push(b.text);
  }
  if (!partes.length && m.text) partes.push(m.text);
  for (const a of [...(m.attachments || []), ...(m.files || [])]) {
    const nome = a.file_name || a.name;
    if (nome) partes.push(`_[anexo: ${nome}]_`);
  }
  return partes.join("\n\n");
}
function importarClaudeAi(entrada) {
  const arquivos = juntarFontes(entrada);
  const vistas = new Set();
  let total = 0;
  for (const arq of arquivos.filter((f) => /\.json$/i.test(f))) {
    for (const c of conversasDoJson(arq)) {
      const id = `claude.ai:${c.uuid || c.id || `${c.name}-${c.created_at}`}`;
      if (vistas.has(id)) continue;
      vistas.add(id);
      total++;
      const msgs = c.chat_messages.map((m) => ({
        quem: m.sender === "human" || m.role === "user" ? "voce" : "claude",
        texto: textoClaudeAi(m),
        data: dataDe(m.created_at),
      }));
      gravar({ id, titulo: c.name, origem: "claude.ai", inicio: dataDe(c.created_at), msgs });
    }
  }
  console.log(`Encontrei ${total} conversas do claude.ai.`);
  if (!total) {
    // formato que ainda não se conhece: mostra o que veio, sem conteúdo, para ajustar o importador
    console.log("\n  Nenhuma conversa reconhecida. Arquivos que vieram (mande um print disto):");
    for (const f of arquivos.slice(0, 40)) {
      let tam = 0; try { tam = fs.statSync(f).size; } catch { /* */ }
      console.log(`   • ${f.split(/[\\/]claude-export-[^\\/]+[\\/]/).pop()}  (${Math.round(tam / 1024)} KB)`);
    }
    if (arquivos.length > 40) console.log(`   … e mais ${arquivos.length - 40}`);
  }
}

// ------------------------------------------- histórico do Claude Code (local)
function textoClaudeCode(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n\n");
}
function importarClaudeCode() {
  const base = path.join(HOME, ".claude", "projects");
  if (!fs.existsSync(base)) throw new Error(`Não achei o histórico do Claude Code em "${base}".`);
  const arquivos = [];
  for (const d of fs.readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(base, d.name))) if (f.endsWith(".jsonl")) arquivos.push(path.join(base, d.name, f));
  }
  console.log(`Lendo ${arquivos.length} conversas do Claude Code deste computador…`);
  for (const arq of arquivos) {
    let linhas = [];
    try { linhas = fs.readFileSync(arq, "utf8").split("\n"); } catch { continue; }
    const msgs = [];
    let cwd = null, inicio = null;
    for (const l of linhas) {
      if (!l.trim()) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== "user" && e.type !== "assistant") continue;
      if (e.isMeta || e.isSidechain) continue;
      cwd = cwd || e.cwd;
      const d = dataDe(e.timestamp);
      inicio = inicio || d;
      const c = e.message?.content;
      if (e.type === "user" && Array.isArray(c) && c.some((b) => b?.type === "tool_result")) continue;
      const t = limpar(textoClaudeCode(c));
      if (!t || t.startsWith("🧠")) continue; // aviso do próprio segundo cérebro
      const quem = e.type === "user" ? "voce" : "claude";
      const ultima = msgs[msgs.length - 1];
      if (ultima && ultima.quem === quem && quem === "claude") ultima.texto += "\n\n" + t; // um turno do Claude vem em pedaços
      else msgs.push({ quem, texto: t, data: d });
    }
    const pasta = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : null; // caminho do Windows ou do Mac
    const projeto = pasta && !/^scratch-\d{4}-\d{2}-\d{2}/i.test(pasta) ? pasta : null;
    gravar({ id: `claude-code:${path.basename(arq, ".jsonl")}`, origem: "Claude Code", projeto, inicio, msgs });
  }
}

// ------------------------------------------------------------------- main
try {
  console.log(`\n💬 Importando conversas para ${COFRE}\n`);
  if (fonte) importarClaudeAi(fonte);
  if (doClaudeCode) importarClaudeCode();
  reindexar();
  console.log(`\n  ✔ ${conta.novas} novas · ${conta.atualizadas} atualizadas · ${conta.puladas} já estavam lá · ${conta.vazias} vazias puladas`);
  console.log(`  ✔ pasta: ${PASTA}\n\nAbra o Obsidian: as conversas estão em "${TIPOS.conversa.pasta}". A partir de agora o Claude Code também as encontra quando você perguntar algo parecido.\n`);
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
