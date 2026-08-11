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
