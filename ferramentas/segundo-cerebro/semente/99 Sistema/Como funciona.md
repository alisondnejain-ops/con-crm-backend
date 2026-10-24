---
tipo: sistema
tags:
  - sistema
---
# 🧠 Como funciona o segundo cérebro

Tudo aqui é **automático**. Você não precisa pedir para buscar nem para registrar.

## No começo de cada sessão (Claude Code)
Um hook lê este cofre e entrega ao Claude: a nota do projeto em que você está, as suas **preferências** e os **padrões** já registrados.

## A cada pedido
Outro hook procura no cofre inteiro — em **todos os projetos** — as notas que têm a ver com o que você pediu e as entrega ao Claude antes de ele começar.

## Ao final de cada execução
Quando o Claude alterou arquivos (ou fez commit, instalou pacote etc.) **ou pesquisou na internet**:
1. uma linha entra no diário do dia em **07 Sessões** (pedido, projeto, arquivos, o que foi buscado);
2. o Claude é obrigado a registrar o que aprendeu: decisões, padrões, preferências, stack, aprendizados. Mesmo título = atualiza a nota existente.
3. se houve pesquisa, ela vira uma nota em **08 Pesquisas**: a pergunta, o que foi encontrado, a conclusão e os links. Pesquisar o mesmo tema de novo atualiza a mesma nota.

Conversa só de pergunta e resposta, sem pesquisa na internet, não gera registro.

Conversa aberta sem pasta de projeto (o app cria uma pasta "scratch-…") é registrada no projeto **Geral**.

**Só vale para o Claude Code deste computador.** Conversas no claude.ai (navegador ou app de conversa) e sessões na nuvem não enxergam este cofre.

## Codex
O Codex não tem os mesmos hooks. Ele segue as instruções globais (`~/.codex/AGENTS.md`): busca no cérebro ao começar e registra ao terminar. O diário do dia é automático pelo `notify` do Codex.

## Cores
| Pasta | Cor | O que guarda |
|---|---|---|
| 🔵 01 Projetos | azul | um resumo vivo de cada projeto, com links para tudo dele |
| 🟣 02 Decisões | roxo | o que foi decidido e **por quê** |
| 🟢 03 Padrões | verde | jeitos de fazer que valem repetir |
| 🟠 04 Preferências | laranja | como você gosta que as coisas sejam feitas |
| 💠 05 Stack | ciano | tecnologias, serviços, configurações |
| 🟡 06 Aprendizados | amarelo | bugs, armadilhas e a solução |
| ⚪ 07 Sessões | cinza | diário bruto de cada execução |
| 🔍 08 Pesquisas | magenta | cada pesquisa: conclusão, detalhes e links |

Abra o **Grafo** (Ctrl/Cmd+G): cada tipo aparece com a sua cor.

## Pode editar à mão?
Pode — as notas são suas. Só o [[00 Índice]] é refeito sozinho. Se uma preferência mudou, edite a nota: ela passa a valer na próxima sessão.

## Comandos (se um dia precisar)
- `node "<cofre>/99 Sistema/scripts/cerebro.mjs" buscar <termos>`
- `node "<cofre>/99 Sistema/scripts/cerebro.mjs" reindexar`
