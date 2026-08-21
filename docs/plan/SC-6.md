# SC-6: План — вывод ошибочно переведённых средств (I-05)

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-6.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-6.md` (Status: RESEARCH)
- Аудит (источник находки I-05): `docs/audit-reports/2026-08-20.md:398-405`
- ADR: **не создаётся** — значимых архитектурных развилок нет; все открытые вопросы
  закрываются решениями в §2/§5 этого плана (см. §7).

## 1. Components

| Компонент | Файл / строки | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Реализация | `contracts/SettelmentsControl.sol` | **Да (единственный файл)** | Поле `totalClientBalance` в `ContractStorage`, 3 точки обновления тотала, 2 новые `onlyOwner`-функции вывода, событие + 2 ошибки. |
| Структура `ContractStorage` | `:110-120` | Да | Добавить `uint256 totalClientBalance;` после `uint256 maxValidity;` (`:119`). |
| Блок событий | `:55-66` | Да | Добавить `event StuckFundsWithdrawn(address token, address to, uint256 amount);` после `FeeConfigSet` (`:66`). |
| Блок ошибок | `:68-99` | Да | Добавить `error InsufficientStuckFunds();` и `error WithdrawalFailed();` после `ZeroAmount()` (`:99`). |
| `topUpClientBalance` | `:183-221` | Да | `$.totalClientBalance += value;` после `:212`. |
| `paymentClientToNative` | `:256-304` | Да | Оставить инлайн-доступы; добавить `_getContractStorage().totalClientBalance -= amount;` рядом со списанием баланса. |
| `backFundsToClient` | `:306-344` | Да | `$.totalClientBalance -= amount;` после `:341`. |
| Конец контракта | после `:499` | Да | Две новые функции `withdrawStuckTokens` / `withdrawStuckNative` и геттер `getTotalClientBalance()`. |
| Прокси | `contracts/SettelmentsControlProxy.sol` | Нет | `receive()` остаётся ревертящим; POL выводится из реализации через `delegatecall`. |
| Тесты / deploy-скрипт / сабграф | `test/`, `scripts/deploy.ts`, `thegraph/` | Нет | Потребители ABI; **не меняются** (I-03). |

**Итог по скоупу:** меняется ровно один файл — `contracts/SettelmentsControl.sol`.
Изменения additive (новое поле структуры, новые функции/событие/ошибки, три однострочные
вставки в существующие функции); сигнатуры существующих функций не меняются.

---

## 2. API contract (целевые интерфейсы и контракты)

### 2.1 Новое поле структуры (EIP-7201)

**До** (`:110-120`):

```solidity
struct ContractStorage {
    mapping(bytes32 => ClientBalance) clientBalances;
    mapping(bytes32 => address) nativeAddresses;
    mapping(bytes32 => bool) usedNonces;
    IERC20WithAuthorization token;
    address admin;
    address owner;
    uint256 feePercentage;
    address feeCollector;
    uint256 maxValidity;
}
```

**После**:

```solidity
struct ContractStorage {
    mapping(bytes32 => ClientBalance) clientBalances;
    mapping(bytes32 => address) nativeAddresses;
    mapping(bytes32 => bool) usedNonces;
    IERC20WithAuthorization token;
    address admin;
    address owner;
    uint256 feePercentage;
    address feeCollector;
    uint256 maxValidity;
    uint256 totalClientBalance;
}
```

- Поле добавляется **в конец** структуры — существующие слоты не сдвигаются, раскладка
  upgradeable-хранилища внутри namespace `STORAGE_LOCATION` сохраняется.
- **Запрещено** добавлять state-переменную верхнего уровня — только внутрь структуры
  (ручной слот EIP-7201, `AGENTS.md`). `STORAGE_LOCATION` (`:101-103`) **не меняется**
  (значение `0xa3644cd4f…` сгенерировано в SC-5).

### 2.2 Новое событие и новые ошибки

После `:66` (`event FeeConfigSet(uint256 feePercentage, address feeCollector);`) добавить:

```solidity
event StuckFundsWithdrawn(address token, address to, uint256 amount);
```

После `:99` (`error ZeroAmount();`) добавить:

```solidity
error InsufficientStuckFunds();
error WithdrawalFailed();
```

Обоснование имен (открытые вопросы №1, №4):
- **Единая `InsufficientStuckFunds()`** — без аргументов, в стиле `ZeroAddress()`/
  `ZeroAmount()`. Единая ошибка для обеих функций вывода (токены и POL) — коллизий имён
  нет; раздельные `InsufficientStuckTokens`/`InsufficientStuckNative` избыточны (семантика
  одинакова: «запрошено больше доступного для вывода»).
- **`WithdrawalFailed()`** — отдельная ошибка для случая, когда низкоуровневый
  `call{value: amount}` в `withdrawStuckNative` вернул `false` (получатель отверг перевод).
  Она **не** заменяет `InsufficientStuckFunds()`: разграничивает «недостаточно средств»
  (проверка `amount <= balance`) от «получатель не принял перевод» (проверка `success`),
  что улучшает диагностику для off-chain/аудита. Имя свободно, коллизий нет.
- **Событие `StuckFundsWithdrawn(address token, address to, uint256 amount)`** —
  **эмитим**. Обоснование: (а) контракт эмитит событие на каждое движение средств
  (`TopUpClientBalance`, `PaymentClientToNative`, `BackFundsToClient`) — пропуск события
  на выводе нарушил бы сложившийся паттерн аудируемости; (б) даёт off-chain (в т.ч. будущий
  сабграф, где сейчас мёртвый `WithdrawFundsToNative`) единую точку наблюдения за выводом;
  (в) additive-изменение ABI допустимо (прод не развёрнут). Для нативного вывода в поле
  `token` передаётся `address(0)` — это различает «вывод POL» от «вывод токена» без второго
  события и без `indexed`-флагов (соответствует стилю `BackFundsToClient`).

### 2.3 `topUpClientBalance` — обновление тотала (`+= value`)

**До** (`:212-213`):

```solidity
clientBalance.balance += value;
clientBalance.lastInboundAddress = from;
```

**После**:

```solidity
clientBalance.balance += value;
$.totalClientBalance += value;
clientBalance.lastInboundAddress = from;
```

Здесь `$` уже локальный (`:194`), дополнительных чтений хранилища нет. Вставка **сразу
после** изменения `clientBalance.balance` и **до** `emit` — та же точка, что и баланс
клиента, что гарантирует симметричность инварианта.

### 2.4 `backFundsToClient` — обновление тотала (`-= amount`)

**До** (`:341`):

```solidity
balance.balance = currentBalance - amount;
```

**После**:

```solidity
balance.balance = currentBalance - amount;
$.totalClientBalance -= amount;
```

`$` локальный (`:311`); вставка сразу после списания `balance.balance`, до `emit`.

### 2.5 `paymentClientToNative` — обновление тотала без локального `$` (открытый вопрос №3)

Функция обращается к хранилищу **инлайн** (`_getContractStorage()`), и локальный `$`
здесь **не вводим**: в SC-1 он был намеренно убран именно для устранения
`Stack too deep` (возврат `$` рискует снова сломать компиляцию). Поэтому тотал
обновляется вторым инлайн-вызовом рядом со списанием баланса.

**До** (фрагмент `:301`):

```solidity
_getContractStorage().clientBalances[clientHash].balance -= amount;

