#!/usr/bin/env node
// Segundo cérebro — a ponte entre o Claude Code / Codex e o cofre do Obsidian.
//
// Este arquivo é copiado pelo instalador para "<cofre>/99 Sistema/scripts/" e
// descobre o cofre pela própria posição (dois níveis acima). Sem dependências:
// só Node 18+.
//
// Comandos (os três primeiros são chamados pelos hooks do Claude Code):
//   sessao          SessionStart     → contexto do projeto + preferências
//   prompt          UserPromptSubmit → notas relacionadas ao pedido, de todos os projetos
//   registrar       Stop             → diário da execução + pede ao Claude o registro do aprendizado
//   salvar          (o Claude/Codex chama) JSON no stdin, ou --arquivo x.json
//   buscar <texto>  busca manual (o Codex usa no começo da tarefa)
//   contexto [dir]  o mesmo contexto do "sessao", em texto (Codex)
//   codex-notify    "notify" do Codex: diário da execução
//   reindexar       refaz o "00 Índice.md"
//
// Regra de ouro dos hooks: NUNCA falhar. Hook com erro não pode travar o
// trabalho de ninguém — no pior caso, ele não ajuda.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ESTE_ARQUIVO = fileURLToPath(import.meta.url);
export const COFRE = path.resolve(process.env.SEGUNDO_CEREBRO || path.join(path.dirname(ESTE_ARQUIVO), "..", ".."));
const SCRIPT = ESTE_ARQUIVO.replace(/\\/g, "/");

export const TIPOS = {
  projeto:     { pasta: "01 Projetos",     rotulo: "Projeto",     emoji: "🔵" },
  decisao:     { pasta: "02 Decisões",     rotulo: "Decisão",     emoji: "🟣" },
  padrao:      { pasta: "03 Padrões",      rotulo: "Padrão",      emoji: "🟢" },
  preferencia: { pasta: "04 Preferências", rotulo: "Preferência", emoji: "🟠" },
  stack:       { pasta: "05 Stack",        rotulo: "Stack",       emoji: "💠" },
  aprendizado: { pasta: "06 Aprendizados", rotulo: "Aprendizado", emoji: "🟡" },
  sessao:      { pasta: "07 Sessões",      rotulo: "Sessão",      emoji: "⚪" },
};
const PASTA_SISTEMA = "99 Sistema";
const INDICE = "00 Índice.md";

// ---------------------------------------------------------------- utilidades
const pad = (n) => String(n).padStart(2, "0");
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hora = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const corta = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const slugTag = (s) => semAcento(s).replace(/^#/, "").replace(/[^a-z0-9/_-]+/g, "-").replace(/^-+|-+$/g, "");
const nomeArquivo = (t) => String(t).replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90) || "sem título";
const dentroDoCofre = (p) => { const r = path.relative(COFRE, path.resolve(p)); return !r.startsWith("..") && !path.isAbsolute(r); };

function lerStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
function lerEntrada() {
  try { return JSON.parse(lerStdin() || "{}"); } catch { return {}; }
}
function responderHook(evento, contexto) {
  if (!contexto) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: evento, additionalContext: contexto } }));
}

const STOP = new Set(`
a o as os um uma uns umas de da do das dos em no na nos nas por pela pelo pelas pelos para pra pro com sem sob sobre entre
e ou mas que se nao sim ja so tambem como quando onde porque pois entao isso isto esse essa este esta aquele aquela
eu voce voces ele ela eles elas nos meu minha meus minhas seu sua seus suas nosso nossa dele dela deles
ser estar ter haver fazer faz feito fazendo foi era sao esta estao tem tinha vai vou quero queria preciso precisa
pode podemos deve agora aqui ali mais menos muito muita muitos todo toda todos todas cada qualquer outro outra outros
coisa coisas favor obrigado olha veja ver vamos fica ficar deixa deixar algo alguma algum ainda depois antes sempre nunca
the and for with that this from into your you are was were have has had not but can will would should could
what when where which while there their them they then than also just only some such make made need want please
arquivo arquivos codigo funcao projeto sistema tela usar uso
`.split(/\s+/).filter(Boolean));

