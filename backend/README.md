# Con CRM — Backend

Backend do CRM da Conecta Imóveis. Recebe os leads dos formulários da Meta em tempo real, distribui pela catraca da SDR, envia/recebe WhatsApp pelo número único da Conecta (via Uazapi) com as mensagens assinadas pelo nome do corretor, e avança o funil automaticamente conforme a conversa.

## Arquitetura (visão geral)

```
Formulário Meta ──(webhook leadgen)──▶  /webhooks/meta  ──▶  grava lead na FILA (sem dono)
                                                              │
SDR (catraca)  ──/distribution/transfer|next──▶  atribui a um atendente disponível
                                                              │
Corretor/SDR   ──POST /leads/:id/messages──▶  Uazapi (número único, msg ASSINADA)  ──▶ lead
Lead responde  ──(webhook Uazapi)──▶  /webhooks/uazapi  ──▶  grava msg + AVANÇA etapa
```

Papéis: **adm** (Ali), **sdr** (Camila — também atende), **corretor**. Um número único da Conecta para todos.

## Como rodar

Requisitos: Node 18+.

```bash
cp .env.example .env      # preencha os valores
npm install
npm run seed              # OPCIONAL: usuários fictícios p/ testar (senha: 123456)
npm start                 # sobe em http://localhost:4000
```

Teste rápido: `GET /health` deve responder `{ ok: true }`.

O `seed` é só para testes. Em produção a organização é criada sozinha no start
(a partir de `ADM_CODE`), e os corretores entram pelo link de cadastro — veja
`../DEPLOY.md`.

## Variáveis de ambiente

Veja `.env.example`. As principais:

- `ADM_CODE` — código que o corretor digita no cadastro para vincular à Conecta.
- `META_VERIFY_TOKEN` — o mesmo que você informa ao configurar o webhook na Meta.
- `META_PAGE_ACCESS_TOKEN` — token da página com permissão `leads_retrieval` (busca os dados do lead).
- `UAZAPI_HOST` / `UAZAPI_TOKEN` — instância da Uazapi do número da Conecta.

## Conectar a Meta (leads em tempo real)

1. No app da Meta (Developers) → Webhooks → objeto **Page** → assine o campo **leadgen**.
2. Callback URL: `https://SEU-DOMINIO/webhooks/meta` · Verify Token: o valor de `META_VERIFY_TOKEN`.
3. Gere o **Page Access Token** (com `leads_retrieval`) e coloque em `META_PAGE_ACCESS_TOKEN`.
4. Cada novo lead do formulário cai automaticamente na fila da catraca.

## Conectar o WhatsApp (Uazapi — número único da Conecta)

1. Crie a instância na Uazapi e conecte o número da Conecta (QR/pareamento).
2. Preencha `UAZAPI_HOST` e `UAZAPI_TOKEN`.
3. Configure o webhook de mensagens recebidas da Uazapi para `https://SEU-DOMINIO/webhooks/uazapi`.
4. Confira o caminho de envio em `src/services/uazapi.js` (`/send/text`) conforme a doc da sua conta.

> As mensagens saem sempre pelo número da Conecta, com o prefixo `*Nome:*` para o lead saber com quem fala.
> Lembre: API não-oficial fere os termos do WhatsApp e tem risco de banir o número — use um chip dedicado, sem disparo em massa idêntico.

## Rotas principais

Auth / cadastro
- `POST /auth/register` `{name,email,phone,adm_code}` — cria a conta como **pendente** e envia o e-mail de confirmação. Sem provedor de e-mail configurado, devolve o `link` na resposta e imprime no log.
- `GET /auth/invite/:token` — valida o link do e-mail
- `POST /auth/set-password` `{token,password}` — define a senha, ativa a conta e já devolve `{token}` de sessão
- `POST /auth/login` `{email,password}` → `{token}`
- `GET /auth/me`
- `GET /auth/users` (adm) — equipe com `status` (`pendente` / `ativo`)

Páginas públicas (servidas pelo próprio backend)
- `GET /cadastro?c=CODIGO` — formulário do corretor (é este o link que a ADM manda)
- `GET /definir-senha?token=...` — destino do e-mail de confirmação

Leads (Bearer token)
- `GET /leads` — atribuídos a mim (corretor/sdr) ou todos (adm)
- `GET /leads/queue` — fila da catraca (sdr/adm)
- `GET /leads/:id` — lead + histórico de mensagens
- `PATCH /leads/:id/stage` `{stage}` — ajuste manual de etapa

Catraca / distribuição (sdr/adm, exceto disponibilidade própria)
- `GET /distribution/attendants`
- `POST /distribution/availability` `{user_id?,available}` — prontidão do dia
- `POST /distribution/transfer` `{lead_id,user_id}` — transferência manual
- `POST /distribution/next` `{lead_id}` — rodízio (próximo disponível)

Atendimento
- `POST /leads/:id/messages` `{text}` — envia no WhatsApp (assinado) + avança etapa

Webhooks
- `GET|POST /webhooks/meta` — leads da Meta
- `POST /webhooks/uazapi` — respostas do lead

## Próximos passos sugeridos

- Relatórios prontos (tempo médio de 1ª resposta e conversão por atendente) como endpoint `/reports`.
- Trocar SQLite por Postgres quando a operação crescer.
- Conectar o frontend (Con CRM) a estas rotas trocando o estado de exemplo por chamadas HTTP.
