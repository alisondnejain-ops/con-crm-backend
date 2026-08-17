# Con CRM — Conecta Imóveis

CRM interno de atendimento a leads da imobiliária **Conecta Imóveis** (região Petrolina/Juazeiro, Brasil).
Foco exclusivo: **atendimento** e **relatório de produtividade individual** por corretor. Sem cadastro de imóveis, contratos ou financeiro — não adicione esses módulos sem pedido explícito.

Este arquivo é o contexto do projeto. Leia-o antes de agir. Fale português com o usuário (Ali).

## Estado atual (o que já existe)

- **Frontend** (`frontend/index.html`): protótipo React completo e funcional, **rodando 100% no navegador com dados de exemplo em memória** (nada persiste — reseta ao recarregar). É um arquivo único, autossuficiente (React embutido), pronto pra hospedar como site estático. Já foi publicado no Netlify pelo usuário.
  - Código-fonte legível em `frontend/src/app.jsx`. O `index.html` é a versão **compilada** desse JSX (ver "Build do frontend").
  - **Responsivo** (feito): dois cortes de largura em `useIsMobile` / `useIsCompact` — até 760px é uma tela por vez com navegação inferior; até 1024px a ficha do lead vira botão em vez de painel fixo.
- **Backend** (`backend/`): Node/Express + SQLite (better-sqlite3). Ainda **não hospedado**. Cadastro de corretor com confirmação por e-mail está pronto e testado ponta a ponta; Meta e Uazapi ainda não ligados.
  - **Cadastro** (feito): `POST /auth/register` cria a conta como `pendente` + token de convite (7 dias) → e-mail via Resend (`services/mail.js`) → `/definir-senha?token=...` → `POST /auth/set-password` ativa. Sem `RESEND_API_KEY`, o link é devolvido na resposta e impresso no log — o fluxo funciona mesmo sem provedor de e-mail contratado.
  - **Páginas públicas**: `backend/public/cadastro.html` e `definir-senha.html`, servidas pelo próprio backend (HTML puro, sem build). O link que a ADM manda é `https://URL/cadastro?c=ADM_CODE`.
  - **`src/bootstrap.js`** roda a cada start: cria a org a partir de `ADM_CODE` e, se `ADM_EMAIL`/`ADM_PASSWORD` estiverem no .env, cria a conta ADM. Por isso **não é preciso rodar `seed` em produção** — `seed` é só para os usuários fictícios de teste.

## Papéis (3)

- **ADM** (Ali): painel da equipe, relatórios por atendente, e conecta o número único da Conecta via Uazapi.
- **SDR** (ex.: Camila): faz a **catraca** (distribuição) E **também atende** como um corretor. Importante: quando a SDR faz o primeiro atendimento, ela precisa poder **repassar o lead para o corretor da vez** (rodízio) — o lead NÃO fica preso na conta dela.
- **Corretor**: atende seus leads, avança no funil, vê a própria produtividade e marca disponibilidade.

## Regras de negócio importantes (não quebrar)

- **Número único da Conecta**: um só WhatsApp para todos (via Uazapi). NÃO é conexão individual por corretor. Cada mensagem que sai é **assinada com o nome do corretor** (prefixo `*Nome:*`) para o lead saber com quem fala.
- **Lead novo cai direto na atendente**: todo lead que entra (Meta ou WhatsApp) já nasce com dono — a atendente da vez, por rodízio próprio (`orgs.atendente_ptr`, ver `services/catraca.js`). Aqui **não** se olha disponibilidade: ninguém atende antes dela, então o lead não pode ficar parado por falta de prontidão marcada. Só o gestor vê e controla essa catraca (`GET /distribution/atendentes`).
- **Catraca manual (corretores)**: só recebe lead quem se prontificou no dia (campo `available`). A SDR transfere manualmente (um a um) ou por rodízio ("próximo disponível"). Quem está indisponível não entra na fila. Esta regra vale para os **corretores** — não confundir com a catraca das atendentes acima.
- **Caixa da atendente x supervisão**: a atendente enxerga a imobiliária inteira (é supervisora), mas a tela "Atender" abre no escopo `meus` — o que está com ela mais a fila. Sem isso, o lead que ela acabou de repassar continuava na tela dela. "Toda a equipe" fica a um clique.
- **Finalizar atendimento** (`POST /leads/:id/finalizar`): tira a conversa da caixa de entrada **sem mexer na etapa do funil** — encerra o atendimento, não o negócio. Se o cliente responder, reabre sozinho (webhook da Uazapi). `?finalizados=1` lista os encerrados.
- **Repasse da SDR**: `POST /distribution/handoff` — passa o lead para o próximo CORRETOR disponível (rodízio), ou para um corretor específico. Nunca de volta pra SDR.
- **Funil com 11 etapas** (nesta ordem): `Lead, Atendimento, Pasta, Aprovação, Agendamento, Visita, Proposta, Venda, Perdido, Recaptação, Transferido por ligação`.
- **Avanço de etapa por palavra-chave** (mudou em 04/08/2026 — ver `backend/src/services/stages.js` → `GATILHOS`): o lead **só** muda de etapa quando a palavra daquela etapa é dita na conversa, pelo corretor ou pelo cliente. Uma palavra por etapa:

  | palavra na conversa | leva para |
  |---|---|
  | atendimento (ou "dar continuidade") | Atendimento |
  | documentação / documentos | Pasta |
  | aprovação | Aprovação |
  | visita / agendar | Agendamento |
  | "o que achou do imóvel" (a pergunta do pós-visita) | Visita |
  | fechar / proposta | Proposta |
  | contrato | Venda |

  Regras: forward-only (nunca volta), não mexe nas etapas manuais (Perdido/Recaptação/Transferido), e vale a palavra **mais adiantada** que aparecer na conversa.

  **Reanálise da base** (`GET/POST /leads/reanalise`, só ADM; tela em "Base de leads"): recalcula a etapa dos leads antigos do zero pela regra nova, lendo a conversa inteira. Aqui o lead **pode descer** — é o objetivo, tirar da frente do funil quem a regra frouxa empurrou. Ficam de fora quem não tem conversa (a base importada inteira cairia para "Lead"), quem tem venda registrada (`sale_value`) e quem está em etapa manual. GET confere, POST aplica. Antes o funil andava sozinho (abrir a conversa já virava "Atendimento", "sábado" virava "Agendamento") — isso acabou. **"Contrato" agora fecha como Venda automaticamente**, a pedido do Ali; era proibido antes. A lógica vive só no backend; o frontend apenas mostra a palavra da próxima etapa na ficha (`PALAVRA_ETAPA` em `app.jsx`, espelho de `GATILHOS`).
