# SC-7: Техническое исследование — тестовый эпик (покрытие контрактов, I-03)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-7.prd.md` (Status: PRD_READY)
Источник истины по скоупу кейсов: `test/TEST_PLAN.md` (88 viem-кейсов + Foundry F-1…F-5)
Активный тикет: `docs/.active_ticket` → `SC-7`

> **Назначение документа.** Зафиксировать технический контекст для переписывания
> тестов под текущий ABI (находка I-03). Скоуп — только `test/` + тестовый стек;
> код контрактов (`contracts/`) и `scripts/deploy.ts` НЕ меняются. Источник истины
> по ABI — сами контракты (нумерация строк ниже — по текущему рабочему дереву,
> после SC-1…SC-6).

## Резюме

Существующие тесты `test/SettelmentsControl.ts` и `test/SettelmentsControlProxy.ts`
написаны под **старый** ABI (ethers v6 + chai + `PRIVATE_KEY`/`.env`) и не компилируются:
там вызовы `initialize(token, admin)` (2 аргумента), `topUpClientBalance(amount, userId)`,
удалённые `withdrawTokens`/`withdrawFundsToNative`, старые поля `getBalance().nativeBalance`.
Текущий ABI полностью изменился (EIP-7201 storage, 6-аргументный `initialize` через
прокси, EIP-3009 топ-ап, `owner`/`admin` роли, `withdrawStuckTokens`/`withdrawStuckNative`,
`totalClientBalance`).

План SC-7: переписать тесты на **Hardhat + viem** (`@nomicfoundation/hardhat-viem`) по
таблице из `test/TEST_PLAN.md`, плюс **Foundry** для property-тестов (F-1…F-5). Оба стека
настраиваются параллельно; тесты идут через прокси с атомарной инициализацией; без
`.env`/`PRIVATE_KEY`. Ниже — текущее состояние окружения, точный ABI (с селекторами
ошибок), подходы к подписи/revert/событиям/аккаунтам в viem, настройка Foundry,
ограничения и открытые вопросы.

---

## 1. Текущее состояние тестового окружения

### 1.1 `package.json` (корень)

- **`devDependencies`** (`package.json:9-19`):
  - `@nomicfoundation/hardhat-toolbox@^5.0.0` — включает ethers v6, `hardhat-ethers`,
    **`@nomicfoundation/hardhat-chai-matchers`**, `@nomicfoundation/hardhat-network-helpers`
    (установлен, `1.0.12`), typechain, `hardhat-verify`, `hardhat-gas-reporter`.
  - `hardhat@^2.24.0`, `ts-node`, `typescript-eslint`, `eslint`, `globals`,
    `prettier` + `prettier-plugin-solidity`.
- **`dependencies`** (`package.json:20-26`):
  - `@openzeppelin/contracts@^5.3.0`, `@openzeppelin/contracts-upgradeable@^5.3.0`,
    `dotenv`, `solhint`, **`viem@^2.30.0`** (viem уже в зависимостях, используется
    `scripts/deploy.ts`).
- **`@nomicfoundation/hardhat-viem` НЕ установлен** (проверено: папки
  `node_modules/@nomicfoundation/hardhat-viem` нет). Требуется добавить dev-зависимость
  (решение PRD §1-2). `viem` уже есть — плагин подхватит его без дублирования.

### 1.2 `hardhat.config.ts`

- `solidity.version = "0.8.28"`, optimizer `enabled: true, runs: 1000`, `viaIR` не задан
  (`hardhat.config.ts:8-16`).
- `networks` — закомментированы `polygonAmoy` и `hardhat` (`:17-27`); для тестов
  используется встроенная сеть Hardhat (дефолт `31337`).
- `gasReporter.enabled = true` (`:28-30`) — **влияет на тесты**: gas-reporter
  оборачивает провайдер и при `npx hardhat test` будет пытаться собирать gas-отчёт
  (см. риски §9).
- `etherscan` — закомментирован (`:31-45`), на тесты не влияет.
- `dotenv.config()` в конфиге и в старых тестах — из нового стека убрать зависимость
  от `.env` (PRD §4).

### 1.3 Foundry

- **Foundry не установлен и не настроен:** `forge`/`foundryup` отсутствуют в PATH;
  `foundry.toml` нет; `lib/forge-std` нет. Инфраструктурная работа на этапе планирования:
  `foundryup`, `forge init`-стиль `lib/forge-std`, `foundry.toml` с `test = "test/foundry"`,
  `out = "foundry-out"` (не пересекаться с `artifacts/`), `solc = "0.8.28"` (см. §6).

### 1.4 Прочие артефакты

- `artifacts/`, `cache/` — игнорируются git'ом (`.gitignore`), перегенерируются
  `npx hardhat compile`. Содержат актуальные ABI (см. §3).
- `typechain-types/` — устаревшая генерация под старый ABI (вне скоупа; viem-тесты
  используют ABI из artifacts/JSON или `parseAbi`, не typechain).