emit PaymentClientToNative(ctx);
```

**После**:

```solidity
_getContractStorage().clientBalances[clientHash].balance -= amount;
_getContractStorage().totalClientBalance -= amount;

emit PaymentClientToNative(ctx);
```

Точная правка: строку `_getContractStorage().clientBalances[clientHash].balance -= amount;`
дополнить соседней строкой `_getContractStorage().totalClientBalance -= amount;`. Строку
`IERC20WithAuthorization token = _getContractStorage().token;` (`:285`) **не трогать** —
она остаётся инлайн.

Выбор: **два инлайн-вызова**, а не локальный `$`. Причина: сохранение стековой
разгрузки из SC-1 (инлайн-доступ возвращает transient-указатель и не держит живой
storage-указатель `$` на протяжении функции). Синхронность двух списаний обеспечивается
их соседством в одной точке, как и в `topUpClientBalance`/`backFundsToClient`.

### 2.6 Новая функция `withdrawStuckTokens`

Добавляется в конец контракта (после `getFeeConfig`, `:499`):

```solidity
function withdrawStuckTokens(
    address token,
    address to,
    uint256 amount
) external onlyOwner {
    if (amount == 0) revert ZeroAmount();
    if (to == address(0)) revert ZeroAddress();
    if (token == address(0)) revert ZeroAddress();

    uint256 contractBalance = IERC20(token).balanceOf(address(this));
    uint256 available;

    if (token == address(_getContractStorage().token)) {
        uint256 total = _getContractStorage().totalClientBalance;
        available = contractBalance > total ? contractBalance - total : 0;
    } else {
        available = contractBalance;
    }

    if (amount > available) revert InsufficientStuckFunds();

    SafeERC20.safeTransfer(IERC20(token), to, amount);

    emit StuckFundsWithdrawn(token, to, amount);
}
```

Пояснения:
- **Порядок проверок (fail-fast, до мутации):** `amount == 0` → `ZeroAmount()`;
  `to == address(0)` → `ZeroAddress()`; `token == address(0)` → `ZeroAddress()`
  (исследование §13.5 — иначе `token == address($.token)` даст `false` и код уйдёт в
  ветку «прочие токены» с ревертом `balanceOf(address(0))`); затем расчёт `available`;
  `amount > available` → `InsufficientStuckFunds()`; затем `safeTransfer`. Все проверки —
  до внешнего вызова перевода.
- **Стиль доступа — инлайн `_getContractStorage()`** (как в `getMaxValidity`/`paymentClientToNative`),
  без локального `$`: функция небольшая, стековой нагрузки нет.
- **Расчёт `available` (открытый вопрос №2, см. §5):** для USDC (`token == address($.token)`)
  доступен избыток `balanceOf(this) - totalClientBalance`, с защитным ветвлением: при
  `totalClientBalance >= balanceOf(this)` (защитный случай, инвариант нарушен) `available = 0`.
  Для прочих токенов `available = balanceOf(this)` (весь баланс «случайный»).
- **Перевод токена:** параметр `token` имеет тип `address`, а директива
  `using SafeERC20 for IERC20WithAuthorization;` (`:34`) распространяет `safeTransfer` только на
  `IERC20WithAuthorization`. Поэтому используется **библиотечная форма**
  `SafeERC20.safeTransfer(IERC20(token), to, amount);` (не `IERC20(token).safeTransfer(...)`,
  которое не скомпилируется) — новых импортов не требуется (`SafeERC20`/`IERC20` уже импортированы).
- Событие `StuckFundsWithdrawn(token, to, amount)` — после успешного `safeTransfer`.

### 2.7 Новая функция `withdrawStuckNative`

Добавляется в конец контракта (после `withdrawStuckTokens`):

```solidity
function withdrawStuckNative(
    address payable to,
    uint256 amount
) external onlyOwner {
    if (amount == 0) revert ZeroAmount();
    if (to == address(0)) revert ZeroAddress();
    if (amount > address(this).balance) revert InsufficientStuckFunds();

    (bool success, ) = to.call{value: amount}("");
    if (!success) revert WithdrawalFailed();

    emit StuckFundsWithdrawn(address(0), to, amount);
}
```

Пояснения:
- **Порядок проверок (fail-fast):** `amount == 0` → `ZeroAmount()`; `to == address(0)` →
  `ZeroAddress()` (низкоуровневый `call` на нулевой адрес вернул бы `true` и средства сгорели
  бы — исследование §13.6); затем `amount > address(this).balance` → `InsufficientStuckFunds()`;
  затем `call`; проверка `success`.
- **`address(this).balance` = баланс прокси.** Функция вызывается через `delegatecall` из
  `SettelmentsControlProxy` — контекст исполнения (включая `address(this)`) остаётся прокси,
  где физически лежит POL от `selfdestruct` (исследование §5). Прокси не меняется.
- **Низкоуровневый `call{value: amount}("")`** — по замыслу PRD; `Address.sendValue` не
  используется (не импортирован), новых импортов не требуется.
- **Reentrancy не актуальна:** функции вывода не меняют storage (тотал/балансы не трогаются),
  единственный эффект — внешний перевод; после внешнего вызова нет чтений/записей состояния.
  Вводить `nonReentrant` (и `ReentrancyGuard`-наследование) не нужно.
- Событие `StuckFundsWithdrawn(address(0), to, amount)` — `token = address(0)` маркирует вывод POL.

### 2.8 Геттер `getTotalClientBalance()`

Добавляется рядом с другими геттерами (после `getFeeConfig`, `:499`):

```solidity
function getTotalClientBalance() external view returns (uint256) {
    return _getContractStorage().totalClientBalance;
}
```

Только чтение — для off-chain мониторинга/сверки тотала с реальным балансом USDC
(избыток = `balanceOf(this) - totalClientBalance`).

---

## 3. Data flows

### 3.1 Инвариант `totalClientBalance == Σ clientBalances`

```
topUpClientBalance(value):
    clientBalance.balance += value   →   $.totalClientBalance += value   (та же точка)

