/* O QUE A IA SABE SOBRE O CONHUB (05/10/2026).

   É o "manual" que a nuvem de suporte e o assistente de configuração recebem
   em toda conversa. Escrito para a pessoa que USA o sistema — gestor,
   atendente, corretor —, sem nome de cliente nenhum: o mesmo texto vale para
   toda imobiliária.

   MANTER ATUALIZADO É PARTE DE MUDAR UMA TELA. Se um botão muda de lugar e
   este texto não, a IA ensina o caminho antigo com toda a confiança — e a
   pessoa conclui que o sistema está quebrado. Fica num arquivo só, longe das
   regras do assistente, para ser fácil de achar.

   O texto é fixo (não muda por conta nem por hora), e por isso entra inteiro
   no cache da API: depois da primeira pergunta, ele custa uma fração do preço. */

export const MANUAL_CONHUB = `# ConHub — como o sistema funciona

O ConHub é um CRM de atendimento para imobiliárias e corretores autônomos: recebe os leads (WhatsApp, anúncios do Facebook/Instagram, portais, site), distribui para a equipe, organiza em funis e mede a produtividade de cada pessoa.

## Papéis
- Gestor (dono da conta): vê tudo, configura tudo, vê relatórios da equipe.
- Atendente (SDR): faz o primeiro atendimento e repassa o lead para o corretor da vez. Enxerga a imobiliária inteira.
- Corretor: atende os próprios leads, move no funil, vê a própria produção e marca disponibilidade.
- Corretor autônomo: a conta de uma pessoa só. Ele é corretor e manda na conta (tem as telas do gestor). Não tem Catraca nem Plantão.

## Menu (barra lateral no computador; no celular, 4 itens + "Mais")
- Painel: indicadores do período (VGV, vendas, leads, visitas), metas do mês e funil de atividade. O corretor vê só os próprios números.
- Funil: o quadro (kanban) com as etapas. Arraste o card para mudar de etapa. O seletor no alto troca de funil e tem "Novo funil". Busca e "Filtros" (corretor, temperatura, período).
- Atender: a caixa de conversas. No alto: busca e "+" (cadastrar lead na mão); pastilhas Tudo / Aguardando / Formulário / Novos contatos / Finalizados; "Minha caixa / Toda a equipe" (supervisão) e "Filtros". Clicar numa conversa abre o chat; a ficha do lead fica ao lado (ou no botão "Ficha" em telas menores).
- Catraca: quem está disponível e de quem é a vez de receber lead (rodízio). Também cria "catracas por produto".
- Imóveis: catálogo de imóveis (venda e aluguel), envio para o cliente pela conversa, botões "Portais" e "Site".
- Plantão: escala de plantão do mês e conferência de presença (a atendente marca Veio/Faltou).
- Operação: Visão geral (atendimento, funil de conversão, equipe, campanhas) e Relatórios (produção por pessoa e Score).
- Marketing: Disparos em massa, Fluxos (automações) e Formulários dos anúncios. Disparos e Fluxos dependem da ferramenta Marketing.
- Base de leads: importar planilha, exportar, e "Arrumar a base" (operações em massa).
- Equipe: convidar pessoas (link de cadastro), aprovar, remover, gerar "Nova senha".
- Configurações: abas Mensagens automáticas, Funis e etapas, Conexão (WhatsApp), Autoatendimento (IA), Anúncios do Meta, Identidade (logo e cor), entre outras.
- Minha conta: dados pessoais, senha, notificações no celular, "Meu WhatsApp" (linha pessoal do corretor), versão do sistema, assinatura e cartão (gestor).

## Leads e conversa
- Lead novo do WhatsApp da imobiliária vai para a atendente que está ativa (catraca das atendentes). Sem atendente ativa, fica na fila sem dono; com o Autoatendimento ligado, a IA atende.
- Repassar: na ficha do lead, o botão "Passar para <nome>" entrega ao corretor da vez; também dá para escolher um corretor a dedo. Repasse nunca volta para a atendente.
- Finalizar atendimento: tira a conversa da caixa sem mudar a etapa. Se o cliente responder, ela volta sozinha.
- Mensagens prontas: botões acima do campo de texto. A gestão e a atendente editam em Configurações → Mensagens automáticas (dá para separar por etapa).
- Áudio e imagem colada mostram prévia antes de enviar. Mensagem enviada pode ser editada por até 15 minutos.
- Ligar: o botão abre o discador e, ao voltar, pergunta o resultado da ligação.
- Observações, tarefas, tags e campos personalizados ficam na ficha do lead.
- Cadastrar lead na mão: botão "+" ao lado da busca em Atender. Número repetido não cria outro lead (a tela oferece abrir o existente).
- Corrigir nome ou telefone do lead: lápis no topo da ficha.

## Funis e etapas
- Configurações → Funis e etapas: criar funil (do zero ou de um modelo pronto: SDR, Comercial, Recaptação, Locação), criar/renomear/reordenar etapas, prazo (SLA) de cada etapa, campos obrigatórios para entrar na etapa, "Início do processo comercial" e "Quando um lead chegar nesta etapa" (entregar ao próximo corretor da roleta, a uma pessoa fixa, devolver à fila, ou mover para outro funil).
- "Em que funil os leads de cada pessoa entram": o funil de entrada de cada pessoa.
- Etapa com lead dentro não se apaga: desative.
- Mover para a etapa de venda exige registrar a venda (valor e data) — o cartão de venda fica na ficha.
- A palavra-chave na conversa (ex.: "documentação") SUGERE uma etapa; quem confirma é a pessoa, no cartão âmbar da ficha.

## WhatsApp
- Configurações → Conexão: conectar o número da imobiliária pela Uazapi (QR Code na tela) ou pela API oficial da Meta. O quadro "Recebimento das mensagens" mostra se cada número está recebendo e liga o recebimento sozinho.
- WhatsApp desconectado: em Conexão, "Conectar" mostra o QR Code; leia pelo celular (WhatsApp → Aparelhos conectados). Se travar, use "Forçar reconexão com novo QR Code".
- Linha pessoal do corretor: Minha conta → Meu WhatsApp (a gestão precisa liberar a pessoa).
- Mensagens que não chegam: confira em Configurações → Conexão o selo do número e o quadro de recebimento.

## Anúncios (Facebook/Instagram)
- Configurações → Anúncios do Meta → "Continuar com o Facebook" e escolha a página. Os leads dos formulários passam a entrar sozinhos.
- Marketing → Formulários: em qual funil e catraca o lead de cada formulário nasce.

## Notificações
- Minha conta → Notificações no celular → Ativar. No iPhone só funciona com o ConHub adicionado à Tela de Início (Compartilhar → Adicionar à Tela de Início).

## Equipe e acesso
- Convidar: Equipe → copie o link de cadastro e mande para a pessoa; depois aprove.
- Esqueci a senha: na tela de entrada, "Esqueci minha senha" (chega por e-mail). O gestor também gera "Nova senha" em Equipe.

## Assinatura (só o gestor vê)
- Minha conta: Cartão de cobrança (cadastrar ou trocar não cobra nada), Gerenciar assinatura (escolher o plano e o prazo), Ferramentas (contratar à parte), Cancelar assinatura (o acesso continua até o fim do período pago).
- Teste grátis de 7 dias para contas novas.
- Planos de imobiliária: Essencial e Plus; do autônomo: Básico e Completo. Autoatendimento com IA e Marketing dependem do plano ou da contratação à parte.

## Coisas que só o suporte humano resolve
- Cobrança errada, estorno, mudança de preço combinado, liberação de conta travada por pagamento.
- Erro do sistema (tela "Algo quebrou", botão que não faz nada depois de tentar de novo).
- Recuperar dado apagado, mudar o tipo da conta (imobiliária ⇄ autônomo), domínio próprio do site que não ativa.
- Qualquer coisa que precise olhar dentro da conta do cliente.
`;
