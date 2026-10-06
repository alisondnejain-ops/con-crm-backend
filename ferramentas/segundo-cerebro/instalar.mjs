#!/usr/bin/env node
// Instalador do segundo cérebro.
//
//   node instalar.mjs                      → acha o cofre do Obsidian sozinho (pergunta se houver vários)
//   node instalar.mjs "/caminho/do/cofre"  → usa esse cofre
//   node instalar.mjs --remover            → tira os hooks e as instruções (o cofre fica intacto)
//
// O que ele faz, sem apagar nada que já exista:
//   1. cria as pastas coloridas, o índice, as notas iniciais e os modelos no cofre;
//   2. copia o cerebro.mjs para "<cofre>/99 Sistema/scripts/";
//   3. liga as cores no Obsidian (trecho de CSS + grupos de cor do grafo + pasta de modelos);
//   4. Claude Code: hooks globais em ~/.claude/settings.json + bloco no ~/.claude/CLAUDE.md;
//   5. Codex: bloco no ~/.codex/AGENTS.md + "notify" no ~/.codex/config.toml.
// Rodar de novo é seguro: ele só atualiza o que é dele.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const fwd = (p) => p.replace(/\\/g, "/");
const INICIO = "<!-- segundo-cerebro:inicio -->";
const FIM = "<!-- segundo-cerebro:fim -->";
const PASTAS = ["01 Projetos", "02 Decisões", "03 Padrões", "04 Preferências", "05 Stack", "06 Aprendizados", "07 Sessões", "99 Sistema/scripts", "99 Sistema/Modelos"];

const ok = (m) => console.log(`  ✔ ${m}`);
const aviso = (m) => console.log(`  ⚠ ${m}`);

function lerJSON(p, padrao) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return padrao; }
}
function gravarJSON(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}
function backupUmaVez(p) {
  if (!fs.existsSync(p)) return;
  const b = `${p}.antes-do-segundo-cerebro`;
  if (!fs.existsSync(b)) fs.copyFileSync(p, b);
}
function trocarBloco(arquivo, conteudo) {
  let txt = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, "utf8") : "";
  const re = new RegExp(`\\n*${INICIO}[\\s\\S]*?${FIM}\\n*`, "g");
  txt = txt.replace(re, "\n\n").trimEnd();
  if (conteudo) txt = (txt ? txt + "\n\n" : "") + `${INICIO}\n${conteudo.trim()}\n${FIM}\n`;
  else txt = txt ? txt + "\n" : "";
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, txt, "utf8");
}

