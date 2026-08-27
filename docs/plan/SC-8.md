# SC-8: План — operationId (ключ идемпотентности bytes32 + indexed)

Status: PLAN

Связанные артефакты:
- PRD: `docs/prd/SC-8.prd.md` (Status: DRAFT)
- Исследование: `docs/research/SC-8.md` (Status: RESEARCH)
- ADR: `docs/adr/SC-8.md` — паттерн idempotency-guard (inline-проверки + `_markProcessed`) и
  отказ от публичного getter'а `isOperationProcessed`.
- Источник истины по кейсам: `test/TEST_PLAN.md` (в SC-8 добавляются кейсы идемпотентности).

> **Скоуп SC-8 — контракт + тесты (TS/viem и Foundry).** Сабграф (`thegraph/`) и
> `scripts/deploy.ts` — **вне скоупа** (отдельные тикеты). Контрактная часть (indexed
> `operationId` в событиях) готовится уже сейчас, чтобы сабграф мог его индексировать позже.

---

## 1. Components

| Компонент | Файл | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Реализация | `contracts/SettelmentsControl.sol` | **Да** | Добавить `processedOperations` в `ContractStorage`; `operationId` первым аргументом трёх функций; проверки/`_markProcessed`; ошибки; indexed-параметр в 3 событиях. |
| Прокси | `contracts/SettelmentsControlProxy.sol` | **Нет** | Не меняется; ABI меняется только у реализации (первый деплой — вне SC-8, контракт ещё не деплоился). |
| Мок | `contracts/mock/ERC20Mock.sol` | **Нет** | Источник revert-причин `receiveWithAuthorization` для кейса retry. |
| Хелперы TS | `test/helpers/actions.ts` | **Да** | Прокинуть `operationId` в `topUp(...)` (дефолт `randomBytes32()`, явный ключ для повторного вызова). |
| Хелперы TS | `test/helpers/matchers.ts` | **Да** | Добавить селекторы `OperationAlreadyProcessed(bytes32)` и `EmptyOperationId()` в `ERRORS`. |
| Хелперы TS | `test/helpers/fixture.ts` | **Нет** | `randomBytes32()` уже есть; ABI подхватится из artifacts после перекомпиляции. |
| TS-тесты | `test/SettelmentsControl/{topup,payment,backfunds,roles-and-management}.test.ts` | **Да** | Адаптировать прямые вызовы трёх функций под `operationId`; новые кейсы идемпотентности. |
| TS-тест | `test/SettelmentsControlProxy.test.ts` | **Да** | Сквозной сценарий (кейс 80) — добавить `operationId`. |
| Foundry-тесты | `test/foundry/{Base,fuzz,invariant}.t.sol` | **Да** | Адаптировать вызовы; уникальный `operationId` на каждый вызов handler'а. |
| План тестов | `test/TEST_PLAN.md` | **Да** | Добавить кейсы идемпотентности (нулевой ключ, повторный ключ, retry, несвязанные ключи). |
| Сабграф | `thegraph/**` | **Нет в SC-8** | Отдельный тикет. |
| Скрипт деплоя | `scripts/deploy.ts` | **Нет в SC-8** | Отдельный тикет. |

**Итог по скоупу:** меняются `contracts/SettelmentsControl.sol`, 2 TS-хелпера
(`actions.ts`, `matchers.ts`), 4 TS-теста, 3 Foundry-теста, `test/TEST_PLAN.md`.
Прокси, мок, `fixture.ts`, `deploy.ts` и `thegraph/` не меняются.

---

## 2. API contract

### 2.1 Итоговые сигнатуры трёх функций (`operationId` — первый аргумент)

```solidity
function topUpClientBalance(
    bytes32 operationId,   // ← новый ключ идемпотентности бэкенда
    string calldata userId,
    address from,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,         // ← nonce EIP-3009 (выбирается клиентом), НЕ путать с operationId
    uint8 v,
    bytes32 r,
    bytes32 s
) external onlyAdmin;

function paymentClientToNative(
    bytes32 operationId,   // ← новый
    string calldata clientId,
    string calldata nativeId,
    uint256 amount,
    string calldata sessionId,
    uint256 timestamp,
    uint256 minutesQty
) external onlyAdmin;

function backFundsToClient(
    bytes32 operationId,   // ← новый
    string calldata userId,
    uint256 amount
) external onlyAdmin;
```

### 2.2 Итоговые события (порядок параметров зафиксирован)

