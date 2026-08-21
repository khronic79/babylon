# SC-6: Техническое исследование — вывод ошибочно переведённых средств (I-05)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-6.prd.md` (Status: PRD_READY)
Аудит (источник находки I-05): `docs/audit-reports/2026-08-20.md:398-405`
Активный тикет: `docs/.active_ticket` → `SC-6`

> **Обратите внимание на актуальную нумерацию строк.** PRD и некоторые формулировки
> замысла ссылаются на `ContractStorage` как на `:107-117` — это **устаревшая**
> нумерация (до добавления `maxValidity` в SC-4). В текущем файле структура
> находится на `:110-120` (поле `maxValidity` — `:119`). Все ссылки ниже — по
> текущему состоянию рабочего дерева (после SC-1…SC-5).

## Резюме

Тикет закрывает информационную находку I-05: добавляет владельцу (`owner`) контракта
возможность выводить случайно застрявшие токены и нативный POL. Логика полностью
локализована в `contracts/SettelmentsControl.sol` (upgradeable-реализация с ручным
слотом EIP-7201 `ContractStorage`):

1. Новое поле `uint256 totalClientBalance` в конце `ContractStorage` (счётчик суммы
   всех балансов клиентов). Обновляется в **трёх** точках изменения баланса клиента.
2. `withdrawStuckTokens(address token, address to, uint256 amount) external onlyOwner`:
   для USDC (`token == address($.token)`) доступно только
   `balanceOf(this) - totalClientBalance`, для прочих токенов — весь `balanceOf(this)`.
3. `withdrawStuckNative(address payable to, uint256 amount) external onlyOwner`:
   вывод `address(this).balance` низкоуровневым `call{value: amount}("")`.

Все необходимые примитивы уже доступны: `SafeERC20`/`IERC20` импортированы
(`:4-7`), `onlyOwner` существует и работает (`:145-151`), ошибка `ZeroAddress()`
уже объявлена (`:98`). Единственное новое имя ошибки — `InsufficientStuckFunds()`.
Прокси `contracts/SettelmentsControlProxy.sol` **не меняется** (вывод POL делается
через `delegatecall` в реализации).

---

## 1. Связанные модули/контракты

