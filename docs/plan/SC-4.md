# SC-4: План — совместимость топ-апа с EIP-3009 (H-03)

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-4.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-4.md` (Status: RESEARCH)
- Аудит (источник H-03): `docs/audit-reports/2026-08-20.md` (`:199-217`)
- ADR (развилка «`ECDSA.tryRecover` vs `SignatureChecker`»): `docs/adr/SC-4.md`

## 1. Components

| Компонент | Файл | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Мок-токен | `contracts/mock/ERC20Mock.sol` | **Да (целиком)** | Наследование `EIP712` (non-upgradeable, `version="2"`), добавление `receiveWithAuthorization` (split), `version()`, `authorizationState()`, nonce-mapping, custom-ошибки. |
| Реализация | `contracts/SettelmentsControl.sol` | **Нет** | Не меняется (проверка EIP-3009 в `initialize` исключена из скоупа). |
| Интерфейс токена | `contracts/SettelmentsControl.sol:18-30` (`IERC20WithAuthorization`) | **Нет** | Не расширяется. |
| `topUpClientBalance` | `contracts/SettelmentsControl.sol:171-209` | **Нет** | Вызов `$.token.receiveWithAuthorization(...)` уже корректен (split-сигнатура USDC). |
| Деплой-скрипт | `scripts/deploy.ts` | Нет | Потребитель ABI мока; станет неконсистентным (вне скоупа). |
| Тесты | `test/` | Нет | Потребители ABI мока; уже неконсистентны (I-03), синхронизация вне скоупа. |
| Сабграф | `thegraph/` | Нет | Индексирует события `SettelmentsControl`, не ABI мока. |
| Компилятор | `hardhat.config.ts` | Нет | Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` выключен. |
| Зависимости | `@openzeppelin/contracts@^5.3.0` | Нет | `EIP712`, `ECDSA` (мок). |

**Итог по скоупу:** меняется ровно один файл — `contracts/mock/ERC20Mock.sol`
(целиком). `SettelmentsControl.sol` (ручной слот `STORAGE_LOCATION`, структура
`ContractStorage`, все функции/события/ошибки) остаётся **без изменений**.

---

## 2. API contract (целевые интерфейсы и контракты)

### 2.1 `contracts/mock/ERC20Mock.sol` (целевая форма)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract ERC20Mock is ERC20, EIP712 {
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    // nonce per authorizer (authorizer => nonce => used)
    mapping(address authorizer => mapping(bytes32 nonce => bool used))
        private _authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error PayeeMustBeCaller();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();

    constructor(
        string memory name,
        string memory symbol,
        address initialAccount,
        uint256 initialBalance
    ) ERC20(name, symbol) EIP712(name, "2") {
        _mint(initialAccount, initialBalance);
    }

    function mint(address account, uint256 amount) public {
        _mint(account, amount);
    }

    function version() external pure returns (string memory) {
        return "2";
    }

    function authorizationState(
        address authorizer,
        bytes32 nonce
    ) external view returns (bool) {
        return _authorizationState[authorizer][nonce];
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert PayeeMustBeCaller();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            digest,
            abi.encodePacked(r, s, v)
        );
        if (err != ECDSA.RecoverError.NoError || signer != from) {
            revert InvalidAuthorizationSignature();
        }

        _authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }
}
```

Пояснения к целевому виду:

- **Наследование `EIP712(name, "2")`** (non-upgradeable) — `version = "2"`, как у USDC.
  `name` пробрасывается из конструктора мока (исследование §7: домен соответствует имени
  токена; у USDC это `"USD Coin"`, у мока — параметр `name`). Число аргументов
  конструктора мока **не меняется** (4: `name, symbol, initialAccount, initialBalance`),
  поэтому deploy-скрипт (`scripts/deploy.ts:33-37`) по числу аргументов не ломается.
- **Typehash** `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` =
  `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8` (сверено
  локально через `ethers.id(...)`, совпадает с PRD/исследованием).
- **Nonce-tracking:** `mapping(address authorizer => mapping(bytes32 nonce => bool used))`
  — nonce per authorizer (как `authorizationState[from][nonce]` у USDC), плюс view
  `authorizationState(address,bytes32)` для совместимости и будущих тестов.
- **Порядок проверок** (семантика USDC, исследование §5.3):
  1. `to != msg.sender` → `PayeeMustBeCaller()` (аналог `"FiatTokenV2: caller must be
     the payee"`; в `topUpClientBalance` `to = address(this)` контракта и `msg.sender`
     внутри токена = контракт → проходит);
  2. `block.timestamp <= validAfter` → `AuthorizationNotYetValid()` (**строгое**
     `block.timestamp > validAfter`);
  3. `block.timestamp >= validBefore` → `AuthorizationExpired()` (**строгое**
     `block.timestamp < validBefore`);
  4. nonce уже использован → `AuthorizationAlreadyUsed()`;
  5. неверная подпись → `InvalidAuthorizationSignature()`;
  6. пометка nonce + `AuthorizationUsed(from, nonce)` + `_transfer(from, to, value)`.