export function termos(texto) {
  const v = semAcento(texto).match(/[a-z0-9][a-z0-9_.-]{2,}/g) || [];
  const fora = v.map((t) => t.replace(/[._-]+$/, "")).filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));
  return [...new Set(fora)].slice(0, 40);
}
const raiz = (t) => (t.length > 6 ? t.slice(0, t.length - 2) : t);
function ocorrencias(texto, t) {
  let n = 0, i = -1;
  while ((i = texto.indexOf(t, i + 1)) !== -1 && n < 3) n++;
  return n;
}

// ------------------------------------------------------------ frontmatter
export function lerNota(abs) {
  const txt = fs.readFileSync(abs, "utf8");
  const fm = {};
  let corpo = txt;
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    corpo = txt.slice(m[0].length);
    let chave = null;
    for (const linha of m[1].split(/\r?\n/)) {
      const lista = linha.match(/^\s+-\s+(.*)$/);
      if (lista && chave) {
        if (!Array.isArray(fm[chave])) fm[chave] = [];
        fm[chave].push(tiraAspas(lista[1]));
        continue;
      }
      const k = linha.match(/^([^:\s][^:]*):\s*(.*)$/);
      if (!k) continue;
      chave = k[1].trim();
      let v = k[2].trim();
      if (v === "") fm[chave] = [];
      else if (/^\[.*\]$/.test(v)) fm[chave] = v.slice(1, -1).split(",").map((x) => tiraAspas(x.trim())).filter(Boolean);
      else fm[chave] = tiraAspas(v);
    }
  }
  return { fm, corpo };
}
function tiraAspas(v) {
  v = String(v).trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
function yamlValor(v) {
  const s = String(v);
  return /^[\w À-ú./@()+-]*$/.test(s) && !/^[-\s]/.test(s) && s !== "" && !/^(true|false|null|\d+)$/i.test(s) ? s : JSON.stringify(s);
}
export function escreverNota(abs, fm, corpo) {
  const linhas = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.length) { linhas.push(`${k}: []`); continue; }
      linhas.push(`${k}:`);
      for (const x of v) linhas.push(`  - ${yamlValor(x)}`);
    } else linhas.push(`${k}: ${yamlValor(v)}`);
  }
  linhas.push("---", "");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, linhas.join("\n") + corpo.replace(/^\n+/, ""), "utf8");
}
const lista = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// ------------------------------------------------------------------ notas
export function listarNotas() {
  const saida = [];
  const andar = (dir) => {
    let itens = [];
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of itens) {
      if (it.name.startsWith(".")) continue;
      const abs = path.join(dir, it.name);
      const rel = path.relative(COFRE, abs).replace(/\\/g, "/");
      if (it.isDirectory()) { if (rel !== PASTA_SISTEMA) andar(abs); continue; }
      if (!it.name.endsWith(".md") || rel === INDICE) continue;
      try {
        const { fm, corpo } = lerNota(abs);
        const st = fs.statSync(abs);
        saida.push({ abs, rel, titulo: it.name.slice(0, -3), fm, corpo, mtime: st.mtimeMs, tipo: fm.tipo || tipoDaPasta(rel) });
      } catch { /* nota ilegível não derruba a busca */ }
    }
  };
  andar(COFRE);
  return saida;
}
function tipoDaPasta(rel) {
  const p = rel.split("/")[0];
  return Object.keys(TIPOS).find((k) => TIPOS[k].pasta === p) || "nota";
}
function trecho(n, max = 380) {
  if (n.fm.resumo) return corta(n.fm.resumo, max);
  const limpo = n.corpo
    .replace(/^#.*$/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^---$/gm, "")
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a);
  return corta(limpo, max);
}

