# SC-8: Таск-лист — operationId (ключ идемпотентности bytes32 + indexed)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-8.prd.md`
- План: `docs/plan/SC-8.md`
- Исследование: `docs/research/SC-8.md`
- ADR: `docs/adr/SC-8.md`

## Контекст и скоуп

В `SettelmentsControl` вводится сквозной бизнес-ключ идемпотентности `bytes32 operationId`
первым аргументом трёх функций: `topUpClientBalance`, `paymentClientToNative`,
`backFundsToClient`. Контракт ведёт `mapping(bytes32 => bool) processedOperations` в
`ContractStorage` и отклоняет повторную обработку одного ключа (`OperationAlreadyProcessed`),
а нулевой ключ — ошибкой `EmptyOperationId`. Ключ «сгорает» (`_markProcessed`) только после
успешного исполнения (внешние вызовы + изменение баланса), перед `emit` — revert внешнего
вызова не сжигает ключ (checks-effects-interactions).

**Скоуп: только `contracts/SettelmentsControl.sol` + тесты TS/viem и Foundry.**

Не трогаем: сабграф (`thegraph/`) и `scripts/deploy.ts` — отдельные тикеты. Прокси, мок
(`ERC20Mock`), `test/helpers/fixture.ts` и `test/TEST_PLAN.md`... `TEST_PLAN.md` дополняется
новыми кейсами (§ ниже), но остаётся тестовой документацией, не кодом контрактов.

Селекторы ошибок (сверены с research §2.7 / plan §2.4):
- новые: `OperationAlreadyProcessed(bytes32)` = `0xe18b4060`, `EmptyOperationId()` = `0xfab3e6eb`
- обновлённые (добавлен `operationId` первым параметром):
  `InsufficientClientBalanceForSessionSettelment` = `0x7eebe94d` (была `0xae895493`),
  `NativeAddressIsOutForSessionSettelment` = `0x03ebc37f` (была `0xc4df6dea`),
  `InsufficientContractBalanceForSessionSettelment` = `0x899b9fa7` (была `0x7f5fdf44`)

---

## Задачи

### Контракт

- [x] **1. Хранилище — `processedOperations`**
  Добавить `mapping(bytes32 => bool) processedOperations;` **в группу mapping'ов** структуры
  `ContractStorage` (после `usedNonces`, перед скалярами).
  - Acceptance: `git diff contracts/` показывает ровно одно новое поле — в группе mapping'ов;
    `STORAGE_LOCATION` (строка 105-106) не изменён; нет новых state-переменных верхнего уровня.

- [x] **2. Ошибки**
  Добавить `error OperationAlreadyProcessed(bytes32 operationId);` и `error EmptyOperationId();`
  рядом с существующими ошибками (`:69-102`). Дополнить три ошибки `paymentClientToNative`
  параметром `bytes32 operationId` первым аргументом:
  `InsufficientClientBalanceForSessionSettelment`, `NativeAddressIsOutForSessionSettelment`,
  `InsufficientContractBalanceForSessionSettelment` (в 3 revert-сайтах передавать `operationId`).
  - Acceptance: `bytes4(keccak256("OperationAlreadyProcessed(bytes32)")) == 0xe18b4060` и
    `bytes4(keccak256("EmptyOperationId()")) == 0xfab3e6eb`; обновлённые селекторы трёх ошибок —
    `0x7eebe94d`/`0x03ebc37f`/`0x899b9fa7` (проверяется после компиляции или через `cast sig`).

- [x] **3. Хелпер `_markProcessed`**
  Добавить `function _markProcessed(bytes32 operationId) internal` — тело: получает
  `ContractStorage storage $ = _getContractStorage();` и ставит
  `$.processedOperations[operationId] = true;`.
  - Acceptance: хелпер `internal` (не `private`), мутирует storage; компилируется без
    предупреждений solhint о «функция должна быть view» (нет, она записывает).

- [x] **4. `topUpClientBalance`**
  `bytes32 operationId` первым аргументом; в начале тела:
  `if (operationId == bytes32(0)) revert EmptyOperationId();` затем
  `if ($.processedOperations[operationId]) revert OperationAlreadyProcessed(operationId);`;
  после `receiveWithAuthorization` и `clientBalance.balance += value` / `totalClientBalance += value`
  / `lastInboundAddress = from` — вызов `_markProcessed(operationId);` перед `emit`.
  Событие: `TopUpClientBalance(bytes32 indexed operationId, string userId, uint256 amount, uint256 currentClientBalance, address sender)`.
  - Acceptance: `npx hardhat test` кейс первого topUp проходит; повторный вызов с тем же
    `operationId` → revert `OperationAlreadyProcessed`; нулевой `operationId` → revert
    `EmptyOperationId` (до внешних вызовов — мок-баланс не меняется).

- [x] **5. `paymentClientToNative`**
  `bytes32 operationId` первым аргументом; проверки `EmptyOperationId` →
  `OperationAlreadyProcessed` в начале (до `ZeroAmount`/`safeTransfer`); после
  `safeTransfer`'ов и `totalClientBalance -= amount` — `_markProcessed(operationId);` перед `emit`.
  Событие: `PaymentClientToNative(bytes32 indexed operationId, SettelmentContext ctx)`.
  - Acceptance: порядок «внешние переводы → изменение баланса → `_markProcessed` → `emit`»
    соблюдён; `operationId` — отдельный `indexed` параметр рядом со структурой `ctx`.