- **Верификация split-подписи:** digest = `_hashTypedDataV4(structHash)`, который
  внутри вызывает `MessageHashUtils.toTypedDataHash(_domainSeparatorV4(), structHash)`
  (= `keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash)`). Подпись собирается как
  `abi.encodePacked(r, s, v)` — **65 байт в порядке `r ‖ s ‖ v`** (порядок важен: не
  `v ‖ r ‖ s`). Используется `ECDSA.tryRecover(bytes32, bytes)` с маппингом любого
  `RecoverError` (неверная длина, high-s, неверный `v`, нулевой signer) **и** несовпадения
  `signer != from` в единую ошибку `InvalidAuthorizationSignature()` — как USDC
  (любая невалидная подпись → единый revert).
- **Что НЕ переносится** (PRD §«Ограничения»): blacklist, pausable, permit/EIP-2612,
  `transferWithAuthorization`, `cancelAuthorization`, `DOMAIN_SEPARATOR()` — только
  необходимое для `receiveWithAuthorization`.

> `SettelmentsControl.sol` **не изменяется**. Проверка поддержки EIP-3009 в
> `initialize` (бывший «Вариант C») исключена из скоупа по решению пользователя —
> признана ненадёжной эвристикой (EIP-3009 не определяет ERC165 id; `version()=="2"`
> даёт ложные срабатывания/пропуски).

---

## 3. Data flows

### 3.1 Топ-ап с моком (`topUpClientBalance` → `receiveWithAuthorization`)

```
topUpClientBalance(userId, from, value, validAfter, validBefore, nonce, v, r, s)
        │ onlyAdmin
        ▼
$.token.receiveWithAuthorization(from, address(this), value, ..., v, r, s)
        │  (внутри токена: to = address(SettelmentsControl), msg.sender = SettelmentsControl)
        ▼
[1] to != msg.sender ?            → PayeeMustBeCaller()   (в этом сценарии проходит)
[2] block.timestamp <= validAfter ? → AuthorizationNotYetValid()  (нужно > validAfter)
[3] block.timestamp >= validBefore ? → AuthorizationExpired()     (нужно < validBefore)
[4] _authorizationState[from][nonce] ? → AuthorizationAlreadyUsed()
[5] structHash = keccak256(TYPEHASH, from, to, value, validAfter, validBefore, nonce)
    digest = _hashTypedDataV4(structHash)
        = MessageHashUtils.toTypedDataHash(_domainSeparatorV4(), structHash)
        = keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash)
    ECDSA.tryRecover(digest, abi.encodePacked(r, s, v))
      err != NoError || signer != from ? → InvalidAuthorizationSignature()
[6] _authorizationState[from][nonce] = true; emit AuthorizationUsed(from, nonce)
[7] _transfer(from, to, value)   // ERC20._update: списание у from, зачисление контракту
        │
        ▼
возврат в topUpClientBalance: clientBalance.balance += value; lastInboundAddress = from
```

**Нюанс домена (из исследования §5.4/§7):** домен включает `verifyingContract =
address(this)` (адрес токена). Поэтому подпись, валидная для USDC, **не** валидна для
мока напрямую и наоборот. «Совместимость» означает: одинаковые `name`/`version`/typehash,
так что тот же инструментарий `signTypedData` (ethers/viem) формирует идентичный
typed-data — но подписывается всегда под конкретный адрес токена. **Будущие тесты должны
подписывать под адрес мока, а не USDC** (вне скоупа SC-4, см. §6/§7).

---

## 4. NFR (нефункциональные требования)

1. **Чистая компиляция без `viaIR`:** `rm -rf artifacts cache && npx hardhat compile`
   → exit 0. Solidity `0.8.28`, optimizer `enabled: true, runs: 1000`, `viaIR` выключен
   (конфиг не меняется).
2. **Ручной слот не меняется:** `STORAGE_LOCATION` (`0x52df…cb00`) и структура
   `ContractStorage` (`:98-117`) остаются без изменений; `SettelmentsControl` **не
   изменяется вообще**. Мок — обычный (не прокси) контракт, для него раскладка
   хранения штатная.
3. **Мок остаётся `ERC20`-наследником** (`@openzeppelin/contracts` v5.3.0), EIP-712 —
   non-upgradeable (`EIP712`, не `EIP712Upgradeable`).
