# SC-7: План — тестовый эпик, покрытие контрактов (I-03)

Status: PLAN_APPROVED

Связанные артефакты:
- PRD: `docs/prd/SC-7.prd.md` (Status: PRD_READY)
- Исследование: `docs/research/SC-7.md` (Status: RESEARCH)
- Источник истины по кейсам: `test/TEST_PLAN.md` (88 viem-кейсов + F-1…F-5)
- Аудит (источник находки I-03): `docs/audit-reports/2026-08-20.md`
- ADR: `docs/adr/SC-7.md` — две значимые развилки тестового стека (единый источник ABI;
  `loadFixture` vs собственная снапшот-обёртка). Остальные открытые вопросы PRD/research
  закрыты решениями этого плана (§5, §7).

## 1. Components

Скоуп — **только `test/` + тестовый стек**. `contracts/`, `scripts/deploy.ts`, `thegraph/`
не меняются.

| Компонент | Файл | Изменение | Роль в задаче |
| --- | --- | --- | --- |
| Dev-зависимость | `package.json` | Да | `@nomicfoundation/hardhat-viem@^2.0.0` (viem `2.30.0` уже в `dependencies`, плагин подхватит без дублирования). toolbox/ethers/chai-matchers **остаются**. |
| Конфиг Hardhat | `hardhat.config.ts` | Да (миним.) | Добавить `import "@nomicfoundation/hardhat-viem";`. Блок `gasReporter` не трогаем (см. §5.2/§6.3). |
| TS-типы | `tsconfig.json` | Да (миним.) | При необходимости добавить `"types": ["@nomicfoundation/hardhat-viem"]` (или `"hardhat-viem"`) для типизации `hre.viem`. |
| Foundry конфиг | `foundry.toml` | **Новый** | `src="contracts"`, `test="test/foundry"`, `out="foundry-out"`, `cache_path="foundry-cache"`, `libs=["lib"]`, `solc_version="0.8.28"`, optimizer `runs=1000`, `evm_version="cancun"`, `[rpc_endpoints] polygon`. |
| forge-std | `lib/forge-std` | **Новый** | `forge install foundry-rs/forge-std@<закреплённый тег>` (submodule). |
| `.gitignore` | `.gitignore` | Да | Добавить `/foundry-out`, `/foundry-cache` (не `/lib` — это submodule). |
| Хелперы | `test/helpers/{fixture,eip712,eip3009,matchers}.ts` | **Новые** | Общая фикстура, подпись EIP-712/EIP-3009, revert/события поверх viem. |
| Тесты реализации | `test/SettelmentsControl/{initialize,topup,payment,backfunds,native-address,roles-and-management,stuck-funds}.test.ts` | **Новые** (7) | Кейсы 1–72. |
| Тест прокси | `test/SettelmentsControlProxy.test.ts` | Переписан | Кейсы 73–80. |
| Тест мока | `test/ERC20Mock.test.ts` | **Новый** | Кейсы 81–88. |
| Foundry-тесты | `test/foundry/{SettelmentsControl.invariant.t.sol,SettelmentsControl.fuzz.t.sol,USDC.fork.t.sol}` + общая база `test/foundry/Base.t.sol` | **Новые** | F-1…F-4 (F-5 — это команды `forge test --gas-report`/`forge snapshot`, не файл). |
| Старые ethers-тесты | `test/SettelmentsControl.ts`, `test/SettelmentsControlProxy.ts` | **Удалить** | Написаны под старый ABI, не компилируются (research §2) — выбрасываются целиком. |
| Контракты / deploy / сабграф | `contracts/`, `scripts/deploy.ts`, `thegraph/` | **Нет** | Неприкосновенны. |

**Итог по скоупу:** меняются только `package.json`, `hardhat.config.ts`, `tsconfig.json`,
`.gitignore`; добавляются `foundry.toml`, `lib/forge-std`, 4 хелпера, 10 TS-тестов,
4 Solidity-теста; удаляются 2 устаревших ethers-теста. Код контрактов и `scripts/deploy.ts`
не затрагиваются.

