# SC-6: Вывод ошибочно переведённых средств (I-05)

Status: PRD_READY
stage: IMPLEMENT

## Контекст / идея

Согласно аудиту `docs/audit-reports/2026-08-20.md`, находка **I-05 (Info)**:
у контракта нет механизма вывода случайно застрявших средств — ни токенов, ни
нативного POL. В частности:

- Нативный POL, переведённый обычным `transfer`, блокируется `receive()` прокси
  (`contracts/SettelmentsControlProxy.sol`, ошибка `NotAcceptEtherDirectly`), но
  POL, зачисленный **принудительно** через `selfdestruct`, извлечь нельзя.
- Токены, отправленные напрямую на контракт мимо `topUpClientBalance`, не могут
  быть выведены администратором отдельно (функция `withdrawTokens` из старых тестов
  в контракте отсутствует).

Финализированное решение (обсуждено с пользователем) — четыре части:

1. **Тотал средств клиентов.** Вести персистентную переменную `totalClientBalance`
   = сумма всех балансов клиентов. Обновляется симметрично в **трёх** функциях:
   - `topUpClientBalance` — `+= value`;
   - `paymentClientToNative` — `-= amount`;
   - `backFundsToClient` — `-= amount`.
   Хранится в `ContractStorage` (в конец структуры, EIP-7201). **Новых
   state-переменных верхнего уровня добавлять нельзя** — хранилище ручное
   (assembly, `STORAGE_LOCATION` в `_getContractStorage()`).
2. **Вывод токенов.** `withdrawStuckTokens(address token, address to, uint256 amount)
   external onlyOwner`:
   - `to != address(0)` → `ZeroAddress()` (ошибка уже существует из SC-5);
   - для USDC (`token == $.token`): доступно `balanceOf(this) - totalClientBalance`
     (только избыток над учтённым тоталом клиентов);
   - для прочих токенов: доступно `balanceOf(this)` (без ограничения — они все
     «случайные»);
   - `amount > available` → новая ошибка (например, `InsufficientStuckFunds()`);
   - перевод через `safeTransfer`.
3. **Вывод нативного POL.** `withdrawStuckNative(address payable to, uint256 amount)
   external onlyOwner`: проверка `amount <= address(this).balance`, низкоуровневый
   `call{value: amount}("")` с проверкой успеха. Застрявший POL от `selfdestruct`
   лежит на адресе прокси — функция вызывается через `delegatecall`, поэтому
   `address(this).balance` корректно отражает баланс прокси.
4. **Доступ:** обе функции `onlyOwner` (управленческая роль).

Ключевой инвариант: `totalClientBalance` всегда равен сумме всех `clientBalances`.
Если обновлять его не во всех трёх функциях — учёт «поедет», и вывод USDC станет
эксплуатируемым (можно вывести средства клиентов сверх избытка).

**Скоуп SC-6** — файл `contracts/SettelmentsControl.sol` (логика + поле
`totalClientBalance` в `ContractStorage`). `contracts/SettelmentsControlProxy.sol`
меняется **только при необходимости** (если решим класть вывод POL в прокси), но
предпочтительно выводить POL в реализации через `delegatecall` (прокси не трогаем).
Вне скоупа: тесты (`test/`), `scripts/deploy.ts`, сабграф `thegraph/` (I-03 отложена).

**Критерий успеха** — чистая компиляция:
`rm -rf artifacts cache && npx hardhat compile` → exit 0, **без** `viaIR`.

## Цели

- Добавить в `ContractStorage` поле `uint256 totalClientBalance` и поддерживать его
  в синхронности с суммой `clientBalances` во всех трёх точках изменения баланса.
- Реализовать `withdrawStuckTokens(token, to, amount) onlyOwner` с корректным
  расчётом доступной суммы: для USDC — только избыток `balanceOf(this) -
  totalClientBalance`, для прочих токенов — весь `balanceOf(this)`.
- Реализовать `withdrawStuckNative(to, amount) onlyOwner` для вывода застрявшего
  POL (в т.ч. зачисленного через `selfdestruct`) с проверкой успеха перевода.
- Закрыть находку I-05, не меняя бизнес-логику расчётов и не вводя новых
  state-переменных верхнего уровня (только поле внутри `ContractStorage`).

## User stories

- Как владелец контракта (`owner`), я хочу вывести случайно застрявшие токены
  (переведённые мимо `topUpClientBalance`) на произвольный ненулевой адрес, чтобы
  не терять ошибочно отправленные средства.
- Как владелец контракта, я хочу, чтобы при выводе USDC я мог снять **только**
  избыток над учтённым тоталом средств клиентов (`totalClientBalance`), чтобы не
  затронуть средства клиентов.
- Как владелец контракта, я хочу вывести застрявший нативный POL (в т.ч.
  зачисленный принудительно через `selfdestruct`), чтобы вернуть случайно
  заблокированные средства.
- Как аналитик/аудитор, я хочу, чтобы инвариант `totalClientBalance == Σ
  clientBalances` поддерживался во всех функциях, меняющих балансы, чтобы вывод
  USDC нельзя было использовать для кражи средств клиентов.

## Основные сценарии

1. **Вывод избытка USDC (успешный путь):** `owner` вызывает
   `withdrawStuckTokens($.token, to, amount)`, где `amount <= balanceOf(this) -
   totalClientBalance`. Контракт переводит `amount` через `safeTransfer` на `to`.
2. **Вывод USDC сверх избытка:** `amount > balanceOf(this) - totalClientBalance`
   → реверт новой ошибкой (например, `InsufficientStuckFunds()`); средства клиентов
   не затрагиваются.