- `tsconfig.json` — `target: es2020`, `module: commonjs`, `strict: true`,
  `resolveJsonModule: true` (важно для импорта `.json` ABI из `artifacts/`).
- `.solhint.json` — `solhint:recommended` (к Solidity-тестам Foundry применим).

---

## 2. Текущие файлы тестов — что переиспользовать / выбросить

### 2.1 `test/SettelmentsControl.ts` (317 строк, ethers+chai, СТАРЫЙ ABI)

Полностью написан под устаревший ABI. Ключевые несоответствия:

- `initialize(token, admin)` — 2 аргумента (`:37`), в текущем ABI **6 аргументов**
  (`_token, _admin, _owner, _feePercentage, _feeCollector, _maxValidity`).
- `topUpClientBalance(amount, userId)` (`:67`) — текущая сигнатура
  `(userId, from, value, validAfter, validBefore, nonce, v, r, s)` (EIP-3009).
- `withdrawTokens(...)` (`:300`, `:313`) и `withdrawFundsToNative(...)` (`:185`, `:206`,
  `:222`) — **функций в контракте больше нет**.
- `getBalance().nativeBalance` (`:74`, `:118-124`, `:191-192`, `:253-254`) — текущая
  структура `ClientBalance { balance, lastInboundAddress }` (без `nativeBalance`).
- Использует `process.env.PRIVATE_KEY` + `ethers.Wallet` как initializer (`:12-15`) —
  зависимость от `.env` (убрать, PRD §4).
- События через chai `.to.emit(...).withArgs(...)`; ошибки через
  `.revertedWithCustomError(...)` — в viem-стеке не используются (PRD §8).

**Выбросить целиком.** Ничего переиспользовать нельзя, кроме *смысла* сценариев
(топ-ап/расчёт/возврат) — они переписаны в таблицу `TEST_PLAN.md` под новый ABI.

### 2.2 `test/SettelmentsControlProxy.ts` (374 строки, ethers+chai, СТАРЫЙ ABI)

Аналогично устарел:

- `Proxy.deploy(implementation.target)` — 1 аргумент (`:26`), текущий конструктор
  **2 аргумента** `(implementation, data)` + в конструкторе `changeAdmin(msg.sender)`
  (`SettelmentsControlProxy.sol:15-18`).
- `initialize(token, admin)` через `proxyUsed` (`:46`) — 2 аргумента.
- Старые `withdrawTokens`/`withdrawFundsToNative` в секции «Using impl via proxy».
- Тест `getProxyAdmin() == deployer` (`:61-66`) **остаётся валидным** семантически
  (конструктор ставит админа = деплойер) — перенести в viem (кейс 73).
- Тест «Should reject direct ETH transfers» → `NotAcceptEtherDirectly` (`:119-131`)
  **остаётся валидным** (кейс 79; `receive()` ревертит в текущем прокси).

**Выбросить целиком**, переписать по кейсам 73–80.

### 2.3 `test/TEST_PLAN.md` — есть, актуален, источник истины

188 строк: 88 viem-кейсов (таблица `:20-109`) + Foundry F-1…F-5 (`:111-188`).
Содержит зафиксированный стек (`:3-18`), фикстуру (`:16-18`), полную таблицу
групп (инициализация 1–9, топ-ап 10–17, расчёты 18–27, возврат 28–33, привязка 34–44,
роли 45–60, геттеры 61, вывод застрявшего 62–72, прокси 73–80, мок 81–88) и
Foundry-дополнение с псевдокодом. **Имплементер должен сверить каждую строку таблицы
с фактическим ABI из §3** (PRD §Риски: расхождение таблицы с ABI — источник ошибок).

---

## 3. Точный текущий ABI контрактов

> Селекторы ошибок вычислены как `bytes4(keccak256(signature))` (ethers `id()`) —
> для сверки в хелперах `expectRevertCustomError`.

### 3.1 `SettelmentsControl` (`contracts/SettelmentsControl.sol`)

**Контракт:** `SettelmentsControl is Initializable, EIP712Upgradeable` (`:33`).
Ручной слот EIP-7201 `STORAGE_LOCATION = 0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00` (`:105-106`).

**Структуры (возвращаемые/событийные):**
- `ClientBalance { uint256 balance; address lastInboundAddress; }` (`:36-39`).
- `SettelmentContext` — 11 полей (`:41-53`):
  `clientId(string), clientBalance(uint256), nativeId(string), nativeAddress(address),
  amountToNative(uint256), sessionId(string), timestamp(uint256), minutesQty(uint256),
  feePercentage(uint256), feeAmount(uint256), feeCollector(address)`.
  Используется в событии `PaymentClientToNative` и в 3 ошибках.