---

## 2. API contract тестовых хелперов (`test/helpers/`)

### 2.1 `fixture.ts` — деплой + атомарная инициализация

```ts
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

// Роли: индекс клиента из hre.viem.getWalletClients() (детерминированы в сети Hardhat)
export const ROLES = {
  owner: 0,         // деплойер (инициализатор через прокси)
  admin: 1,
  feeCollector: 2,
  user1: 3,
  user2: 4,
  native: 5,
} as const;

export interface DeployFixture {
  publicClient: PublicClient;
  clients: { owner: WalletClient; admin: WalletClient; feeCollector: WalletClient;
             user1: WalletClient; user2: WalletClient; native: WalletClient };
  token:     { address: Address; abi: typeof ERC20MockAbi };                 // ERC20Mock
  implementation: Address;                                                    // SettelmentsControl impl
  proxy:     { address: Address; abi: typeof SettelmentsControlProxyAbi };    // прокси
  control:   { address: Address; abi: typeof SettelmentsControlAbi };         // ABI реализации, адрес = прокси
  DEFAULT:   { feePercentage: bigint; maxValidity: bigint };
}

export async function deployFixture(): Promise<DeployFixture> {
  // 1) clients = hre.viem.getWalletClients(); publicClient = hre.viem.getPublicClient()
  // 2) token = hre.viem.deployContract("ERC20Mock",
  //        ["BabylonTest", "BT", owner.address, 1_000_000n * 10n**18n])
  //    + mint(user1/user2/native, запас) через token.mint(...) (для топ-апов/расчётов)
  // 3) implementation = hre.viem.deployContract("SettelmentsControl", [])   // без аргументов
  // 4) data = encodeFunctionData({ abi: SettelmentsControlAbi, functionName: "initialize",
  //        args: [token, admin, owner, feePercentage, feeCollector, maxValidity] })
  // 5) proxy = hre.viem.deployContract("SettelmentsControlProxy", [implementation, data])
  //    // атомарно: конструктор ERC1967Proxy(impl, data) вызывает initialize через delegatecall,
  //    // затем ERC1967Utils.changeAdmin(msg.sender) → getProxyAdmin() == deployer (кейс 73)
  // 6) return {...}
}

// Единственная точка входа для тестов: loadFixture поверх evm_snapshot/evm_revert
export const useFixture = () => loadFixture(deployFixture);
```

Ключевые решения:
- **Без `.env`/`PRIVATE_KEY`.** Аккаунты — `hre.viem.getWalletClients()` (детерминированные
  аккаунты сети Hardhat). Роли закреплены индексами 0–5 (owner=деплойер).
- **Инициализация только через прокси** (в реализации `_disableInitializers()` в конструкторе,
  `SettelmentsControl.sol:126-128`): `data = encodeFunctionData({...initialize, [6 аргументов]})`
  передаётся вторым аргументом конструктора прокси `(implementation, data)`. Это же покрывает
  кейс 9 (атомарная инициализация) и SC-3.
- Возвращает **две ABI-обёртки**: `proxy` (для `getProxyAdmin`/`getImpl`/`setImpl`/`changeProxyAdmin`)
  и `control` (полный ABI `SettelmentsControl`, но `address = прокси` — все функции реализации
  идут через `delegatecall`).

### 2.2 `eip712.ts` — подпись `NativeAddressAssignment`

