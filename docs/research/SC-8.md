# SC-8: Техническое исследование — operationId (ключ идемпотентности bytes32 + indexed)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-8.prd.md`
Активный тикет: `docs/.active_ticket` → `SC-8` (STAGE: RESEARCH)

> **Назначение документа.** Зафиксировать полный технический контекст для внедрения
> сквозного ключа идемпотентности `bytes32 operationId` первым аргументом трёх функций
> (`topUpClientBalance`, `paymentClientToNative`, `backFundsToClient`), нового mapping'а
> `processedOperations` в `ContractStorage`, ошибок `OperationAlreadyProcessed` /
> `EmptyOperationId`, хелпера `_markProcessed` и `indexed`-параметра в трёх событиях.
> Скоуп SC-8 — **контракт + тесты (TS/viem и Foundry)**. Синхронизация сабграфа
> (`thegraph/`) и скрипта деплоя (`scripts/deploy.ts`) вынесены в отдельные тикеты.

---

## 1. Связанные модули / сервисы

| Модуль | Путь | Роль в SC-8 | Изменяется |
| --- | --- | --- | --- |
| `SettelmentsControl` | `contracts/SettelmentsControl.sol` | Реализация (логика, `ContractStorage`, события/ошибки) | **Да** |
| `SettelmentsControlProxy` | `contracts/SettelmentsControlProxy.sol` | ERC1967-прокси, `delegatecall` к реализации | **Нет** (ABI меняется только у реализации; прокси сам не меняется, но ре-деплой реализации обязателен) |
| `ERC20Mock` | `contracts/mock/ERC20Mock.sol` | EIP-3009 мок токена; источник revert-причин для `receiveWithAuthorization` | **Нет** |
| TS/viem тесты | `test/SettelmentsControl/*.test.ts`, `test/helpers/{actions,fixture,matchers,eip3009,eip712}.ts` | Адаптация вызовов под `operationId` + новые кейсы идемпотентности | **Да** |
| Foundry тесты | `test/foundry/{Base,fuzz,invariant}.t.sol` | То же для forge | **Да** |
| План тестов | `test/TEST_PLAN.md` | Источник истины по кейсам | **Да** (добавить кейсы идемпотентности) |
| Сабграф | `thegraph/{subgraph.yaml,schema.graphql,abis/,src/settelments-control.ts,networks.json}` | Индексирует события; нуждается в синхронизации ABI/схемы/address/startBlock | **Нет в SC-8** (отдельный тикет) |
| Скрипт деплоя | `scripts/deploy.ts` | viem-деплой; захардкожен `INITIALIZER_ADDRESS`, верификация | **Нет в SC-8** (отдельный тикет) |

Косвенно связаны (только контекст): `hardhat.config.ts`, `foundry.toml`, `package.json` —
стек сборки/тестов (см. §6).

---

## 2. Текущие функции и события контракта

Источник: `contracts/SettelmentsControl.sol` (Solidity `0.8.28`, всего 553 строки).

### 2.1 Контракт и наследование

```solidity
contract SettelmentsControl is Initializable, EIP712Upgradeable {   // :33
    using SafeERC20 for IERC20WithAuthorization;
    ...
}
```

- `IERC20WithAuthorization` (`:18-30`) — интерфейс EIP-3009, объявлен поверх `IERC20`;
  `receiveWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)`.
- `constructor() { _disableInitializers(); }` (`:126-128`) — прямую инициализацию на
  реализации запрещено; тесты идут только через прокси.

### 2.2 Ручной слот EIP-7201 (`ContractStorage`)

```solidity
// keccak256(abi.encode(uint256(keccak256("SettelmentsControl.storage")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant STORAGE_LOCATION =
    0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00;   // :104-106

struct ContractStorage {                                    // :113-124
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

function _getContractStorage()
    private pure returns (ContractStorage storage $)
{
    assembly { $.slot := STORAGE_LOCATION }                  // :130-139
}
```