| Модуль | Файл | Роль в задаче |
| --- | --- | --- |
| Реализация логики расчётов | `contracts/SettelmentsControl.sol` | **Единственный изменяемый файл.** Поле `totalClientBalance` в `ContractStorage` + две новые `onlyOwner`-функции + новая ошибка + три точки обновления тотала. |
| ERC1967-прокси | `contracts/SettelmentsControlProxy.sol` | **Не меняется.** `receive()` ревертит (`:50-52`), но POL, зачисленный через `selfdestruct`, лежит на балансе прокси и выводится функцией реализации через `delegatecall` (см. §5). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Вне скоупа (реализует EIP-3009, SC-4). Используется тестами/deploy-скриптом. |
| Тесты Hardhat | `test/SettelmentsControl.ts`, `test/SettelmentsControlProxy.ts` | Потребители ABI; **не меняются** (I-03). Уже неконсистентны, ссылаются на удалённые `withdrawTokens`/`withdrawFundsToNative` (см. §8). |
| Деплой-скрипт | `scripts/deploy.ts` | Потребитель ABI; **не меняется**. Уже передаёт неверное число аргументов в `initialize` (`:111-116`). |
| Сабграф The Graph | `thegraph/` (`subgraph.yaml`, `schema.graphql`, `abis/SettelmentsControl.json`, `src/settelments-control.ts`) | Потребитель ABI/событий; **не меняется**. События вывода в контракте нет (см. §8, открытые вопросы). |
| Компилятор | `hardhat.config.ts` | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` выключен (см. §7). |
| Зависимости | `@openzeppelin/contracts@^5.3.0`, `@openzeppelin/contracts-upgradeable@^5.3.0` (`package.json:20-26`) | `IERC20`+`SafeERC20` (токены), `Initializable`+`EIP712Upgradeable` (upgradeable-паттерн). |

**Вывод по скоупу:** меняется только `contracts/SettelmentsControl.sol`. Прокси и все
off-chain потребители (тесты, deploy-скрипт, сабграф) — вне скоупа; их синхронизация —
отдельная задача (находка I-03).

---

## 2. Точки обновления `totalClientBalance` (три функции)

### 2.1 `topUpClientBalance` — `contracts/SettelmentsControl.sol:183-221`

`external onlyAdmin` (`:193`). Обращается к хранилищу через **локальный** указатель:

```solidity
ContractStorage storage $ = _getContractStorage();           // :194
ClientBalance storage clientBalance = $.clientBalances[
    keccak256(abi.encodePacked(userId))
];                                                            // :196-198
$.token.receiveWithAuthorization(from, address(this), value, ...); // :200-210
clientBalance.balance += value;                               // :212
clientBalance.lastInboundAddress = from;                      // :213
emit TopUpClientBalance(userId, value, clientBalance.balance, from); // :215-220
```

- USDC поступает на контракт через `$.token.receiveWithAuthorization(...)` (`:200-210`) —
  средства зачисляются на `address(this)`, а баланс клиента растёт на `value` в `:212`.
- **Точка добавления `$.totalClientBalance += value;`** — сразу после
  `clientBalance.balance += value;` (`:212`), до `emit` (`:215`). Здесь `$` уже
  локальный, дополнительных чтений хранилища не требуется.

### 2.2 `paymentClientToNative` — `contracts/SettelmentsControl.sol:256-304`

`external onlyAdmin` (`:263`). **Важно:** в этой функции **нет локального `$`** — она
читает/пишет хранилище **инлайн-вызовами** `_getContractStorage()`:

```solidity
if (amount == 0) revert ZeroAmount();                        // :264
SettelmentContext memory ctx = _buildSettelmentContext(...); // :268-275
if (ctx.nativeAddress == address(0)) { ... }                 // :277-279
if (ctx.clientBalance < amount) { ... }                      // :281-283
IERC20WithAuthorization token = _getContractStorage().token; // :285 (инлайн)
uint256 contractBalance = token.balanceOf(address(this));    // :287
if (contractBalance < amount) { ... }                        // :289-291
if (ctx.amountToNative > 0) token.safeTransfer(...);         // :293-295
if (ctx.feeAmount > 0) token.safeTransfer(...);              // :297-299
_getContractStorage().clientBalances[clientHash].balance -= amount; // :301 (инлайн)
emit PaymentClientToNative(ctx);                             // :303
```

- Баланс клиента списывается в `:301` через **инлайн**
  `_getContractStorage().clientBalances[clientHash].balance -= amount;`.
- **Точка добавления `-= amount`:** сразу после `:301` (в той же точке списания).
  Два эквивалентных способа:
  1. `_getContractStorage().totalClientBalance -= amount;` (инлайн, в стиле `:301`),
  2. либо ввести локальный `ContractStorage storage $ = _getContractStorage();` в
     начале функции и писать `$.totalClientBalance -= amount;`.
  Рекомендация — согласовать с планом, но **не** смешивать: если тотал обновляется
  инлайн, то и списание баланса должно быть в том же выражении/блоке, чтобы исключить
  рассинхрон. См. открытый вопрос №3.

### 2.3 `backFundsToClient` — `contracts/SettelmentsControl.sol:306-344`

`external onlyAdmin` (`:309`). Использует **локальный** `$` и локальный указатель
`balance`:

```solidity
if (amount == 0) revert ZeroAmount();                        // :310
ContractStorage storage $ = _getContractStorage();           // :311
ClientBalance storage balance = $.clientBalances[
    keccak256(abi.encodePacked(userId))
];                                                            // :312-314
address lastAddress = balance.lastInboundAddress;             // :315
uint256 currentBalance = balance.balance;                     // :316
if (currentBalance < amount) { ... }                          // :317-324
IERC20WithAuthorization token = $.token;                      // :326
uint256 contractBalance = token.balanceOf(address(this));     // :328
if (contractBalance < amount) { ... }                         // :330-337
token.safeTransfer(lastAddress, amount);                      // :339
balance.balance = currentBalance - amount;                    // :341
emit BackFundsToClient(userId, lastAddress, amount);          // :343
```

- Баланс клиента уменьшается в `:341` (`balance.balance = currentBalance - amount`).
- **Точка добавления `$.totalClientBalance -= amount;`** — сразу после `:341`, до
  `emit` (`:343`). Здесь `$` уже локальный.

### 2.4 Итог по точкам вставки

| Функция | Строка обновления баланса клиента | Строка вставки тотала |
| --- | --- | --- |
| `topUpClientBalance` | `:212` (`clientBalance.balance += value`) | после `:212` → `$.totalClientBalance += value;` |
| `paymentClientToNative` | `:301` (инлайн списание) | после `:301` → `-= amount` |
| `backFundsToClient` | `:341` (`balance.balance = currentBalance - amount`) | после `:341` → `$.totalClientBalance -= amount;` |

Во всех трёх случаях `value`/`amount` — это ровно та величина, на которую меняется
`clientBalances[hash].balance`, поэтому инвариант `totalClientBalance == Σ
clientBalances` поддерживается симметрично.

---

## 3. `ContractStorage` — куда добавить поле

Текущая структура — `contracts/SettelmentsControl.sol:110-120`:

```solidity
struct ContractStorage {
    mapping(bytes32 => ClientBalance) clientBalances;   // :111
    mapping(bytes32 => address) nativeAddresses;        // :112
    mapping(bytes32 => bool) usedNonces;                // :113
    IERC20WithAuthorization token;                      // :114
    address admin;                                      // :115
    address owner;                                      // :116
    uint256 feePercentage;                              // :117
    address feeCollector;                               // :118
    uint256 maxValidity;                                // :119
}                                                        // :120
```

**Поле `uint256 totalClientBalance;` добавляется в конец структуры — после `:119`
(`maxValidity`), перед закрывающей скобкой `:120`.** Это **безопасно** для
upgradeable-хранилища: добавление в конец не сдвигает существующие слоты полей
(первые поля — `mapping`, следующие — скаляры; новый скаляр займёт следующий
свободный слот внутри namespace `STORAGE_LOCATION`).

- **Запрещено** добавлять state-переменную верхнего уровня — только внутрь
  `ContractStorage` (ручной слот EIP-7201, `AGENTS.md`).
- `STORAGE_LOCATION` (`:101-103`) не перегенерируется. Текущее значение (регенерировано
  в SC-5 из корректной строки `"SettelmentsControl.storage"`):
  `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00` (`:102-103`).
- Доступ к хранилищу — через `_getContractStorage()` (`:126-135`, assembly
  `$.slot := STORAGE_LOCATION`). Новое поле автоматически доступно как
  `$.totalClientBalance`.

---

## 4. Как контракт узнаёт адрес USDC (`$.token`)

- Поле хранилища: `IERC20WithAuthorization token;` — `:114` (тип объявлен `:18-30`,
  расширяет `IERC20`).
- Устанавливается один раз в `initialize`: `$.token = IERC20WithAuthorization(_token);` (`:173`).
- Проверка «это USDC» в `withdrawStuckTokens`: сравнение адресов
  `token == address($.token)` — `$.token` (тип `IERC20WithAuthorization`, т.е.
  контракт-тип) явно приводится к `address`. Других маркеров USDC в контракте нет —
  единственный канонический признак «наш расчётный токен» это поле `$.token`.
- Для вычисления доступной суммы USDC используется `token.balanceOf(address(this))`
  (`IERC20.balanceOf`, импорт `:4`), минус `totalClientBalance`.

---

## 5. Вывод нативного POL и прокси

### 5.1 Прокси

`contracts/SettelmentsControlProxy.sol:49-52`:

```solidity
// Запрет на передачу ether
receive() external payable {
    revert NotAcceptEtherDirectly();
}
```

- Обычный `transfer`/`send` POL на прокси ревертится (`NotAcceptEtherDirectly`).
- **`selfdestruct` (и принудительная отправка `value`)** обходит `receive()` и
  зачисляет POL **на адрес прокси** — эти средства физически лежат на балансе
  адреса прокси, а не на адресе реализации.

### 5.2 Почему вывод делается в реализации через `delegatecall`

- Все вызовы к логике идут через прокси как `delegatecall` — контекст исполнения
  (включая `address(this)`) остаётся **прокси**.
- Поэтому в функции реализации `withdrawStuckNative` выражение
  `address(this).balance` возвращает **баланс прокси** (именно там лежит POL от
  `selfdestruct`). Низкоуровневый `call{value: amount}("")` отправит средства именно
  с баланса прокси.
- **Прокси менять не нужно**: отдельная функция вывода POL в самом прокси не требуется.
  Реализация в прокси остаётся ревертящей для обычных переводов (сохраняется
  инвариант «не принимать ETH напрямую»), а «принудительный» POL выводится через
  `delegatecall`-функцию реализации.
- Реализация сама по себе не должна получать POL напрямую: `constructor()` вызывает
  `_disableInitializers()` (`:122-124`), что блокирует её самостоятельное использование.

### 5.3 Импорты для вывода POL

- `Address` из OpenZeppelin (`Address.sendValue`) **не импортирован** (импорты:
  `:4-16`). PRD замысла предписывает **низкоуровневый `call{value: amount}("")`** —
  он не требует новых импортов. (Либо, как альтернатива, добавить
  `import {Address} from "@openzeppelin/contracts/utils/Address.sol";` и использовать
  `Address.sendValue` — решение за планом; низкоуровневый `call` уже согласован в PRD.)

---

## 6. Импорты и доступные примитивы для вывода токенов

`contracts/SettelmentsControl.sol:4-16`:

```solidity
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";       // :4
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol"; // :5-7
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol"; // :8-10
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol"; // :11-13
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";  // :14-16
```

- `using SafeERC20 for IERC20WithAuthorization;` — `:34`.
- **`IERC20` доступен** (`:4`) → `balanceOf(address(this))` работает для `address token`
  (после приведения/через `IERC20(token)`).
- **`SafeERC20` доступен** (`:5-7`) → `safeTransfer` доступен. `safeTransfer` для
  `address token` вызывается как `IERC20(token).safeTransfer(to, amount)` (функция
  `safeTransfer` — член `IERC20` в OZ v5, см. текущее использование
  `token.safeTransfer(...)` в `:294`, `:298`, `:339`).
- `Address` **не импортирован** (см. §5.3).

Итого: для `withdrawStuckTokens` новых импортов не требуется; для
`withdrawStuckNative` — тоже (если использовать низкоуровневый `call`).

---

## 7. Ошибки — существующие и новая

Текущий блок ошибок — `contracts/SettelmentsControl.sol:68-99`:

```solidity
error OnlyAdmin();                                    // :68
error OnlyOwner();                                    // :69
error InsufficientClientBalanceForSessionSettelment(SettelmentContext ctx); // :70
error NativeAddressIsOutForSessionSettelment(SettelmentContext ctx);       // :71
error InsufficientContractBalanceForSessionSettelment(SettelmentContext ctx); // :72
error InsufficientClientBalanceForBackFunds(string clientId, address clientAddress, uint256 amount, uint256 clientBalance); // :74-79
error InsufficientContractBalanceForBackFunds(string clientId, address clientAddress, uint256 amount, uint256 clientBalance); // :81-86
error InvalidSignature();                             // :87
error NonceAlreadyUsed();                             // :88
error InvalidNativeAddress();                         // :89
error EmptyNativeId();                                // :90
error EmptyNonce();                                   // :91
error FeeTooHigh(uint256 feePercentage);              // :92
error InvalidFeeCollector();                          // :93
error SignatureExpired();                             // :94
error DeadlineTooFar();                               // :95
error InvalidMaxValidity();                           // :96
error InvalidAdmin();                                 // :97
error ZeroAddress();                                  // :98
error ZeroAmount();                                   // :99
```

- **`ZeroAddress()`** (`:98`) — уже существует (введена в SC-5), используется для
  проверки `to != address(0)` в `withdrawStuckTokens`/`withdrawStuckNative` (и
  `token == address(0)` при желании).
- **`OnlyOwner()`** (`:69`) — уже существует; модификатор `onlyOwner` (`:145-151`)
  читает `$.owner` и ревертит именно этой ошибкой.
- **Новая ошибка** `InsufficientStuckFunds()` — без аргументов, в стиле
  `ZeroAddress()`/`ZeroAmount()`/`InvalidFeeCollector()`. Рекомендуемое место —
  рядом с валидационными ошибками, например после `ZeroAmount()` (`:99`) или после
  `InvalidFeeCollector()` (`:93`). Имя `InsufficientStuckFunds` в коде **не занято**
  (коллизий нет). PRD допускает альтернативу — раздельные
  `InsufficientStuckTokens()`/`InsufficientStuckNative()` (открытый вопрос №1).

---

## 8. Потребители ABI, которые станут неконсистентны (вне скоупа, I-03)

Изменения ABI в SC-6 — **additive**: новые функции `withdrawStuckTokens` /
`withdrawStuckNative`, новая ошибка `InsufficientStuckFunds`, новое поле в storage
(в ABI структура `ContractStorage` не экспортируется, т.к. она `private`-доступна
только внутри). Селекторы существующих функций не меняются.

- **`test/SettelmentsControl.ts`** — уже не соответствует ABI (I-03): `initialize` с
  2 аргументами (`:37`), `topUpClientBalance(amount, userId)` (`:67`),
  `.withdrawTokens(...)` (`:300`, `:313`) — функции в контракте **нет**,
  `withdrawFundsToNative` (`:185`, `:206`, `:222`) — тоже удалена, структура
  `getBalance().clientBalance/.nativeBalance` (`:73-74`, `:118-124`, `:191-192`,
  `:253-254`) устарела. Тесты ссылаются на старый `withdrawTokens` — его роль теперь
  будет выполнять `withdrawStuckTokens`, но с другой сигнатурой/семантикой.
- **`test/SettelmentsControlProxy.ts`** — аналогично: `initialize(token, admin)`
  (`:46`), `withdrawTokens` (`:356`, `:369`), `withdrawFundsToNative` (`:252`,
  `:274`, `:285`), старые `.clientBalance/.nativeBalance`. Также тест «Should reject
  direct ETH transfers» (`:119-131`) проверяет `NotAcceptEtherDirectly` — поведение
  прокси не меняется (SC-6 его не трогает).
- **`scripts/deploy.ts`** — `initialize` с 2 аргументами `[erc20Address, account.address]`
  (`:115`); новые функции вывода скрипт не вызывает. Уже неконсистентен (H-02/I-03).
- **`thegraph/`** — см. §9. События вывода нет → сабграф ничего индексировать по
  выводу не будет. ABI в `thegraph/abis/SettelmentsControl.json` устареет (нужен
  `yarn codegen` после перегенерации — отдельная задача).

**Синхронизация перечисленного — отдельная задача (находка I-03; вынесена из SC-6).**

---

## 9. Сабграф The Graph (для контекста, вне скоупа)

- `thegraph/subgraph.yaml:29-43` — `eventHandlers`: `BackFundsToClient`,
  `BalanceUpdated`, `ChangeAdmin`, `Initialized`, `PaymentClientToNative`,
  `TopUpClientBalance`, `WithdrawFundsToNative`. Последние три (`BalanceUpdated`,
  `WithdrawFundsToNative`, часть полей) — от **старых** версий контракта; в текущем
  `.sol` события `BalanceUpdated`/`WithdrawFundsToNative` **отсутствуют**.
- `thegraph/schema.graphql:62-70` — сущность `WithdrawFundsToNative` (старое событие).
- `thegraph/src/settelments-control.ts:201-234` — `handleWithdrawFundsToNative`.
- `thegraph/abis/SettelmentsControl.json` — сгенерированный ABI, уже устарел
  (нет `SettelmentContext`-события/ошибок текущего контракта).
- Адрес `0x51de3ac5b5cdf4496c5b793a98b1a103e6675386` и `startBlock: 22033296`
  продублированы в `thegraph/subgraph.yaml:11,13` и `thegraph/networks.json:4,5`.

**В контракте сейчас нет события «вывод средств».** Если по итогам SC-6 захочет
эмититься событие вывода (например, `StuckTokensWithdrawn(address token, address to, uint256 amount)`
/ `StuckNativeWithdrawn(address to, uint256 amount)`), это (а) упростит будущую
индексацию в сабграфе, (б) станет ещё одним additive-изменением ABI. Решение о
событии — на этапе планирования (открытый вопрос №4), в замысле PRD событие не
фигурирует.

---

## 10. Компилятор (`hardhat.config.ts`)

`hardhat.config.ts:8-16`:

```ts
solidity: {
  version: "0.8.28",
  settings: {
    optimizer: { enabled: true, runs: 1000 },
  },
}
```

- Solidity `0.8.28`, optimizer `runs=1000`, **`viaIR` не задан** (выключен).
- **Критерий успеха:** `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `viaIR`.
- Изменения тикета — простые скалярные операции и два перевода; введения новых
  многоаргументных ошибок/событий нет (новая ошибка без аргументов). Риск повторения
  «Stack too deep» (историческая находка C-01, устранена в SC-1) низкий.
