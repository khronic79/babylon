# SC-8: operationId: ключ идемпотентности (bytes32 + indexed)

Status: DRAFT
stage: IDEA

## Контекст / идея

Суть. В SettelmentsControl вводится сквозной бизнес-ключ operationId типа bytes32, который бэкенд генерирует для каждой логической операции (client_operations.operation_key) и передаёт в контракт при доставке. Контракт ведёт mapping(bytes32 => bool) processedOperations в ContractStorage и отклоняет повторную обработку одного ключа, давая идемпотентность при retry/replacement (старый/новый nonce, повторный broadcast). Бэкенд хранит ключ как text, а в bytes32 переводит на своей стороне через keccak256(toBytes(operationKey)).

Куда внедрять. Ключ добавляется первым аргументом во все три функции: topUpClientBalance, paymentClientToNative и backFundsToClient. В topUpClientBalance он не путается с существующим bytes32 nonce — тот является nonce EIP-3009-авторизации USDC и выбирается клиентом, тогда как operationId — ключ идемпотентности самого бэкенда. Mapping хранит ключ напрямую, без дополнительного keccak256 внутри контракта: экономия газа на отсутствии строки в calldata и на отказе от лишнего хеширования.

Механика. Добавляется error OperationAlreadyProcessed(bytes32 operationId) и хелпер _markProcessed(bytes32): в начале функции — if (processedOperations[operationId]) revert OperationAlreadyProcessed(operationId), отметка processedOperations[operationId] = true ставится после успешного изменения баланса и внешних вызовов, непосредственно перед emit. Ключ сгорает только при реальном исполнении: если receiveWithAuthorization/safeTransfer ревертит, retry возможен. Reentrancy-риск низкий, т.к. все функции onlyAdmin.

Пояснение «revert → retry возможен»: в Solidity `revert` откатывает **все** изменения состояния транзакции, включая запись в mapping. Порядок внутри функции:

1. проверка `if (processedOperations[operationId]) revert OperationAlreadyProcessed(operationId)`;
2. изменение баланса и внешние вызовы (`receiveWithAuthorization`/`safeTransfer`) — здесь может произойти revert;
3. `processedOperations[operationId] = true` — выполняется только если шаг 2 прошёл успешно;
4. `emit`.

Если на шаге 2 внешний вызов ревертит (истёк срок EIP-3009 авторизации, неверный/уже использованный nonce, недостаточно средств), транзакция откатывается целиком и отметка на шаге 3 не сохраняется. Ключ остаётся «необработанным», поэтому бэкенд может повторить вызов с тем же `operationId` (возможно, с новым nonce) — проверка на шаге 1 снова пройдёт. Ключ сгорает только при фактическом успехе операции. Размещение отметки в конце — это паттерн checks-effects-interactions: «сжимаем ключ только после того, как исполнение реально состоялось».

События. operationId добавляется как indexed в TopUpClientBalance, PaymentClientToNative (отдельным параметром рядом со структурой SettelmentContext) и BackFundsToClient. bytes32 indexed занимает один topic, поэтому граф/индексер сможет фильтровать по нему без декодирования — ключ предназначен для внутренней связки «контракт ↔ бэкенд», а остальные атрибуты уходят в события для отчётов на клиент. Следствия: меняется ABI контракта → ре-деплой, в thegraph — обновление схемы, yarn codegen и синхронизация адреса/startBlock.

## Контекст репозитория (что выяснено при исследовании)

- Три функции, которые меняются, сейчас имеют сигнатуры:
  - `topUpClientBalance(string userId, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external onlyAdmin` — уже содержит `bytes32 nonce` (nonce EIP-3009 авторизации USDC), от которого `operationId` следует отличать;
  - `paymentClientToNative(string clientId, string nativeId, uint256 amount, string sessionId, uint256 timestamp, uint256 minutesQty) external onlyAdmin`;
  - `backFundsToClient(string userId, uint256 amount) external onlyAdmin`.
