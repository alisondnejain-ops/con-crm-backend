---
tipo: padrao
tags:
  - padrao
  - arquitetura
projetos:
  - con-crm-backend
resumo: Uma regra de negócio mora numa função só, chamada por todos os caminhos; regra copiada em duas rotas diverge em silêncio.
criado: 2026-10-06
atualizado: 2026-10-06
---
# Regra escrita num lugar só

> Uma regra de negócio mora numa função só, chamada por todos os caminhos; regra copiada em duas rotas diverge em silêncio.

Exemplos no ConHub: `trocarResponsavel` (seis rotas faziam o mesmo UPDATE), `moverLead` (cinco caminhos movem etapa), `temRecurso`, `whatsConectado`. Quando a tela e o servidor precisam da mesma lista, ela é gerada de uma fonte só (ex.: `services/paises.js` injetado no build).

---
*Projeto:* [[con-crm-backend]] · 2026-10-06
