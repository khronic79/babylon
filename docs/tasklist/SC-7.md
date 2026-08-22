# SC-7: Tasklist — тестовый эпик, покрытие контрактов (I-03)

Status: TASKLIST_READY

Связанные артефакты:
- PRD: `docs/prd/SC-7.prd.md` (Status: PRD_READY)
- План: `docs/plan/SC-7.md` (Status: PLAN_APPROVED)
- Исследование: `docs/research/SC-7.md` (Status: RESEARCH)
- ADR: `docs/adr/SC-7.md`
- Источник истины по кейсам: `test/TEST_PLAN.md` (88 viem-кейсов + Foundry F-1…F-5)
- Аудит (источник находки I-03): `docs/audit-reports/2026-08-20.md`

## Контекст

После SC-1…SC-6 контракты `SettelmentsControl`, `SettelmentsControlProxy` и `ERC20Mock`
изменились, а старые тесты `test/SettelmentsControl.ts` / `test/SettelmentsControlProxy.ts`
написаны под устаревший ABI и не компилируются (находка I-03). SC-7 — эпик полного
перепокрытия: настраиваем тестовый стек (viem для Hardhat + Foundry), пишем хелперы и
88 viem-кейсов по таблице `test/TEST_PLAN.md`, добавляем Foundry-тесты F-1…F-5, удаляем
устаревшие ethers-тесты.

**Скоуп — только `test/` + тестовый стек** (`package.json`, `hardhat.config.ts`,
`tsconfig.json`, `.gitignore`, `foundry.toml`, `lib/forge-std`). `contracts/`,
`scripts/deploy.ts` и `thegraph/` **неприкосновенны**.

Критерий успеха: `npx hardhat compile` → exit 0; `npx hardhat test` → 88 viem-кейсов
зелёные **без `.env`**; `forge test` → F-1…F-4 зелёные, `forge test --gas-report`/
`forge snapshot` собираются (F-5); код контрактов и `scripts/deploy.ts` не изменён.

---

## Задачи

### 1. Стек Hardhat + viem

- [ ] В `package.json` добавить dev-зависимость `@nomicfoundation/hardhat-viem@^2.0.0`
      (toolbox/ethers/chai-matchers остаются; `viem@^2.30.0` уже в dependencies — не дублировать).
- [ ] В `hardhat.config.ts` добавить `import "@nomicfoundation/hardhat-viem";` (минимальная
      правка; блок `gasReporter` не трогать).
- [ ] При необходимости (ошибки типизации `hre.viem`) добавить в `tsconfig.json`
      `"types": ["@nomicfoundation/hardhat-viem"]`; `resolveJsonModule`/`strict` сохранить.

**Acceptance-критерии:**
- `npx hardhat compile` → exit 0 после установки зависимости и импорта плагина; `hre.viem`
  доступен и типизирован (нет ошибок TS в `test/`).
- `git diff` по `hardhat.config.ts` содержит ровно добавление импорта `@nomicfoundation/hardhat-viem`
  (блоки `solidity`/`networks`/`gasReporter`/`etherscan` без изменений).

---

### 2. Стек Foundry (`foundry.toml`, `lib/forge-std`, `.gitignore`)

- [ ] Создать `foundry.toml`: `src="contracts"`, `test="test/foundry"`, `out="foundry-out"`,
      `cache_path="foundry-cache"`, `libs=["lib"]`, `solc_version="0.8.28"`, optimizer
      `runs=1000`, `evm_version="cancun"`, секция `[rpc_endpoints]` с `polygon`.
- [ ] Установить `forge-std` как submodule: `forge install foundry-rs/forge-std@<закреплённый тег>`.
- [ ] В `.gitignore` добавить `/foundry-out` и `/foundry-cache` (не `/lib` — это submodule).

**Acceptance-критерии:**
- `forge --version` доступен; `lib/forge-std` присутствует как git submodule (в `git status`
  виден как submodule-запись, не как обычные файлы).