- Валидация выполняется на чистом кэше (артефакты в `artifacts/`/`cache/` могут быть
  устаревшими и маскировать ошибки).

---

## 11. Используемые паттерны

1. **EIP-7201 (namespaced storage).** Всё персистентное состояние — в `ContractStorage`
   (`:110-120`), доступ через `_getContractStorage()` (`:126-135`, assembly
   `$.slot := STORAGE_LOCATION`). Новое поле — только внутрь структуры, в конец.
2. **Upgradeable-паттерн.** `Initializable` + `initializer` (`:153-181`),
   `constructor() { _disableInitializers(); }` (`:122-124`); вызовы идут через
   ERC1967Proxy (`SettelmentsControlProxy`).
3. **`SafeERC20` для токенов.** `using SafeERC20 for IERC20WithAuthorization` (`:34`);
   переводы через `token.safeTransfer(...)` (`:294`, `:298`, `:339`). Для
   `withdrawStuckTokens` — аналогично `safeTransfer` по `IERC20(token)`.
4. **Низкоуровневый `call` для нативного POL** (по замыслу PRD) — с проверкой успеха
   (`if (!success) revert ...`); `Address.sendValue` не используется (не импортирован).
5. **Custom errors** — `error Xxx(...)` + `if (...) revert Xxx(...)`; без строковых
   `require` (все `require` уже заменены на custom errors в SC-5). Новая ошибка —
   без аргументов, в стиле `ZeroAddress()`/`ZeroAmount()`.
