# SC-2: Техническое исследование — верификация подписи назначения адреса носителя (H-01)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-2.prd.md`
Аудит (источник находок H-01, L-02, I-01, M-01, H-02): `docs/audit-reports/2026-08-20.md`
План исправлений: `docs/audit-reports/2026-08-20-fix-plan.md`

## 1. Связанные модули/контракты

| Модуль | Файл | Роль в задаче |
| --- | --- | --- |
| Реализация логики расчётов | `contracts/SettelmentsControl.sol` | **Единственный файл, который меняется.** Содержит `setNativeAddressWithSignature`, `changeAdmin`, `initialize`, `getAdmin`, модификаторы `onlyAdmin`/`onlyOwner`, `ASSIGNMENT_TYPEHASH`, `ContractStorage`, события и ошибки. |
| ERC1967-прокси | `contracts/SettelmentsControlProxy.sol` | **Не меняется.** Управляет собственным админом прокси (`changeProxyAdmin`/`getProxyAdmin`/`setImpl`) и не зависит от сигнатур `initialize`/`changeAdmin` реализации (см. §5). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Вне скоупа; не затронут. |
| Деплой-скрипт | `scripts/deploy.ts` | Потребитель ABI; уже неконсистентен (H-02): вызывает `initialize` с 2 аргументами вместо 5 (станет 6 после SC-2). Синхронизация — вне скоупа. |
| Тесты Hardhat | `test/SettelmentsControl.ts`, `test/SettelmentsControlProxy.ts` | Потребители ABI; уже неконсистентны с текущим контрактом (см. §6). Вне скоупа. |
| Сабграф The Graph | `thegraph/` (abis, schema, src, subgraph.yaml, networks.json) | Потребитель ABI; ABI сильно устарел (см. §6). Синхронизация — вне скоупа. |
| Компилятор | `hardhat.config.ts` | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` не включён (см. §7). Критерий успеха — чистая компиляция без `viaIR`. |
| Зависимости | `@openzeppelin/contracts@5.3.0`, `@openzeppelin/contracts-upgradeable@5.3.0` | Источник `ECDSA` и `EIP712Upgradeable` (см. §4). |

**Вывод по скоупу:** меняется **только** `contracts/SettelmentsControl.sol`. Прокси не
затрагивается. Все остальные файлы — потребители ABI, которые уже неконсистентны либо
станут такими после изменения сигнатуры `initialize`/`setNativeAddressWithSignature`;
их синхронизация — отдельные задачи, в SC-2 не входят (PRD §«Ограничения и допущения»,
риск про H-02).

---

## 2. Текущие функции, ошибки, события (с точными строками)

Все ссылки ниже — на `contracts/SettelmentsControl.sol` (текущая версия после SC-1,
коммит `33be408`; файл имеет 437 строк).

### 2.1 Объявления контракта и импорты

| Элемент | Строки |
| --- | --- |
| `pragma solidity 0.8.28` | `:2` |
| Импорт `IERC20` (contracts) | `:4` |
| Импорт `SafeERC20` (contracts) | `:5-7` |
| Импорт `Initializable` (contracts-upgradeable) | `:8-10` |
| Импорт `EIP712Upgradeable` (contracts-upgradeable) | `:11-13` |
| `contract SettelmentsControl is Initializable, EIP712Upgradeable` | `:30` |
| `using SafeERC20 for IERC20WithAuthorization` | `:31` |

Важно: контракт уже смешивает импорты из `contracts` и `contracts-upgradeable`
(`IERC20`/`SafeERC20` из `contracts`, `Initializable`/`EIP712Upgradeable` из
`contracts-upgradeable`), поэтому добавление `ECDSA` из `contracts` не создаёт нового
паттерна.

### 2.2 Структуры

| Структура | Строки | Примечание |
| --- | --- | --- |
| `ClientBalance` (`balance`, `lastInboundAddress`) | `:33-36` | — |
| `NativeAddressAssignment` (`nativeId`, `nativeAddress`, `nonce`) | `:38-42` | **Объявлена, но НЕ используется** в коде. `ASSIGNMENT_TYPEHASH` задан вручную (см. 2.5), а не через `keccak256` полей этой структуры. Мёртвый код. |
| `SettelmentContext` (11 полей) | `:44-56` | Введён в SC-1 для устранения Stack too deep. К задаче не относится. |

### 2.3 События (стиль — именованные параметры, `indexed` только для `nativeId`)

| Событие | Строка | Сигнатура |
| --- | --- | --- |
| `TopUpClientBalance(string userId, uint256 amount, uint256 currentClientBalance, address sender)` | `:58-63` | 4 поля |
| `PaymentClientToNative(SettelmentContext ctx)` | `:64` | 1 struct-поле |
| `NativeAddressSet(string indexed nativeId, address nativeAddress)` | `:65` | — |
| `BackFundsToClient(string userId, address reciever, uint256 amount)` | `:66` | опечатка `reciever` |
| `ChangeAdmin(address newAdmin)` | `:67` | используется в `initialize` и `changeAdmin` |

Новое событие для SC-2 — `MaxValiditySet(uint256)` (в том же стиле именованных полей).

### 2.4 Ошибки (custom errors)

| Ошибка | Строка |
| --- | --- |
| `OnlyAdmin()` | `:69` |
| `OnlyOwner()` | `:70` |
| `InsufficientClientBalanceForSessionSettelment(SettelmentContext ctx)` | `:71` |
| `NativeAddressIsOutForSessionSettelment(SettelmentContext ctx)` | `:72` |
| `InsufficientContractBalanceForSessionSettelment(SettelmentContext ctx)` | `:73` |
| `InsufficientClientBalanceForBackFunds(string,address,uint256,uint256)` | `:75-80` |
| `InsufficientContractBalanceForBackFunds(string,address,uint256,uint256)` | `:82-87` |
| `InvalidSignature()` | `:88` |
| `NonceAlreadyUsed()` | `:89` |
| `InvalidNativeAddress()` | `:90` |
| `EmptyNativeId()` | `:91` |
| `EmptyNonce()` | `:92` |
| `FeeTooHigh(uint256 feePercentage)` | `:93` |
| `InvalidFeeCollector()` | `:94` |

Новые ошибки для SC-2 (добавить в этот блок, стиль — без параметров или с одним
параметром, как существующие): `SignatureExpired()`, `DeadlineTooFar()`,
`InvalidMaxValidity()`, `InvalidAdmin()`.

### 2.5 Константы и ручной слот

| Элемент | Строки |
| --- | --- |
| `STORAGE_LOCATION` (EIP-7201, `0x52df...8cb00`) | `:96-98` |
| `ASSIGNMENT_TYPEHASH` = `keccak256("NativeAddressAssignment(string nativeId,address nativeAddress,string nonce)")` | `:100-101` |

**`ASSIGNMENT_TYPEHASH` задан вручную** и не содержит `deadline`. Для SC-2 его нужно
переписать на
`keccak256("NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)")`
(порядок типов и полей — под вопросом, см. §9, вопрос 2). Struct
`NativeAddressAssignment` при этом либо тоже обновить (добавить `uint256 deadline`),
либо удалить как мёртвый код — на хэш это не влияет, т.к. хэш ручной.

### 2.6 Структура хранилища `ContractStorage` (порядок полей критичен)

`contracts/SettelmentsControl.sol:103-112`:

| # | Поле | Тип | Строка |
| --- | --- | --- | --- |
| 1 | `clientBalances` | `mapping(bytes32 => ClientBalance)` | `:104` |
| 2 | `nativeAddresses` | `mapping(bytes32 => address)` | `:105` |
| 3 | `usedNonces` | `mapping(bytes32 => bool)` | `:106` |
| 4 | `token` | `IERC20WithAuthorization` | `:107` |
| 5 | `admin` | `address` | `:108` |
| 6 | `owner` | `address` | `:109` |
| 7 | `feePercentage` | `uint256` | `:110` |
| 8 | `feeCollector` | `address` | `:111` |

Новое поле `uint256 maxValidity` добавляется **в конец** структуры (после
`feeCollector`, `:111`) — это дописывает новый слот в конец namespaced-области и не
меняет раскладку существующих полей (см. §5 про EIP-7201).

### 2.7 Конструктор, доступ к хранилищу, модификаторы

| Элемент | Строки | Примечание |
| --- | --- | --- |
| `constructor()` → `_disableInitializers()` | `:114-116` | защита от инициализации логики напрямую |
| `_getContractStorage()` (assembly `$.slot := STORAGE_LOCATION`) | `:118-127` | — |
| `onlyAdmin` (сверка `msg.sender != $.admin`) | `:129-135` | — |
| `onlyOwner` (сверка `msg.sender != $.owner`) | `:137-143` | **сейчас нигде не используется** (I-01) |

### 2.8 `initialize`

`contracts/SettelmentsControl.sol:145-161`. Сигнатура — **5 параметров**:

```solidity
function initialize(
    address _token,
    address _admin,
    address _owner,
    uint256 _feePercentage,
    address _feeCollector
) external initializer
```

| Строка | Что происходит |
| --- | --- |
| `:152` | `__EIP712_init("SettelmentsControl", "1.0")` — имя и версия домена EIP-712 |
| `:153` | `if (_feePercentage > 100) revert FeeTooHigh(_feePercentage);` |
| `:154-159` | присваивание `token`, `admin`, `owner`, `feePercentage`, `feeCollector` |
| `:160` | `emit ChangeAdmin(_admin);` |

Для SC-2 добавляется **6-й параметр `_maxValidity`** с проверкой `_maxValidity > 0`
(новая ошибка `InvalidMaxValidity` или отдельная — уточняется на плане) и
присваиванием `$.maxValidity = _maxValidity`. Валидаций `_token/_admin/_owner/_feeCollector`
на `address(0)` нет (M-02) — **вне скоупа** SC-2.

### 2.9 `changeAdmin` и `getAdmin`

| Функция | Строки | Примечание |
| --- | --- | --- |
| `changeAdmin(address newAdmin) external onlyAdmin` | `:336-340` | **без проверки `newAdmin != address(0)`** (M-01), модификатор `onlyAdmin` (I-01 требует перевести на `onlyOwner`) |
| `getAdmin() external view returns (address)` | `:342-345` | — |

Для SC-2: `changeAdmin` → `onlyOwner` + `if (newAdmin == address(0)) revert InvalidAdmin();`
Событие `ChangeAdmin(newAdmin)` сохраняется.

### 2.10 `setNativeAddressWithSignature`

`contracts/SettelmentsControl.sol:353-403`. Сигнатура — **6 параметров**:

```solidity
function setNativeAddressWithSignature(
    string calldata nativeId,
    address nativeAddress,
    string calldata nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external onlyAdmin
```

| Строка | Что происходит |
| --- | --- |
| `:360` | `onlyAdmin` (ретранслятор — бэк, сохраняется) |
| `:362-364` | `EmptyNativeId` |
| `:365-367` | `InvalidNativeAddress` (проверка `nativeAddress != address(0)`) |
| `:368-370` | `EmptyNonce` |
| `:372` | `ContractStorage storage $ = _getContractStorage();` |
| `:374-377` | `nonceHash` + `usedNonces` → `NonceAlreadyUsed` |
| `:379-386` | `structHash = keccak256(abi.encode(ASSIGNMENT_TYPEHASH, keccak256(bytes(nativeId)), nativeAddress, keccak256(bytes(nonce))))` |
| `:388` | `digest = _hashTypedDataV4(structHash)` |
| `:390` | `signer = ecrecover(digest, v, r, s)` |
| `:392-394` | `if (signer == address(0)) revert InvalidSignature();` — **единственная** проверка подписи (H-01) |
| `:396` | `$.usedNonces[nonceHash] = true;` |
| `:398-400` | `nativeHash` + `$.nativeAddresses[nativeHash] = nativeAddress;` |
| `:402` | `emit NativeAddressSet(nativeId, nativeAddress);` |

Для SC-2:
- добавить параметр `uint256 deadline` (итоговая сигнатура — 7 параметров; место
  параметра — открытый вопрос, см. §9);
- включить `deadline` в `structHash` (`abi.encode(ASSIGNMENT_TYPEHASH, ..., deadline)`);
- заменить `ecrecover` на `ECDSA` (см. §4) и добавить проверку
  `if (signer != nativeAddress) revert InvalidSignature();` **до** `:396`;
- проверки `block.timestamp <= deadline` (`SignatureExpired`) и
  `deadline - block.timestamp > maxValidity` (`DeadlineTooFar`) — также **до** `:396`
  (инвариант: невалидная/просроченная подпись не «сжигает» nonce).

### 2.11 Остальные функции (не затрагиваются, для полноты)

- `topUpClientBalance` (`:163-201`), `_buildSettelmentContext` (`:203-234`),
  `paymentClientToNative` (`:236-284`), `backFundsToClient` (`:286-324`),
  `getBalance` (`:326-333`), `isNonceUsed` (`:347-351`), `getNativeAddress` (`:405-411`),
  `isNativeAddressSet` (`:413-419`), `setFeeConfig` (`:421-431`), `getFeeConfig` (`:433-436`).

Замечание: в `ContractStorage` нет отдельного поля `nativeId`; привязка хранится как
`nativeAddresses[keccak256(nativeId)] = address`. Перезапись этой записи в `:400` и есть
«перезапись привязки», которую PRD фиксирует как допустимую фичу (без изменений).

---

## 3. Используемые паттерны

### 3.1 EIP-712 (домен и `_hashTypedDataV4`)

- Контракт наследует `EIP712Upgradeable` (`:30`) и инициализирует домен в
  `__EIP712_init("SettelmentsControl", "1.0")` (`:152`) — имя `SettelmentsControl`,
  версия `1.0`.
- `_hashTypedDataV4(structHash)` — наследуемый метод (`EIP712Upgradeable.sol:108-110`):
  `MessageHashUtils.toTypedDataHash(_domainSeparatorV4(), structHash)`.
- Доменный сепаратор строится динамически из `(name, version, chainid, address(this))`
  (`EIP712Upgradeable.sol:89-91`); в upgradeable-версии кэш не используется — сепаратор
  всегда пересобирается от `address(this)` (комментарий `EIP712Upgradeable.sol:28-30`).
- `EIP712Upgradeable` хранит своё состояние в собственном EIP-7201 слоте
  `0xa16a46d9...d100` (`EIP712Upgradeable.sol:47-48`) — отдельно от `STORAGE_LOCATION`
  контракта; коллизий нет (подтверждено аудитом, §7 «Положительные стороны»).

### 3.2 EIP-7201 (namespaced storage / ручной слот)

- `STORAGE_LOCATION = 0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00`
  (`:97-98`), доступ через `_getContractStorage()` (assembly, `:118-127`).
- **Всё персистентное состояние — внутри `ContractStorage`.** Добавление
  `uint256 maxValidity` в конец структуры (`:111`) добавляет новый слот, не трогая
  существующую раскладку; это безопасно для upgradeable-паттерна. НЕЛЬЗЯ добавлять
  переменные состояния верхнего уровня контракта (AGENTS.md) и нельзя переставлять
  существующие поля.
- Примечание (I-02): в комментарии `:96` опечатка `"SettelmentControle.storage"`
  (лишняя `e`); само значение `STORAGE_LOCATION` корректно — не относится к SC-2.

### 3.3 ECDSA (OpenZeppelin) — см. §4

---

## 4. Доступность и сигнатуры `ECDSA`

- Установленные версии: `@openzeppelin/contracts@5.3.0`,
  `@openzeppelin/contracts-upgradeable@5.3.0` (из `package.json`).
- Файл **существует только** в `contracts`:
  `node_modules/@openzeppelin/contracts/utils/cryptography/ECDSA.sol`
  (заголовок «last updated v5.1.0»).
- В `node_modules/@openzeppelin/contracts-upgradeable/utils/cryptography/` есть **только**
  `EIP712Upgradeable.sol` — **`ECDSAUpgradeable` отсутствует**. `ECDSA` — stateless
  библиотека, для неё upgradeable-вариант не нужен. `EIP712Upgradeable` сам импортирует
  `MessageHashUtils` из `@openzeppelin/contracts` (`EIP712Upgradeable.sol:6`), т.е.
  смешивание пакетов — штатная практика.

**Рекомендуемый импорт:**
```solidity
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
```

**Точные сигнатуры (вариант с раздельными `v`/`r`/`s`):**
- `recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address)` — `ECDSA.sol:160-164`
- `tryRecover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address recovered, RecoverError err, bytes32 errArg)` — `ECDSA.sol:128-154`

Варианты с `bytes memory signature` и `(r, vs)` также есть, но контракт получает
`v`/`r`/`s` раздельными параметрами, поэтому используется overload с `v, r, s`.

**Ключевой нюанс (риск из PRD §«Риски»):** `recover` при некорректной подписи ревертит
**библиотечными** ошибками `ECDSAInvalidSignature()` / `ECDSAInvalidSignatureS(bytes32)` /
`ECDSAInvalidSignatureLength(uint256)` (`ECDSA.sol:169-179`), а не кастомной
`InvalidSignature()` контракта. Чтобы сохранить различимую ошибку `InvalidSignature`,
нужно использовать `tryRecover` и проверять `RecoverError`:

- `RecoverError.InvalidSignatureS` — high-`s` (маллеабельность, L-02);
- `RecoverError.InvalidSignature` — `signer == address(0)` (некорректный `v`/подпись).

Оба случая должны приводить к `revert InvalidSignature()`. `tryRecover` включает
проверку каноничности `s` (`s <= n/2`, `ECDSA.sol:143-145`) и, косвенно, `v ∈ {27,28}`
(некорректный `v` даёт `signer == 0`).

---

## 5. Прокси — не затрагивается

`contracts/SettelmentsControlProxy.sol` (52 строки) — самостоятельный ERC1967-прокси:

- наследует `ERC1967Proxy` (`:11`), конструктор `ERC1967Proxy(implementation, "")` +
  `ERC1967Utils.changeAdmin(msg.sender)` (`:15-17`);
- собственные функции управления прокси: `changeProxyAdmin` (`:29-31`), `getProxyAdmin`
  (`:34-36`), `getImpl` (`:39-41`), `setImpl` (`:44-46`), блокировка ETH (`:49-51`).

Он хранит своего администратора через `ERC1967Utils` и **никак не связан** с
`admin`/`owner`/`changeAdmin`/`initialize` реализации. Изменения в
`SettelmentsControl` (включая новую сигнатуру `initialize` и перевод `changeAdmin` на
`onlyOwner`) его не затрагивают. **Файл менять не нужно.**

---

## 6. Потребители ABI (станут/уже неконсистентны — синхронизация вне скоупа)

### 6.1 Сабграф The Graph — ABI сильно устарел

`thegraph/abis/SettelmentsControl.json` содержит **29 записей** и описывает **более
старую версию** контракта, чем текущая. В нём присутствуют несуществующие сейчас
сущности:

- функции: `INITIALIZER_ADDRESS()`, `owner()`, `multicall(bytes[])`,
  `withdrawFundsToNative(string,address,uint256)`, `withdrawTokens(address,uint256)`,
  `topUpClientBalance(uint256,string)`, `initialize(address,address)` (2 параметра!),
  `paymentClientToNative(string,string,uint256,string,uint256,uint256)` (без struct);
- события: `BalanceUpdated(address,uint256)`, `Initialized(uint64)`,
  `WithdrawFundsToNative(string,address,uint256)` и
  `PaymentClientToNative(string,uint256,string,uint256,uint256,string,uint256,uint256)`
  (8 полей, а не `SettelmentContext`).

Это несовместимо с текущим контрактом (где `PaymentClientToNative(SettelmentContext)`,
нет `BalanceUpdated`/`Initialized`/`withdrawFundsToNative`/`withdrawTokens` и
`initialize` из 5 параметров). Соответственно:
- `thegraph/schema.graphql` — entities для старых событий (`BalanceUpdated`,
  `Initialized`, `WithdrawFundsToNative`, `PaymentClientToNative.nativeBalance`);
- `thegraph/subgraph.yaml` — `eventHandlers` со старыми сигнатурами (`:30-43`);
- `thegraph/src/settelments-control.ts` — mapping для старых событий.

`thegraph/networks.json` и `subgraph.yaml` адресуют `0x51de3ac5...e6675386`,
`startBlock: 22033296`. Всё это — синхронизация, вынесенная из SC-2.

### 6.2 Тесты Hardhat — уже не соответствуют ABI (I-03)

`test/SettelmentsControl.ts`:
- `initialize(await token.getAddress(), admin.address)` — **2 аргумента** (`:37`), а
  текущий `initialize` ожидает 5 (станет 6);
- ссылки на удалённые/переименованные функции: `topUpClientBalance(amount, userId)`
  (`:67`), `withdrawFundsToNative` (`:185`), `withdrawTokens` (`:300`);
- `getBalance(...).clientBalance` / `.nativeBalance` (`:73-74`) — структура сейчас
  `{balance, lastInboundAddress}`;
- старый порядок аргументов события `PaymentClientToNative` (`:116`).

`test/SettelmentsControlProxy.ts` — также устарел (по аудиту I-03). Вне скоупа.

### 6.3 Деплой-скрипт (H-02)

`scripts/deploy.ts:111-116` вызывает `initialize` с 2 аргументами
(`args: [erc20Address, account.address]`) — комментарий «Token address and admin
address». Это уже сломано для текущих 5 параметров; после SC-2 станет 6 (добавится
`_maxValidity`). `INITIALIZER_ADDRESS`/`onlyInitializer`, упомянутые в AGENTS.md, в
контракте отсутствуют. Исправление скрипта — вне скоупа SC-2 (зафиксировано в PRD,
риск «изменение сигнатуры `initialize`»).

---

## 7. Компилятор (`hardhat.config.ts`)

- Solidity `0.8.28` (`:9`), optimizer `enabled: true, runs: 1000` (`:11-14`).
- **`viaIR` не задан** → выключен (значение по умолчанию). Критерий успеха — `npx
  hardhat compile` возвращает 0 без `viaIR`.
- `networks`/`etherscan` закомментированы (`:17-45`); `gasReporter.enabled = true` (`:28-30`).
- Базовое состояние: `npx hardhat compile` на текущем дереве выдаёт «Nothing to
  compile» — контракт после SC-1 компилируется (C-01 закрыт).

Риск, связанный с компилятором: добавление 7-го параметра `deadline` в
`setNativeAddressWithSignature` и локальной переменной `maxValidity` немного
увеличивает стек, но функция существенно проще `paymentClientToNative` (нет 11-полевых
struct/ошибок), поэтому повторный «Stack too deep» маловероятен — однако его стоит
проверить на плане/реализации.

---

## 8. Ограничения и риски

1. **Порядок проверок критичен** (PRD §«Риски»): проверка подписи
   (`signer == nativeAddress`), `SignatureExpired` и `DeadlineTooFar` должны
   выполняться **до** `$.usedNonces[nonceHash] = true` (`:396`), иначе невалидная
   подпись будет «сжигать» nonce.
2. **`ECDSA.recover` ревертит библиотечными ошибками**, а не `InvalidSignature` —
   использовать `tryRecover` (см. §4), чтобы не «прятать» revert библиотеки за другой
   ошибкой.
3. **Изменение `ASSIGNMENT_TYPEHASH`/`structHash`** (добавление `deadline`) ломает
   совместимость со старыми подписанными payload — приемлемо, продукт не в проде.
4. **`ContractStorage` раскладка**: `maxValidity` добавляется в конец структуры;
   запрещено переставлять поля или добавлять state-переменные верхнего уровня.
5. **Перевод `changeAdmin` на `onlyOwner`**: если `owner == admin`, разграничение ролей
   теряется; `owner` задаётся в `initialize` и должен быть под контролем.
6. **Изменение сигнатуры `initialize`** (6-й параметр `_maxValidity`) дополнительно
   ломает уже нерабочий `scripts/deploy.ts` и off-chain вызывающих (синхронизация вне
   скоупа).
7. **Слишком малый `maxValidity`** может вызывать `DeadlineTooFar` у легитимных
   пользователей (медленное email-подтверждение); слишком большой — обесценивает
   `deadline`. Значение задаётся при инициализации и меняется только `owner`.
8. **`NativeAddressAssignment` — мёртвая структура** (`:38-42`): при обновлении
   typehash решить, обновлять ли структуру (добавить `deadline`) или удалить. На
   фактический хэш не влияет (хэш ручной).
9. **`nonce` остаётся `string`** и генерируется бэком; перезапись
   `nativeAddresses[nativeHash]` — допустимая фича (без изменений).

---

## 9. Открытые технические вопросы

1. **Позиция параметра `deadline` в сигнатуре `setNativeAddressWithSignature`**:
   `(nativeId, nativeAddress, nonce, deadline, v, r, s)` или `(..., nonce, v, r, s,
   deadline)`? Влияет на off-chain подписчиков и ABI. Рекомендуется поставить рядом с
   `nonce` (логическая группировка payload) — уточнить на плане.
2. **Точный тип EIP-712 структуры для typehash**: поле `uint256 deadline` в
   `NativeAddressAssignment` — порядок полей `(string nativeId, address nativeAddress,
   string nonce, uint256 deadline)` (продолжение текущего) vs `(uint256 deadline, ...)`
   в начале. Должно совпадать с off-chain подписью. Хэш ручной — важно зафиксировать
   строку `keccak256(...)`.
3. **`recover` vs `tryRecover`**: подтвердить выбор `tryRecover` для сохранения
   `InvalidSignature()` (рекомендация данного исследования).
4. **Порядок проверок `SignatureExpired`/`DeadlineTooFar` относительно
   `NonceAlreadyUsed`**: PRD-вопрос (неблокирующий); инвариант — невалидная/просроченная
   подпись не сжигает nonce. Уточнить точный порядок на плане.
5. **Граничное значение `deadline == block.timestamp`**: PRD задаёт
   `block.timestamp <= deadline` (включительно). Подтвердить, что граница включена.
6. **Имя ошибки для проверки `_maxValidity > 0` в `initialize`**: та же
   `InvalidMaxValidity`, что и в `setMaxValidity`, или отдельная — уточнить.
7. **Обновлять ли/удалять структуру `NativeAddressAssignment`** (мёртвый код) вместе с
   изменением typehash.
8. **Остаётся ли событие `ChangeAdmin`** у `changeAdmin` после перевода на `onlyOwner`
   (PRD не упоминает переименование) — судя по PRD, остаётся.