- **A conversa SEMPRE abre no fim** (17/08/2026, `chatRef` virou um ref de função em `app.jsx`): a rolagem para o rodapé só acontecia quando o `selId` mudava. Só que abrir a ficha e voltar, ou sair para outra tela e voltar ao atendimento, **remonta o painel da conversa** — e div recém-montada nasce com a rolagem no topo, com o mesmo lead selecionado, então o efeito não fazia nada. O corretor caía na primeira mensagem, de meses atrás. Agora o `ref` é uma função: o React a chama no instante em que o elemento entra na tela, que é exatamente o momento certo, e ela vale para todo caminho de volta (não só os dois conhecidos). O `.current` continua existindo (`Object.defineProperty`) para o resto do código que já usava. A regra de NÃO puxar quem subiu para ler continua de pé — o ref só dispara na montagem.
- **Sem temperatura é um estado válido** (14/08/2026): todo lead do WhatsApp nascia `MORNO` — não era leitura de ninguém, era o padrão da coluna, e o funil inteiro ficou morno. Lead novo agora entra com `priority = NULL`, e a tela mostra "sem temperatura". No frontend, `prioDe(p)` substituiu todo acesso direto a `PRIO[...]`: com `prio` nulo o app quebrava a tela inteira.
- **Arrumar a base** (14/08/2026, `services/lote.js`, tela em "Base de leads" → Arrumar a base; só ADM): duas operações em massa, as duas com **prévia antes de aplicar**. (1) **Tirar o "Morno"** — apaga só essa marcação, Quente e Frio não são tocados. (2) **Reposicionar o funil com a IA** — lê a conversa de cada lead e grava a etapa com `motivo='ia_lote'`. Ficam **de fora**: lead com a atendente ou sem dono (não é atendimento de corretor — pedido do Ali por causa da Vanessa), sem conversa, com venda registrada e em etapa manual. Roda **em blocos** com barra de avanço e botão de parar: são centenas de conversas e uma requisição só estouraria o navegador. Lead já lido nas últimas 12h não é relido — parar no meio e continuar não paga duas vezes. O **custo estimado aparece antes do botão**. `ia_lote` conta como confirmação humana no score (o gestor autorizou a leitura sabendo o que ela faria). Teste: `npm run teste:lote`.
- **Os números do ranking passaram a ser DA PESSOA** (14/08/2026, `services/score.js` → `primeirasRespostas`, `temposDeResposta(ids, userId)`): `leads.first_resp_at` guarda a primeira resposta de QUALQUER pessoa, e na Conecta quem fala primeiro é a atendente, que depois repassa. O corretor aparecia com o tempo dela — ganhando nota por trabalho que não fez, ou levando a culpa — e a agilidade dele não existia no relatório. Agora os dois tempos contam **de `assigned_at`** (quando o lead ficou com ele) e só olham **as mensagens que ele escreveu**. `atendidos` também. Teste: `npm run teste:tempo`.
- **Primeiro atendimento fora do expediente** (16/08/2026, `services/robo.js` + `services/ia.js` → `atenderPrimeiroContato`; tela em Configurações → Fora do expediente, ligar só ADM): **é o ÚNICO lugar do CRM em que a IA fala com o CLIENTE** — todo o resto (resumo, etapa, temperatura) é leitura para gente de dentro. Nasce DESLIGADO: robô conversando no WhatsApp da imobiliária não pode começar porque uma versão nova subiu. A missão é estreita — **acolher e colher**.

  **Comprar ou alugar é a PRIMEIRA pergunta** (16/08/2026, `camposDa()`): são cinco campos nos dois casos, mas não os mesmos. Compra: renda, entrada, situação, CPF, prazo (os do formulário do Meta). Aluguel: renda, **orçamento**, situação, **garantia**, prazo — sem entrada, sem CPF, sem falar em simulação. Antes só existia o conjunto da compra, e ele perguntava "quanto tem de entrada?" para quem tinha acabado de dizer que queria alugar. A contagem "3 de 5" na conferência usa a lista do caso; na ficha, que só tem os campos da compra, orçamento e garantia entram na **situação** — jogá-los em `entrada`/`cpf` seria escrever mentira num campo com nome.

  **"Responda antes de perguntar"** é a primeira regra do prompt: reagir ao que a pessoa disse, responder o que ela perguntou, e só então fazer UMA pergunta. Emendar pergunta por cima do que o cliente falou é o que faz parecer robô — muito mais do que qualquer palavra.

  **Quando ele fala** — as três regras são do Ali: (1) **fora do expediente**, e são duas perguntas em ordem: *hoje tem expediente?* (`orgs.robo_dias`, padrão seg–sex) — no sábado e no domingo não tem, e aí ele atende **o dia inteiro**, sem olhar a hora; *se tem, estamos fora dele?* — a janela **18:00→09:00** atravessa a meia-noite (`a<b ? entre : a||b` — errar isso deixa o robô mudo a noite toda sem erro nenhum aparecer). Assim sexta 18h → segunda 9h vira um bloco contínuo sem nenhum caso especial. Às 09:00 a atendente assume, **e isso preserva o tempo de resposta DELA**, que é o número do relatório. Na tela marcam-se os **dias em que a EQUIPE trabalha**, não os do robô — invertido de propósito, senão a pergunta vira "marco sábado para ele atender no sábado?"; (2) só lead **sem corretor** — fila, com a atendente ou com o gestor são a mesma situação: ninguém tem esse atendimento no nome ainda. Lead repassado a corretor é o único caso em que ele se cala por causa do dono; (3) só quem está **sem retorno** (última mensagem é do cliente, mesma definição do `alerta.js`). Mais uma minha: **gente entrou, robô saiu para sempre** (`robo_parado`).

  **O que ele nunca faz**: valor de parcela/entrada/juros, dizer que aprovou, marcar visita, prometer ligação, e **dizer que a imobiliária tem imóvel num bairro/faixa de preço** (16/08/2026, primeiro teste real do Ali: ele respondeu "a gente tem opções bacanas por lá" para um bairro específico — nem sempre tem, e a pessoa cobra isso na segunda). Quando o cliente cita um bairro, ele anota em `situacao` e responde no espírito de "a gente encontra o imóvel ideal pra você". E o texto passa por `palavraProibida()` antes de sair — a resposta pode estar ótima e conter "podemos agendar sua visita", que move o lead duas etapas às 3h da manhã. Barrado não envia: a conversa fica parada para a atendente, que é onde ela estaria sem o robô. **`advanceStage` não roda enquanto o robô está atendendo.**

  **A última mensagem é sempre uma despedida** (16/08/2026): antes ele emudecia no teto, e o cliente ficava falando sozinho depois de "e qual a sua renda?". Agora a IA recebe quantas mensagens ainda cabem — faltando 2 ela começa a fechar, na última o aviso é explícito e o `encerrar` é forçado no código, tenha ela obedecido ou não. E o motivo mostrado na ficha separa as quatro causas de ele estar fora da conversa (gente respondeu / ele se despediu / bateu o teto / foi conferido): `podeAtender` devolve um `robo_encerrado` neutro e quem atribui a causa é `estadoNoLead`. **Gente x robô se distingue pela ASSINATURA (`ASSINATURA_ROBO`), não por ter autor** — mensagem digitada no WhatsApp Web não tem `from_user_id`, e a Vanessa cairia do lado do robô.

  **Não carimba `first_resp_at`** — senão um lead atendido só por robô apareceria no relatório como respondido por gente.

  **Atraso de 8–20s antes de responder**, e ele faz duas coisas: resposta em 2 segundos às 23h grita "robô"; e o `Set atendendoAgora` + a **reconferência depois da espera** impedem que duas mensagens seguidas do cliente virem duas respostas, e que o robô atropele a Vanessa que respondeu nesses segundos.

  **O disparo no webhook é SEM `await`** (`uazapi.webhook.js`). Webhook lento é webhook que a Uazapi desiste de chamar — e aí para de entrar lead. `atender` nunca lança.

  **A lista de conferência é par obrigatório, não extra**: a conversa que o robô atendeu tem a última mensagem da imobiliária e por isso SAI da fila de "cliente esperando". Sem ela, o robô trocaria "ninguém respondeu" por "ninguém percebeu que faltava responder". `GET/POST /config/robo/conferir`. Teste: `npm run teste:robo` (ele testa sobretudo **quando o robô fica calado**).

  **Religar num lead** (`POST /leads/:id/robo`, só supervisão; cartão "Atendimento da IA neste lead" na ficha): o robô sai da conversa quando gente responde, quando ele se despede ou quando a atendente confere — e até 16/08/2026 isso não tinha volta. Agora a gestão e a atendente religam num atendimento específico, e **religar zera `robo_msgs`** (religar e deixar mudo no teto seria o mesmo botão que não faz nada, com outra roupa). O cartão mostra o **estado real**, não só o botão: as regras gerais continuam valendo depois de religar, então ele diz o que aconteceria se o cliente escrevesse agora e por quê — e o motivo mostrado **prefere a causa do lead à do relógio** ("alguém já respondeu" em vez de "agora é expediente", que muda sozinha às 18h). O corretor não recebe o cartão: o servidor devolve `robo: null` para ele, e a permissão fica num lugar só.

  **Limitação conhecida:** áudio. A mensagem de voz chega como o rótulo "Áudio" — a IA vê que chegou algo e não ouve o conteúdo. O prompt manda pedir por escrito. Transcrição é outro serviço e outro custo.
