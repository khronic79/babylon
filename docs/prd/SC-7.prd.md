# SC-7: Тестовый эпик — покрытие контрактов (I-03)

Status: PRD_READY
stage: IMPLEMENT

## Контекст / идея

После серии тикетов SC-1…SC-6 контракты `SettelmentsControl`,
`SettelmentsControlProxy` и `ERC20Mock` сильно изменились (переезд на ручной слот
EIP-7201, атомарная инициализация через прокси, `receiveWithAuthorization`,
роли `owner`/`admin`, вывод застрявших средств, поле `totalClientBalance`), а
существующие тесты `test/SettelmentsControl.ts` и `test/SettelmentsControlProxy.ts`
написаны под старый ABI и не компилируются. Это зафиксировано в аудите как находка
**I-03** и отложено отдельным эпиком.

**Источник истины для скоупа тестов — `test/TEST_PLAN.md`** (таблица 88 viem-кейсов +
Foundry F-1…F-5).

## Принятые решения

1. **`scripts/deploy.ts` — НЕ входит в SC-7** (выносится отдельным тикетом). SC-7 — только тесты.
2. **Оставляем оба стека:** `@nomicfoundation/hardhat-toolbox` (ethers v6) сохраняется
   для `verify:verify`/`gasReporter`/typegen; для тестов добавляется **viem**
   (`@nomicfoundation/hardhat-viem`) — единый стек с будущим `deploy.ts`.
3. **Структура тестов** (см. ниже): общие хелперы + файлы по областям + отдельная папка
   для Foundry.
4. **Убираем зависимость тестов от `PRIVATE_KEY`/`.env`** — старый
   `onlyInitializer`/`INITIALIZER_ADDRESS` удалён, инициализация идёт через прокси;
   тесты используют аккаунты Hardhat (`getWalletClients()`).
5. **`SettelmentsControl` тестируется только через прокси** — `_disableInitializers()`
   в конструкторе имплементации запрещает прямой `initialize`, поэтому фикстура
   разворачивает прокси с init-`data` (это же покрывает SC-3).
6. **Мок тестируется минимально** — только поверхность EIP-3009 (кейсы 81–88), без
   базового ERC20 (OpenZeppelin уже покрыт). Верность мока относительно USDC
   подтверждается fork-тестом F-4.

## Структура тестов (решено)

```
test/
  TEST_PLAN.md
  helpers/
    fixture.ts          # деплой ERC20Mock + имплементация + прокси(impl, data); атомарный initialize
    eip712.ts           # подпись NativeAddressAssignment (домен контракта, signTypedData)
    eip3009.ts          # подпись receiveWithAuthorization (домен мока version="2", r||s||v)
    matchers.ts         # expectRevertCustomError(selector), expectEvent(...) поверх viem
  SettelmentsControl/
    initialize.test.ts
    topup.test.ts
    payment.test.ts
    backfunds.test.ts
    native-address.test.ts
    roles-and-management.test.ts
    stuck-funds.test.ts
  SettelmentsControlProxy.test.ts
  ERC20Mock.test.ts
  foundry/
    SettelmentsControl.invariant.t.sol   # F-1
    SettelmentsControl.fuzz.t.sol        # F-2, F-3
    USDC.fork.t.sol                      # F-4
```

## Цели

1. **Настроить тестовый стек:** добавить dev-зависимость `@nomicfoundation/hardhat-viem`
   (toolbox/ethers остаётся); для Foundry — `foundry.toml` (`test = "test/foundry"`) и
   `forge-std`.
2. **Написать viem-тесты по таблице** (88 кейсов): общая фикстура (деплой + атомарная
   инициализация через прокси), хелперы подписи EIP-712/EIP-3009, хелперы revert/событий.
3. **Написать Foundry-тесты F-1…F-5:** invariant, fuzz комиссии и подписи, fork против
   USDC, gas-снапшоты.
4. Обеспечить прохождение `npx hardhat test` и `forge test` без `.env`.

