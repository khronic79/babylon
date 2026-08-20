# ADR SC-2: Верификация подписи назначения адреса носителя — `ECDSA.tryRecover` и судьба мёртвой структуры

Status: ACCEPTED
Date: 2026-08-20

## Контекст

Находки аудита `docs/audit-reports/2026-08-20.md`:

- **H-01 (High)** — в `setNativeAddressWithSignature` подпись восстанавливается через
  `ecrecover`, но проверяется только `signer != address(0)`, а не принадлежность
  подписи владельцу привязываемого `nativeAddress`. Финализировано: проверять
  `signer == nativeAddress` (осознанное отклонение от рекомендации аудита сверять с
  `owner`, см. PRD §«Контекст»).
- **L-02** — маллеабельность `ecrecover` (нет проверки каноничности `s`).
- **I-01** — `owner`/`onlyOwner` — мёртвый код.
- **M-01** — `changeAdmin` без проверки нулевого адреса.

Дополнительно вводится `deadline` и потолок `maxValidity` (не из аудита).

В ходе планирования возникли две архитектурные развилки.

## Развилка 1: `ECDSA.recover` vs `ECDSA.tryRecover`

### Решение

Использовать **`ECDSA.tryRecover(bytes32 hash, uint8 v, bytes32 r, bytes32 s)`** из
`@openzeppelin/contracts/utils/cryptography/ECDSA.sol` (v5.3.0), а не `ECDSA.recover`.

```solidity
(address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, v, r, s);
if (err != ECDSA.RecoverError.NoError || signer != nativeAddress) {
    revert InvalidSignature();
}
```

### Рассмотренные альтернативы

| Вариант | Плюсы | Минусы | Итог |
| --- | --- | --- | --- |
| **A. `ECDSA.recover` + try/catch** | Лаконично. | Solidity не имеет try/catch для internal-вызовов библиотек; `recover` ревертит **библиотечными** ошибками `ECDSAInvalidSignature()`/`ECDSAInvalidSignatureS(bytes32)`/`ECDSAInvalidSignatureLength(uint256)`, «пряча» различимую `InvalidSignature()` контракта и ломая off-chain декодирование revert-причин. | Отклонён. |
| **B. `ECDSA.tryRecover` + проверка `RecoverError`** | Не ревертит; даёт маппинг любой некорректности (`InvalidSignatureS` = high-`s`, `InvalidSignature` = нулевой signer) в единую `InvalidSignature()`; сохраняет различимую ошибку контракта. | Чуть более многословный код (деструктуризация возврата). | **Принят.** |

### Обоснование

- `tryRecover` возвращает `(address, RecoverError, bytes32)` вместо revert, что
  позволяет явно свести `RecoverError.InvalidSignatureS` (маллеабельность, L-02),
  `RecoverError.InvalidSignature` (некорректный `v`/подпись) и любой будущий не-NoError
  к единой ошибке `InvalidSignature()` контракта (PRD §«Риски»).
- `tryRecover` включает проверку каноничности `s` (`s <= n/2`, `ECDSA.sol:143-145`),
  закрывая L-02.
- `ECDSA` — stateless-библиотека; `ECDSAUpgradeable` отсутствует (подтверждено
  ресерчем §4). Импорт из `@openzeppelin/contracts` — штатная практика, контракт уже
  смешивает пакеты (`IERC20`/`SafeERC20` из `contracts`, `Initializable`/`EIP712Upgradeable`
  из `contracts-upgradeable`).

## Развилка 2: обновить или удалить мёртвую структуру `NativeAddressAssignment`

### Решение

**Удалить** структуру `NativeAddressAssignment` — она не используется в коде и не
участвует в EIP-712 хэше; единственный источник истины о форме подписываемого
payload — строковый литерал `ASSIGNMENT_TYPEHASH`.

### Рассмотренные альтернативы

| Вариант | Плюсы | Минусы | Итог |
| --- | --- | --- | --- |
| **A. Удалить мёртвую структуру** | Меньше мёртвого кода; нет риска расхождения с `ASSIGNMENT_TYPEHASH`. | Описание формы payload остаётся только в строковом литерале typehash. | **Принят.** |
| **B. Обновить структуру (добавить `deadline`)** | «Живое» описание формы payload. | Структура формально не используется и **не синхронизирована автоматически** с typehash — легко разъезжается при будущих изменениях, создавая ложное ощущение, что она где-то используется. | Отклонён. |

### Обоснование

- Хэш `ASSIGNMENT_TYPEHASH` вычисляется вручную (`keccak256("NativeAddressAssignment(...)")`)
  и не зависит от структуры. Struct не участвует ни в хранилище, ни в memory, ни в
  параметрах функций — это чистый мёртвый код.
- Держать дублирующее описание payload (struct + строковый typehash) вручную
  синхронизированными — источник расхождений, а не пользы. Источник истины — typehash.
- Решение пересмотрено после ревью (первоначально ADR предлагал «обновить»): мёртвый
  код без автоматической синхронизации не добавляет ценности.

## Последствия

- Положительные: закрытие H-01/L-02/I-01/M-01; сохранение различимой `InvalidSignature()`;
  устранение мёртвого кода (структура удалена, источник истины — typehash).
- Отрицательные: изменение ABI (`setNativeAddressWithSignature` +7-й параметр `deadline`,
  `initialize` +6-й параметр `_maxValidity`, новые события/ошибки); несовместимость со
  старыми подписанными payload (продукт не в проде — допустимо, см. план §5).

## Проверка

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `Stack too deep`,
  при `viaIR` выключенном (optimizer `runs=1000`, Solidity `0.8.28`).
- Невалидная (не-владелец/неканоничная) и просроченная подпись ревертятся `InvalidSignature`,
  `SignatureExpired`/`DeadlineTooFar` **до** `$.usedNonces[nonceHash] = true` (nonce не сжигается).