- **Temperatura só existe quando alguém a coloca** (16/08/2026, `services/lote.js` → `rodarTemperaturaIA`, colunas `leads.priority_por` / `priority_em`): o lead nascia **MORNO** por padrão da coluna — não era leitura de ninguém, e era o morno de ninguém que enchia o Kanban e o relatório. Agora **nenhum caminho de entrada marca temperatura**: nem o WhatsApp, nem o Meta (a nota de corte do formulário saiu de `stages.js`; as respostas continuam em `qual_json` e aparecem na ficha). Ela passa a ter duas origens, e as duas ficam gravadas em `priority_por`: `mao` (o corretor na ficha) e `ia` (a análise que o gestor pede). No card do funil e na catraca, **sem temperatura = sem pastilha** — escrever "sem temperatura" num card de 160px gasta a linha mais visível para dizer que não se sabe.
- **Análise de temperatura por IA, um corretor por vez** (16/08/2026, tela "Base de leads" → Arrumar a base; `GET/POST /leads/lote/temperatura-ia[/:corretorId]`, só ADM): o gestor escolhe **um nome**, vê quantos atendimentos seriam lidos e quanto custa, e manda rodar. A IA lê cada conversa daquele corretor e responde quente/morno/frio olhando **o que o cliente fez**, não o que a imobiliária escreveu (`services/ia.js` → `temperaturaDaConversa`; na dúvida entre dois, escolhe o menos quente). Por corretor porque a pergunta do Ali não é "como está a base", é "como esta pessoa está atendendo" — e assim a leitura fica ao lado do nome de quem atendeu. Ficam de fora os mesmos de sempre: quem está com a atendente (a SDR não entra, e a recusa explica por quê), sem conversa, com venda registrada ou em etapa marcada na mão. **Aqui a IA ESCREVE** — é a única coisa em que ela escreve, porque temperatura não vira cobrança em reunião e o corretor corrige na ficha. Etapa continua sendo sugestão. Teste: `npm run teste:lote`.
- **Lead sem temperatura não é "morno" na conta** (16/08/2026, `services/score.js` → `GRUPOS`/`grupoDe`): o score tinha três grupos e jogava o nulo no do meio. Com a base inteira sem temperatura, a "conversão dos mornos" virava a conversão da base com outro nome. Agora existe o grupo **SEM**, e a recomendação de direcionamento para um lead sem temperatura cai no desempenho da semana — que é a resposta honesta: "não sei como este perfil converte, mas sei quem está atendendo bem agora".
- **Bloco de IA que falha inteiro para o laço** (16/08/2026): as rodadas em lote devolvem `marcados`/`lidos` **separado de** `analisados`, e a tela para quando um bloco inteiro falha, mostrando o motivo. Antes, chave de IA inválida enchia a barra de progresso e terminava com "a IA leu 4 atendimentos" — sem ter lido nenhum. Junto: conversa que falhou **não fica marcada**; o motivo costuma ser a instalação, e marcar deixava o lead 12h fora da fila mesmo depois de o gestor consertar a chave.
- **Visita só conta quando uma pessoa confirma** (14/08/2026): `Agendamento`/`Visita` são etapas que a palavra-chave move sozinha; enquanto a equipe não usa as palavras, o número descreve o palpite da regra. O score passou a usar `visitas_confirmadas` — leads cuja etapa atual tem uma linha em `lead_etapas` com `motivo` em `mao`/`ia`. A tela mostra `confirmadas/total` e uma tarja âmbar dizendo quantas vieram da regra automática. **O histórico começou em 13/08/2026**, então o número nasce zero para todo mundo — zero honesto em vez de um número que ninguém reconhece.
- **Botão que some no iPhone** (14/08/2026): `-webkit-overflow-scrolling:touch` estava em 24 containers. No iOS essa propriedade legada faz `position:fixed` se comportar como `absolute` — a folha que abre por cima fica **presa dentro da área que rola**, e o botão do WhatsApp (popup do funil) e o Imprimir (relatório de reunião) saíam da tela. Removida: desde o iOS 13 a rolagem por inércia é o padrão e ela não faz mais nada além do estrago. Junto: as folhas usam a classe `.tela-cheia` (`height:100vh;height:100dvh` — no iPhone `100vh` é a tela COM a barra do navegador escondida, maior que a área visível), o popup para **acima** da barra de navegação (`usarAlturaDaBarra` mede a barra, que muda de tamanho com a faixa do iPhone) e o relatório ganhou um **segundo botão de imprimir no fim do documento** — ação importante com um caminho só é ação que some quando esse caminho falha.
- **Celular: o que estava fora do alcance** (14/08/2026): a tabela do score tinha 696px de largura numa tela de 375 — **6 das 10 colunas não existiam no celular**, sem nada indicando que dava para arrastar. Virou um cartão por corretor. Junto: `Metric` encolhe a fonte do número em vez de cortar (`R$ 400.000` saía como `R$ 400.00`, e quem bate o olho lê quarenta mil), a faixa de corretores quebra em linhas em vez de cortar o último ao meio, o cartão do corretor empilha (o botão "Relatório para reunião" ia de 174×30 para 313×41) e as pílulas de período passaram de 22–26px para ~34px. **Abaixo de ~32px o dedo erra** — é a régua usada aqui.
- **Lead repassado sobe na caixa do corretor** (13/08/2026, coluna `leads.assigned_at`): a ordem usava a data de ENTRADA do lead, então um lead de junho repassado agora afundava atrás de leads antigos — só por ser antigo — e o corretor não via justamente o que acabou de receber. Agora sobe ao topo o que chegou na mão dele nas últimas 24h, com o selo **"novo com você"**, junto com quem está esperando resposta (as duas coisas somam). `assigned_at` é carimbado em toda atribuição e zerado ao devolver para a fila.
- **O repasse diz se o corretor vai mesmo ser avisado** (13/08/2026): `POST /distribution/{transfer,next,handoff}` devolvem `aviso: {push, motivo}` — `sem_push_no_servidor` (falta VAPID) ou `corretor_sem_notificacao` (ele nunca ativou). A tela mostra uma tarja âmbar. Antes o repasse respondia "ok" nos dois casos e a atendente passava o lead achando que alguém tinha sido chamado; **lead entregue a quem não sabe que recebeu fica parado exatamente como se não tivesse sido entregue**. O disparo do push continua fora do fluxo da resposta — o que é imediato é a conferência "há chave VAPID? este corretor cadastrou aparelho?".
- **Barra de navegação** (13/08/2026): a ordem é a mesma no PC e no celular, mas o **corte é diferente** — 6 itens à vista no PC (`LIMITE_NAV_PC`) e 4 no celular (`LIMITE_NAV`). A barra do PC é uma coluna com a tela inteira de altura sobrando; a do celular é uma linha de 375px, onde sete ícones viram alvos que o dedo não acerta. Como a ordem é a mesma, o que está à vista no celular está à vista no PC. **Funil** ficou logo abaixo de **Painel**, e **Plantão** saiu do "Mais".
- **Escolher quais fotos do imóvel enviar** (13/08/2026, `POST /leads/:id/produto` aceita `fotos_ids`): sem a lista continua indo o anúncio inteiro (o padrão e o caso comum). Com ela vão só as escolhidas, sempre **na ordem do anúncio** — a primeira foto é a capa que o captador definiu e é ela que leva a legenda no WhatsApp. Quando não vão todas, o registro na conversa diz `(2 de 5 fotos)`: dois dias depois, ninguém saberia se o cliente viu o anúncio inteiro ou três fotos escolhidas.
- **Onde cada cartão do lead aparece** (13/08/2026): **Resumo da IA** e **Tarefas** aparecem no popup do funil E na ficha; a **Etapa lida pela IA** fica **só na ficha**. Duas telas oferecendo a mesma decisão é como o mesmo lead acaba movido duas vezes.
- **Funil (kanban) que responde sem clique** (13/08/2026): o card mostra temperatura escrita, **desde quando o lead está NESTA etapa**, quando foi a última conversa, a tarefa marcada (coral se venceu) e uma faixa de urgência no topo. A cor de urgência olha a **última interação**, não a idade do lead — lead de um mês que conversou hoje está saudável; lead de hoje sem resposta está em chamas. Verde não existe de propósito: quadro cheio de verde vira enfeite. Âmbar em 24h, vermelho em 72h.
- **Histórico de etapas** (13/08/2026, tabela `lead_etapas`, `services/etapas.js` → `moverEtapa`): TODA mudança de etapa passa por ali e grava de/para/motivo/quem. `motivo` é `mao`, `palavra`, `ia`, `venda` ou `reanalise`. **O histórico começa no dia em que entrou** — lead que nunca mais mudou não tem linha, e a tela mostra "—" em vez de usar a data de criação, que quase nunca é a mesma coisa. É o pré-requisito que faltava para medir "quantos avançaram para X no período" nos relatórios.
- **Popup do lead no funil** (13/08/2026): clicar no card abre um popup com as mesmas leituras da IA da ficha (resumo e etapa), as tarefas, e um botão do WhatsApp para ir à conversa. Antes o clique jogava direto na conversa — e para decidir o que fazer com um lead parado, ler 40 mensagens não ajuda.
- **Tarefas do lead** (13/08/2026, tabela `tarefas`, `routes/tarefas.routes.js`): "ligar terça", "levar a pasta na Caixa". Pequeno de propósito — texto, data/hora e um risco para dizer que foi feito; sem repetição e sem lembrete por e-mail. A tarefa nasce no nome de **quem está com o lead**, não de quem escreveu: o gestor que combina algo na reunião está criando trabalho para o corretor. Data é obrigatória — sem ela a tarefa não é cobrável.
- **Sino na lista de conversas** (13/08/2026): a temperatura saiu do item da lista e no lugar entrou o sino, para a atendente chamar o corretor sem abrir o lead. Só para quem supervisiona, e só quando há corretor. Fica verde depois de chamado (com a hora no title) para ninguém cutucar duas vezes pelo mesmo motivo.
- **Nome do lead corrigível** (13/08/2026, `PATCH /leads/:id/nome`; lápis no topo da ficha): o nome que entra pelo WhatsApp é o que a PESSOA escolheu no aparelho dela — às vezes o número puro, às vezes o nome do marido. Quem atende corrige, e a supervisão também: quem descobre o nome verdadeiro é quem está conversando. O nome só é gravado quando o lead nasce (`uazapi.webhook.js`), nunca atualizado depois — então a correção não é desfeita pela próxima mensagem. Nome vazio é recusado.
- **Data/hora da última mensagem na lista de conversas** (13/08/2026, `fmtQuando` em `app.jsx`): régua do WhatsApp — hoje mostra a hora (`15:06`), ontem diz "Ontem", dentro da semana o dia da semana, e passando disso a data. O arranjo do item também virou o do WhatsApp: hora em cima à direita, contador de não lidas embaixo à direita. Antes não havia carimbo nenhum na lista.
- **Mensagens do WhatsApp entram na conversa** (06/08/2026): o que o corretor digita direto no celular ou no WhatsApp Web aparece no CRM como mensagem enviada, sem assinatura (o número é único e o WhatsApp não diz quem digitou — a tela mostra "Enviada pelo WhatsApp"). O eco do que o próprio CRM mandou é descartado pelo `messages.wa_id`. Mensagem enviada para um número que ainda NÃO é lead não cria lead: o número da Conecta também fala com colega e fornecedor.
- **Responder uma mensagem específica** (09/08/2026): a seta ao lado do balão cita a mensagem, como o Responder do WhatsApp. `messages.reply_to` guarda o id LOCAL da citada (o `wa_id` é buscado na hora de enviar), e o servidor devolve a citação já resolvida em `/leads/:id`. O envio manda `replyid` para a Uazapi; se ela recusar o campo, a mensagem sai com o trecho citado escrito em cima — nunca se perde a mensagem por causa da citação. Mensagens anteriores a 08/08/2026 não têm `wa_id`: a citação vale só dentro do CRM.
- **Editar mensagem enviada** (10/08/2026): regras do WhatsApp — até 15 minutos, só texto, só o que saiu daqui; o autor edita a própria, a gestão edita qualquer uma. **O texto no CRM só muda depois que a Uazapi confirma** (`editMessage` em `services/uazapi.js` tenta `/message/edit`, `/send/edit`, `/message/update`; 404 passa para o próximo, qualquer outro erro para). Se a edição não sai no WhatsApp, o banco não é tocado — CRM que mostra texto diferente do que o cliente recebeu deixa de servir de registro. `messages.body_original` guarda a primeira versão.
- **Colar imagem (Ctrl+V) mostra a prévia antes de enviar** (10/08/2026): colar NÃO envia — as imagens ficam numa faixa acima do campo, com miniatura, tamanho e um × para tirar a que veio errada. O que estiver digitado vai como legenda (a Uazapi só aceita legenda na primeira). Só o botão Enviar dispara; trocar de conversa descarta o que estava pendente. Imagem errada no WhatsApp do cliente não tem desfazer.
- **Resultado da ligação** (10/08/2026): clicar em Ligar abre o discador e grava a TENTATIVA na hora (`POST /leads/:id/ligacao` devolve o `ligacao_id`); ao voltar, um popup pergunta o que aconteceu — falou / não atendeu / caixa postal / número errado, mais uma observação opcional (`PATCH /leads/:id/ligacao/:ligId`). Só quem ligou responde, nem a gestão. As ligações entram na MESMA linha do tempo da conversa (juntadas na leitura em `/leads/:id`, não gravadas em `messages`). Sem a resposta, a tentativa continua no histórico — antes o relatório contava toques no botão.
- **Aviso de cliente sem resposta** (`services/alerta.js`): passado `orgs.alerta_resposta_min` (padrão 30, 0 desliga), o corretor recebe push. "Esperando" = a última mensagem da conversa é do cliente. `leads.alerta_em` impede repetição; nova mensagem do cliente volta a valer aviso. A gestão também cutuca na mão (`POST /leads/:id/cutucar`), e o pedido fica gravado no lead — sem isso, quem não tem push (todo iPhone fora da Tela de Início) não seria avisado de nada.
- **Link de nova senha** (`POST /auth/users/:id/redefinir-senha`, **só ADM**; botão "Nova senha" na tela Equipe): gera um link de 24h para a pessoa criar outra senha, usando a MESMA página `/definir-senha`. `users.invite_tipo` diz se o token é `convite` ou `redefinicao` — a redefinição vale para conta JÁ ATIVA e não mexe no status nem no papel. Manda por e-mail se o Resend estiver ligado, e devolve o link de qualquer jeito para a gestão repassar no WhatsApp. Gerar outro derruba o anterior.
- **KPIs — o que cada número mede** (revisto em 10/08/2026): **venda** é contada pela `sale_date` dentro do período, não pela entrada do lead. Era o furo que fazia o relatório parecer parado: venda fechada hoje de um lead de junho não aparecia em "esta semana". **Recebidos** e **por_etapa** continuam sendo de quem ENTROU no período (coorte), e `conversao` é de coorte também. `agendamentos` é foto do momento ("onde estão hoje"), não "avançaram no período" — o banco não guarda a data de cada mudança de etapa; para medir avanço por período seria preciso um histórico de etapas, que ainda não existe.
- **Recomendação de direcionamento** (mudou em 10/08/2026): quando não há `AMOSTRA_MINIMA` (5) atendimentos resolvidos por temperatura, a sugestão passa a sair do **desempenho da última semana entre os 5 melhores** (`situacao: "por_desempenho_da_semana"`), em vez de responder "histórico insuficiente" — que na prática travava a sugestão por semanas.
- **Configurações** (11/08/2026, aba que substituiu "Conexão"): duas seções com donos diferentes. **Mensagens automáticas** (`/config/mensagens`, tabela `mensagens_rapidas`) — os botões prontos acima do campo de conversa; gestor **e atendente** editam, criam, ligam/desligam e ordenam, porque texto de abordagem muda toda semana e quem sabe é quem atende; o corretor só usa. Na primeira abertura a imobiliária é semeada com os quatro textos que a Conecta já usava. **Conexão** (`/config/conexao`, só supervisão) — lista de provedores (hoje só Uazapi, marcada como **API não oficial** com o aviso de risco de bloqueio na tela), estado da instância, **Desconectar** (só ADM, exige escrever DESCONECTAR), a URL do webhook para colar e um tutorial de contratação da Uazapi passo a passo dentro da ferramenta.
- **Resumo da conversa por IA** (11/08/2026, `services/ia.js` → `resumirConversa`, botão na ficha do lead): a IA lê a conversa e devolve em campos curtos — situação, o que o cliente quer, quanto pode pagar, o que ficou combinado, próximo passo, o que falta perguntar e um alerta de risco quando existe. Nasceu para o repasse: o corretor recebe um lead com 40 mensagens e precisa saber o essencial em dez segundos. Três regras: **é leitura, nunca escrita** (nada daqui vai para o cliente); **só no clique** (o texto da conversa sai do servidor rumo ao provedor de IA, e isso não pode acontecer sozinho em toda conversa aberta); e **resumo velho se anuncia** (`leads.resumo_msgs` guarda com quantas mensagens foi feito, e a tela diz quantas entraram depois). Fica guardado em `leads.resumo_json` para não pagar duas vezes pelo mesmo clique. Sem `ANTHROPIC_API_KEY` o cartão não aparece — como a leitura do print da Caixa.
- **Vínculo por código**: o corretor se cadastra com o código da imobiliária (`ADM_CODE`, ex.: `CONECTA-JAZ-2026`) para ficar ligado à ADM da Conecta.