- [x] **6. `backFundsToClient`**
  `bytes32 operationId` первым аргументом; проверки `EmptyOperationId` →
  `OperationAlreadyProcessed` в начале; после `safeTransfer` и `balance.balance = ...` /
  `totalClientBalance -= amount` — `_markProcessed(operationId);` перед `emit`.
  Событие: `BackFundsToClient(bytes32 indexed operationId, string userId, address reciever, uint256 amount)`
  (опечатка `reciever` сохраняется).
  - Acceptance: повторный вызов с тем же ключом → `OperationAlreadyProcessed`; нулевой ключ →
    `EmptyOperationId`; успешный вызов emits с `indexed operationId`.

- [x] **7. Чистая компиляция**
  `rm -rf artifacts cache && npx hardhat compile` → exit 0.
  - Acceptance: сборка зелёная, без `viaIR` (optimizer `runs=1000`, Solidity `0.8.28`),
    stack-too-deep (C-01) не возвращается; `npx solhint 'contracts/**/*.sol'` без новых ошибок.

### Тестовые хелперы (TS)

- [x] **8. `test/helpers/matchers.ts` — селекторы**
  Добавить в `ERRORS`: `OperationAlreadyProcessed: "0xe18b4060"` и
  `EmptyOperationId: "0xfab3e6eb"`; обновить селекторы трёх ошибок `paymentClientToNative`:
  `InsufficientClientBalanceForSessionSettelment: "0x7eebe94d"`,
  `NativeAddressIsOutForSessionSettelment: "0x03ebc37f"`,
  `InsufficientContractBalanceForSessionSettelment: "0x899b9fa7"`.
  - Acceptance: `matchers.ts` `ERRORS` содержит новые и обновлённые селекторы;
    `npx tsc --noEmit` (если есть) / тесты, использующие `expectRevertCustomError` с этими
    ключами, проходят.

- [x] **9. `test/helpers/actions.ts` — `topUp`**
  Прокинуть `operationId` первым элементом массива args в `topUpClientBalance`; добавить в
  `TopUpOpts` поле `operationId?: \`0x${string}\`` с дефолтом `randomBytes32()` (nonce остаётся
  отдельным полем, не путать).
  - Acceptance: `topUp(fx, userId, value)` без явного `operationId` работает (генерирует
    `randomBytes32()`); `topUp(fx, userId, value, { operationId })` передаёт заданный ключ.

### TS-тесты — адаптация вызовов

- [x] **10. Обновить все вызовы трёх функций под новый первый аргумент**
  Файлы/места (по plan §9): `test/SettelmentsControl/topup.test.ts` (кейс 12),
  `test/SettelmentsControl/roles-and-management.test.ts` (кейсы 45/46/47),
  `test/SettelmentsControl/payment.test.ts` (хелпер `pay` + кейс 20),
  `test/SettelmentsControl/backfunds.test.ts` (хелпер `backFunds` + кейс 30),
  `test/SettelmentsControlProxy.test.ts` (кейс 80).
  - Acceptance: `rg "topUpClientBalance|paymentClientToNative|backFundsToClient" test/` не
    находит вызовов без `operationId` первым аргументом; `npx hardhat test` существующие кейсы
    (адаптированные) зелёные.

### TS-тесты — новые кейсы идемпотентности

- [x] **11. Новые кейсы идемпотентности + `test/TEST_PLAN.md`**
  Для всех трёх функций добавить кейсы:
  - нулевой ключ `bytes32(0)` → revert `EmptyOperationId`;
  - повторный ключ после успеха → revert `OperationAlreadyProcessed`;
  - revert внешнего вызова (`receiveWithAuthorization` с истёкшей авторизацией/уже
    использованным nonce) → ключ не сжигается, retry с тем же `operationId` (для topUp — с
    новым `nonce`) проходит;
  - разные ключи не конфликтуют (две последовательные операции с разными `operationId`).
  Дополнить `test/TEST_PLAN.md` описанием этих кейсов.
  - Acceptance: каждый кейс имеет явный `it(...)` с `expectRevertCustomError`/`expectEvent`;
    `npx hardhat test` зелёный; `TEST_PLAN.md` содержит новые кейсы.

### Foundry-тесты — адаптация

- [x] **12. `test/foundry/*.t.sol`**
  - `Base.t.sol` `_topUp` — добавить параметр `bytes32 operationId` (или генерировать внутри);
  - `SettelmentsControl.fuzz.t.sol` — первый аргумент `operationId` во всех вызовах
    `paymentClientToNative`/`backFundsToClient`;
  - `SettelmentsControl.invariant.t.sol` — в handler'е `payment`/`backFunds` генерировать
    **уникальный** `operationId` на каждый вызов (паттерн `_nextNonce()` уже есть).
  - Acceptance: `forge test` зелёный; invariant-раннер не «высыхает» на массовых
    `OperationAlreadyProcessed` (уникальный ключ на вызов).

### Проверка

- [x] **13. Полный прогон**
  `npx hardhat test` (TS/viem) и `forge test` — зелёные; `git diff` не содержит изменений в
  `thegraph/` и `scripts/deploy.ts`.
  - Acceptance: оба прогона exit 0; `git diff --name-only` ограничен
    `contracts/SettelmentsControl.sol`, тестовыми файлами TS/Foundry, `test/helpers/*.ts`,
    `test/TEST_PLAN.md`.