// ---------------------------------------------------------------- projetos
function raizDoProjeto(cwd) {
  let d = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return path.resolve(cwd || process.cwd());
}
export function projetoDe(cwd) {
  const r = raizDoProjeto(cwd);
  if (dentroDoCofre(r) || r === os.homedir() || r === path.parse(r).root) return null;
  const caminho = r.replace(/\\/g, "/");
  const pasta = path.join(COFRE, TIPOS.projeto.pasta);
  try {
    for (const f of fs.readdirSync(pasta)) {
      if (!f.endsWith(".md")) continue;
      const { fm } = lerNota(path.join(pasta, f));
      if (lista(fm.caminhos).includes(caminho)) return { nome: f.slice(0, -3), raiz: caminho };
    }
  } catch { /* pasta ainda não existe */ }
  return { nome: nomeArquivo(path.basename(r)), raiz: caminho };
}
function notaDoProjeto(nome) {
  return path.join(COFRE, TIPOS.projeto.pasta, `${nomeArquivo(nome)}.md`);
}
function garantirProjeto(proj) {
  const abs = notaDoProjeto(proj.nome);
  if (fs.existsSync(abs)) {
    if (proj.raiz) {
      const { fm, corpo } = lerNota(abs);
      const caminhos = lista(fm.caminhos);
      if (!caminhos.includes(proj.raiz)) { fm.caminhos = [...caminhos, proj.raiz]; escreverNota(abs, fm, corpo); }
    }
    return abs;
  }
  escreverNota(abs, {
    tipo: "projeto",
    tags: ["projeto", slugTag(proj.nome)],
    resumo: "",
    caminhos: proj.raiz ? [proj.raiz] : [],
    criado: hoje(),
    atualizado: hoje(),
  }, `# ${proj.nome}\n\n## Resumo\n_O que é o projeto, para quem, e em que pé está. Preenchido automaticamente nos registros._\n\n## Stack\n\n## Registros\n`);
  return abs;
}
function ligarAoProjeto(projNome, titulo, tipo) {
  const abs = notaDoProjeto(projNome);
  if (!fs.existsSync(abs) || titulo === projNome) return;
  const { fm, corpo } = lerNota(abs);
  const link = `[[${titulo}]]`;
  if (corpo.includes(link)) return;
  let novo = corpo.includes("## Registros") ? corpo.replace(/\s*$/, "\n") : corpo.replace(/\s*$/, "\n\n## Registros\n");
  novo += `- ${TIPOS[tipo]?.emoji || "•"} ${link} · ${TIPOS[tipo]?.rotulo || tipo} · ${hoje()}\n`;
  fm.atualizado = hoje();
  escreverNota(abs, fm, novo);
}

// ------------------------------------------------------------------ busca
export function buscar(texto, { projeto, limite = 5, minimo = 3 } = {}) {
  const ts = termos(texto);
  if (!ts.length) return [];
  const notas = listarNotas();
  const res = [];
  for (const n of notas) {
    const titulo = semAcento(n.titulo);
    const tags = semAcento(lista(n.fm.tags).join(" "));
    const projs = semAcento(lista(n.fm.projetos).concat(lista(n.fm.projeto)).join(" "));
    const corpo = semAcento(n.corpo + " " + (n.fm.resumo || ""));
    let pontos = 0, casou = 0;
    for (const t of ts) {
      const r = raiz(t);
      let p = 0;
      if (titulo.includes(r)) p += 5;
      if (tags.includes(r)) p += 4;
      if (projs.includes(r)) p += 2;
      p += ocorrencias(corpo, r);
      if (p) { pontos += p; casou++; }
    }
    if (!pontos) continue;
    pontos *= 1 + Math.min(casou - 1, 4) * 0.25; // vários termos diferentes valem mais que um repetido
    if (n.tipo === "sessao") pontos *= 0.5;      // o diário é bruto; nota consolidada vale mais
    if (projeto && semAcento(projs + " " + titulo).includes(semAcento(projeto))) pontos *= 1.2;
    if (pontos >= minimo) res.push({ ...n, pontos });
  }
  return res.sort((a, b) => b.pontos - a.pontos || b.mtime - a.mtime).slice(0, limite);
}
function formatarResultados(res) {
  return res.map((n) => {
    const t = TIPOS[n.tipo];
    const projs = lista(n.fm.projetos).concat(lista(n.fm.projeto)).filter(Boolean);
    return `### ${t ? `${t.emoji} ${t.rotulo}` : "📝"}: ${n.titulo}${projs.length ? ` (${projs.join(", ")})` : ""}\n` +
      `Arquivo: ${path.join(COFRE, n.rel)}\n${trecho(n)}`;
  }).join("\n\n");
}

