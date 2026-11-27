# Protótipo CETRO: referência de layout e usabilidade

Cópia do protótipo interativo que o Fernando montou (27/11/2026), guardada como
**referência** para o layout e a usabilidade do CETRO. Não é código do sistema:
nada daqui é servido nem importado.

- `index.html`, `style.css`, `revision.css`, `app.js`, `revision.js`: o protótipo
  como estava publicado. Abre num navegador (servidor estático simples).
- `navegacao-gestao.txt` / `navegacao-corretor.txt`: o texto de cada tela,
  subtela e popup, clique a clique, nos dois modos.
- `telas/`: folhas com os prints de cada tela e dos popups abertos.

## Como usar esta referência (decisões do Ali, 27/11/2026)

1. **Layout e usabilidade do protótipo em cada ponto do CETRO**, sem desfazer
   os ajustes já feitos (ficha do Kanban em duas colunas, ficha lateral do
   Atender engavetada, sem cabeçalho grande, regras dos números).
2. **Nada de botão quadrado demais.** O protótipo usa cantos de 6 a 9px; no CETRO
   os botões ficam em 10 a 11px e os cartões em 14 a 16px.
3. **Cores e ferramentas organizadas, sem perder praticidade.** O que se usa
   todo dia fica à vista; o raro fica a um clique.
4. **Explicação só para função complexa.** Botão que diz o que faz não ganha
   parágrafo embaixo.
5. Estrutura leve, fluida e moderna.

## O que o protótipo tem e o CETRO ainda não tinha (lista de 27/11/2026)

1. Diretorias, gerências e corretores como filtros na barra de todas as telas.
2. Indicador personalizado no Painel; metas por diretoria/gerência.
3. "Assumir negociação" num clique.
4. Enviar imóvel escolhendo o formato (com fluxo de pagamento).
5. Agendar e disparar com áudio gravado na hora.
6. Tarefa com imóvel vinculado.
7. Visitas e videochamadas, e anexos, na ficha.
8. CPF, idioma, profissão e país na ficha.
9. Vários imóveis por lead e propostas.
10. Configuração completa da etapa na engrenagem do Funil, com cor.
11. Catraca: código do imóvel no site, portal específico, anúncio do portal,
    equipes vinculadas, funil/etapa para repetidos, gestor a notificar,
    relatório por equipe.
12. Imóvel: venda e locação juntos, "Locado", plantas, legendas, documentos,
    prévia antes de salvar, publicar no site sim/não, título e descrição para
    portais.
13. Plantão: vários por dia, noite/integral, local, equipes e catracas.
14. Leads recebidos por dia no relatório individual.
15. Equipe: funções acumuláveis, escopo de acesso e permissões por ferramenta.
16. Autoatendimento "quando não houver atendente" e conferência do que o robô
    atendeu.
17. Histórico de disponibilidade dos últimos 7 dias do corretor.

## Pontos do protótipo que NÃO devem ser copiados

- "Leads recebidos 360" e funil começando em 161 sem a frase que explica a
  diferença (o CETRO explica).
- "Ligações 200%" no funil de atividades.
- "Responderam · da população contatada" (palavra de pesquisa).
- Telefone mascarado ("Contato · •••• 4821") sem regra de permissão.
- "Importar escala" do Plantão abrindo o formulário de importar contatos.
