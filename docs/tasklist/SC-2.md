# SC-2: Tasklist — верификация подписи назначения адреса носителя (H-01)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-2.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-2.md` (Status: PLAN_APPROVED)
- Исследование: `docs/research/SC-2.md` (Status: RESEARCH)
- ADR: `docs/adr/SC-2.md`
- Аудит (источник H-01, L-02, I-01, M-01, H-02): `docs/audit-reports/2026-08-20.md`

## Контекст

`setNativeAddressWithSignature` (`contracts/SettelmentsControl.sol`) восстанавливает подпись
через `ecrecover`, но проверяет только `signer != address(0)`, а не то, что подписантом
является владелец привязываемого `nativeAddress` (H-01). Тикет: сверять `signer == nativeAddress`,
заменить `ecrecover` на `ECDSA.tryRecover` (L-02, устранение маллеабельности), ввести срок
действия подписи `deadline` (ошибка `SignatureExpired`) и потолок `maxValidity`
(`DeadlineTooFar`), перевести `changeAdmin` с `onlyAdmin` на `onlyOwner` (I-01) + проверку
`newAdmin != address(0)` (M-01, ошибка `InvalidAdmin`), добавить геттер/сеттер `maxValidity`.

**Скоуп:** изменяется только `contracts/SettelmentsControl.sol`. Тесты, deploy-скрипт,
сабграф, прокси, мок-токен и конфиг компилятора (`viaIR` остаётся выключенным) — вне скоупа.

---

## Задачи

### 1. Импортировать `ECDSA`

- [x] Добавить после импорта `EIP712Upgradeable` (`:11-13`) мультистрочный импорт
      `ECDSA` из `@openzeppelin/contracts/utils/cryptography/ECDSA.sol`:

```solidity
import {
    ECDSA
} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
```

**Acceptance-критерии:**
- В `contracts/SettelmentsControl.sol` присутствует импорт `ECDSA` из
      `@openzeppelin/contracts/utils/cryptography/ECDSA.sol` (не `...-upgradeable/...` —
      `ECDSAUpgradeable` не существует), в том же мультистрочном стиле, что и соседние импорты.
- Прочие импорты (`IERC20`, `SafeERC20`, `Initializable`, `EIP712Upgradeable`) не изменены.

---

### 2. Обновить структуру `NativeAddressAssignment` (добавить `deadline`)

- [x] Добавить `uint256 deadline` в конец `struct NativeAddressAssignment` (`:38-42`):

```solidity
struct NativeAddressAssignment {
    string nativeId;
    address nativeAddress;
    string nonce;
    uint256 deadline;
}
```

**Acceptance-критерии:**
- Структура содержит ровно 4 поля в порядке `nativeId, nativeAddress, nonce, deadline`
      (`deadline` — последнее; существующие поля не переставлены).
- Структура по-прежнему объявлена на уровне контракта и не добавляется в `ContractStorage`;
      имя структуры сохранено (совпадает с типом в `ASSIGNMENT_TYPEHASH`).

---

### 3. Объявить событие `MaxValiditySet` и четыре новые ошибки

- [x] Добавить в блок событий (`:58-67`) `event MaxValiditySet(uint256 maxValidity);`
      (в стиле именованных параметров). Событие `ChangeAdmin` сохранить без изменений.
- [x] Добавить в блок ошибок: `SignatureExpired()` и `DeadlineTooFar()` рядом с
      `InvalidSignature()` (`:88`); `InvalidMaxValidity()` и `InvalidAdmin()` — в конец
      блока (после `InvalidFeeCollector()`, `:94`):

```solidity
error SignatureExpired();
error DeadlineTooFar();
error InvalidMaxValidity();
error InvalidAdmin();
```

**Acceptance-критерии:**
- Присутствуют ровно одно объявление `event MaxValiditySet(uint256 maxValidity)` и ровно
      одно объявление каждой из ошибок `SignatureExpired()`, `DeadlineTooFar()`,
      `InvalidMaxValidity()`, `InvalidAdmin()` — все без параметров.
- `ChangeAdmin(address newAdmin)` и существующие ошибки (`OnlyAdmin`, `OnlyOwner`,
      `InvalidSignature`, `NonceAlreadyUsed`, `InvalidNativeAddress`, `EmptyNativeId`,
      `EmptyNonce`, `FeeTooHigh`, `InvalidFeeCollector` и прочие) не изменены.