paymentClientToNative(amount):
    _getContractStorage().clientBalances[clientHash].balance -= amount
    _getContractStorage().totalClientBalance -= amount   (соседняя строка, инлайн)

backFundsToClient(amount):
    balance.balance = currentBalance - amount
    $.totalClientBalance -= amount   (та же точка)
```

Тотал меняется на **ровно ту же величину** и **в той же точке**, что и баланс клиента;
`value`/`amount` в трёх функциях совпадают с изменением `clientBalances[hash].balance`.

### 3.2 `withdrawStuckTokens`

```
withdrawStuckTokens(token, to, amount) external onlyOwner
        ▼
[1] to == address(0)      ? → revert ZeroAddress()
[2] token == address(0)   ? → revert ZeroAddress()
[3] contractBalance = IERC20(token).balanceOf(address(this))
[4] available = (token == address($.token))
                 ? (contractBalance > $.totalClientBalance ? contractBalance - $.totalClientBalance : 0)
                 : contractBalance
[5] amount > available    ? → revert InsufficientStuckFunds()
[6] SafeERC20.safeTransfer(IERC20(token), to, amount)
[7] emit StuckFundsWithdrawn(token, to, amount)
```

### 3.3 `withdrawStuckNative`

```
withdrawStuckNative(to, amount) external onlyOwner
        ▼
