# SC-4: Tasklist — совместимость топ-апа с EIP-3009 (H-03)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-4.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-4.md` (Status: PLAN_APPROVED)
- Исследование: `docs/research/SC-4.md`
- ADR: `docs/adr/SC-4.md`
- Аудит (источник H-03): `docs/audit-reports/2026-08-20.md` (`:199-217`)

## Контекст

Находка H-03: `topUpClientBalance` вызывает у токена
`receiveWithAuthorization(...)` (EIP-3009, как у USDC), но мок-токен
`contracts/mock/ERC20Mock.sol` — обычный `ERC20` без этой функции, поэтому
пополнение баланса клиента в текущей конфигурации деплоя/тестов ревертится.

**Скоуп SC-4 — ровно один файл:**
1. `contracts/mock/ERC20Mock.sol` — полноценная реализация EIP-3009 (наследование
   `EIP712` non-upgradeable с `version = "2"`, `receiveWithAuthorization` (split),
   `version()`, `authorizationState()`, nonce-mapping, custom-ошибки).

`SettelmentsControl.sol` **не меняется** (проверка поддержки EIP-3009 в `initialize`
исключена из скоупа по решению пользователя — признана ненадёжной эвристикой).

Вне скоупа: `scripts/deploy.ts`, `test/`, сабграф `thegraph/`, конфиг компилятора
(`viaIR` остаётся выключенным, Solidity `0.8.28`, optimizer `runs=1000`).

Критерий успеха — чистая компиляция:
`rm -rf artifacts cache && npx hardhat compile` → exit 0 (без `viaIR`).

---

## Задачи

### 1. ERC20Mock: наследование `ERC20, EIP712` с доменом `version = "2"`

- [x] В `contracts/mock/ERC20Mock.sol` добавить импорты
      `EIP712` и `ECDSA` из `@openzeppelin/contracts/utils/cryptography/`.
- [x] Заменить `contract ERC20Mock is ERC20` на `contract ERC20Mock is ERC20, EIP712`.
- [x] В конструкторе добавить базовый инициализатор `EIP712(name, "2")` после
      `ERC20(name, symbol)`; число аргументов конструктора не меняется (4:
      `name, symbol, initialAccount, initialBalance`).

**Acceptance-критерии:**
- Декларация контракта — `contract ERC20Mock is ERC20, EIP712`; `EIP712` —
  non-upgradeable (не `EIP712Upgradeable`).
- Список инициализации базовых конструкторов содержит `ERC20(name, symbol) EIP712(name, "2")`
  — версия домена строго `"2"`, `name` пробрасывается из параметра конструктора.
- Сигнатура конструктора остаётся `(string name, string symbol, address initialAccount,
  uint256 initialBalance)`; тела `_mint(initialAccount, initialBalance)` и `mint(...)`
  не изменены.

---

### 2. ERC20Mock: константа typehash, nonce-mapping, событие, ошибки и view-функции

- [x] Добавить `bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH` со значением
      `keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`.
- [x] Добавить `mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationState;`.
- [x] Добавить `event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);`.
- [x] Добавить custom-ошибки `PayeeMustBeCaller()`, `AuthorizationNotYetValid()`,
      `AuthorizationExpired()`, `AuthorizationAlreadyUsed()`, `InvalidAuthorizationSignature()`.
- [x] Добавить `version() external pure returns (string memory)` → `"2"` и
      `authorizationState(address authorizer, bytes32 nonce) external view returns (bool)`.

**Acceptance-критерии:**
- Константа `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` вычисляется как
  `keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`
  (значение = `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8`).
- `_authorizationState` — вложенный mapping `authorizer => nonce => bool` (nonce per
  authorizer, как `authorizationState[from][nonce]` у USDC).
- `version()` возвращает ровно `"2"`; `authorizationState(authorizer, nonce)` возвращает
  `_authorizationState[authorizer][nonce]`.
- Все 5 custom-ошибок объявлены с указанными именами и без параметров.

---

### 3. ERC20Mock: реализация `receiveWithAuthorization` (split-подпись, порядок проверок)

- [x] Добавить `receiveWithAuthorization(address from, address to, uint256 value,
      uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external`.
- [x] Реализовать проверки строго в порядке плана §2.1:
      1. `to != msg.sender` → `PayeeMustBeCaller()`;
      2. `block.timestamp <= validAfter` → `AuthorizationNotYetValid()`;
      3. `block.timestamp >= validBefore` → `AuthorizationExpired()`;
      4. `_authorizationState[from][nonce]` → `AuthorizationAlreadyUsed()`.
- [x] Собрать `structHash` через `keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))`, digest через `_hashTypedDataV4(structHash)`.
- [x] Проверить подпись: `ECDSA.tryRecover(digest, abi.encodePacked(r, s, v))` и при
      `err != NoError || signer != from` → `InvalidAuthorizationSignature()`.
- [x] При успехе пометить nonce, эмитнуть `AuthorizationUsed(from, nonce)` и выполнить `_transfer(from, to, value)`.

**Acceptance-критерии:**
- Функция имеет точную сигнатуру с 9 параметрами в указанном порядке:
  `(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)`.
- Порядок проверок совпадает с планом (payee → not-yet-valid → expired → nonce-used →
  signature); окна **строгие** (`block.timestamp > validAfter`, `block.timestamp < validBefore`).
- Подпись верифицируется как `ECDSA.tryRecover(digest, abi.encodePacked(r, s, v))` с
  маппингом любого `RecoverError` и `signer != from` в `InvalidAuthorizationSignature()` —
  байты собраны в порядке `r ‖ s ‖ v` (65 байт); digest строится через
  `_hashTypedDataV4(structHash)`.
- Nonce помечается как использованный **до** `_transfer`; при валидной подписи
  списываются средства у `from` и зачисляются на `to` (штатная логика ERC20 `_update`).

---

### 4. Финальная проверка: чистая компиляция без `viaIR`

- [x] Проверить сборку на чистом кэше: `rm -rf artifacts cache && npx hardhat compile`
      (без включения `viaIR`; `hardhat.config.ts` не меняется).

**Acceptance-критерии:**
- `rm -rf artifacts cache && npx hardhat compile` завершается с кодом выхода 0, в выводе
  нет `Stack too deep`.
- Компиляция проходит при действующей конфигурации (Solidity `0.8.28`, optimizer
  `enabled: true, runs: 1000`, `viaIR` выключен).
- `git status` показывает изменения только в `contracts/mock/ERC20Mock.sol`
  (`artifacts/` и `cache/` игнорируются git'ом); `contracts/SettelmentsControl.sol`,
  `scripts/deploy.ts`, `test/`, `thegraph/` и `hardhat.config.ts` не тронуты.

---

## Примечание по независимости

Задачи 1–3 относятся к `ERC20Mock` и выполняются последовательно внутри одного файла:
наследование/конструктор (1) → константы/состояние/view-функции (2) →
`receiveWithAuthorization` (3). Задача 4 — сквозная проверка компиляции.

Ключевые инварианты тикета (PRD §«Ограничения», план §3):
- `SettelmentsControl.sol` **не изменяется**.
- В `receiveWithAuthorization` подпись собирается строго как `abi.encodePacked(r, s, v)`
  (порядок `r ‖ s ‖ v`), digest — через `_hashTypedDataV4`; порядок проверок и строгие
  окна `validAfter`/`validBefore` воспроизводят семантику USDC.
