---
description: "Разбить план по тикету на список небольших задач (tasklist)"
argument-hint: "[ticket-id]"
allowed-tools: Read, Write, Glob, Grep
---

Используй subagent `task-planner`.

1. Установи атрибут STAGE в .active_ticket в значение TASK.
2. Прочитай:
   - `docs/prd/$1.prd.md`,
   - `docs/plan/$1.md`.
3. Сформируй `docs/tasklist/$1.md`:
   - заголовок и краткий контекст,
   - список задач с `- [ ]`,
   - для каждой задачи - 1-2 acceptance-критерия.
4. Если tasklist выглядит цельным и покрывает план - установи `Status: TASKLIST_READY`.