```ts
import { signTypedData, privateKeyToAccount } from "viem/accounts";
import { hexToSignature, type TypedDataDomain } from "viem";

export interface NativeAddressAssignment {
  nativeId: string; nativeAddress: Address; nonce: string; deadline: bigint;
}

export const ASSIGNMENT_TYPES = {
  NativeAddressAssignment: [
    { name: "nativeId",      type: "string" },
    { name: "nativeAddress", type: "address" },
    { name: "nonce",         type: "string" },
    { name: "deadline",      type: "uint256" },
  ],
} as const;

// Домен: name="SettelmentsControl", version="1.0" (__EIP712_init, SettelmentsControl.sol:165)
export function assignmentDomain(verifyingContract: Address, chainId: number): TypedDataDomain {
  return { name: "SettelmentsControl", version: "1.0", chainId, verifyingContract };
}

export async function signNativeAddressAssignment(
  signer: { privateKey: `0x${string}` } | WalletClient,
  domain: TypedDataDomain,
  message: NativeAddressAssignment,
): Promise<{ v: number; r: `0x${string}`; s: `0x${string}`; signature: `0x${string}` }> {
  const signature = await (typeof (signer as any).signTypedData === "function"
      ? (signer as WalletClient).signTypedData
      : () => signTypedData({ privateKey: (signer as any).privateKey, ... }))({ ... });
  return { ...hexToSignature(signature), signature };
}
```

Критично (research §4.1): `verifyingContract` = **адрес прокси** (не реализации) — контракт
проверяет `_hashTypedDataV4`, где `address(this)` при `delegatecall` равен прокси. Подпись
передаётся в `setNativeAddressWithSignature` **раздельными** `v/r/s` (контракт использует
`ECDSA.tryRecover(hash, v, r, s)`). `hexToSignature` даёт `{ r, s, v }` из 65-байтной подписи.

### 2.3 `eip3009.ts` — подпись `ReceiveWithAuthorization` (мок, домен `version="2"`)

```ts
export interface ReceiveWithAuthorization {
  from: Address; to: Address; value: bigint;
  validAfter: bigint; validBefore: bigint; nonce: `0x${string}`;
}

export const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;

// Домен мока: name = имя токена (параметр конструктора), version = "2" (ERC20Mock.sol:30)
export function mockDomain(tokenName: string, verifyingContract: Address, chainId: number): TypedDataDomain {
  return { name: tokenName, version: "2", chainId, verifyingContract };
}

export async function signReceiveWithAuthorization(signer, domain, message) {
  // signTypedData → hexToSignature → { r, s, v, signature }
}
```

Критично (research §4.2): `to` в подписи = **адрес прокси** (payee; иначе `PayeeMustBeCaller`,
т.к. мок требует `to == msg.sender`, а `msg.sender` внутри мока = прокси). Nonce — per authorizer.
`r/s/v` из `hexToSignature` передаются в `topUpClientBalance(userId, from, value, validAfter,
validBefore, nonce, v, r, s)` как раздельные аргументы; мок сам склеивает их через
`abi.encodePacked(r, s, v)`.

### 2.4 `matchers.ts` — revert/события без chai