## Identidade visual

Verde-esmeralda (`#0E8F6E`), verde profundo (`#0A3D30`), base clara, coral (`#E1553A`) para urgência. Fontes: Sora (títulos), Inter (texto), IBM Plex Mono (números). Elemento-assinatura: cronômetro de espera que "esquenta" (verde→âmbar→vermelho) conforme o lead aguarda. Se o usuário mandar logo/cores oficiais da Conecta, aplicar.

## Estrutura

```
con-crm/
├── DEPLOY.md              # passo a passo de hospedagem, escrito para não-dev
├── render.yaml            # alternativa ao Railway
├── frontend/
│   ├── index.html         # versão compilada e deployável (Netlify). React embutido.
│   ├── build.mjs          # compila src/app.jsx e injeta no index.html (npm run build)
│   └── src/app.jsx        # fonte React (global React, sem imports)
└── backend/
    ├── public/            # cadastro.html e definir-senha.html (HTML puro, sem build)
    ├── railway.json
    ├── .env.example
    ├── src/server.js      # Express app + páginas públicas
    ├── src/bootstrap.js   # cria org e conta ADM no start (idempotente)
    ├── src/db.js          # SQLite + schema + migrações leves de coluna
    ├── src/auth.js        # JWT + middleware de papéis
    ├── src/seed.js        # SÓ testes: usuários fictícios (senha 123456)
    ├── src/routes/        # auth, leads, distribution, messages, meta.webhook, uazapi.webhook
    └── src/services/      # stages, uazapi, meta, mail (Resend)
```