Вне скоупа: код контрактов (`contracts/`), `scripts/deploy.ts`, сабграф `thegraph/`.

## User stories

- Как разработчик, я хочу, чтобы тесты компилировались против текущего ABI и проходили
  локально без `.env`, чтобы ловить регрессии при правках контрактов.
- Как разработчик, я хочу проверять revert/события через viem-хелперы (без chai-матчеров),
  чтобы тесты были единообразны со стеком `deploy.ts`.
- Как разработчик, я хочу подписывать EIP-712 (привязка адреса) и EIP-3009 (топ-ап) через
  общий хелпер, чтобы не дублировать криптографию.
- Как аудитор, я хочу property-тесты (invariant/fuzz/fork) в Foundry, чтобы проверять
  свойства при любых последовательностях и случайных входах, а не только фиксированные сценарии.

## Основные сценарии (группы кейсов из `test/TEST_PLAN.md`)

1. Фикстура: прокси с `data = encodeFunctionData(initialize, [6 аргументов])`; состояние
   инициализировано, `getImpl()` корректен (кейсы 1, 9).
2. Инициализация (1–9); топ-ап (10–17); расчёты (18–27); возврат (28–33); привязка
   адреса (34–44); роли/управление (45–60); геттеры (61); вывод застрявшего (62–72);
   прокси (73–80); мок (81–88).
3. Foundry F-1…F-5 — см. раздел «Foundry-дополнение» в `test/TEST_PLAN.md`.

## Успех / метрики

- `npx hardhat compile` → exit 0 (без `viaIR`, optimizer `runs=1000`, Solidity 0.8.28).
- `npx hardhat test` → все 88 viem-кейсов зелёные, **без `.env`**.
- `forge test` → F-1…F-5 зелёные; `forge test --gas-report` собирается (F-5).
- Код контрактов не изменён.

## Ограничения и допущения

- Не меняется код контрактов (`contracts/`) и `scripts/deploy.ts`.
- Источник истины перечня кейсов — `test/TEST_PLAN.md`; новые кейсы сверх плана не
  добавляются без отдельного решения.
- TS-тесты — viem; revert/события — через viem-хелперы, не chai-матчеры.
- Инициализация только через прокси (в реализации `_disableInitializers`).
- Мок воспроизводит семантику USDC (домен `version="2"`, `r||s||v`, nonce per authorizer,
  `to == msg.sender`); прямые тесты мока — только EIP-3009, без ERC20-основ.
- Fork-тест F-4 опирается на RPC Polygon mainnet; наличие обеих перегрузок
  `receiveWithAuthorization` у живого USDC пока подтверждено только по исходникам.

## Риски

- **Foundry не настроен** в репо: установка forge + `forge-std`, `foundry.toml` — инфраструктурная работа; gas-снапшоты чувствительны к версии компилятора.
- **Fork-тест F-4** зависит от внешнего RPC — может быть нестабилен/недоступен; нужен фолбэк (skip) или локальный RPC.
- **Переписывание с нуля** — риск расхождения таблицы с фактическим ABI (имена ошибок/порядок проверок); сверять с `test/TEST_PLAN.md` и контрактами (источник истины — контракт, план актуализируется).
- **Параллельность Hardhat+Foundry** — разные команды/кэши; гарантировать, что `forge test` не конфликтует с `hardhat` (отдельные `test/foundry`, `out/`).
- **viem-матчеры** отсутствуют как в chai — нужны свои хелперы revert/событий; риск ошибок в этих хелперах (сверять селекторы).

## Открытые вопросы

Неблокирующие (решаются на этапе планирования):
- Foundry-инфраструктура: установка (foundryup), версия `forge-std`, закрепление 0.8.28 в `foundry.toml`.
- RPC для F-4 и стратегия при недоступности сети.
- Порог качества: считать ли 88 viem + F-1…F-5 полным, или добавить `solidity-coverage`.