- `ContractStorage` (`contracts/SettelmentsControl.sol:113-124`) — ручной слот EIP-7201 (`STORAGE_LOCATION`); новые персистентные поля добавляются только внутрь структуры, `STORAGE_LOCATION` не перегенерируется. `mapping(bytes32 => bool) processedOperations` добавляется в структуру.
- События сейчас:
  - `TopUpClientBalance(string userId, uint256 amount, uint256 currentClientBalance, address sender)`;
  - `PaymentClientToNative(SettelmentContext ctx)` — параметр-структура (11 полей);
  - `BackFundsToClient(string userId, address reciever, uint256 amount)`.
  Поле-структуру нельзя пометить `indexed`, поэтому `operationId` добавляется как отдельный `indexed` параметр **рядом** со структурой: `PaymentClientToNative(bytes32 indexed operationId, SettelmentContext ctx)`.
- Механика маркировки: проверка `if (processedOperations[operationId]) revert OperationAlreadyProcessed(operationId)` — в начале функции (до внешних вызовов), отметка `processedOperations[operationId] = true` — после успешного изменения баланса и внешних вызовов, перед `emit` (хелпер `_markProcessed(bytes32)`).
- Сабграф `thegraph/` индексирует `polygon-amoy`, контракт `0x51de3ac5b5cdf4496c5b793a98b1a103e6675386`, `startBlock: 22033296` (продублировано в `thegraph/subgraph.yaml` и `thegraph/networks.json`). После ре-деплоя адрес/startBlock нужно синхронизировать в обоих файлах, затем `yarn codegen` (перегенерирует `generated/`).

## Цели

- Ввести в `SettelmentsControl` сквозной ключ идемпотентности `bytes32 operationId` первым аргументом трёх функций: `topUpClientBalance`, `paymentClientToNative`, `backFundsToClient`.
- Добавить в `ContractStorage` поле `mapping(bytes32 => bool) processedOperations` (внутрь структуры, без новых state-переменных верхнего уровня и без изменения `STORAGE_LOCATION`).
- Добавить ошибки `OperationAlreadyProcessed(bytes32 operationId)` и `EmptyOperationId()` (валидация `operationId == bytes32(0)`), а также хелпер `_markProcessed(bytes32)`; обеспечить, что повторная обработка ключа отклоняется, а ключ «сгорает» только при реальном исполнении (revert внешнего вызова не блокирует retry).
- Дополнить три существующие ошибки `paymentClientToNative` параметром `operationId` первым аргументом (`InsufficientClientBalanceForSessionSettelment`, `NativeAddressIsOutForSessionSettelment`, `InsufficientContractBalanceForSessionSettelment`) — для единого «сквозного ключа» на всей поверхности «контракт ↔ бэкенд» и диагностики падающих платежей. `ctx` остаётся memory-указателем, поэтому стек не переполняется (C-01 не возвращается).
- Добавить `operationId` как `indexed` параметр в события `TopUpClientBalance`, `PaymentClientToNative` (отдельным параметром рядом со `SettelmentContext`) и `BackFundsToClient` — для фильтрации по одному topic без декодирования.
- Зафиксировать, что в `topUpClientBalance` `operationId` ≠ существующий `bytes32 nonce` (nonce EIP-3009, выбирается клиентом).
- Определить следствия для off-chain обвязки: ABI меняется → ре-деплой. Синхронизация сабграфа (`thegraph/`: схема, `yarn codegen`, address/startBlock) и скрипт деплоя (`scripts/deploy.ts`) — **отдельные тикеты**, в SC-8 не входят.
- Обновить существующие тесты, введённые в SC-7, и добавить новые кейсы идемпотентности: адаптировать все вызовы трёх функций под новый первый аргумент `operationId` (TS-тесты `test/SettelmentsControl/*.test.ts`, хелперы `test/helpers/actions.ts`/`fixture.ts`, Foundry-тесты `test/foundry/*.t.sol`/`Base.t.sol`), и покрыть механики «повторный ключ → `OperationAlreadyProcessed`» и «revert внешнего вызова → retry с тем же ключом проходит».

## User stories

- Как бэкенд, я хочу передавать в контракт сквозной ключ `operationId` для каждой логической операции (`client_operations.operation_key`), чтобы при retry/replacement (старый/новый nonce, повторный broadcast) контракт не обрабатывал одну операцию дважды.
- Как бэкенд, я хочу хранить ключ как `text`, а в `bytes32` переводить на своей стороне через `keccak256(toBytes(operationKey))`, чтобы контракт не платил газ за строку в calldata и не делал лишний хеш.
- Как оператор/аналитик, я хочу фильтровать события по `operationId` (indexed, один topic) без декодирования, чтобы связывать события контракта с внутренними операциями бэкенда для сверки и отчётов.
- Как разработчик, я хочу, чтобы ключ сгорал только при реальном исполнении (если `receiveWithAuthorization`/`safeTransfer` ревертит — retry возможен), чтобы идемпотентность не блокировала легитимные повторы.
- Как оператор, я хочу, чтобы отчётные атрибуты операций по-прежнему уходили в события (для отчётов на клиент), а `operationId` оставался служебной связкой «контракт ↔ бэкенд».