## Ordem de montagem no server.js — a armadilha que já custou caro

`app.use(middleware, router)` **sem caminho** aplica o middleware a TODA rota
registrada depois dele. Em 13/08/2026 as tarefas entraram como
`app.use(cobrando, tarefasRoutes)`, e as rotas seguintes eram os webhooks da
Meta e da Uazapi: **todo lead que chegava pelo WhatsApp levou 401 e foi
descartado**. O CRM continuou de pé, a tela abria, nenhum erro aparecia — só
parou de entrar lead.

Regra: **todo `app.use` com middleware leva caminho explícito.** Rota nova nunca
entra depois dos webhooks sem prefixo próprio.

`npm run teste:webhook` sobe o servidor inteiro e confere de fora: os webhooks e
o painel `/integracoes` respondem SEM login, e `/leads`, `/reports`, `/config`,
`/tarefas` e `/distribution` respondem 401. É o primeiro teste da suíte — se o
webhook está fechado, nada mais importa. Nenhum teste de unidade pega isso:
cada rota isolada funciona; o que quebra é a ordem.

## "Parou de chegar lead" — por onde começar

1. **`SITE/integracoes`** → `ultima_entrada` diz há quantos minutos entrou o
   último lead, a última mensagem recebida e a última enviada. Mensagem
   recebida é o sinal mais sensível: ela chega pelo mesmo webhook do lead novo.
   Se as mensagens continuam entrando e leads não, o WhatsApp está de pé.
   Confira também `whatsapp.ok` (instância pareada?) e `banco.caminho`.