6. **`onlyOwner` для управленческих действий.** Вывод средств — управленческая роль
   `owner` (согласуется с SC-5: `setFeeConfig` тоже переведён на `onlyOwner`).
   Модификатор `onlyOwner` — `:145-151`.

---

## 12. Ограничения и риски

1. **Рассинхрон `totalClientBalance` с суммой `clientBalances` (ключевой риск).**
   Если тотал обновится не во всех трёх точках (`:212`, `:301`, `:341`), инвариант
   нарушится: заниженный тотал позволит владельцу вывести средства клиентов как
   «избыток» USDC; завышенный — заблокирует вывод или даст underflow. Митигация:
   обновление тотала **строго в той же точке**, что и баланс клиента.
2. **Underflow `balanceOf(this) - totalClientBalance`** при
   `totalClientBalance > balanceOf(this)`. Solidity 0.8 ревертится на underflow —
   нужна явная проверка/подстраховка (открытый вопрос №2). Ситуация возможна, если
   `backFundsToClient`/`paymentClientToNative` в какой-то момент переведут больше,
   чем тотал (или при «случайном» поступлении USDC мимо `topUpClientBalance`).
3. **Смешение стилей доступа к хранилищу в `paymentClientToNative`.** Функция не
   имеет локального `$` и пишет хранилище инлайн (`:285`, `:301`). При добавлении
   `-= amount` важно не создать «висящий» инлайн-доступ, который можно забыть
   синхронизировать. Рекомендуется либо единый инлайн-стиль, либо ввести локальный `$`
   (открытый вопрос №3).
