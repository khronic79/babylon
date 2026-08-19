---
description: "Сформировать архитектуру и план реализации по тикету"
argument-hint: "[ticket-id]"
allowed-tools: Read, Write, Glob, Grep
---

Используй subagent `planner`.

1. Установи атрибут STAGE в .active_ticket в значение PLAN.
2. Прочитай:
   - `docs/prd/$1.prd.md`,
   - `docs/research/$1.md` (если есть).
3. Создай или обнови `docs/plan/$1.md` со структурой:
   - Components
   - API contract
   - Data flows
   - NFR
   - Risks
   - Open questions (если есть).
4. Если есть архитектурные развилки - создай `docs/adr/$1.md` с вариантами и принятым решением.
5. Если план согласован - установи в `docs/plan/$1.md` строку `Status: PLAN_APPROVED`.