# SC-4: Совместимость топ-апа с EIP-3009 (H-03)

Status: PRD_READY
stage: IMPLEMENT

## Контекст / идея

Согласно аудиту `docs/audit-reports/2026-08-20.md`, находка **H-03 (High)**:
функция `topUpClientBalance` контракта `contracts/SettelmentsControl.sol`
вызывает у токена `$.token.receiveWithAuthorization(...)` (EIP-3009, как у USDC).
Однако мок-токен `contracts/mock/ERC20Mock.sol`, который используется в
`scripts/deploy.ts` и `test/`, — это обычный `ERC20` **без**
`receiveWithAuthorization`. Вызов селектора, которого нет в контракте токена,
всегда ревертится, поэтому в текущей конфигурации деплоя/тестов **пополнение
баланса клиента не работает вообще** — основной сценарий системы сломан.

Продакшн-токен — USDC, реализующий EIP-3009, поэтому интерфейс
`IERC20WithAuthorization` (уже объявлен в `SettelmentsControl.sol`) корректен для
прода; проблема именно в моке.

**Финализированное решение (обсуждено с пользователем):** дополнить
`contracts/mock/ERC20Mock.sol` до поддержки EIP-3009, чтобы `topUpClientBalance`
работал с моком. Нужна функция
`receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` с семантикой USDC.

**Исключено из скоупа (по решению пользователя):** проверка поддержки EIP-3009 в
`initialize` (бывший «Вариант C»). Она признана ненадёжной эвристикой (EIP-3009 не
определяет ERC165 id; проверка `version() == "2"` даёт ложные срабатывания/пропуски)
и удалена.

**Скоуп SC-4** — один файл:
1. `contracts/mock/ERC20Mock.sol` — реализация EIP-3009.

`SettelmentsControl.sol` **не меняется**. Вне скоупа также: `scripts/deploy.ts`,
`test/`, сабграф `thegraph/` (синхронизация — известная находка I-03/H-02,
отдельная задача).

**Исследование USDC (продакшн-токен):** native USDC Circle на Polygon —
`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (FiatTokenProxy → FiatTokenV2_2).
По исходникам `centrehq/centre-tokens` (`FiatTokenV2.sol`, `FiatTokenV2_2.sol`,
`EIP3009.sol`) `receiveWithAuthorization` существует в **двух перегрузках**:
split `(uint8 v, bytes32 r, bytes32 s)` (унаследована из FiatTokenV2) и
`bytes memory signature` (добавлена в FiatTokenV2_2 для EIP-1271). Split-версия
совместима с интерфейсом `IERC20WithAuthorization` контракта. Семантика USDC:
EIP-712 домен `version = "2"`, `RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8`, проверка
`to == msg.sender`, валидность `now > validAfter` / `now < validBefore`, nonce по
`authorizer → nonce → bool`, подпись `abi.encodePacked(r, s, v)`.

**Принятое допущение (зафиксировано с пользователем):** считаем, что USDC
поддерживает нужный интерфейс (split-сигнатуру). Подтверждение по живому ABI с
ноды отложено (публичные RPC были недоступны) — см. примечание в fix-plan.

## Цели

- Дополнить `ERC20Mock` функцией `receiveWithAuthorization(...)` с сигнатурой
  EIP-3009 и семантикой USDC, чтобы `topUpClientBalance` работал с моком.
- Закрыть находку H-03 в части «несовместимость мока», **не трогая** контракт
  `SettelmentsControl`, deploy-скрипт, тесты и сабграф.

## User stories

- Как разработчик/деплойер, я хочу, чтобы мок-токен, используемый в тестах и
  deploy-скрипте, поддерживал `receiveWithAuthorization`, чтобы сценарий
  пополнения баланса клиента (`topUpClientBalance`) был исполним в тестовом
  окружении, а не ревертился на отсутствующем селекторе.
- Как разработчик, я хочу, чтобы мок воспроизводил реальную семантику USDC
  (проверка подписи, nonce, `validAfter`/`validBefore`, `to == msg.sender`), чтобы
  тестовое окружение не маскировало проблемы, специфичные для реального токена.

## Основные сценарии

1. **Топ-ап с моком (успешный путь):** после доработки `ERC20Mock` вызов
   `topUpClientBalance(userId, from, value, validAfter, validBefore, nonce, v, r, s)`
   через прокси с `_token = ERC20Mock` выполняет `receiveWithAuthorization` и
   увеличивает `clientBalance` без реверта.
2. **Невалидная authorization (мок):** `receiveWithAuthorization` ревертится при
   нарушении каждого инварианта USDC (`to != msg.sender`, `validAfter`/`validBefore`,
   повторный nonce, неверная подпись).
3. **Продакшн-путь (USDC):** поведение `topUpClientBalance` с настоящим USDC не
   меняется — интерфейс `IERC20WithAuthorization` и вызов `receiveWithAuthorization`
   остаются без изменений (контракт не трогается).

## Успех / метрики

- **Критерий успеха — успешная чистая компиляция:**
  `rm -rf artifacts cache && npx hardhat compile` возвращает код 0 (без `viaIR`).
- В `ERC20Mock` объявлена `receiveWithAuthorization(...)` с сигнатурой EIP-3009
  (`from, to, value, validAfter, validBefore, nonce, v, r, s`), `version()` и
  `authorizationState(...)`.
- `SettelmentsControl.sol` не изменён.
- Deploy-скрипт, тесты, сабграф — вне скоупа и не являются критерием приёмки.

## Ограничения и допущения

- Область задачи — только `contracts/mock/ERC20Mock.sol`.
- `SettelmentsControl.sol`, `scripts/deploy.ts`, `test/`, сабграф `thegraph/`
  **не меняются** (синхронизация тестов/deploy-скрипта — известная находка
  I-03/H-02, вынесена отдельно).
- Продукт ещё не в проде — изменение ABI мока допустимо.
- Компилятор Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` остаётся
  **отключённым**.
- Мок — `ERC20`-наследник (`@openzeppelin/contracts` v5.3.0). EIP-3009 реализуется
  **полноценно** (EIP-712 домен `version = "2"`, верификация подписи split
  `(v, r, s)`, nonce-трекинг, проверки `to == msg.sender` и
  `validAfter`/`validBefore`) — чтобы тестовое окружение воспроизводило семантику
  реального USDC. Прочие функции FiatToken (blacklist/pausable/permit) в мок
  **не** переносятся — только то, что нужно для `receiveWithAuthorization`.

## Риски

- Сложность EIP-712 в моке (domain separator, typehash, digest, split-подпись
  `r‖s‖v`) — митигируется примитивами OpenZeppelin v5 (`EIP712`, `ECDSA`).
- Нюанс домена: EIP-712 включает `verifyingContract = address(токена)`, поэтому
  подпись, валидная для USDC, не валидна для мока напрямую — тесты должны
  подписывать под адрес мока.
- Изменение `ERC20Mock` меняет его ABI; off-chain потребители (deploy-скрипт,
  верификация) вне скоупа и могут временно расходиться.

## Открытые вопросы

- **Синхронизация тестов/deploy-скрипта:** приведение `test/` и `scripts/deploy.ts`
  в соответствие с новым ABI мока — вне скоупа SC-4 (известная находка I-03/H-02),
  требует отдельного тикета (неблокирующее для PRD, но необходимо до релиза).