2. **`SITE/integracoes/webhooks`** → o que a Uazapi mandou desde que o servidor
   subiu, com o resultado de cada evento. A lista **zera a cada publicação** — e
   a própria resposta avisa isso, para lista vazia logo após um deploy não ser
   lida como "a Uazapi parou".

## Aviso de versão nova (conserto de 13/08/2026)

O `AvisoVersao` relia o `/index.html` para descobrir se havia versão nova. Isso
funcionava no Netlify — era o próprio arquivo do site. Depois que o CRM passou
a ser servido pelo backend, a página virou `/app` e o `index.html` **não existe
em `backend/public/`**: o pedido voltava 401, o erro era engolido pelo `catch` e
**a faixa de versão nova nunca apareceu na produção**. Cada publicação dependia
de alguém desconfiar sozinho e apertar Ctrl+Shift+R.

Agora confere pelo **`/versao.txt`**, que o build grava e o servidor entrega com
`no-store`. E em **Minha conta** aparecem as DUAS versões — a do aparelho e a
publicada no servidor — com botão de atualizar quando diferem. É o que separa
"não foi publicado" de "está no cache do aparelho": sem as duas lado a lado,
"consertei" e "aqui continua igual" são duas frases verdadeiras que ninguém
consegue reconciliar.

Diagnóstico rápido, sem abrir o CRM: **`https://www.conhubcrm.com.br/versao.txt`**.

