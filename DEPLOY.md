# Como colocar o Con CRM no ar (passo a passo)

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
| `FRONTEND_ORIGIN` | o endereço do CRM no Netlify |

Salvou → o Railway reinicia sozinho. Abra `https://SUA-URL/health`:
tem que responder `{"ok":true,...}`.

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

## Alternativa: Render

Já existe um `render.yaml` pronto na raiz. É só **New → Blueprint** apontando para o
repositório. Mesma lógica de variáveis. Atenção: o plano gratuito hiberna e atrasa os
leads da Meta — para operação real, use o plano pago.

---

## Perguntas que costumam aparecer

**Perdi o acesso de ADM.** Coloque `ADM_EMAIL`/`ADM_PASSWORD` com um e-mail novo e
reinicie: ele cria outra conta de administração (não mexe nas existentes).

**Quero trocar o código da imobiliária.** Mude `ADM_CODE` nas variáveis. No próximo
start o código novo passa a valer e os links antigos param de funcionar.

**Um corretor não recebeu o e-mail.** Peça para conferir o spam. Se o Resend ainda não
estiver ligado, o link está no log do servidor (aba *Deployments → Logs* no Railway),
na linha que começa com `[convite]`.