- `foundry.toml` содержит все перечисленные ключи; `foundry-out/` и `foundry-cache/` не
  трекаются git'ом и не пересекаются с Hardhat `artifacts/`/`cache/`.

---

### 3. Хелпер `test/helpers/fixture.ts` (деплой + атомарная инициализация)

- [ ] Реализовать `deployFixture()` по плану §2.1: `getWalletClients()`/`getPublicClient()`;
      деплой `ERC20Mock` + mint запаса `user1`/`user2`/`native`; деплой имплементации
      `SettelmentsControl` без аргументов; `data = encodeFunctionData({abi: SettelmentsControlAbi,
      functionName: "initialize", args: [token, admin, owner, feePercentage, feeCollector, maxValidity]})`;
      деплой `SettelmentsControlProxy(implementation, data)`.
- [ ] Экспортировать `ROLES` (owner=0 … native=5), интерфейс `DeployFixture` (publicClient,
      clients, token, implementation, proxy, control, DEFAULT) и `useFixture = () => loadFixture(deployFixture)`.

**Acceptance-критерии:**
- Фикстура не требует `.env`/`PRIVATE_KEY`: аккаунты — `hre.viem.getWalletClients()`; owner =
  деплойер (индекс 0).
- Инициализация идёт **только через прокси** вторым аргументом конструктора (`data`); возвращаются
  две обёртки — `proxy` (ABI прокси, `getProxyAdmin`/`getImpl`/`setImpl`/`changeProxyAdmin`) и
  `control` (полный ABI `SettelmentsControl`, `address = прокси`).
- `useFixture` — единственная точка входа через `loadFixture`; после фикстуры `getImpl()` ==
  адрес имплементации, `getProxyAdmin()` == owner, состояние инициализировано (покрывает кейс 9).

---

### 4. Хелперы подписи `test/helpers/eip712.ts` и `test/helpers/eip3009.ts`

- [ ] `eip712.ts`: тип `NativeAddressAssignment`, `ASSIGNMENT_TYPES`, `assignmentDomain`
      (name="SettelmentsControl", version="1.0", verifyingContract=**прокси**),
      `signNativeAddressAssignment` (signTypedData → `hexToSignature` → `{v,r,s,signature}`).
- [ ] `eip3009.ts`: тип `ReceiveWithAuthorization`, `RECEIVE_WITH_AUTH_TYPES`, `mockDomain`
      (name = имя токена, version="2"), `signReceiveWithAuthorization` (r||s||v через `hexToSignature`).

**Acceptance-критерии:**
- Домен EIP-712 строится от адреса **прокси** (`verifyingContract`), не реализации; подпись
  возвращает раздельные `v`/`r`/`s` (совместимо с `ECDSA.tryRecover(hash, v, r, s)`).
- Домен мока — `version="2"`, `name` берётся из конструктора токена; в `ReceiveWithAuthorization`
  поле `to` ожидает адрес прокси (payee), `nonce` — `bytes32`; возвращаются `r`/`s`/`v` для
  раздельных аргументов `topUpClientBalance`.

---

### 5. Хелпер `test/helpers/matchers.ts` (revert/события без chai)

- [ ] Экспортировать константу `ERRORS` со всеми селекторами custom errors из плана §2.4
      (реализация/мок/прокси), сверенными с research §3.
- [ ] Реализовать `expectRevertCustomError(promise, selector)` (сверка первых 4 байт
      `cause.data` со `selector`) и `expectEvent(publicClient, txHash, abi, eventName)` через
      `getTransactionReceipt` + `parseEventLogs`.

**Acceptance-критерии:**
- `expectRevertCustomError` бросает ошибку, если транзакция прошла (не ревертнулась) или
  селектор не совпал; сверка регистронезависима по `slice(0, 10)`; `decodeErrorResult`/chai
  не используются.
- `expectEvent` возвращает `logs[0].args` (camelCase, включая структуру `ctx` `SettelmentContext`)
  или бросает, если событие не найдено; работает с произвольным промисом (и `simulateContract`,
  и `writeContract`).

---

### 6. `test/SettelmentsControl/initialize.test.ts` (кейсы 1–9)

