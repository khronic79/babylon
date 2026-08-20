# SC-3: План — атомарная инициализация прокси (H-02)

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-3.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-3.md` (Status: RESEARCH)
- Аудит (источник H-02): `docs/audit-reports/2026-08-20.md` (`:168-196`)
- ADR (развилка `bytes memory data` vs явные параметры конструктора): `docs/adr/SC-3.md`

## 1. Components

| Компонент | Файл | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Прокси | `contracts/SettelmentsControlProxy.sol` | **Да (единственный файл)** | Меняется **только конструктор** (`:15-17`): принимает `(address implementation, bytes memory data)`, пробрасывает `data` в базовый `ERC1967Proxy`, затем `changeAdmin(msg.sender)`. |
| Реализация | `contracts/SettelmentsControl.sol` | Нет | `initializer`/`_disableInitializers()` уже корректны для атомарной инициализации (research §4). |
| Базовый прокси | `@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol` | Нет | Источник атомарного поведения `upgradeToAndCall` → `functionDelegateCall`. |
| Деплой-скрипт | `scripts/deploy.ts` | Нет | Потребитель ABI прокси; сломается новой сигнатурой (`:88`, `:106`). Синхронизация — вне скоупа. |
| Тесты | `test/SettelmentsControlProxy.ts` | Нет | Потребитель ABI прокси; сломается (`:26`). Синхронизация — вне скоупа. |
| Сабграф | `thegraph/` | Нет | Не затрагивается (индексирует события `SettelmentsControl`, не ABI прокси). |
| Конфиг компилятора | `hardhat.config.ts` | Нет | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` выключен. |

**Итог по скоупу:** изменяется только конструктор `SettelmentsControlProxy` (`:15-17`).
Остальные элементы прокси (`receive`, `changeProxyAdmin`, `getProxyAdmin`, `getImpl`,
`setImpl`, модификатор `onlyProxyAdmin`, ошибки `OnlyAdmin`/`NotAcceptEtherDirectly`)
остаются **без изменений**. `SettelmentsControl.sol`, deploy-скрипт, тесты, сабграф и
конфигурация компилятора не меняются.

## 2. API contract (целевые интерфейсы и контракты)

Единственная правка — конструктор `SettelmentsControlProxy` (`:15-17`).

### 2.1 Текущая форма (`:15-17`)

```solidity
constructor(address implementation) ERC1967Proxy(implementation, "") {
    ERC1967Utils.changeAdmin(msg.sender);
}
```

### 2.2 Целевая форма

```solidity
constructor(address implementation, bytes memory data)
    ERC1967Proxy(implementation, data) {
    ERC1967Utils.changeAdmin(msg.sender);
}
```

Изменения относительно текущей формы:

- **Сигнатура:** добавлен второй параметр `bytes memory data`.
- **Базовый вызов:** `ERC1967Proxy(implementation, "")` → `ERC1967Proxy(implementation, data)`.
- **Тело:** `ERC1967Utils.changeAdmin(msg.sender)` сохраняется **без изменений**.

Никаких новых полей, событий, ошибок, модификаторов или функций не вводится. Прокси
остаётся `contract SettelmentsControlProxy is ERC1967Proxy` без дополнительного
наследования. Конструктор остаётся non-payable (ETH в SC-3 не передаётся; целевой
`initialize` non-payable, а `receive()` ревертит — research §10.3).

## 3. Data flows

### 3.1 Механика атомарной инициализации (почему `data` выполняет `initialize`)

Конструктор `ERC1967Proxy` (`ERC1967Proxy.sol:26-28`) делает
`ERC1967Utils.upgradeToAndCall(implementation, _data)`. Внутри
(`ERC1967Utils.sol:67-76`):

1. `_setImplementation(newImplementation)` — запись адреса имплементации в
   `IMPLEMENTATION_SLOT` (ревертит `ERC1967InvalidImplementation`, если
   `newImplementation.code.length == 0`);
2. `emit IERC1967.Upgraded(newImplementation)`;
3. **если `data.length > 0`** → `Address.functionDelegateCall(newImplementation, data)`
   — `delegatecall` на `initialize` в контексте хранилища прокси (атомарно в той же
   транзакции деплоя);