**Ключевой вывод для SC-8:** `mapping(bytes32 => bool) processedOperations` добавляется
**внутрь** `ContractStorage`, `STORAGE_LOCATION` не перегенерируется. Никаких
state-переменных верхнего уровня. В SC-5 слот уже перегенерировался; в SC-8 этого делать
не нужно (поле нового mapping'а просто занимает следующую ячейку структуры).

### 2.3 Модификаторы

- `onlyAdmin` (`:141-147`): `msg.sender != $.admin → revert OnlyAdmin()`.
- `onlyOwner` (`:149-155`): `msg.sender != $.owner → revert OnlyOwner()`.
- `initializer` (OpenZeppelin `Initializable`) на `initialize` (`:164`).

Все три изменяемые функции помечены `onlyAdmin` → reentrancy-риск низкий (доверенный
бэкенд), но порядок «проверка в начале / отметка в конце» фиксируется как инвариант.

### 2.4 Три функции — точные сигнатуры и порядок внешних вызовов

> Для SC-8 критично, **где** в каждой функции происходят внешние вызовы
> (`receiveWithAuthorization`, `safeTransfer`) относительно обновления баланса и `emit` —
> от этого зависит место вставки `_markProcessed(operationId)`.

#### 2.4.1 `topUpClientBalance` (`:187-226`)

```solidity
function topUpClientBalance(
    string calldata userId,
    address from,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,        // nonce EIP-3009 авторизации USDC (выбирается клиентом)
    uint8 v,
    bytes32 r,
    bytes32 s
) external onlyAdmin {
    ContractStorage storage $ = _getContractStorage();
    ClientBalance storage clientBalance = $.clientBalances[keccak256(abi.encodePacked(userId))];

    $.token.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);  // :204 — внешний вызов

    clientBalance.balance += value;           // :216
    $.totalClientBalance += value;            // :217
    clientBalance.lastInboundAddress = from;  // :218

    emit TopUpClientBalance(userId, value, clientBalance.balance, from);  // :220-225
}
```

Порядок: **внешний вызов (`receiveWithAuthorization`) → изменение баланса → `emit`**.
Для SC-8: проверка `EmptyOperationId`/`OperationAlreadyProcessed` — в начале (перед
`receiveWithAuthorization`); `_markProcessed` — после `clientBalance.lastInboundAddress = from`,
перед `emit`. Если `receiveWithAuthorization` ревертит — вся транзакция откатывается,
отметка не сохраняется → retry с тем же `operationId` возможен.

#### 2.4.2 `paymentClientToNative` (`:261-310`)

```solidity
function paymentClientToNative(
    string calldata clientId,
    string calldata nativeId,
    uint256 amount,
    string calldata sessionId,
    uint256 timestamp,
    uint256 minutesQty
) external onlyAdmin {
    if (amount == 0) revert ZeroAmount();                       // :269

    bytes32 clientHash = keccak256(abi.encodePacked(clientId)); // :271
    SettelmentContext memory ctx = _buildSettelmentContext(...); // :273-280

    if (ctx.nativeAddress == address(0)) revert NativeAddressIsOutForSessionSettelment(operationId, ctx);   // :282-284
    if (ctx.clientBalance < amount) revert InsufficientClientBalanceForSessionSettelment(operationId, ctx); // :286-288

    IERC20WithAuthorization token = _getContractStorage().token; // :290
    uint256 contractBalance = token.balanceOf(address(this));     // :292
    if (contractBalance < amount) revert InsufficientContractBalanceForSessionSettelment(operationId, ctx); // :294-296

    if (ctx.amountToNative > 0) { token.safeTransfer(ctx.nativeAddress, ctx.amountToNative); }  // :298-300 — внешний вызов
    if (ctx.feeAmount > 0)      { token.safeTransfer(ctx.feeCollector, ctx.feeAmount); }         // :302-304 — внешний вызов

    _getContractStorage().clientBalances[clientHash].balance -= amount;  // :306 — изменение баланса
    _getContractStorage().totalClientBalance -= amount;                   // :307

    emit PaymentClientToNative(ctx);                                     // :309
}
```

Порядок: **внешние переводы (`safeTransfer`) → изменение баланса → `emit`**. Это
подтверждает открытый вопрос PRD №3: `_markProcessed` ставится **после** внешних вызовов
и изменения баланса, перед `emit`. Отметка до внешних вызовов «сожгла» бы ключ при
revert'е `safeTransfer` — запрещено.

#### 2.4.3 `backFundsToClient` (`:312-351`)

```solidity
function backFundsToClient(
    string calldata userId,
    uint256 amount
) external onlyAdmin {
    if (amount == 0) revert ZeroAmount();                       // :316
    ContractStorage storage $ = _getContractStorage();           // :317
    ClientBalance storage balance = $.clientBalances[keccak256(abi.encodePacked(userId))];  // :318-320
    address lastAddress = balance.lastInboundAddress;            // :321
    uint256 currentBalance = balance.balance;                    // :322
    if (currentBalance < amount) revert InsufficientClientBalanceForBackFunds(...);  // :323-330

    IERC20WithAuthorization token = $.token;                     // :332
    uint256 contractBalance = token.balanceOf(address(this));    // :334
    if (contractBalance < amount) revert InsufficientContractBalanceForBackFunds(...);  // :336-343

    token.safeTransfer(lastAddress, amount);                     // :345 — внешний вызов

    balance.balance = currentBalance - amount;                   // :347 — изменение баланса
    $.totalClientBalance -= amount;                              // :348

    emit BackFundsToClient(userId, lastAddress, amount);         // :350
}
```

Порядок: **внешний перевод (`safeTransfer`) → изменение баланса → `emit`**.
`_markProcessed` — после `$.totalClientBalance -= amount`, перед `emit`.

### 2.5 Вспомогательная функция `_buildSettelmentContext` (`:228-259`)

`internal view` → `SettelmentContext memory`. Собирает 11 полей, включая `feeAmount =
(amount * feePercentage) / 100` и `amountToNative = amount - feeAmount`. В SC-8 не меняется.

### 2.6 События (`:55-67`) — что меняется

| Событие | Текущая сигнатура | В SC-8 |
| --- | --- | --- |
| `TopUpClientBalance` | `(string userId, uint256 amount, uint256 currentClientBalance, address sender)` | + `bytes32 indexed operationId` первым параметром |
| `PaymentClientToNative` | `(SettelmentContext ctx)` (структура, не indexed) | + `bytes32 indexed operationId` **отдельным** параметром рядом со структурой: `(bytes32 indexed operationId, SettelmentContext ctx)` |
| `BackFundsToClient` | `(string userId, address reciever, uint256 amount)` (опечатка `reciever` — в ABI так и есть) | + `bytes32 indexed operationId` первым параметром |

Прочие события (`NativeAddressSet`, `ChangeAdmin`, `MaxValiditySet`, `FeeConfigSet`,
`StuckFundsWithdrawn`) и OZ-события (`Initialized`, `EIP712DomainChanged`) — без изменений.

> `bytes32 indexed` = один topic → сабграф/индексер смогут фильтровать по `operationId`
> без декодирования data. Структура `SettelmentContext` целиком не может быть `indexed`,
> поэтому параметр выносится рядом (PRD сценарий 7).

### 2.7 Ошибки (`:69-102`)

Существующие (без изменений): `OnlyAdmin`, `OnlyOwner`,
`InsufficientClientBalanceForBackFunds`, `InsufficientContractBalanceForBackFunds`,
`InvalidSignature`, `NonceAlreadyUsed`, `InvalidNativeAddress`, `EmptyNativeId`,
`EmptyNonce`, `FeeTooHigh(uint256)`, `InvalidFeeCollector`, `SignatureExpired`,
`DeadlineTooFar`, `InvalidMaxValidity`, `InvalidAdmin`, `ZeroAddress`, `ZeroAmount`,
`InsufficientStuckFunds`, `WithdrawalFailed`.

**Добавляются в SC-8:**
- `error OperationAlreadyProcessed(bytes32 operationId);`
- `error EmptyOperationId();`

**Изменяются в SC-8** — три ошибки `paymentClientToNative` дополняются `operationId`
первым параметром (единый «сквозной ключ» для диагностики падающих платежей):

| Ошибка | Было | Стало | Селектор (было → стало) |
| --- | --- | --- | --- |
| `InsufficientClientBalanceForSessionSettelment` | `(SettelmentContext ctx)` | `(bytes32 operationId, SettelmentContext ctx)` | `0xae895493` → `0x7eebe94d` |
| `NativeAddressIsOutForSessionSettelment` | `(SettelmentContext ctx)` | `(bytes32 operationId, SettelmentContext ctx)` | `0xc4df6dea` → `0x03ebc37f` |
| `InsufficientContractBalanceForSessionSettelment` | `(SettelmentContext ctx)` | `(bytes32 operationId, SettelmentContext ctx)` | `0x7f5fdf44` → `0x899b9fa7` |

Селекторы (для хелпера `matchers.ts`) имплементер вычислит как
`bytes4(keccak256(...))` и добавит/обновит в `ERRORS` (см. §5.3 — селекторы хранятся константами).
`ctx` остаётся memory-указателем (1 слот), добавление `bytes32` даёт 2 параметра — стек не
переполняется, C-01 не возвращается.

### 2.8 Прочие функции (без изменений в SC-8)

`initialize` (`:157-185`), `getBalance` (`:353-360`), `changeAdmin` (`:363-368`),
`getAdmin` (`:370-373`), `getMaxValidity` (`:375-377`), `setMaxValidity` (`:379-383`),
`isNonceUsed` (`:385-389`), `setNativeAddressWithSignature` (`:422-472`),
`getNativeAddress` (`:474-480`), `isNativeAddressSet` (`:482-488`), `setFeeConfig`
(`:490-501`), `getFeeConfig` (`:503-506`), `getTotalClientBalance` (`:508-510`),
`withdrawStuckTokens` (`:512-538`), `withdrawStuckNative` (`:540-552`).

---

## 3. Прокси (`contracts/SettelmentsControlProxy.sol`)

- `SettelmentsControlProxy is ERC1967Proxy` (`:11`). Конструктор `(address implementation,
  bytes memory data)` вызывает `ERC1967Proxy(implementation, data)` и
  `ERC1967Utils.changeAdmin(msg.sender)` (`:15-18`).
- Функции админки: `changeProxyAdmin` (`:30-32`), `getProxyAdmin` (`:35-37`), `getImpl`
  (`:40-42`), `setImpl` (`:45-47`, `upgradeToAndCall(impl, "")`), все через `onlyProxyAdmin`
  (`:21-27`). `receive()` ревертит `NotAcceptEtherDirectly` (`:50-52`).

**Вывод для SC-8:** сам прокси не меняется. Изменение ABI происходит только у
**реализации** (`SettelmentsControl`). Для применения новой логики нужно задеплоить новую
реализацию и вызвать `setImpl` (или задеплоить новый прокси), затем синхронизировать адрес
в сабграфе/деплое (вне SC-8). Адрес прокси сохраняет состояние, т.к. хранилище живёт в
прокси (ручной слот). `processedOperations` добавляется в группу mapping'ов (после
`usedNonces`): контракт ещё не деплоился, поэтому перестановка безопасна; после первого
деплоя любые новые поля — строго в конец структуры (**без перегенерации слота** существующие
данные сохраняются при апгрейде).