## Основные сценарии

1. **Первый вызов** `topUpClientBalance(operationId, userId, from, ...)`: `processedOperations[operationId]` пуст → проходит; после успешного `receiveWithAuthorization` и увеличения баланса ключ помечается `true` перед `emit TopUpClientBalance(operationId, ...)`.
2. **Нулевой ключ:** `operationId == bytes32(0)` → `revert EmptyOperationId()` в начале функции (до проверки `processedOperations` и внешних вызовов).
3. **Повторный вызов с тем же ключом:** `processedOperations[operationId] == true` → `revert OperationAlreadyProcessed(operationId)` в начале функции, до внешних вызовов.
4. **Retry после revert:** `receiveWithAuthorization`/`safeTransfer` ревертит → ключ не помечается → повторный вызов с тем же `operationId` возможен.
5. **То же для `paymentClientToNative` и `backFundsToClient`:** проверки (нулевой ключ, уже обработан) в начале, отметка после изменения баланса и внешних переводов, перед `emit`.
6. **Отличие от `nonce`:** в `topUpClientBalance` `operationId` и `bytes32 nonce` — разные аргументы; `nonce` — nonce EIP-3009-авторизации USDC (выбирается клиентом), `operationId` — ключ идемпотентности бэкенда.
7. **Событие `PaymentClientToNative`:** `operationId` добавляется отдельным `indexed` параметром рядом со структурой (`PaymentClientToNative(bytes32 indexed operationId, SettelmentContext ctx)`), т.к. структура не может быть `indexed` целиком.
8. **Ошибки `paymentClientToNative`:** три revert-сайта (`NativeAddressIsOutForSessionSettelment`, `InsufficientClientBalanceForSessionSettelment`, `InsufficientContractBalanceForSessionSettelment`) ревертятся с `operationId` первым аргументом рядом с `ctx` — revert-данные несут ключ операции для диагностики.
9. **Тесты (SC-7):** все существующие тесты, вызывающие `topUpClientBalance`/`paymentClientToNative`/`backFundsToClient`, адаптируются под новый первый аргумент `operationId` (TS-тесты и хелперы `actions.ts`/`fixture.ts`, Foundry `Base.t.sol` и `*.t.sol`). Добавляются новые кейсы: нулевой ключ → `revert EmptyOperationId`; повторный вызов с тем же ключом → `revert OperationAlreadyProcessed`; revert внешнего вызова (`receiveWithAuthorization`/`safeTransfer`) → ключ не сжигается, retry с тем же ключом проходит; ключи разных операций не конфликтуют между собой.

## Успех / метрики

- **Критерий успеха — чистая компиляция:** `rm -rf artifacts cache && npx hardhat compile` → exit 0, без `viaIR` (optimizer `runs=1000`, Solidity `0.8.28`).
- `processedOperations: mapping(bytes32 => bool)` добавлен внутрь `ContractStorage`; новых state-переменных верхнего уровня нет, `STORAGE_LOCATION` не меняется.
- Три функции принимают `operationId` первым аргументом.
- `operationId == bytes32(0)` отклоняется `EmptyOperationId()`.
- Повторная обработка одного ключа отклоняется `OperationAlreadyProcessed(operationId)`; ключ не сжигается при revert внешнего вызова.
- `operationId` — `indexed` во всех трёх событиях (в `PaymentClientToNative` — отдельным параметром рядом со `SettelmentContext`).
- Три ошибки `paymentClientToNative` принимают `operationId` первым параметром; matchers (`test/helpers/matchers.ts`) содержат обновлённые селекторы (`0x7eebe94d`, `0x03ebc37f`, `0x899b9fa7`).
- Тесты зелёные: `npx hardhat test` (TS/viem) и Foundry (`forge test`, если выбран) проходят после адаптации вызовов под новый аргумент; новые кейсы идемпотентности покрыты (повторный ключ → revert; revert внешнего вызова → retry проходит).

