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
- Catraca: quem está disponível e de quem é a vez de receber lead (rodízio). Também cria "catracas por produto". "Comparar catracas" (e "Relatório" em cada uma, inclusive as desativadas) mostra leads, vendas, conversão e a conversão com e sem o Autoatendimento.
- Imóveis: catálogo de imóveis (venda e aluguel), envio para o cliente pela conversa, botão "Portais". As fotos são tratadas sozinhas ao subir: giradas, sem a localização do celular e em versões leves para o site. No formulário do imóvel, foto com problema (pequena, escura, desfocada, em pé) ganha um "!" e o aviso embaixo; quando outra foto é bem melhor que a capa, aparece "Usar como capa". Isso só avisa — quem decide a foto é quem captou.
- Cetrolab (só gestor): o site da imobiliária, organizado em gavetas (Modelo do site, Conteúdo do site, Endereço/WhatsApp/Pixel, Domínio próprio, Aparência no Google) — ligar e desligar, endereço, WhatsApp do site, frase, Pixel, domínio próprio, Google (Tag Manager e SEO) e o MODELO do site. O modelo Clássico vem em todo plano; os modelos premium (Bairros, Institucional, Editorial e Lançamento, todos no mesmo plano) pedem a ferramenta Cetrolab. Na tela, o Clássico (grátis) vem primeiro e os premium depois; o botão "Assinar o Cetrolab" abre a contratação ali mesmo (também dá em Minha conta → Ferramentas). Se o botão não aparece e a tela diz "Ainda não está à venda", o ConHub ainda não cadastrou o preço. "Ver prévia" mostra outro modelo sem trocar o site no ar. O Institucional mostra também o "Conteúdo do site" (Cetrolab → Conteúdo do site): Sobre nós, redes sociais, a equipe que o gestor marcar (nome, foto de Minha conta e função) e depoimentos. O que ficar em branco não aparece. "Lançamentos" são os imóveis cadastrados como empreendimento. Para aparecer no Google: Cetrolab → Aparência no Google → quadro "Google Search Console" (passo a passo: cadastrar a propriedade "Prefixo do URL" com o endereço mostrado, colar a "Tag HTML" do Google, Salvar, Verificar no Google e enviar o sitemap). O "Nome da marca no site" troca o nome mostrado no site quando a conta está no nome de uma pessoa.
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
- Áudio e imagem colada mostram prévia antes de enviar. Mensagem enviada pode ser editada por até 15 minutos e apagada para todos (lixeira ao lado do balão) por até 2 dias e meio, como no WhatsApp — só a que saiu da imobiliária; a do cliente fica no registro. A ficha do lead mostra em "De onde veio" a campanha, o conjunto, o anúncio e o formulário do anúncio.
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
- Marketing → Formulários: em qual funil e catraca o lead de cada formulário nasce, e a ficha de produto que a IA usa com ele.

## Marketing e automações
- Marketing → Fluxos: o construtor. Gatilhos: disparo em massa, formulário preenchido, lead novo, entrou na etapa, etiqueta adicionada e campo preenchido (com um valor ou qualquer valor). Blocos: mensagem (texto livre ou modelo aprovado da Meta), espera, esperar resposta, botões, condição (etiqueta, etapa, temperatura, responsável, valor de um campo, se o cliente respondeu), etiqueta, mover de etapa, atribuir responsável (catraca, pessoa ou fila) e tarefa. No bloco de início há "Parar o fluxo quando o cliente responder". "Automação ativa" liga o fluxo. Um fluxo pode ter vários gatilhos (botão "Novo gatilho", até 10): cada um tem a própria seta e o próprio caminho. Dois gatilhos não podem pegar a mesma ação (o mesmo formulário, etapa, etiqueta ou campo; lead novo da mesma origem; ou lead novo de formulário junto com "formulário preenchido") — a tela avisa "se sobrepõem" e não deixa ligar. Um lead anda por um caminho do fluxo de cada vez; "uma vez só" vale para cada gatilho.
- Modelo aprovado da Meta só existe na API oficial; numa linha da Uazapi o texto do modelo sai como mensagem comum.
- Configurações → Funis e etapas → etapa → "Quando um lead chegar nesta etapa": responsável (roleta, uma catraca específica, fila ou pessoa), funil, e etiquetas para colocar ou tirar — inclusive a etiqueta com o nome do corretor que recebeu.