4. **Изменение ABI (additive).** Новые функции/ошибка ломают off-chain потребителей
   (тесты, deploy-скрипт, сабграф) — осознанно, обвязка вне скоупа (I-03). Продукт не
   в проде — допустимо.
5. **Reentrancy на `withdrawStuckNative`.** Низкоуровневый `call` к `to` без
   ограничения газа/данных может вернуться с reentrancy. Митигируется минимальностью
   функции (state не меняется после внешнего вызова; новых внешних вызовов нет).
   При необходимости рассмотреть `nonReentrant` (PRD §Риски) — решение на плане.
6. **Вывод POL только с баланса прокси.** Если POL окажется на балансе самой
   реализации (прямой вызов), он останется недоступным; но реализация защищена
   `_disableInitializers()` и не должна получать средств напрямую.
7. **Не добавлять state-переменные верхнего уровня** и **не перегенерировать
   `STORAGE_LOCATION`** — иначе конфликт раскладки хранилища прокси/структуры.
8. **Опечатка `reciever`** в событии `BackFundsToClient` (`:63`) и соответствующих
   полях — существующая, вне скоупа SC-6 (не трогаем).

---

## 13. Открытые технические вопросы

1. **Имя ошибки «недостаточно средств».** Единая `InsufficientStuckFunds()` (по
   умолчанию в замысле) либо раздельные `InsufficientStuckTokens()` /
   `InsufficientStuckNative()`. Обе без аргументов; коллизий имён нет.