- [ ] Покрыть: валидный `initialize` (поля + события `ChangeAdmin`, `FeeConfigSet`), границы
      `feePercentage > 100` → `FeeTooHigh`, `maxValidity == 0` → `InvalidMaxValidity`,
      `address(0)` для token/admin/owner/feeCollector → `ZeroAddress`, повторный `initialize` →
      `InvalidInitialization`, атомарная инициализация через прокси.

**Acceptance-критерии:**
- Все кейсы 1–9 из `test/TEST_PLAN.md` реализованы и зелёные; revert проверяется через
  `expectRevertCustomError` с селекторами `ERRORS.FeeTooHigh`/`InvalidMaxValidity`/`ZeroAddress`/`InvalidInitialization`.
- Повторный `initialize` тестируется через прокси (реализация с `_disableInitializers`
  прямо запрещает) → `InvalidInitialization` (селектор `0xf92ee8a9`).

---

### 7. `test/SettelmentsControl/topup.test.ts` (кейсы 10–17)

- [ ] Покрыть: ретрансляцию EIP-3009 authorization от `user1` (баланс `+= value`, тотал
      `+= value`, `lastInboundAddress`, событие `TopUpClientBalance`), несколько топ-апов,
      вызов не от `admin` → `OnlyAdmin`, неверная подпись / просрочка / ещё не валидна /
      повторный nonce → ошибки мока, сверку `balanceOf(контракт) == totalClientBalance`.

**Acceptance-критерии:**
- Кейсы 10–17 зелёные; подпись строится через `mockDomain`/`signReceiveWithAuthorization` с
  `to = прокси` и `nonce = randomBytes32()`; вызов `topUpClientBalance` от `admin`.
- Ошибки мока проверяются по селекторам `ERRORS` (PayeeMustBeCaller / AuthorizationNotYetValid /
  AuthorizationExpired / AuthorizationAlreadyUsed / InvalidAuthorizationSignature); после
  топ-апа `balanceOf(прокси) == getTotalClientBalance()`.

---

### 8. `test/SettelmentsControl/payment.test.ts` (кейсы 18–27)

- [ ] Покрыть: успешный `paymentClientToNative` (`amountToNative` → native, `feeAmount` →
      feeCollector, списание баланса/тотала, событие `PaymentClientToNative(ctx)`), границы
      `amount == 0` → `ZeroAmount`, не от `admin` → `OnlyAdmin`, отсутствие native-адреса,
      недостаток баланса клиента/контракта, расчёт комиссии и округление вниз.

**Acceptance-критерии:**
- Кейсы 18–27 зелёные; математика комиссии проверена: `feeAmount = amount * feePercentage / 100`,
  `amountToNative = amount − feeAmount`; случаи `feePercentage == 0` и `== 100` дают
  `feeAmount == 0` / `amountToNative == 0`; округление вниз задокументировано.
- Ошибки проверяются по селекторам (`ZeroAmount`, `OnlyAdmin`, `NativeAddressIsOutForSessionSettelment`,
  `InsufficientClientBalanceForSessionSettelment`, `InsufficientContractBalanceForSessionSettelment`).

---

### 9. `test/SettelmentsControl/backfunds.test.ts` (кейсы 28–33)

- [ ] Покрыть: успешный `backFundsToClient` (возврат на `lastInboundAddress`, списание
      баланса/тотала, событие `BackFundsToClient`), `amount == 0` → `ZeroAmount`, не от
      `admin` → `OnlyAdmin`, недостаток баланса клиента/контракта, частичный возврат.

**Acceptance-критерии:**
- Кейсы 28–33 зелёные; получатель возврата — `lastInboundAddress` (частичный возврат сохраняет
  остаток на том же адресе).
- Ошибки проверяются по селекторам (`ZeroAmount`, `OnlyAdmin`,
  `InsufficientClientBalanceForBackFunds`, `InsufficientContractBalanceForBackFunds`).

---

### 10. `test/SettelmentsControl/native-address.test.ts` (кейсы 34–44)

