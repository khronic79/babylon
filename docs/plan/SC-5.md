# SC-5: План — пакет малых исправлений контракта (M-02…I-02)

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-5.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-5.md` (Status: RESEARCH)
- Аудит (источник находок M-02…I-02): `docs/audit-reports/2026-08-20.md`
- ADR: **не создаётся** — значимых архитектурных развилок нет; все решения уже
  зафиксированы в PRD/исследовании (см. §7).

## 1. Components

| Компонент | Файл / строки | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Реализация | `contracts/SettelmentsControl.sol` | **Да (основной файл)** | Правки в блок ошибок/событий, `initialize`, `setFeeConfig`, `paymentClientToNative`, `backFundsToClient`, перегенерация `STORAGE_LOCATION`. |
| Блок событий | `:55-65` | Да | Добавить `event FeeConfigSet(uint256 feePercentage, address feeCollector);` после `MaxValiditySet` (`:65`). |
| Блок ошибок | `:67-96` | Да | Добавить `error ZeroAddress();` и `error ZeroAmount();` после `InvalidAdmin` (`:96`). |
| `STORAGE_LOCATION` | `:98-100` | Да (перегенерация) | Значение пересчитано из `"SettelmentsControl.storage"` → `0xa3644cd4f…`. |
| `scripts/calc.js` | генератор слота | Да | Строка namespace `"SettelmentsControl.storage"`; перевод с `web3` на `ethers`. |
| `initialize` | `:150-169` | Да | Валидация адресов `ZeroAddress()` (M-02), `emit FeeConfigSet(...)` (M-03). |
| `paymentClientToNative` | `:244-292` (строка `:252`) | Да | `require(...)` → `if (amount == 0) revert ZeroAmount();` (L-05). |
| `backFundsToClient` | `:294-332` (строка `:298`) | Да | `require(...)` → `if (amount == 0) revert ZeroAmount();` (L-05). |
| `setFeeConfig` | `:471-481` | Да | Модификатор `onlyAdmin` → `onlyOwner`, `emit FeeConfigSet(...)` (M-03). |
| Прокси | `contracts/SettelmentsControlProxy.sol` | Нет | Не меняется (ERC1967Proxy-обёртка). |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | Нет | Не затрагивается. |
| Тесты | `test/` | Нет | Потребители ABI; **не меняются** (вне скоупа, I-03). Уже неконсистентны. |
| Деплой-скрипт | `scripts/deploy.ts` | Нет | Потребитель ABI `initialize`; **не меняется**. |
| Сабграф | `thegraph/` | Нет | **не меняется**; `FeeConfigSet` не имеет handler → не индексируется (допустимо). |
| Компилятор | `hardhat.config.ts` | Нет | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` выключен. |

**Итог по скоупу:** меняется ровно один файл — `contracts/SettelmentsControl.sol`.
Правки локальные и additive (новые ошибки/событие + смена модификатора одной функции);
сигнатуры функций не меняются.

---

## 2. API contract (целевые интерфейсы и контракты)

### 2.1 Новое событие и новые ошибки (M-02, M-03, L-05)

После строки `:65` (`event MaxValiditySet(uint256 maxValidity);`) добавить:

```solidity
event FeeConfigSet(uint256 feePercentage, address feeCollector);
```

После строки `:96` (`error InvalidAdmin();`) добавить:

```solidity
error ZeroAddress();
error ZeroAmount();
```

Пояснения:
- Имена `FeeConfigSet`, `ZeroAddress`, `ZeroAmount` **свободны** — коллизий с
  существующими событиями/ошибками нет (проверено, исследование §2.1/§2.2).
- `FeeConfigSet` — два простых параметра без `indexed`, что соответствует сложившемуся
  стилю событий контракта (прецедент: `BackFundsToClient(string,address,uint256)`).
- `ZeroAddress()`/`ZeroAmount()` — без аргументов, в стиле `OnlyAdmin()`/
  `InvalidFeeCollector()`.

### 2.2 `initialize` (M-02, M-03) — до/после

**До** (`:150-169`):

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