// --------------------------------------------------------------- contexto
export function contextoDaSessao(cwd) {
  const proj = projetoDe(cwd);
  const notas = listarNotas();
  const partes = [`🧠 SEGUNDO CÉREBRO (cofre Obsidian em ${COFRE}) — memória de longo prazo de TODOS os projetos deste computador. Use-a sem que o usuário peça.`];

  if (proj) {
    const abs = notaDoProjeto(proj.nome);
    if (fs.existsSync(abs)) {
      const n = notas.find((x) => x.abs === abs);
      partes.push(`## Projeto atual: ${proj.nome}\n${n ? corta(n.corpo.replace(/^# .*\n/, ""), 1500) : ""}`);
    } else {
      partes.push(`## Projeto atual: ${proj.nome}\nAinda não tem nota no cérebro — ela nasce no primeiro registro. Registre a stack e o propósito do projeto quando entender.`);
    }
    const doProjeto = notas
      .filter((n) => n.tipo !== "projeto" && n.tipo !== "sessao" && lista(n.fm.projetos).includes(proj.nome))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 8);
    if (doProjeto.length) partes.push("## Últimos registros deste projeto\n" + doProjeto.map((n) => `- ${TIPOS[n.tipo]?.emoji || "•"} ${n.titulo}: ${trecho(n, 160)}`).join("\n"));
  }

  const prefs = notas.filter((n) => n.tipo === "preferencia").sort((a, b) => b.mtime - a.mtime).slice(0, 15);
  if (prefs.length) partes.push("## Preferências do usuário (valem em qualquer projeto)\n" + prefs.map((n) => `- ${n.titulo}: ${trecho(n, 200)}`).join("\n"));

  const padroes = notas.filter((n) => n.tipo === "padrao").sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  if (padroes.length) partes.push("## Padrões registrados (todos os projetos)\n" + padroes.map((n) => `- ${n.titulo}: ${trecho(n, 140)}`).join("\n"));

  partes.push(`## Como o cérebro funciona aqui
- A cada pedido, notas relacionadas de qualquer projeto chegam sozinhas no contexto. Para procurar mais: node "${SCRIPT}" buscar <termos>
- Ao final de cada execução com alterações, um aviso automático pede o registro do que foi aprendido. Nunca peça ao usuário para buscar ou registrar.
- Se uma nota contradiz o pedido atual, o pedido atual vence — e a mudança deve ser registrada.`);
  return partes.join("\n\n");
}

// -------------------------------------------------------------- transcrição
function textoDe(conteudo) {
  if (typeof conteudo === "string") return conteudo;
  if (!Array.isArray(conteudo)) return "";
  return conteudo.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}
function limparPedido(s) {
  return String(s || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, "")
    .trim();
}
export function analisarTranscricao(arquivo) {
  const r = { pedido: "", arquivos: [], executou: false, jaSalvou: false };
  let linhas = [];
  try { linhas = fs.readFileSync(arquivo, "utf8").split("\n"); } catch { return r; }
  const eventos = [];
  for (const l of linhas) { if (!l.trim()) continue; try { eventos.push(JSON.parse(l)); } catch { /* linha parcial */ } }

  // o pedido é a última mensagem do usuário que é texto de verdade (não resultado de ferramenta)
  let inicio = -1;
  for (let i = eventos.length - 1; i >= 0; i--) {
    const e = eventos[i];
    if (e.type !== "user" || e.isMeta) continue;
    const c = e.message?.content;
    const temResultado = Array.isArray(c) && c.some((b) => b?.type === "tool_result");
    const txt = limparPedido(textoDe(c));
    if (!temResultado && txt && !txt.startsWith("🧠")) { inicio = i; r.pedido = txt; break; }
  }
  if (inicio < 0) return r;

  const arquivos = new Set();
  for (const e of eventos.slice(inicio + 1)) {
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type !== "tool_use") continue;
      const inp = b.input || {};
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(b.name)) {
        const f = inp.file_path || inp.notebook_path;
        if (f && !dentroDoCofre(f)) { arquivos.add(f); r.executou = true; }
      } else if (b.name === "Bash") {
        const cmd = String(inp.command || "");
        if (cmd.includes("cerebro.mjs") && /\bsalvar\b/.test(cmd)) r.jaSalvou = true;
        else if (/\bgit\s+(commit|push|merge|rebase)\b|\b(npm|pnpm|yarn)\s+(install|add|publish)\b|\bmkdir\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i\b|>\s*(?!\/dev\/null|&)[^\s|]/.test(cmd)) r.executou = true;
      }
    }
  }
  r.arquivos = [...arquivos];
  return r;
}

