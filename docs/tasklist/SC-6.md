# SC-6: Tasklist — вывод ошибочно переведённых средств (I-05)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-6.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-6.md` (Status: PLAN_APPROVED)
- Исследование: `docs/research/SC-6.md` (Status: RESEARCH)
- Аудит (источник находки I-05): `docs/audit-reports/2026-08-20.md` (`:398-405`)

## Контекст

Находка I-05: у контракта нет механизма вывода случайно застрявших средств — ни
токенов (переведённых мимо `topUpClientBalance`), ни нативного POL (зачисленного
принудительно через `selfdestruct`). Решение — четыре части, все в одном файле
`contracts/SettelmentsControl.sol` (upgradeable-контракт с ручным слотом хранилища
EIP-7201 `ContractStorage`):

1. Персистентное поле `uint256 totalClientBalance` в `ContractStorage` (в конец
   структуры) — сумма всех балансов клиентов, обновляется симметрично в трёх
   функциях: `topUpClientBalance` (`+= value`), `paymentClientToNative` (`-= amount`),
   `backFundsToClient` (`-= amount`).
2. `withdrawStuckTokens(address token, address to, uint256 amount) external onlyOwner`:
   для USDC (`token == address($.token)`) доступен только избыток
   `balanceOf(this) - totalClientBalance` (с защитой `available = 0`), для прочих
   токенов — весь `balanceOf(this)`; `amount > available` → `InsufficientStuckFunds()`;
   перевод через `SafeERC20.safeTransfer`.
3. `withdrawStuckNative(address payable to, uint256 amount) external onlyOwner`:
   проверка баланса, низкоуровневый `call{value: amount}("")` с проверкой успеха.
4. Событие `StuckFundsWithdrawn(address token, address to, uint256 amount)` + ошибки
   `InsufficientStuckFunds()` / `WithdrawalFailed()`.

Ключевой инвариант: `totalClientBalance == Σ clientBalances`. Если тотал не обновлять
во всех трёх функциях — вывод USDC станет эксплуатируемым (вывод средств клиентов
сверх избытка).

**Скоуп SC-6 — ровно один файл:** `contracts/SettelmentsControl.sol`. Изменения
additive (новое поле структуры, новые функции/событие/ошибки, три однострочные
вставки в существующие функции); сигнатуры существующих функций не меняются. Прокси
`contracts/SettelmentsControlProxy.sol` **не меняется** (POL выводится из реализации
через `delegatecall`; `receive()` прокси остаётся ревертящим).

Вне скоупа: `test/`, `scripts/deploy.ts`, сабграф `thegraph/`, конфиг компилятора
(`viaIR` остаётся выключенным, Solidity `0.8.28`, optimizer `runs=1000`).
`STORAGE_LOCATION` не меняется (`0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`).

Критерий успеха — чистая компиляция:
`rm -rf artifacts cache && npx hardhat compile` → exit 0, **без** `viaIR`.

---

## Задачи

### 1. Добавить `totalClientBalance` в конец `ContractStorage`

- [x] В `struct ContractStorage` (после `uint256 maxValidity;`, строка `:119`) добавить
      `uint256 totalClientBalance;` — поле идёт последним в структуре.

**Acceptance-критерии:**
- Поле `uint256 totalClientBalance;` присутствует ровно в конце `struct ContractStorage`
  (после `maxValidity`, до закрывающей `}`) — существующие поля не сдвинуты и не
  переименованы.
- Нет новых state-переменных верхнего уровня (вне структуры); `STORAGE_LOCATION`
  (`:101-103`) не изменён и равен `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`.
- Доступ к полю идёт только через `_getContractStorage()` (`$.totalClientBalance`).

---

### 2. Добавить событие `StuckFundsWithdrawn` и ошибки `InsufficientStuckFunds`/`WithdrawalFailed`

- [x] В блоке событий (после `event FeeConfigSet(...);`, строка `:66`) добавить
      `event StuckFundsWithdrawn(address token, address to, uint256 amount);`.
- [x] В блоке ошибок (после `error ZeroAmount();`, строка `:99`) добавить
      `error InsufficientStuckFunds();` и `error WithdrawalFailed();`.

**Acceptance-критерии:**
- Объявлено `event StuckFundsWithdrawn(address token, address to, uint256 amount);` —
  три не-индексированных параметра в указанном порядке (без `indexed`).
- Объявлены `error InsufficientStuckFunds();` и `error WithdrawalFailed();` — обе без
  аргументов, в стиле `ZeroAddress()`/`ZeroAmount()`.
