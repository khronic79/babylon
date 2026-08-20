# SC-1: План — устранение «Stack too deep» через структуру-контекст `SettelmentContext`

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-1.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-1.md` (Status: RESEARCH)
- Аудит (источник C-01): `docs/audit-reports/2026-08-20.md`
- ADR (архитектурная развилка struct vs viaIR): `docs/adr/SC-1.md`

## 1. Components

| Компонент | Файл | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Реализация логики | `contracts/SettelmentsControl.sol` | **Да (единственный файл)** | Добавление `struct SettelmentContext`, переопределение события `PaymentClientToNative` и трёх ошибок на параметр `SettelmentContext`, рефакторинг `paymentClientToNative` (сборка одного `ctx` в memory). |
| Прокси | `contracts/SettelmentsControlProxy.sol` | Нет | Не ссылается на событие/ошибки реализации (подтверждено в research §4). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Нет | Вне скоупа. |
| Деплой-скрипт | `scripts/deploy.ts` | Нет | Потребитель ABI; синхронизация — отдельная задача вне SC-1. |
| Тесты | `test/*.ts` | Нет | Потребители ABI; синхронизация — отдельная задача вне SC-1. |
| Сабграф | `thegraph/` | Нет | Потребитель ABI; синхронизация — отдельная задача вне SC-1. |
| Конфиг компилятора | `hardhat.config.ts` | Нет | `viaIR` остаётся выключенным; optimizer `runs=1000`, Solidity `0.8.28`. |

**Итог по скоупу:** изменяется только `contracts/SettelmentsControl.sol`. Никаких правок
тестов, deploy-скрипта, сабграфа, прокси, мок-токена и конфигурации компилятора.

## 2. API contract (целевые интерфейсы и контракты)

Все изменения локализованы в `contracts/SettelmentsControl.sol`. Ниже — точный состав
правок и итоговый вид фрагментов.

### 2.1 Новая структура `SettelmentContext`

Объявляется на уровне контракта, в том же стиле и рядом с существующими
`ClientBalance` (`:33-36`) и `NativeAddressAssignment` (`:38-42`) — то есть между
`NativeAddressAssignment` и первым событием (`event TopUpClientBalance`, `:44`).
Структура — обычный `struct` без модификаторов видимости, используется только в
memory-контексте.

**Точный состав и порядок полей — сохраняется текущий порядок 11 полей**
события/ошибок (см. research §2.1/§2.2):

```solidity
struct SettelmentContext {
    string clientId;
    uint256 clientBalance;
    string nativeId;
    address nativeAddress;
    uint256 amountToNative;
    string sessionId;
    uint256 timestamp;
    uint256 minutesQty;
    uint256 feePercentage;
    uint256 feeAmount;
    address feeCollector;
}
```

Порядок полей (1–11): `clientId`, `clientBalance`, `nativeId`, `nativeAddress`,
`amountToNative`, `sessionId`, `timestamp`, `minutesQty`, `feePercentage`,
`feeAmount`, `feeCollector`. Порядок не меняется относительно текущего плоского
набора — это минимизирует расхождения при будущей синхронизации off-chain
потребителей (research §8.1).

### 2.2 Новое событие и три ошибки

Событие `PaymentClientToNative` (сейчас `:50-62`) заменяется на одно-параметрическое:

```solidity
event PaymentClientToNative(SettelmentContext ctx);
```

Три ошибки (сейчас `:69-107`) заменяются на одно-параметрические:

```solidity
error InsufficientClientBalanceForSessionSettelment(SettelmentContext ctx);
error NativeAddressIsOutForSessionSettelment(SettelmentContext ctx);
error InsufficientContractBalanceForSessionSettelment(SettelmentContext ctx);
```

Порядок и имена ошибок/события сохраняются (меняется только сигнатура параметров:
11 плоских аргументов → 1 структура). Остальные ошибки (`OnlyAdmin`, `OnlyOwner`,
`InsufficientClientBalanceForBackFunds`, `InsufficientContractBalanceForBackFunds`,
`InvalidSignature`, `NonceAlreadyUsed`, `InvalidNativeAddress`, `EmptyNativeId`,
`EmptyNonce`, `FeeTooHigh`, `InvalidFeeCollector`) и события (`TopUpClientBalance`,
`NativeAddressSet`, `BackFundsToClient`, `ChangeAdmin`) не затрагиваются.

### 2.3 Итоговый вид `paymentClientToNative` (`:237-344`)

Логика расчётов и порядок проверок/переводов/списания **не меняются**. Меняется
только способ передачи контекста: вместо четырёх раз по 11 аргументов — один
`SettelmentContext memory ctx`, собранный один раз после расчёта `amountToNative`
(строка `:267`) и до первой revert-ветки (`:269`), и используемый в трёх `revert`
и в `emit`.

```solidity
function paymentClientToNative(
    string calldata clientId,
    string calldata nativeId,
    uint256 amount,
    string calldata sessionId,
    uint256 timestamp,
    uint256 minutesQty
) external onlyAdmin {
    require(amount > 0, "Settlement amount between client and native must be > 0");

    ContractStorage storage $ = _getContractStorage();

    ClientBalance storage clientBalance = $.clientBalances[
        keccak256(abi.encodePacked(clientId))
    ];

    uint256 clientBalanceAmount = clientBalance.balance;

    address nativeAddress = $.nativeAddresses[
        keccak256(abi.encodePacked(nativeId))
    ];

    uint256 feeAmount = 0;

    address feeCollector = $.feeCollector;

    uint256 feePercentage = $.feePercentage;

    feeAmount = (amount * feePercentage) / 100;

    uint256 amountToNative = amount - feeAmount;

    SettelmentContext memory ctx = SettelmentContext({
        clientId: clientId,
        clientBalance: clientBalanceAmount,
        nativeId: nativeId,
        nativeAddress: nativeAddress,
        amountToNative: amountToNative,
        sessionId: sessionId,
        timestamp: timestamp,
        minutesQty: minutesQty,
        feePercentage: feePercentage,
        feeAmount: feeAmount,
        feeCollector: feeCollector
    });

    if (nativeAddress == address(0)) {
        revert NativeAddressIsOutForSessionSettelment(ctx);
    }

    if (clientBalanceAmount < amount) {
        revert InsufficientClientBalanceForSessionSettelment(ctx);
    }

    IERC20WithAuthorization token = $.token;

    uint256 contractBalance = token.balanceOf(address(this));

    if (contractBalance < amount) {
        revert InsufficientContractBalanceForSessionSettelment(ctx);
    }

    if (amountToNative > 0) {
        token.safeTransfer(nativeAddress, amountToNative);
    }

    if (feeAmount > 0) {
        token.safeTransfer(feeCollector, feeAmount);
    }

    clientBalance.balance -= amount;

    emit PaymentClientToNative(ctx);
}
```

Ключевые моменты:

- **Именованная инициализация** `SettelmentContext({...})` — исключает перепутывание
  порядка полей (research §8.3).
- **Поле `amountToNative: amountToNative`** — исправление опечатки: теперь в
  5-е поле записывается чистая сумма исполнителю, а не `amount`. Полная сумма
  восстанавливается как `amountToNative + feeAmount` (оба поля есть в структуре).
- **Проверки остаются по полной сумме `amount`:** `require(amount > 0, ...)`,
  `clientBalanceAmount < amount`, `contractBalance < amount`, а также списание
  `clientBalance.balance -= amount` — без изменений.
- **Переводы без изменений:** `amountToNative` исполнителю, `feeAmount` сборщику
  комиссии (условия `> 0` сохранены).
- **Точка сборки `ctx`** — после `amountToNative` (`:267`), до первой ветки
  revert (`:269`). Все поля к этому моменту уже вычислены; повторной сборки нет.

## 3. Data flows

### 3.1 Поток данных внутри `paymentClientToNative` (после рефакторинга)

```
входы: clientId, nativeId, sessionId (string calldata), amount, timestamp, minutesQty (uint256)
        │
        ▼
require(amount > 0)  ──revert(строковый require)──► (без контекста)
        │
        ▼
$ = _getContractStorage()
clientBalance = $.clientBalances[keccak256(encodePacked(clientId))]
clientBalanceAmount = clientBalance.balance
nativeAddress = $.nativeAddresses[keccak256(encodePacked(nativeId))]
feeCollector = $.feeCollector
feePercentage = $.feePercentage
        │
        ▼
feeAmount = (amount * feePercentage) / 100
amountToNative = amount - feeAmount
        │
        ▼
ctx = SettelmentContext({ clientId, clientBalanceAmount, nativeId, nativeAddress,
        amountToNative, sessionId, timestamp, minutesQty, feePercentage, feeAmount, feeCollector })
   (string calldata → string memory при инициализации полей структуры)
        │
        ├─ nativeAddress == address(0) ──► revert NativeAddressIsOutForSessionSettelment(ctx)
        ├─ clientBalanceAmount < amount ──► revert InsufficientClientBalanceForSessionSettelment(ctx)
        ├─ (token.balanceOf(this)) contractBalance < amount ──► revert InsufficientContractBalanceForSessionSettelment(ctx)
        │
        ▼ (успешный путь)
if amountToNative > 0: token.safeTransfer(nativeAddress, amountToNative)
if feeAmount > 0:     token.safeTransfer(feeCollector, feeAmount)
clientBalance.balance -= amount
emit PaymentClientToNative(ctx)
```

### 3.2 Кодирование ABI (как это влияет на стек и потребителей)

- Раньше: emit/revert передавали 11 аргументов (3 × `string` = 6 слотов + 8 скаляров
  = 14 слотов стека) → `Stack too deep`.
- Теперь: emit/revert передают **один** аргумент — указатель на `SettelmentContext`
  в memory. ABI-кодировщик разворачивает структуру в кортеж из 11 полей при
  фактическом кодировании события/ошибки (это происходит вне стекового пика
  кодогена функции).
- Для off-chain потребителей ABI-тип события/ошибки изменяется с 11 плоских
  аргументов на 1 компонент-структуру (см. Risks, §6.1). Валидность значений полей
  не меняется (строки calldata → memory копируются без изменения значения).

## 4. NFR (нефункциональные требования)

1. **Компиляция без `viaIR`:** `rm -rf artifacts cache && npx hardhat compile` → exit 0,
   в выводе нет `Stack too deep`. Компилятор Solidity `0.8.28`, optimizer
   `enabled: true, runs: 1000`; `viaIR` остаётся **выключенным** (конфиг
   `hardhat.config.ts` не меняется).
2. **Стек-давление снято за счёт одной memory-структуры:** одна `SettelmentContext
   memory` должна быть достаточной (эмпирически подтверждено в research §7.3/§8.4 для
   изолированного emit; итоговая проверка — на чистом кэше всего контракта).
3. **Хранилище не меняется:** ручной слот EIP-7201 (`STORAGE_LOCATION` `:130-132`,
   `_getContractStorage()` `:152-161`) и раскладка `ContractStorage` (`:137-146`)
   не модифицируются. `SettelmentContext` — **только memory**, в `ContractStorage`
   не добавляется (иначе конфликт раскладки прокси/структуры).
4. **Неизменность расчётной логики:** формулы `feeAmount = (amount * feePercentage) / 100`
   и `amountToNative = amount - feeAmount`; порядок трёх проверок, двух переводов и
   списания `clientBalance.balance -= amount` идентичны. Единственное осознанное
   изменение значения — передача `amountToNative` вместо `amount` в 5-е поле
   (исправление опечатки).
5. **Семантика revert-веток сохранена:** каждая из трёх веток (`nativeAddress == address(0)`,
   `clientBalanceAmount < amount`, `contractBalance < amount`) ревертит своей ошибкой
   с полным контекстом.
6. **Внешняя обвязка не входит в критерий приёмки:** тесты, deploy-скрипт и сабграф
   не затрагиваются и не проверяются в рамках SC-1.

## 5. Trade-off (явно зафиксирован)

**Изменение ABI события и трёх ошибок** — переход с 11 плоских параметров на
структуру `SettelmentContext`. Это:
- ломает off-chain потребителей (декодирование revert-причин, тесты `test/`,
  deploy-скрипт `scripts/deploy.ts`, сабграф `thegraph/`);
- **допустимо**, поскольку продукт не в проде, а тесты/deploy/сабграф уже
  рассинхронизированы с текущим ABI (research §5) и синхронизируются отдельными
  задачами вне SC-1;
- является осознанной ценой за сохранение `viaIR` выключенным и отсутствие
  изменений в конфигурации сборки и хранилище.

Альтернатива (`viaIR: true`) решала бы проблему однострочной правкой конфига, но
меняет весь пайплайн кодогена и влияет на газ/верификацию — отклонена; см. ADR.

## 6. Risks

1. **Изменение ABI события/ошибок.** Ломает декодирование revert-причин и чтение
   события off-chain-потребителями (тесты, deploy-скрипт, сабграф). Митигация:
   осознанно вне скоупа SC-1; синхронизация — отдельные задачи; продукт не в проде.
2. **Копирование `string calldata` в memory-структуру.** `clientId`, `nativeId`,
   `sessionId` приходят как `calldata`; при инициализации `SettelmentContext` копируются
   в `memory`, а при emit/revert снова ABI-кодируются. Значения не меняются, но
   необходимо убедиться в корректности заполнения полей (именованная инициализация
   снижает риск перепутывания).
3. **Эмпирическая достаточность одной memory-структуры.** Пока не проверено на
   итоговой версии функции целиком: достаточно ли одной `SettelmentContext memory`,
   чтобы компиляция прошла без `viaIR` при `runs=1000`. Критерий успеха — чистая
   компиляция всего контракта. При нехватке — запасные ходы (см. Open questions).
4. **Устаревшие артефакты маскируют проблему.** `artifacts/`/`cache/` собраны до
   последних правок; проверка только на чистом кэше (`rm -rf artifacts cache`).
5. **Риск неаккуратного рефакторинга.** Случайное изменение семантики проверок или
   порядка переводов — исключается точным следованием п. 2.3 (проверки по `amount`,
   переводы `amountToNative`/`feeAmount`).
6. **Не выходить за скоуп.** Прочие находки аудита (H-01…I-05, особенно H-02 в
   deploy-скрипте и I-03 в тестах) не должны всплывать в рамках SC-1.

## 7. Open questions

- Нет блокирующих. Все вопросы research §8 закрыты:
  - порядок полей — сохранён текущий (11 полей);
  - место объявления структуры — рядом с `ClientBalance`/`NativeAddressAssignment`;
  - способ заполнения — именованная инициализация;
  - подтверждено, что событие/ошибки используются только в `paymentClientToNative`;
  - синхронизация тестов/deploy/сабграфа — отдельные задачи вне SC-1.
- Единственный остаточный эмпирический вопрос — достаточность одной memory-структуры
  для гарантированной компиляции без `viaIR` — проверяется критерием успеха на чистом
  кэше. Запасные варианты (если вдруг не хватит): перенос сборки `ctx` ближе к точкам
  использования, разделение на два контекста или, в крайнем случае, повторное
  рассмотрение `viaIR` через новый ADR.

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` завершается с кодом 0, без
  `Stack too deep`, при выключенном `viaIR` (optimizer `runs=1000`, Solidity `0.8.28`).
- В `contracts/SettelmentsControl.sol` присутствуют `struct SettelmentContext`,
  новое событие и три ошибки с параметром `SettelmentContext`, а
  `paymentClientToNative` собирает один `ctx` и использует его в трёх `revert` и `emit`.
- `ctx.amountToNative` содержит чистую сумму исполнителю (опечатка исправлена).
- Расчётная логика, проверки (по `amount`), переводы, списание и хранилище не изменены.