---

## 4. Мок-токен `ERC20Mock` (`contracts/mock/ERC20Mock.sol`)

`ERC20Mock is ERC20, EIP712` (`:8`); домен `EIP712(name, "2")` (`:30`), `version() == "2"`
(`:38-40`). `receiveWithAuthorization` (`:49-90`).

**Revert-причины** (порядок проверок, `:60-84`) — важны для кейса «revert внешнего вызова
→ retry с тем же `operationId` проходит»:

| Условие | Ошибка | Строка |
| --- | --- | --- |
| `to != msg.sender` | `PayeeMustBeCaller()` | `:60` |
| `block.timestamp <= validAfter` | `AuthorizationNotYetValid()` | `:61` |
| `block.timestamp >= validBefore` | `AuthorizationExpired()` | `:62` |
| `_authorizationState[from][nonce]` уже true | `AuthorizationAlreadyUsed()` | `:63` |
| невалидная подпись (`err != NoError || signer != from`) | `InvalidAuthorizationSignature()` | `:82-84` |

Успех: `_authorizationState[from][nonce] = true` → `emit AuthorizationUsed(from, nonce)` →
`_transfer(from, to, value)` (`:86-89`). Nonce — **per authorizer**
(`mapping(address => mapping(bytes32 => bool))`, `:14-15`).