3. **Вывод прочих токенов:** для `token != $.token` доступна вся сумма
   `balanceOf(this)` (ограничения по `totalClientBalance` нет — такие токены все
   «случайные»); `amount > balanceOf(this)` → реверт.
4. **Нулевой получатель:** `withdrawStuckTokens(..., address(0), ...)` → реверт
   `ZeroAddress()`.
5. **Вывод нативного POL:** `owner` вызывает `withdrawStuckNative(payable(to),
   amount)`, где `amount <= address(this).balance`; средства переводятся
   низкоуровневым `call{value: amount}("")`; при неуспехе вызова — реверт.
6. **Доступ:** вызовы `withdrawStuckTokens`/`withdrawStuckNative` не от `owner`
   ревертятся `OnlyOwner()`.
7. **Инвариант тотала:** после `topUpClientBalance` тотал увеличивается на `value`;
   после `paymentClientToNative` и `backFundsToClient` — уменьшается на `amount`,
   в той же точке, где меняется `clientBalances[hash].balance`.

## Успех / метрики

- **Критерий успеха — чистая компиляция:** `rm -rf artifacts cache && npx hardhat
  compile` возвращает код 0, без `viaIR` (optimizer `runs=1000`, `viaIR` отключён).
- В `ContractStorage` добавлено поле `uint256 totalClientBalance` (в конец
  структуры); новых state-переменных верхнего уровня нет, `STORAGE_LOCATION` не
  меняется.
- `totalClientBalance` обновляется в `topUpClientBalance` (`+= value`),
  `paymentClientToNative` (`-= amount`) и `backFundsToClient` (`-= amount`) —
  все три точки.
- `withdrawStuckTokens` реализован с семантикой: USDC — `balanceOf(this) -
  totalClientBalance`, прочие токены — `balanceOf(this)`; `amount > available` →
  новая ошибка; `to == address(0)` → `ZeroAddress()`.
- `withdrawStuckNative` реализован с проверкой `amount <= address(this).balance` и
  низкоуровневым `call{value: amount}("")` с проверкой успеха.
- Обе функции — `onlyOwner`.
- Тесты, `scripts/deploy.ts`, сабграф `thegraph/` — вне скоупа и не являются
  критерием приёмки.

## Ограничения и допущения

- Область задачи — `contracts/SettelmentsControl.sol` (логика + поле
  `totalClientBalance` в `ContractStorage`). Прокси
  `contracts/SettelmentsControlProxy.sol` не меняется (вывод POL делается в
  реализации через `delegatecall`; `receive()` прокси остаётся ревертящим).
- `test/`, `scripts/deploy.ts`, сабграф `thegraph/` **не меняются** (I-03 отложена).
- Компилятор Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` отключён.
- Хранилище — ручной слот EIP-7201 (`ContractStorage`); новые поля добавляются
  только внутрь структуры (в конец), `STORAGE_LOCATION` не перегенерируется
  (значение из SC-5: `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`).
- Продукт ещё не в проде — изменение ABI (новые функции/ошибка) допустимо.
- Управленческая роль вывода — `owner` (не `admin`), что согласуется с уже
  принятым в SC-5 разграничением: `setFeeConfig` тоже переведён на `onlyOwner`.

## Риски

- **Ключевой риск — расхождение `totalClientBalance` с суммой `clientBalances`.**
  Если забыть обновить тотал хотя бы в одной из трёх функций, учёт «поедет»: при
  заниженном тотале владелец сможет вывести средства клиентов как «избыток» USDC;
  при завышенном — вывод заблокируется или вычтется underflow. Митигация:
  обновление тотала строго в той же точке, что и баланс клиента.
- Underflow при вычитании `balanceOf(this) - totalClientBalance`, если
  `totalClientBalance > balanceOf(this)` (защитный случай). Требует явной проверки
  — вынесено в открытые вопросы (план).
- Изменение ABI (новые функции, новая ошибка) ломает off-chain потребителей
  (тесты, deploy-скрипт, сабграф) — осознанно, обвязка вне скоупа (I-03).
- Вывод POL через `delegatecall` в реализации опирается на то, что застрявший POL
  лежит на балансе прокси (`address(this).balance` в контексте delegatecall). Если
  в будущем POL зачислится на саму имплементацию (прямым вызовом), он останется
  недоступным — но имплементация не должна получать средств напрямую
  (`_disableInitializers` в конструкторе).
- Низкоуровневый `call` без ограничения газа/данных получателя может вернуться с
  reentrancy — митигируется минимальностью функции (state меняется до/после вызова
  атомарно, новых внешних вызовов нет; рассмотреть `nonReentrant` на плане при
  необходимости).

## Открытые вопросы

Перечисленные ниже вопросы **не блокируют** PRD и решаются на этапе планирования:

1. **Имя ошибки «недостаточно средств для вывода»:** единая `InsufficientStuckFunds()`
   для токенов и POL, либо раздельные (например, `InsufficientStuckTokens()` /
   `InsufficientStuckNative()`). По умолчанию в замысле — единая
   `InsufficientStuckFunds()`.
2. **Защитный случай `totalClientBalance > balanceOf(this)`:** нужна ли явная
   проверка/`max(0, ...)`-подстраховка перед вычитанием `balanceOf(this) -
   totalClientBalance` в `withdrawStuckTokens` для USDC (иначе underflow в Solidity
   0.8 ревертится), или считать инвариант достаточной гарантией.
3. **Точка обновления тотала в `paymentClientToNative`/`backFundsToClient`:**
   подтвердить, что `-= amount` выполняется в той же точке, что и
   `clientBalances[hash].balance -= amount` / `balance.balance = currentBalance -
   amount`, с осторожностью к инлайн-вызовам `_getContractStorage()` после
   рефакторинга SC-1 (единый storage-указатель `$` против повторных инлайн-чтений).