- [ ] Покрыть: валидную подпись (`signer == nativeAddress`, запись адреса, nonce помечен,
      событие `NativeAddressSet`), не от `admin`, пустой `nativeId`/`nonce`, `address(0)`,
      повторный nonce, просроченный deadline, `deadline − now > maxValidity`, чужой ключ,
      high-s подпись, nonce не сжигается при невалидной подписи.

**Acceptance-критерии:**
- Кейсы 34–44 зелёные; домен — `assignmentDomain(прокси, chainId)`, подпись — от аккаунта
  `native`; вызов `setNativeAddressWithSignature` от `admin`.
- Ошибки по селекторам (`OnlyAdmin`, `EmptyNativeId`, `EmptyNonce`, `InvalidNativeAddress`,
  `NonceAlreadyUsed`, `SignatureExpired`, `DeadlineTooFar`, `InvalidSignature`); кейс 44
  подтверждает, что после невалидной подписи `isNonceUsed(nonce) == false` и повтор с валидной
  подписью проходит.

---

### 11. `test/SettelmentsControl/roles-and-management.test.ts` (кейсы 45–61)

- [ ] Покрыть роли: owner не может вызывать admin-функции (topUp/payment/backFunds/
      setNativeAddressWithSignature → `OnlyAdmin`); admin не может вызывать owner-функции
      (changeAdmin/setMaxValidity/setFeeConfig/withdrawStuckTokens/withdrawStuckNative → `OnlyOwner`).
- [ ] Покрыть управление и геттеры: валидные `changeAdmin`/`setMaxValidity`/`setFeeConfig` с
      событиями; границы `changeAdmin(0)` → `InvalidAdmin`, `setMaxValidity(0)` →
      `InvalidMaxValidity`, `setFeeConfig` с `>100` → `FeeTooHigh` и `feeCollector == 0` →
      `InvalidFeeCollector`; все геттеры возвращают актуальные значения.

**Acceptance-критерии:**
- Кейсы 45–61 зелёные; разделение ролей проверено обеими сторонами (`OnlyAdmin` от owner,
  `OnlyOwner` от admin) через `expectRevertCustomError`.
- Все перечисленные в кейсе 61 геттеры (`getAdmin`/`getMaxValidity`/`getFeeConfig`/
  `getTotalClientBalance`/`getBalance`/`getNativeAddress`/`isNativeAddressSet`/`isNonceUsed`)
  проверены на актуальных значениях.

---

### 12. `test/SettelmentsControl/stuck-funds.test.ts` (кейсы 62–72)

- [ ] Покрыть `withdrawStuckTokens`: вывод ровно избытка `balanceOf − totalClientBalance`,
      `amount > избыток` / отсутствие избытка → `InsufficientStuckFunds`, прочий токен выводится
      целиком, `to == 0` / `token == 0` → `ZeroAddress`, `amount == 0` → `ZeroAmount`.
- [ ] Покрыть `withdrawStuckNative`: успех через `selfdestruct`-зачисление POL, `amount > balance`
      → `InsufficientStuckFunds`, `to == 0` → `ZeroAddress`, `amount == 0` → `ZeroAmount`.

**Acceptance-критерии:**
- Кейсы 62–72 зелёные; зачисление POL на прокси выполнено **без** обычного `sendTransaction`
  (прокси `receive()` ревертит) — через вспомогательный `selfdestruct`-контракт или
  `hardhat_setBalance` на адрес прокси.
- Ошибки по селекторам (`InsufficientStuckFunds`, `ZeroAddress`, `ZeroAmount`); для прочего
  токена (не USDC) выводится весь `balanceOf(прокси)`.

---

### 13. `test/SettelmentsControlProxy.test.ts` (кейсы 73–80)

- [ ] Переписать под новый ABI: `getProxyAdmin()` == деплойер, валидный `changeProxyAdmin`
      и не от админа → `OnlyAdmin`, `getImpl()`, `setImpl` от админа и не от админа → `OnlyAdmin`,
      отправка ETH на прокси → `NotAcceptEtherDirectly`, сквозной сценарий топ-ап → расчёт → возврат.