// ------------------------------------------------------------------ diário
export function registrarNoDiario({ ferramenta, projeto, pedido, arquivos = [], resumo }) {
  const abs = path.join(COFRE, TIPOS.sessao.pasta, `${hoje()}.md`);
  if (!fs.existsSync(abs)) {
    escreverNota(abs, { tipo: "sessao", tags: ["sessao"], data: hoje() }, `# Sessões de ${hoje()}\n\nDiário automático de tudo que foi executado neste dia, em qualquer projeto.\n`);
  }
  const raizProj = projeto?.raiz;
  const rels = arquivos.slice(0, 15).map((f) => {
    const p = f.replace(/\\/g, "/");
    return raizProj && p.startsWith(raizProj + "/") ? p.slice(raizProj.length + 1) : p;
  });
  let bloco = `\n### ${hora()} · ${ferramenta}${projeto ? ` · [[${projeto.nome}]]` : ""}\n`;
  bloco += `- **Pedido:** ${corta(pedido, 300) || "—"}\n`;
  if (rels.length) bloco += `- **Arquivos:** ${rels.map((x) => "`" + x + "`").join(", ")}${arquivos.length > 15 ? ` e mais ${arquivos.length - 15}` : ""}\n`;
  if (resumo) bloco += `- **Resultado:** ${corta(resumo, 400)}\n`;
  fs.appendFileSync(abs, bloco, "utf8");
}

// ------------------------------------------------------------------ salvar
export function salvar(dados, { origem = "Claude Code", cwd } = {}) {
  const proj = dados.projeto ? { nome: nomeArquivo(dados.projeto), raiz: projetoDe(cwd)?.raiz } : projetoDe(cwd || dados.cwd);
  const projNome = proj?.nome || "Geral";
  if (proj) garantirProjeto(proj.nome === projNome ? proj : { nome: projNome });
  const feitos = [];
  for (const item of lista(dados.itens)) {
    if (!item || !item.titulo || !String(item.conteudo || item.resumo || "").trim()) continue;
    const tipo = TIPOS[item.tipo] && item.tipo !== "sessao" ? item.tipo : "aprendizado";
    const titulo = tipo === "projeto" ? projNome : nomeArquivo(item.titulo);
    const abs = tipo === "projeto" ? garantirProjeto({ nome: projNome, raiz: proj?.raiz }) : path.join(COFRE, TIPOS[tipo].pasta, `${titulo}.md`);
    const tags = [...new Set([tipo, slugTag(projNome), ...lista(item.tags).map(slugTag)].filter(Boolean))];
    const conteudo = String(item.conteudo || "").trim();

    if (fs.existsSync(abs)) {
      const { fm, corpo } = lerNota(abs);
      fm.tags = [...new Set([...lista(fm.tags), ...tags])];
      if (tipo !== "projeto") fm.projetos = [...new Set([...lista(fm.projetos), projNome])];
      if (item.resumo) fm.resumo = corta(item.resumo, 240);
      fm.atualizado = hoje();
      const bloco = `## Atualização — ${hoje()} · [[${projNome}]] · ${origem}\n\n${conteudo}\n`;
      let novo = corpo;
      if (conteudo && tipo === "projeto" && corpo.includes("\n## Registros")) {
        novo = corpo.replace("\n## Registros", `\n${bloco}\n## Registros`); // "Registros" fica sempre por último
      } else if (conteudo) novo = `${corpo.replace(/\s*$/, "")}\n\n${bloco}`;
      escreverNota(abs, fm, novo);
      feitos.push(`atualizada: ${path.relative(COFRE, abs)}`);
    } else {
      escreverNota(abs, {
        tipo,
        tags,
        projetos: [projNome],
        resumo: item.resumo ? corta(item.resumo, 240) : "",
        origem,
        criado: hoje(),
        atualizado: hoje(),
      }, `# ${titulo}\n\n${item.resumo ? `> ${item.resumo}\n\n` : ""}${conteudo}\n\n---\n*Projeto:* [[${projNome}]] · *Origem:* ${origem} · ${hoje()}\n`);
      feitos.push(`criada: ${path.relative(COFRE, abs)}`);
    }
    ligarAoProjeto(projNome, titulo, tipo);
  }
  reindexar();
  return feitos;
}