4. **Stack too deep:** в `receiveWithAuthorization` локальные переменные в норме
   (9 параметров + `structHash`/`digest`/`signer`/`err`), риск низкий. Если компилятор
   укажет `Stack too deep`, правка локализуется выносом внутренних проверок в хелперы
   (не меняет ABI).

---

## 5. Trade-off (явно зафиксирован)

1. **Изменение ABI мока.** `ERC20Mock` получает новые функции
   (`receiveWithAuthorization`, `version`, `authorizationState`, событие
   `AuthorizationUsed`). Это меняет ABI мока; `scripts/deploy.ts`, `test/` и будущая
   верификация могут временно расходиться. **Допустимо:** продукт не в проде (PRD
   §«Ограничения»); синхронизация вынесена отдельно (I-03/H-02). `scripts/deploy.ts`,
   `test/`, `thegraph/` — **вне скоупа SC-4**.
2. **Полная (не упрощённая) реализация EIP-3009 в моке.** Воспроизводятся EIP-712
   домен `version="2"`, верификация split-подписи, nonce-tracking и строгие окна
   `validAfter`/`validBefore`. Это усложняет мок, но устраняет риск маскирования багов,
   специфичных для реального USDC (PRD §«Риски»). Упрощённый мок (без верификации)
   отвергнут.
3. **`ECDSA.tryRecover` вместо `SignatureChecker` (без ERC-1271).** Для мока `from` всегда
   EOA (тестовые/деплой-аккаунты), поддержка contract-wallet (ERC-1271) не нужна;
   `ECDSA.tryRecover` `pure`, детерминирован, меньше зависимостей, и мапит любую
   некорректную подпись в единую `InvalidAuthorizationSignature()`. Цена — мок не
   воспроизводит ERC-1271-ветку USDC. Осознанно; при необходимости заменяется одной
   строкой. Детализация — ADR.

---

## 6. Risks

1. **Сложность EIP-712 в моке** (domain separator, typehash, digest). Митигация:
   использование проверенных примитивов OZ v5 (`EIP712`, `ECDSA`,
   `MessageHashUtils.toTypedDataHash` через `_hashTypedDataV4`) вместо ручной сборки;
   typehash сверен с PRD/исследованием.
2. **Выбор `ECDSA.tryRecover` vs `SignatureChecker`.** Для EOA они эквивалентны; EIP-1271
   моку не нужен. Выбран `ECDSA.tryRecover` (см. ADR). Риск расхождения с USDC-семантикой
   для contract-wallet минимален (в моке такие `from` не встречаются).
3. **Синхронизация тестов/deploy-скрипта.** `scripts/deploy.ts` и `test/` не меняются и
   после SC-4 неконсистентны (I-03/H-02). Митигация: вне скоупа, отдельная задача;
   зафиксировано в PRD §«Открытые вопросы» и в этом плане.
4. **Порядок базовых конструкторов мока** (`ERC20(name, symbol)` и `EIP712(name, "2")`).
   Оба — обычные конструкторы с разными иммутаблами; порядок не влияет на
   компиляцию/поведение. Рекомендованный порядок — `ERC20(name, symbol) EIP712(name, "2")`
   (линейная база слева направо); формализован в §2.1.
5. **Порядок байт подписи.** `abi.encodePacked(r, s, v)` даёт `r ‖ s ‖ v` (65 байт).
   Ошибочный порядок (`v ‖ r ‖ s`) или неверная длина приведут к `InvalidAuthorizationSignature()`.
   Закреплено в §2.1.

---

## 7. Open questions

- **Нет блокирующих.** Неблокирующие (вне скоупа SC-4, отдельные задачи):
  - синхронизация `test/` и `scripts/deploy.ts` с новым ABI мока, включая формирование
    EIP-712 подписи **под адрес мока** (I-03/H-02);
  - подтверждение живого ABI USDC с ноды (split-сигнатура) — принято допущение PRD
    (`docs/prd/SC-4.prd.md`).

---

## 8. Критерий приёмки

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `Stack too deep`, при
  `viaIR` выключенном (optimizer `runs=1000`, Solidity `0.8.28`).
- `ERC20Mock` наследует `ERC20, EIP712` (non-upgradeable), конструктор
  `EIP712(name, "2")`; функция `receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`
  присутствует и соответствует §2.1 (порядок проверок, строгие окна, nonce per
  authorizer, `abi.encodePacked(r, s, v)`).
- `ERC20Mock` имеет `version() == "2"` и `authorizationState(address,bytes32)`.
- `SettelmentsControl.sol` **не изменён** (`STORAGE_LOCATION`, `ContractStorage`,
  функции/события/ошибки и `IERC20WithAuthorization` без изменений).
- Deploy-скрипт, тесты, сабграф — вне скоупа и не являются критерием приёмки.