**Acceptance-критерии:**
- Кейсы 73–80 зелёные; используются обёртки `proxy` (функции прокси) и `control` (через `delegatecall`).
- Ошибки по селекторам (`OnlyAdmin`, `NotAcceptEtherDirectly`); сквозной сценарий (кейс 80)
  меняет балансы клиента и native так же, как отдельные вызовы.

---

### 14. `test/ERC20Mock.test.ts` (кейсы 81–88)

- [ ] Покрыть поверхность EIP-3009: `version() == "2"`, `authorizationState` до/после,
      успешный `receiveWithAuthorization` (перевод, nonce помечен, событие `AuthorizationUsed`),
      `to != msg.sender` → `PayeeMustBeCaller`, `validAfter` в будущем → `AuthorizationNotYetValid`,
      `validBefore` в прошлом → `AuthorizationExpired`, повторный nonce → `AuthorizationAlreadyUsed`,
      неверная подпись → `InvalidAuthorizationSignature`.

**Acceptance-критерии:**
- Кейсы 81–88 зелёные; тестируется только EIP-3009 поверхность (базовый ERC20 не дублируется —
  OpenZeppelin уже покрыт).
- Ошибки мока проверяются по селекторам (`PayeeMustBeCaller`, `AuthorizationNotYetValid`,
  `AuthorizationExpired`, `AuthorizationAlreadyUsed`, `InvalidAuthorizationSignature`).

---

### 15. Foundry: `Base.t.sol` + invariant F-1

- [ ] Создать `test/foundry/Base.t.sol` (setUp: деплой ERC20Mock → имплементация →
      `SettelmentsControlProxy(impl, abi.encodeCall(initialize, ...))`).
- [ ] Создать `test/foundry/SettelmentsControl.invariant.t.sol`: handler крутит
      `topUp`/`payment`/`backFunds` через `vm.prank(admin)`, инвариант
      `invariant_totalMatchesSum` (`Σ getBalance(users[i]).balance == getTotalClientBalance()`).

**Acceptance-критерии:**
- F-1 зелёный: `forge test --match-path test/foundry/SettelmentsControl.invariant.t.sol` проходит;
  инвариант держится на случайных последовательностях вызовов через handler.
- Дебаг через тот же ERC1967-прокси (не harness), атомарная инициализация обходит
  `_disableInitializers`; компилируется с `solc 0.8.28`.

---

### 16. Foundry: fuzz F-2 и F-3

- [ ] `test/foundry/SettelmentsControl.fuzz.t.sol` — F-2: `testFuzz_feeMath(amount, feePercentage)`
      (bound 0..100, проверка `feeAmount = amount * feePercentage / 100`, `amountToNative`,
      границы 0/100, без underflow).
- [ ] F-3: `testFuzz_badSignature(v, r, s, deadline)` — edge-подписи (high-s, `v ∉ {27,28}`,
      чужой signer, deadline на границе) → `InvalidSignature`/`SignatureExpired`/`DeadlineTooFar`,
      nonce не сжигается.

**Acceptance-критерии:**
- F-2: на тысячах случайных входов сумма `feeAmount + amountToNative == amount`, переводы/списания
  == amount, нет underflow; крайние значения 0 и 100 дают корректные результаты.
- F-3: любые edge-подписи не проходят (`vm.expectRevert(selector)`), `isNonceUsed(nonce) == false`
  после каждого негативного случая; используется `vm.sign`/`vm.prank`.

---

### 17. Foundry: fork-тест F-4 (USDC, Polygon)

- [ ] Создать `test/foundry/USDC.fork.t.sol`: `vm.createSelectFork(polygonRpc)` с фиксированным
      `blockNumber`; `IERC3009(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359).version() == "2"`;
      `receiveWithAuthorization` со split-сигнатурой `(v,r,s)` (через `vm.prank`/`vm.sign`).
