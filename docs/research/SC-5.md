# SC-5: Техническое исследование — пакет малых исправлений (M-02…I-02)

Status: RESEARCH
Связанный PRD: `docs/prd/SC-5.prd.md` (Status: PRD_READY)
Аудит (источник находок M-02…I-02): `docs/audit-reports/2026-08-20.md`
Активный тикет: `docs/.active_ticket` → `SC-5`

> **Изменение решения по I-02 (зафиксировано после research).** В этом документе
> I-02 описан как «поправить только комментарий, значение `STORAGE_LOCATION` не
> трогать». На этапе plan/реализации решение пересмотрено: продукт ещё не в проде,
> поэтому слот **перегенерирован** из корректной строки `"SettelmentsControl.storage"`
> (новое значение `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`),
> а `scripts/calc.js` переведён с `web3` на `ethers`. Актуальная формулировка — в
> PRD/плане/tasklist; нижеследующие упоминания «только комментарий» считаются устаревшими.

## Резюме

Тикет — набор малых, локальных правок в единственном файле
`contracts/SettelmentsControl.sol` (upgradeable-реализация с ручным слотом EIP-7201
`ContractStorage`). Изменения не затрагивают бизнес-логику расчётов, раскладку
хранилища и значение `STORAGE_LOCATION`:

1. **M-02** — в `initialize` добавить валидацию `_token`/`_admin`/`_owner`/`_feeCollector`
   на `address(0)` через единую ошибку `ZeroAddress()`.
2. **M-03** — `setFeeConfig` перевести с `onlyAdmin` на `onlyOwner`; добавить событие
   `FeeConfigSet(uint256 feePercentage, address feeCollector)` и эмитить его и в
   `setFeeConfig`, и при первичной установке в `initialize`. Верхняя граница
   `feePercentage > 100` не меняется.
3. **L-05** — заменить `require(amount > 0, "...")` на `if (amount == 0) revert ZeroAmount();`
   в `paymentClientToNative` и `backFundsToClient`.
4. **I-02** — поправить **только комментарий** о деривации `STORAGE_LOCATION` без
   изменения значения константы, добавив пояснение о зафиксированной опечатке.
5. **L-01/L-03/L-04** — без изменений кода (решения документальны, зафиксированы в PRD).

Имена `ZeroAddress`, `ZeroAmount`, `FeeConfigSet` **свободны** — коллизий с
существующими ошибками/событиями нет (проверено по `:55-96`). Сигнатуры функций не
меняются (изменения только additive: новые custom errors + новое событие + смена
модификатора одной функции), поэтому break-эффект для потребителей ABI носит
поведенческий/добавочный характер, а не изменение селекторов.

---

## 1. Связанные модули/контракты