> Для тестов SC-8 «повторный nonce → revert → retry с новым nonce и тем же operationId»:
> `AuthorizationAlreadyUsed` возникает только при повторной передаче того же nonce в
> `topUpClientBalance`. При ретрае с **новым** nonce (но тем же `operationId`) — вызов
> пройдёт (ключ не был сожжён из-за отката первого вызова).

---

## 5. Тесты — все места вызова трёх функций (куда добавлять первый аргумент `operationId`)

### 5.1 Хелперы TS (удобная точка для генерации/прокидывания ключа)

- `test/helpers/actions.ts`:
  - `topUp(...)` (`:22-49`) — вызов `fx.control.write.topUpClientBalance([userId, from, value,
    validAfter, validBefore, nonce, v, r, s], ...)` на `:45`. **Удобная точка:** добавить
    параметр `operationId` в `TopUpOpts`/сигнатуру `topUp` и генерировать дефолт через
    `randomBytes32()` (уже экспортируется из `fixture.ts`). Здесь `nonce` — отдельное поле
    EIP-3009; `operationId` добавляется **первым** аргументом массива.
  - `setNativeAddress(...)` (`:59-83`) — не затронута (не входит в три функции).
- `test/helpers/fixture.ts`:
  - экспортирует `randomBytes32()` (`:46-48`) — **готовая** генерация `operationId`.
  - `SettelmentsControlAbi` из artifacts (`:20-22`) — после перекомпиляции автоматически
    подхватит новые сигнатуры/события/ошибки.