---

### 4. Обновить `ASSIGNMENT_TYPEHASH` (добавить `deadline`)

- [x] Заменить константу `ASSIGNMENT_TYPEHASH` (`:100-101`) на версию с `deadline` в конце:

```solidity
bytes32 private constant ASSIGNMENT_TYPEHASH =
    keccak256("NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)");
```

**Acceptance-критерии:**
- Строка типа — ровно
      `NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)`
      (порядок `string, address, string, uint256`, `deadline` в конце, без лишних пробелов).
- Константа остаётся `private constant bytes32`, вычисляется через `keccak256(...)`;
      имя `ASSIGNMENT_TYPEHASH` и расположение не меняются.

---

### 5. Добавить `uint256 maxValidity` в конец `ContractStorage`

- [x] После поля `feeCollector` (`:111`) добавить `uint256 maxValidity;` — в конец структуры.

**Acceptance-критерии:**
- `ContractStorage` получил ровно одно новое поле `uint256 maxValidity` — последним;
      порядок существующих полей (`clientBalances`, `nativeAddresses`, `usedNonces`,
      `token`, `admin`, `owner`, `feePercentage`, `feeCollector`) не изменён.
- `STORAGE_LOCATION` (`:96-98`) и `_getContractStorage()` (`:118-127`) не изменены;
      state-переменных верхнего уровня контракта не добавлено (EIP-7201, ручной слот).

---

### 6. `initialize`: 6-й параметр `_maxValidity` и проверка `> 0`

- [x] Добавить `uint256 _maxValidity` последним параметром `initialize` (`:145-161`).
- [x] Добавить проверку `if (_maxValidity == 0) revert InvalidMaxValidity();` (после
      проверки `_feePercentage > 100`).
- [x] Присвоить `$.maxValidity = _maxValidity;` в теле (вместе с остальными присваиваниями).

**Acceptance-критерии:**
- Сигнатура `initialize` — ровно 6 параметров:
      `(address _token, address _admin, address _owner, uint256 _feePercentage,
      address _feeCollector, uint256 _maxValidity)`, модификатор `initializer` сохранён.
- `_maxValidity == 0` ревертится `InvalidMaxValidity()`; при `> 0` значение записывается в
      `$.maxValidity`. Событие для `maxValidity` в `initialize` **не** эмитится
      (консистентно с `feePercentage`/`feeCollector`); `emit ChangeAdmin(_admin)` сохранён.
- Прочая логика `initialize` (`__EIP712_init`, проверка `FeeTooHigh`, присваивание
      `token/admin/owner/feePercentage/feeCollector`) без изменений.

---

### 7. `changeAdmin`: `onlyOwner` + проверка нулевого адреса

- [x] Заменить `changeAdmin` (`:336-340`): модификатор `onlyAdmin` → `onlyOwner`, добавить
      `if (newAdmin == address(0)) revert InvalidAdmin();` перед записью:

```solidity
function changeAdmin(address newAdmin) external onlyOwner {
    if (newAdmin == address(0)) revert InvalidAdmin();
    ContractStorage storage $ = _getContractStorage();
    $.admin = newAdmin;
    emit ChangeAdmin(newAdmin);
}
```

**Acceptance-критерии:**
- `changeAdmin` объявлен с `onlyOwner` (не `onlyAdmin`); вызов от `admin` ревертится
      `OnlyOwner()`, от `owner` — проходит.
- `changeAdmin(address(0))` ревертится `InvalidAdmin()`; при ненулевом `newAdmin` поле
      `$.admin` обновляется и эмитится `ChangeAdmin(newAdmin)` (событие сохранено).

---

### 8. Добавить `getMaxValidity()` и `setMaxValidity(uint256)`

- [x] Добавить после `getAdmin` (`:345`) геттер и сеттер:

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

**Acceptance-критерии:**
- `getMaxValidity()` — `external view returns (uint256)`, возвращает
      `_getContractStorage().maxValidity`.
- `setMaxValidity` — `onlyOwner`; `maxValidity == 0` ревертится `InvalidMaxValidity()`
      (та же ошибка, что и в `initialize`); при успехе обновляется `$.maxValidity` и
      эмитится `MaxValiditySet(maxValidity)`. Вызов от `admin` ревертится `OnlyOwner()`.

---

### 9. `setNativeAddressWithSignature`: новая сигнатура и порядок проверок