**После**:

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
    if (
        _token == address(0) ||
        _admin == address(0) ||
        _owner == address(0) ||
        _feeCollector == address(0)
    ) revert ZeroAddress();
    ContractStorage storage $ = _getContractStorage();
    $.token = IERC20WithAuthorization(_token);
    $.admin = _admin;
    $.owner = _owner;
    $.feePercentage = _feePercentage;
    $.feeCollector = _feeCollector;
    $.maxValidity = _maxValidity;
    emit FeeConfigSet(_feePercentage, _feeCollector);
    emit ChangeAdmin(_admin);
}
```

**Порядок операторов (обоснование):**

1. `__EIP712_init(...)` — остаётся первым (как сейчас).
2. Проверки значений `_feePercentage > 100` (`FeeTooHigh`) и `_maxValidity == 0`
   (`InvalidMaxValidity`) — **остаются на месте** (не переносятся), чтобы минимизировать
   дифф и сохранить уже обкатанный порядок.
3. Проверка адресов `ZeroAddress()` — **после** двух существующих проверок и **до**
   первой записи в `$` (`:162`). Все три проверки сгруппированы как «валидация до
   мутации»; относительный порядок между ними на корректность не влияет (все — чистые
   `revert` без побочных эффектов), но `ZeroAddress` идёт последним из проверок, чтобы
   не сдвигать существующие строки `:159-160`.
4. Запись всех полей в `$` — без изменений (`:162-167`).
5. `emit FeeConfigSet(_feePercentage, _feeCollector);` — **сразу после записи
   fee-полей** (`$.feeCollector`, `:166`) и `$.maxValidity` (`:167`). Эмиссия сразу
   после мутации соответствующего состояния — паттерн, уже используемый контрактом
   (`setMaxValidity`/`changeAdmin` эмитят после записи). Эмитим по аргументам
   (`_feePercentage`, `_feeCollector`) — они идентичны только что записанным значениям
   и читаются как «первичная установка» (исследование §9.3).
6. `emit ChangeAdmin(_admin);` — **остаётся последним**. Оно относится к роли `admin`,
   а не к комиссии, и исторически является завершающим событием инициализации. Порядок
   «сначала комиссия, затем смена админа» даёт семантическую связность (событие
   комиссии идёт сразу за записью комиссии), не влияя на потребителей (оба события
   эмитятся в одной транзакции, порядок логов для off-chain не принципиален).

> Альтернатива «`emit ChangeAdmin` перед `emit FeeConfigSet`» функционально
> эквивалентна; выбран порядок `FeeConfigSet` → `ChangeAdmin` из соображений
> когезии (событие комиссии непосредственно после записи комиссии, `ChangeAdmin` —
> завершающее, как и сейчас).

### 2.3 `setFeeConfig` (M-03) — до/после

**До** (`:471-481`):

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

**После**:

```solidity
function setFeeConfig(
    uint256 feePercentage,
    address feeCollector
) external onlyOwner {
    if (feePercentage > 100) revert FeeTooHigh(feePercentage);
    if (feeCollector == address(0)) revert InvalidFeeCollector();
    
    ContractStorage storage $ = _getContractStorage();
    $.feePercentage = feePercentage;
    $.feeCollector = feeCollector;
    emit FeeConfigSet(feePercentage, feeCollector);
}
```

Изменения:
- Модификатор `onlyAdmin` → `onlyOwner` (`:474`). Модификатор `onlyOwner` уже объявлен
  (`:142-148`) и используется `changeAdmin`/`setMaxValidity` — добавлять ничего не нужно.
- **Порядок проверок сохраняется**: сначала `feePercentage > 100` → `FeeTooHigh`
  (`:475`), затем `feeCollector == address(0)` → `InvalidFeeCollector` (`:476`).
- После записи `$.feeCollector = feeCollector;` добавлен
  `emit FeeConfigSet(feePercentage, feeCollector);`.
- Верхняя граница `feePercentage > 100` **не меняется** (осознанно оставлено, PRD §1).

### 2.4 `paymentClientToNative` (L-05) — до/после

**До** (`:252`):

```solidity
require(amount > 0, "Settlement amount between client and native must be > 0");
```

**После**:

```solidity
if (amount == 0) revert ZeroAmount();
```

`amount` — `uint256`, поэтому `amount > 0` ⇔ `amount != 0` ⇔ `!(amount == 0)` —
семантика эквивалентна.

### 2.5 `backFundsToClient` (L-05) — до/после

**До** (`:298`):

```solidity
require(amount > 0, "Back fund amount to client must be > 0");
```

**После**:

```solidity
if (amount == 0) revert ZeroAmount();
```

### 2.6 Перегенерация `STORAGE_LOCATION` (I-02) — до/после

**До** (`:98-100`):

```solidity
// keccak256(abi.encode(uint256(keccak256("SettelmentControle.storage")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant STORAGE_LOCATION =
    0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00;
```

**После**:

```solidity
// keccak256(abi.encode(uint256(keccak256("SettelmentsControl.storage")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant STORAGE_LOCATION =
    0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00;
