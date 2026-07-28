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
- **Catraca manual (SDR)**: só recebe lead quem se prontificou no dia (campo `available`). A SDR transfere manualmente (um a um) ou por rodízio ("próximo disponível"). Quem está indisponível não entra na fila.
- **Repasse da SDR**: `POST /distribution/handoff` — passa o lead para o próximo CORRETOR disponível (rodízio), ou para um corretor específico. Nunca de volta pra SDR.
- **Funil com 11 etapas** (nesta ordem): `Lead, Atendimento, Pasta, Aprovação, Agendamento, Visita, Proposta, Venda, Perdido, Recaptação, Transferido por ligação`.
- **Avanço automático de etapa**: conforme a conversa evolui, o lead sobe sozinho no funil (ver `backend/src/services/stages.js` → `inferStage`). Regras: forward-only (nunca volta), nunca fecha como "Venda" automaticamente, e não mexe nas etapas manuais (Perdido/Recaptação/Transferido). Palavras-chave disparam etapas (ex.: "agendar" → Agendamento, "documento" → Pasta, "banco/crédito" → Aprovação). A mesma lógica existe no frontend e no backend — mantenha as duas em sincronia.
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

1. **Hospedar o backend** — guia pronto em `DEPLOY.md` (Railway; `render.yaml` como alternativa). Precisa de plano sempre-ligado (o free hiberna e atrasa os webhooks) e de disco persistente com `DB_PATH=/data/concrm.db`. Objetivo: obter a URL HTTPS pública e liberar o link de cadastro.
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
- Manter `inferStage` sincronizado entre `frontend/src/app.jsx` e `backend/src/services/stages.js`.
- O usuário (Ali) é de marketing/gestão, não é dev — explicar em passos claros, sem jargão, e nunca assumir que ele roda comandos avançados sem orientação.