| Модуль | Файл | Роль в задаче |
| --- | --- | --- |
| Реализация | `contracts/SettelmentsControl.sol` | **Единственный изменяемый файл.** Правки в `initialize`, `setFeeConfig`, `paymentClientToNative`, `backFundsToClient`, блоки `error`/`event`, комментарий `STORAGE_LOCATION`. |
| Прокси | `contracts/SettelmentsControlProxy.sol` | Не меняется (ERC1967Proxy-обёртка поверх реализации). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Не меняется (не затрагивается этим тикетом). |
| Тесты Hardhat | `test/SettelmentsControl.ts`, `test/SettelmentsControlProxy.ts` | Потребители ABI; **не меняются** (вне скоупа, I-03). Уже неконсистентны (см. §8). |
| Деплой-скрипт | `scripts/deploy.ts` | Потребитель ABI `initialize`; **не меняется**, уже передаёт неверное число аргументов (`:111-116`). |
| Сабграф The Graph | `thegraph/` (`subgraph.yaml`, `schema.graphql`, `abis/SettelmentsControl.json`, `src/settelments-control.ts`) | Потребитель ABI/событий; **не меняется**. Новое событие `FeeConfigSet` не имеет handler → просто не индексируется. |
| Компилятор | `hardhat.config.ts` | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` **выключен** (см. §7). |
| Зависимости | `@openzeppelin/contracts@^5.3.0`, `@openzeppelin/contracts-upgradeable@^5.3.0` | `Initializable` (модификатор `initializer`), `EIP712Upgradeable`, `SafeERC20`, `ECDSA`. |

**Вывод по скоупу:** меняется только `contracts/SettelmentsControl.sol`. Все
остальные файлы — потребители ABI, синхронизация которых вынесена отдельно (находка
I-03 и связанные; в этот пакет не входят I-04/I-05).

---

## 2. Текущий код `contracts/SettelmentsControl.sol` (точные строки)

### 2.1 События (для добавления `FeeConfigSet` в правильном стиле)

`contracts/SettelmentsControl.sol:55-65`:

```solidity
event TopUpClientBalance(string userId, uint256 amount, uint256 currentClientBalance, address sender);
event PaymentClientToNative(SettelmentContext ctx);
event NativeAddressSet(string indexed nativeId, address nativeAddress);
event BackFundsToClient(string userId, address reciever, uint256 amount);
event ChangeAdmin(address newAdmin);
event MaxValiditySet(uint256 maxValidity);
```

Наблюдения по стилю:
- Параметры событий по большей части **не indexed** (кроме `NativeAddressSet.nativeId`).
- Есть прецедент события с двумя простыми параметрами (`BackFundsToClient(string,address,uint256)`).
- Событие `FeeConfigSet(uint256 feePercentage, address feeCollector)` (два простых
  параметра, без `indexed`) соответствует сложившемуся стилю. **Нет** существующего
  события `FeeConfigSet` — имя свободно.

### 2.2 Ошибки (чтобы не дублировать имена и понять стиль)

`contracts/SettelmentsControl.sol:67-96`:

```solidity
error OnlyAdmin();
error OnlyOwner();
error InsufficientClientBalanceForSessionSettelment(SettelmentContext ctx);
error NativeAddressIsOutForSessionSettelment(SettelmentContext ctx);
error InsufficientContractBalanceForSessionSettelment(SettelmentContext ctx);
error InsufficientClientBalanceForBackFunds(string clientId, address clientAddress, uint256 amount, uint256 clientBalance);
error InsufficientContractBalanceForBackFunds(string clientId, address clientAddress, uint256 amount, uint256 clientBalance);
error InvalidSignature();
error NonceAlreadyUsed();
error InvalidNativeAddress();
error EmptyNativeId();
error EmptyNonce();
error FeeTooHigh(uint256 feePercentage);
error InvalidFeeCollector();
error SignatureExpired();
error DeadlineTooFar();
error InvalidMaxValidity();
error InvalidAdmin();
```

Наблюдения по стилю:
- Ошибки без параметров объявляются как `error Xxx();` (например `OnlyAdmin()`,
  `InvalidFeeCollector()`, `InvalidMaxValidity()`, `InvalidAdmin()`).
- Ошибки с параметрами — `error FeeTooHigh(uint256 feePercentage);` и т.п.
- **Имена `ZeroAddress` и `ZeroAmount` отсутствуют** — коллизий нет. Их следует
  объявить в этом блоке, по стилю без аргументов: `error ZeroAddress();` и
  `error ZeroAmount();`. Рекомендуемое место — сразу после `error InvalidAdmin();`
  (`:96`), либо рядом с родственными валидационными ошибками
  (`InvalidFeeCollector`/`InvalidMaxValidity`/`InvalidAdmin`, `:92-96`).

### 2.3 Модификаторы `onlyAdmin`/`onlyOwner`

`contracts/SettelmentsControl.sol:134-148`:

```solidity
modifier onlyAdmin() {
    ContractStorage storage $ = _getContractStorage();
    if (msg.sender != $.admin) {
        revert OnlyAdmin();
    }
    _;
}