### 5.2 Прямые вызовы в TS-тестах

**`topUpClientBalance`:**
- `test/SettelmentsControl/topup.test.ts:61` (кейс 12, OnlyAdmin — прямой вызов от owner).
- `test/SettelmentsControl/roles-and-management.test.ts:24` (кейс 45, OnlyAdmin).

**`paymentClientToNative`:**
- `test/SettelmentsControl/payment.test.ts:31` (локальный хелпер `pay`).
- `test/SettelmentsControl/payment.test.ts:101` (кейс 20, OnlyAdmin — прямой вызов).
- `test/SettelmentsControl/roles-and-management.test.ts:45` (кейс 46, OnlyAdmin).
- `test/SettelmentsControlProxy.test.ts:100` (кейс 80, сквозной сценарий).

**`backFundsToClient`:**
- `test/SettelmentsControl/backfunds.test.ts:23` (локальный хелпер `backFunds`).
- `test/SettelmentsControl/backfunds.test.ts:84` (кейс 30, OnlyAdmin — прямой вызов).
- `test/SettelmentsControl/roles-and-management.test.ts:56` (кейс 47, OnlyAdmin).
- `test/SettelmentsControlProxy.test.ts:117` (кейс 80, сквозной сценарий).

Остальные вызовы идут через хелперы `topUp`/`pay`/`backFunds` (см. §5.1), поэтому правка
хелпера покрывает большинство кейсов автоматически.

