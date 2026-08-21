# SC-5: Пакет малых исправлений контракта (M-02…I-02)

Status: PRD_READY
stage: IMPLEMENT

## Контекст / идея

Тикет объединяет оставшиеся незакрытые находки аудита
`docs/audit-reports/2026-08-20.md` — от **M-02** до **I-02** включительно. Все они
относятся к одному файлу `contracts/SettelmentsControl.sol` (upgradeable-контракт с
ручным слотом хранилища EIP-7201 `ContractStorage`). Это пакет малых исправлений:
проверки входных данных, событие смены конфига, стиль ошибок и комментарий — без
изменения бизнес-логики расчётов и без изменения раскладки хранилища.

Сводка закрываемых находок и **принятые решения**:

1. **M-02 (Medium)** — `initialize` не валидирует нулевые адреса `_token`, `_admin`,
   `_owner`, `_feeCollector`. **Решение:** одна универсальная ошибка `ZeroAddress()`,
   проверка каждого из четырёх адресов.
2. **M-03 (Medium)** — `feePercentage` допускает `100`; `setFeeConfig` не эмитит
   событие. **Решение:** верхнюю границу `100` НЕ меняем (осознанно оставляем — см.
   примечание); в `setFeeConfig` меняем модификатор `onlyAdmin` → `onlyOwner`; добавляем
   событие `FeeConfigSet(uint256 feePercentage, address feeCollector)`.
3. **L-01 (Low)** — `topUpClientBalance` не проверяет `value > 0`/`from != address(0)`.
   **Решение:** НЕ делаем (функция доверяет админу; зафиксировано как осознанное).
4. **L-03 (Low)** — округление комиссии вниз до нуля. **Решение:** оставляем round
   down (осознанно зафиксировано).
5. **L-04 (Low)** — `backFundsToClient` возвращает только на `lastInboundAddress`.
   **Решение:** оставляем как есть. Это соответствует принятому в бизнесе возврату
   средств на последнее платёжное средство (например, на карту, с которой была оплата);
   в нашем случае — на адрес, с которого поступал последний платёж.
6. **L-05 (Low)** — `require` со строковыми сообщениями; `timestamp`/`minutesQty`/
   `sessionId` не валидируются. **Решение:** заменить `require` на custom errors
   (`ZeroAmount()`); валидацию `timestamp`/`minutesQty`/`sessionId` НЕ добавляем.
7. **I-02 (Info)** — опечатка в строке слота `"SettelmentControle.storage"` (лишняя
   `e` + несовпадение с именем контракта). **Решение (по итогам обсуждения):** не
   оставлять опечатку, а **перегенерировать слот** из корректной строки
   `"SettelmentsControl.storage"` (по имени контракта): обновить `scripts/calc.js` и
   константу `STORAGE_LOCATION` в контракте. Это безопасно, т.к. продукт ещё не в
   проде. Новое значение: `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`.

**Текущее состояние кода (после SC-1…SC-4):**

- `initialize(_token, _admin, _owner, _feePercentage, _feeCollector, _maxValidity)`
  уже проверяет `_feePercentage > 100` (`FeeTooHigh`) и `_maxValidity == 0`
  (`InvalidMaxValidity`), но **не** проверяет адреса на `address(0)`.
- `setFeeConfig(feePercentage, feeCollector)` — `onlyAdmin`, проверяет
  `feePercentage > 100` (`FeeTooHigh`) и `feeCollector == address(0)`
  (`InvalidFeeCollector`), но не эмитит событие.
- `paymentClientToNative` и `backFundsToClient` используют
  `require(amount > 0, "...")` (строковые сообщения).

**Скоуп SC-5** — файлы: `contracts/SettelmentsControl.sol` (основной) и
`scripts/calc.js` (правка строки namespace для I-02). Вне скоупа: тесты (`test/`),
`scripts/deploy.ts`, сабграф `thegraph/`. Находка **I-03** (тесты не соответствуют
ABI) — отложена, отдельный эпик. **I-04/I-05** в этот пакет не входят.

**Критерий успеха** — чистая компиляция:
`rm -rf artifacts cache && npx hardhat compile` → exit 0, **без** `viaIR`.
Ручной слот `ContractStorage` меняется осознанно (I-02 — перегенерация слота), без
новых персистентных полей.

## Цели

- **M-02:** в `initialize` валидировать `_token`, `_admin`, `_owner`, `_feeCollector`
  на `address(0)` с единой ошибкой `ZeroAddress()`.
- **M-03:** перевести `setFeeConfig` на `onlyOwner`; добавить и эмитить событие
  `FeeConfigSet(uint256 feePercentage, address feeCollector)` — и в `setFeeConfig`,
  и при первичной установке в `initialize`. Верхнюю границу `feePercentage` (`100`)
  не менять.
- **L-05:** заменить `require` со строковыми сообщениями на custom errors
  (`ZeroAmount()` для `amount == 0`) в `paymentClientToNative`/`backFundsToClient`.
