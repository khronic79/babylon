# AGENTS.md

Репозиторий смарт-контрактов: проект Hardhat (Solidity 0.8.28) плюс сабграф The Graph. Комментарии и сообщения коммитов — на русском.

## Два независимых пакета

- Корень: **npm** + Hardhat (контракты, тесты, скрипты деплоя). Зависимости ставятся в корневой `node_modules/`.
- `thegraph/`: **yarn** + сабграф The Graph (свой `yarn.lock`). Команды `yarn` выполняются изнутри `thegraph/`, а не через `npm`.

## Команды

Корень (Hardhat):
- `npx hardhat compile`
- `npx hardhat test` — запуск одного файла: `npx hardhat test test/SettelmentsControl.ts`
- `npm run format:check` / `format:sol` / `format:tests` / `format:scripts` (Prettier)
- `npx solhint 'contracts/**/*.sol'` (npm-скрипта нет; solhint настроен через `.solhint.json`)
- Деплой: `npx hardhat run scripts/deploy.ts --network polygonAmoy`

Сабграф (`cd thegraph`):
- `yarn codegen` — ОБЯЗАТЕЛЬНО перед `build`/`test`; перегенерирует игнорируемый git'ом `generated/`
- `yarn build`
- `yarn test` (unit-тесты matchstick-as)

## `.env` обязателен (корень)

`hardhat.config.ts` и `scripts/deploy.ts` читают `PRIVATE_KEY`, `NETWORK_URL`, `AMOY_POLYGON_APIKEY` через `dotenv`. Файла `.env.example` нет.

**Тесты зависят от `PRIVATE_KEY`.** Функция `initialize` контракта защищена модификатором `onlyInitializer`, который проверяет `msg.sender == INITIALIZER_ADDRESS` (захардкоженная константа `0x5c8630069c6663e7Fa3eAAAB562e2fF4419e12f7`). В фикстурах тестов создаётся `ethers.Wallet(PRIVATE_KEY)`, от имени которого вызывается `initialize`. Без валидного `.env` тесты падают с ошибкой невалидного адреса/hex.

## Архитектура контрактов

- Обновляемый прокси: `SettelmentsControl` (реализация, `Initializable`) за `SettelmentsControlProxy` (ERC1967Proxy). Порядок деплоя важен: токен -> реализация -> прокси -> `initialize` через прокси.
- `SettelmentsControl` использует **ручной слот хранилища** (assembly, `STORAGE_LOCATION` в `_getContractStorage()`), а не стандартную раскладку Solidity. **Всё персистентное состояние должно лежать внутри структуры `ContractStorage`.** Добавление переменной состояния верхнего уровня конфликтует с хранилищем прокси/структуры. Константа слота была сгенерирована `scripts/calc.js` (одноразовый скрипт; импортирует `web3`, которого нет в зависимостях).
- `initialize` также защищён модификатором `initializer` из OpenZeppelin — вызвать его можно только один раз.
- Известный мёртвый код / TODO: неиспользуемая переменная состояния `owner`; наследование `Multicall` помечено на удаление; несколько русских TODO-комментариев.

## Особенности скрипта деплоя

`scripts/deploy.ts` использует `viem` напрямую (не Hardhat Ignition). `ignition/modules/Lock.ts` и примеры Lock в README — оставшийся boilerplate из шаблона Hardhat, их можно игнорировать. Верификация контрактов внутри скрипта опирается на конфиг `etherscan` в `hardhat.config.ts` (Polygon Amoy, chainId 80002). В скрипте `INITIALIZER_ADDRESS` захардкожен и равен адресу деплойера.

## Сабграф

- Индексирует `polygon-amoy`, контракт `SettelmentsControl` по адресу `0x51de3ac5b5cdf4496c5b793a98b1a103e6675386`, `startBlock: 22033296`. Адрес/startBlock продублированы в `thegraph/subgraph.yaml` и `thegraph/networks.json` — держите их синхронными при передеплое.
- `generated/` и `build/` игнорируются git'ом; запускайте `yarn codegen` после любого изменения ABI/схемы.
- События дополнительно сворачиваются в сущности `ClientBalanceHistory` / `NativeBalanceHistory` с идентификаторами `Counter` `'client'` и `'native'`.

## Workflow (тикетный флоу OpenCode)

- Тикетный процесс через `.opencode/commands/*` (`idea` → `researcher` → `plan` → `tasks` →
  `implement` → `review` → `doc` → `ready`), каждый делегирует субагенту из `.opencode/agents/`.
- Артефакты в `docs/` (`prd/`, `research/`, `plan/`, `tasklist/`, `adr/`); активный тикет хранится в
  `docs/.active_ticket`; шаблон PRD — `docs/prd.template.md`.
- Имплементер обязан получить явное подтверждение пользователя перед правками кода и добавлять/обновлять
  тесты для каждой задачи.
- Коммиты делаются через команду `ready` (добавляет id тикета в сообщение).