## Ограничения и допущения

- Продукт ещё не в проде — изменение ABI (новые аргументы, ошибка, события) допустимо.
- Компилятор Solidity `0.8.28`, optimizer `runs=1000`, `viaIR` отключён.
- Ручной слот EIP-7201 (`ContractStorage`/`STORAGE_LOCATION`): новые персистентные поля добавляются только внутрь структуры, слот не перегенерируется.
- Ключ хранится в mapping напрямую (уже `bytes32`), без дополнительного `keccak256` внутри контракта; перевод `text → bytes32` (`keccak256(toBytes(operationKey))`) выполняет бэкенд.
- Все три функции `onlyAdmin` — reentrancy-риск низкий; тем не менее порядок «проверка в начале / отметка в конце» зафиксирован как инвариант.

## Риски

- **Забыть добавить `operationId` в одну из трёх функций/событий** — идемпотентность станет частичной, связка «контракт ↔ бэкенд» разъедется. Митигация: единый шаблон проверки/отметки и единый порядок аргументов.
- **Порядок отметки критичен:** если отметить `processedOperations[operationId] = true` до внешних вызовов, revert «сожжёт» ключ и заблокирует легитимный retry.
- **TOCTOU/reentrancy:** проверка в начале и отметка в конце оставляют окно между ними; при reentrant-вызове (только `onlyAdmin`) теоретически возможен двойной проход. Практический риск низкий, т.к. все функции `onlyAdmin` (доверенный бэкенд).
- **Изменение ABI ломает off-chain потребителей** (тесты, `scripts/deploy.ts`, сабграф) — осознанно; синхронизация сабграфа и скрипта деплоя вынесена в отдельные тикеты.
- **Сабграф уже рассинхронизирован с контрактом:** ABI в `thegraph/abis/SettelmentsControl.json` и `subgraph.yaml` содержат события `BalanceUpdated`/`WithdrawFundsToNative` и плоскую (не структуру `SettelmentContext`) сигнатуру `PaymentClientToNative`, которых нет в текущем контракте. Синхронизация сабграфа может оказаться шире, чем только добавление `operationId`.
- **Рост хранилища:** `processedOperations` — неограниченно растущий `bool`-mapping (фиксированная цена на ключ `bytes32`, без массива для итерации); накопление мусора возможно, но не создаёт проблем с доступом к конкретному ключу.

## Открытые вопросы

1. **Скоуп SC-8 — решено:** синхронизация сабграфа (`thegraph/schema.graphql`, `subgraph.yaml`, `abis/`, `src/settelments-control.ts`, `yarn codegen`, `networks.json`) и скрипт деплоя (`scripts/deploy.ts`) выносятся в **отдельные тикеты**. В SC-8 остаются: контракт и тесты (TS/viem + Foundry). События должны содержать `operationId` (indexed), чтобы сабграф мог его индексировать позже — контрактная часть готовится уже сейчас.
2. **Валидация нулевого ключа — решено:** проверку оставить. Добавляется ошибка `EmptyOperationId()`, валидация `operationId == bytes32(0)` выполняется в начале каждой из трёх функций (до проверки `processedOperations` и внешних вызовов).
3. **Точный порядок в `paymentClientToNative`:** в текущем коде внешние переводы `safeTransfer` идут **до** обновления баланса. Подтвердить финальный порядок: внешние вызовы → обновление баланса → `_markProcessed` → `emit` (идея фиксирует «после изменения баланса и внешних вызовов, перед emit»).
4. **Прокидывание в сабграф-истории** *(переносится в отдельный тикет сабграфа)*: добавлять ли `operationId` в сущности `ClientBalanceHistory`/`NativeBalanceHistory` (для сверки бэкенда), или только в три основные event-сущности (`TopUpClientBalance`, `PaymentClientToNative`, `BackFundsToClient`)?
5. **Синхронизация устаревшего ABI сабграфа** *(переносится в отдельный тикет сабграфа)*: ограничиться добавлением `operationId` в текущий (уже устаревший) ABI, или привести ABI сабграфа полностью в соответствие с текущим контрактом (удалить `BalanceUpdated`/`WithdrawFundsToNative`, перевести `PaymentClientToNative` на структуру `SettelmentContext`)?