[1] to == address(0)        ? → revert ZeroAddress()
[2] amount > address(this).balance ? → revert InsufficientStuckFunds()
[3] (success, ) = to.call{value: amount}("")
[4] !success                ? → revert WithdrawalFailed()
[5] emit StuckFundsWithdrawn(address(0), to, amount)
```

---

## 4. NFR (нефункциональные требования)

1. **Чистая компиляция без `viaIR`:** `rm -rf artifacts cache && npx hardhat compile` → exit 0.
   Solidity `0.8.28`, optimizer `enabled: true, runs: 1000`, `viaIR` выключен (конфиг не меняется).
2. **`STORAGE_LOCATION` не меняется** (`0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`).
   Новое поле — только внутри `ContractStorage`, в конец; существующие слоты не сдвигаются.
3. **Новых state-переменных верхнего уровня нет.** Единственное новое персистентное поле —
   `ContractStorage.totalClientBalance` (доступ через `_getContractStorage()`).
4. **Stack too deep:** `withdrawStuckTokens` использует 3 локальные переменные
   (`$`, `contractBalance`, `available`), `withdrawStuckNative` — 2 (`success`, `to`-параметр);
   давление на стек низкое. Риск повторения исторической находки C-01 (Stack too deep) минимален.
5. **Стиль:** только custom errors (`if (...) revert Xxx()`), без строковых `require`;
   событие эмитится после успешной мутации (паттерн контракта).

---

## 5. Trade-off (явно зафиксирован)

1. **Изменение ABI — additive.** Новое поле структуры, 2 функции, событие `StuckFundsWithdrawn`,
   ошибки `InsufficientStuckFunds`/`WithdrawalFailed`. Селекторы существующих функций не меняются.
   **Допустимо:** прод не развёрнут (PRD §«Ограничения»). Потребители (`test/`, `scripts/deploy.ts`,
   `thegraph/`) **вне скоупа** (синхронизация — I-03).
2. **Защитный случай `totalClientBalance > balanceOf(this)` — считаем `available = 0`, а не
   полагаемся только на инвариант.** Выбор: явное ветвление `if (contractBalance > total) available = ...
   else available = 0` вместо «голого» `balanceOf - totalClientBalance` (которое ревертится на
   underflow в 0.8) и вместо «гарантии инварианта» (которую нельзя доказать статически). Цена —
   одна дополнительная ветка и локальная переменная; выгода — вывод USDC не ревертится неожиданным
   underflow, а безопасно «замораживается» (available = 0), не давая владельцу снять средства
   клиентов при рассинхроне учёта.
3. **Инлайн-доступ к хранилищу в `paymentClientToNative` (без локального `$`).** Тотал
   обновляется вторым инлайн-вызовом `_getContractStorage().totalClientBalance -= amount;`
   рядом со списанием баланса. Локальный `$` не вводится: в SC-1 он был убран именно для
   устранения `Stack too deep`; соседство двух инлайн-строк обеспечивает синхронность
   (ключевой риск §6.1).
4. **Одно событие `StuckFundsWithdrawn` вместо двух** (`StuckTokensWithdrawn`/`StuckNativeWithdrawn`).
   Различение POL/токена — по `token == address(0)`. Цена — незначительная неоднозначность поля
   (семантика «нулевой token = нативный вывод» должна быть задокументирована); выгода — меньший ABI,
   единая точка индексации в будущем сабграфе.
5. **`WithdrawalFailed()` как вторая новая ошибка.** Скоуп декларировал «единую ошибку
   `InsufficientStuckFunds()`» — она сохраняется для проверки баланса; вторая ошибка нужна строго
   для неуспешного низкоуровневого `call` (иначе пришлось бы маскировать её тем же
   `InsufficientStuckFunds()` или строковым `require`). Осознанное расширение скоупа одной ошибкой.
6. **Без `nonReentrant`.** Функции вывода не мутируют storage и не читают его после внешнего
   вызова; reentrancy-вектора нет. Наследование `ReentrancyGuard` не вводится.

---

## 6. Risks

1. **Рассинхрон `totalClientBalance` с суммой `clientBalances` (ключевой).** Если пропустить
   обновление тотала хотя бы в одной из трёх функций (`:212`, `:301`, `:341`), инвариант нарушится:
   заниженный тотал позволит владельцу вывести средства клиентов как «избыток» USDC; завышенный —
   заблокирует вывод. Митигация: обновление **в той же точке**, что и баланс клиента (§2.3–2.5),
   и соседние строки в `paymentClientToNative`.
2. **Underflow `balanceOf(this) - totalClientBalance`.** Снят защитным ветвлением `available = 0`
   (§2.6, §5.2). Solidity 0.8 ревертится на underflow, но явная ветка делает поведение
   предсказуемым и безопасным.
3. **Вывод POL в ноль / сгоревшие средства.** Низкоуровневый `call` на `address(0)` вернул бы
   `true` — средства сгорели бы. Митигация: проверка `to != address(0)` → `ZeroAddress()` первой
   строкой `withdrawStuckNative`.
4. **Инлайн-доступ в `paymentClientToNative`.** Тотал обновляется вторым инлайн-вызовом
   `_getContractStorage().totalClientBalance -= amount;` рядом со списанием баланса — без
   возврата локального `$` (иначе рискуем `Stack too deep`, как в SC-1). Синхронность
   обеспечивается соседством строк (§2.5).
5. **Неконсистентность потребителей ABI.** `test/`, `scripts/deploy.ts`, `thegraph/` останутся
   несинхронными (новые селекторы функций/ошибок/события). Митигация: осознанно вынесено в I-03,
   вне скоупа SC-6.
6. **Ошибки именования.** `InsufficientStuckFunds`/`WithdrawalFailed`/`StuckFundsWithdrawn` должны
   быть введены в точности (регистр, сигнатура) — иначе селекторы off-chain не сматчатся. Имена
   сверены с исследованием (§7, §13), коллизий нет.
7. **POL на балансе самой имплементации.** Если POL зачислится напрямую на имплементацию (прямой
   вызов), `withdrawStuckNative` через прокси его не увидит. Митигация: имплементация защищена
   `constructor() { _disableInitializers(); }` и не должна получать средств напрямую (исследование §5.2).

---

## 7. ADR (развилки)

Значимых архитектурных развилок нет — ADR **не создаётся**. Все открытые вопросы PRD закрыты
решениями этого плана: имя ошибки (§2.2 — единая `InsufficientStuckFunds` + `WithdrawalFailed`),
защитный underflow (§2.6/§5.2 — `available = 0`), стиль доступа в `paymentClientToNative`
(§2.5 — инлайн-вызовы, без локального `$`), событие вывода (§2.2 — одно `StuckFundsWithdrawn`), проверка
`token == address(0)` (§2.6), `to != address(0)` в нативной функции (§2.7), порядок проверок
(§2.6/§2.7). Это локальные имплементационные решения, не требующие отдельного ADR (прецедент SC-5).

---

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `viaIR` (optimizer `runs=1000`,
  Solidity `0.8.28`).
- В `ContractStorage` присутствует `uint256 totalClientBalance;` (в конец); новых
  state-переменных верхнего уровня нет; `STORAGE_LOCATION` не изменён.
- `totalClientBalance` обновляется в трёх точках: `topUpClientBalance` (`+= value`),
  `paymentClientToNative` (`-= amount`), `backFundsToClient` (`-= amount`) — в той же точке, что
  и баланс клиента.
- `withdrawStuckTokens(token, to, amount) external onlyOwner`: `to == address(0)`/`token == address(0)`
  → `ZeroAddress()`; USDC — `available = balanceOf - totalClientBalance` (с защитой `available = 0`),
  прочие токены — `available = balanceOf`; `amount > available` → `InsufficientStuckFunds()`;
  `SafeERC20.safeTransfer(IERC20(token), to, amount)`; `emit StuckFundsWithdrawn(token, to, amount)`.
- `withdrawStuckNative(to, amount) external onlyOwner`: `to == address(0)` → `ZeroAddress()`;
  `amount > address(this).balance` → `InsufficientStuckFunds()`; низкоуровневый
  `call{value: amount}("")` с проверкой `success` → `WithdrawalFailed()`; `emit StuckFundsWithdrawn(address(0), to, amount)`.
- В блоке ошибок присутствуют `InsufficientStuckFunds()` и `WithdrawalFailed()`; в блоке событий —
  `StuckFundsWithdrawn(address token, address to, uint256 amount)`.
- `test/`, `scripts/deploy.ts`, `thegraph/` — вне скоупа и не являются критерием приёмки.

---

## 9. Open questions

- **Нет блокирующих.** Неблокирующие (вне скоупа SC-6, отдельные задачи):
  - синхронизация `test/`, `scripts/deploy.ts`, `thegraph/` с обновлённым ABI (I-03 и связанные);
  - добавление handler/сущности для `StuckFundsWithdrawn` в сабграфе — при необходимости, отдельная
    задача (в SC-6 сабграф не меняется, событие просто не индексируется);
  - существующая опечатка `reciever` в событии `BackFundsToClient` (`:63`) — вне скоупа, не трогаем.