modifier onlyOwner() {
    ContractStorage storage $ = _getContractStorage();
    if (msg.sender != $.owner) {
        revert OnlyOwner();
    }
    _;
}
```

Оба модификатора существуют и работоспособны. `onlyOwner` уже используется
`changeAdmin` (`:344`) и `setMaxValidity` (`:360`). `onlyAdmin` используется
`topUpClientBalance` (`:181`), `paymentClientToNative` (`:251`), `backFundsToClient`
(`:297`), `setNativeAddressWithSignature` (`:411`), `setFeeConfig` (`:474`).

Для M-03 достаточно заменить `onlyAdmin` → `onlyOwner` у `setFeeConfig` (`:474`).
Модификатор `onlyOwner` уже объявлен, добавлять ничего не нужно.

### 2.4 `initialize`

`contracts/SettelmentsControl.sol:150-169`:

```solidity
function initialize(
    address _token,
    address _admin,
    address _owner,
    uint256 _feePercentage,
    address _feeCollector,
    uint256 _maxValidity
) external initializer {
    __EIP712_init("SettelmentsControl", "1.0");
    if (_feePercentage > 100) revert FeeTooHigh(_feePercentage);
    if (_maxValidity == 0) revert InvalidMaxValidity();
    ContractStorage storage $ = _getContractStorage();
    $.token = IERC20WithAuthorization(_token);
    $.admin = _admin;
    $.owner = _owner;
    $.feePercentage = _feePercentage;
    $.feeCollector = _feeCollector;
    $.maxValidity = _maxValidity;
    emit ChangeAdmin(_admin);
}
```

Текущий порядок операторов:
1. `__EIP712_init(...)` — `:158`.
2. Проверка `_feePercentage > 100` → `FeeTooHigh` — `:159`.
3. Проверка `_maxValidity == 0` → `InvalidMaxValidity` — `:160`.
4. Получение указателя хранилища `$` — `:161`.
5. Запись в хранилище `token`/`admin`/`owner`/`feePercentage`/`feeCollector`/`maxValidity` — `:162-167`.
6. `emit ChangeAdmin(_admin)` — `:168`.

**Куда вставить проверки `ZeroAddress()` (M-02):** до первой записи в хранилище
(`:162`). Естественная точка — после `__EIP712_init` (`:158`) и перед/рядом с
существующими проверками `:159-160` (порядок проверок между собой не влияет на
корректность, но все они должны идти до записи в `$`). Проверять четыре адреса
`_token`, `_admin`, `_owner`, `_feeCollector` одной и той же ошибкой `ZeroAddress()`.

**Куда вставить `emit FeeConfigSet(...)` (M-03):** после записи `$.feePercentage`
(`:165`) и `$.feeCollector` (`:166`). Эмитить можно по локальным аргументам
`FeeConfigSet(_feePercentage, _feeCollector)` (идентичны только что записанным
значениям). Позиция относительно существующего `emit ChangeAdmin(_admin)` (`:168`)
несущественна; логично разместить сразу после записи полей комиссии (после `:166`).

### 2.5 `setFeeConfig`

`contracts/SettelmentsControl.sol:471-481`:

```solidity
function setFeeConfig(
    uint256 feePercentage,
    address feeCollector
) external onlyAdmin {
    if (feePercentage > 100) revert FeeTooHigh(feePercentage);
    if (feeCollector == address(0)) revert InvalidFeeCollector();

    ContractStorage storage $ = _getContractStorage();
    $.feePercentage = feePercentage;
    $.feeCollector = feeCollector;
}
```

Текущее состояние: модификатор `onlyAdmin` (`:474`), проверки
`feePercentage > 100` (`:475`) и `feeCollector == address(0)` (`:476`), затем запись
`:478-480`. События нет.

**Что меняется (M-03):**
- Модификатор `onlyAdmin` → `onlyOwner` (`:474`).
- **Порядок проверок сохранить**: сначала `feePercentage > 100` → `FeeTooHigh`
  (`:475`), затем `feeCollector == address(0)` → `InvalidFeeCollector` (`:476`).
- После записи `$.feeCollector = feeCollector;` (`:480`) добавить
  `emit FeeConfigSet(feePercentage, feeCollector);`.
- Верхнюю границу `feePercentage > 100` **не менять** (осознанно оставлено).

### 2.6 `getFeeConfig`

`contracts/SettelmentsControl.sol:483-486`:

```solidity
function getFeeConfig() external view returns (uint256 feePercentage, address feeCollector) {
    ContractStorage storage $ = _getContractStorage();
    return ($.feePercentage, $.feeCollector);
}
```

Не меняется. Геттер остаётся `view`-парой `(feePercentage, feeCollector)`; на него
перевод `setFeeConfig` на `onlyOwner` не влияет.

### 2.7 `paymentClientToNative` — строка для замены (L-05)

`contracts/SettelmentsControl.sol:244-292`. Релевантная строка `:252`:

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
    ...
}
```

