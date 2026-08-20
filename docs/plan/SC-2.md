# SC-2: План — верификация подписи назначения адреса носителя (H-01)

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-2.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-2.md` (Status: RESEARCH)
- Аудит (источник H-01, L-02, I-01, M-01, H-02): `docs/audit-reports/2026-08-20.md`
- ADR (развилки `tryRecover` vs `recover`, судьба структуры): `docs/adr/SC-2.md`

## 1. Components

| Компонент | Файл | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Реализация логики | `contracts/SettelmentsControl.sol` | **Да (единственный файл)** | Проверка `signer == nativeAddress`, замена `ecrecover` на `ECDSA.tryRecover`, добавление `deadline` + `maxValidity`, перевод `changeAdmin` на `onlyOwner` + проверка нулевого адреса, новые ошибки/событие/геттер/сеттер. |
| Прокси | `contracts/SettelmentsControlProxy.sol` | Нет | Не зависит от сигнатур `initialize`/`changeAdmin` реализации (research §5). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Нет | Вне скоупа. |
| Деплой-скрипт | `scripts/deploy.ts` | Нет | Потребитель ABI; уже сломан (H-02), станет несовместим с 6-параметрическим `initialize`. Синхронизация — вне скоупа. |
| Тесты | `test/*.ts` | Нет | Потребители ABI; уже неконсистентны (I-03). Синхронизация — вне скоупа. |
| Сабграф | `thegraph/` | Нет | Потребитель ABI; ABI устарел. Синхронизация — вне скоупа. |
| Конфиг компилятора | `hardhat.config.ts` | Нет | `viaIR` выключен; optimizer `runs=1000`, Solidity `0.8.28`. |

**Итог по скоупу:** изменяется только `contracts/SettelmentsControl.sol`. Никаких правок
тестов, deploy-скрипта, сабграфа, прокси, мок-токена и конфигурации компилятора.

## 2. API contract (целевые интерфейсы и контракты)

Все изменения локализованы в `contracts/SettelmentsControl.sol` (текущая версия — 437
строк). Номера строк ниже — ориентиры по текущей версии.

### 2.1 Импорт `ECDSA`

Добавить после импорта `EIP712Upgradeable` (`:11-13`), в том же мультистрочном стиле:

```solidity
import {
    ECDSA
} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
```

`ECDSAUpgradeable` не существует (research §4); `ECDSA` — stateless-библиотека из
`@openzeppelin/contracts` v5.3.0.

### 2.2 Структура `NativeAddressAssignment` — обновить (добавить `deadline`)

Текущая структура (`:38-42`) — мёртвый код, но её имя совпадает с типом в ручном
`ASSIGNMENT_TYPEHASH`. Решение (см. ADR §Развилка 2): **обновить**, а не удалить,
добавив `uint256 deadline` в конец:

```solidity
struct NativeAddressAssignment {
    string nativeId;
    address nativeAddress;
    string nonce;
    uint256 deadline;
}
```

### 2.3 Событие `MaxValiditySet`

Добавить в блок событий (`:58-67`), в стиле именованных параметров:

```solidity
event MaxValiditySet(uint256 maxValidity);
```

Событие `ChangeAdmin(address newAdmin)` **сохраняется** без изменений (PRD и research §9,
вопрос 8 — не упоминается переименование).

### 2.4 Новые ошибки

Добавить в блок ошибок (`:69-94`):

- `SignatureExpired()` и `DeadlineTooFar()` — рядом с существующей `InvalidSignature()`
  (`:88`), логическая группировка «жизненный цикл подписи»;
- `InvalidMaxValidity()` и `InvalidAdmin()` — в конец блока (после `InvalidFeeCollector()`,
  `:94`).

```solidity
error SignatureExpired();
error DeadlineTooFar();
error InvalidMaxValidity();
error InvalidAdmin();
```

Все — без параметров, в стиле существующих `OnlyAdmin()`/`InvalidSignature()` и т.п.

### 2.5 `ASSIGNMENT_TYPEHASH` — добавить `deadline`

Заменить `:100-101` на:

```solidity
bytes32 private constant ASSIGNMENT_TYPEHASH =
    keccak256("NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)");
```

Порядок типов `(string, address, string, uint256)` — продолжение текущего порядка,
`deadline` в конец. Соответствует обновлённой структуре (§2.2). Хэш ручной — строка
`keccak256(...)` фиксируется как источник истины для off-chain подписи.

### 2.6 `ContractStorage` — добавить `maxValidity` в конец

После `feeCollector` (`:111`) добавить:

```solidity
uint256 maxValidity;
```

Порядок существующих полей (`:104-111`) **не меняется** — `maxValidity` дописывает
новый слот в конец namespaced-области EIP-7201 (research §2.6/§3.2). Запрещено:
переставлять поля и добавлять state-переменные верхнего уровня контракта (AGENTS.md).

### 2.7 `initialize` — 6-й параметр `_maxValidity`

Новая сигнатура (7-й параметр `deadline` сюда не входит — это параметр подписи, см. §2.9):

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

Изменения относительно текущего (`:145-161`): добавлен параметр `_maxValidity`,
проверка `_maxValidity == 0 → InvalidMaxValidity()` и присваивание
`$.maxValidity = _maxValidity`. Событие для `maxValidity` в `initialize` **не**
эмитится (консистентно с `feePercentage`/`feeCollector`, которые задаются без событий).
Валидации `_token`/`_admin`/`_owner`/`_feeCollector` на `address(0)` нет (M-02) — вне
скоупа SC-2.

### 2.8 `changeAdmin` — `onlyOwner` + проверка нулевого адреса

Заменить `:336-340` на:

```solidity
function changeAdmin(address newAdmin) external onlyOwner {
    if (newAdmin == address(0)) revert InvalidAdmin();
    ContractStorage storage $ = _getContractStorage();
    $.admin = newAdmin;
    emit ChangeAdmin(newAdmin);
}
```

Закрывает I-01 (перевод с `onlyAdmin` на `onlyOwner` — модификатор `onlyOwner` (`:137-143`)
становится используемым) и M-01 (проверка `newAdmin != address(0)`). Событие
`ChangeAdmin` сохраняется.

### 2.9 `setNativeAddressWithSignature` — полная сигнатура и порядок проверок

Новая сигнатура (7 параметров; `deadline` размещён после `nonce`, перед `v` — логическая
группировка payload, research §9 вопрос 1):

```solidity
function setNativeAddressWithSignature(
    string calldata nativeId,
    address nativeAddress,
    string calldata nonce,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
) external onlyAdmin
```

**Точный порядок проверок (критичен для сохранения nonce):**

```solidity
// 1. Валидация входных данных (без изменений, `:362-370`)
if (bytes(nativeId).length == 0) revert EmptyNativeId();
if (nativeAddress == address(0)) revert InvalidNativeAddress();
if (bytes(nonce).length == 0) revert EmptyNonce();

ContractStorage storage $ = _getContractStorage();

// 2. NonceAlreadyUsed — дешёвая ранняя проверка (чтение mapping), без «сжигания»
bytes32 nonceHash = keccak256(abi.encodePacked(nonce));
if ($.usedNonces[nonceHash]) revert NonceAlreadyUsed();

// 3. Срок действия подписи (дешёвые timestamp-сравнения, ДО дорогого recover)
//    ВАЖНО: SignatureExpired ДО DeadlineTooFar, иначе `deadline - block.timestamp`
//    даст underflow (Solidity 0.8 -> panic revert).
if (block.timestamp > deadline) revert SignatureExpired();
if (deadline - block.timestamp > $.maxValidity) revert DeadlineTooFar();

// 4. structHash + digest (deadline включён в payload)
bytes32 structHash = keccak256(
    abi.encode(
        ASSIGNMENT_TYPEHASH,
        keccak256(bytes(nativeId)),
        nativeAddress,
        keccak256(bytes(nonce)),
        deadline
    )
);
bytes32 digest = _hashTypedDataV4(structHash);

// 5. Восстановление подписи и сверка signer == nativeAddress
(address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, v, r, s);
if (err != ECDSA.RecoverError.NoError || signer != nativeAddress) {
    revert InvalidSignature();
}

// 6. ТОЛЬКО после всех проверок — «сжигание» nonce
$.usedNonces[nonceHash] = true;

// 7. Запись привязки (без изменений, `:398-402`)
bytes32 nativeHash = keccak256(abi.encodePacked(nativeId));
$.nativeAddresses[nativeHash] = nativeAddress;
emit NativeAddressSet(nativeId, nativeAddress);
```

Ключевые решения по порядку:

- **`NonceAlreadyUsed` раньше `SignatureExpired`/`DeadlineTooFar`** (закрывает PRD-вопрос
  «порядок deadline/DeadlineTooFar относительно NonceAlreadyUsed»): nonce-проверка —
  самое дешёвое раннее отклонение и сохраняет существующий сигнал «повторный nonce» для
  off-chain систем. Иначе повтор с просроченным deadline вернул бы `SignatureExpired`,
  маскируя факт повторного использования. Инвариант PRD соблюдён: «сжигание» nonce
  (`$.usedNonces[nonceHash] = true`) происходит строго **после** всех проверок.
- **`SignatureExpired` до `DeadlineTooFar`**: порядок обязателен для исключения
  underflow в `deadline - block.timestamp` (при `block.timestamp > deadline` разность
  зарезала бы panic-revert в 0.8.x).
- **`tryRecover` + единая `InvalidSignature()`** (см. ADR §Развилка 1): любой
  `RecoverError != NoError` (high-`s`, некорректный `v`) и `signer != nativeAddress`
  ревертятся одной различимой ошибкой `InvalidSignature()`, а не библиотечной.
- **`deadline == block.timestamp` включено** (`block.timestamp > deadline` строго):
  граница срока валидности включена (PRD задаёт `block.timestamp <= deadline`).
- **`maxValidity` читается инлайн** (`$.maxValidity`) — локальная переменная не нужна,
  снижает стек-давление.

### 2.10 `getMaxValidity` и `setMaxValidity`

Добавить после `getAdmin` (`:345`), группируя governance/конфиг-функции:

```solidity
function getMaxValidity() external view returns (uint256) {
    return _getContractStorage().maxValidity;
}

function setMaxValidity(uint256 maxValidity) external onlyOwner {
    if (maxValidity == 0) revert InvalidMaxValidity();
    ContractStorage storage $ = _getContractStorage();
    $.maxValidity = maxValidity;
    emit MaxValiditySet(maxValidity);
}
```

- `setMaxValidity` — `onlyOwner` (консистентно с `changeAdmin`), проверка `> 0`
  (`InvalidMaxValidity`), событие `MaxValiditySet`.
- Проверка `maxValidity == 0` использует **ту же** ошибку `InvalidMaxValidity`, что и
  в `initialize` (§2.7) — единая ошибка для нулевого потолка (research §9 вопрос 6).

## 3. Data flows

### 3.1 Поток данных `setNativeAddressWithSignature` (после изменения)

```
входы: nativeId, nonce (string calldata), nativeAddress (address),
        deadline, v (uint8), r, s (bytes32)
        │
        ▼
EmptyNativeId ← bytes(nativeId).length == 0
InvalidNativeAddress ← nativeAddress == address(0)
EmptyNonce ← bytes(nonce).length == 0
        │
        ▼
$ = _getContractStorage()
nonceHash = keccak256(abi.encodePacked(nonce))
        │
NonceAlreadyUsed ← $.usedNonces[nonceHash] == true        (чтение, без сжигания)
        │
SignatureExpired ← block.timestamp > deadline             (строго после)
DeadlineTooFar   ← deadline - block.timestamp > $.maxValidity   (safe: deadline >= now)
        │
        ▼
structHash = keccak256(abi.encode(
    ASSIGNMENT_TYPEHASH,                // с deadline в typehash
    keccak256(bytes(nativeId)),
    nativeAddress,
    keccak256(bytes(nonce)),
    deadline))
digest = _hashTypedDataV4(structHash)
        │
        ▼
(signer, err, ) = ECDSA.tryRecover(digest, v, r, s)
        │
InvalidSignature ← err != NoError || signer != nativeAddress
        │
        ▼ (все проверки пройдены)
$.usedNonces[nonceHash] = true            (сжигание nonce)
$.nativeAddresses[keccak256(abi.encodePacked(nativeId))] = nativeAddress
emit NativeAddressSet(nativeId, nativeAddress)
```

### 3.2 Кодирование ABI (влияние на потребителей)

- `setNativeAddressWithSignature`: 6 → 7 параметров (добавлен `uint256 deadline` между
  `nonce` и `v`). Селектор функции меняется.
- `initialize`: 5 → 6 параметров (добавлен `uint256 _maxValidity` в конец). Селектор
  меняется.
- Новые: событие `MaxValiditySet(uint256)`, ошибки `SignatureExpired()`,
  `DeadlineTooFar()`, `InvalidMaxValidity()`, `InvalidAdmin()`.
- `ASSIGNMENT_TYPEHASH` изменился → ранее выданные EIP-712 подписи невалидны (осознанно,
  продукт не в проде).

## 4. NFR (нефункциональные требования)

1. **Компиляция без `viaIR`:** `rm -rf artifacts cache && npx hardhat compile` → exit 0,
   без `Stack too deep`. Solidity `0.8.28`, optimizer `enabled: true, runs: 1000`,
   `viaIR` выключен (конфиг не меняется).
2. **Хранилище:** `STORAGE_LOCATION` (`:96-98`) и `_getContractStorage()` (`:118-127`)
   не меняются; `ContractStorage` получает ровно одно новое поле `maxValidity` в конец
   (`:112`), порядок существующих полей не меняется. State-переменные верхнего уровня
   не добавляются.
3. **Стек в `setNativeAddressWithSignature`:** функция проще `paymentClientToNative`
   (нет 11-полевого struct/ошибок). `maxValidity` читается инлайн (`$.maxValidity`),
   третий возврат `tryRecover` (`errArg`) отбрасывается через пустой tuple `( , , )`.
   **Если** на чистом кэше возникнет `Stack too deep` — вынести вычисление
   `structHash`+`digest` в internal-хелпер
   `_assignmentDigest(string calldata nativeId, address nativeAddress, string calldata nonce, uint256 deadline) returns (bytes32)`
   (но сначала оценить необходимость, см. Risks п. 3).
4. **Семантика nonce:** невалидная (`InvalidSignature`), просроченная
   (`SignatureExpired`) и «слишком далёкая» (`DeadlineTooFar`) подписи **не** расходуют
   nonce — `$.usedNonces[nonceHash] = true` выполняется только после всех проверок.
5. **Нет underflow:** `SignatureExpired` (строгое `>`) проверяется до `DeadlineTooFar`,
   поэтому `deadline - block.timestamp` вычисляется только при `deadline >= block.timestamp`.
6. **Неизменность прочей логики:** `nonce` остаётся `string`; перезапись
   `nativeAddresses[nativeHash]` — допустимая фича без изменений; `topUpClientBalance`,
   `paymentClientToNative`, `backFundsToClient`, `getBalance`, `getNativeAddress`,
   `isNativeAddressSet`, `setFeeConfig`, `getFeeConfig` не затрагиваются.

## 5. Trade-off (явно зафиксирован)

**Изменение ABI** (сигнатуры `setNativeAddressWithSignature`/`initialize`, новый typehash,
событие `MaxValiditySet`, 4 новых ошибки) ломает off-chain потребителей:
- тесты `test/` (уже неконсистентны, I-03),
- deploy-скрипт `scripts/deploy.ts` (уже сломан, H-02),
- сабграф `thegraph/` (ABI устарел).

Это **допустимо**: продукт не в проде; тесты/deploy/сабграф синхронизируются отдельными
задачами вне SC-2 (PRD §«Ограничения», risk про H-02). Осознанная цена за корректную
верификацию владения адресом (H-01), срок/потолок действия подписи и задействование
роли `owner` (I-01).

Альтернативы (сохранить ABI) не рассматривались — без добавления `deadline`/`maxValidity`
невозможно реализовать срок действия подписи, а сверка `signer == nativeAddress` не
требует изменения сигнатуры, но требует изменения ABI ошибок/событий в любом случае.

## 6. Risks

1. **Изменение ABI и typehash.** Ломает совместимость со старыми подписанными payload
   и off-chain вызывающими. Митигация: продукт не в проде; синхронизация — отдельные
   задачи вне SC-2; строка `ASSIGNMENT_TYPEHASH` зафиксирована в §2.5 как источник
   истины.
2. **Библиотечные реверты `ECDSA`.** `recover` ревертит `ECDSAInvalidSignature*`, а не
   `InvalidSignature`. Митигация: используется `tryRecover` с маппингом любого
   `RecoverError` и `signer != nativeAddress` в единую `InvalidSignature()` (ADR).
3. **`Stack too deep`.** Добавление 7-го параметра `deadline` и деструктуризации
   `tryRecover` повышает стек. Митигация: минимизация локальных переменных (инлайн
   `$.maxValidity`, отбрасывание `errArg`); при нехватке — internal-хелпер
   `_assignmentDigest` (NFR п. 3). Функция существенно проще `paymentClientToNative`,
   риск низкий, но проверяется на чистом кэше.
4. **Underflow в `deadline - block.timestamp`.** Если переставить проверки,
   при `block.timestamp > deadline` вычитание даст panic-revert. Митигация: жёсткий
   порядок `SignatureExpired` → `DeadlineTooFar` (зафиксировано в §2.9).
5. **«Сжигание» nonce при невалидной подписи.** Митигация: `$.usedNonces[nonceHash] = true`
   выполняется строго после всех проверок (инвариант PRD §«Риски»).
6. **Потеря разграничения ролей при `owner == admin`.** Перевод `changeAdmin` на
   `onlyOwner` требует контроля за адресом `owner` (задаётся в `initialize`). Митигация:
   значения `_owner`/`_admin` выбираются при инициализации; в скоупе SC-2 не вводится
   проверка их различия (вне скоупа).
7. **Слишком малый/большой `maxValidity`.** Малый — `DeadlineTooFar` у легитимных
   пользователей (медленное email-подтверждение); большой — обесценивает `deadline`.
   Митигация: значение задаётся при инициализации, меняется только `owner` через
   `setMaxValidity`.
8. **Не выходить за скоуп.** Прочие находки (M-02 валидация `address(0)` в `initialize`,
   H-02 deploy, I-03 тесты, I-02 опечатка в комментарии слота) не затрагиваются.

## 7. Open questions

- Нет блокирующих. Закрытые вопросы research §9:
  - позиция `deadline` — после `nonce` (`(nativeId, nativeAddress, nonce, deadline, v, r, s)`);
  - тип/порядок EIP-712 структуры — `(string, address, string, uint256)`, `deadline` в конец;
  - `recover` vs `tryRecover` — `tryRecover` (ADR);
  - порядок `SignatureExpired`/`DeadlineTooFar` относительно `NonceAlreadyUsed` —
    `NonceAlreadyUsed` раньше, «сжигание» — после всех проверок (§2.9);
  - граница `deadline == block.timestamp` — включена (строгое `>` для expired);
  - имя ошибки `_maxValidity == 0` в `initialize` — та же `InvalidMaxValidity`;
  - структура `NativeAddressAssignment` — обновить (ADR);
  - `ChangeAdmin` — сохраняется.
- Остаточный эмпирический вопрос — достаточность стека в `setNativeAddressWithSignature`
  без `viaIR` — проверяется критерием приёмки на чистом кэше; запасной ход — internal-хелпер
  `_assignmentDigest` (NFR п. 3, Risks п. 3).

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `Stack too deep`,
  при `viaIR` выключенном (optimizer `runs=1000`, Solidity `0.8.28`).
- В `contracts/SettelmentsControl.sol`:
  - импорт `ECDSA`; `ASSIGNMENT_TYPEHASH` содержит `...,uint256 deadline)`;
  - структура `NativeAddressAssignment` содержит `uint256 deadline`;
  - `ContractStorage` содержит `uint256 maxValidity` в конце;
  - `initialize` имеет 6 параметров (в т.ч. `_maxValidity` с проверкой `> 0`);
  - `changeAdmin` — `onlyOwner` с проверкой `newAdmin != address(0)` (`InvalidAdmin`);
  - `getMaxValidity()` / `setMaxValidity(uint256)` (`onlyOwner`, `> 0` → иначе
    `InvalidMaxValidity`, событие `MaxValiditySet`);
  - `setNativeAddressWithSignature` — 7 параметров с `deadline`, использует
    `ECDSA.tryRecover`, сверяет `signer == nativeAddress` (`InvalidSignature`), проверяет
    `block.timestamp > deadline` (`SignatureExpired`) и
    `deadline - block.timestamp > maxValidity` (`DeadlineTooFar`), все проверки — до
    `$.usedNonces[nonceHash] = true`.
- Невалидная/просроченная подпись не расходует nonce.