```

Инвариант: строка namespace — `"SettelmentsControl.storage"` (по имени контракта);
значение константы перегенерировано и воспроизводится `scripts/calc.js` (переведён с
`web3` на `ethers`). Безопасно, т.к. продукт не в проде; после деплоя слот менять нельзя.
(она исторически точна); добавляется только пояснение.

---

## 3. Data flows

### 3.1 `initialize` (порядок проверок и мутаций)

```
initialize(_token, _admin, _owner, _feePercentage, _feeCollector, _maxValidity)
        │ external initializer
        ▼
[1] __EIP712_init("SettelmentsControl", "1.0")
[2] _feePercentage > 100      ? → revert FeeTooHigh(_feePercentage)
[3] _maxValidity == 0         ? → revert InvalidMaxValidity()
[4] _token==0 || _admin==0 || _owner==0 || _feeCollector==0 ? → revert ZeroAddress()
[5] $.token/.admin/.owner/.feePercentage/.feeCollector/.maxValidity = ...
[6] emit FeeConfigSet(_feePercentage, _feeCollector)
[7] emit ChangeAdmin(_admin)
```

### 3.2 `setFeeConfig` (только owner, событие после мутации)

```
setFeeConfig(feePercentage, feeCollector)
        │ external onlyOwner          ← было onlyAdmin (M-03)
        ▼
