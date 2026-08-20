# SC-4: Техническое исследование — совместимость топ-апа с EIP-3009 (H-03)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-4.prd.md`
Аудит (источник находки H-03): `docs/audit-reports/2026-08-20.md` (строки `:199-217`)
Активный тикет: `docs/.active_ticket` → `SC-4`

## Резюме

`topUpClientBalance` (`contracts/SettelmentsControl.sol:171-209`) вызывает у токена
`$.token.receiveWithAuthorization(...)` (split-сигнатура EIP-3009, как у USDC), но
мок `contracts/mock/ERC20Mock.sol` — обычный OZ `ERC20` без этой функции, поэтому
топ-ап в тестах/deploy-скрипте всегда ревертится (H-03). Скоуп SC-4 — два файла:

1. **`contracts/mock/ERC20Mock.sol`** — дополнить мок до EIP-3009 (вариант A):
   `receiveWithAuthorization(...)` + EIP-712 домен `version="2"` + верификация
   split-подписи `(v, r, s)` + nonce-трекинг + проверки `to == msg.sender` и
   `validAfter`/`validBefore`.
2. **`contracts/SettelmentsControl.sol`** — добавить в `initialize` (вариант C)
   проверку поддержки EIP-3009 у `_token`.

Оба файла воспроизводят **семантику USDC** (FiatTokenV2_2 / Polygon
`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`), но **без** переноса кода
centre-tokens (Solidity 0.6.12) — только на 0.8.28 + OZ v5.3.0.

**Рекомендованный механизм проверки (вариант C):** `version() == "2"` через
низкоуровневый `staticcall` (селектор `0x54fd4d50`) — детерминированный, не
ревертится для поддерживаемых токенов, напрямую валидирует версию EIP-712 домена,
от которой зависит совместимость подписи. Альтернативы (`authorizationState`,
probe селектора `receiveWithAuthorization`) надёжнее/слабее — сравнение в §6.

---

## 1. Связанные модули/контракты