### 5.3 Хелпер проверки revert/событий

- `test/helpers/matchers.ts` — `ERRORS` (`:5-37`) хранит селекторы ошибок константами.
  Сюда добавить селекторы `OperationAlreadyProcessed(bytes32)` и `EmptyOperationId()`.
  `expectRevertCustomError` (`:56-72`) сверяет первые 4 байта revert-data — подходит для
  новых ошибок без изменений. `expectEvent` (`:75-87`) вернёт `args` события; для
  `PaymentClientToNative` теперь будет `args.operationId` (indexed, topic) и `args.ctx`.

### 5.4 Foundry-тесты

- `test/foundry/Base.t.sol`:
  - `_topUp(...)` (`:148-178`) — вызов `control.topUpClientBalance(userId, from, value,
    validAfter, validBefore, nonce, v, r, s)` на `:167`. **Удобная точка:** добавить
    параметр `bytes32 operationId` в `_topUp` (или генерировать внутри через счётчик/
    `bytes32(nonceCounter)`).
- `test/foundry/SettelmentsControl.fuzz.t.sol`:
  - `control.paymentClientToNative(...)` — `:30` (`testFuzz_feeMath`), `:81`
    (`testFuzz_feeMathMultiStep`), `:122` (`testFeeMath_zeroPercent`), `:145`
    (`testFeeMath_hundredPercent`).
  - `control.backFundsToClient("alice", back)` — `:98` (`testFuzz_feeMathMultiStep`).
- `test/foundry/SettelmentsControl.invariant.t.sol`:
  - handler `payment(...)` → `control.paymentClientToNative(...)` — `:60`.
  - handler `backFunds(...)` → `control.backFundsToClient(userId, amount)` — `:75`.
  - handler `topUp(...)` → через `_topUp` из `Base.t.sol` (`:52`) — покрывается правкой `_topUp`.
  - **Важно:** invariant-раннер крутит случайные последовательности; при введении
    `processedOperations` handler должен генерировать **уникальный** `operationId` на каждый
    вызов (иначе случайный повтор ключа даст постоянные `OperationAlreadyProcessed`-revert'ы
    и сократит живое покрытие). Есть `_nextNonce()` (`:39-42`) — тот же паттерн можно
    применить для `operationId`.
- `test/foundry/USDC.fork.t.sol` — fork-тест реального USDC; **не вызывает** три функции,
  не затронут.

### 5.5 `test/TEST_PLAN.md`

Источник истины по кейсам. В SC-8 нужно добавить кейсы идемпотентности (нулевой ключ →
`EmptyOperationId`; повторный ключ → `OperationAlreadyProcessed`; revert внешнего вызова →
retry с тем же ключом; ключи разных операций не конфликтуют). Существующие кейсы 10–17,
18–27, 28–33, 45–47, 80 затрагивают три функции и требуют адаптации вызовов (первый
аргумент).

---

## 6. Стек сборки и запуска тестов

### 6.1 `hardhat.config.ts`

- `solidity.version = "0.8.28"`, `optimizer.enabled = true`, `runs = 1000` (`:9-17`).
  **`viaIR` не задан** — отключён (критерий успеха PRD: компиляция без `viaIR`).
- `networks` закомментированы (`:18-28`) — тесты на встроенной сети Hardhat (31337).
- `gasReporter.enabled = true` (`:29-31`) — оборачивает провайдер (см. риск §7).
- `etherscan` закомментирован (`:32-46`).
- Импорты: `@nomicfoundation/hardhat-toolbox` + `@nomicfoundation/hardhat-viem` (`:2-3`),
  `dotenv` (`:4-6`).

### 6.2 `package.json`

