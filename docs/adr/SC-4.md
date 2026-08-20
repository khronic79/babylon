# ADR SC-4: Решения по моку EIP-3009

Status: ACCEPTED
Date: 2026-08-21

Связанный план: `docs/plan/SC-4.md`
Связанное исследование: `docs/research/SC-4.md` (§4, §5, §6)
Источник находки H-03: `docs/audit-reports/2026-08-20.md` (`:199-217`)

## Контекст

`topUpClientBalance` вызывает у токена `receiveWithAuthorization(...)` (EIP-3009), но
мок `ERC20Mock` — обычный `ERC20` без этой функции. Задача SC-4: дополнить мок до
EIP-3009. `SettelmentsControl.sol` не меняется.

Первоначально рассматривалась также «проверка поддержки EIP-3009 в `initialize`»
(бывший «Вариант C»), но по решению пользователя она **исключена** как ненадёжная
эвристика (EIP-3009 не определяет ERC165 `interfaceId`; проверка `version() == "2"`
даёт ложные срабатывания/пропуски). Единственная значимая развилка — способ
верификации split-подписи в моке.

---

## Развилка 1: верификация подписи — `ECDSA` vs `SignatureChecker`

### Решение

Использовать **`ECDSA.tryRecover(digest, abi.encodePacked(r, s, v))`** с маппингом
любого `RecoverError` и несовпадения `signer != from` в единую
`InvalidAuthorizationSignature()`.

```solidity
bytes32 digest = _hashTypedDataV4(structHash);
(address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
    digest,
    abi.encodePacked(r, s, v)
);
if (err != ECDSA.RecoverError.NoError || signer != from) {
    revert InvalidAuthorizationSignature();
}
```

### Рассмотренные альтернативы

| Вариант | Плюсы | Минусы | Итог |
| --- | --- | --- | --- |
| **A. `ECDSA.tryRecover` + маппинг `RecoverError`** | Не ревертит «сырыми» OZ-ошибками; любую некорректность (длина/high-s/неверный `v`/нулевой signer) и несовпадение `signer != from` сводит к единой `InvalidAuthorizationSignature()` — как USDC. | Чуть многословнее. | **Принят.** |
| **B. `ECDSA.recover`** | Короче. | Ревертит библиотечными `ECDSAInvalidSignature*` на битой подписи, «пряча» различимую ошибку мока. | Отклонён (после ревью). |
| **C. `SignatureChecker.isValidSignatureNow`** | Ближе к семантике USDC (поддержка ERC-1271); будущая замена локализована. | `internal view` (не `pure`), тянет `IERC1271` + `staticcall`-ветку; для мока EIP-1271 не нужен. | Отклонён (избыточно для мока). |

### Обоснование

- В моке `from` в `receiveWithAuthorization` — всегда EOA (тестовые аккаунты,
  деплой-аккаунты). Ветка ERC-1271 (`signer.code.length > 0`) никогда не сработает,
  поэтому `SignatureChecker` не даёт практической выгоды, а только добавляет
  `staticcall`-ветку и зависимость от `IERC1271`.
- `ECDSA.tryRecover` `pure` и детерминирован, а главное — возвращает `RecoverError`
  вместо revert, позволяя свести все некорректные подписи к одной различимой ошибке
  контракта (тот же паттерн уже применён в `SettelmentsControl._verifyAssignmentSignature`).
- «Близость к USDC» (которая использует `SignatureChecker` и единый revert
  «invalid signature») воспроизводится на уровне семантики (единая ошибка), без
  переноса ERC-1271 в мок.
- Если в будущем понадобится ERC-1271, замена локализована одной строкой:
  `SignatureChecker.isValidSignatureNow(from, digest, abi.encodePacked(r, s, v))`.

---

## Последствия

- **Положительные:** закрытие H-03 (мок поддерживает EIP-3009); тестовое окружение
  воспроизводит семантику USDC (домен v2, верификация подписи, nonce, строгие окна);
  минимальные зависимости; `SettelmentsControl` не затронут.
- **Отрицательные:** изменение ABI мока (синхронизация `scripts/deploy.ts`/`test/`
  вне скоупа); домен EIP-712 включает `verifyingContract = address(токена)`, поэтому
  подпись валидна только под конкретный адрес токена — тесты должны подписывать под
  адрес мока.

## Проверка

- `rm -rf artifacts cache && npx hardhat compile` → exit 0, при `viaIR` выключенном
  (optimizer `runs=1000`, Solidity `0.8.28`).
- `ERC20Mock` использует `ECDSA.tryRecover(digest, abi.encodePacked(r, s, v))` с
  маппингом `RecoverError` в `InvalidAuthorizationSignature()` (не `SignatureChecker`);
  `version()` возвращает `"2"`.