- [ ] Добавить skip-гвард: RPC из `vm.envOr("POLYGON_RPC_URL", "https://polygon-rpc.com")`,
      при `FORK_TESTS=0` — пропуск.

**Acceptance-критерии:**
- F-4 зелёный при доступном RPC: `version() == "2"` и подписанный `receiveWithAuthorization`
  проходит — подтверждает допущение про USDC (split-сигнатура валидируется так же, как в моке).
- При `FORK_TESTS=0` тест пропускается (не падает); блок и RPC зафиксированы в коде/конфиге
  для воспроизводимости.

---

### 18. Foundry: gas-снапшоты F-5

- [ ] Настроить/убедиться, что `forge test --gas-report` и `forge snapshot` собираются для
      ключевых функций (topUp/payment/backFunds/withdrawStuck*); зафиксировать `.gas-snapshot`.

**Acceptance-критерии:**
- `forge test --gas-report` завершается exit 0 и выводит таблицу газа по ключевым функциям;
  `forge snapshot` создаёт/обновляет `.gas-snapshot`.
- Значения воспроизводимы (закреплены `solc_version="0.8.28"`, `optimizer_runs=1000`,
  `evm_version="cancun"`, forge-std тегом).

---

### 19. Удалить устаревшие ethers-тесты

- [ ] Удалить `test/SettelmentsControl.ts` и `test/SettelmentsControlProxy.ts`.

**Acceptance-критерии:**
- Файлы отсутствуют; `git status` показывает их удаление.
- `npx hardhat test` больше не пытается компилировать старый ABI (не осталось ethers/chai-тестов
  под старый ABI).

---

### 20. Финальная проверка эпика

- [ ] Прогнать весь набор: `npx hardhat compile`, `npx hardhat test` (без `.env`),
      `forge test`, `forge test --gas-report`.
- [ ] Проверить `git diff`: нет изменений в `contracts/` и `scripts/deploy.ts`.

**Acceptance-критерии:**
- `npx hardhat compile` → exit 0 (Solidity 0.8.28, optimizer runs=1000, без `viaIR`).
- `npx hardhat test` → **88 viem-кейсов зелёные, без `.env`** (без `PRIVATE_KEY`).
- `forge test` → F-1…F-4 зелёные; `forge test --gas-report` собирается (F-5).
- `git diff` по `contracts/` и `scripts/deploy.ts` пустой; `foundry-out/`/`foundry-cache/` не в git.
- В `test/` присутствуют: `helpers/{fixture,eip712,eip3009,matchers}.ts`, 7 файлов в
  `test/SettelmentsControl/`, `SettelmentsControlProxy.test.ts`, `ERC20Mock.test.ts`,
  `foundry/{Base,SettelmentsControl.invariant,SettelmentsControl.fuzz,USDC.fork}.t.sol`.

---

## Примечание по независимости и порядку

Задачи упорядочены так, что каждая последующая опирается на результат предыдущих:
1→2 (стек), 3→4→5 (хелперы, зависят от стека и друг от друга не зависят), 6–14 (viem-тесты
по областям — все зависят от хелперов 3–5, но независимы между собой), 15–18 (Foundry,
зависит от 2), 19 (независимо), 20 (сквозная, после всех).

Ключевые инварианты тикета (PRD §«Риски», план §5–6):
- Меняются только `test/` + тестовый стек; `contracts/`, `scripts/deploy.ts`, `thegraph/` — вне скоупа.
- Тесты не зависят от `.env`/`PRIVATE_KEY`: аккаунты `getWalletClients()`, инициализация через прокси.
- `verifyingContract`/`to` в подписях — адрес **прокси** (не реализации).
- Revert/события — через viem-хелперы (`expectRevertCustomError`/`expectEvent`), не chai-матчеры.
- Hardhat и Foundry изолированы: `foundry-out/`/`foundry-cache/` ≠ `artifacts/`/`cache/`;
  solc 0.8.28 и `evm_version="cancun"` закреплены в обоих.
- Порог качества — 88 viem + F-1…F-5; `solidity-coverage` вне скоупа (отдельный будущий тикет).