**Функции** (все `external`):
| Функция | Сигнатура | Файл:строка |
| --- | --- | --- |
| `initialize` | `(address _token, address _admin, address _owner, uint256 _feePercentage, address _feeCollector, uint256 _maxValidity)` — `initializer` | `:157-185` |
| `topUpClientBalance` | `(string userId, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` — `onlyAdmin` | `:187-226` |
| `paymentClientToNative` | `(string clientId, string nativeId, uint256 amount, string sessionId, uint256 timestamp, uint256 minutesQty)` — `onlyAdmin` | `:261-310` |
| `backFundsToClient` | `(string userId, uint256 amount)` — `onlyAdmin` | `:312-351` |
| `getBalance` | `(string userId) → ClientBalance` | `:353-360` |
| `changeAdmin` | `(address newAdmin)` — `onlyOwner` | `:363-368` |
| `getAdmin` | `() → address` | `:370-373` |
| `getMaxValidity` | `() → uint256` | `:375-377` |
| `setMaxValidity` | `(uint256 newMaxValidity)` — `onlyOwner` | `:379-383` |
| `isNonceUsed` | `(string nonce) → bool` | `:385-389` |
| `setNativeAddressWithSignature` | `(string nativeId, address nativeAddress, string nonce, uint256 deadline, uint8 v, bytes32 r, bytes32 s)` — `onlyAdmin` | `:422-472` |
| `getNativeAddress` | `(string nativeId) → address` | `:474-480` |
| `isNativeAddressSet` | `(string nativeId) → bool` | `:482-488` |
| `setFeeConfig` | `(uint256 feePercentage, address feeCollector)` — `onlyOwner` | `:490-501` |
| `getFeeConfig` | `() → (uint256 feePercentage, address feeCollector)` | `:503-506` |
| `getTotalClientBalance` | `() → uint256` | `:508-510` |
| `withdrawStuckTokens` | `(address token, address to, uint256 amount)` — `onlyOwner` | `:512-538` |
| `withdrawStuckNative` | `(address payable to, uint256 amount)` — `onlyOwner` | `:540-552` |

Плюс из OpenZeppelin: `eip712Domain()` (EIP712Upgradeable), `Initialized`/`EIP712DomainChanged`
события, ошибки `InvalidInitialization`/`NotInitializing` (Initializable).

**События** (`:55-67`):
`TopUpClientBalance(string userId, uint256 amount, uint256 currentClientBalance, address sender)`,
`PaymentClientToNative(SettelmentContext ctx)` (struct, не индексирован),
`NativeAddressSet(string indexed nativeId, address nativeAddress)`,
`BackFundsToClient(string userId, address reciever, uint256 amount)` (опечатка `reciever` — в ABI так и есть),
`ChangeAdmin(address newAdmin)`, `MaxValiditySet(uint256 maxValidity)`,
`FeeConfigSet(uint256 feePercentage, address feeCollector)`,
`StuckFundsWithdrawn(address token, address to, uint256 amount)`.
Плюс OZ: `Initialized(uint64 version)`, `EIP712DomainChanged()`.

**Модификаторы:** `onlyAdmin` (`:141-147`, revert `OnlyAdmin()`), `onlyOwner` (`:149-155`,
revert `OnlyOwner()`).

**Custom errors и селекторы** (`:69-102`):

| Ошибка | Селектор |
| --- | --- |
| `OnlyAdmin()` | `0x47556579` |
| `OnlyOwner()` | `0x5fc483c5` |
| `InsufficientClientBalanceForSessionSettelment(SettelmentContext)` | `0xae895493` |
| `NativeAddressIsOutForSessionSettelment(SettelmentContext)` | `0xc4df6dea` |
| `InsufficientContractBalanceForSessionSettelment(SettelmentContext)` | `0x7f5fdf44` |
| `InsufficientClientBalanceForBackFunds(string,address,uint256,uint256)` | `0x6f194512` |
| `InsufficientContractBalanceForBackFunds(string,address,uint256,uint256)` | `0x21483961` |
| `InvalidSignature()` | `0x8baa579f` |
| `NonceAlreadyUsed()` | `0x1fb09b80` |
| `InvalidNativeAddress()` | `0xa86b1e53` |
| `EmptyNativeId()` | `0xd46b306d` |
| `EmptyNonce()` | `0xfa662e90` |
| `FeeTooHigh(uint256)` | `0x7b931420` |
| `InvalidFeeCollector()` | `0xbb0bac99` |
| `SignatureExpired()` | `0x0819bdcd` |
| `DeadlineTooFar()` | `0x48f0fae6` |
| `InvalidMaxValidity()` | `0x9a93f8d6` |
| `InvalidAdmin()` | `0xb5eba9f0` |
| `ZeroAddress()` | `0xd92e233d` |
| `ZeroAmount()` | `0x1f2a2005` |
| `InsufficientStuckFunds()` | `0x68509843` |
| `WithdrawalFailed()` | `0x27fcd9d1` |