Строка `require(amount > 0, "Settlement amount between client and native must be > 0");`
(`:252`) заменяется на:

```solidity
if (amount == 0) revert ZeroAmount();
```

`amount` — `uint256`, поэтому `amount > 0` ⇔ `amount != 0` ⇔ `!(amount == 0)` —
семантика эквивалентна.

### 2.8 `backFundsToClient` — строка для замены (L-05)

`contracts/SettelmentsControl.sol:294-332`. Релевантная строка `:298`:

```solidity
function backFundsToClient(
    string calldata userId,
    uint256 amount
) external onlyAdmin {
    require(amount > 0, "Back fund amount to client must be > 0");
    ...
}
```

Строка `require(amount > 0, "Back fund amount to client must be > 0");` (`:298`)
заменяется на:

```solidity
if (amount == 0) revert ZeroAmount();
```

---

## 3. Паттерны, которым нужно следовать

1. **Custom errors** — код консистентно использует `error Xxx(...)` + `if (...) revert Xxx(...)`
   (пример: `:159`, `:160`, `:475`, `:476`). Единственное место со строковыми
   `require` — `:252` и `:298` (это и есть L-05). Новые `ZeroAddress()`/`ZeroAmount()`
   должны быть без аргументов, как `OnlyAdmin()`/`InvalidFeeCollector()`.
2. **События** — эмитятся после мутации состояния (пример `setMaxValidity` `:360-364`,
   `changeAdmin` `:344-349`). `FeeConfigSet` эмитится после записи полей комиссии.
3. **Модификаторы** — `onlyAdmin`/`onlyOwner` читают роль из `ContractStorage`
   (`:134-148`); перевод `setFeeConfig` на `onlyOwner` — чистая замена одного готового
   модификатора другим.
4. **Ручной слот EIP-7201** — всё персистентное состояние в `ContractStorage`
   (`:107-117`); новые поля состояния НЕ добавляются (M-02/M-03/L-05/I-02 не требуют
   новых полей). `STORAGE_LOCATION` (`:99-100`) не трогается.

---

## 4. `STORAGE_LOCATION` — точный комментарий (I-02)

`contracts/SettelmentsControl.sol:98-100`:

```solidity
// keccak256(abi.encode(uint256(keccak256("SettelmentControle.storage")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant STORAGE_LOCATION =
    0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00;
```

Факты:
- В строке деривации присутствует опечатка `"SettelmentControle.storage"` (лишняя `e`).
- Значение `0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00`
  **корректно** и выведено именно из этой (опечаточной) строки (подтверждено аудитом,
  `docs/audit-reports/2026-08-20.md:361-368`).
- Поэтому «исправлять» строку на правильное написание **нельзя** — комментарий тогда
  перестал бы соответствовать фактической деривации значения, а случайная
  перегенерация слота по «исправленной» строке привела бы к расхождению слота и потере
  данных.

