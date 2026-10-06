---
tipo: padrao
tags:
  - padrao
  - qualidade
projetos:
  - con-crm-backend
resumo: Todo erro precisa aparecer para quem usa, com o motivo em português; "respondeu ok e não fez nada" é o defeito mais caro.
criado: 2026-10-06
atualizado: 2026-10-06
---
# Falha silenciosa é o pior defeito

> Todo erro precisa aparecer para quem usa, com o motivo em português; "respondeu ok e não fez nada" é o defeito mais caro.

- Testes que sobem o servidor inteiro e conferem de fora (a trava conferida por dentro não prova nada sobre a rota).
- Diagnóstico visível na tela (ex.: `/integracoes`, quadro "Recebimento das mensagens").
- Ver [[Prévia antes de aplicar]].

---
*Projeto:* [[con-crm-backend]] · 2026-10-06