Плюс OZ: `InvalidInitialization()` = `0xf92ee8a9` (кейс 8, повторный `initialize`),
`NotInitializing()` = `0xd7e6bcf8`, `SafeERC20FailedOperation(address)` = `0x5274afe7`.

> **Важно для хелпера revert:** 3 ошибки (`InsufficientClientBalanceForSessionSettelment`,
> `NativeAddressIsOutForSessionSettelment`, `InsufficientContractBalanceForSessionSettelment`)
> имеют аргумент-структуру `SettelmentContext`; их селектор зависит от **канонической**
> кортежной сигнатуры. Для проверки «какая именно ошибка» достаточно сверки первых 4 байт
> revert-data с селектором. Ошибки с аргументами (`FeeTooHigh(uint256)`) при сверке по
> селектору игнорируют аргументы.

### 3.2 `SettelmentsControlProxy` (`contracts/SettelmentsControlProxy.sol`)

**Конструктор:** `(address implementation, bytes memory data)` — наследует
`ERC1967Proxy(implementation, data)` и вызывает `ERC1967Utils.changeAdmin(msg.sender)`
(`:15-18`). → `getProxyAdmin()` сразу равен деплойеру (кейс 73).

**Функции:**
- `changeProxyAdmin(address newAdmin)` — `onlyProxyAdmin` (`:30-32`).
- `getProxyAdmin() → address` (`:35-37`).
- `getImpl() → address` (`:40-42`).
- `setImpl(address implementation)` — `onlyProxyAdmin`, `upgradeToAndCall(impl, "")` (`:45-47`).

**Ошибки (свои):** `OnlyAdmin()` = `0x47556579` (`:12`), `NotAcceptEtherDirectly()` =
`0x1398a250` (`:13`).

**`receive()`** — `revert NotAcceptEtherDirectly()` (`:50-52`).

Плюс наследуемые из OZ: события `AdminChanged`, `Upgraded`; ошибки
`AddressEmptyCode`, `ERC1967InvalidAdmin`, `ERC1967InvalidImplementation`,
`ERC1967NonPayable`, `FailedCall` (видны в ABI artifacts).

> **Осторожно:** имя `OnlyAdmin` совпадает с ошибкой `SettelmentsControl.OnlyAdmin`,
> селектор один и тот же (`0x47556579`) — при сверке revert по селектору их не различить.
> Тесты прокси и реализации в разных файлах, конфликт только семантический.

### 3.3 `ERC20Mock` (`contracts/mock/ERC20Mock.sol`, EIP-3009 + ERC20 + EIP712)

**Конструктор:** `(string name, string symbol, address initialAccount, uint256 initialBalance)`
(`:25-32`); `EIP712(name, "2")` — домен EIP-712: **name = `name` (параметр), version = `"2"`**.

**Функции:**
- `version() → string` — возвращает `"2"` (`:38-40`) — кейс 81.
- `authorizationState(address authorizer, bytes32 nonce) → bool` (`:42-47`) — кейс 82.
- `mint(address account, uint256 amount)` (`:34-36`).
- `receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
  uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` (`:49-90`).