- **I-02:** перегенерировать `STORAGE_LOCATION` из корректной строки
  `"SettelmentsControl.storage"` (обновить `scripts/calc.js` и константу в контракте).
- **L-01/L-03/L-04:** без изменений кода — решения зафиксированы документально.
- Не менять бизнес-логику расчётов, раскладку хранилища и `STORAGE_LOCATION`.

## User stories

- Как владелец/админ контракта, я хочу, чтобы `initialize` отклонял нулевые адреса,
  чтобы исключить необратимую потерю управления или поломку переводов средств.
- Как владелец контракта (`owner`), я хочу, чтобы изменение конфигурации комиссии
  (`setFeeConfig`) было доступно только мне (управленческая роль), и чтобы каждое
  изменение эмитило событие для мониторинга/аудита.
- Как оператор/аналитик, я хочу, чтобы ошибки в `paymentClientToNative`/
  `backFundsToClient` были консистентными custom errors (а не строковыми `require`),
  чтобы их можно было однозначно декодировать off-chain.
- Как разработчик/аудитор, я хочу, чтобы комментарии в коде не вводили в заблуждение
  (опечатка слота задокументирована, значение не трогается).

## Основные сценарии

1. **M-02, инициализация с нулевым адресом:** `initialize` с любым из
   `_token`/`_admin`/`_owner`/`_feeCollector` = `address(0)` ревертится `ZeroAddress()`;
   валидный вызов проходит.
2. **M-03, доступ:** `setFeeConfig` от `admin` ревертится `OnlyOwner`; от `owner`
   проходит.
3. **M-03, событие:** при смене конфига через `setFeeConfig` и при первичной
   установке в `initialize` эмитится `FeeConfigSet(feePercentage, feeCollector)`.
4. **L-05, ошибки:** `paymentClientToNative`/`backFundsToClient` при `amount == 0`
   ревертятся `ZeroAmount()` (вместо строкового `require`).
5. **I-02, слот:** `STORAGE_LOCATION` перегенерирован из
   `"SettelmentsControl.storage"` (значение `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`),
   `scripts/calc.js` обновлён и воспроизводит это значение.

## Успех / метрики

- **Критерий успеха — чистая компиляция:** `rm -rf artifacts cache && npx hardhat compile`
  возвращает код 0, без `viaIR` (optimizer `runs=1000`, `viaIR` отключён).
- Ручной слот `ContractStorage`/`STORAGE_LOCATION` перегенерирован (I-02); новых
  персистентных полей не добавлено.
- `initialize` отклоняет `address(0)` для `_token`/`_admin`/`_owner`/`_feeCollector`
  (`ZeroAddress()`).
- `setFeeConfig` доступен только `owner`; `FeeConfigSet` эмитится и в `setFeeConfig`,
  и в `initialize`.
- В `paymentClientToNative`/`backFundsToClient` нет `require` со строковыми сообщениями —
  только custom errors (`ZeroAmount()`).
- `STORAGE_LOCATION` перегенерирован из `"SettelmentsControl.storage"` и равен
  `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`;
  `scripts/calc.js` воспроизводит значение.
- Тесты, `scripts/deploy.ts`, сабграф `thegraph/` — вне скоупа и не являются критерием
  приёмки.

## Ограничения и допущения

- Область задачи — только `contracts/SettelmentsControl.sol`.
- `test/`, `scripts/deploy.ts`, сабграф `thegraph/` **не меняются** (I-03 отложена).
- Компилятор Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` отключён.
- Ручной слот EIP-7201 (`ContractStorage`, `STORAGE_LOCATION`) перегенерирован (I-02),
  но структура `ContractStorage` и раскладка её полей не меняются; новых персистентных
  полей не добавляется.
- `_owner` задаётся в `initialize` и уже используется `onlyOwner` (`changeAdmin`,
  `setMaxValidity`) — нулевой `_owner` ломает управление (значимо для M-02).
- Прод ещё не развёрнут — изменение ABI (новые ошибки/событие) допустимо.

## Риски

- Изменение ABI (новые ошибки `ZeroAddress`/`ZeroAmount`, событие `FeeConfigSet`,
  смена модификатора `setFeeConfig`) ломает off-chain потребителей (тесты,
  deploy-скрипт, сабграф) — осознанно, обвязка вне скоупа.
- Перевод `setFeeConfig` на `onlyOwner` требует, чтобы адрес `owner` был под контролем;
  если `owner == admin`, разграничение ролей теряется (уже задокументировано в SC-2).
- Перегенерация `STORAGE_LOCATION` (I-02) безопасна только пока продукт не в проде;
  после деплоя менять слот нельзя (потеря данных). Зафиксировать: строка namespace —
  `"SettelmentsControl.storage"`.

## Открытые вопросы

- Нет блокирующих. Все решения зафиксированы (включая эмиссию `FeeConfigSet` и в
  `initialize`, и в `setFeeConfig`).