2. **Защитный случай `totalClientBalance > balanceOf(this)`.** Нужна ли явная
   проверка/`max(0, ...)`-подстраховка перед `balanceOf(this) - totalClientBalance`
   в `withdrawStuckTokens` для USDC (иначе underflow ревертится в Solidity 0.8), или
   считать инвариант `totalClientBalance ≤ balanceOf(this)` достаточной гарантией.
3. **Стиль обновления тотала в `paymentClientToNative`.** Подтвердить: инлайн
   `_getContractStorage().totalClientBalance -= amount;` (в стиле существующего `:301`)
   либо ввести локальный `$` в функции. Главное — обновлять строго в той же точке,
   что и `clientBalances[clientHash].balance`.
4. **Эмитить ли событие вывода.** В контракте нет события для `withdrawStuckTokens` /
   `withdrawStuckNative`; сабграф (вне скоупа) имеет мёртвый обработчик
   `WithdrawFundsToNative`. Нужно ли добавить новые события (например,
   `StuckTokensWithdrawn(address token, address to, uint256 amount)` и
   `StuckNativeWithdrawn(address to, uint256 amount)`) — улучшит будущую индексацию,
   но расширит ABI. В замысле PRD события нет.
5. **Проверка `token == address(0)` в `withdrawStuckTokens`.** Помимо `to != address(0)`,
   проверять ли сам адрес токена на ноль (`ZeroAddress()`)? (Сравнение с `address($.token)`
   при нулевом `token` даст false и пойдёт по ветке «прочие токены»; вызов
   `balanceOf(address(0))` ревертится. Явная проверка нагляднее.)
