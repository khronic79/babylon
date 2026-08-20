# SC-1: Техническое исследование — «Stack too deep» в `SettelmentsControl`

Status: RESEARCH
Связанный PRD: `docs/prd/SC-1.prd.md`
Аудит (источник находки C-01): `docs/audit-reports/2026-08-20.md`

## 1. Связанные модули/контракты

| Модуль | Файл | Роль в задаче |
| --- | --- | --- |
| Реализация логики расчётов | `contracts/SettelmentsControl.sol` | **Единственный файл, который меняется.** Содержит событие `PaymentClientToNative`, три custom-ошибки и функцию `paymentClientToNative`. |
| ERC1967-прокси | `contracts/SettelmentsControlProxy.sol` | **Не меняется.** Не имеет завязок на сигнатуры события/ошибок реализации (см. §4). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Вне скоупа; используется тестами/deploy-скриптом. Не затронут. |
| Деплой-скрипт | `scripts/deploy.ts` | Потребитель ABI (через `artifacts/`). Вне скоупа; уже неконсистентен (см. §5). |
| Тесты Hardhat | `test/SettelmentsControl.ts`, `test/SettelmentsControlProxy.ts` | Потребители ABI. Вне скоупа; уже неконсистентны (см. §5). |
| Сабграф The Graph | `thegraph/` (abis, schema, src, tests, subgraph.yaml, networks.json) | Потребитель ABI. Вне скоупа; синхронизация — отдельная задача (см. §5). |
| Компилятор | `hardhat.config.ts` | Источник ограничения «без `viaIR`» (см. §6). |

**Вывод по скоупу:** из перечисленного меняется **только** `contracts/SettelmentsControl.sol`.
Всё остальное — потребители ABI, которые станут неконсистентны после рефакторинга и
синхронизируются отдельными задачами.

## 2. Текущие событие и ошибки (с точными строками)

### 2.1 Событие `PaymentClientToNative`

`contracts/SettelmentsControl.sol:50-62` — 11 полей:

| Поле | Тип | Строка |
| --- | --- | --- |
| `clientId` | `string` | `SettelmentsControl.sol:51` |
| `clientBalance` | `uint256` | `SettelmentsControl.sol:52` |
| `nativeId` | `string` | `SettelmentsControl.sol:53` |
| `nativeAddress` | `address` | `SettelmentsControl.sol:54` |
| `amountToNative` | `uint256` | `SettelmentsControl.sol:55` |
| `sessionId` | `string` | `SettelmentsControl.sol:56` |
| `timestamp` | `uint256` | `SettelmentsControl.sol:57` |
| `minutesQty` | `uint256` | `SettelmentsControl.sol:58` |
| `feePercentage` | `uint256` | `SettelmentsControl.sol:59` |
| `feeAmount` | `uint256` | `SettelmentsControl.sol:60` |
| `feeCollector` | `address` | `SettelmentsControl.sol:61` |

Из 11 полей три — `string` (`clientId`, `nativeId`, `sessionId`); каждая строка в
EVM занимает 2 слота стека, т.е. 3 строки = 6 слотов + 8 скаляров = 14 слотов на
параметры события, плюс служебные слоты кодогена — причина `Stack too deep`.

### 2.2 Три custom-ошибки (по 11 параметров, идентичный набор полей)

- `InsufficientClientBalanceForSessionSettelment` — `contracts/SettelmentsControl.sol:69-81`
- `NativeAddressIsOutForSessionSettelment` — `contracts/SettelmentsControl.sol:82-94`
- `InsufficientContractBalanceForSessionSettelment` — `contracts/SettelmentsControl.sol:95-107`

Порядок полей у всех трёх ошибок совпадает с порядком полей события:

1. `clientId` (`:70`, `:83`, `:96`)
2. `clientBalance` (`:71`, `:84`, `:97`)
3. `nativeId` (`:72`, `:85`, `:98`)
4. `nativeAddress` (`:73`, `:86`, `:99`)
5. `amountToNative` (`:74`, `:87`, `:100`)
6. `sessionId` (`:75`, `:88`, `:101`)
7. `timestamp` (`:76`, `:89`, `:102`)
8. `minutesQty` (`:77`, `:90`, `:103`)
9. `feePercentage` (`:78`, `:91`, `:104`)
10. `feeAmount` (`:79`, `:92`, `:105`)
11. `feeCollector` (`:80`, `:93`, `:106`)

