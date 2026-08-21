# SC-5: Tasklist — пакет малых исправлений контракта (M-02…I-02)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-5.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-5.md` (Status: PLAN_APPROVED)
- Исследование: `docs/research/SC-5.md`
- Аудит (источник находок M-02…I-02): `docs/audit-reports/2026-08-20.md`

## Контекст

Тикет закрывает находки аудита M-02, M-03, L-05 и I-02. Все они относятся к одному
файлу — `contracts/SettelmentsControl.sol` (upgradeable-контракт с ручным слотом
хранилища EIP-7201 `ContractStorage`). Изменения локальные и additive (новые ошибки,
новое событие, смена модификатора одной функции); сигнатуры функций не меняются.

**Скоуп SC-5 — ровно один файл:** `contracts/SettelmentsControl.sol`.

- M-02: в `initialize` валидация `_token`/`_admin`/`_owner`/`_feeCollector` на
  `address(0)` с единой ошибкой `ZeroAddress()`.
- M-03: событие `FeeConfigSet(uint256 feePercentage, address feeCollector)`; эмиссия в
  `initialize` и в `setFeeConfig`; `setFeeConfig` переводится с `onlyAdmin` на `onlyOwner`.
- L-05: `require(amount > 0, "...")` → `if (amount == 0) revert ZeroAmount();`.
- I-02: перегенерация `STORAGE_LOCATION` из `"SettelmentsControl.storage"` (правка
  `scripts/calc.js` + константа в контракте).

Вне скоупа: `test/`, `scripts/deploy.ts`, сабграф `thegraph/`, конфиг компилятора
(`viaIR` остаётся выключенным, Solidity `0.8.28`, optimizer `runs=1000`). Находки
L-01/L-03/L-04 — без изменений кода (решения зафиксированы в PRD).

Критерий успеха — чистая компиляция:
`rm -rf artifacts cache && npx hardhat compile` → exit 0, **без** `viaIR`.

---

## Задачи

### 1. Добавить ошибки `ZeroAddress()` / `ZeroAmount()` и событие `FeeConfigSet`

- [x] В блоке ошибок (после `error InvalidAdmin();`, строка `:96`) добавить
      `error ZeroAddress();` и `error ZeroAmount();` (обе без аргументов).
- [x] В блоке событий (после `event MaxValiditySet(uint256 maxValidity);`, строка `:65`)
      добавить `event FeeConfigSet(uint256 feePercentage, address feeCollector);`.

**Acceptance-критерии:**
- В контракте объявлены `error ZeroAddress();` и `error ZeroAmount();` — ровно с этими
  именами, без параметров, в стиле `OnlyAdmin()`/`InvalidFeeCollector()`.
- Объявлено `event FeeConfigSet(uint256 feePercentage, address feeCollector);` — два
  не-индексированных параметра, имена и порядок совпадают с планом §2.1.
- Имена не конфликтуют с существующими событиями/ошибками (коллизий селекторов нет).

---

### 2. `initialize`: валидация адресов `ZeroAddress()` + `emit FeeConfigSet` (M-02, M-03)

- [x] После существующих проверок `FeeTooHigh`/`InvalidMaxValidity` и до первой записи
      в `$` добавить составную проверку: `_token`/`_admin`/`_owner`/`_feeCollector`
      равны `address(0)` → `revert ZeroAddress();`.
- [x] После записи fee-полей (`$.feeCollector` / `$.maxValidity`) и перед
      `emit ChangeAdmin(_admin)` добавить `emit FeeConfigSet(_feePercentage, _feeCollector);`
      (по аргументам функции).

**Acceptance-критерии:**
- `initialize` ревертится `ZeroAddress()` при любом из `_token`/`_admin`/`_owner`/
  `_feeCollector == address(0)`; валидный вызов проходит.
- Порядок операторов сохранён: `__EIP712_init` → `FeeTooHigh` → `InvalidMaxValidity` →
  `ZeroAddress` → запись полей → `emit FeeConfigSet` → `emit ChangeAdmin` (план §2.2).
- Проверка `ZeroAddress` стоит до записи `$.token = ...`; существующие строки
  `:159-160` не сдвинуты.

---

### 3. `setFeeConfig`: `onlyAdmin` → `onlyOwner` + `emit FeeConfigSet` (M-03)