```solidity
event TopUpClientBalance(
    bytes32 indexed operationId,   // ← новый, первый
    string userId,
    uint256 amount,
    uint256 currentClientBalance,
    address sender
);

event PaymentClientToNative(
    bytes32 indexed operationId,   // ← новый, отдельным indexed рядом со структурой
    SettelmentContext ctx          // struct нельзя indexed → остаётся в data
);

event BackFundsToClient(
    bytes32 indexed operationId,   // ← новый, первый
    string userId,
    address reciever,              // опечатка `reciever` сохраняется как есть (в ABI так и есть)
    uint256 amount
);
```

`bytes32 indexed` занимает ровно один topic → сабграф/индексер сможет фильтровать по
`operationId` без декодирования data. Прочие события (`NativeAddressSet`, `ChangeAdmin`,
`MaxValiditySet`, `FeeConfigSet`, `StuckFundsWithdrawn`, OZ `Initialized`/`EIP712DomainChanged`)
— без изменений.

### 2.3 Хранилище (ручной слот EIP-7201)

```solidity
struct ContractStorage {
    mapping(bytes32 => ClientBalance) clientBalances;
    mapping(bytes32 => address) nativeAddresses;
    mapping(bytes32 => bool) usedNonces;
    mapping(bytes32 => bool) processedOperations;   // ← новый, в группу mapping'ов
    IERC20WithAuthorization token;
    address admin;
    address owner;
    uint256 feePercentage;
    address feeCollector;
    uint256 maxValidity;
    uint256 totalClientBalance;
}
```

- Поле добавляется **в группу mapping'ов** `ContractStorage` (после `usedNonces`, перед
  скалярами). Контракт ещё не деплоился, поэтому перестановка безопасна; после первого деплоя
  любые новые поля — строго в конец структуры.
- `STORAGE_LOCATION` (`0xa3644...`) **не перегенерируется**; mapping всегда занимает один слот,
  его позиция в структуре не влияет на газ.
- **Никаких** state-переменных верхнего уровня (они конфликтуют с ручным слотом).

### 2.4 Ошибки (итоговый список)

Новые ошибки:

```solidity
error OperationAlreadyProcessed(bytes32 operationId);  // selector 0xe18b4060
error EmptyOperationId();                                // selector 0xfab3e6eb
```

Существующие ошибки `paymentClientToNative` дополняются `operationId` первым параметром
(для единого «сквозного ключа» на всей поверхности «контракт ↔ бэкенд» и удобной
диагностики падающих платежей; `ctx` по-прежнему memory-указатель → 2 параметра, стек не
переполняется, C-01 не возвращается):

```solidity
// было:  error InsufficientClientBalanceForSessionSettelment(SettelmentContext ctx);   // 0xae895493
// стало:                                                                                // 0x7eebe94d
error InsufficientClientBalanceForSessionSettelment(bytes32 operationId, SettelmentContext ctx);
// было:  error NativeAddressIsOutForSessionSettelment(SettelmentContext ctx);          // 0xc4df6dea
// стало:                                                                                // 0x03ebc37f
error NativeAddressIsOutForSessionSettelment(bytes32 operationId, SettelmentContext ctx);
// было:  error InsufficientContractBalanceForSessionSettelment(SettelmentContext ctx); // 0x7f5fdf44
// стало:                                                                                // 0x899b9fa7
error InsufficientContractBalanceForSessionSettelment(bytes32 operationId, SettelmentContext ctx);
```

Селекторы приведены как константы для `test/helpers/matchers.ts` (§3.2); имплементер
подтверждает их `bytes4(keccak256(...))` после перекомпиляции. Изменение сигнатур этих трёх
ошибок меняет их селекторы — matchers обновляются, контракт не задеплоен, блокирующих
последствий нет.

### 2.5 Хелпер `_markProcessed`

```solidity
function _markProcessed(bytes32 operationId) internal {
    ContractStorage storage $ = _getContractStorage();
    $.processedOperations[operationId] = true;
}
```

`internal` (не `private`), без `view`, мутирует `processedOperations`. Проверки
`EmptyOperationId`/`OperationAlreadyProcessed` остаются **инлайн** в начале каждой функции
(см. ADR SC-8, развилка 1) — отдельный `_checkNotProcessed` не вводится.

### 2.6 Шаблон проверок/отметки (checks-effects-interactions)

Единый порядок внутри каждой из трёх функций:

```
1. if (operationId == bytes32(0)) revert EmptyOperationId();          // ← проверка валидности
2. if (processedOperations[operationId]) revert OperationAlreadyProcessed(operationId);  // ← проверка повтора
3. [существующие проверки + внешние вызовы receiveWithAuthorization/safeTransfer]
4. [изменение баланса клиента и totalClientBalance]
5. _markProcessed(operationId);                                        // ← отметка только после успеха
6. emit ...                                                            // ← событие с operationId
```

Порядок «отметка после внешних вызовов и изменения баланса, перед `emit`» — это
checks-effects-interactions: `revert` на шаге 3 откатывает транзакцию целиком (включая
гипотетическую запись в mapping), поэтому ключ «сгорает» **только** при фактическом успехе.
Отметка до внешнего вызова запрещена — она «сожгла» бы ключ при revert и заблокировала бы
легитимный retry (риск PRD). В `paymentClientToNative` внешние `safeTransfer` идут **до**
обновления баланса (`:298-307`), поэтому `_markProcessed` ставится после
`totalClientBalance -= amount`, перед `emit PaymentClientToNative`.

### 2.7 Явно НЕ добавляем

- **Публичный getter `isOperationProcessed(bytes32)` не добавляется.** Обоснование: вне
  скоупа (PRD не упоминает), расширяет ABI (лишний селектор + поддержка в matchers/сабграфе),
  а для сверки «ключ сгорел» тесты используют косвенную проверку — повторный вызов →
  `OperationAlreadyProcessed`. Если прозрачность понадобится бэкенду позже — это аддитивное
  (не ломающее) ABI-изменение в отдельном тикете. (ADR SC-8, развилка 2.)

---

## 3. Data flows

### 3.1 Первый вызов (успех)

```
backend → topUpClientBalance(opId, userId, from, value, ..., nonce, v, r, s)  [onlyAdmin]
  1) opId != 0 && !processedOperations[opId]            → проходят
  2) receiveWithAuthorization(from, this, value, ..., nonce, v, r, s)   → успех (мок: +balance, mark nonce)
  3) clientBalances[hash].balance += value; totalClientBalance += value; lastInboundAddress = from
  4) _markProcessed(opId)                                → processedOperations[opId] = true
  5) emit TopUpClientBalance(opId, userId, value, newBalance, from)
```