### 2.3 Функция `paymentClientToNative` — все три `revert` и `emit`

`contracts/SettelmentsControl.sol:237-344`.

Сигнатура (`:237-244`, 6 параметров): `clientId`, `nativeId`, `amount`, `sessionId`,
`timestamp`, `minutesQty` (все `string calldata` / `uint256`).

Ход функции:

| Строка | Что происходит |
| --- | --- |
| `:245` | `require(amount > 0, ...)` — строковый require (не custom error). |
| `:247` | `ContractStorage storage $ = _getContractStorage();` |
| `:249-251` | `ClientBalance storage clientBalance = $.clientBalances[keccak256(abi.encodePacked(clientId))];` |
| `:253` | `uint256 clientBalanceAmount = clientBalance.balance;` |
| `:255-257` | `address nativeAddress = $.nativeAddresses[keccak256(abi.encodePacked(nativeId))];` |
| `:259` | `uint256 feeAmount = 0;` |
| `:261` | `address feeCollector = $.feeCollector;` |
| `:263` | `uint256 feePercentage = $.feePercentage;` |
| `:265` | `feeAmount = (amount * feePercentage) / 100;` |
| `:267` | `uint256 amountToNative = amount - feeAmount;` |
| `:269-283` | **revert 1:** `NativeAddressIsOutForSessionSettelment(...)` — при `nativeAddress == address(0)`. В позицию `amountToNative` (5-е поле) передаётся `amount` (`:275`). |
| `:285-299` | **revert 2:** `InsufficientClientBalanceForSessionSettelment(...)` — при `clientBalanceAmount < amount`. Передаёт `amount` в 5-е поле (`:291`). |
| `:301` | `IERC20WithAuthorization token = $.token;` |
| `:303` | `uint256 contractBalance = token.balanceOf(address(this));` |
| `:305-319` | **revert 3:** `InsufficientContractBalanceForSessionSettelment(...)` — при `contractBalance < amount`. Передаёт `amount` в 5-е поле (`:311`). |
| `:321-323` | `if (amountToNative > 0) token.safeTransfer(nativeAddress, amountToNative);` |
| `:325-327` | `if (feeAmount > 0) token.safeTransfer(feeCollector, feeAmount);` |
| `:329` | `clientBalance.balance -= amount;` |
| `:331-343` | **emit:** `PaymentClientToNative(...)` — в 5-е поле (`amountToNative`) передаётся `amount` (`:336`). |

**Зафиксированная опечатка (подтверждена):** во всех четырёх местах (три `revert` +
один `emit`) 5-е поле, названное в декларации `amountToNative`, фактически получает
переменную `amount` (полную сумму), а не `amountToNative` (чистую сумму исполнителю):
- `revert` 1: `SettelmentsControl.sol:275`
- `revert` 2: `SettelmentsControl.sol:291`
- `revert` 3: `SettelmentsControl.sol:311`
- `emit`: `SettelmentsControl.sol:336`

В рамках SC-1 это исправляется: в структуру-контекст `ctx.amountToNative` должна
записываться чистая сумма `amountToNative`, а полная сумма восстанавливается как
`amount = amountToNative + feeAmount` (оба поля присутствуют в структуре).

## 3. Используемые паттерны

### 3.1 Стиль объявления структур (для консистентной новой `SettelmentContext`)

Существующие структуры объявлены **на уровне контракта** (до событий/ошибок), с
явными типами и без модификаторов видимости (по умолчанию `internal`/`public` не
задаётся — используется в `internal` контексте):

- `ClientBalance` — `contracts/SettelmentsControl.sol:33-36`:
  ```solidity
  struct ClientBalance {
      uint256 balance;
      address lastInboundAddress;
  }
  ```
- `NativeAddressAssignment` — `contracts/SettelmentsControl.sol:38-42`:
  ```solidity
  struct NativeAddressAssignment {
      string nativeId;
      address nativeAddress;
      string nonce;
  }
  ```
- `ContractStorage` — `contracts/SettelmentsControl.sol:137-146`:
  ```solidity
  struct ContractStorage {
      mapping(bytes32 => ClientBalance) clientBalances;
      mapping(bytes32 => address) nativeAddresses;
      mapping(bytes32 => bool) usedNonces;
      IERC20WithAuthorization token;
      address admin;
      address owner;
      uint256 feePercentage;
      address feeCollector;
  }
  ```