// ------------------------------------------------------------ achar o cofre
function cofresDoObsidian() {
  const candidatos = [
    process.env.APPDATA && path.join(process.env.APPDATA, "obsidian", "obsidian.json"),
    path.join(HOME, "Library", "Application Support", "obsidian", "obsidian.json"),
    path.join(HOME, ".config", "obsidian", "obsidian.json"),
    path.join(HOME, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
  ].filter(Boolean);
  const achados = [];
  for (const c of candidatos) {
    const j = lerJSON(c, null);
    for (const v of Object.values(j?.vaults || {})) if (v?.path && fs.existsSync(v.path)) achados.push(v.path);
  }
  return [...new Set(achados)];
}
async function escolherCofre(arg) {
  if (arg) {
    const p = path.resolve(arg.replace(/^~(?=$|[\\/])/, HOME));
    if (!fs.existsSync(p)) throw new Error(`A pasta "${p}" não existe. Confira o caminho do cofre.`);
    return p;
  }
  const cofres = cofresDoObsidian();
  if (cofres.length === 1) { console.log(`Cofre encontrado: ${cofres[0]}`); return cofres[0]; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (cofres.length > 1) {
      console.log("Encontrei estes cofres do Obsidian:");
      cofres.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
      const r = (await rl.question("Qual é o segundo cérebro? (número): ")).trim();
      const c = cofres[Number(r) - 1];
      if (!c) throw new Error("Escolha inválida.");
      return c;
    }
    const r = (await rl.question("Não achei o Obsidian. Cole o caminho completo da pasta do cofre: ")).trim().replace(/^["']|["']$/g, "");
    return escolherCofre(r);
  } finally { rl.close(); }
}

// ------------------------------------------------------------- 1 e 2: cofre
function copiarSemSobrescrever(origem, destino) {
  for (const it of fs.readdirSync(origem, { withFileTypes: true })) {
    const o = path.join(origem, it.name), d = path.join(destino, it.name);
    if (it.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copiarSemSobrescrever(o, d); }
    else if (!fs.existsSync(d)) fs.copyFileSync(o, d);
  }
}
function prepararCofre(cofre) {
  for (const p of PASTAS) fs.mkdirSync(path.join(cofre, p), { recursive: true });
  copiarSemSobrescrever(path.join(AQUI, "semente"), cofre);
  const script = path.join(cofre, "99 Sistema", "scripts", "cerebro.mjs");
  fs.copyFileSync(path.join(AQUI, "cerebro.mjs"), script);
  ok("pastas, notas iniciais, modelos e script no cofre");
  return script;
}

// ---------------------------------------------------------- 3: Obsidian
const COR = (hex) => parseInt(hex.slice(1), 16);
const GRUPOS = [
  ['path:"01 Projetos"', "#4c8dff"],
  ['path:"02 Decisões"', "#a970ff"],
  ['path:"03 Padrões"', "#2fbf71"],
  ['path:"04 Preferências"', "#ff9f43"],
  ['path:"05 Stack"', "#22c1c3"],
  ['path:"06 Aprendizados"', "#e6b800"],
  ['path:"07 Sessões"', "#8a94a6"],
  ['file:"00 Índice"', "#ff5c8a"],
];
function configurarObsidian(cofre) {
  const ob = path.join(cofre, ".obsidian");
  fs.mkdirSync(path.join(ob, "snippets"), { recursive: true });
  fs.copyFileSync(path.join(AQUI, "obsidian", "segundo-cerebro.css"), path.join(ob, "snippets", "segundo-cerebro.css"));

  const ap = lerJSON(path.join(ob, "appearance.json"), {});
  ap.enabledCssSnippets = [...new Set([...(ap.enabledCssSnippets || []), "segundo-cerebro"])];
  gravarJSON(path.join(ob, "appearance.json"), ap);

  const gr = lerJSON(path.join(ob, "graph.json"), {});
  const nossas = new Set(GRUPOS.map(([q]) => q));
  gr.colorGroups = [
    ...GRUPOS.map(([query, hex]) => ({ query, color: { a: 1, rgb: COR(hex) } })),
    ...(gr.colorGroups || []).filter((g) => !nossas.has(g.query)),
  ];
  gr.search = gr.search ?? '-path:"99 Sistema"';
  gr.showTags = gr.showTags ?? false;
  gravarJSON(path.join(ob, "graph.json"), gr);

  const tp = lerJSON(path.join(ob, "templates.json"), {});
  if (!tp.folder) tp.folder = "99 Sistema/Modelos";
  gravarJSON(path.join(ob, "templates.json"), tp);

  // Modelos (templates) é um plugin nativo; liga se a lista existir no formato de lista
  const cp = path.join(ob, "core-plugins.json");
  const core = lerJSON(cp, null);
  if (Array.isArray(core) && !core.includes("templates")) gravarJSON(cp, [...core, "templates"]);
  else if (core && !Array.isArray(core) && core.templates === false) gravarJSON(cp, { ...core, templates: true });

  ok("cores do Obsidian: trecho de CSS ligado, grupos de cor no grafo, pasta de modelos");
}

// -------------------------------------------------------- 4: Claude Code
function comandoNode() {
  // "node" do PATH quando ele é o mesmo deste Node; senão o caminho absoluto
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? "node" : `"${fwd(process.execPath)}"`;
}
function ehNosso(h) { return String(h?.command || "").includes("cerebro.mjs"); }
function limparHooks(settings) {
  for (const ev of Object.keys(settings.hooks || {})) {
    settings.hooks[ev] = (settings.hooks[ev] || [])
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !ehNosso(h)) }))
      .filter((m) => m.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}
function configurarClaude(cofre, script) {
  const arq = path.join(HOME, ".claude", "settings.json");
  backupUmaVez(arq);
  const s = lerJSON(arq, {});
  limparHooks(s);
  const node = comandoNode();
  const cmd = (sub) => ({ type: "command", command: `${node} "${fwd(script)}" ${sub}`, timeout: 20 });
  s.hooks = s.hooks || {};
  s.hooks.SessionStart = [...(s.hooks.SessionStart || []), { hooks: [cmd("sessao")] }];
  s.hooks.UserPromptSubmit = [...(s.hooks.UserPromptSubmit || []), { hooks: [cmd("prompt")] }];
  s.hooks.Stop = [...(s.hooks.Stop || []), { hooks: [cmd("registrar")] }];

  s.permissions = s.permissions || {};
  const allow = new Set((s.permissions.allow || []).filter((r) => !r.includes("cerebro.mjs")));
  allow.add(`Bash(node "${fwd(script)}" salvar:*)`);
  allow.add(`Bash(node "${fwd(script)}" buscar:*)`);
  s.permissions.allow = [...allow];
  const dirs = new Set(s.permissions.additionalDirectories || []);
  dirs.add(fwd(cofre));
  s.permissions.additionalDirectories = [...dirs];
  gravarJSON(arq, s);
  ok(`Claude Code: 3 hooks globais em ${arq}`);

  trocarBloco(path.join(HOME, ".claude", "CLAUDE.md"), `
## 🧠 Segundo cérebro (Obsidian) — automático em TODO projeto
- Cofre: \`${fwd(cofre)}\`. É a memória de longo prazo de todos os projetos deste computador: decisões, padrões, preferências, stack e aprendizados.
- Hooks deste computador já fazem o trabalho: no começo da sessão chegam o projeto, as preferências e os padrões; a cada pedido chegam as notas relacionadas de qualquer projeto; ao final de cada execução chega o pedido de registro. Siga esses avisos sem perguntar ao usuário.
- Antes de propor uma solução, aproveite o que o cérebro já sabe (preferências e padrões valem em qualquer projeto). Se uma nota contradiz o pedido atual, o pedido vence — e registre a mudança.
- Para procurar mais: \`node "${fwd(script)}" buscar <termos>\`.
- Nunca peça ao usuário para buscar ou registrar no cérebro: é automático.`);
  ok("Claude Code: instruções globais em ~/.claude/CLAUDE.md");
}

// --------------------------------------------------------------- 5: Codex
function configurarCodex(cofre, script) {
  const dir = path.join(HOME, ".codex");
  trocarBloco(path.join(dir, "AGENTS.md"), `
## 🧠 Segundo cérebro (Obsidian) — obrigatório em TODA tarefa, sem o usuário pedir
Cofre: \`${fwd(cofre)}\` — memória de longo prazo de todos os projetos deste computador.

1. **Ao começar qualquer tarefa**, antes de planejar, rode:
   - \`node "${fwd(script)}" contexto\` (projeto atual, preferências e padrões);
   - \`node "${fwd(script)}" buscar <3 a 8 palavras-chave do pedido>\` (notas relacionadas de qualquer projeto).
   Siga as preferências e padrões encontrados e reaproveite decisões. Se algo contradiz o pedido atual, o pedido vence.
2. **Ao terminar qualquer execução que alterou arquivos**, antes da resposta final, registre o que foi aprendido e vale para o futuro (decisões com o porquê, padrões, preferências do usuário, stack, aprendizados/bugs). Grave um JSON num arquivo temporário e rode:
   \`node "${fwd(script)}" salvar --codex --arquivo <arquivo.json>\`
   Formato: \`{"projeto":"<nome da pasta do projeto>","itens":[{"tipo":"decisao|padrao|preferencia|stack|aprendizado|projeto","titulo":"curto e reutilizável","resumo":"uma linha","tags":["tema"],"conteudo":"markdown curto"}]}\`
   Mesmo título atualiza a nota existente. Sem nada novo, use "itens": [].
3. Nunca peça ao usuário para buscar ou registrar no cérebro, e não comente o registro na resposta.`);
  ok("Codex: instruções globais em ~/.codex/AGENTS.md");

  const toml = path.join(dir, "config.toml");
  let txt = fs.existsSync(toml) ? fs.readFileSync(toml, "utf8") : "";
  const linha = `notify = ["node", "${fwd(script)}", "codex-notify"]`;
  if (/^\s*notify\s*=.*cerebro\.mjs.*$/m.test(txt)) {
    txt = txt.replace(/^\s*notify\s*=.*cerebro\.mjs.*$/m, linha);
    fs.writeFileSync(toml, txt, "utf8");
    ok("Codex: notify atualizado em ~/.codex/config.toml");
  } else if (/^\s*notify\s*=/m.test(txt)) {
    aviso("Codex: o config.toml já tem um 'notify' seu; não mexi. O diário automático do Codex fica desligado (o registro pelo AGENTS.md continua).");
  } else {
    backupUmaVez(toml);
    // notify precisa ficar no topo (fora de qualquer [tabela])
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(toml, `# segundo cérebro: diário automático de cada execução\n${linha}\n\n${txt}`, "utf8");
    ok("Codex: notify (diário automático) em ~/.codex/config.toml");
  }
}

// ---------------------------------------------------------------- remover
function remover() {
  const arq = path.join(HOME, ".claude", "settings.json");
  if (fs.existsSync(arq)) {
    const s = lerJSON(arq, {});
    limparHooks(s);
    if (s.permissions?.allow) s.permissions.allow = s.permissions.allow.filter((r) => !r.includes("cerebro.mjs"));
    gravarJSON(arq, s);
  }
  for (const f of [path.join(HOME, ".claude", "CLAUDE.md"), path.join(HOME, ".codex", "AGENTS.md")]) if (fs.existsSync(f)) trocarBloco(f, "");
  const toml = path.join(HOME, ".codex", "config.toml");
  if (fs.existsSync(toml)) {
    fs.writeFileSync(toml, fs.readFileSync(toml, "utf8")
      .replace(/^# segundo cérebro: diário automático de cada execução\n/m, "")
      .replace(/^\s*notify\s*=.*cerebro\.mjs.*\n?/m, ""), "utf8");
  }
  console.log("Segundo cérebro desligado do Claude Code e do Codex. O cofre e as notas continuam onde estão.");
}

// ------------------------------------------------------------------- main
async function main() {
  const arg = process.argv[2];
  if (arg === "--remover") return remover();
  console.log("\n🧠 Instalando o segundo cérebro\n");
  const cofre = await escolherCofre(arg);
  console.log(`Cofre: ${cofre}\n`);
  const script = prepararCofre(cofre);
  configurarObsidian(cofre);
  configurarClaude(cofre, script);
  configurarCodex(cofre, script);
  const r = spawnSync(process.execPath, [script, "reindexar"], { encoding: "utf8" });
  if (r.status === 0) ok("índice gerado (00 Índice.md)"); else aviso(`não consegui gerar o índice: ${r.stderr}`);
  console.log(`
Pronto. Agora:
  • Obsidian: se estava aberto, feche e abra de novo (ou Ctrl/Cmd+P → "Reload app without saving").
  • Claude Code e Codex: abra uma sessão NOVA em qualquer projeto. A partir dela, buscar e registrar é automático.
`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
