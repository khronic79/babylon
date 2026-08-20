# SC-1: Tasklist — устранение «Stack too deep» через структуру `SettelmentContext`

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-1.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-1.md` (Status: PLAN_APPROVED)
- Аудит (источник C-01): `docs/audit-reports/2026-08-20.md`

## Контекст

Контракт `contracts/SettelmentsControl.sol` не компилируется (`CompilerError: Stack too deep`)
в функции `paymentClientToNative`: событие `PaymentClientToNative` и три custom-ошибки
(`InsufficientClientBalanceForSessionSettelment`, `NativeAddressIsOutForSessionSettelment`,
`InsufficientContractBalanceForSessionSettelment`) передают по 11 плоских аргументов.
Решение — ввести `struct SettelmentContext` (11 полей, порядок сохраняется), перевести
событие и три ошибки на один параметр `SettelmentContext ctx`, а в функции собирать `ctx`
один раз в memory и использовать в трёх `revert` и одном `emit`. Заодно исправляется
опечатка: в поле `amountToNative` передаётся `amountToNative` (чистая сумма исполнителю),
а не `amount`.

**Скоуп:** изменяется только `contracts/SettelmentsControl.sol`. Тесты, deploy-скрипт,
сабграф, прокси, мок-токен и конфиг компилятора (`viaIR` остаётся выключенным) — вне скоупа.

---

## Задачи

### 1. Объявить структуру `SettelmentContext`

- [x] Добавить `struct SettelmentContext` на уровне контракта — рядом с `ClientBalance`
      (`:33-36`) и `NativeAddressAssignment` (`:38-42`), до события `TopUpClientBalance`.

**Состав и порядок полей (11, сохраняется текущий порядок):**

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

**Acceptance-критерии:**
- В `contracts/SettelmentsControl.sol` присутствует `struct SettelmentContext` ровно с 11
  полями, в порядке `clientId, clientBalance, nativeId, nativeAddress, amountToNative,
  sessionId, timestamp, minutesQty, feePercentage, feeAmount, feeCollector`.
- Структура объявлена только на уровне контракта и используется исключительно как
  memory-тип: она **не** добавляется в `struct ContractStorage` (`:137-146`) и не меняет
  ручной слот `STORAGE_LOCATION` / `_getContractStorage()`.

---

### 2. Перевести событие `PaymentClientToNative` на параметр `SettelmentContext`

- [x] Заменить событие `PaymentClientToNative` (`:50-62`) с 11 плоских параметров на
      одно-параметрическое: `event PaymentClientToNative(SettelmentContext ctx);`.

**Acceptance-критерии:**
- В контракте осталось ровно одно объявление `event PaymentClientToNative`, сигнатура —
      ровно один параметр `SettelmentContext ctx` (без плоских аргументов).
- Имя события сохранено; прочие события (`TopUpClientBalance`, `NativeAddressSet`,
      `BackFundsToClient`, `ChangeAdmin`) не изменены.

---

### 3. Перевести три custom-ошибки на параметр `SettelmentContext`

- [x] Заменить три ошибки (`:69-107`) с 11 плоских параметров на одно-параметрические:
      `InsufficientClientBalanceForSessionSettelment(SettelmentContext ctx)`,
      `NativeAddressIsOutForSessionSettelment(SettelmentContext ctx)`,
      `InsufficientContractBalanceForSessionSettelment(SettelmentContext ctx)`.

**Acceptance-критерии:**
- Каждая из трёх ошибок имеет ровно один параметр `SettelmentContext ctx` (без плоских
      аргументов); имена и порядок объявления ошибок сохранены.
- Остальные ошибки (`OnlyAdmin`, `OnlyOwner`, `InsufficientClientBalanceForBackFunds`,
      `InsufficientContractBalanceForBackFunds`, `InvalidSignature`, `NonceAlreadyUsed`,
      `InvalidNativeAddress`, `EmptyNativeId`, `EmptyNonce`, `FeeTooHigh`,
      `InvalidFeeCollector`) не изменены.

---

### 4. Рефакторинг `paymentClientToNative`: сборка `ctx` и исправление опечатки

- [x] В `paymentClientToNative` (`:237-344`) собрать один
      `SettelmentContext memory ctx` через именованную инициализацию — после вычисления
      `amountToNative` (`:267`) и до первой revert-ветки (`:269`).
- [x] Использовать `ctx` в трёх `revert` (вместо 11 плоских аргументов каждый) и в одном
      `emit PaymentClientToNative(ctx)`.
- [x] В поле `amountToNative` передавать `amountToNative` (чистую сумму исполнителю),
      а не `amount` (исправление опечатки).

**Acceptance-критерии:**
- Именованная инициализация: `SettelmentContext({ clientId: clientId, clientBalance: clientBalanceAmount,
      nativeId: nativeId, nativeAddress: nativeAddress, amountToNative: amountToNative, sessionId: sessionId,
      timestamp: timestamp, minutesQty: minutesQty, feePercentage: feePercentage, feeAmount: feeAmount,
      feeCollector: feeCollector })`.
- В теле функции `ctx` собирается **один** раз и используется во всех трёх `revert` и в
      `emit PaymentClientToNative(ctx)`; плоских списков из 11 аргументов в revert/emit не осталось.
- Семантика не изменилась: `require(amount > 0, ...)`; проверки по полной сумме `amount`
      (`nativeAddress == address(0)`, `clientBalanceAmount < amount`, `contractBalance < amount`);
      переводы `token.safeTransfer(nativeAddress, amountToNative)` при `amountToNative > 0` и
      `token.safeTransfer(feeCollector, feeAmount)` при `feeAmount > 0`; списание
      `clientBalance.balance -= amount`; формулы `feeAmount = (amount * feePercentage) / 100` и
      `amountToNative = amount - feeAmount` — без изменений относительно плана §2.3.
- В 5-м поле контекста передаётся `amountToNative`, а не `amount` (полная сумма
      восстанавливается как `amountToNative + feeAmount`).

---

### 5. Финальная проверка: чистая компиляция без `viaIR`

- [x] Проверить сборку на чистом кэше: `rm -rf artifacts cache && npx hardhat compile`
      (без включения `viaIR`; конфиг `hardhat.config.ts` не меняется).

**Acceptance-критерии:**
- Команда `rm -rf artifacts cache && npx hardhat compile` завершается с кодом выхода 0,
      в выводе компилятора нет строки `Stack too deep`.
- Компиляция проходит при действующей конфигурации (Solidity `0.8.28`, optimizer
      `enabled: true, runs: 1000`, `viaIR` выключен) — правок `hardhat.config.ts` нет.
- `git status` показывает изменения только в `contracts/SettelmentsControl.sol`
      (`artifacts/` и `cache/` игнорируются git'ом).

---

## Примечание по независимости

Задачи 1–4 относятся к одному файлу и выполняются в порядке нумерации (структура должна
быть объявлена до события/ошибок/функции, которые её используют); задачи 2 и 3
(событие и ошибки) независимы друг от друга и могут выполняться в любом порядке после
задачи 1. Задача 5 — сквозная проверка всего набора.

## Результат реализации (отклонения от плана)

Задачи 1–5 выполнены, контракт компилируется на чистом кэше без `viaIR`.

В ходе реализации выяснилось, что простое именованное заполнение структуры в самой
функции **не устраняет** `Stack too deep`: в `paymentClientToNative` одновременно живут
3 `string calldata` (6 слотов стека) + ~10 скаляров/указателей — лимит 16 слотов
превышается уже при построении структуры. Поэтому реализация отличается от плана §2.3:

1. Структура собирается **не** именованной инициализацией, а **инкрементальным**
   присваиванием полей (`ctx.field = value`).
2. Построение вынесено в отдельную `internal` функцию `_buildSettelmentContext`
   (собственный стековый фрейм), что позволило уложиться в лимит.
3. Вместо локального `ContractStorage storage $` используются инлайн-вызовы
   `_getContractStorage()` — экономия одного живого слота стека.
4. Хэш `clientId` (`clientHash`) вычисляется в `paymentClientToNative` и
   переиспользуется для списания в конце функции (чтобы не повторять `keccak` на
   пике стека); `_buildSettelmentContext` при этом считает `keccak(clientId)`
   ещё раз для чтения баланса — это осознанная плата за разгрузку стека, без
   изменения семантики.

Семантика не изменилась: порядок проверок (`nativeAddress == address(0)`,
`clientBalance < amount`, `contractBalance < amount`), формулы комиссии, переводы,
списание `-= amount` и эмиссия события сохранены. В поле `ctx.amountToNative`
передаётся `amountToNative` (опечатка исправлена).