Новая `SettelmentContext` должна следовать этому же стилю: обычный `struct` с 11
полями, объявленный на верхнем уровне (например, рядом с `ClientBalance` /
`NativeAddressAssignment`, т.е. в районе `:33-42`), с порядком полей, идентичным
текущему порядку события/ошибок: `clientId`, `clientBalance`, `nativeId`,
`nativeAddress`, `amountToNative`, `sessionId`, `timestamp`, `minutesQty`,
`feePercentage`, `feeAmount`, `feeCollector`.

### 3.2 Хранилище — ручной слот EIP-7201

- Константа слота `STORAGE_LOCATION` — `contracts/SettelmentsControl.sol:130-132`
  (комментарий с опечаткой `"SettelmentControle.storage"` — находка I-02, вне скоупа).
- `_getContractStorage()` — `contracts/SettelmentsControl.sol:152-161` (assembly
  `$.slot := STORAGE_LOCATION`).
- Всё персистентное состояние лежит в `ContractStorage` (`:137-146`). **Новая
  структура `SettelmentContext` не должна попадать в `ContractStorage`** — это
  временный memory-контекст для события/ошибок, а не персистентное состояние.

### 3.3 Наследование и библиотеки

- Контракт наследует `Initializable`, `EIP712Upgradeable`
  (`contracts/SettelmentsControl.sol:30`) из `@openzeppelin/contracts-upgradeable`.
- `using SafeERC20 for IERC20WithAuthorization;` — `contracts/SettelmentsControl.sol:31`.
- `constructor() { _disableInitializers(); }` — `contracts/SettelmentsControl.sol:148-150`.
- `initialize(...)` с `initializer` и `__EIP712_init("SettelmentsControl", "1.0")` —
  `contracts/SettelmentsControl.sol:179-195`.
- EIP-712 typehash `ASSIGNMENT_TYPEHASH` — `contracts/SettelmentsControl.sol:134-135`.

### 3.4 Версии OpenZeppelin

Из `package.json`:
- `@openzeppelin/contracts`: `^5.3.0` (фактически установлено **5.3.0**)
- `@openzeppelin/contracts-upgradeable`: `^5.3.0` (фактически **5.3.0**)

Импорты в контракте:
- `IERC20`, `SafeERC20` — из `@openzeppelin/contracts` (`:4-7`)
- `Initializable`, `EIP712Upgradeable` — из `@openzeppelin/contracts-upgradeable` (`:8-13`)

## 4. Прокси и завязка на ABI

`contracts/SettelmentsControlProxy.sol` (`:1-52`):

- Наследует `ERC1967Proxy` (`:11-17`), управляет админом/имплементацией через
  `ERC1967Utils` (`:16`, `:20-46`).
- Определяет **собственные** ошибки `OnlyAdmin` (`:12`) и `NotAcceptEtherDirectly`
  (`:13`), которые **не имеют отношения** к трём 11-параметрическим ошибкам
  реализации и к событию `PaymentClientToNative`.
- В прокси **нет ни одной ссылки** на `PaymentClientToNative`,
  `InsufficientClientBalanceForSessionSettelment`,
  `NativeAddressIsOutForSessionSettelment` или
  `InsufficientContractBalanceForSessionSettelment`.

**Вывод:** изменение ABI реализации (переход события и трёх ошибок на
`SettelmentContext`) **не затрагивает** прокси. Прокси остаётся без изменений;
события/ошибки реализуются и декодируются на уровне реализации, прокси лишь
делегирует вызовы.

## 5. Слои и зависимости (контракт → прокси → потребители ABI)

### 5.1 Деплой-скрипт `scripts/deploy.ts`

- Импортирует ABI из артефактов: `artifacts/contracts/SettelmentsControl.sol/SettelmentsControl.json` (`:7`).
- **Не ссылается** на сигнатуры `PaymentClientToNative` или трёх ошибок.
- Уже неконсистентен с текущим контрактом (находка H-02): `initialize` вызывается с
  2 аргументами (`scripts/deploy.ts:115`), тогда как контракт ожидает 5.
- После SC-1 его неконсистентность по событию/ошибкам **не меняется** (он их не
  использует); но сам deploy-скрипт требует отдельного исправления (вне скоупа SC-1).

### 5.2 Тесты Hardhat

`test/SettelmentsControl.ts` и `test/SettelmentsControlProxy.ts` — уже не
соответствуют текущему ABI (находка I-03); после SC-1 становятся ещё более
неконсистентны в части события/ошибок:

- `test/SettelmentsControl.ts:37` — `initialize(token, admin)` (контракт ждёт 5 аргументов).
- `test/SettelmentsControl.ts:67` — `topUpClientBalance(amount, userId)` (контракт ждёт 9 параметров).
- `test/SettelmentsControl.ts:116` и `test/SettelmentsControlProxy.ts:190` —
  `.withArgs(clientId, 0, nativeId, amount, amount, "123456", 156156156n, 10n)` — старый
  порядок/набор полей события (8 значений, включая дважды `amount`).
- `test/SettelmentsControl.ts:142`, `test/SettelmentsControlProxy.ts:214` —
  ошибка `InsufficientClientBalance` (не существует в контракте; сейчас называется
  `InsufficientClientBalanceForSessionSettelment`).
- `test/SettelmentsControl.ts:73-74, 118-124, 191-192`, `test/SettelmentsControlProxy.ts:151-153, 192-198, 258-259` —
  `getBalance(...).clientBalance` / `.nativeBalance` (структура сейчас
  `{balance, lastInboundAddress}`).

Эти места ссылаются на **старые** сигнатуры и станут ещё неконсистентнее после
перехода события/ошибок на `SettelmentContext` — подтверждает, что синхронизация
тестов — отдельная задача (вне SC-1).

### 5.3 Сабграф The Graph

Потребитель ABI через `thegraph/abis/SettelmentsControl.json` (файл **уже устарел**
относительно текущего `.sol`):

- `thegraph/abis/SettelmentsControl.json:114-168` — событие `PaymentClientToNative`
  описано **8 полями** (`clientId`, `clientBalance`, `nativeId`, `nativeBalance`,
  `amount`, `sessionId`, `timestamp`, `minutesQty`), что не совпадает с текущими 11
  полями контракта (`nativeAddress`/`feePercentage`/`feeAmount`/`feeCollector`
  отсутствуют; поле `nativeBalance` в контракте отсутствует).
- `thegraph/abis/SettelmentsControl.json` **не содержит** трёх 11-параметрических
  ошибок вообще (только `OnlyAdmin`, `SafeERC20FailedOperation` и устаревшие
  `InsufficientClientBalance`/`InsufficientNativeBalance`/`NotThisBalanceType`).
- `thegraph/subgraph.yaml:38` — обработчик
  `PaymentClientToNative(string,uint256,string,uint256,uint256,string,uint256,uint256)`
  (8 параметров). Также содержит обработчики событий, отсутствующих в контракте:
  `BalanceUpdated` (`:32-33`), `WithdrawFundsToNative` (`:42-43`).
- `thegraph/schema.graphql:36-49` — сущность `PaymentClientToNative` со старым
  набором полей (`nativeBalance`, `amount`; нет `nativeAddress`, `feePercentage`,
  `feeAmount`, `feeCollector`, `amountToNative`).
- `thegraph/src/settelments-control.ts:99-164` — `handlePaymentClientToNative`
  читает `event.params.clientBalance`, `nativeBalance`, `amount` и т.д. (старая форма).
- `thegraph/tests/settelments-control-utils.ts:83-136` — фабрика
  `createPaymentClientToNativeEvent` на 8 параметров.
- `thegraph/tests/settelments-control.test.ts` — тестирует только `BackFundsToClient`,
  `PaymentClientToNative` не затрагивает.

**Вывод:** сабграф уже рассинхронизирован с контрактом (старые 8 полей и мёртвые
события), а после SC-1 (переход на `SettelmentContext` из 11 полей) его
синхронизация становится ещё более явной отдельной задачей. Адрес
`0x51de3ac5b5cdf4496c5b793a98b1a103e6675386` и `startBlock: 22033296` продублированы в
`thegraph/subgraph.yaml:11,13` и `thegraph/networks.json:4,5` — при будущем передеплое
их нужно держать синхронными (вне скоупа SC-1).

## 6. Компилятор (`hardhat.config.ts`)

`hardhat.config.ts:8-16`:

```ts
solidity: {
  version: "0.8.28",
  settings: {
    optimizer: { enabled: true, runs: 1000 },
  },
}
```

- Компилятор **0.8.28**, оптимизатор включён (`runs=1000`), **`viaIR` не задан**
  (по умолчанию отключён). Именно эта конфигурация даёт `Stack too deep`.
