---
tipo: projeto
tags:
  - projeto
  - con-crm-backend
  - conhub
resumo: ConHub — CRM de atendimento a leads para imobiliárias (começou na Conecta Imóveis, Petrolina/Juazeiro), multi-conta, com WhatsApp, funil, catraca, IA e relatórios de produtividade.
caminhos: []
criado: 2026-10-06
atualizado: 2026-10-06
---
# con-crm-backend

## Resumo
**ConHub**: CRM de atendimento a leads para imobiliárias e corretores autônomos. Nasceu como CRM interno da Conecta Imóveis e virou plataforma multi-imobiliária (white-label). Foco: atendimento e produtividade individual — sem cadastro de contratos ou financeiro. O contexto completo e todas as decisões estão no `CLAUDE.md` da raiz do repositório.

## Stack
- [[Node + Express + SQLite (better-sqlite3)]]
- Frontend React em arquivo único (`frontend/src/app.jsx` → `index.html` via esbuild)
- Hospedagem Railway (`www.conhubcrm.com.br`), disco persistente em `/data`
- WhatsApp: Uazapi (não oficial) e WhatsApp Cloud API (oficial); Meta Lead Ads
- E-mail Resend · arquivos Cloudflare R2 · cobrança Pagar.me e Asaas · IA Anthropic

## Registros
- 🟠 [[Falar em português, sem jargão]] · Preferência · 2026-10-06
- 🟢 [[Regra escrita num lugar só]] · Padrão · 2026-10-06
- 🟢 [[Falha silenciosa é o pior defeito]] · Padrão · 2026-10-06
- 🟢 [[Prévia antes de aplicar]] · Padrão · 2026-10-06
- 🟣 [[Registrar cada decisão no CLAUDE.md do projeto]] · Decisão · 2026-10-06