// --------------------------------------------------------------- índice
export function reindexar() {
  const notas = listarNotas();
  const linhas = [
    "---", "tipo: indice", "cssclasses:", "  - cerebro-indice", `atualizado: ${hoje()}`, "---", "",
    "# 🧠 Segundo Cérebro", "",
    "> Índice gerado automaticamente a cada registro. Não edite à mão — ele é refeito. Veja [[Como funciona]].", "",
    `**${notas.filter((n) => n.tipo !== "sessao").length} notas** · ${notas.filter((n) => n.tipo === "projeto").length} projetos · atualizado em ${hoje()} ${hora()}`, "",
  ];
  for (const [tipo, t] of Object.entries(TIPOS)) {
    let doTipo = notas.filter((n) => n.tipo === tipo).sort((a, b) => b.mtime - a.mtime);
    if (tipo === "sessao") doTipo = doTipo.sort((a, b) => b.titulo.localeCompare(a.titulo)).slice(0, 14);
    linhas.push(`## ${t.emoji} ${t.pasta.replace(/^\d+\s/, "")} (${notas.filter((n) => n.tipo === tipo).length})`, "");
    if (!doTipo.length) { linhas.push("_Nada ainda._", ""); continue; }
    for (const n of doTipo.slice(0, 60)) {
      const projs = lista(n.fm.projetos).filter((p) => p !== n.titulo);
      const resumo = tipo === "sessao" ? "" : trecho(n, 110);
      linhas.push(`- [[${n.titulo}]]${projs.length ? ` · ${projs.map((p) => `[[${p}]]`).join(", ")}` : ""}${resumo ? ` — ${resumo}` : ""}`);
    }
    if (doTipo.length > 60) linhas.push(`- _e mais ${doTipo.length - 60} na pasta ${t.pasta}_`);
    linhas.push("");
  }
  fs.writeFileSync(path.join(COFRE, INDICE), linhas.join("\n"), "utf8");
}

// ------------------------------------------------------------- instrução
function instrucaoDeRegistro(projNome) {
  return `🧠 REGISTRO AUTOMÁTICO NO SEGUNDO CÉREBRO (obrigatório; não pergunte nada ao usuário).
Antes de encerrar, salve o que esta execução ensinou e que vai servir em tarefas FUTURAS, em qualquer projeto:
decisões (com o porquê), padrões de código/arquitetura, preferências do usuário, stack/ferramentas/configuração, aprendizados (bugs, armadilhas e a solução).
Nada de óbvio nem de detalhe passageiro. Prefira atualizar uma nota existente (mesmo título = atualiza). Se nada novo foi aprendido, rode o comando com "itens": [].
Rode exatamente (um único comando):

node "${SCRIPT}" salvar <<'EOF'
{"projeto":"${projNome}","itens":[
  {"tipo":"decisao","titulo":"Título curto e reutilizável","resumo":"uma linha","tags":["tema"],"conteudo":"markdown curto: contexto, o que foi decidido, por quê"}
]}
EOF

Tipos: projeto (resumo/stack/estado do projeto atual), decisao, padrao, preferencia, stack, aprendizado.
Depois, encerre a resposta normalmente, sem comentar o registro.`;
}

