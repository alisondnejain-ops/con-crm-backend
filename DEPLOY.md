# Como colocar o ConHub no ar (passo a passo)

> **O site (a tela do CRM) fica no Cloudflare Pages. O servidor (a API) fica no
> Railway.** São duas coisas separadas e independentes — instruções do site logo
> abaixo, do servidor mais adiante.

---

## O site: Cloudflare Pages

Saímos do Netlify porque o plano grátis dele trava as publicações quando o crédito
acaba — foi o que aconteceu em 29/07/2026: seis atualizações ficaram presas com
*"Skipped due to account credit usage exceeded"*, e nem o envio manual passava.

### Publicar (uma vez só)

1. Entre em [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → aba **Pages** → **Connect to Git**
2. Autorize o GitHub e escolha o repositório `con-crm-backend`
3. Configure exatamente assim:

| Campo | Valor |
|---|---|
| Framework preset | **None** |
| Build command | *deixe vazio* |
| Build output directory | `frontend` |
| Root directory | *deixe vazio* |

4. **Save and Deploy**

Pronto. A partir daí, toda mudança no GitHub publica sozinha. O endereço fica
`algo.pages.dev` e já funciona de imediato — use ele enquanto o domínio não muda.

> **Build command vazio** é de propósito: o `index.html` já vai compilado no
> repositório (ver `frontend/build.mjs`). A Cloudflare só serve a pasta.

### Levar o domínio conhubcrm.com.br

O caminho mais simples é passar o DNS do domínio para a Cloudflare — assim o
endereço sem `www` funciona também, o que o registro.br não resolve bem.

1. No painel da Cloudflare: **Add a site** → `conhubcrm.com.br` → plano **Free**
2. Ela lê os registros atuais e mostra **dois servidores de nome** (algo como
   `ana.ns.cloudflare.com`)
3. No **registro.br** → seu domínio → **Alterar servidores DNS** → troque pelos dois
   da Cloudflare
4. Volte ao seu projeto no Pages → **Custom domains** → **Set up a domain** →
   `conhubcrm.com.br` e depois `www.conhubcrm.com.br`

A troca de servidores de nome leva de algumas horas a um dia. O certificado HTTPS
é emitido automaticamente. Enquanto isso, o endereço `.pages.dev` continua servindo.

---

# Servidor (API) no Railway

Objetivo deste guia: sair de "roda no meu computador" para **um link público que você manda no grupo dos corretores**.

Você vai precisar de: uma conta no GitHub e uma conta na hospedagem. Nada de terminal complicado — o essencial é copiar e colar.

---

## Resumo do que acontece

Hoje o cadastro funciona assim:

```
Você manda o link  ──▶  corretor preenche nome, e-mail e WhatsApp
                              │
                              ▼
                     chega um e-mail de confirmação
                              │
                              ▼
                   ele cria a senha  ──▶  conta ativa
```

Enquanto o e-mail automático **não** estiver contratado, o link de confirmação aparece
na própria tela do corretor e no log do servidor — dá para operar assim no começo,
só é menos elegante.

---

## Passo 1 — Subir o código para o GitHub

1. Crie uma conta em [github.com](https://github.com) (se ainda não tiver).
2. Crie um repositório **privado** chamado `con-crm`.
3. Me peça para publicar a pasta `con-crm` nesse repositório — eu faço os comandos de git.

> A pasta já tem `.gitignore` configurado: o banco de dados e o arquivo `.env`
> (que guarda as senhas) **não** vão para o GitHub. Isso é proposital.

---

## Passo 2 — Criar o serviço no Railway

1. Entre em [railway.app](https://railway.app) e faça login **com o GitHub**.
2. **New Project → Deploy from GitHub repo →** escolha `con-crm`.
3. Em **Settings** do serviço:
   - **Root Directory**: `backend`  ← importante, senão ele não acha o projeto
   - **Start Command**: `npm start` (já vem pronto pelo `railway.json`)
4. Em **Settings → Networking → Generate Domain**. Guarde a URL que aparecer,
   algo como `https://con-crm-production.up.railway.app`.

### Disco para o banco de dados

O banco é um arquivo. Sem disco fixo, **cada atualização apaga tudo**.

5. No serviço, **Variables → + Volume** (ou aba *Volumes*): crie um volume com
   **Mount path** = `/data`.

---

## Passo 3 — Preencher as variáveis

Em **Variables**, adicione uma a uma (a lista completa está em `backend/.env.example`):

| Variável | O que colocar |
|---|---|
| `APP_URL` | a URL que o Railway gerou, **sem barra no final** |
| `DB_PATH` | `/data/concrm.db` |
| `JWT_SECRET` | um texto longo e aleatório (peça que eu gere) |
| `ADM_CODE` | o código da imobiliária, ex.: `CONECTA-JAZ-2026` |
| `ADM_EMAIL` | seu e-mail de administrador |
| `ADM_PASSWORD` | a senha que você vai usar para entrar como ADM |
| `FRONTEND_ORIGIN` | **deixe em branco** — hoje a tela vem deste mesmo servidor |
| `CRYPTO_KEY` | a chave que fecha a cópia de segurança (peça que eu gere) |
| `ASAAS_WEBHOOK_TOKEN` | o mesmo texto que você digitou no painel do Asaas |

Salvou → o Railway reinicia sozinho. Abra `https://SUA-URL/health`:
tem que responder `{"ok":true,...}`.

### As três variáveis que não dá para esquecer (revisão de segurança, 02/09/2026)

São as três em que **esquecer não dá erro nenhum** — o CRM sobe, a tela abre,
os leads entram, e alguma coisa fica destrancada em silêncio. Depois de
publicar, abra `https://SUA-URL/integracoes` e olhe o bloco **`seguranca`**:
ele responde as três de uma vez, em português.

1. **`JWT_SECRET`** — a chave que assina o crachá de quem entra. Sem ela o
   servidor agora **se recusa a subir**, e o log diz o que fazer. (Antes ele
   subia usando uma palavra escrita dentro do código: qualquer pessoa que a
   conhecesse entrava como dono da plataforma.)
2. **`CRYPTO_KEY`** — fecha a cópia de segurança diária. Sem ela a cópia
   continua sendo feita, mas **em claro** — e ela é o CRM inteiro de todos os
   clientes num arquivo só, guardado fora do nosso servidor.
   **Guarde uma cópia desta chave fora do Railway.** Perdê-la é perder o
   acesso a todas as cópias antigas.
3. **`ASAAS_WEBHOOK_TOKEN`** — sem ele o aviso de pagamento é **recusado** e a
   conta do cliente não desbloqueia sozinha. (Antes, sem ele a conferência era
   pulada e qualquer pessoa podia avisar "paguei" por qualquer conta.)

E duas opcionais que valem a pena:

- **`META_APP_SECRET`** — confere se o lead veio mesmo do Facebook.
- **`UAZAPI_ACEITAR_POR_NUMERO`** — deixe **fora**. É a saída de emergência
  para o dia em que a Uazapi parar de mandar o token e os leads pararem de
  entrar; `https://SUA-URL/integracoes/webhooks` diz quando esse dia chegou.

> `ADM_EMAIL` e `ADM_PASSWORD` só são usados **uma vez**, para criar sua conta de
> administração no primeiro start. Depois disso pode remover as duas se quiser.
> Não é preciso rodar `seed` na hospedagem — a organização é criada sozinha.

---

## Passo 4 — Testar e mandar o link

Seu link de cadastro é:

```
https://SUA-URL/cadastro?c=CONECTA-JAZ-2026
```

O `?c=...` já preenche o código da imobiliária — o corretor não precisa digitar nada disso.

**Teste você mesmo primeiro**: abra o link no celular, cadastre um e-mail seu,
confirme e faça login. Só depois mande para a equipe.

Para acompanhar quem já se cadastrou e quem ainda não confirmou, entre como ADM
e consulte `GET /auth/users` (ou me peça para montar essa tela no CRM).

---

## Domínio próprio — o que ficou decidido

O endereço oficial do CRM é **`https://www.conhubcrm.com.br`**, com o `www`.

No painel do domínio existe um registro **CNAME** em `www` apontando para o
endereço que o Railway gerou (`8x2da35r.up.railway.app`). É esse o caminho.

**Por que não funciona sem o `www`.** O Railway não entrega um IP fixo: para
apontar a raiz do domínio (`conhubcrm.com.br`, sem nada na frente) seria preciso
um recurso chamado *CNAME flattening* / *ALIAS*, que o DNS do Registro.br não
tem. Só trocando os servidores de DNS para quem tenha (a Cloudflare, por
exemplo, de graça).

**Por que não fizemos essa troca.** O domínio está com **DNSSEC ligado** no
Registro.br. Trocar os servidores de DNS sem desligar o DNSSEC antes derruba o
domínio inteiro — site e e-mail — até desfazer. O ganho seria só poupar quem
digita o endereço na mão, e ninguém digita: o acesso é por link. Decidido em
11/08/2026: fica no `www`. Se um dia for feito, é em horário de baixo
movimento e nesta ordem: desligar o DNSSEC → esperar propagar → recriar os
registros na Cloudflare → só então trocar os servidores de DNS.

**Ao trocar de endereço, três coisas precisam acompanhar:**

1. `APP_URL` e `SITE_URL` nas variáveis do Railway. O `APP_URL` monta o
   endereço público das fotos e vídeos que vão para o WhatsApp — endereço
   errado aqui é envio de mídia quebrado, e o erro não diz isso.
2. O webhook da Uazapi (a URL pronta aparece em *Configurações → Conexão*).
   Sem trocar, o CRM envia mas para de receber.
3. Quem já instalou o CRM na tela de início precisa **remover e adicionar de
   novo** pelo endereço novo — para o navegador é outro site, e a autorização
   de notificação não vai junto.

---

## Passo 5 — Ligar o e-mail automático (Resend)

Enquanto isso não estiver feito, o link de confirmação aparece na tela e no log.

1. Crie a conta em [resend.com](https://resend.com).
2. **Domains → Add Domain**: cadastre o domínio da Conecta e adicione no provedor do
   domínio os registros DNS que o Resend mostrar (SPF/DKIM). Sem domínio verificado,
   o e-mail cai em spam ou nem sai.
3. **API Keys → Create**. Copie a chave.
4. No Railway, adicione:
   - `RESEND_API_KEY` = a chave copiada
   - `MAIL_FROM` = `Conecta Imóveis <nao-responda@seudominio.com.br>`
5. Refaça o teste do Passo 4: agora o e-mail chega de verdade.

---

## Passo 6 — Meta e WhatsApp (depois, sem pressa)

Com a URL pública em mãos:

- **Meta Lead Ads** → webhook `https://SUA-URL/webhooks/meta`, campo `leadgen`,
  com `META_VERIFY_TOKEN` e `META_PAGE_ACCESS_TOKEN`.
- **Uazapi** → `UAZAPI_HOST` / `UAZAPI_TOKEN` e webhook de recebimento em
  `https://SUA-URL/webhooks/uazapi`.

Detalhes em `backend/README.md`.

---

## Cópia de segurança do banco

O banco é **um arquivo só**, no disco do Railway, com os leads de todas as
contas dentro. Perder esse disco é perder tudo de todo mundo de uma vez.

Desde 27/08/2026 o sistema faz uma cópia **todo dia às 3 da manhã** para o
Cloudflare R2 — o mesmo armazenamento das fotos dos imóveis. Ela vai
compactada, é conferida antes de subir (arquivo quebrado não sobe) e ficam
guardadas as **30 mais recentes**.

**Ela só acontece com o R2 configurado**, e isso é de propósito: gravar a cópia
no disco da hospedagem seria guardá-la no mesmo lugar que ela existe para
proteger. Sem R2, o hub avisa em vermelho que não há cópia nenhuma sendo feita.

Onde olhar: **hub de contas → Cópia de segurança**. O cartão mostra a data da
última e um botão **Copiar agora** — use antes de mexer em algo grande
(importar planilha grande, apagar imobiliária).

Duas variáveis opcionais, se quiser mudar: `BACKUP_HORA` (padrão 3) e
`BACKUP_MANTER` (padrão 30).

### Como voltar uma cópia

Você não deve precisar disso sozinho — me chame antes. Mas o caminho é:

1. No painel do Cloudflare R2, abra o bucket e a pasta `backups/`.
2. Baixe o arquivo do dia que você quer (`concrm-2026-08-27.db.gz`).
3. Descompacte: vira `concrm-2026-08-27.db`.
4. No Railway, pare o serviço.
5. Ponha o arquivo no volume, no lugar de `/data/concrm.db`, com esse nome.
6. Apague os arquivos `/data/concrm.db-wal` e `/data/concrm.db-shm` se existirem
   — eles são de outra versão do banco e brigariam com o arquivo restaurado.
7. Suba o serviço de novo.

O que voltar é a foto daquele dia às 3 da manhã: o que entrou depois disso não
está lá. Por isso o botão **Copiar agora** existe.

---

## Alternativa: Render

Já existe um `render.yaml` pronto na raiz. É só **New → Blueprint** apontando para o
repositório. Mesma lógica de variáveis. Atenção: o plano gratuito hiberna e atrasa os
leads da Meta — para operação real, use o plano pago.

---

## Proteção de dados (LGPD) — o que o sistema faz e o que é decisão sua

O CRM guarda dado pessoal de gente que não é da sua equipe: nome, telefone,
conversa de WhatsApp, print de simulação com renda e CPF. A lei brasileira
chama essas pessoas de **titulares**, e dá a elas dois direitos que agora têm
botão no sistema:

- **"O que vocês têm sobre mim?"** → na ficha do lead, a gestão gera um
  documento com tudo: cadastro, conversas, ligações, observações, simulações e
  as leituras que a IA fez.
- **"Apaguem meus dados"** → o mesmo lugar tem a opção de **anonimizar**. Some
  o nome, o telefone, o e-mail, o texto das conversas, os arquivos e as
  observações. **Fica** o esqueleto do atendimento — datas, etapas, quem
  atendeu, quantas mensagens houve —, porque senão o relatório de agosto
  mudaria em setembro e a comissão de um corretor passaria a depender do pedido
  de um cliente. É irreversível e pede confirmação escrita.

**O que continua sendo decisão da imobiliária, não do código:**

1. **Por quanto tempo guardar.** Hoje nada some sozinho. Um lead perdido em
   2024 continua no sistema em 2027. Defina um prazo (ex.: "lead sem interação
   há 3 anos é anonimizado") e me peça para ligar isso.
2. **Aviso de privacidade.** A pessoa que preenche o formulário do Facebook
   precisa saber que os dados dela vão para um CRM, para quê, e como pedir
   exclusão. Isso é texto no anúncio e no site, não no código.
3. **Quem pode ver o quê.** Corretor vê só os leads dele; atendente e gestor
   veem a casa inteira. Isso é do sistema — mas quem você promove a gestor é
   sua decisão, e cada gestor enxerga toda a base de clientes.
4. **A Uazapi.** As conversas do WhatsApp passam por um fornecedor terceiro,
   fora do WhatsApp oficial. Isso precisa estar no seu aviso de privacidade.

---

## Perguntas que costumam aparecer

**Perdi o acesso de ADM.** Coloque `ADM_EMAIL`/`ADM_PASSWORD` com um e-mail novo e
reinicie: ele cria outra conta de administração (não mexe nas existentes).

**Quero trocar o código da imobiliária.** Mude `ADM_CODE` nas variáveis. No próximo
start o código novo passa a valer e os links antigos param de funcionar.

**Um corretor não recebeu o e-mail.** Peça para conferir o spam. Se o Resend ainda não
estiver ligado, o link está no log do servidor (aba *Deployments → Logs* no Railway),
na linha que começa com `[convite]`.