- [x] Заменить модификатор `onlyAdmin` на `onlyOwner` у `setFeeConfig`.
- [x] После записи `$.feeCollector = feeCollector;` добавить
      `emit FeeConfigSet(feePercentage, feeCollector);`.
- [x] Сохранить проверки `feePercentage > 100` → `FeeTooHigh` и
      `feeCollector == address(0)` → `InvalidFeeCollector` в прежнем порядке.

**Acceptance-критерии:**
- Сигнатура функции `setFeeConfig(uint256 feePercentage, address feeCollector)` не
  изменена; модификатор — `onlyOwner` (не `onlyAdmin`).
- Вызов `setFeeConfig` от адреса, отличного от `$.owner`, ревертится `OnlyOwner()`.
- Проверки `FeeTooHigh`/`InvalidFeeCollector` стоят в прежнем порядке до записи;
  `emit FeeConfigSet(feePercentage, feeCollector)` — после записи обоих полей.
- Верхняя граница `feePercentage > 100` не меняется.

---

### 4. `paymentClientToNative` / `backFundsToClient`: `require` → `ZeroAmount()` (L-05)

- [x] В `paymentClientToNative` заменить
      `require(amount > 0, "Settlement amount between client and native must be > 0");`
      на `if (amount == 0) revert ZeroAmount();`.
- [x] В `backFundsToClient` заменить
      `require(amount > 0, "Back fund amount to client must be > 0");`
      на `if (amount == 0) revert ZeroAmount();`.

**Acceptance-критерии:**
- В обеих функциях отсутствуют `require` со строковыми сообщениями; используется
  `if (amount == 0) revert ZeroAmount();` (семантика `amount > 0` для `uint256`
  эквивалентна).
- Остальная логика (`onlyAdmin`, расчёты, трансферы, события) не изменена.

---

### 5. Перегенерация `STORAGE_LOCATION` (I-02)

- [x] В `scripts/calc.js` заменить строку namespace на `"SettelmentsControl.storage"`
      (и перевести скрипт с `web3` на `ethers` — зависимость отсутствует).
- [x] В `contracts/SettelmentsControl.sol` обновить `STORAGE_LOCATION` на
      `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00` и поправить
      комментарий на `keccak256("SettelmentsControl.storage")`.

**Acceptance-критерии:**
- `scripts/calc.js` (`node scripts/calc.js`) печатает ровно
  `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`.
- В контракте `STORAGE_LOCATION == 0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`,
  комментарий соответствует строке `"SettelmentsControl.storage"`.
- Структура `ContractStorage` и раскладка полей не изменены, новых персистентных полей нет.

---

### 6. Финальная проверка: чистая компиляция без `viaIR`

- [x] Проверить сборку на чистом кэше: `rm -rf artifacts cache && npx hardhat compile`
      (без включения `viaIR`; `hardhat.config.ts` не меняется).

**Acceptance-критерии:**
- `rm -rf artifacts cache && npx hardhat compile` завершается с кодом выхода 0, в выводе
  нет `Stack too deep`.
- Компиляция проходит при действующей конфигурации (Solidity `0.8.28`, optimizer
  `enabled: true, runs: 1000`, `viaIR` выключен).
- `git status` показывает изменения только в `contracts/SettelmentsControl.sol`
  (`artifacts/` и `cache/` игнорируются git'ом); `test/`, `scripts/deploy.ts`,
  `thegraph/` и `hardhat.config.ts` не тронуты.

---

## Примечание по независимости

Задачи 1–5 правят один файл `SettelmentsControl.sol` и локально независимы друг от
друга (разные строки: блок ошибок/событий, `initialize`, `setFeeConfig`,
`paymentClientToNative`/`backFundsToClient`, комментарий `STORAGE_LOCATION`), поэтому
порядок их выполнения не влияет на результат. Задача 6 — сквозная проверка компиляции,
выполняется после всех правок.

Ключевые инварианты тикета (PRD §«Ограничения», план §4):
- Изменяются `contracts/SettelmentsControl.sol` и `scripts/calc.js`.
- `STORAGE_LOCATION` перегенерирован (I-02); структура `ContractStorage` не меняется.
- Новых персистентных полей нет; изменения additive (событие/ошибки/модификатор).
- Верхняя граница `feePercentage > 100` не меняется (осознанно зафиксировано).
- `test/`, `scripts/deploy.ts`, `thegraph/` — вне скоупа и не являются критерием приёмки.