```ts
import { parseEventLogs, type Abi, type PublicClient } from "viem";

// Селекторы custom errors (сверены с research §3; константы, НЕ выводятся из ABI на рантайме)
export const ERRORS = {
  OnlyAdmin: "0x47556579",                 // совпадает у прокси и реализации (семантически)
  OnlyOwner: "0x5fc483c5",
  InvalidInitialization: "0xf92ee8a9",     // OZ (кейс 8)
  InvalidSignature: "0x8baa579f",
  NonceAlreadyUsed: "0x1fb09b80",
  EmptyNativeId: "0xd46b306d", EmptyNonce: "0xfa662e90",
  InvalidNativeAddress: "0xa86b1e53",
  SignatureExpired: "0x0819bdcd", DeadlineTooFar: "0x48f0fae6",
  FeeTooHigh: "0x7b931420", InvalidFeeCollector: "0xbb0bac99",
  InvalidMaxValidity: "0x9a93f8d6", InvalidAdmin: "0xb5eba9f0",
  ZeroAddress: "0xd92e233d", ZeroAmount: "0x1f2a2005",
  InsufficientStuckFunds: "0x68509843", WithdrawalFailed: "0x27fcd9d1",
  InsufficientClientBalanceForSessionSettelment: "0xae895493",
  NativeAddressIsOutForSessionSettelment: "0xc4df6dea",
  InsufficientContractBalanceForSessionSettelment: "0x7f5fdf44",
  InsufficientClientBalanceForBackFunds: "0x6f194512",
  InsufficientContractBalanceForBackFunds: "0x21483961",
  // мок (EIP-3009)
  PayeeMustBeCaller: "0x182dc57a", AuthorizationNotYetValid: "0xdf8e4372",
  AuthorizationExpired: "0x0f05f5bf", AuthorizationAlreadyUsed: "0x9508f1f2",
  InvalidAuthorizationSignature: "0x391e7a64",
  // прокси
  NotAcceptEtherDirectly: "0x1398a250",
} as const;

export async function expectRevertCustomError(
  promise: Promise<unknown>,
  selector: `0x${string}`,
): Promise<void> {
  try { await promise; }
  catch (e: any) {
    const data: string | undefined = e?.cause?.data;   // revert data
    if (data && data.slice(0, 10).toLowerCase() === selector.toLowerCase()) return;
    throw new Error(`ожидался revert ${selector}, получено ${data}`);
  }
  throw new Error("ожидался revert, но транзакция прошла");
}

export async function expectEvent(
  publicClient: PublicClient,
  txHash: `0x${string}`,
  abi: Abi,
  eventName: string,
): Promise<Record<string, any>> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const logs = parseEventLogs({ abi, logs: receipt.logs, eventName });
  if (logs.length === 0) throw new Error(`событие ${eventName} не найдено`);
  return logs[0].args;   // args.ctx — структура SettelmentContext в camelCase (research §5.2)
}
```

Решения:
- **Ручная сверка первых 4 байт revert-data** (надёжно, не зависит от ABI-обёртки; корректно
  различает одинаковые по имени ошибки `OnlyAdmin` прокси/реализации). `decodeErrorResult`
  не используется. Ошибки с аргументами (`FeeTooHigh(uint256)`, 3× `...Settelment(ctx)`)
  сверяются по селектору — аргументы игнорируются.
- Хелпер принимает **произвольный промис** — работает и с `simulateContract` (проверка revert
  без майна, быстрее), и с `writeContract` (когда параллельно проверяется побочный эффект).
- События — через `parseEventLogs` по receipt (замена `.to.emit(...).withArgs(...)`).

---

## 3. Data flows

### 3.1 Типовой revert-кейс (роли/границы)

```
тест → expectRevertCustomError(
           adminAsUser.writeContract({ address: proxy, abi, functionName: 'topUpClientBalance', args }),
           ERRORS.OnlyAdmin )
        ▼
writeContract бросает ContractFunctionExecutionError
        ▼
cause.data = 0x47556579... → сверка slice(0,10) → return
```

### 3.2 Топ-ап с EIP-3009 (кейсы 10–17)

```
fixture.useFixture() → token (ERC20Mock), proxy, control, clients
  1) mint(user1, value)                       # user1 имеет баланс
  2) nonce = randomBytes32()
  3) domain = mockDomain("BabylonTest", proxy, chainId)
  4) {v,r,s} = signReceiveWithAuthorization(user1, domain,
        { from: user1, to: proxy, value, validAfter: now-1, validBefore: now+3600, nonce })
  5) tx = control.writeContract('topUpClientBalance',
        [userId, user1, value, validAfter, validBefore, nonce, v, r, s])   # от admin
  6) assert: getBalance(userId).balance += value; getTotalClientBalance += value;
     lastInboundAddress == user1; expectEvent(..., 'TopUpClientBalance', ...)
```

### 3.3 Привязка адреса с EIP-712 (кейсы 34–44)