6. **`withdrawStuckNative` и проверка `to != address(0)`.** Для `address payable to`
   также нужна проверка `to != address(0)` → `ZeroAddress()` (низкоуровневый `call`
   на нулевой адрес вернёт `true`, средства сгорят). Зафиксировать в плане.
7. **Порядок проверок в `withdrawStuckTokens`.** Очевидно: сначала `to != address(0)`,
   затем расчёт `available`, затем `amount > available` → `InsufficientStuckFunds()`,
   затем `safeTransfer`. Подтвердить порядок, чтобы ошибки срабатывали предсказуемо.

---

## 14. Источники

- `docs/prd/SC-6.prd.md` — принятые решения и скоуп.
- `docs/audit-reports/2026-08-20.md:398-405` — находка I-05.
- `contracts/SettelmentsControl.sol` — текущий код (строки `:4-16`, `:18-30`, `:34`,
  `:68-99`, `:101-103`, `:110-120`, `:122-135`, `:145-151`, `:183-221`, `:256-304`,
  `:306-344`).
- `contracts/SettelmentsControlProxy.sol:49-52` — `receive()` и `NotAcceptEtherDirectly`.
- `hardhat.config.ts:8-16` — компилятор/оптимизатор.
- `scripts/deploy.ts:111-116`, `test/SettelmentsControl.ts`,
  `test/SettelmentsControlProxy.ts`, `thegraph/` — потребители ABI (вне скоупа).
- `docs/research/SC-1.md`, `docs/research/SC-5.md` — контекст рефакторинга SC-1
  (структура `SettelmentContext`) и SC-5 (ошибки `ZeroAddress`/`ZeroAmount`,
  `setFeeConfig` → `onlyOwner`, регенерация `STORAGE_LOCATION`).