## Build do frontend

```bash
cd frontend
npm install     # só na primeira vez (esbuild)
npm run build   # src/app.jsx -> index.html
```

`build.mjs` usa o `index.html` como molde: mantém `<head>`, `<style>` e os React/ReactDOM
embutidos, e troca **só o último `<script>`** pelo JSX recompilado. Ou seja: **JS mexe em
`src/app.jsx`; CSS global e `<meta>` mexem direto no `index.html`.** Sempre rode o build
depois de editar o JSX — senão o arquivo publicado fica velho.

Restrições do sandbox de artifact NÃO se aplicam aqui (é HTML puro). Hoje o app usa
**estilos inline** (sem Tailwind) e ícones SVG inline — mantenha esse padrão para não
depender de rede.

## Rodar o backend

```bash
cd backend
cp .env.example .env      # preencher
npm install
npm run seed              # opcional: usuários fictícios (senha 123456)
npm start                 # http://localhost:4000  (GET /health)
```

Banco: SQLite em `backend/concrm.db` (não commitar). Ao hospedar, aponte `DB_PATH` para
um disco/volume persistente ou migre para Postgres.

Cuidado com Node novo: `better-sqlite3` precisa ser uma versão com binário pré-compilado
para a versão do Node em uso (hoje `^12`), senão o `npm install` tenta compilar do zero e
exige Python + build tools. O npm 11+ também bloqueia os scripts de instalação — o
`package.json` já traz o campo `allowScripts` liberando o `better-sqlite3`.

## Integrações (a ligar)

- **Meta Lead Ads**: webhook `POST /webhooks/meta` (campo `leadgen`) → busca o lead na Graph API e joga na fila da catraca. Precisa `META_VERIFY_TOKEN` e `META_PAGE_ACCESS_TOKEN` (permissão `leads_retrieval`).
- **Uazapi (WhatsApp não-oficial)**: envio em `services/uazapi.js` (`/send/text`), recebimento em `POST /webhooks/uazapi`. Precisa `UAZAPI_HOST`/`UAZAPI_TOKEN`. ATENÇÃO: API não-oficial fere os termos do WhatsApp e tem risco de ban — usar número dedicado, sem disparo em massa idêntico. Os campos exatos de payload variam por provedor; ajustar conforme a conta.
- **E-mail (implementado, falta a conta)**: `services/mail.js` chama a API do Resend por HTTP puro (sem SDK). Precisa de `RESEND_API_KEY` e `MAIL_FROM` com domínio verificado da Conecta. Sem isso, `sendMail` devolve `{sent:false}` e o cadastro cai no modo manual (link na tela + no log) — de propósito, para não travar a operação.

## Relatórios e etapa por IA (feito em 13/08/2026)

Os quatro pontos da pauta do Ali, entregues. O que ficou:

- **Diagnóstico do funil** (`GET /leads/reanalise` → campo `diagnostico`; tela em
  "Base de leads" → Analisar a base). "A palavra-chave não funciona" são três
  doenças com remédios diferentes, e o painel separa: quantas conversas não têm
  NENHUMA das palavras, quantas são só áudio/foto (onde regra de palavra nunca
  vai alcançar) e em quantas conversas cada palavra aparece — marcando a que
  **nunca apareceu**. Sai um veredito escrito, em uma frase. Medir antes de
  mexer no regex é a regra aqui.