Аналогично `paymentClientToNative` (safeTransfer'ы → баланс → `_markProcessed` → emit) и
`backFundsToClient` (safeTransfer → баланс → `_markProcessed` → emit).

### 3.2 Нулевой ключ

```
opId == bytes32(0) → revert EmptyOperationId()          // до проверки processedOperations и внешних вызовов
```

### 3.3 Повторный ключ (после успеха)

```
processedOperations[opId] == true → revert OperationAlreadyProcessed(opId)   // до внешних вызовов
```

### 3.4 Retry после revert внешнего вызова

```
первый вызов: opId ещё не помечен → receiveWithAuthorization ревертит (AuthorizationExpired /
  AuthorizationAlreadyUsed / InvalidAuthorizationSignature / PayeeMustBeCaller ...)
  → вся транзакция откатывается, _markProcessed НЕ выполняется, opId остаётся «чистым»
второй вызов (retry): тот же opId (возможно, с новым nonce для topUp) → проверки проходят
  → операция исполняется → _markProcessed(opId)
```

Это ключевой инвариант SC-8: **revert внешнего вызова не сжигает ключ**.

### 3.5 Тестовая генерация `operationId`

- **TS:** дефолт — `randomBytes32()` (уже из `fixture.ts`); для кейса «повторный ключ» и
  «retry с тем же ключом» — явно передаваемый `operationId` в `TopUpOpts`/аргументах хелперов.
  `nonce` (EIP-3009) остаётся отдельным полем и генерируется независимо.
- **Foundry invariant:** в handler'е на каждый вызов `payment`/`backFunds`/`topUp` генерируется
  **уникальный** `operationId` (паттерн `_nextNonce()` → `bytes32(nonceCounter)` уже есть,
  `invariant.t.sol:39-42`), иначе случайный повтор ключа даст постоянный
  `OperationAlreadyProcessed` и «высушит» живое покрытие.

---

## 4. NFR (нефункциональные требования)

1. `rm -rf artifacts cache && npx hardhat compile` → **exit 0** (Solidity `0.8.28`, optimizer
   `runs=1000`, **без `viaIR`**; конфиг solidity не меняется).
2. `npx hardhat test` → все TS/viem-кейсы зелёные (существующие, адаптированные + новые кейсы
   идемпотентности).
3. `forge test` → Foundry (fuzz/invariant/fork) зелёные после адаптации; invariant-раннер
   сохраняет живое покрытие (уникальный `operationId` на вызов).
4. Никаких новых state-переменных верхнего уровня; `STORAGE_LOCATION` не изменён (проверка
   `git diff` по `contracts/`).
5. `git diff` не содержит изменений в `thegraph/` и `scripts/deploy.ts`.
6. `processedOperations` — фиксированная цена записи на ключ (`bytes32`), O(1)-доступ,
   без массива для итерации (накопление мусора допустимо, итерация не нужна).

---

## 5. Trade-offs (явно зафиксированы)

1. **Проверки инлайн, а не `_checkNotProcessed`.** Выбран вариант «две инлайн-проверки +
   единственный хелпер `_markProcessed`» (ADR SC-8, развилка 1). Газ-нейтрально (оптимизатор
   инлайнит мелкие internal-функции); читаемость выше (revert-условия видны в точке вызова,
   как в существующих `if (amount == 0) revert ZeroAmount();`); DRY здесь не страдает — это
   две строки, а общий инвариант фиксируется этим планом, а не кодом. Выносить только
   `_markProcessed` (side-effecting write) — семантически чисто: «проверка» и «запись»
   разделены.
2. **Отметка в конце (CEI), а не в начале.** Отметка в начале «сожгла» бы ключ при revert и
   заблокировала бы retry. Цена — окно TOCTOU между проверкой и отметкой; риск низкий, т.к.
   все три функции `onlyAdmin` (доверенный бэкенд), а `receiveWithAuthorization`/`safeTransfer`
   в моке не вызывают reentrancy-колбэков.
3. **Ключ хранится напрямую (bytes32), без повторного keccak256 в контракте.** Экономия газа
   (нет строки в calldata, нет лишнего хеша); `text → bytes32` делает бэкенд через
   `keccak256(toBytes(operationKey))`. Контракт остаётся агностичным к формату ключа.
4. **`operationId` отдельным `indexed`-параметром в `PaymentClientToNative`, а не вложенным в
   структуру.** Структура целиком не может быть `indexed`; вынесенный `bytes32 indexed`
   занимает один topic → фильтрация без декодирования. Порядок `(operationId, ctx)`
   зафиксирован PRD (сценарий 7).
5. **Без публичного getter'а `isOperationProcessed`.** Сверка идемпотентности — косвенная
   (повторный вызов → revert). Не расширяем ABI без продуктовой необходимости (ADR SC-8,
   развилка 2).
6. **Сабграф и `deploy.ts` вынесены из скоупа.** ABI-изменение осознанно ломает off-chain
   потребителей; контрактная часть (`operationId` indexed) готовится сейчас, синхронизация —
   отдельные тикеты. Минимизирует размер SC-8 и исключает «наполовину» синхронизированный
   сабграф.

---

## 6. Risks

1. **Забыть `operationId` в одной из трёх функций/событий.** Частичная идемпотентность,
   разъезд связки «контракт ↔ бэкенд». Митигация: единый шаблон (§2.6) и единый порядок
   аргументов (§2.1), чек-лист приёмки (§8).
2. **Порядок отметки.** Отметка до внешних вызовов — критическая ошибка (сжигание ключа при
   revert). Митигация: `_markProcessed` всегда после изменения баланса, перед `emit`; в
   `paymentClientToNative` — после `totalClientBalance -= amount`.
3. **TOCTOU/reentrancy-окно.** Между проверкой в начале и отметкой в конце. Практический риск
   низкий (`onlyAdmin`, мок без hooks); фиксируется как инвариант.
4. **Изменение ABI ломает off-chain.** Тесты адаптируются в SC-8; `deploy.ts` и сабграф —
   отдельные тикеты. Митигация: явный скоуп (§1).
5. **Сабграф уже рассинхронизирован** (в `thegraph/abis/` и `subgraph.yaml` — события
   `BalanceUpdated`/`WithdrawFundsToNative` и плоская `PaymentClientToNative`, которых нет в
   контракте). Полная синхронизация — отдельный тикет; SC-8 лишь готовит контрактную часть.
6. **Invariant-тесты Foundry при случайных повторах `operationId`.** Массовые
   `OperationAlreadyProcessed` «высушат» покрытие. Митигация: уникальный `operationId` на
   каждый вызов handler'а (§3.5).
7. **`operationId` vs `nonce` в `topUpClientBalance`.** Легко перепутать при адаптации хелпера
   `topUp`. `nonce` — EIP-3009 (per-authorizer, выбирается клиентом), `operationId` — ключ
   идемпотентности бэкенда. Митигация: раздельные поля в `TopUpOpts`, комментарии.
8. **Селекторы новых ошибок.** Опечатка в `matchers.ts` даст ложные падения revert-тестов.
   Митигация: константы `0xe18b4060` / `0xfab3e6eb` (§2.4) сверяются с research §2.7.
9. **Рост хранилища.** `processedOperations` — неограниченно растущий bool-mapping. Допустимо:
   O(1)-доступ, итерация не нужна, фиксированная цена на ключ.

---

## 7. ADR и решения по открытым вопросам

ADR создаётся (`docs/adr/SC-8.md`) — две значимые развилки: паттерн idempotency-guard
(инлайн-проверки + `_markProcessed`) и отказ от публичного getter'а.

Закрытие открытых вопросов research (§8) и PRD (§«Открытые вопросы»):

| Вопрос | Решение |
| --- | --- |
| PRD №1 / research ОТВ-1 (скоуп сабграфа и deploy.ts) | **Вне SC-8** — отдельные тикеты (§1). |
| PRD №2 / research ОТВ-8 (валидация нулевого ключа) | Оставить; `EmptyOperationId()` в начале каждой функции, до проверки `processedOperations`. |
| PRD №3 / research ОТВ (порядок в `paymentClientToNative`) | Внешние вызовы → изменение баланса → `_markProcessed` → `emit` (§2.6). |
| research ОТВ-1 (инлайн vs `_checkNotProcessed`) | Инлайн + `_markProcessed` (ADR SC-8, развилка 1). |
| research ОТВ-2 (viem-типизация нового первого аргумента) | После перекомпиляции artifacts ABI подхватится автоматически; при `strict`-ошибках — точечные `as`-приведения, без изменения `fixture.ts`. |
| research ОТВ-3 (генерация `operationId` в хелперах) | Дефолт `randomBytes32()` + явный прокидываемый ключ для повторного/retry кейсов (§3.5). |
| research ОТВ-4 (порядок в `PaymentClientToNative`) | `(bytes32 indexed operationId, SettelmentContext ctx)` — operationId первым (§2.2). |
| research ОТВ-5 (апгрейд vs ре-деплой) | Контракт ещё не деплоился — вопроса «апгрейд vs новый прокси» нет. В SC-8 (тесты) фикстура пересоздаёт реализацию с нуля; первый продовый деплой — отдельный тикет (`scripts/deploy.ts`). |
| research ОТВ-6 (getter) | **Не добавляем** (ADR SC-8, развилка 2). |
| research ОТВ-7 (форма `args.operationId` в viem) | `bytes32` как `0x...` (topic → `parseEventLogs` распакует); `args.ctx` — структура. |
| research ОТВ-8 (порядок проверок в `topUpClientBalance`) | `EmptyOperationId` → `OperationAlreadyProcessed` → существующие проверки/`receiveWithAuthorization`; `onlyAdmin` срабатывает модификатором до тела функции всегда. |
| research ОТВ-9 (селекторы) | `OperationAlreadyProcessed(bytes32)`=`0xe18b4060`, `EmptyOperationId()`=`0xfab3e6eb` в `matchers.ts` `ERRORS`. |

---

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` → exit 0; `npx hardhat test` → зелёные;
  `forge test` → зелёные.
- Три функции принимают `operationId` первым аргументом (§2.1).
- `processedOperations` добавлен в группу mapping'ов `ContractStorage` (после `usedNonces`);
  `STORAGE_LOCATION` неизменён; нет новых state-переменных верхнего уровня.
- `operationId == bytes32(0)` → `EmptyOperationId()`; повторный ключ →
  `OperationAlreadyProcessed(operationId)`; revert внешнего вызова → retry с тем же ключом
  проходит.
- `operationId` — `indexed` во всех трёх событиях (§2.2).
- Все существующие вызовы трёх функций адаптированы (точные места — §9 тест-чек-лист ниже),
  добавлены новые кейсы идемпотентности; `TEST_PLAN.md` дополнен.
- `git diff` не содержит изменений в `thegraph/` и `scripts/deploy.ts`.

---

## 9. Чек-лист тестовых правок (точные места вызовов)

Из research §5 — куда добавить первый аргумент `operationId`:

| Файл:строка | Функция | Правка |
| --- | --- | --- |
| `test/helpers/actions.ts:45` | `topUp` | `operationId` первым в массиве args; поле в `TopUpOpts` (дефолт `randomBytes32()`). |
| `test/SettelmentsControl/topup.test.ts:61` | `topUpClientBalance` (кейс 12) | первый аргумент. |
| `test/SettelmentsControl/roles-and-management.test.ts:24` | `topUpClientBalance` (кейс 45) | первый аргумент. |
| `test/SettelmentsControl/payment.test.ts:31` | `paymentClientToNative` (хелпер `pay`) | первый аргумент. |
| `test/SettelmentsControl/payment.test.ts:101` | `paymentClientToNative` (кейс 20) | первый аргумент. |
| `test/SettelmentsControl/roles-and-management.test.ts:45` | `paymentClientToNative` (кейс 46) | первый аргумент. |
| `test/SettelmentsControlProxy.test.ts:100` | `paymentClientToNative` (кейс 80) | первый аргумент. |
| `test/SettelmentsControl/backfunds.test.ts:23` | `backFundsToClient` (хелпер `backFunds`) | первый аргумент. |
| `test/SettelmentsControl/backfunds.test.ts:84` | `backFundsToClient` (кейс 30) | первый аргумент. |
| `test/SettelmentsControl/roles-and-management.test.ts:56` | `backFundsToClient` (кейс 47) | первый аргумент. |
| `test/SettelmentsControlProxy.test.ts:117` | `backFundsToClient` (кейс 80) | первый аргумент. |
| `test/foundry/Base.t.sol:167` | `_topUp` | параметр `bytes32 operationId` (или генерировать внутри). |
| `test/foundry/SettelmentsControl.fuzz.t.sol:30` | `paymentClientToNative` (`testFuzz_feeMath`) | первый аргумент. |
| `test/foundry/SettelmentsControl.fuzz.t.sol:81` | `paymentClientToNative` (`testFuzz_feeMathMultiStep`) | первый аргумент. |
| `test/foundry/SettelmentsControl.fuzz.t.sol:122` | `paymentClientToNative` (`testFeeMath_zeroPercent`) | первый аргумент. |
| `test/foundry/SettelmentsControl.fuzz.t.sol:145` | `paymentClientToNative` (`testFeeMath_hundredPercent`) | первый аргумент. |
| `test/foundry/SettelmentsControl.fuzz.t.sol:98` | `backFundsToClient` (`testFuzz_feeMathMultiStep`) | первый аргумент. |
| `test/foundry/SettelmentsControl.invariant.t.sol:60` | `paymentClientToNative` (handler) | уникальный `operationId` на вызов. |
| `test/foundry/SettelmentsControl.invariant.t.sol:75` | `backFundsToClient` (handler) | уникальный `operationId` на вызов. |

Новые кейсы (добавляются в `test/TEST_PLAN.md` и в тесты):

1. Нулевой ключ (`operationId == bytes32(0)`) → `EmptyOperationId` (все три функции).
2. Повторный ключ после успеха → `OperationAlreadyProcessed` (все три функции).
3. Revert внешнего вызова (`receiveWithAuthorization`/`safeTransfer`) → ключ не сжигается,
   retry с тем же `operationId` проходит (для `topUpClientBalance` — с новым `nonce`).
4. Разные ключи не конфликтуют между собой (последовательность двух независимых операций).

`test/helpers/matchers.ts` `ERRORS` пополняется/обновляется:
- `OperationAlreadyProcessed: "0xe18b4060"` (новая)
- `EmptyOperationId: "0xfab3e6eb"` (новая)
- `InsufficientClientBalanceForSessionSettelment: "0x7eebe94d"` (была `0xae895493`)
- `NativeAddressIsOutForSessionSettelment: "0x03ebc37f"` (была `0xc4df6dea`)
- `InsufficientContractBalanceForSessionSettelment: "0x899b9fa7"` (была `0x7f5fdf44`)

---

## 10. Open questions

- **Блокирующих нет.**

Вне скоупа SC-8 (не трогаются сейчас, переносятся в отдельные тикеты):
- сабграф `thegraph/` (схема, `subgraph.yaml`, `abis/`, `src/settelments-control.ts`, `yarn codegen`, address/startBlock) — сейчас не трогается;
- `scripts/deploy.ts` и первый деплой/верификация на Polygon Amoy (контракт ещё не деплоился).