```
  1) domain = assignmentDomain(proxy, chainId)      # verifyingContract = ПРОКСИ
  2) {v,r,s} = signNativeAddressAssignment(native, domain,
        { nativeId, nativeAddress: native.address, nonce, deadline })
  3) tx = control.writeContract('setNativeAddressWithSignature',
        [nativeId, nativeAddress, nonce, deadline, v, r, s])   # от admin
  4) assert: getNativeAddress(nativeId) == native; isNonceUsed(nonce);
     expectEvent(..., 'NativeAddressSet', ...)
  # негативные: deadline в прошлом → SignatureExpired; deadline-now > maxValidity → DeadlineTooFar;
  #   чужой ключ/high-s → InvalidSignature (nonce НЕ сжигается — кейс 44)
```

### 3.4 Foundry F-1 (invariant) — через тот же ERC1967-прокси

```
Base.t.sol.setUp(): deploy ERC20Mock → deploy impl → deploy SettelmentsControlProxy(impl,
    abi.encodeCall(SettelmentsControl.initialize, (...)))  # атомарно, обход _disableInitializers
SettelmentsControl.invariant.t.sol:
    handler (targetContract(handler)) крутит topUp/payment/backFunds через vm.prank(admin)
    invariant_totalMatchesSum(): Σ getBalance(users[i]).balance == getTotalClientBalance()
```

---

## 4. NFR (нефункциональные требования)

1. `npx hardhat compile` → **exit 0** (Solidity 0.8.28, optimizer `runs=1000`, без `viaIR`; конфиг
   солидити не меняется).
2. `npx hardhat test` → **все 88 viem-кейсов зелёные, без `.env`** (без `PRIVATE_KEY`). Старые
   ethers-тесты удалены.
3. `forge test` → **F-1…F-4 зелёные**; `forge test --gas-report` и `forge snapshot` собираются (F-5).
4. Код контрактов (`contracts/`) и `scripts/deploy.ts` **не изменён** (проверка `git diff`).
5. Кэши/выходные артефакты не пересекаются: `foundry-out/`/`foundry-cache/` ≠ `artifacts/`/`cache/`.
6. `lib/forge-std` закреплён (submodule), solc 0.8.28 закреплён в `foundry.toml` — для
   воспроизводимости gas-снапшотов.

---

## 5. Trade-offs (явно зафиксированы)

1. **Два стека, один ABI-источник.** Hardhat+viem и Foundry параллельны; ABI в TS-тестах берётся
   из `artifacts/**/*.json` (как `scripts/deploy.ts`), а в Foundry — напрямую импортом контрактов
   из `contracts/`. Дублирования сигнатур нет; риск расхождения снимается `npx hardhat compile`
   перед тестами (ADR SC-7, развилка 1).
2. **gasReporter оставляем включённым** (`gasReporter.enabled = true` в `hardhat.config.ts`),
   блок не трогаем. Gas-reporter не роняет прогон (в худшем случае — неполная таблица для
   viem-транзакций). Fallback при проблемах: `REPORT_GAS=false npx hardhat test`. Цена — возможный
   «шум» в выводе; выгода — минимальная правка конфига.
3. **`loadFixture`, а не собственная снапшот-обёртка.** `loadFixture` (network-helpers 1.0.12)
   работает на уровне `evm_snapshot`/`evm_revert`, не зависит от ethers/viem; viem-клиенты
   stateless (подписывают и шлют через publicClient), сброс nonce снапшотом их не ломает
   (ADR SC-7, развилка 2). Своя обёртка `takeSnapshot`/`restore` — избыточна.
4. **Foundry через ERC1967-прокси, а не harness-контракт.** `_disableInitializers()` исполняется
   в конструкторе `SettelmentsControl` и «переезжает» в любой наследник (родительский конструктор
   всегда вызывается), поэтому harness, наследующий реализацию, тоже окажется «задизейбленным».
   Обход через `vm.store` сбросом слота `_initialized` — хрупкий. Выбран вариант «тот же прокси,
   что и в viem»: семантика идентична, специального harness не нужно.