## Autoatendimento (IA que atende o cliente)
- Configurações → Autoatendimento: ligar, horário, "Onde a IA atua e o que ela faz no lead" (funis/etapas, campos que ela preenche, resumo como observação, etapa para onde move quando o cliente quer seguir), "Fichas de produto" (uma por empreendimento) e as orientações da equipe (dá para editar, desligar e apagar). As orientações são as regras da IA: o que perguntar, o que falar e o que nunca fazer — não há regra fixa do ConHub; as proibições comuns (preço, aprovação, visita) aparecem como sugestões de um clique.

## Notificações
- Minha conta → Notificações no celular → Ativar. No iPhone só funciona com o ConHub adicionado à Tela de Início (Compartilhar → Adicionar à Tela de Início).

## Assistente Claude (botão no alto da tela)
- Gestor: faz o trabalho da gestão conversando — configura a conta (funis, etapas, prazos, campos, tags, mensagens prontas, a regra "quando um lead chegar nesta etapa" com catraca e etiquetas), o Marketing (fluxos com gatilho, ligar e desligar automação), as catracas por produto, os formulários dos anúncios, o Autoatendimento (horário, onde atua, campos que a IA preenche, resumo, etapa final, orientações e fichas de produto) e mexe nos leads (mover de etapa e de funil, repassar, tags, finalizar, tarefas, observações, cadastrar, registrar venda). Também lê o catálogo de imóveis. Mais de 10 leads de uma vez só depois de o gestor confirmar. Aceita texto longo e arquivos (foto, print, PDF, planilha, e cenas de vídeo — sem som). Não apaga lead, funil, fluxo nem catraca e não manda mensagem ao cliente nem dispara campanha.
- Atendente e corretor: só consulta — tira dúvidas, procura leads e números dele e pesquisa na internet. Não muda nada na conta.
- Todos: o Claude reorganiza a ORDEM do menu de quem pede (ex.: "coloque Imóveis no topo do meu menu"), só para ela. Os nomes das telas não mudam e nada some; "volte o menu ao padrão" desfaz.

## Equipe e acesso
- Convidar: Equipe → copie o link de cadastro e mande para a pessoa; depois aprove.
- Esqueci a senha: na tela de entrada, "Esqueci minha senha" (chega por e-mail). O gestor também gera "Nova senha" em Equipe.
- Conta bloqueada por senha: 4 senhas erradas seguidas bloqueiam a conta. Para desbloquear, "Esqueci minha senha" na tela de entrada e criar uma nova pelo link do e-mail (o link de "Nova senha" que o gestor gera em Equipe também desbloqueia).
- Código de acesso do suporte ConHub: em Minha conta (só a gestão vê), 6 dígitos que mudam a cada 60 segundos. O suporte do ConHub só entra na conta com esse código, e a entrada vale por algumas horas. A lista "Entradas do ConHub na sua conta" mostra quando entrou, e o botão "Encerrar o acesso do ConHub agora" tira o suporte na hora.

## Assinatura (só o gestor vê)
- Minha conta: Cartão de cobrança (cadastrar ou trocar não cobra nada), Gerenciar assinatura (escolher o plano e o prazo), Ferramentas (contratar à parte), Cancelar assinatura (o acesso continua até o fim do período pago).
- Boleto: a cobrança é no cartão. Pagar por boleto só existe quando o suporte do ConHub libera na conta — quem quiser pede pelo "Falar com o suporte". Liberado, aparece "Pagar por boleto" em Minha conta (e na tela de conta travada): escolher o plano, gerar, pagar pela linha digitável. O boleto não renova sozinho; a cada período, gera-se outro. O acesso volta quando o banco confirma (até 3 dias úteis). Com cobrança no cartão ligada, é preciso cancelar a assinatura do cartão antes.
- Teste grátis de 7 dias para contas novas.
- Planos de imobiliária: Essencial e Plus; do autônomo: Básico e Completo. Autoatendimento com IA e Marketing dependem do plano ou da contratação à parte.

## Coisas que só o suporte humano resolve
- Cobrança errada, estorno, mudança de preço combinado, liberação de conta travada por pagamento.
- Erro do sistema (tela "Algo quebrou", botão que não faz nada depois de tentar de novo).
- Recuperar dado apagado, mudar o tipo da conta (imobiliária ⇄ autônomo), domínio próprio do site que não ativa.
- Qualquer coisa que precise olhar dentro da conta do cliente.
`;