- Базовые ERC20 (`transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, …).

**События:** `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` (`:17`),
`Transfer`, `Approval` (OZ), `EIP712DomainChanged`.

**Ошибки и селекторы** (`:19-23`):
| Ошибка | Селектор |
| --- | --- |
| `PayeeMustBeCaller()` | `0x182dc57a` |
| `AuthorizationNotYetValid()` | `0xdf8e4372` |
| `AuthorizationExpired()` | `0x0f05f5bf` |
| `AuthorizationAlreadyUsed()` | `0x9508f1f2` |
| `InvalidAuthorizationSignature()` | `0x391e7a64` |

Плюс OZ ERC20-ошибки (для кейсов 13/14/15/16 и пр. — «ошибка мока» может быть и
ERC20-ошибкой при неверном маршруте, но в норме это ошибки EIP-3009):
`ERC20InsufficientBalance(address,uint256,uint256)` = `0xe450d38c`,
`ERC20InsufficientAllowance(address,uint256,uint256)` = `0xfb8f41b2` и др.

### 3.4 Typehash'и (для подписи)

- **`SettelmentsControl.ASSIGNMENT_TYPEHASH`** (`:108-111`):
  `keccak256("NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)")`.
  Домен EIP-712: `__EIP712_init("SettelmentsControl", "1.0")` (`:165`) → name
  `"SettelmentsControl"`, version `"1.0"`. Тип структуры в viem-хелпере должен называться
  `NativeAddressAssignment` (см. §4.1).
- **`ERC20Mock.RECEIVE_WITH_AUTHORIZATION_TYPEHASH`** (`:9-12`):
  `keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`.
  Домен: name = имя токена, version `"2"`.

---

## 4. Подпись EIP-712 в viem

viem предоставляет `signTypedData` в **двух** местах:

1. **`viem/accounts`** — функция `signTypedData({ privateKey, domain, types, primaryType, message })`
   → возвращает `0x`-префиксную 65-байтную подпись `r‖s‖v` (`v` — последний байт, 27/28).
2. **wallet-клиент** (`createWalletClient`/`hre.viem.getWalletClients()[i]`) — action
   `client.signTypedData(...)` (тот же результат).

Проверено в установленной `viem@2.30.0`: `signTypedData` доступен из `viem/accounts`
(и как action `viem/actions.signTypedData`), `hexToSignature`/`recoverTypedDataAddress` —
из корня `viem`. Тип домена — `TypedDataDomain` (из `viem`): поля
`{ name?, version?, chainId?, verifyingContract?, salt? }`.

**Разбор 65-байтной подписи** → `const { r, s, v } = hexToSignature(signature)`
(`viem` корень; возвращает `{ r, s, v, yParity }` для 65-байтной формы).

### 4.1 Домен и структура для `setNativeAddressWithSignature` (кейсы 34–44)

```ts
import { signTypedData, privateKeyToAccount } from "viem/accounts";
import { hexToSignature, type TypedDataDomain } from "viem";

const domain: TypedDataDomain = {
  name: "SettelmentsControl",
  version: "1.0",
  chainId,                      // chainId сети Hardhat (31337)
  verifyingContract: proxyAddress, // АДРЕС ПРОКСИ (delegatecall: address(this)=proxy)
};
const types = {
  NativeAddressAssignment: [
    { name: "nativeId", type: "string" },
    { name: "nativeAddress", type: "address" },
    { name: "nonce", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const sig = await signTypedData({
  privateKey, domain, types,
  primaryType: "NativeAddressAssignment",
  message: { nativeId, nativeAddress, nonce, deadline },
});
const { r, s, v } = hexToSignature(sig);   // v: number (27/28)
// вызов: setNativeAddressWithSignature(nativeId, nativeAddress, nonce, deadline, v, r, s)
```

> **Критично:** `verifyingContract` должен быть **адрес прокси**, а не реализации —
> `_hashTypedDataV4` использует `address(this)`, который при `delegatecall` равен прокси.
> Контракт проверяет `ECDSA.tryRecover(hash, v, r, s)` с **раздельными** v/r/s
> (`SettelmentsControl.sol:410-415`), поэтому подпись передаётся в раздельные аргументы.

### 4.2 Домен и структура для `receiveWithAuthorization` мока (кейсы 10–17, 83–88)

```ts
const domain: TypedDataDomain = {
  name: tokenName,              // имя, переданное в конструктор мока (напр. "Test Token")
  version: "2",
  chainId,
  verifyingContract: tokenAddress, // адрес ERC20Mock
};
const types = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const sig = await signTypedData({ privateKey, domain, types,
  primaryType: "ReceiveWithAuthorization",
  message: { from, to: proxyAddress /* контракт — payee */, value, validAfter, validBefore, nonce } });
const { r, s, v } = hexToSignature(sig);
// вызов: topUpClientBalance(userId, from, value, validAfter, validBefore, nonce, v, r, s)
```

> **Важно для мока:**
> - `to` в подписи должно быть равно `msg.sender` (иначе `PayeeMustBeCaller`,
>   `ERC20Mock.sol:60`). Топ-ап идёт от `admin`, `msg.sender` внутри `receiveWithAuthorization`
>   = `address(this)` контракта (прокси), поэтому `to = proxyAddress`.
> - Контракт передаёт подпись в мок как `r‖s‖v` **склеенную**: мок вызывает
>   `ECDSA.tryRecover(_hashTypedDataV4(structHash), abi.encodePacked(r, s, v))`
>   (`ERC20Mock.sol:78-81`). Поэтому `r/s/v` из `hexToSignature` подходят как есть
>   (сначала в раздельные аргументы `topUpClientBalance`, а мок уже сам склеит).
> - Nonce — **per authorizer** (`_authorizationState[from][nonce]`), а не глобальный
>   (`ERC20Mock.sol:14-15`, `:63`).

---

## 5. Ловля custom errors и чтение событий в viem

### 5.1 Ловля revert + сверка селектора

Готовых chai-матчеров для viem **нет** (PRD §8, §Риски). Нужны свои хелперы.
Доступные примитивы в viem 2.30 (проверено):

- `simulateContract(publicClient, {...})` — для проверки revert **без майна**; при
  revert бросает `ContractFunctionExecutionError`/`ContractFunctionRevertedError` с
  `cause.data` (revert-data).
- `writeContract(walletClient, {...})` — при revert бросает
  `ContractFunctionExecutionError`, в `.cause.data` лежит `0x`-префиксная revert-data
  (первые 4 байта = селектор ошибки).
- `decodeErrorResult({ abi, data })` — корень `viem`; **но** требует, чтобы ошибка была
  объявлена в переданном `abi`. Можно использовать, передав полный ABI контракта (в
  artifacts ABI уже есть все ошибки — см. §3), либо делать ручную сверку селектора.

Рекомендуемый хелпер (`test/helpers/matchers.ts`):

```ts
// ручная сверка селектора (надёжно, не зависит от ABI-обёртки)
export async function expectRevertCustomError(promise, selector: `0x${string}`) {
  try { await promise; }
  catch (e) {
    const data = (e as any)?.cause?.data;          // revert data
    if (data && (data as string).slice(0, 10).toLowerCase() === selector.toLowerCase())
      return;
    throw new Error(`expected revert ${selector}, got ${data}`);
  }
  throw new Error("expected revert, but tx succeeded");
}
```

Альтернатива — `decodeErrorResult({ abi, data })`, но ручная сверка проще и точнее,
когда есть несколько ошибок с одинаковым именем (`OnlyAdmin` в прокси и реализации).
Использование: `expectRevertCustomError(adminAsUser.writeContract({...}), "0x47556579")`.

> **Эквивалентность `simulateContract` vs `writeContract`.** Для проверки revert
> достаточно `simulateContract` (быстрее, без майна). `writeContract` нужен, когда тест
> одновременно проверяет побочный эффект (событие/перевод). Хелперы должны принимать
> произвольный промис, чтобы работали и с тем, и с другим.

### 5.2 Чтение событий

- `getContractEvents(client, { address, abi, eventName, fromBlock, toBlock })` — action
  (`viem/actions`; также доступен как `publicClient.getContractEvents`).
- `parseEventLogs({ abi, logs, eventName })` — корень `viem` (для логов из receipt).
- `watchContractEvent(client, {...})` — для подписки (обычно не нужен в тестах).

Рекомендация для тестов: после `writeContract` получить receipt
(`getTransactionReceipt`), затем `parseEventLogs({ abi, logs: receipt.logs, eventName })`
и сверить `args`. Это заменяет chai `.to.emit(...).withArgs(...)`. Хелпер
`expectEvent(...)` из `test/helpers/matchers.ts` (PRD §37).

> **Внимание к `PaymentClientToNative`:** аргумент события — структура
> `SettelmentContext` (11 полей). `parseEventLogs` вернёт её как объект `args.ctx`
> с ключами в camelCase (viem нормализует имена). Сверять поля точечно
> (`args.ctx.amountToNative`, `args.ctx.feeAmount`, …).

---

## 6. Foundry — настройка параллельно с Hardhat

**Текущее состояние:** не установлен (см. §1.3). Полная настройка — на этапе
планирования (PRD §Открытые вопросы). Ключевые пункты для имплементера:

1. **Установка:** `curl -L https://foundry.paradigm.xyz | bash && foundryup` →
   `forge`, `cast`, `anvil`, `chisel`.
2. **`foundry.toml`** (в корне, рядом с `hardhat.config.ts`), **не конфликтует** с
   Hardhat при разделении путей:
   ```toml
   [profile.default]
   src = "contracts"
   test = "test/foundry"
   out = "foundry-out"        # НЕ artifacts/ (Hardhat), НЕ пересекается
   cache_path = "foundry-cache"
   libs = ["lib"]
   solc_version = "0.8.28"    # закрепить, совпадает с hardhat.config.ts
   optimizer = true
   optimizer_runs = 1000
   [rpc_endpoints]
   polygon = "https://polygon-rpc.com"   # для F-4
   ```
   `lib/forge-std` — добавить субмодулем/папкой (`forge install foundry-rs/forge-std`),
   импорт в `.t.sol`: `import {Test} from "forge-std/Test.sol";`.
3. **Команды:** `forge test` (запуск `test/foundry`), `forge test --gas-report` (F-5),
   `forge snapshot` (газ-снапшот). `forge fmt --check test/foundry` при желании.
4. **Fork-тест F-4:** `vm.createSelectFork(vm.rpcUrl("polygon"))` или
   `vm.createSelectFork("https://polygon-rpc.com")`; адрес USDC на Polygon
   `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (см. `TEST_PLAN.md:165`). Нужен внешний
   RPC → риск недоступности (PRD §Риски); предусмотреть skip/фолбэк или локальный RPC.
5. **Invariant F-1:** `invariant_totalMatchesSum()` + handler-контракт
   (`targetContract(control)`), который крутит `topUp`/`payment`/`backFunds`.
   Для вызова функций контракта из handler через прокси-семантику в Foundry — деплой
   `SettelmentsControl` как обычный контракт + прямой `initialize` **невозможен**
   (`_disableInitializers`, `SettelmentsControl.sol:126-128`). Значит в Foundry нужно
   либо (а) тестировать через тот же ERC1967-прокси, либо (б) поднять упрощённый
   harness-контракт, наследующий `SettelmentsControl` и вызывающий внутреннюю
   инициализацию. Это **открытый вопрос** (§9, ОТВ-3).
6. **Cheatcodes:** `vm.warp`, `vm.prank`, `vm.startPrank`, `vm.sign`, `vm.expectRevert`,
   `vm.expectEmit`, `vm.deal`, `vm.etch`, `vm.store` — быстрые, не через JSON-RPC.
   `vm.sign(privateKey, digest)` для подписей в fuzz F-3.

---

## 7. Аккаунты и сеть в Hardhat + viem

### 7.1 Аккаунты

- `hre.viem.getWalletClients()` → массив wallet-клиентов (`WalletClient[]`), по умолчанию
  первые 20 аккаунтов Hardhat (деривируются от мнемоники; адреса детерминированы).
  Индексация: `clients[0]` = deployer/owner, `clients[1]` = admin, и т.д. — зафиксировать
  роли в `test/helpers/fixture.ts` (owner, admin, feeCollector, user1, user2, native).
- `hre.viem.getPublicClient()` — публичный клиент (read/simulate/getLogs/getContractEvents).
- `hre.viem.deployContract(name, { args })` / `client.deployContract({ abi, bytecode, args })`
  — деплой.
- Имперсонация: `hardhat_impersonateAccount` через
  `@nomicfoundation/hardhat-network-helpers` (`impersonateAccount(address)` /
  `stopImpersonatingAccount(address)`), `setBalance(address, value)` — **для POL**.
  Для кейса 69 (`withdrawStuckNative` через `selfdestruct`-хелпер): развернуть
  вспомогательный selfdestruct-контракт (или `vm.deal`/`setBalance` на прокси), т.к.
  `receive()` прокси ревертит обычные переводы, а `selfdestruct` зачисляет принудительно.

### 7.2 Манипуляция временем

`@nomicfoundation/hardhat-network-helpers` (`time`):
`time.increase(seconds)`, `time.increaseTo(ts)`, `time.latest()` (текущий timestamp),
`time.latestBlock()`, `time.setNextBlockTimestamp(ts)`. Это JSON-RPC-обёртки
(`evm_increaseTime`/`evm_mine`) — **совместимы с viem** (не зависят от ethers).
Используются для кейсов с `deadline` (40, 41), `validAfter`/`validBefore` (14, 15, 85, 86).

> **Альтернатива** — напрямую `hre.network.provider.send("evm_increaseTime", [n])` +
> `evm_mine`, но хелперы `time.*` читабельнее.

---

## 8. `hardhat-network-helpers` и `loadFixture` с viem

- `loadFixture` (из `@nomicfoundation/hardhat-network-helpers@1.0.12`, установлен)
  работает через `evm_snapshot`/`evm_revert` на уровне провайдера — **не зависит от
  ethers/viem**. Она принимает fixture-функцию, возвращающую промис, и на повторных
  вызовах восстанавливает снапшот.
- **Совместима с viem** при условии, что fixture детерминирован (деплой через
  `hre.viem.deployContract`/`getWalletClients()` — адреса и nonce восстанавливаются
  вместе со снапшотом). Wallet-клиенты — stateless (подписывают и шлют через
  publicClient), поэтому «сброс» nonce аккаунтов снапшотом не ломает клиенты.
- **Рекомендация:** собственная обёртка-фикстура в `test/helpers/fixture.ts`
  (PRD §37) поверх `loadFixture`: деплой `ERC20Mock` + имплементация + прокси с
  init-`data` (`encodeFunctionData` для `initialize([6 аргументов])`), возвращает
  клиентов + адреса + ABI-обёртки (`getContract`).
- Если по каким-то причинам `loadFixture` покажется неудобной — альтернатива
  `takeSnapshot`/`restore` вручную, но `loadFixture` достаточно.

---

## 9. Ограничения и риски

1. **`@nomicfoundation/hardhat-viem` отсутствует** — первое действие имплементера:
   `npm i -D @nomicfoundation/hardhat-viem` + `import "@nomicfoundation/hardhat-viem";`
   в `hardhat.config.ts` и (возможно) `"hardhat-viem"` в `tsconfig` types. Версия плагина
   должна соответствовать `hardhat@2.24` и `viem@2.30`.
2. **Нет viem-матчеров в chai.** Все revert/событийные проверки — через собственные
   хелперы (`matchers.ts`). Риск ошибок в селекторах — сверять с §3 (селекторы
   приведены явно).
3. **Gas-reporter включён** (`hardhat.config.ts:28-30`). При `npx hardhat test`
   gas-reporter пытается обернуть провайдер; с viem-транзакциями может не собирать
   отчёт корректно (gas-reporter исторически заточен под ethers). Решение: в тестовом
   рантайме либо отключить (`REPORT_GAS=false`), либо оставить и проверить, что отчёт
   не мешает прохождению. **Открытый вопрос** (§ОТВ-4).
4. **Параллельность Hardhat + Foundry.** Раздельные команды/кэши: `foundry-out/` и
   `foundry-cache/` **не** должны пересекаться с `artifacts/`/`cache/`; `test/foundry/`
   — отдельная папка, вне `test/*.ts` (иначе `hardhat test` не подхватит `.sol`, но
   `forge test` должен искать только `test/foundry`). Версии solc должны совпадать
   (0.8.28) — иначе расход газа в снапшотах (F-5) несопоставим.
5. **Fork-тест F-4 зависит от внешнего RPC** — нестабильность/недоступность сети;
   нужен фолбэк (skip) или локальный RPC/кэш форка (`vm.createSelectFork` с
   `blockNumber` для детерминизма).
6. **Расхождение `TEST_PLAN.md` с фактическим ABI.** Источник истины — контракт; план
   актуализируется. При переписывании сверять каждую группу кейсов с §3 (имена ошибок,
   порядок проверок). Особо: ошибки с `SettelmentContext`-аргументом, `FeeTooHigh(uint256)`
   (с аргументом), опечатка `reciever` в событии `BackFundsToClient`.
7. **`_disableInitializers()` в имплементации** (`:126-128`) → прямой `initialize` на
   реализации невозможен; тесты только через прокси с init-`data`. Это же ограничение
   переносится в Foundry (см. §6.5, ОТВ-3).
8. **`verifyingContract` в подписи = адрес прокси** (а не реализации) — легко ошибиться,
   из-за чего `InvalidSignature` при корректной подписи.
9. **Вывод POL (`withdrawStuckNative`, кейсы 69–72).** `receive()` прокси ревертит
   обычные ETH-переводы; зачисление только через `selfdestruct`-хелпер или
   `hardhat_setBalance` на адрес прокси (не `sendTransaction`).
10. **Типизация `strict: true`** — сигнатуры `writeContract`/`readContract` viem
    строго типизированы; при импорте ABI из JSON (`resolveJsonModule: true`) может
    потребоваться `as const` для ABI или приведение типов аргументов (`bigint` для
    uint, `0x${string}` для address/bytes32).

---

## 10. Открытые технические вопросы

- **ОТВ-1. Версия `@nomicfoundation/hardhat-viem`** и совместимость с
  `hardhat@2.24.0`/`viem@2.30.0`; включать ли типы плагина в `tsconfig` (`types`).
- **ОТВ-2. Gas-reporter + viem.** Отключать ли `gasReporter` при тестах (или
  `REPORT_GAS=false`), чтобы он не мешал/не падал на viem-транзакциях.
- **ОТВ-3. Foundry + `_disableInitializers`.** Как инициализировать `SettelmentsControl`
  в Foundry-тестах: через ERC1967-прокси (как в viem) или через harness-контракт,
  наследующий реализацию и вызывающий `initialize` (обход `_disableInitializers` через
  наследование — `_disableInitializers` запрещает только прямой вызов на самой
  реализации). Определяет каркас `test/foundry/*.t.sol`.
- **ОТВ-4. RPC для F-4.** Какой RPC Polygon использовать, и стратегия при недоступности
  (skip/фолбэк). Фиксировать ли `blockNumber` для детерминизма форка.
- **ОТВ-5. `forge-std` версия и способ установки** (submodule vs копия в `lib/`),
  закрепление solc 0.8.28 в `foundry.toml`, `evm_version`.
- **ОТВ-6. Порог качества.** Считать ли 88 viem + F-1…F-5 полным покрытием или добавить
  `solidity-coverage` (PRD §Открытые вопросы).
- **ОТВ-7. Фикстура vs `loadFixture`.** Подтвердить использование `loadFixture` с
  viem-клиентами или собственная снапшот-обёртка (`takeSnapshot`/`restore`).
- **ОТВ-8. Единый источник ABI в тестах.** Импортировать ли ABI из `artifacts/**/*.json`
  напрямую (как `scripts/deploy.ts`) или заново объявлять через `parseAbi`; как
  обеспечить, что тесты всегда сверяются с последней компиляцией (пересборка перед
  тестом).

---

## 11. Источники

- `docs/prd/SC-7.prd.md` — решения, структура, цели, риски, открытые вопросы.
- `test/TEST_PLAN.md` — источник истины по 88 viem-кейсам + F-1…F-5.
- `contracts/SettelmentsControl.sol` — ABI (§3.1); `contracts/SettelmentsControlProxy.sol`
  (§3.2); `contracts/mock/ERC20Mock.sol` (§3.3).
- `package.json`, `hardhat.config.ts`, `tsconfig.json`, `.gitignore`, `.solhint.json` — окружение.
- `scripts/deploy.ts` — эталон viem-паттернов (import ABI из artifacts, `deployContract`,
  `writeContract`/`readContract`), вне скоупа.
- `node_modules/viem/package.json`, `node_modules/@nomicfoundation/hardhat-network-helpers/`,
  `node_modules/@nomicfoundation/hardhat-chai-matchers/` — фактические версии/API (проверено).
- `artifacts/contracts/**/*.json` — актуальные ABI (проверено перечисление функций/событий/ошибок).