- Имена/сигнатуры совпадают с планом §2.2; коллизий селекторов с существующими
  событиями/ошибками нет.

---

### 3. `topUpClientBalance`: обновить тотал (`$.totalClientBalance += value;`)

- [x] После `clientBalance.balance += value;` (строка `:212`) и до
      `clientBalance.lastInboundAddress = from;` добавить `$.totalClientBalance += value;`
      (используется уже существующий локальный `$`).

**Acceptance-критерии:**
- Инкремент тотала стоит строго после изменения `clientBalance.balance` и до
  `emit TopUpClientBalance(...)` — та же точка, что и баланс клиента.
- Используется существующий локальный `$` (нового вызова `_getContractStorage()` не
  добавлено); величина прироста — `value` (совпадает с приростом баланса клиента).
- Порядок остальных операторов функции (`receiveWithAuthorization` → баланс → тотал →
  `lastInboundAddress` → `emit`) сохранён.

---

### 4. `paymentClientToNative`: обновить тотал без локального `$` (`-= amount`)

- [x] Строку `_getContractStorage().clientBalances[clientHash].balance -= amount;`
      (`:301`) дополнить соседней строкой
      `_getContractStorage().totalClientBalance -= amount;` (списание баланса первым).
- [x] НЕ вводить локальный `$` и НЕ трогать `IERC20WithAuthorization token = _getContractStorage().token;`
      (`:285`) — инлайн-доступы сохраняются (SC-1 убрал `$` ради устранения `Stack too deep`).

**Acceptance-критерии:**
- Декремент `_getContractStorage().totalClientBalance -= amount;` стоит сразу после
  `_getContractStorage().clientBalances[clientHash].balance -= amount;` (соседние строки),
  до `emit PaymentClientToNative(ctx)`; величина декремента — `amount`.
- Локальный `$` в функции НЕ появился (инлайн-стиль сохранён); `token` читается как
  `_getContractStorage().token`.
- Проверки `NativeAddressIsOutForSessionSettelment`/`InsufficientClientBalance...`/
  `InsufficientContractBalance...` и трансферы не изменены; семантика функции не меняется.

---

### 5. `backFundsToClient`: обновить тотал (`$.totalClientBalance -= amount;`)

- [x] После `balance.balance = currentBalance - amount;` (строка `:341`) и до
      `emit BackFundsToClient(...)` добавить `$.totalClientBalance -= amount;`
      (используется уже существующий локальный `$`).

**Acceptance-критерии:**
- Декремент тотала стоит строго после списания `balance.balance` и до `emit` — та же
  точка, что и баланс клиента; величина — `amount`.
- Используется существующий локальный `$` (нового вызова `_getContractStorage()` не
  добавлено); порядок остальных операторов функции не изменён.

---

### 6. Реализовать `withdrawStuckTokens(address token, address to, uint256 amount)`

- [x] В конец контракта (после `getFeeConfig`, строка `:499`) добавить функцию
      `withdrawStuckTokens` с модификатором `onlyOwner` по сигнатуре/телу из плана §2.6:
      проверки `to == address(0)`/`token == address(0)` → `ZeroAddress()`; расчёт
      `contractBalance = IERC20(token).balanceOf(address(this))`; для USDC
      (`token == address($.token)`) — `available = contractBalance - $.totalClientBalance`
      с защитой `available = 0` при `contractBalance <= $.totalClientBalance`; для прочих —
      `available = contractBalance`; `amount > available` → `InsufficientStuckFunds()`;
      `SafeERC20.safeTransfer(IERC20(token), to, amount);`; `emit StuckFundsWithdrawn(token, to, amount);`.

**Acceptance-критерии:**
- Сигнатура `withdrawStuckTokens(address token, address to, uint256 amount) external onlyOwner`.
- Порядок проверок fail-fast: `to == address(0)` → `ZeroAddress()`; `token == address(0)` →
  `ZeroAddress()`; затем расчёт `available`; `amount > available` → `InsufficientStuckFunds()`;
  затем перевод — все проверки до внешнего вызова `safeTransfer`.
- Для `token == address($.token)` доступно `balanceOf(this) - totalClientBalance`, при
  `totalClientBalance >= balanceOf(this)` → `available = 0` (underflow не возникает); для
  прочих токенов доступно `balanceOf(this)`.
- Перевод выполнен в библиотечной форме `SafeERC20.safeTransfer(IERC20(token), to, amount);`
  (не `IERC20(token).safeTransfer(...)`); новых импортов нет.
