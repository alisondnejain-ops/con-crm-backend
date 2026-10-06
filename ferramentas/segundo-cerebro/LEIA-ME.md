# 🧠 Segundo cérebro (Obsidian + Claude Code + Codex)

Liga o seu cofre do Obsidian a **todo projeto** do seu computador. Depois de instalado:

- **Ao começar** uma tarefa, o Claude Code recebe sozinho o resumo do projeto, as suas preferências e os padrões já registrados.
- **A cada pedido**, ele recebe as notas relacionadas ao pedido, vindas de **qualquer projeto**.
- **Ao terminar** uma execução que mudou arquivos, o dia ganha uma linha no diário e o Claude é obrigado a registrar o que aprendeu (decisões, padrões, preferências, stack e aprendizados).

Você não pede nada disso: os hooks globais do Claude Code fazem tudo sozinhos.

## Instalar (uma vez, no seu computador)

Precisa do **Node 18+** (o mesmo que o Claude Code e o Codex já usam).

1. Feche o Obsidian.
2. No terminal, dentro desta pasta:
   ```
   node instalar.mjs
   ```
   Ele acha o cofre sozinho pela lista do Obsidian. Se você tiver mais de um cofre, ele pergunta qual usar. Para indicar o caminho do cofre direto:
   ```
   node instalar.mjs "C:/Users/Ali/Documents/MeuCofre"
   ```
3. Abra o Obsidian de novo e abra uma **sessão nova** do Claude Code ou do Codex.

Pode rodar de novo quando quiser, por exemplo para atualizar o script: ele não duplica nada e não apaga notas. Para desligar, rode `node instalar.mjs --remover` (o cofre continua intacto).

## O que ele muda

| Onde | O quê |
|---|---|
| Cofre | pastas `01 Projetos` … `07 Sessões`, `00 Índice.md`, notas iniciais, modelos, `99 Sistema/scripts/cerebro.mjs` |
| `.obsidian` do cofre | trecho de CSS com as cores (`segundo-cerebro`), grupos de cor do grafo, pasta de modelos |
| `~/.claude/settings.json` | hooks `SessionStart`, `UserPromptSubmit` e `Stop`, e permissão para o script (cópia antes da primeira mudança: `settings.json.antes-do-segundo-cerebro`) |
| `~/.claude/CLAUDE.md` | um bloco de instruções entre marcadores |
| `~/.codex/AGENTS.md` | instruções: buscar no começo e registrar no fim |
| `~/.codex/config.toml` | `notify`, que grava o diário de cada execução (só se você ainda não tiver um `notify`) |

## Limites que valem saber

- **Codex**: não tem hooks iguais aos do Claude Code. A busca e o registro dele seguem as instruções globais do `AGENTS.md`, que o Codex lê em toda sessão; só o diário do dia é garantido pelo `notify`.
- O registro acontece em execução que **alterou algo** (arquivos, commit, instalação). Conversa só de pergunta e resposta não vira nota.
- O registro custa uma volta a mais do Claude no fim de cada execução, alguns segundos.
- Sessões que já estavam abertas antes da instalação não pegam os hooks. Abra uma nova.