- `scripts`: только format-скрипты; `test`/`compile` через `npx hardhat ...` (AGENTS.md).
- `devDependencies`: `@nomicfoundation/hardhat-toolbox@^5`, `@nomicfoundation/hardhat-viem@^2.1.5`,
  `hardhat@^2.24`, `prettier` (+`plugin-solidity`), `ts-node`, eslint-стек.
- `dependencies`: `@openzeppelin/contracts@^5.3`, `@openzeppelin/contracts-upgradeable@^5.3`,
  `viem@^2.30`, `dotenv`, `solhint`.

Запуск тестов: `npx hardhat test` (TS/viem). Компиляция: `npx hardhat compile`.
Foundry: `forge test` (см. §6.3).

### 6.3 `foundry.toml` (корень, есть)

```toml
[profile.default]
src = "contracts"
test = "test/foundry"
out = "foundry-out"
cache_path = "foundry-cache"
libs = ["lib"]
solc_version = "0.8.28"
evm_version = "cancun"
optimizer = true
optimizer_runs = 1000
remappings = ["@openzeppelin/contracts/=node_modules/...", "@openzeppelin/contracts-upgradeable/=node_modules/..."]

[rpc_endpoints]
polygon = "https://polygon-rpc.com"
```

- Solidity `0.8.28`, optimizer `runs=1000` — **совпадает** с Hardhat (для сопоставимых
  gas-снапшотов). `viaIR` не включён.
- Отдельного `test/foundry.toml` **нет**; конфиг единственный — корневой `foundry.toml`.

---

## 7. Ограничения и риски

1. **Место отметки критично.** `_markProcessed` только **после** успешных внешних вызовов
   и изменения баланса, перед `emit`. Отметка до `receiveWithAuthorization`/`safeTransfer`
   «сожжёт» ключ при revert и заблокирует легитимный retry (риск PRD). В `paymentClientToNative`
   внешние переводы идут **до** обновления баланса (`:298-307`) — подтверждён порядок
   «внешние вызовы → изменение баланса → `_markProcessed` → `emit`».
2. **Забыть `operationId` в одной из трёх функций/событий** — частичная идемпотентность.
   Единый шаблон проверки/отметки и единый порядок аргументов.
3. **`operationId` vs `nonce` в `topUpClientBalance`.** `nonce` — EIP-3009 nonce USDC
   (выбирается клиентом, per-authorizer); `operationId` — ключ идемпотентности бэкенда.
   Не путать при адаптации хелпера `topUp` (там `nonce` генерируется через `randomBytes32()`).
4. **TOCTOU/reentrancy-окно** между проверкой в начале и отметкой в конце. Практический
   риск низкий: все функции `onlyAdmin` (доверенный бэкенд), `receiveWithAuthorization`
   не вызывает reentrancy-колбэки, `safeTransfer` — перевод ERC20 (без `hooks` в моке).
5. **Изменение ABI ломает off-chain потребителей** (тесты, `scripts/deploy.ts`, сабграф).
   В SC-8 адаптируются только тесты; сабграф и деплой — отдельные тикеты.
6. **Сабграф уже рассинхронизирован** с текущим контрактом (в `thegraph/abis/` и
   `subgraph.yaml` — события `BalanceUpdated`/`WithdrawFundsToNative` и плоская сигнатура
   `PaymentClientToNative`, которых нет в контракте). Полная синхронизация — отдельный
   тикет; в SC-8 лишь готовится контрактная часть (`operationId` indexed в событиях).
7. **Рост хранилища.** `processedOperations` — неограниченно растущий bool-mapping без
   итерации; доступ к конкретному ключу O(1), итерация не нужна. Допустимо.
8. **Invariant-тесты Foundry.** При случайных повторах `operationId` handler начнёт
   массово ловить `OperationAlreadyProcessed`, снижая живое покрытие; нужен уникальный
   `operationId` на каждый вызов handler'а.
9. **`gasReporter.enabled = true`** при `npx hardhat test` может влиять на выполнение
   viem-транзакций (историческая заточка под ethers) — проверить, что не мешает прохождению.

---