**Рекомендуемая правка (только комментарий, значение не трогать):** оставить строку
деривации как есть (она исторически точна) и добавить явное пояснение, что опечатка
зафиксирована намеренно и менять её нельзя. Примерный вид:

```solidity
// ВНИМАНИЕ: в строке ниже опечатка «SettelmentControle.storage» зафиксирована НАМЕРЕННО.
// Значение STORAGE_LOCATION выведено именно из этой (опечаточной) строки — НЕ исправлять.
// keccak256(abi.encode(uint256(keccak256("SettelmentControle.storage")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant STORAGE_LOCATION =
    0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00;
```

Точная формулировка — на усмотрение имплементера/плана, но ключевые инварианты:
значение константы бит-в-бит прежнее, строка в комментарии не «исправляется»,
добавляется пояснение об опечатке.

---

## 5. Рекомендуемая раскладка правок по строкам

| Что | Где (строка) | Правка |
| --- | --- | --- |
| `event FeeConfigSet(uint256 feePercentage, address feeCollector);` | после `:65` (блок событий) | добавить событие |
| `error ZeroAddress();` / `error ZeroAmount();` | после `:96` (блок ошибок) | добавить ошибки |
| Комментарий `STORAGE_LOCATION` | `:98` | добавить пояснение об опечатке (значение `:99-100` не трогать) |
| `initialize`: проверки `ZeroAddress()` | после `:158` (до записи `:162`) | `if (_token == address(0) || _admin == address(0) || _owner == address(0) || _feeCollector == address(0)) revert ZeroAddress();` (или 4 отдельные проверки) |
| `initialize`: `emit FeeConfigSet(...)` | после `:166` | `emit FeeConfigSet(_feePercentage, _feeCollector);` |
| `paymentClientToNative` | `:252` | `require(...)` → `if (amount == 0) revert ZeroAmount();` |
| `backFundsToClient` | `:298` | `require(...)` → `if (amount == 0) revert ZeroAmount();` |
| `setFeeConfig`: модификатор | `:474` | `onlyAdmin` → `onlyOwner` |
| `setFeeConfig`: событие | после `:480` | `emit FeeConfigSet(feePercentage, feeCollector);` |

---

## 6. Конфигурация компиляции (`hardhat.config.ts`)

`hardhat.config.ts:8-16`:

```ts
solidity: {
  version: "0.8.28",
  settings: {
    optimizer: {
      enabled: true,
      runs: 1000,
    },
  },
},
```

- Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` **не задан** (выключен).
- **Критерий успеха:** `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `viaIR`.
- Изменения тикета не должны спровоцировать «Stack too deep» (историческая находка
  C-01 уже устранена в текущем коде использованием `SettelmentContext memory ctx`
  вместо 11 параметров ошибок). Добавляемые правки не вводят новых стековых давлений:
  проверки адресов — простые сравнения, `emit FeeConfigSet` с 2 скалярными аргументами.
- Изменение ABI (новые ошибки `ZeroAddress`/`ZeroAmount`, событие `FeeConfigSet`)
  допустимо: прод не развёрнут (PRD §Ограничения).

---

## 7. Ограничения и риски

1. **Не добавлять поля в `ContractStorage`** (`:107-117`) и **не менять
   `STORAGE_LOCATION`** (`:99-100`) — раскладка персистентного состояния обязана
   остаться неизменной (upgradeable-прокси).
2. **Риск расхождения слота (I-02):** любое «исправление» строки
   `"SettelmentControle.storage"` в комментарии/при перегенерации константы → потеря
   данных. Правка строго ограничена добавлением пояснения.
3. **Риск изменения ABI:** новые ошибки/событие + смена модификатора `setFeeConfig`
   делают неконсистентными потребителей ABI (тесты, deploy-скрипт, сабграф). Это
   осознанно, обвязка вне скоупа (I-03).
