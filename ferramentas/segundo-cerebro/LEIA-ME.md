# 🧠 Segundo cérebro (Obsidian + Claude Code + Codex)

Liga o seu cofre do Obsidian a **todo projeto** do seu computador. Depois de instalado:

- **Ao começar** uma tarefa, o Claude Code recebe sozinho o resumo do projeto, as suas preferências e os padrões já registrados.
- **A cada pedido**, ele recebe as notas relacionadas ao pedido, vindas de **qualquer projeto**.
- **Ao terminar** uma execução que mudou arquivos ou **pesquisou na internet**, o dia ganha uma linha no diário e o Claude é obrigado a registrar o que aprendeu (decisões, padrões, preferências, stack e aprendizados). A pesquisa vira uma nota em `08 Pesquisas`, com a conclusão e os links.

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

## Trazer as conversas antigas

As conversas que já existem viram notas em `09 Conversas`, uma por conversa:

- **claude.ai** (navegador e app de conversa): Configurações → Privacidade → **Exportar dados**. O link chega por e-mail; baixe o `.zip` e rode
  ```
  node importar.mjs "C:/Users/Ali/Downloads/data-....zip"
  ```
- **Claude Code deste computador**:
  ```
  node importar.mjs --claude-code
  ```

Rodar de novo é seguro: conversa já importada é pulada (e refeita se ganhou mensagens). Sessões do Claude Code na nuvem não ficam no seu computador nem na exportação, e não entram.

## O que ele muda

| Onde | O quê |
|---|---|
| Cofre | pastas `01 Projetos` … `09 Conversas`, `00 Índice.md`, notas iniciais, modelos, `99 Sistema/scripts/cerebro.mjs` |
| `.obsidian` do cofre | trecho de CSS com as cores (`segundo-cerebro`), grupos de cor do grafo, pasta de modelos |
| `~/.claude/settings.json` | hooks `SessionStart`, `UserPromptSubmit` e `Stop`, e permissão para o script (cópia antes da primeira mudança: `settings.json.antes-do-segundo-cerebro`) |
| `~/.claude/CLAUDE.md` | um bloco de instruções entre marcadores |
| `~/.codex/AGENTS.md` | instruções: buscar no começo e registrar no fim |
| `~/.codex/config.toml` | `notify`, que grava o diário de cada execução (só se você ainda não tiver um `notify`) |

## Limites que valem saber

- **Codex**: não tem hooks iguais aos do Claude Code. A busca e o registro dele seguem as instruções globais do `AGENTS.md`, que o Codex lê em toda sessão; só o diário do dia é garantido pelo `notify`.
- O registro acontece em execução que **alterou algo** (arquivos, commit, instalação) ou que **pesquisou na internet**. Conversa só de pergunta e resposta, sem pesquisa, não vira nota.
- Só o Claude Code **deste computador** registra. O claude.ai e as sessões na nuvem não enxergam o cofre.
- Conversa aberta sem pasta de projeto (pasta `scratch-…` do app) é registrada no projeto **Geral**.
- O registro custa uma volta a mais do Claude no fim de cada execução, alguns segundos.
- Sessões que já estavam abertas antes da instalação não pegam os hooks. Abra uma nova.