4. **если `data` пустое** → `_checkNonPayable()` — только установка имплементации,
   **без** инициализации (текущее уязвимое поведение H-02, research §3.2).

При неудаче `delegatecall` revert-причина пробрасывается наверх
(`verifyCallResultFromTarget` → `_revert`): если `initialize` ревертится, ревертится
весь деплой прокси — частичного состояния не возникает.

### 3.2 Порядок выполнения в конструкторе `SettelmentsControlProxy`

```
вызов конструктора с (implementation, data)
        │
        ▼
[1] базовый конструктор ERC1967Proxy(implementation, data)   ← выполняется ПЕРВЫМ
        │   (правило Solidity: базовые конструкторы до тела производного)
        ▼
    upgradeToAndCall(implementation, data)
        │
        ├─ _setImplementation(...)          // запись IMPLEMENTATION_SLOT
        ├─ emit Upgraded(implementation)
        └─ data.length > 0
             └─ functionDelegateCall(...)   // delegatecall initialize (хранилище прокси)
                    │
                    └─ initializer: _initialized == 0, _initializing == false
                       → initialSetup == true → ПРОХОДИТ (research §4.1)
        │
        ▼
[2] тело производного конструктора:
        ERC1967Utils.changeAdmin(msg.sender)   // запись ADMIN_SLOT
```

**Про `msg.sender`:** `delegatecall` сохраняет контекст вызова — внутри `initialize`
`msg.sender` = деплойер прокси. Конфликтов нет: `initialize` **не читает** `msg.sender`
(все роли — `_admin`, `_owner`, `_token`, `_feeCollector` — задаются параметрами),
а админ прокси назначается отдельно через `changeAdmin(msg.sender)` (research §5).

**Про отсутствие конфликтов по слотам:** `initialize` пишет только в
`INITIALIZABLE_STORAGE`, namespaced `STORAGE_LOCATION` (`ContractStorage`) и EIP-712
слот; `changeAdmin` пишет только `ADMIN_SLOT`. Пересечений нет, поэтому порядок
«сначала `initialize`, потом `changeAdmin`» безопасен (research §5).

### 3.3 Влияние на ABI и потребителей

Смена конструктора `(address)` → `(address, bytes)` меняет ABI прокси:

- `test/SettelmentsControlProxy.ts:26` (`Proxy.deploy(implementation.target)` — 1
  аргумент) перестанет компилироваться/деплоиться.
- `scripts/deploy.ts:88` (`args: [implAddress]`) и `:106`
  (`constructorArguments: [implAddress]`) передают 1 аргумент — сломаются; верификация
  на etherscan потребует `constructorArguments: [implAddress, data]`.
- Сабграф не затрагивается (ABI прокси в `thegraph/` не упоминается — research §6.3).

Синхронизация тестов и deploy-скрипта — **вне скоупа SC-3** (PRD §«Ограничения»).

## 4. NFR (нефункциональные требования)

1. **Компиляция без `viaIR`:** `rm -rf artifacts cache && npx hardhat compile` → exit 0.
   Solidity `0.8.28`, optimizer `enabled: true, runs: 1000`, `viaIR` выключен (конфиг
   не меняется).
2. **Только конструктор:** не добавляется state-переменных верхнего уровня, новых
   функций, событий, ошибок или модификаторов; не меняется хранилище. Вся
   персистентная логика прокси (слоты `IMPLEMENTATION_SLOT`/`ADMIN_SLOT`) управляется
   базовым `ERC1967Proxy`/`ERC1967Utils` — ручной слот хранилища прокси не задействован.
3. **Безопасность операций:** `changeAdmin(msg.sender)` выполняется после `delegatecall`
   на `initialize`; реверт `initialize` откатывает весь деплой (нет частичной
   инициализации).
4. **Stack/газ:** правка добавляет один параметр `bytes memory data` без новой логики —
   риск `Stack too deep` отсутствует (research §7).
5. **Неизменность прочей логики:** `receive` (`NotAcceptEtherDirectly`),
   `changeProxyAdmin`, `getProxyAdmin`, `getImpl`, `setImpl`, `onlyProxyAdmin` — не
   затрагиваются.

## 5. Trade-off (явно зафиксирован)