[1] feePercentage > 100       ? → revert FeeTooHigh(feePercentage)
[2] feeCollector == address(0)? → revert InvalidFeeCollector()
[3] $.feePercentage = feePercentage; $.feeCollector = feeCollector
[4] emit FeeConfigSet(feePercentage, feeCollector)
```

### 3.3 Custom errors в `paymentClientToNative`/`backFundsToClient` (L-05)

```
paymentClientToNative(...) → if (amount == 0) revert ZeroAmount();   // было require(amount > 0, "...")
backFundsToClient(...)     → if (amount == 0) revert ZeroAmount();   // было require(amount > 0, "...")
```

---

## 4. NFR (нефункциональные требования)

1. **Чистая компиляция без `viaIR`:** `rm -rf artifacts cache && npx hardhat compile`
   → exit 0. Solidity `0.8.28`, optimizer `enabled: true, runs: 1000`, `viaIR` выключен
   (конфиг не меняется).
2. **Ручной слот перегенерирован (I-02):** `STORAGE_LOCATION` = `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00` (из
   `"SettelmentsControl.storage"`); структура `ContractStorage` (`:107-117`) не меняется.
3. **Новых персистентных полей нет:** изменения additive (событие/ошибки/модификатор),
   в `ContractStorage` ничего не добавляется; раскладка upgradeable-хранилища
   сохраняется.
4. **Stack too deep:** правки не добавляют стекового давления — проверки адресов это
   простые сравнения, `emit FeeConfigSet` с двумя скалярными аргументами. Риск низкий;
   при гипотетическом `Stack too deep` в `initialize` правка локализуется выносом
   проверки адресов в приватный хелпер (без изменения ABI).

---

## 5. Trade-off (явно зафиксирован)

1. **Изменение ABI — additive.** Новые custom errors `ZeroAddress`/`ZeroAmount`, новое
   событие `FeeConfigSet`, смена модификатора `setFeeConfig` (`onlyAdmin` →
   `onlyOwner`). Селекторы функций не меняются; break-эффект носит
   поведенческий/добавочный характер. **Допустимо:** прод не развёрнут (PRD
   §«Ограничения»). Потребители ABI — `test/`, `scripts/deploy.ts`, `thegraph/` —
   **вне скоупа SC-5** (синхронизация вынесена в I-03).
2. **`setFeeConfig` под управлением `owner`.** Комиссия становится управленческим
   параметром (роль `owner`), а не операционным (`admin`). Цена — операционные админы
   теряют возможность менять комиссию; при `owner == admin` разграничение ролей
   фактически исчезает. Осознанно: `owner` уже управляет `changeAdmin`/`setMaxValidity`;
   валидация `_owner != address(0)` в `initialize` (M-02) снимает риск «сломанного»
   `onlyOwner`.
3. **Форма проверки `ZeroAddress` — один составной `if`.** Выбрана компактная форма
   `if (a == 0 || b == 0 || c == 0 || d == 0) revert ZeroAddress();` (соответствует
   формулировке «единая ошибка `ZeroAddress()`»). Цена — менее информативно при
   отладке (не видно, какой именно адрес нулевой). Альтернатива (4 отдельных `if`)
   функционально эквивалентна и допустима, если имплементер предпочтёт точечный дебаг.
4. **Верхняя граница `feePercentage > 100` не меняется** (несмотря на замечание аудита
   про базисные пункты) — осознанно зафиксировано в PRD §1, в этот тикет не входит.
5. **`FeeConfigSet` эмитится и в `initialize`, и в `setFeeConfig`** — единый источник
   события о конфигурации комиссии для off-chain мониторинга/аудита. В `initialize`
   эмиссия по аргументам `(_feePercentage, _feeCollector)` (идентичны записанным
   значениям), в `setFeeConfig` — по аргументам функции.

---

## 6. Risks

1. **Перевод `setFeeConfig` на `onlyOwner`.** Если `owner == admin` (или `owner` потерян/
   передан не под контроль), управление комиссией блокируется/теряет разграничение.
   Митигация: `_owner` валидируется на `address(0)` (M-02); сценарий `owner == admin`
   задокументирован в SC-2 и остаётся вне скоупа.
2. **Перегенерация `STORAGE_LOCATION` (I-02).** Смена слота безопасна только до деплоя;
   после деплоя менять нельзя (потеря данных). Митигация: значение и namespace
   `"SettelmentsControl.storage"` зафиксированы в §2.6; продукт не в проде.
3. **Ошибки именования.** Новые имена `ZeroAddress`/`ZeroAmount`/`FeeConfigSet` должны
   быть введены в точности (регистр, отсутствие аргументов) — иначе селекторы ошибок/
   событий off-chain не сматчатся. Митигация: имена сверены с PRD/исследованием и
   коллизии проверены (свободны).
4. **Неконсистентность потребителей ABI.** `test/`, `scripts/deploy.ts` (вызывают
   `initialize` с 2 аргументами вместо 6), `thegraph/` (нет handler для `FeeConfigSet`)
   останутся несинхронными. Митигация: осознанно вынесено в I-03, вне скоупа SC-5;
   зафиксировано в PRD §«Ограничения» и в этом плане.
5. **Семантическая эквивалентность `require` → `if/revert`.** `require(amount > 0)`
   эквивалентно `if (amount == 0) revert ZeroAmount()` для `uint256`; риск потери
   поведения отсутствует. Единственное отличие — error selector вместо строкового
   сообщения (это и есть цель L-05).

---

## 7. ADR (развилки)

Значимых архитектурных развилок нет — ADR **не создаётся**. Все решения уже приняты и
зафиксированы в PRD (`docs/prd/SC-5.prd.md`) и исследовании
(`docs/research/SC-5.md`): граница `100` не меняется, `FeeConfigSet` эмитится и в
`initialize`, и в `setFeeConfig`, `setFeeConfig` → `onlyOwner`, L-01/L-03/L-04 — без
изменений кода. Неблокирующие вариативные пункты (форма `ZeroAddress`-проверки, точная
формулировка комментария I-02, порядок `FeeConfigSet`/`ChangeAdmin`) закрыты решениями
в §2.2/§2.6 и не требуют отдельного ADR.

---

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `viaIR`
  (optimizer `runs=1000`, Solidity `0.8.28`).
- В блоке ошибок присутствуют `error ZeroAddress();` и `error ZeroAmount();`; в блоке
  событий — `event FeeConfigSet(uint256 feePercentage, address feeCollector);`.
- `initialize` ревертится `ZeroAddress()` при любом из `_token`/`_admin`/`_owner`/
  `_feeCollector == address(0)`; `emit FeeConfigSet` присутствует (по аргументам), после
  записи fee-полей.
- `setFeeConfig` имеет модификатор `onlyOwner`, сохраняет проверки `FeeTooHigh`/
  `InvalidFeeCollector` в прежнем порядке и эмитит `FeeConfigSet` после записи.
- В `paymentClientToNative`/`backFundsToClient` строковые `require(amount > 0, ...)`
  заменены на `if (amount == 0) revert ZeroAmount();`.
- `STORAGE_LOCATION` перегенерирован из `"SettelmentsControl.storage"` =
  `0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00`; `scripts/calc.js`
  воспроизводит значение; `ContractStorage` и раскладка полей не изменены, новых полей нет.
- `test/`, `scripts/deploy.ts`, `thegraph/` — вне скоупа и не являются критерием приёмки.

---

## 9. Open questions

- **Нет блокирующих.** Неблокирующие (вне скоупа SC-5, отдельные задачи):
  - синхронизация `test/`, `scripts/deploy.ts`, `thegraph/` с обновлённым ABI
    (I-03 и связанные);
  - добавление handler/сущности для `FeeConfigSet` в сабграфе — при необходимости,
    отдельная задача (в SC-5 событие просто не индексируется).