- **Etapa lida pela IA** (`POST /leads/:id/etapa-ia`, `services/ia.js` →
  `etapaDaConversa`; cartão na ficha do lead). A IA lê a conversa e diz a
  etapa, com confiança, motivo e o **trecho** que sustenta. **É SUGESTÃO**: quem
  grava é o corretor no botão, pela rota manual de sempre — a regra "a IA lê,
  nunca escreve" continua de pé, e etapa vira relatório que vira cobrança em
  reunião. Guardada em `leads.etapa_ia_json/_em/_msgs` para não pagar duas vezes;
  entra no Uso da IA como recurso `etapa`. Etapa fora do funil ou resposta fora
  do formato viram erro na tela, nunca lead movido.
- **Etapa confirmada por pessoa fica FORA da reanálise** por palavra-chave
  (`fora.confirmado_na_mao`). Sem isso as duas regras brigavam e o lead voltava
  para trás em silêncio.
- **Score fiel à tela**. Eram três descasamentos, todos corrigidos em
  `services/score.js`: venda agora conta pela `sale_date` (era etapa da coorte),
  conversão divide pelos **recebidos** (era pelos resolvidos) e o período é o
  **mesmo** que o gestor escolheu na tela (era 90 dias fixos). A função `pct`
  virou uma só, exportada do `score.js` e usada também pelo `reports.routes.js`
  — eram duas, uma arredondando para inteiro e outra com uma casa decimal
  (33% x 33,3%). O teste `npm run teste:score` compara as duas rotas número a
  número e quebra se voltarem a divergir.
- **A nota vem aberta**: cada parte com valor, régua, peso e quantos pontos
  contribuiu (`COMPONENTES_DO_SCORE`). Clicar no nome na tabela do score abre o
  detalhe. Vendas e ligações são notas **comparativas** (100 = o melhor da
  equipe no período) e a tela avisa isso.
- **Relatório para reunião** (botão na ficha do corretor em Relatórios). Abre em
  tela cheia e sai pela impressão do navegador → Salvar como PDF. Não calcula
  nada: busca as MESMAS duas rotas da tela, com o mesmo período. Traz o bloco
  "Como cada número é medido". O corretor imprime o próprio (sem o bloco da
  nota — ranking continua só da gestão). O CSS de impressão está no
  `index.html`; a folha usa a classe `folha`, e o que não vai ao papel usa
  `nao-imprimir`.

Ainda não existe **histórico de etapas**, então "quantos avançaram para X no
período" continua impossível — `agendamentos` é foto do momento, e o relatório
diz isso por escrito.

## Próximos passos (nesta ordem)

1. **Hospedar o backend** — guia pronto em `DEPLOY.md` (Railway; `render.yaml` como alternativa). Precisa de plano sempre-ligado (o free hiberna e atrasa os webhooks) e de disco persistente com `DB_PATH=/data/concrm.db`. Objetivo: obter a URL HTTPS pública e liberar o link de cadastro. **Domínio (11/08/2026): o endereço oficial é `https://www.conhubcrm.com.br`, COM `www`** — a raiz sem `www` não aponta e não vai apontar tão cedo (o Railway não dá IP fixo e o domínio está com DNSSEC no Registro.br; o porquê está em `DEPLOY.md → Domínio próprio`). Ao trocar o endereço, acompanham: `APP_URL`/`SITE_URL` no Railway (é o `APP_URL` que monta a URL pública das mídias enviadas ao WhatsApp), o webhook da Uazapi e a reinstalação do atalho na tela de início.
2. **Ligar o e-mail** (Resend): verificar o domínio da Conecta, preencher `RESEND_API_KEY` e `MAIL_FROM`. Enquanto isso não é feito, o link de confirmação aparece na tela e no log.
3. **Ligar o frontend ao backend**: trocar os dados de exemplo (lista fixa de login, leads em memória) por chamadas HTTP às rotas. Precisa da URL do passo 1. Aí os corretores fictícios saem e entram as contas reais, e a tela de login vira e-mail + senha.
4. **PWA**: manifest + service worker + ícone para instalar na tela de início. O layout responsivo já está pronto.
5. **Notificações push (Web Push)**: backend dispara push quando um lead é transferido para o corretor ou quando o lead responde. Requer HTTPS (do passo 1), VAPID keys e armazenar a subscription por usuário. Caveat iOS: só funciona se o corretor **adicionar o site à Tela de Início** (PWA) — aba aberta no Safari não recebe push. Android funciona direto.
6. **Tela de equipe para a ADM**: `GET /auth/users` já devolve quem está `pendente` / `ativo`; falta a tela no CRM.

## Decisões já tomadas

- Cadastro **com confirmação por e-mail** (opção b) — decidido em 27/07/2026.
- `ADM_CODE` **continua sendo a trava**, mas vai embutido no link (`?c=...`), então o corretor não digita nada.
- Provedor de e-mail: **Resend** (implementado; falta a conta e o domínio verificado).

## Decisões em aberto (perguntar ao usuário)

- Qual domínio da Conecta usar no remetente do e-mail.
- Nomes reais dos corretores / quem é SDR / quem é ADM (hoje são fictícios no frontend).

## Restrições / cuidados

- Não introduzir `localStorage`/`sessionStorage` no frontend do artifact original; no site hospedado é permitido, mas o padrão atual é estado em memória.
- O avanço de etapa vive só em `backend/src/services/stages.js`. Ao mexer nas palavras (`GATILHOS`), atualizar também o `PALAVRA_ETAPA` de `frontend/src/app.jsx` — é o texto que o corretor lê na ficha, e regra que ninguém sabe não é regra.
- O usuário (Ali) é de marketing/gestão, não é dev — explicar em passos claros, sem jargão, e nunca assumir que ele roda comandos avançados sem orientação.