**Защита от фронт-раннинга обеспечивается процессом деплоя, а не самим контрактом.**
Канонический паттерн `(implementation, data)` не принуждает передавать непустые `data`:
контракт не ревертит при `data = ""`. Если деплойер развернёт прокси с пустыми `data`,
прокси останется неинициализированным и снова уязвимым к фронт-раннингу. Осознанная
цена канонического паттерна OpenZeppelin; ответственность за всегда-непустые `data`
(`data = abi.encodeCall(initialize, (...))`) лежит на будущем deploy-скрипте (вне
скоупа SC-3).

**Изменение ABI прокси.** Смена сигнатуры конструктора меняет ABI `SettelmentsControlProxy`
(деплой, верификация на etherscan, любые off-chain потребители ABI прокси). Это ломает
`scripts/deploy.ts` и `test/SettelmentsControlProxy.ts`. Допустимо: продукт не в проде;
синхронизация вынесена в отдельные задачи вне SC-3 (PRD §«Ограничения»/«Риски»).

Альтернативы, сохраняющие ABI/защищающие контрактом, отвергнуты — см. ADR.

## 6. Risks

1. **Пустые `data` → неинициализированный прокси.** Контракт не принуждает передавать
   `data`. Митигация: защита целиком зависит от корректности будущего deploy-скрипта
   (вне скоупа); trade-off зафиксирован в §5.
2. **Сломанные потребители ABI прокси.** `test/SettelmentsControlProxy.ts:26` и
   `scripts/deploy.ts:88,106` передают 1 аргумент конструктора; после SC-3 перестанут
   работать. Митигация: синхронизация — отдельные задачи вне SC-3; явно зафиксировано
   в PRD и плане.
3. **Неверный порядок `initialize`/`changeAdmin`.** Требование — базовый конструктор
   (имплементация + `initialize`) **до** `changeAdmin`. Порядок гарантируется правилом
   Solidity (базовые конструкторы исполняются первыми); `initialize` не читает
   `msg.sender`, поэтому назначение админа после `initialize` не влияет на результат
   инициализации (research §5).
4. **Недопонимание ролей «админ прокси» vs «админ/владелец контракта».** Админ прокси
   (`ADMIN_SLOT`, `changeAdmin`, `onlyProxyAdmin` → `getImpl`/`setImpl`/`changeProxyAdmin`)
   независим от `admin`/`owner` логики `SettelmentsControl` (`ContractStorage`).
   Соотношение этих ролей уточняется на этапе планирования деплоя (вне скоупа, PRD
   §«Открытые вопросы»). Митигация в рамках SC-3: документация ролей не меняется, но
   план явно разделяет их, чтобы не допустить путаницы.
5. **Не выходить за скоуп.** Deploy-скрипт не пишется/не правится; `SettelmentsControl.sol`
   не меняется; M-02 (валидация `address(0)` в `initialize`) и прочие находки — вне
   скоупа.

## 7. Open questions

- Нет блокирующих. Неблокирующие (вынесены в будущую задачу деплоя):
  - формирование `data = abi.encodeCall(initialize, (...))` с 6 аргументами `initialize`
    (`_token, _admin, _owner, _feePercentage, _feeCollector, _maxValidity`);
  - исправление «неверного числа аргументов» в `scripts/deploy.ts`;
  - верификация прокси с `constructorArguments: [implAddress, data]`;
  - соотношение ролей «админ прокси» и «админ/владелец контракта».

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `Stack too deep`,
  при `viaIR` выключенном (optimizer `runs=1000`, Solidity `0.8.28`).
- Конструктор `SettelmentsControlProxy` имеет сигнатуру
  `(address implementation, bytes memory data)` и вызывает базовый
  `ERC1967Proxy(implementation, data)`.
- `ERC1967Utils.changeAdmin(msg.sender)` в теле конструктора сохранён.
- Функции `receive`, `changeProxyAdmin`, `getProxyAdmin`, `getImpl`, `setImpl` и
  модификатор `onlyProxyAdmin` не изменены.
- `contracts/SettelmentsControl.sol` не изменён.
- Тесты, deploy-скрипт, сабграф — вне скоупа и не являются критерием приёмки.