## 8. Открытые технические вопросы

1. **Имя/формат `_markProcessed` и проверки.** Ожидается `_markProcessed(bytes32 operationId)`
   (устанавливает `processedOperations[operationId] = true`). Где размещать проверку
   `EmptyOperationId`/`OperationAlreadyProcessed` — в начале каждой функции инлайн, или
   вынести в отдельный хелпер `_checkNotProcessed(bytes32)`? (PRD фиксирует только
   `_markProcessed`; валидация нулевого ключа — в начале каждой функции.)
2. **Точная позиция `operationId` в массиве аргументов viem-вызовов.** Первый аргумент
   добавляется в начало массива `args` у всех трёх функций. Подтвердить, что
   typechain/viem-типизация (`GetContractReturnType`) корректно инферит новый первый
   аргумент после перекомпиляции artifacts (иначе потребуются `as`-приведения).
3. **Генерация `operationId` в хелперах.** Дефолт `randomBytes32()` (как `nonce`) или
   детерминированная строка вида `keccak256("op-<n>")`? Для тестов «повторный ключ» нужен
   явно передаваемый `operationId`, поэтому в `topUp`/`pay`/`backFunds` удобно опциональное
   поле `operationId` с дефолтом `randomBytes32()`.
4. **Событие `PaymentClientToNative` — порядок параметров.** `(bytes32 indexed operationId,
   SettelmentContext ctx)`: indexed-параметр должен быть первым, или допустим вторым?
   Solidity позволяет indexed в любом порядке, но PRD фиксирует `operationId` первым.
5. **Апгрейд прокси vs ре-деплой.** Для SC-8 (тесты) достаточно задеплоить новую
   реализацию и обновить `setImpl` в фикстуре. Контракт ещё не деплоился — вопроса «апгрейд
   vs новый прокси» в проде нет (первый деплой — отдельный тикет).
6. **Нужен ли getter для `processedOperations`.** В PRD не упомянут. Для тестов сверку
   «ключ сгорел» можно делать косвенно (повторный вызов → revert). Добавлять ли публичный
   view `isOperationProcessed(bytes32)`? (Полезно для прозрачности/отладки, но расширяет ABI.)
7. **Каноническая типизация события в viem `parseEventLogs`.** Для `PaymentClientToNative`
   с двумя параметрами (`operationId` indexed + `ctx`) `args` будет содержать `operationId`
   (из topic) и `ctx` (структура). Уточнить форму `args.operationId` (bytes32 как `0x...`).
8. **Диапазон/порядок проверок в `topUpClientBalance`.** Порядок: `EmptyOperationId` →
   `OperationAlreadyProcessed` → `receiveWithAuthorization` → баланс → `_markProcessed` →
   `emit`. Подтвердить, что проверка нулевого ключа идёт до проверки `processedOperations`
   (и до `onlyAdmin`? — `onlyAdmin` модификатор срабатывает раньше тела функции всегда).
9. **Селекторы новых ошибок.** Вычислить и зафиксировать `OperationAlreadyProcessed(bytes32)`
   и `EmptyOperationId()` в `test/helpers/matchers.ts` `ERRORS` (константы, как в SC-7).

---

## 9. Источники

- `docs/prd/SC-8.prd.md` — решения, механика, сценарии, цели, риски, открытые вопросы.
- `contracts/SettelmentsControl.sol` — ABI, `ContractStorage`, функции, события, ошибки.
- `contracts/SettelmentsControlProxy.sol`, `contracts/mock/ERC20Mock.sol` — прокси и мок.
- `test/SettelmentsControl/*.test.ts`, `test/helpers/*.ts`, `test/TEST_PLAN.md` — тесты.
- `test/foundry/*.t.sol` — Foundry (Base/fuzz/invariant/fork).
- `hardhat.config.ts`, `package.json`, `foundry.toml` — стек сборки/тестов.
- `docs/research/SC-7.md` — эталонная структура research-документа и селекторы ошибок.