- SC-1 **не меняет** конфигурацию (viaIR остаётся выключенным).

Проверка чистой компиляции:
- Удалить устаревшие артефакты/кэш: `rm -rf artifacts cache` (сейчас в `artifacts/`
  лежат сборки от Aug 19, `cache/solidity-files-cache.json` — тоже от Aug 19; они
  устарели и маскируют ошибку).
- Выполнить `npx hardhat compile` — критерий успеха: код 0 и отсутствие
  `Stack too deep` в выводе.

## 7. Ограничения и риски

1. **Изменение ABI.** Событие `PaymentClientToNative` и три ошибки меняют сигнатуру
   (с 11 плоских параметров на 1 структуру `SettelmentContext`). Это ломает
   off-chain потребителей: декодирование revert-причин, тесты (`test/`),
   deploy-скрипт (`scripts/deploy.ts`), сабграф (`thegraph/`). Осознанно допустимо:
   обвязка вне скоупа, продукт не в проде.
2. **Memory-копирование строк.** Параметры `clientId`, `nativeId`, `sessionId`
   приходят как `string calldata`; при сборке `SettelmentContext memory` и
   последующем `emit`/`revert` строки копируются calldata → memory → (при ABI-кодировании)
   снова кодируются. Значения не меняются, но нужно убедиться, что заполнение
   структуры корректно (не перепутаны поля) и что это не вносит семантических
   расхождений.
3. **Сохранение логики.** Рефакторинг не должен менять порядок/семантику трёх
   проверок, формул комиссии (`:265`, `:267`), переводов (`:321-327`) и списания
   (`:329`). Единственное осознанное изменение значения — передача `amountToNative`
   вместо `amount` в 5-е поле (опечатка).
4. **Риск «структура в storage».** Новая `SettelmentContext` — только memory-структура.
   Её нельзя добавлять в `ContractStorage`, иначе конфликт с раскладкой EIP-7201.
5. **Устаревшие артефакты.** `artifacts/`/`cache/` маскируют проблему — проверку
   нужно делать на чистом кэше.
6. **Прочие находки аудита (H-01…I-05)** вне скоупа SC-1; не должны всплывать в
   рамках этой задачи (особенно H-02 в deploy-скрипте и I-03 в тестах).

## 8. Открытые технические вопросы

1. **Порядок полей `SettelmentContext`.** Закрепить ли порядок ровно в текущей
   последовательности события/ошибок (`clientId, clientBalance, nativeId,
   nativeAddress, amountToNative, sessionId, timestamp, minutesQty, feePercentage,
   feeAmount, feeCollector`), или допустимо переупорядочить? Рекомендация:
   сохранить текущий порядок для минимизации расхождений.
2. **Место объявления структуры.** Размещать `SettelmentContext` рядом с
   `ClientBalance`/`NativeAddressAssignment` (`:33-42`) или после `ContractStorage`?
   (стиль — см. §3.1).
3. **Способ заполнения структуры.** Использовать именованную инициализацию
   `SettelmentContext({...})` или `SettelmentContext memory ctx;` + присваивание по
   полям? Именованная инициализация нагляднее и меньше рискует перепутать порядок.
4. **Валидация стека после рефакторинга.** Достаточно ли одной memory-структуры,
   чтобы гарантированно пройти компиляцию без `viaIR` при `runs=1000`, или могут
   понадобиться доп. локальные переменные/хелперы? (Проверяется эмпирически на
   чистом кэше — основной критерий успеха.)
5. **Совместимость имени поля.** После исправления 5-е поле структуры остаётся
   `amountToNative` (чистая сумма), а полная сумма выводится как
   `amountToNative + feeAmount`. Подтвердить, что именно так интерпретируют
   off-chain потребители при будущей синхронизации.
6. **Где ещё используются старые ошибки/событие?** Поиск по кодовой базе: три ошибки
   и событие используются **только** в `paymentClientToNative`
   (`contracts/SettelmentsControl.sol:269-343`); ни в прокси, ни в тестах, ни в
   deploy-скрипте они не вызываются напрямую по имени (тесты ссылаются на другие,
   уже устаревшие имена). Дополнительных мест правки нет.
7. **Синхронизация обвязки.** Подтверждено, что тесты (`test/`), deploy-скрипт и
   сабграф (`thegraph/`) синхронизируются отдельными задачами (вне SC-1); в SC-1
   они не трогаются.