5. **Селекторы ошибок — константы в `matchers.ts`, а не `decodeErrorResult`.** Ручная сверка
   первых 4 байт надёжнее при коллизиях имён (`OnlyAdmin` прокси/реализации) и не требует
   корректной ABI-обёртки ошибок. Цена — селекторы надо сверять с research §3 (приведены явно).
6. **F-4 (fork) — публичный RPC + детерминированный блок + skip-гвард.** Не архивный узел не
   нужен (F-4 читает `version()` и зовёт `receiveWithAuthorization` — состояние не зависит от
   архива). Блок фиксируем для воспроизводимости; при недоступности RPC — skip через env-флаг.
7. **`solidity-coverage` не добавляем** (порог качества = 88 viem + F-1…F-5). Coverage — отдельный
   будущий тикет (добавил бы chai/istanbul и третий стек).

---

## 6. Risks

1. **Параллельность Hardhat/Foundry.** Разные команды/кэши: `forge test` читает `test/foundry`,
   пишет в `foundry-out/`/`foundry-cache/`; `hardhat test` читает `test/**/*.ts`, пишет в
   `artifacts/`/`cache/`. Solc 0.8.28 закреплён в обоих — иначе gas-снапшоты F-5 несопоставимы.
   Митигация: отдельные пути в `foundry.toml` + `evm_version="cancun"` (совпадает с дефолтом Hardhat).
2. **`test/helpers/*.ts` подхватываются `npx hardhat test`.** Дефолтный сборщик Hardhat берёт
   **все** `.ts` под `test/` (проверено: `getAllFilesMatching(paths.tests, isTypescriptFile)` →
   регэксп `\.(ts|cts|mts)$`). Хелперы без `describe`/`it` загрузятся как пустые 0-test suite —
   **безвредно** (нет side effects на верхнем уровне: `hre`/`getWalletClients()` вызываются только
   внутри функций). Опция (не обязательна): сузить `paths.tests` до `"./test/**/*.test.ts"`.
   Решение: оставить дефолт, зафиксировать поведение.
3. **gasReporter + viem.** Может не собрать отчёт для viem-транзакций (исторически заточен под
   ethers), но не роняет прогон. Митигация: fallback `REPORT_GAS=false` (§5.2); приёмка опирается
   на «88 зелёных», не на отчёт газа.
4. **Fork F-4 и RPC-фолбэк.** Внешний RPC Polygon может быть недоступен/нестабилен. Митигация:
   публичный `https://polygon-rpc.com` (переопределение `POLYGON_RPC_URL` через `vm.envOr`),
   фиксированный `blockNumber`, skip-гвард по env (`FORK_TESTS=0`). Падение F-4 при недоступности
   сети — осознанный риск (документирован в PRD §«Риски»).
5. **Версия forge-std / solc.** Gas-снапшоты чувствительны к версии компилятора. Митигация:
   закрепить `solc_version = "0.8.28"` и `forge-std` тегом (submodule), `optimizer_runs = 1000`.
6. **Отсутствие chai-матчеров для viem.** Свои `expectRevertCustomError`/`expectEvent`. Риск ошибки
   в селекторах — митигируется явным списком `ERRORS` (сверен с research §3) и точечными сверками
   (research §9.2).
7. **Расхождение `TEST_PLAN.md` с фактическим ABI.** Источник истины — контракт. Имплементер сверяет
   каждую группу кейсов с research §3 (имена ошибок, порядок проверок, опечатка `reciever` в
   `BackFundsToClient`, `FeeTooHigh(uint256)` с аргументом, 3 ошибки с `SettelmentContext`).
8. **`verifyingContract` в подписи = прокси (не реализация).** Легко ошибиться → `InvalidSignature`
   при корректной подписи. Митигация: домен строится централизованно в `eip712.ts`/`eip3009.ts`
   от адреса прокси (research §9.8).