// ------------------------------------------------------------------ main
function main() {
  const [cmd, ...args] = process.argv.slice(2);
  fs.mkdirSync(COFRE, { recursive: true });

  if (cmd === "sessao") {
    const e = lerEntrada();
    try { responderHook("SessionStart", contextoDaSessao(e.cwd)); } catch { /* nunca falha */ }
    return;
  }

  if (cmd === "prompt") {
    const e = lerEntrada();
    try {
      const pedido = String(e.prompt || "");
      if (pedido.trim().length < 12 || pedido.trim().startsWith("/")) return;
      const res = buscar(pedido, { projeto: projetoDe(e.cwd)?.nome });
      if (!res.length) return;
      responderHook("UserPromptSubmit",
        `🧠 Segundo cérebro — notas relacionadas a este pedido (de todos os projetos). Use o que for relevante; abra o arquivo se precisar do texto completo.\n\n${formatarResultados(res)}`);
    } catch { /* nunca falha */ }
    return;
  }

  if (cmd === "registrar") {
    const e = lerEntrada();
    try {
      if (e.stop_hook_active) return;               // já pedimos nesta volta: não entra em laço
      const t = analisarTranscricao(e.transcript_path);
      if (!t.executou) return;                       // conversa sem execução não vira registro
      const proj = projetoDe(e.cwd);
      if (proj) garantirProjeto(proj);
      registrarNoDiario({ ferramenta: "Claude Code", projeto: proj, pedido: t.pedido, arquivos: t.arquivos });
      reindexar();
      if (t.jaSalvou) return;
      process.stdout.write(JSON.stringify({ decision: "block", reason: instrucaoDeRegistro(proj?.nome || "Geral") }));
    } catch { /* nunca falha */ }
    return;
  }

  if (cmd === "salvar") {
    let bruto = "";
    const iArq = args.indexOf("--arquivo");
    if (iArq >= 0 && args[iArq + 1]) bruto = fs.readFileSync(args[iArq + 1], "utf8");
    else if (args[0] && args[0].trim().startsWith("{")) bruto = args.join(" ");
    else bruto = lerStdin();
    let dados;
    try { dados = JSON.parse(bruto.trim().replace(/^﻿/, "")); } catch (err) {
      console.error(`JSON inválido para o segundo cérebro: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const origem = args.includes("--codex") ? "Codex" : "Claude Code";
    const feitos = salvar(dados, { origem, cwd: process.cwd() });
    console.log(feitos.length ? `🧠 Segundo cérebro: ${feitos.join("; ")}` : "🧠 Segundo cérebro: nada novo a registrar.");
    return;
  }

  if (cmd === "buscar") {
    const res = buscar(args.join(" "), { projeto: projetoDe(process.cwd())?.nome, limite: 8, minimo: 2 });
    console.log(res.length ? formatarResultados(res) : "🧠 Nada relacionado no segundo cérebro.");
    return;
  }

  if (cmd === "contexto") {
    console.log(contextoDaSessao(args[0] || process.cwd()));
    return;
  }

  if (cmd === "codex-notify") {
    try {
      const ev = JSON.parse(args[args.length - 1] || "{}");
      if (ev.type !== "agent-turn-complete") return;
      const cwd = ev.cwd || process.cwd();
      const proj = projetoDe(cwd);
      if (proj) garantirProjeto(proj);
      const pedido = lista(ev["input-messages"] || ev.input_messages).map(String).join(" / ");
      registrarNoDiario({ ferramenta: "Codex", projeto: proj, pedido, resumo: ev["last-assistant-message"] || ev.last_assistant_message });
      reindexar();
    } catch { /* nunca falha */ }
    return;
  }

  if (cmd === "reindexar") { reindexar(); console.log(`🧠 Índice refeito em ${path.join(COFRE, INDICE)}`); return; }

  console.log("Uso: cerebro.mjs sessao|prompt|registrar|salvar|buscar <texto>|contexto [pasta]|codex-notify <json>|reindexar");
}

const direto = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ESTE_ARQUIVO);
if (direto) {
  try { main(); } catch (err) {
    const cmd = process.argv[2];
    if (cmd === "salvar" || cmd === "buscar" || cmd === "reindexar") { console.error(err.message); process.exitCode = 1; }
  }
}
