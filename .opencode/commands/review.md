---
description: "Сделать review изменений по тикету"
argument-hint: "[ticket-id]"
allowed-tools: Read, Glob, Grep
---

Используй subagent `reviewer`.

1. Прочитай:
   - `docs/prd/$1.prd.md`,
   - `docs/plan/$1.md`,
   - `docs/tasklist/$1.md`.
2. Проанализируй diff по изменениям, связанным с тикетом `$1`.
3. Сформируй review:
   - blocking-замечания (что нужно исправить до мержа),
   - important (желательно поправить),
   - etc (косметика).
4. Если видишь незакрытые сценарии или долги - предложи добавить задачи в `docs/tasklist/$1.md` (но сам файл не правь без отдельной команды).