4. **Риск разграничения ролей:** перевод `setFeeConfig` на `onlyOwner` требует, чтобы
   `owner` был под контролем. Если `owner == admin`, разграничение теряется (уже
   задокументировано в SC-2). В `initialize` `_owner` теперь валидируется на
   `address(0)` (M-02), что снимает риск «сломанного» `onlyOwner`.
5. **Семантика `feePercentage`:** верхняя граница `100` осознанно оставлена (M-03),
   несмотря на замечание аудита про базисные пункты — в этом тикете не меняется.

---

## 8. Потребители ABI, которые станут неконсистентны (вне скоупа, I-03)

Изменения ABI в SC-5 — **additive** (новые ошибки `ZeroAddress`/`ZeroAmount`, новое
событие `FeeConfigSet`) плюс поведенческое (смена модификатора `setFeeConfig`).
Селекторы функций не меняются. Тем не менее потребители уже неконсистентны и остаются
вне скоупа:

- **`test/SettelmentsControl.ts:37`** — `initialize(await token.getAddress(), admin.address)`
  (2 аргумента вместо 6); тест не компилируется/не отражает текущий ABI (I-03).
- **`test/SettelmentsControlProxy.ts:46`** — `initialize(token.target, admin.address)`
  (2 аргумента вместо 6); аналогично.
- **`scripts/deploy.ts:111-116`** — `initialize` с 2 аргументами
  `[erc20Address, account.address]` (ожидается 6); скрипт не вызывает `setFeeConfig`.
- **`thegraph/`**:
  - `thegraph/abis/SettelmentsControl.json` — сгенерированный ABI устареет (нужен
    `yarn codegen` после перегенерации ABI — отдельная задача).
  - `thegraph/subgraph.yaml:29-43` — eventHandlers не включают `FeeConfigSet`
    (событие просто не будет индексироваться, это допустимо для SC-5).
  - `thegraph/schema.graphql` — сущность для `FeeConfigSet` не добавлена (вне скоупа).

Синхронизация перечисленного — **отдельная задача** (находка I-03; вынесена из SC-5).

---

## 9. Открытые технические вопросы

1. **Точная формулировка комментария I-02.** Формула деривации исторически точна
   (содержит опечатку, из которой выведено значение). Открыт выбор: (а) оставить
   формулу как есть и добавить предупреждение «не исправлять» (рекомендовано в §4),
   либо (б) переформулировать комментарий без литеральной строки. Оба варианта не
   трогают значение константы — решение закрепить в плане.
2. **Форма проверки `ZeroAddress()` в `initialize`.** Один составной
   `if (a == 0 || b == 0 || c == 0 || d == 0) revert ZeroAddress();` vs четыре
   отдельных `if (...) revert ZeroAddress();`. Функционально эквивалентны; составная
   форма компактнее, но менее информативна для дебага. Не блокирует.
3. **`emit FeeConfigSet` в `initialize` — по аргументам или по `$`.** Эквивалентны
   (значения только что записаны). Рекомендуется по аргументам
   `(_feePercentage, _feeCollector)` для читаемости «первичной установки».
4. **Нет блокирующих вопросов.** Все продуктовые решения (граница `100`, round down,
   `lastInboundAddress`, доверие админу в `topUpClientBalance`) зафиксированы в PRD и
   в этот тикет не входят.

---

## 10. Источники

- `docs/prd/SC-5.prd.md` — принятые решения и скоуп.
- `docs/audit-reports/2026-08-20.md` — находки M-02/M-03/L-01/L-03/L-04/L-05/I-02/I-03.
- `contracts/SettelmentsControl.sol` — текущий код (строки `:55-65`, `:67-96`,
  `:98-100`, `:107-117`, `:134-148`, `:150-169`, `:244-292`, `:294-332`,
  `:344-349`, `:360-364`, `:471-486`).
- `hardhat.config.ts` — компилятор/оптимизатор.
- `test/`, `scripts/deploy.ts`, `thegraph/` — потребители ABI (вне скоупа).
