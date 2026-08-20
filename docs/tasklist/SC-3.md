# SC-3: Tasklist — атомарная инициализация прокси (H-02)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-3.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-3.md` (Status: PLAN_APPROVED)
- Исследование: `docs/research/SC-3.md` (Status: RESEARCH)
- ADR (развилка `bytes memory data` vs явные параметры): `docs/adr/SC-3.md`
- Аудит (источник H-02): `docs/audit-reports/2026-08-20.md` (`:168-196`)

## Контекст

Находка H-02: `initialize` в `SettelmentsControl` защищён только модификатором
`initializer`, а текущий конструктор прокси деплоит его с пустыми данными
(`ERC1967Proxy(implementation, "")`), после чего `initialize` вызывается отдельной
транзакцией — любой наблюдатель может фронт-ранить её и захватить админа/владельца.
Решение — канонический паттерн OpenZeppelin: конструктор прокси принимает
`bytes memory data` и пробрасывает их в базовый `ERC1967Proxy`, который атомарно
выполняет `initialize` в рамках транзакции деплоя.

**Скоуп:** изменяется **только** конструктор `contracts/SettelmentsControlProxy.sol`
(`:15-17`). `SettelmentsControl.sol` (модификатор `initializer` и
`_disableInitializers()` уже корректны), deploy-скрипт, тесты, сабграф и конфиг
компилятора (`viaIR` выключен) — вне скоупа и не меняются.

---

## Задачи

### 1. Изменить сигнатуру конструктора прокси на `(address implementation, bytes memory data)`

- [x] В `contracts/SettelmentsControlProxy.sol` заменить объявление конструктора
      (`:15`) с `constructor(address implementation)` на
      `constructor(address implementation, bytes memory data)`.

**Acceptance-критерии:**
- Конструктор `SettelmentsControlProxy` имеет ровно два параметра в указанном
      порядке: `(address implementation, bytes memory data)`; параметр `data` —
      тип `bytes memory`.
- Конструктор остаётся non-payable (модификатор `payable` не добавлен); контракт
      по-прежнему `is ERC1967Proxy` без дополнительного наследования.

---

### 2. Пробросить `data` в базовый `ERC1967Proxy`

- [x] Заменить вызов базового конструктора с `ERC1967Proxy(implementation, "")`
      на `ERC1967Proxy(implementation, data)`.

**Acceptance-критерии:**
- В списке инициализации базовых конструкторов присутствует ровно
      `ERC1967Proxy(implementation, data)` — второй аргумент это параметр `data`,
      а не пустой литерал `""`.
- `data` передаётся в базовый `ERC1967Proxy`, что включает атомарный
      `functionDelegateCall` на `initialize` при непустых `data` (поведение
      обеспечивается базовым классом; дополнительный код в прокси не добавляется).

---

### 3. Сохранить `changeAdmin(msg.sender)` в теле конструктора

- [x] Убедиться, что тело конструктора по-прежнему содержит
      `ERC1967Utils.changeAdmin(msg.sender);` и оно выполняется **после** базового
      конструктора (порядок гарантируется правилом Solidity — базовые конструкторы
      исполняются первыми).

**Acceptance-критерии:**
- В теле конструктора присутствует ровно `ERC1967Utils.changeAdmin(msg.sender);`
      — без изменений относительно исходного кода.
- Назначение админа происходит после базового конструктора: деплойер прокси
      становится админом прокси, а реверт `initialize` (при непустых `data`)
      откатывает весь деплой — частично инициализированного состояния не возникает.

---

### 4. Подтвердить неизменность остальных функций прокси

- [x] Проверить, что `receive` (`NotAcceptEtherDirectly`), `changeProxyAdmin`,
      `getProxyAdmin`, `getImpl`, `setImpl` и модификатор `onlyProxyAdmin` не
      затронуты правкой.

**Acceptance-критерии:**
- `git diff` по `contracts/SettelmentsControlProxy.sol` показывает изменения
      только в конструкторе (строки `:15-17`): сигнатура, вызов базового
      `ERC1967Proxy` и тело; все остальные функции/модификатор/ошибки
      (`OnlyAdmin`, `NotAcceptEtherDirectly`) идентичны исходным.
- Не добавлено новых state-переменных верхнего уровня, функций, событий, ошибок
      или модификаторов; ручной слот хранилища прокси не задействован
      (слоты `IMPLEMENTATION_SLOT`/`ADMIN_SLOT` управляются базовыми классами).

---

### 5. Финальная проверка: чистая компиляция без `viaIR`

- [x] Проверить сборку на чистом кэше: `rm -rf artifacts cache && npx hardhat compile`
      (без включения `viaIR`; конфиг `hardhat.config.ts` не меняется).

**Acceptance-критерии:**
- Команда `rm -rf artifacts cache && npx hardhat compile` завершается с кодом
      выхода 0, в выводе компилятора нет `Stack too deep`.
- Компиляция проходит при действующей конфигурации (Solidity `0.8.28`, optimizer
      `enabled: true, runs: 1000`, `viaIR` выключен) — правок `hardhat.config.ts` нет.
- `git status` показывает изменения только в `contracts/SettelmentsControlProxy.sol`
      (`artifacts/` и `cache/` игнорируются git'ом);
      `contracts/SettelmentsControl.sol`, `scripts/deploy.ts`, тесты и `thegraph/`
      не тронуты.

---

## Примечание по независимости

Все задачи относятся к одному конструктору в одном файле и выполняются в порядке
нумерации: сначала сигнатура (1), затем передача `data` в базовый конструктор (2) и
подтверждение сохранённого `changeAdmin(msg.sender)` (3) — вместе они образуют
целевую форму из плана §2.2. Задача 4 — проверка неизменности остальной части файла,
задача 5 — сквозная проверка чистой компиляции всего набора.

Ключевой инвариант тикета (PRD §«Риски», план §3.2): порядок «базовый конструктор
(имплементация + `initialize`) → `changeAdmin(msg.sender)`» обязателен; он
гарантируется правилом Solidity (базовые конструкторы исполняются первыми) и не
требует ручного переупорядочивания. Осознанный trade-off (план §5): контракт не
принуждает передавать непустые `data` — при `data = ""` прокси останется
неинициализированным; ответственность за всегда-непустые `data` лежит на будущем
deploy-скрипте (вне скоупа SC-3).
