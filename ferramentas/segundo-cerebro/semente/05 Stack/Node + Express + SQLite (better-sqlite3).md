---
tipo: stack
tags:
  - stack
  - node
  - sqlite
projetos:
  - con-crm-backend
resumo: Backend Node/Express com SQLite via better-sqlite3 (síncrono); banco num volume persistente; sem ORM.
criado: 2026-10-06
atualizado: 2026-10-06
---
# Node + Express + SQLite (better-sqlite3)

> Backend Node/Express com SQLite via better-sqlite3 (síncrono); banco num volume persistente; sem ORM.

- Migrações leves de coluna no start (`ALTER TABLE ... ADD COLUMN`), idempotentes.
- `better-sqlite3` precisa de binário pré-compilado para a versão do Node.
- Consulta com muitos `IN (?,?…)` estoura acima de ~32 mil variáveis — usar lotes.
- `app.use(middleware, router)` sem caminho vale para TODA rota registrada depois (já derrubou os webhooks).

---
*Projeto:* [[con-crm-backend]] · 2026-10-06