9. **Вывод POL (`withdrawStuckNative`, кейсы 69–72).** `receive()` прокси ревертит обычные
   переводы; зачисление только через `selfdestruct`-хелпер (вспомогательный контракт) или
   `hardhat_setBalance` на прокси (не `sendTransaction`) (research §9.9).
10. **Строгая типизация viem (`strict: true`).** Импорт ABI из JSON (`resolveJsonModule: true`)
    требует `as const` для ABI и `bigint`/`0x${string}` для аргументов (research §9.10).

---

## 7. ADR и решения по открытым вопросам

ADR создаётся (`docs/adr/SC-7.md`) — две значимые развилки: единый источник ABI и
`loadFixture` vs своя снапшот-обёртка.

Закрытие открытых вопросов research (§10):

| Вопрос | Решение |
| --- | --- |
| ОТВ-1 (версия hardhat-viem) | `@nomicfoundation/hardhat-viem@^2.0.0` (линия 2.x совместима с hardhat 2.24/viem 2.30). `import "@nomicfoundation/hardhat-viem"` в `hardhat.config.ts`; при ошибках типов — `"types": ["@nomicfoundation/hardhat-viem"]` в `tsconfig.json`. |
| ОТВ-2 (gas-reporter) | Оставить включённым (§5.2); fallback `REPORT_GAS=false`. |
| ОТВ-3 (Foundry + `_disableInitializers`) | Через тот же ERC1967-прокси (не harness) — §5.4. |
| ОТВ-4 (RPC для F-4) | `https://polygon-rpc.com`, override `POLYGON_RPC_URL`, фикс. `blockNumber`, skip-гвард `FORK_TESTS` — §6.4. |
| ОТВ-5 (forge-std) | `forge install foundry-rs/forge-std@<тег>` (submodule); `solc_version="0.8.28"`, `evm_version="cancun"` — §1. |
| ОТВ-6 (порог качества) | 88 viem + F-1…F-5 достаточно; `solidity-coverage` вне скоупа — §5.7. |
| ОТВ-7 (fixture vs loadFixture) | `loadFixture` — ADR SC-7, развилка 2. |
| ОТВ-8 (источник ABI) | Импорт из `artifacts/**/*.json` + константные селекторы в `matchers.ts` — ADR SC-7, развилка 1. |

---

## 8. Критерий приёмки

- `npx hardhat compile` → exit 0; `npx hardhat test` → 88 viem-кейсов зелёные, **без `.env`**.
- `forge test` → F-1…F-4 зелёные; `forge test --gas-report`/`forge snapshot` собираются (F-5).
- Присутствуют `test/helpers/{fixture,eip712,eip3009,matchers}.ts`, 7 файлов в
  `test/SettelmentsControl/`, `test/SettelmentsControlProxy.test.ts`, `test/ERC20Mock.test.ts`,
  `test/foundry/{Base,SettelmentsControl.invariant,SettelmentsControl.fuzz,USDC.fork}.t.sol`.
- `foundry.toml` с `src="contracts"`, `test="test/foundry"`, `out="foundry-out"`, solc 0.8.28,
  `lib/forge-std` установлен.
- Фикстура инициализирует через прокси с `encodeFunctionData(initialize, [6 аргументов])`,
  без `PRIVATE_KEY`; аккаунты — `hre.viem.getWalletClients()`.
- `git diff` не содержит изменений в `contracts/` и `scripts/deploy.ts`; старые ethers-тесты удалены.

---

## 9. Open questions

- **Нет блокирующих.** Неблокирующие (вне скоупа SC-7):
  - добавление `solidity-coverage` (если потребуется мерить покрытие) — отдельный тикет;
  - синхронизация `scripts/deploy.ts` (и сабграфа `thegraph/`) с актуальным ABI и его верификация
    на Polygon Amoy — отдельный тикет (в SC-7 `deploy.ts` не меняется);
  - выбор конкретного закреплённого тега `forge-std` и блока форка F-4 — определяется
    имплементером при установке/запуске (фиксируется в коде/конфиге, не в плане).