- `emit StuckFundsWithdrawn(token, to, amount);` — после успешного `safeTransfer`.
- Функция не мутирует `totalClientBalance`/`clientBalances` (только чтение).

---

### 7. Реализовать `withdrawStuckNative(address payable to, uint256 amount)`

- [x] В конец контракта (после `withdrawStuckTokens`) добавить функцию
      `withdrawStuckNative` с модификатором `onlyOwner` по сигнатуре/телу из плана §2.7:
      `to == address(0)` → `ZeroAddress()`; `amount > address(this).balance` →
      `InsufficientStuckFunds()`; `(bool success, ) = to.call{value: amount}("");`;
      `if (!success) revert WithdrawalFailed();`; `emit StuckFundsWithdrawn(address(0), to, amount);`.

**Acceptance-критерии:**
- Сигнатура `withdrawStuckNative(address payable to, uint256 amount) external onlyOwner`.
- Порядок проверок: `to == address(0)` → `ZeroAddress()` первой строкой; затем
  `amount > address(this).balance` → `InsufficientStuckFunds()`; затем низкоуровневый
  `call{value: amount}("")` с проверкой `success` → `WithdrawalFailed()`.
- `address(this).balance` используется как баланс (в контексте `delegatecall` из прокси
  отражает баланс прокси); `Address.sendValue` не используется.
- `emit StuckFundsWithdrawn(address(0), to, amount);` — `token = address(0)` маркирует
  вывод POL; событие после успешного перевода.
- Функция не мутирует storage (тотал/балансы не трогаются); `nonReentrant`/`ReentrancyGuard`
  не вводится.

---

### 8. Геттер `getTotalClientBalance()`

- [x] В конец контракта (рядом с другими геттерами) добавить
      `function getTotalClientBalance() external view returns (uint256) { return _getContractStorage().totalClientBalance; }`.

**Acceptance-критерии:**
- Сигнатура `getTotalClientBalance() external view returns (uint256)`; только чтение
  (`view`), без модификатора доступа, возвращает `$.totalClientBalance`.

---

### 9. Финальная проверка: чистая компиляция без `viaIR`

- [x] Проверить сборку на чистом кэше: `rm -rf artifacts cache && npx hardhat compile`
      (без включения `viaIR`; `hardhat.config.ts` не меняется).

**Acceptance-критерии:**
- `rm -rf artifacts cache && npx hardhat compile` завершается с кодом выхода 0, в выводе
  нет `Stack too deep`.
- Компиляция проходит при действующей конфигурации (Solidity `0.8.28`, optimizer
  `enabled: true, runs: 1000`, `viaIR` выключен).
- `git status` показывает изменения только в `contracts/SettelmentsControl.sol`
  (`artifacts/` и `cache/` игнорируются git'ом); `contracts/SettelmentsControlProxy.sol`,
  `test/`, `scripts/deploy.ts`, `thegraph/` и `hardhat.config.ts` не тронуты.

---

## Примечание по независимости

Задачи 1–8 правят один файл `SettelmentsControl.sol`, но локально независимы друг от
друга (разные строки: конец `ContractStorage`, блок событий/ошибок, `topUpClientBalance`,
`paymentClientToNative`, `backFundsToClient`, конец контракта с двумя новыми функциями и
геттером), поэтому порядок их выполнения не влияет на результат. Задача 9 — сквозная
проверка компиляции, выполняется после всех правок.

Ключевые инварианты тикета (PRD §«Риски», план §4):
- Меняется только `contracts/SettelmentsControl.sol`; `STORAGE_LOCATION` не меняется,
  новое поле — только внутри `ContractStorage`, в конец (существующие слоты не сдвигаются).
- `totalClientBalance` обновляется строго в той же точке, что и баланс клиента, во всех
  трёх функциях (`+= value` / `-= amount` / `-= amount`) — инвариант
  `totalClientBalance == Σ clientBalances` сохраняется.
- Для USDC вывод ограничен избытком `balanceOf(this) - totalClientBalance` (с защитой
  `available = 0` при рассинхроне); для прочих токенов — весь баланс.
- `withdrawStuckNative` использует низкоуровневый `call{value: amount}("")` с проверкой
  успеха и маркирует вывод POL через `token = address(0)`.
- Обе функции вывода — `onlyOwner`; reentrancy-вектора нет (`nonReentrant` не вводится).
- `test/`, `scripts/deploy.ts`, `thegraph/` — вне скоупа и не являются критерием приёмки.