- [x] Изменить сигнатуру на 7 параметров — `deadline` после `nonce`, перед `v`:
      `(string calldata nativeId, address nativeAddress, string calldata nonce,
      uint256 deadline, uint8 v, bytes32 r, bytes32 s)`, модификатор `onlyAdmin` сохранён.
- [x] Реализовать точный порядок проверок (критичен — см. Acceptance):

  1. `EmptyNativeId` / `InvalidNativeAddress` / `EmptyNonce` (без изменений);
  2. `NonceAlreadyUsed` (чтение `$.usedNonces[nonceHash]`, **без** «сжигания»);
  3. `SignatureExpired` — строго `block.timestamp > deadline`;
  4. `DeadlineTooFar` — `deadline - block.timestamp > $.maxValidity`;
  5. `structHash`/`digest` с `deadline` в payload, `ECDSA.tryRecover`;
  6. `InvalidSignature` при `err != NoError || signer != nativeAddress`;
  7. только после всех проверок `$.usedNonces[nonceHash] = true`, затем запись
     `$.nativeAddresses[nativeHash] = nativeAddress` и `emit NativeAddressSet(...)`.

**Acceptance-критерии:**
- Сигнатура функции — ровно 7 параметров в указанном порядке; `ecrecover` заменён на
      `ECDSA.tryRecover(digest, v, r, s)` с деструктуризацией
      `(address signer, ECDSA.RecoverError err, )`, `maxValidity` читается инлайн
      (`$.maxValidity`).
- Порядок проверок строго: входные данные → `NonceAlreadyUsed` → `SignatureExpired`
      (строгое `>`, граница `deadline == block.timestamp` валидна) → `DeadlineTooFar` →
      `tryRecover` + `signer == nativeAddress` (`InvalidSignature`) → «сжигание» nonce →
      запись + `emit`. `SignatureExpired` стоит **до** `DeadlineTooFar`, чтобы
      `deadline - block.timestamp` не давал underflow (panic-revert).
- Невалидная (`InvalidSignature`), просроченная (`SignatureExpired`) и «слишком далёкая»
      (`DeadlineTooFar`) подписи **не** расходуют nonce — `$.usedNonces[nonceHash] = true`
      выполняется только после всех проверок.
- `structHash` собирается через `abi.encode(ASSIGNMENT_TYPEHASH, keccak256(bytes(nativeId)),
      nativeAddress, keccak256(bytes(nonce)), deadline)`, `digest = _hashTypedDataV4(structHash)`;
      перезапись привязки и `emit NativeAddressSet(nativeId, nativeAddress)` без изменений.

---

### 10. Финальная проверка: чистая компиляция без `viaIR`

- [x] Проверить сборку на чистом кэше: `rm -rf artifacts cache && npx hardhat compile`
      (без включения `viaIR`; конфиг `hardhat.config.ts` не меняется).

**Acceptance-критерии:**
- Команда `rm -rf artifacts cache && npx hardhat compile` завершается с кодом выхода 0,
      в выводе компилятора нет `Stack too deep`.
- Компиляция проходит при действующей конфигурации (Solidity `0.8.28`, optimizer
      `enabled: true, runs: 1000`, `viaIR` выключен) — правок `hardhat.config.ts` нет.
- `git status` показывает изменения только в `contracts/SettelmentsControl.sol`
      (`artifacts/` и `cache/` игнорируются git'ом); тесты/deploy/сабграф не тронуты.

---

## Примечание по независимости

Задачи 1–8 относятся к одному файлу и выполняются в порядке нумерации: объявления
(импорт, структура, событие/ошибки, typehash, поле хранилища) должны предшествовать их
использованию в `initialize`/`changeAdmin`/`getMaxValidity`/`setMaxValidity`/`setNativeAddressWithSignature`.
Задачи 2–5 (объявления) взаимно независимы и могут выполняться в любом порядке после
задачи 1. Задача 9 зависит от всех объявлений (1–8) и целиком переписывает порядок
проверок в одной функции. Задача 10 — сквозная проверка всего набора.

Критичный инвариант всего тикета (PRD §«Риски», план §2.9): невалидная/просроченная
подпись не «сжигает» nonce — присваивание `$.usedNonces[nonceHash] = true` стоит строго
после всех проверок, а `SignatureExpired` (строгое `>`) — строго до `DeadlineTooFar`
(иначе underflow в `deadline - block.timestamp`).