| Модуль | Файл | Роль в задаче |
| --- | --- | --- |
| Реализация | `contracts/SettelmentsControl.sol` | **Меняется.** Только `initialize` — добавление проверки EIP-3009 (§2.3). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | **Меняется.** Дополняется до EIP-3009 (§3). |
| Интерфейс токена | `contracts/SettelmentsControl.sol:18-30` (`IERC20WithAuthorization`) | Источник сигнатуры `receiveWithAuthorization`; без `version()`/`authorizationState` (см. §6). |
| EIP-712 (non-upgradeable) | `node_modules/@openzeppelin/contracts/utils/cryptography/EIP712.sol` | Базовый класс для мока: конструктор `EIP712(name, version)` (§4). |
| ECDSA | `node_modules/@openzeppelin/contracts/utils/cryptography/ECDSA.sol` | `tryRecover`/`recover(hash, v, r, s)` и `recover(hash, bytes)` — верификация split-подписи (§4). |
| MessageHashUtils | `node_modules/@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol` | `toTypedDataHash(domainSeparator, structHash)` (§4). |
| SignatureChecker / IERC1271 | `node_modules/@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol`, `interfaces/IERC1271.sol` | Опционально: ERC1271-верификация (как у USDC) (§4, §5). |
| Деплой-скрипт | `scripts/deploy.ts` | Потребитель ABI мока (`:33-37` деплой с 4 аргументами) и `initialize` (`:111-116` с 2 аргументами); **не меняется**, станет неконсистентным (§8). |
| Тесты Hardhat | `test/SettelmentsControl.ts`, `test/SettelmentsControlProxy.ts` | Потребители ABI мока/`initialize`; **не меняются**, уже неконсистентны (I-03) (§8). |
| Сабграф The Graph | `thegraph/` | **Не затрагивается** — индексирует события `SettelmentsControl`, не ABI мока/`initialize`. |
| Компилятор | `hardhat.config.ts` | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` выключен (§9). |
| Зависимости | `@openzeppelin/contracts@^5.3.0`, `@openzeppelin/contracts-upgradeable@^5.3.0` | Установленные версии (`package.json:21-22`). |

**Вывод по скоупу:** меняются только два файла (`ERC20Mock.sol` целиком и
`initialize` в `SettelmentsControl.sol`). Остальное — потребители ABI, чья
синхронизация вынесена отдельно (находки I-03/H-02).

---

## 2. Текущий код `SettelmentsControl.sol` (точные строки)

### 2.1 Интерфейс `IERC20WithAuthorization`

`contracts/SettelmentsControl.sol:18-30`:

```solidity
interface IERC20WithAuthorization is IERC20 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
```

Точная split-сигнатура: `receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`.
Селектор: `0xef55bec6`. Интерфейс **не содержит** `version()` и
`authorizationState(address,bytes32)` — для варианта C их нужно либо добавить в
интерфейс, либо опрашивать через низкоуровневый `staticcall` (§6).

Прочее: `using SafeERC20 for IERC20WithAuthorization` (`:34`);
`ContractStorage.token` типизирован как `IERC20WithAuthorization` (`:111`).

### 2.2 `topUpClientBalance`

`contracts/SettelmentsControl.sol:171-209`:

```solidity
function topUpClientBalance(
    string calldata userId,
    address from,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external onlyAdmin {
    ContractStorage storage $ = _getContractStorage();

    ClientBalance storage clientBalance = $.clientBalances[
        keccak256(abi.encodePacked(userId))
    ];

    $.token.receiveWithAuthorization(
        from,
        address(this),          // to = контракт (payee)
        value,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s
    );

    clientBalance.balance += value;
    clientBalance.lastInboundAddress = from;

    emit TopUpClientBalance(userId, value, clientBalance.balance, from);
}
```

Ключевые детали:
- вызов `$.token.receiveWithAuthorization(from, address(this), ...)` — `:188-198`,
  `to` жёстко равен `address(this)` (совпадает с `to == msg.sender` в USDC: вызов
  идёт от контракта, поэтому `msg.sender` внутри токена = адрес контракта);
- баланс хранится в `$.clientBalances[keccak256(abi.encodePacked(userId))]`
  (`:184-186`), структура `ClientBalance { uint256 balance; address lastInboundAddress; }`
  (`:36-39`); увеличение `clientBalance.balance += value` и запись
  `lastInboundAddress = from` — `:200-201`;
- событие `TopUpClientBalance(userId, value, clientBalance.balance, from)` — `:203-208`;
- модификатор `onlyAdmin` (`:181`, определён `:134-140`).

**Вывод:** `topUpClientBalance` менять **не нужно** — интерфейс и вызов уже
соответствуют USDC. Проблема только в токене (мок) и в отсутствии валидации на
деплое (H-03).

### 2.3 `initialize` (6 параметров, после SC-2)

`contracts/SettelmentsControl.sol:150-169`:

```solidity
function initialize(
    address _token,
    address _admin,
    address _owner,
    uint256 _feePercentage,
    address _feeCollector,
    uint256 _maxValidity
) external initializer {
    __EIP712_init("SettelmentsControl", "1.0");
    if (_feePercentage > 100) revert FeeTooHigh(_feePercentage);
    if (_maxValidity == 0) revert InvalidMaxValidity();
    ContractStorage storage $ = _getContractStorage();
    $.token = IERC20WithAuthorization(_token);
    $.admin = _admin;
    $.owner = _owner;
    $.feePercentage = _feePercentage;
    $.feeCollector = _feeCollector;
    $.maxValidity = _maxValidity;
    emit ChangeAdmin(_admin);
}
```

- `__EIP712_init("SettelmentsControl", "1.0")` (`:158`) — это **собственный**
  EIP-712 домен контракта (для `setNativeAddressWithSignature`/`_verifyAssignmentSignature`,
  `:372-401`), **не** имеет отношения к домену токена EIP-3009. Не путать.
- **Где добавить проверку:** после валидации `_feePercentage`/`_maxValidity`
  (`:159-160`) и до/рядом с `$.token = IERC20WithAuthorization(_token)` (`:162`) —
  проверка зависит только от `_token`, поэтому логично вызвать её сразу после
  `:160` (fail fast), до записи в хранилище. При неудаче ревертится вся
  инициализация (атомарность через `initializer`), что и требуется PRD сценарию 3.
- Механика `initializer`/`_disableInitializers` описана в `docs/research/SC-3.md:158-227`
  (для SC-4 не меняется).

**Внимание:** `initialize` не проверяет `_token`/`_admin`/`_owner`/`_feeCollector`
на `address(0)` — это находка M-02, **вне скоупа SC-4** (не раздувать правку; при
желании — отдельная задача).

---

## 3. Текущий код `contracts/mock/ERC20Mock.sol` (целиком)

Файл `contracts/mock/ERC20Mock.sol` — 19 строк:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {
    constructor(
        string memory name,
        string memory symbol,
        address initialAccount,
        uint256 initialBalance
    ) ERC20(name, symbol) {
        _mint(initialAccount, initialBalance);
    }

    function mint(address account, uint256 amount) public {
        _mint(account, amount);
    }
}
```

- Наследует только OZ `ERC20` (`:6`), **нет** `EIP712`, **нет**
  `receiveWithAuthorization` — селектор `0xef55bec6` отсутствует → вызов из
  `topUpClientBalance` ревертится с пустой причиной (fallback-реверт).
- Конструктор: `(name, symbol, initialAccount, initialBalance)` (`:7-14`), минтит
  `initialBalance` на `initialAccount`.
- `mint(address,uint256)` public (`:16-18`).

**Куда добавить EIP-3009:** наследование `EIP712` (non-upgradeable) +
реализация `receiveWithAuthorization` (split) + `authorizationState` + `version()`
+ nonce-mapping. Подробно в §5 и §7.

---

## 4. Доступные криптопримитивы OpenZeppelin v5.3.0

Все нужные модули **присутствуют** в `@openzeppelin/contracts@5.3.0`
(`package.json:21`):

| Примитив | Путь | Что даёт |
| --- | --- | --- |
| `EIP712` (non-upgradeable) | `utils/cryptography/EIP712.sol` | `constructor(string name, string version)` (`:68`), `_domainSeparatorV4()` (`:82`), `_hashTypedDataV4(bytes32 structHash)` (`:109`) |
| `ECDSA` | `utils/cryptography/ECDSA.sol` | `tryRecover(bytes32, uint8, bytes32, bytes32)` (`:128-154`), `recover(bytes32, uint8, bytes32, bytes32)` (`:160`), `recover(bytes32, bytes memory)` (`:91`, для 65-байтной подписи) |
| `MessageHashUtils` | `utils/cryptography/MessageHashUtils.sol` | `toTypedDataHash(bytes32 domainSeparator, bytes32 structHash)` (`:90`) — собирает `keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash)` |
| `SignatureChecker` | `utils/cryptography/SignatureChecker.sol` | `isValidSignatureNow(address signer, bytes32 hash, bytes memory signature)` (`:22`) — EOA `ecrecover` + fallback на ERC-1271 |
| `IERC1271` | `interfaces/IERC1271.sol` | интерфейс `isValidSignature(bytes32,bytes)` для ERC-1271 |

**Что использовать в моке (вариант A):**

1. **EIP-712 домен:** наследовать `EIP712` (non-upgradeable, **не**
   `EIP712Upgradeable` — мок не прокси). Конструктор `EIP712(name, version)`
   (`EIP712.sol:68`). OZ v5 строит домен как `keccak256(abi.encode(TYPE_HASH,
   hashedName, hashedVersion, chainId, address(this)))` (`_buildDomainSeparator`,
   `:90-92`) — **та же формула, что у USDC** (`EIP712.makeDomainSeparator(name,
   "2", chainId)`), поэтому `EIP712(<name>, "2")` воспроизводит домен USDC с
   точностью до `address(this)` (см. §5, §7).

2. **Верификация split-подписи `(v, r, s)`:** два равнозначных варианта:
   - `ECDSA.recover(digest, abi.encodePacked(r, s, v)) == from` — `abi.encodePacked(r,s,v)`
     даёт 65 байт, `ECDSA.recover(bytes32, bytes)` (`ECDSA.sol:91-95`) разбирает их
     на `(v, r, s)` и сверяет с `from`;
   - `SignatureChecker.isValidSignatureNow(from, digest, abi.encodePacked(r, s, v))`
     — ближе к USDC (которое тоже использует `SignatureChecker` и поддерживает
     ERC-1271 contract-wallet). Для EOA оба эквивалентны.
   Рекомендуется `SignatureChecker.isValidSignatureNow` (максимальная близость к
   семантике USDC), `ECDSA.recover` — как минимальный вариант.

3. **`MessageHashUtils.toTypedDataHash`** — для сборки digest; эквивалент
   `_hashTypedDataV4` (OZ `EIP712._hashTypedDataV4` сам вызывает
   `toTypedDataHash`, `EIP712.sol:109-111`).

**Примечание про `EIP712Upgradeable` в `SettelmentsControl`:** контракт уже
наследует `EIP712Upgradeable` (`:11-13`, `:33`) и инициализирует его
`__EIP712_init("SettelmentsControl", "1.0")` (`:158`) — это домен **контракта**,
а не токена; к моку не относится.

---

## 5. Точная семантика USDC (EIP-3009) — что воспроизвести в моке

Источник: `centrehq/centre-tokens` (`FiatTokenV2.sol`, `FiatTokenV2_2.sol`,
`EIP3009.sol`, `FiatTokenV2_1.sol`). Код 0.6.12 **не переносится** — только
семантика на 0.8.28 + OZ v5.

### 5.1 EIP-712 домен USDC

- `FiatTokenV2_2._domainSeparator()` = `EIP712.makeDomainSeparator(name, "2", chainId)`
  — домен: `name` = имя токена (`"USD Coin"` у native USDC на Polygon),
  `version = "2"`, `chainId`, `verifyingContract = address(this)` (адрес токена).
- `version()` возвращает `"2"` (`FiatTokenV2_1.sol`, `external pure`).

### 5.2 Typehash

`RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`
= `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8`
(сверено с PRD и пересчитано локально — совпадает).

### 5.3 `_receiveWithAuthorization` (split → bytes) — порядок проверок

1. `require(to == msg.sender, "FiatTokenV2: caller must be the payee")`.
2. `_requireValidAuthorization(from, nonce, validAfter, validBefore)`:
   - `now > validAfter` (**строго**);
   - `now < validBefore` (**строго**);
   - `!authorizationState[from][nonce]` (nonce **по authorizer**).
3. `_requireValidSignature(from, keccak256(abi.encode(TYPEHASH, from, to, value,
   validAfter, validBefore, nonce)), signature)`:
   - `SignatureChecker.isValidSignatureNow(from,
     MessageHashUtils.toTypedDataHash(domainSeparator, structHash), signature)`;
   - `signature = abi.encodePacked(r, s, v)` — **r ‖ s ‖ v** (65 байт).
4. `_markAuthorizationAsUsed(from, nonce)` → `authorizationState[from][nonce] = true`
   + событие `AuthorizationUsed(from, nonce)`.
5. `_transfer(from, to, value)`.

### 5.4 Что переносить в мок (и что не переносить)

Переносить **только** нужное для `receiveWithAuthorization`:
- `mapping(address => mapping(bytes32 => bool)) authorizationState` (nonce per authorizer);
- `receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)`
  (split) — с проверками `to == msg.sender`, `block.timestamp > validAfter` (строго),
  `block.timestamp < validBefore` (строго), nonce-unused, верификацией подписи,
  пометкой nonce и `_transfer(from, to, value)`;
- `authorizationState(address,bytes32) external view returns (bool)`;
- `version() external pure returns (string memory)` → `"2"`.

**Не переносить** (PRD §«Ограничения», `docs/prd/SC-4.prd.md:120-125`): blacklist,
pausable, permit/EIP-2612, `transferWithAuthorization`, `cancelAuthorization`,
`DOMAIN_SEPARATOR()` — только то, что нужно для `receiveWithAuthorization`.

**Замечание о `now`:** в 0.6.12 `now` == `block.timestamp`; в моке на 0.8.28
использовать `block.timestamp`.

**Важный нюанс совместимости домена:** домен включает `verifyingContract =
address(this)` (адрес токена). Поэтому подпись, валидная для USDC, **не является**
байт-в-байт валидной для мока и наоборот — у них разные адреса. «Совместимость» из
PRD означает: одинаковые `name`/`version`/typehash, чтобы **тот же инструментарий
подписи** (ethers/viem `signTypedData`) формировал идентичный typed-data; сам факт
подписи всегда производится под конкретный адрес токена. Это следует отразить в
тестах (подписывать под адрес мока, а не USDC) — см. §11, §12.

---

## 6. Проверка поддержки EIP-3009 в `initialize` (вариант C)

EIP-3009 **не определяет** ERC165 `interfaceId`, поэтому `supportsInterface`
недоступен (PRD §«Риски»). Сравнение трёх механизмов:

### Вариант 1 — низкоуровневый `staticcall` селектора `receiveWithAuthorization` (probe)

- Селектор `0xef55bec6`, `staticcall` с 9 dummy-аргументами.
- Детектирование существования по returndata при revert: `ret.length > 0` → функция
  существует (реверт произошёл внутри тела), `ret.length == 0` → селектор не найден.
- **Надёжность: средняя/низкая.** Эвристика «пустой returndata == нет функции»
  хрупкая: функция может ревертиться без данных (`revert()`/`assert`/assembly),
  fallback может возвращать пустые данные, прокси-маршрутизация даёт пустой revert
  для неизвестных селекторов. Для USDC на практике работает (он ревертится строкой
  «FiatTokenV2: caller must be the payee» и т.п.), но это нечистый интерфейсный
  чек, а ручное кодирование 9 аргументов порождает ошибки. Риск ложного пропуска.
  Не рекомендован как основной.

### Вариант 2 — `version() == "2"` (рекомендован)

- Селектор `0x54fd4d50`, `staticcall` → декодировать `string`, сравнить с `"2"`.
- **Надёжность: высокая для прода.** `version()` — `pure`, возвращает `"2"`
  детерминированно, **не ревертится** у поддерживаемых токенов. Дискриминатор —
  «успех + значение», а не «revert-причина». Напрямую валидирует версию EIP-712
  домена, от которой зависит совместимость split-подписи (PRD допущение о USDC).
- **Ограничение:** не универсальный EIP-3009-чек — токен с `receiveWithAuthorization`,
  но без `version()=="2"` (например, домен v1) будет отклонён. Это **приемлемо и
  желательно**, т.к. продакшн-токен — именно USDC с доменом v2.
- **Реализация:** либо (а) добавить `function version() external view returns
  (string memory);` в `IERC20WithAuthorization` и вызвать напрямую (при отсутствии
  ревертится с невнятной причиной), либо (б) — чище — внутренний хелпер со
  `staticcall` + `abi.decode`, возвращающий `bool`, и `revert` новым custom error
  (например, `error TokenDoesNotSupportEIP3009()`). Рекомендован (б).

### Вариант 3 — `authorizationState(address,bytes32)`

- Селектор `0xe94a0102`, `staticcall` с произвольными `(authorizer, nonce)`.
- **Надёжность: выше варианта 1, ниже/равно варианта 2.** `authorizationState` —
  view-функция EIP-3009, **не ревертится** для поддерживаемых токенов (возвращает
  `bool`), поэтому дискриминатор «успех vs revert» чистый. Это самый
  «спецификационно-корректный» способ детекции EIP-3009. Но он **не проверяет
  версию домена**: токен с `authorizationState` и доменом v1 прошёл бы чек, но
  split-подпись была бы несовместима с USDC-семантикой.

### Рекомендация

**Основной механизм — вариант 2 (`version() == "2"`)** через `staticcall` с
декодированием и custom error. Он детерминирован, семантичен (проверяет именно ту
характеристику, от которой зависит совместимость), не опирается на хрупкую
returndata-эвристику. При желании — «belt-and-suspenders»: добавить поверх
вариант 3 (`authorizationState`) как проверку наличия EIP-3009, но для прода (USDC)
и мока это избыточно. **Вариант 1 не рекомендован.**

Мок должен, соответственно, реализовывать `version() == "2"` (и, при выборе
варианта 3, `authorizationState`).

---

## 7. EIP-712 домен в моке (version = "2")

- Использовать **non-upgradeable** `EIP712` из `@openzeppelin/contracts`
  (мок — не прокси; `EIP712Upgradeable` из `contracts-upgradeable` **не** нужен).
- Конструктор OZ v5: `EIP712(string memory name, string memory version)`
  (`EIP712.sol:68`). Для совместимости с USDC задать `version = "2"`.
- `name`: USDC использует имя токена (`"USD Coin"`). В моке есть параметр
  конструктора `name`, который уже передаётся в `ERC20(name, symbol)`. Рекомендуется
  пробросить тот же `name` в `EIP712(name, "2")` — домен будет соответствовать
  имени токена, как у USDC. (Жёсткое зашивание `"USD Coin"` тоже допустимо, но
  менее универсально для тестов с произвольным именем.)
- Пример целевой формы конструктора мока:
  `constructor(string memory name, string memory symbol, address initialAccount,
  uint256 initialBalance) ERC20(name, symbol) EIP712(name, "2") { ... }` — порядок
  базовых конструкторов не критичен (разные слаты/иммутаблы).
- **Не путать** с доменом контракта `"SettelmentsControl"/"1.0"` (`:158`) — это
  разные домены, для разных целей (назначение native-адреса vs EIP-3009 топ-ап).

---

## 8. Потребители ABI мока/`initialize` (станут неконсистентны — вне скоупа)

Подтверждение, что синхронизация — отдельная задача (PRD §«Вне скоупа»,
`docs/prd/SC-4.prd.md:35-36`; находки I-03/H-02):

### 8.1 `scripts/deploy.ts`

- Деплой мока с **4 аргументами** (`:33-37`): `args: ['BabylonTest', 'BT',
  account.address, 1000n * 10n**18n]` — после добавления `EIP712(name, "2")`
  число аргументов конструктора мока **не меняется** (name/symbol берутся из
  параметров), но ABI мока расширяется (`receiveWithAuthorization`, `version`,
  `authorizationState`) — верификация мока (`:52-55`,
  `constructorArguments: ['BabylonTest', 'BT', account.address, 1000n * 10n**18n]`)
  остаётся корректной по числу аргументов.
- Инициализация с **2 аргументами** (`:111-116`): `args: [erc20Address,
  account.address]` — **уже неконсистентна** с текущим `initialize` (6 параметров
  после SC-2) и остаётся неконсистентной после SC-4. **Не меняется в SC-4.**

### 8.2 `test/`

- Оба теста деплоят мок с 4 аргументами (`test/SettelmentsControl.ts:19-24`,
  `test/SettelmentsControlProxy.ts:12-17`) — по числу аргументов не ломаются, но
  `initialize` вызывается с **2 аргументами** (`SettelmentsControl.ts:35-37`,
  `SettelmentsControlProxy.ts:44-46`), а `topUpClientBalance` — с **2 аргументами**
  (`topUpClientBalance(amount, userId)`, `:63-70`, `:144-149` и др.), что не
  соответствует текущему ABI (9 параметров). Тесты ссылаются на удалённые
  `withdrawFundsToNative`/`withdrawTokens` и старую структуру `getBalance` — см.
  I-03 в аудите (`docs/audit-reports/2026-08-20.md:371-383`). **Не меняются в SC-4.**

**Вывод:** SC-4 не трогает тесты и deploy-скрипт; их синхронизация (включая
формирование 6 аргументов `initialize` и 9 аргументов `topUpClientBalance`, а
также подпись EIP-712 под адрес мока) — отдельная задача (I-03/H-02), см. §12.

---

## 9. Компилятор (`hardhat.config.ts`)

- Solidity `0.8.28` (`:9`), optimizer `enabled: true, runs: 1000` (`:11-14`).
- **`viaIR` не задан** → выключен. Критерий успеха — `rm -rf artifacts cache &&
  npx hardhat compile` возвращает 0 (PRD §«Успех», `docs/prd/SC-4.prd.md:99-100`).
- `networks`/`etherscan` закомментированы (`:17-45`); `gasReporter.enabled = true`
  (`:28-30`).

Оценка риска «Stack too deep»: добавление в мок отдельной функции
`receiveWithAuthorization` (несколько `require`-проверок + вызовы `_transfer`) —
локальные переменные в пределах нормы; риск низкий. В `initialize` добавляется
одна проверка (или `staticcall`-хелпер) — риск низкий. При необходимости
(симптомы stack too deep) можно вынести проверки в `internal`-хелпер.

---

## 10. Используемые паттерны

- **EIP-3009** (gasless transfer с авторизацией): split-сигнатура
  `(v, r, s)` → `abi.encodePacked(r, s, v)`; nonce per authorizer
  (`authorizer => nonce => bool`); строгие окна `now > validAfter` /
  `now < validBefore`; `to == msg.sender` (анти-фронт-раннинг payee).
- **EIP-712:** домен `(name, version, chainId, verifyingContract)`; typehash
  `ReceiveWithAuthorization(...)`; digest = `keccak256(0x19 0x01 ‖ domainSeparator
  ‖ structHash)` (в OZ — `MessageHashUtils.toTypedDataHash`).
- **Отсутствие ERC165** у EIP-3009: нет `interfaceId`; проверка поддержки — только
  функциональным probe (`version()`, `authorizationState`, селектор) — см. §6.
- **ERC-1271 (опционально):** USDC верифицирует через `SignatureChecker`
  (EOA `ecrecover` + fallback на контрактные кошельки). В моке можно воспроизвести
  через OZ `SignatureChecker.isValidSignatureNow`.
- **Upgradeable-паттерн контракта** не затрагивается: `initialize` остаётся
  `initializer` (одноразовый), проверка добавляется до/в месте `$.token = ...`
  внутри уже существующей инициализации (ручной слот `ContractStorage` не меняется).

---

## 11. Ограничения и риски

1. **EIP-3009 без ERC165** — механизм проверки в `initialize` неочевиден; наивный
   `supportsInterface` не работает. Неверный выбор (probe с returndata-эвристикой)
   может дать ложный пропуск/ложное срабатывание (PRD §«Риски»). Рекомендация
   `version() == "2"` минимизирует этот риск (§6).
2. **Домен-совместимость ограничена адресом токена:** домен включает
   `verifyingContract = address(this)`, поэтому подпись, валидная для USDC, **не**
   валидна для мока напрямую — тесты должны подписывать под адрес мока. «Общее» у
   мока и USDC — `name`/`version`/typehash (один и тот же инструментарий подписи),
   а не взаимозаменяемые подписи (§5.4).
3. **Упрощённый мок маскирует семантику USDC:** если верификация/нонце/окна не
   воспроизведены, тестовое окружение не покажет баги, специфичные для реального
   USDC. PRD требует полноценную реализацию EIP-3009 (§5).
4. **Изменение ABI мока и `initialize`:** off-chain потребители (deploy-скрипт,
   верификация, тесты) временно расходятся — осознанно, вне скоупа SC-4 (§8).
5. **`initialize` без валидации нулевых адресов (M-02)** — отдельная находка, вне
   скоупа SC-4; проверка EIP-3009 добавляется, но `_token`/`_admin`/`_owner`/
   `_feeCollector` на `address(0)` по-прежнему не проверяются (не раздувать правку).
6. **`feePercentage`/`_maxValidity`/слот** — не затрагиваются; ручной слот
   `STORAGE_LOCATION` и структура `ContractStorage` остаются без изменений
   (PRD §«Цели»).
7. **`version()` у USDC — `pure`:** при объявлении в интерфейсе использовать
   `external view` (совместимо с `pure`), либо вовсе не трогать интерфейс и
   опрашивать через `staticcall` (§6, вариант 2-б).

---

## 12. Открытые технические вопросы

1. **(решается в plan)** Конкретная форма проверки EIP-3009: расширять ли
   `IERC20WithAuthorization` (`version()`, `authorizationState()`) или добавить
   `internal`-хелпер со `staticcall` + custom error `TokenDoesNotSupportEIP3009()`.
   Рекомендация research: `staticcall`-хелпер с `version() == "2"` (§6).
2. **Имя домена мока:** пробрасывать ли `name` конструктора в `EIP712(name, "2")`
   или жёстко `"USD Coin"`. Рекомендация: пробрасывать `name` (§7).
3. **Верификация подписи в моке:** `ECDSA.recover` (минимальный) vs
   `SignatureChecker.isValidSignatureNow` (ближе к USDC, поддержка ERC-1271).
   Рекомендация: `SignatureChecker` для близости к семантике USDC (§4, §5).
4. **Порядок базовых конструкторов мока** (`ERC20(name, symbol)` и
   `EIP712(name, "2")`) — не влияет на компиляцию/поведение (разные слаты), но
   формализуется в plan.
5. **(неблокирующее)** Синхронизация `test/` и `scripts/deploy.ts` с новым ABI
   мока и 6-аргументным `initialize` (а также 9-аргументным `topUpClientBalance`
   и EIP-712 подписью под адрес мока) — отдельная задача (I-03/H-02), вне скоупа
   SC-4 (PRD §«Открытые вопросы», `docs/prd/SC-4.prd.md:150-153`).
6. **Подтверждение живого ABI USDC с ноды** (split-сигнатура `receiveWithAuthorization`)
   отложено (RPC недоступны) — принято допущение о поддержке split-сигнатуры
   (PRD `docs/prd/SC-4.prd.md:50-52`).
