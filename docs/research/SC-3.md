# SC-3: Техническое исследование — атомарная инициализация прокси (H-02)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-3.prd.md`
Аудит (источник находки H-02): `docs/audit-reports/2026-08-20.md` (строки `:168-196`)
Активный тикет: `docs/.active_ticket` → `SC-3`

## Резюме

Задача сводится к **одной правке** — конструктору `SettelmentsControlProxy`, который
сейчас деплоит прокси с пустыми данными (`ERC1967Proxy(implementation, "")`,
`contracts/SettelmentsControlProxy.sol:15`) и оставляет `initialize` на отдельную
транзакцию (фронт-раннинг, H-02). Решение — канонический паттерн OpenZeppelin:
конструктор принимает `(address implementation, bytes memory data)` и пробрасывает
`data` в базовый `ERC1967Proxy`, который атомарно выполняет `initialize` через
`delegatecall` в рамках транзакции деплоя прокси. Реализация
`SettelmentsControl.sol` **не меняется** — её `initializer`/`_disableInitializers()`
уже корректны для этого сценария (подтверждено ниже, §4).

---

## 1. Связанные модули/контракты

| Модуль | Файл | Роль в задаче |
| --- | --- | --- |
| Прокси | `contracts/SettelmentsControlProxy.sol` | **Единственный файл, который меняется.** Только конструктор `:15-17`. |
| Реализация | `contracts/SettelmentsControl.sol` | **Не меняется.** Содержит `initialize` с модификатором `initializer` и `_disableInitializers()` в конструкторе (см. §4). |
| Базовый прокси | `node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol` | Источник атомарного поведения через `upgradeToAndCall` (см. §3). |
| Утилиты ERC-1967 | `node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol` | `upgradeToAndCall`, `_setImplementation`, `changeAdmin`, `_checkNonPayable`. |
| `Address` | `node_modules/@openzeppelin/contracts/utils/Address.sol` | `functionDelegateCall` (сам `delegatecall`). |
| `Initializable` | `node_modules/@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol` | Модификатор `initializer` + `_disableInitializers` (см. §3.3). |
| Деплой-скрипт | `scripts/deploy.ts` | Потребитель ABI прокси; **не меняется** в SC-3, но будет сломан новой сигнатурой (см. §6.2). |
| Тесты Hardhat | `test/SettelmentsControlProxy.ts` | Потребитель ABI прокси; будет сломан новой сигнатурой (см. §6.1). |
| Сабграф The Graph | `thegraph/` | **Не затрагивается**: индексирует события `SettelmentsControl`, не ABI прокси. |
| Компилятор | `hardhat.config.ts` | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` выключен. Критерий — чистая компиляция (см. §7). |
| Зависимости | `@openzeppelin/contracts@^5.3.0`, `@openzeppelin/contracts-upgradeable@^5.3.0` | Установленные версии (`package.json:21-22`). |

**Вывод по скоупу:** меняется **только** конструктор `SettelmentsControlProxy`
(`:15-17`). `SettelmentsControl.sol` остаётся без изменений (PRD §«Скоуп»,
`docs/prd/SC-3.prd.md:22-26`). Остальные файлы — потребители ABI прокси, которые
станут неконсистентными; их синхронизация явно вне скоупа SC-3.

---

## 2. Текущий код `SettelmentsControlProxy` (точные строки)

Файл `contracts/SettelmentsControlProxy.sol` — 52 строки.

| Элемент | Строки | Что делает |
| --- | --- | --- |
| `pragma solidity 0.8.28` | `:2` | — |
| Импорт `ERC1967Proxy` | `:4-6` | из `@openzeppelin/contracts` |
| Импорт `ERC1967Utils` | `:7-9` | из `@openzeppelin/contracts` |
| `contract SettelmentsControlProxy is ERC1967Proxy` | `:11` | — |
| `error OnlyAdmin()` | `:12` | для `onlyProxyAdmin` |
| `error NotAcceptEtherDirectly()` | `:13` | для `receive()` |
| **`constructor(address implementation) ERC1967Proxy(implementation, "")`** | **`:15-17`** | **Целевая правка.** Сейчас передаёт пустую строку → `initialize` не выполняется атомарно. Затем `ERC1967Utils.changeAdmin(msg.sender)` (`:16`). |
| `modifier onlyProxyAdmin()` | `:20-26` | сверяет `msg.sender` с `ERC1967Utils.getAdmin()`, иначе `revert OnlyAdmin()` |
| `changeProxyAdmin(address newAdmin) external onlyProxyAdmin` | `:29-31` | `ERC1967Utils.changeAdmin(newAdmin)` |
| `getProxyAdmin() external view returns (address)` | `:34-36` | `ERC1967Utils.getAdmin()` |
| `getImpl() external view returns (address)` | `:39-41` | `_implementation()` (наследуется) |
| `setImpl(address implementation) external onlyProxyAdmin` | `:44-46` | `ERC1967Utils.upgradeToAndCall(implementation, "")` |
| `receive() external payable { revert NotAcceptEtherDirectly(); }` | `:49-51` | блокирует приём ETH |

**Целевая правка (по PRD, `docs/prd/SC-3.prd.md:37-42`):**

```solidity
constructor(address implementation, bytes memory data)
    ERC1967Proxy(implementation, data) {
    ERC1967Utils.changeAdmin(msg.sender);
}
```

Все прочие элементы прокси (`receive`, `changeProxyAdmin`, `getProxyAdmin`, `getImpl`,
`setImpl`, модификатор `onlyProxyAdmin`) остаются **без изменений**.

---

## 3. Базовый `ERC1967Proxy` и `ERC1967Utils.upgradeToAndCall` — механика атомарной инициализации

### 3.1 Конструктор `ERC1967Proxy`

`node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol`:

```solidity
constructor(address implementation, bytes memory _data) payable {
    ERC1967Utils.upgradeToAndCall(implementation, _data);
}
```
— строки `:26-28`. Конструктор `payable` (можно передавать `msg.value`), но в SC-3
ETH не передаётся.

`_implementation()` (`:37-39`) возвращает `ERC1967Utils.getImplementation()` — чтение
слота `IMPLEMENTATION_SLOT`.

### 3.2 `ERC1967Utils.upgradeToAndCall` — ключевая логика

`node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol:67-76`:

```solidity
function upgradeToAndCall(address newImplementation, bytes memory data) internal {
    _setImplementation(newImplementation);
    emit IERC1967.Upgraded(newImplementation);

    if (data.length > 0) {
        Address.functionDelegateCall(newImplementation, data);
    } else {
        _checkNonPayable();
    }
}
```

- `_setImplementation` (`:53-58`) — проверяет `newImplementation.code.length == 0`
  → `revert ERC1967InvalidImplementation`; затем пишет адрес в `IMPLEMENTATION_SLOT`
  (`0x360894a1...d382bbc`, `:21`).
- **`data.length > 0`** → `Address.functionDelegateCall(newImplementation, data)`
  (`:71-72`) — **это и есть атомарный `delegatecall` на `initialize`**.
- **`data` пустое** → `_checkNonPayable()` (`:74`), которая ревертит при
  `msg.value > 0` (`:172-176`, `ERC1967NonPayable`). То есть с пустыми `data` прокси
  просто устанавливает имплементацию и админа, но **не** инициализируется — текущее
  уязвимое поведение (H-02).

### 3.3 `Address.functionDelegateCall` и `delegatecall`

`node_modules/@openzeppelin/contracts/utils/Address.sol:96-99`:

```solidity
function functionDelegateCall(address target, bytes memory data) internal returns (bytes memory) {
    (bool success, bytes memory returndata) = target.delegatecall(data);
    return verifyCallResultFromTarget(target, success, returndata);
}
```

- `delegatecall` выполняется в контексте **хранилища прокси**: весь код `initialize`
  (и `__EIP712_init`) пишет в слоты прокси, а не имплементации.
- При неудаче revert-причина пробрасывается наверх (`verifyCallResultFromTarget`,
  `:106-121` → `_revert`, `:138-149`). Если `initialize` ревертится (например,
  невалидный `_feePercentage`/`_maxValidity`), **вся транзакция деплоя прокси
  ревертится** — частично инициализированного состояния не возникает (PRD §«Риски»).

Дополнительно, `Proxy._delegate` (`Proxy.sol:22-45`) — это fallback-делегирование для
обычных вызовов через прокси (не для конструктора); в SC-3 напрямую не задействован,
но объясняет, как прокси делегирует все прочие вызовы.

### 3.4 `changeAdmin` / слоты ERC-1967

`ERC1967Utils.sol`:
- `ADMIN_SLOT = 0xb5312768...5d6103` (`:83`);
- `changeAdmin(newAdmin)` (`:111-114`) → `_setAdmin` (`:99-104`, ревертит
  `ERC1967InvalidAdmin` при `newAdmin == address(0)`).

Админ прокси (`ADMIN_SLOT`) **отделён** от `admin`/`owner` логики
`SettelmentsControl` (которые лежат внутри namespaced `ContractStorage`), и от
`Initializable`-слота. Коллизий нет.

---

## 4. `initializer` при `delegatecall` из конструктора прокси

`node_modules/@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol`.

### 4.1 Модификатор `initializer` (`:104-132`)

```solidity
bool isTopLevelCall = !$._initializing;
uint64 initialized = $._initialized;
bool initialSetup = initialized == 0 && isTopLevelCall;
bool construction = initialized == 1 && address(this).code.length == 0;
if (!initialSetup && !construction) {
    revert InvalidInitialization();
}
$._initialized = 1;
if (isTopLevelCall) { $._initializing = true; }
```

Ключевые строки: `isTopLevelCall`/`initialized` (`:109-110`), `initialSetup`
(`:117`), `construction` (`:118`), `revert InvalidInitialization` (`:120-122`),
`$._initialized = 1` (`:123`), `$._initializing = true` (`:124-126`), завершающая
часть с `emit Initialized(1)` (`:128-131`).

**Поведение при атомарной инициализации через конструктор прокси:**
- Хранилище прокси **пустое** на момент деплоя → `_initialized == 0`,
  `_initializing == false` → `isTopLevelCall == true` → `initialSetup == true` →
  модификатор **проходит**. Это ровно тот сценарий, который описан в PRD
  (`docs/prd/SC-3.prd.md:23-26, 67-71`).
- Ветка `construction` (`initialized == 1 && address(this).code.length == 0`) здесь
  не используется: `address(this)` — прокси, чей код уже развёрнут (`code.length != 0`),
  а `initialized == 0`, так что ветка `initialSetup` истинна, `construction` ложна.
- После выполнения `initialize` `_initialized = 1` → **повторный** вызов `initialize`
  (напрямую или через прокси) ревертится `InvalidInitialization` (существующее
  поведение, PRD сценарий 4).

### 4.2 `_disableInitializers()` в конструкторе имплементации

`Initializable.sol:192-203`:

```solidity
function _disableInitializers() internal virtual {
    InitializableStorage storage $ = _getInitializableStorage();
    if ($._initializing) revert InvalidInitialization();
    if ($._initialized != type(uint64).max) {
        $._initialized = type(uint64).max;
        emit Initialized(type(uint64).max);
    }
}
```

`SettelmentsControl.sol:119-121` вызывает `_disableInitializers()` в своём
конструкторе:

```solidity
constructor() {
    _disableInitializers();
}
```

**Следствие:** при деплое **самой имплементации** её собственный `INITIALIZABLE_STORAGE`
слот (`0xf0c57e16...c6a00`, `Initializable.sol:77`) получает
`_initialized = type(uint64).max`, поэтому прямой вызов `initialize` на имплементации
ревертится `InvalidInitialization`. При этом конструктор имплементации выполняется **в
хранилище имплементации**, а `delegatecall` из прокси — **в хранилище прокси**, чей
`INITIALIZABLE_STORAGE` слот остаётся `0` → инициализация через прокси работает. Две
области хранилища не пересекаются.

**Вывод:** изменения в `SettelmentsControl.sol` **не требуются** — `initializer` и
`_disableInitializers()` уже реализуют требуемый инвариант (PRD §«Ограничения»,
`docs/prd/SC-3.prd.md:107-108`).

---

## 5. Порядок выполнения в конструкторе прокси и `msg.sender`

Порядок исполнения конструктора `SettelmentsControlProxy` при вызове с
`(implementation, data)`:

1. **Базовый конструктор** `ERC1967Proxy(implementation, data)` (`:26-28`)
   выполняется **первым** (это правило Solidity — конструкторы базовых контрактов
   исполняются до тела производного конструктора).
2. Внутри него `upgradeToAndCall` → `_setImplementation` (запись
   `IMPLEMENTATION_SLOT`) → `delegatecall` на `initialize` (см. §3.2).
3. **Только после** возврата из базового конструктора исполняется тело производного
   конструктора: `ERC1967Utils.changeAdmin(msg.sender)` (запись `ADMIN_SLOT`,
   `SettelmentsControlProxy.sol:16`).

**`msg.sender` во время `delegatecall`:** `delegatecall` сохраняет контекст вызова —
`msg.sender` внутри `initialize` остаётся **деплойером прокси** (EOA/контракт,
создающий прокси). Это не создаёт конфликтов, потому что `initialize`
(`SettelmentsControl.sol:150-169`) **не использует `msg.sender`** — все роли берутся из
параметров (`_admin`, `_owner`, `_token`, `_feeCollector`, `_feePercentage`,
`_maxValidity`). Админ/владелец контракта задаются явно аргументами, а админ прокси —
отдельно через `changeAdmin(msg.sender)`.

**Отсутствие конфликтов по слотам при таком порядке:**
- `initialize` пишет только в `INITIALIZABLE_STORAGE`, `STORAGE_LOCATION`
  (`ContractStorage`), и EIP-712 слот (`EIP712Upgradeable`), **не** в `ADMIN_SLOT`;
- `changeAdmin` пишет только `ADMIN_SLOT`. Пересечений нет, поэтому порядок
  «сначала `initialize`, потом `changeAdmin`» безопасен (PRD сценарий 1, §«Риски»).
- Если `initialize` ревертится, `changeAdmin` не выполнится и весь деплой откатится.

---

## 6. Потребители ABI прокси (будут сломаны новой сигнатурой — вне скоупа)

Смена конструктора с `(address implementation)` на
`(address implementation, bytes memory data)` меняет ABI прокси. Оба текущих
потребителя деплоят прокси **с одним аргументом**:

### 6.1 Тесты `test/SettelmentsControlProxy.ts`

- `:25-26` — `const Proxy = await ethers.getContractFactory("SettelmentsControlProxy");
  const proxy = await Proxy.deploy(implementation.target);` — **1 аргумент**.
- Далее (`:44-46`) инициализация вызывается **отдельной транзакцией**:
  `proxyUsed.connect(initializer).initialize(token.target, admin.address)` — к тому же
  с устаревшей сигнатурой `initialize` (2 аргумента; сейчас 6 после SC-2). Это ровно
  уязвимый сценарий H-02, который SC-3 устраняет на уровне контракта.

Тесты уже неконсистентны с текущим ABI (I-03 в аудите); после SC-3 деплой в фикстуре
перестанет компилироваться (неверное число аргументов конструктора). Синхронизация
тестов — вне скоупа SC-3.

### 6.2 Деплой-скрипт `scripts/deploy.ts`

- `:85-89` — деплой прокси:
  `args: [implAddress]` — **1 аргумент** (сломается).
- `:104-107` — верификация прокси: `constructorArguments: [implAddress]` — тоже 1
  аргумент (сломается).
- `:109-119` — отдельная транзакция `initialize` с `args: [erc20Address,
  account.address]` (2 аргумента) — уже сломана и вне скоупа SC-3 (PRD §«Открытые
  вопросы», `docs/prd/SC-3.prd.md:126-131`).

PRD явно фиксирует: deploy-скрипт **не меняется и не пишется** в SC-3
(`docs/prd/SC-3.prd.md:28-29, 99-100`); исправление «неверного числа аргументов» и
формирование `data = abi.encodeCall(initialize, ...)` вынесены в будущую задачу деплоя.

### 6.3 Сабграф The Graph

Не затрагивается: `thegraph/` индексирует события `SettelmentsControl`, а не ABI
прокси. В `thegraph/subgraph.yaml`/`abis` прокси-контракт не упоминается (проверено
grep-поиском — совпадений нет).

---

## 7. Компилятор (`hardhat.config.ts`)

- Solidity `0.8.28` (`:9`), optimizer `enabled: true, runs: 1000` (`:11-14`).
- **`viaIR` не задан** → выключен (значение по умолчанию). Критерий успеха —
  `rm -rf artifacts cache && npx hardhat compile` возвращает 0 (PRD §«Успех»,
  `docs/prd/SC-3.prd.md:86-87`).
- `networks`/`etherscan` закомментированы (`:17-45`); `gasReporter.enabled = true`
  (`:28-30`).

Риск «Stack too deep»/проблем компилятора для данной правки **отсутствует**:
изменяется только конструктор прокси (добавляется один параметр `bytes memory data`),
никакой новой логики/локальных переменных не вводится.

---

## 8. Используемые паттерны

- **ERC-1967 (upgradeable proxy):** прокси наследует `ERC1967Proxy`, хранит
  имплементацию/админа в стандартных слотах (`IMPLEMENTATION_SLOT` `ERC1967Utils.sol:21`,
  `ADMIN_SLOT` `:83`), делегирование — через `Proxy._delegate` (fallback) и
  `Address.functionDelegateCall` (в конструкторе).
- **Каноническая атомарная инициализация OZ:** «initializer function should be called
  as early as possible by providing the encoded function call as the `_data` argument to
  `ERC1967Proxy-constructor`» — цитата из документации `Initializable.sol:33-34` (TIP).
  Именно этот паттерн реализует SC-3.
- **`initializer` + `delegatecall`:** одноразовая инициализация через `delegatecall` в
  хранилище прокси; повторные вызовы блокируются `InvalidInitialization`.
- **EIP-7201 (namespaced storage):** состояние `Initializable` лежит в собственном
  слоте `0xf0c57e16...c6a00` (`Initializable.sol:77`), а бизнес-логика — в ручном слоте
  `STORAGE_LOCATION` (`SettelmentsControl.sol:99-100`). Всё это живёт в хранилище
  прокси после `delegatecall`, не конфликтуя с ERC-1967 слотами.

---

## 9. Ограничения и риски

1. **Контракт не принуждает передавать `data`.** Если будущий deploy-скрипт развернёт
   прокси с `data = ""`, он останется неинициализированным и снова уязвимым к
   фронт-раннингу (`upgradeToAndCall` с пустыми `data` идёт в ветку `_checkNonPayable`,
   `ERC1967Utils.sol:73-75`). Защита целиком зависит от корректности deploy-процесса
   (осознанный trade-off канонического паттерна, PRD §«Ограничения»/«Риски»).
2. **Смена сигнатуры конструктора ломает ABI прокси:** `test/SettelmentsControlProxy.ts:26`
   и `scripts/deploy.ts:88, 106` (передают 1 аргумент). Верификация на etherscan
   потребует `constructorArguments: [implAddress, data]`. Синхронизация — вне скоупа.
3. **Атомарность:** `changeAdmin(msg.sender)` выполняется **после** `delegatecall` на
   `initialize`; если `initialize` ревертится — откатывается весь деплой, частичного
   состояния нет (желаемое поведение).
4. **`msg.sender` во время `initialize` = деплойер** (а не админ контракта): безвредно,
   т.к. `initialize` не читает `msg.sender`, роли задаются параметрами (§5).
5. **Роли не смешиваются:** админ прокси (`ADMIN_SLOT`, `changeAdmin`) и
   `admin`/`owner` контракта (`ContractStorage`) — независимы. Соотношение этих ролей —
   открытый вопрос, вынесенный в планирование деплоя (PRD §«Открытые вопросы»).
6. **Валидация нулевых адресов в `initialize` отсутствует (M-02)** — отдельная находка,
   вне скоупа SC-3; `_admin`/`_owner`/`_token`/`_feeCollector` не проверяются на
   `address(0)` (`SettelmentsControl.sol:150-169`).

---

## 10. Открытые технические вопросы

1. **(неблокирующее)** Формирование `data = abi.encodeCall(initialize, (...))` с шестью
   аргументами `initialize` (`_token, _admin, _owner, _feePercentage, _feeCollector,
   _maxValidity`) и исправление «неверного числа аргументов» в `scripts/deploy.ts` —
   будущая задача деплоя, вне скоупа SC-3 (PRD `docs/prd/SC-3.prd.md:126-128`).
2. **(неблокирующее)** Соотношение ролей «админ прокси» (`changeAdmin(msg.sender)`) и
   «админ/владелец контракта» (`_admin`/`_owner` из `initialize`) — уточняется на этапе
   планирования деплоя (PRD `docs/prd/SC-3.prd.md:129-131`).
3. **Делать ли производный конструктор `payable`?** Базовый `ERC1967Proxy` — `payable`
   (`ERC1967Proxy.sol:26`); в SC-3 ETH не передаётся, поэтому целевая форма из PRD
   (`constructor(address, bytes memory)`) без `payable` достаточно и корректна.
   Передача `msg.value` при непустых `data` не требуется (целевой `initialize`
   non-payable, а `receive()` ревертит).
4. **Синхронизация тестов и deploy-скрипта** (потребители ABI прокси, §6) — отдельные
   задачи, явно вне скоупа SC-3.
