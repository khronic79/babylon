# План тестов контрактов `SettelmentsControl` / `SettelmentsControlProxy` / `ERC20Mock`

## Стек тестирования (зафиксированное решение)

- **Интеграционные/юнит TS-тесты:** Hardhat + **viem** (плагин `@nomicfoundation/hardhat-viem`)
  — единый стек с `scripts/deploy.ts` (общие хелперы: `encodeFunctionData` для init-`data`
  прокси, `signTypedData` для EIP-712/EIP-3009 подписей).
- **«Жёсткие» тесты инвариантов/подписей/форка:** опционально **Foundry (Forge)**
  параллельно — fuzzing (`testFuzz`), invariant (`totalClientBalance == Σ clientBalances`),
  fork-тест против реального USDC на Polygon (`receiveWithAuthorization`).
- Проверка revert/событий — через хелперы viem (ловля ошибки + сверка селектора,
  `getContractEvents`); chai-матчеры `hardhat-chai-matchers` не используются.
- Требуется добавить dev-зависимость `@nomicfoundation/hardhat-viem` (и, при выборе
  Foundry, `forge`/`foundry.toml`).

Фикстура: `owner`, `admin`, `feeCollector`, `user1`, `user2`, `native` — аккаунты Hardhat;
деплой `ERC20Mock` + `SettelmentsControl` + `SettelmentsControlProxy`; инициализация через
прокси с `data` (`initialize(token, admin, owner, feePercentage, feeCollector, maxValidity)`).

| № | Группа | Тест-кейс | Ожидаемый результат | Стек |
| --- | --- | --- | --- | --- |
| 1 | Инициализация | `initialize` с валидными параметрами | поля заданы; события `ChangeAdmin`, `FeeConfigSet` | viem |
| 2 | Инициализация | `feePercentage > 100` | revert `FeeTooHigh` | viem |
| 3 | Инициализация | `maxValidity == 0` | revert `InvalidMaxValidity` | viem |
| 4 | Инициализация | `_token == address(0)` | revert `ZeroAddress` | viem |
| 5 | Инициализация | `_admin == address(0)` | revert `ZeroAddress` | viem |
| 6 | Инициализация | `_owner == address(0)` | revert `ZeroAddress` | viem |
| 7 | Инициализация | `_feeCollector == address(0)` | revert `ZeroAddress` | viem |
| 8 | Инициализация | повторный `initialize` | revert `InvalidInitialization` | viem |
| 9 | Инициализация | атомарная инициализация через прокси (`data` в конструкторе) | состояние инициализировано; `getImpl()` корректен | viem |
| 10 | Топ-ап | админ ретранслирует EIP-3009 authorization от `user1` | баланс клиента `+= value`; `totalClientBalance += value`; `lastInboundAddress = user1`; событие `TopUpClientBalance` | viem |
| 11 | Топ-ап | несколько топ-апов | баланс и тотал накапливаются | viem |
| 12 | Топ-ап | вызов не от `admin` | revert `OnlyAdmin` | viem |
| 13 | Топ-ап | authorization с неверной подписью | revert (ошибка мока) | viem |
| 14 | Топ-ап | просроченная authorization (`validBefore` в прошлом) | revert (ошибка мока) | viem |
| 15 | Топ-ап | authorization ещё не валидна (`validAfter` в будущем) | revert (ошибка мока) | viem |
| 16 | Топ-ап | повторный nonce | revert (ошибка мока) | viem |
| 17 | Топ-ап | сверка после топ-апа | `balanceOf(контракт) == totalClientBalance` | viem |
| 18 | Расчёты | успешный `paymentClientToNative` | `amountToNative` → native, `feeAmount` → feeCollector; баланс клиента и тотал `-= amount`; событие `PaymentClientToNative(ctx)` | viem |
| 19 | Расчёты | `amount == 0` | revert `ZeroAmount` | viem |
| 20 | Расчёты | вызов не от `admin` | revert `OnlyAdmin` | viem |
| 21 | Расчёты | `nativeAddress` не задан | revert `NativeAddressIsOutForSessionSettelment` | viem |
| 22 | Расчёты | баланс клиента < amount | revert `InsufficientClientBalanceForSessionSettelment` | viem |
| 23 | Расчёты | баланс токена контракта < amount | revert `InsufficientContractBalanceForSessionSettelment` | viem |
| 24 | Расчёты | расчёт комиссии | `feeAmount = amount * feePercentage / 100`; `amountToNative = amount − feeAmount` | viem |
| 25 | Расчёты | `feePercentage == 0` | вся сумма исполнителю; `feeAmount == 0` | viem |
| 26 | Расчёты | `feePercentage == 100` | `amountToNative == 0`; вся сумма сборщику | viem |
| 27 | Расчёты | округление вниз (малый amount/низкий процент) | `feeAmount == 0` (задокументировано) | viem |
| 28 | Возврат | успешный `backFundsToClient` | возврат на `lastInboundAddress`; баланс клиента и тотал `-= amount`; событие `BackFundsToClient` | viem |
| 29 | Возврат | `amount == 0` | revert `ZeroAmount` | viem |
| 30 | Возврат | вызов не от `admin` | revert `OnlyAdmin` | viem |
| 31 | Возврат | баланс клиента < amount | revert `InsufficientClientBalanceForBackFunds` | viem |
| 32 | Возврат | баланс контракта < amount | revert `InsufficientContractBalanceForBackFunds` | viem |
| 33 | Возврат | частичный возврат | остаток сохраняется; получатель — последний адрес пополнения | viem |
| 34 | Привязка адреса | валидная подпись (`signer == nativeAddress`) | адрес записан; nonce помечен; событие `NativeAddressSet` | viem |
| 35 | Привязка адреса | вызов не от `admin` | revert `OnlyAdmin` | viem |
| 36 | Привязка адреса | пустой `nativeId` | revert `EmptyNativeId` | viem |
| 37 | Привязка адреса | `nativeAddress == address(0)` | revert `InvalidNativeAddress` | viem |
| 38 | Привязка адреса | пустой `nonce` | revert `EmptyNonce` | viem |
| 39 | Привязка адреса | повторный nonce | revert `NonceAlreadyUsed` | viem |
| 40 | Привязка адреса | `deadline` в прошлом | revert `SignatureExpired` | viem |
| 41 | Привязка адреса | `deadline − now > maxValidity` | revert `DeadlineTooFar` | viem |
| 42 | Привязка адреса | подпись от чужого ключа (`signer != nativeAddress`) | revert `InvalidSignature` | viem |
| 43 | Привязка адреса | маллеабельная/неканоничная подпись (high-s) | revert `InvalidSignature` | viem |
| 44 | Привязка адреса | невалидная/просроченная подпись не сжигает nonce | повтор с валидной подписью проходит | viem |
| 45 | Роли | `topUpClientBalance` от `owner` | revert `OnlyAdmin` | viem |
| 46 | Роли | `paymentClientToNative` от `owner` | revert `OnlyAdmin` | viem |
| 47 | Роли | `backFundsToClient` от `owner` | revert `OnlyAdmin` | viem |
| 48 | Роли | `setNativeAddressWithSignature` от `owner` | revert `OnlyAdmin` | viem |
| 49 | Роли | `changeAdmin` от `admin` | revert `OnlyOwner` | viem |
| 50 | Роли | `setMaxValidity` от `admin` | revert `OnlyOwner` | viem |
| 51 | Роли | `setFeeConfig` от `admin` | revert `OnlyOwner` | viem |
| 52 | Роли | `withdrawStuckTokens` от `admin` | revert `OnlyOwner` | viem |
| 53 | Роли | `withdrawStuckNative` от `admin` | revert `OnlyOwner` | viem |
| 54 | Управление | `changeAdmin` валидный | админ сменён; событие `ChangeAdmin` | viem |
| 55 | Управление | `changeAdmin(address(0))` | revert `InvalidAdmin` | viem |
| 56 | Управление | `setMaxValidity` валидный | значение обновлено; событие `MaxValiditySet` | viem |
| 57 | Управление | `setMaxValidity(0)` | revert `InvalidMaxValidity` | viem |
| 58 | Управление | `setFeeConfig` валидный | оба поля обновлены; событие `FeeConfigSet` | viem |
| 59 | Управление | `setFeeConfig` с `>100` | revert `FeeTooHigh` | viem |
| 60 | Управление | `setFeeConfig` с `feeCollector == 0` | revert `InvalidFeeCollector` | viem |
| 61 | Геттеры | `getAdmin`/`getMaxValidity`/`getFeeConfig`/`getTotalClientBalance`/`getBalance`/`getNativeAddress`/`isNativeAddressSet`/`isNonceUsed` | возвращают актуальные значения | viem |
| 62 | Вывод застрявшего | `withdrawStuckTokens` (USDC, есть избыток) | выведен ровно избыток `balanceOf − totalClientBalance` | viem |
| 63 | Вывод застрявшего | `withdrawStuckTokens` (USDC, `amount > избыток`) | revert `InsufficientStuckFunds` | viem |
| 64 | Вывод застрявшего | `withdrawStuckTokens` (USDC, избытка нет) | revert `InsufficientStuckFunds` | viem |
| 65 | Вывод застрявшего | `withdrawStuckTokens` (прочий токен) | выведен весь баланс (без ограничения) | viem |
| 66 | Вывод застрявшего | `withdrawStuckTokens`: `to == 0` | revert `ZeroAddress` | viem |
| 67 | Вывод застрявшего | `withdrawStuckTokens`: `token == 0` | revert `ZeroAddress` | viem |
| 68 | Вывод застрявшего | `withdrawStuckTokens`: `amount == 0` | revert `ZeroAmount` | viem |
| 69 | Вывод застрявшего | `withdrawStuckNative` успех (POL через `selfdestruct`) | POL выведен | viem |
| 70 | Вывод застрявшего | `withdrawStuckNative`: `amount > balance` | revert `InsufficientStuckFunds` | viem |
| 71 | Вывод застрявшего | `withdrawStuckNative`: `to == 0` | revert `ZeroAddress` | viem |
| 72 | Вывод застрявшего | `withdrawStuckNative`: `amount == 0` | revert `ZeroAmount` | viem |
| 73 | Прокси | `getProxyAdmin()` | равен деплойеру | viem |
| 74 | Прокси | `changeProxyAdmin` валидный | админ прокси сменён | viem |
| 75 | Прокси | `changeProxyAdmin` не от админа | revert `OnlyAdmin` | viem |
| 76 | Прокси | `getImpl()` | возвращает имплементацию | viem |
| 77 | Прокси | `setImpl` от админа | имплементация сменена | viem |
| 78 | Прокси | `setImpl` не от админа | revert `OnlyAdmin` | viem |
| 79 | Прокси | отправка ETH на прокси | revert `NotAcceptEtherDirectly` | viem |
| 80 | Прокси | сквозной сценарий через прокси | топ-ап → расчёт → возврат работают | viem |
| 81 | Мок-токен | `version()` | `"2"` | viem |
| 82 | Мок-токен | `authorizationState` | `false` до использования, `true` после | viem |
| 83 | Мок-токен | `receiveWithAuthorization` успех | перевод; nonce помечен; событие `AuthorizationUsed` | viem |
| 84 | Мок-токен | `to != msg.sender` | revert `PayeeMustBeCaller` | viem |
| 85 | Мок-токен | `validAfter` в будущем | revert `AuthorizationNotYetValid` | viem |
| 86 | Мок-токен | `validBefore` в прошлом | revert `AuthorizationExpired` | viem |
| 87 | Мок-токен | повторный nonce | revert `AuthorizationAlreadyUsed` | viem |
| 88 | Мок-токен | неверная подпись | revert `InvalidAuthorizationSignature` | viem |
| 89 | Идемпотентность (topUp) | нулевой `operationId` (`bytes32(0)`) | revert `EmptyOperationId`; баланс не меняется | viem |
| 90 | Идемпотентность (topUp) | повторный `operationId` после успеха | revert `OperationAlreadyProcessed`; событие содержит `indexed operationId` | viem |
| 91 | Идемпотентность (topUp) | revert внешнего вызова (просроченная authorization) → retry с тем же `operationId` | ключ не сжигается, retry проходит | viem |
| 92 | Идемпотентность (topUp) | разные `operationId` | не конфликтуют, баланс накапливается | viem |
| 93 | Идемпотентность (payment) | нулевой `operationId` | revert `EmptyOperationId` | viem |
| 94 | Идемпотентность (payment) | повторный `operationId` после успеха | revert `OperationAlreadyProcessed`; событие содержит `indexed operationId` | viem |
| 95 | Идемпотентность (payment) | revert (недостаток баланса) → retry с тем же `operationId` | ключ не сжигается, retry проходит | viem |
| 96 | Идемпотентность (payment) | разные `operationId` | не конфликтуют | viem |
| 97 | Идемпотентность (backFunds) | нулевой `operationId` | revert `EmptyOperationId` | viem |
| 98 | Идемпотентность (backFunds) | повторный `operationId` после успеха | revert `OperationAlreadyProcessed`; событие содержит `indexed operationId` | viem |
| 99 | Идемпотентность (backFunds) | revert (недостаток баланса) → retry с тем же `operationId` | ключ не сжигается, retry проходит | viem |
| 100 | Идемпотентность (backFunds) | разные `operationId` | не конфликтуют | viem |

## Foundry-дополнение (forge)

«Жёсткие» тесты — проверка **свойств** (а не фиксированных сценариев): инварианты при
любой последовательности вызовов, тысячи случайных входов (fuzz), работа против реальной
сети (fork). Дополняют таблицу viem-кейсов, не дублируют их.

### F-1. Invariant `totalClientBalance == Σ clientBalances`

Риск SC-6: рассинхрон тотала (забыли обновить в одной из трёх функций → можно вывести
чужие средства). Foundry крутит случайные последовательности `topUp` → `payment` →
`backFunds` через handler и после каждого шага сверяет инвариант.

```solidity
function invariant_totalMatchesSum() public {
    uint256 sum = 0;
    for (uint256 i = 0; i < users.length; i++) {
        sum += control.getBalance(users[i]).balance;
    }
    assertEq(control.getTotalClientBalance(), sum);
}
```

### F-2. Fuzz `paymentClientToNative` (комиссия/округление)

Тысячи случайных `amount`/`feePercentage` (0..100) — проверка математики и границ.

```solidity
function testFuzz_feeMath(uint256 amount, uint8 feePercentage) public {
    feePercentage = uint8(bound(feePercentage, 0, 100));
    // настройка: достаточно баланса клиента и токена
    uint256 feeAmount = amount * feePercentage / 100;
    uint256 amountToNative = amount - feeAmount;
    // переводы/списание == amount; нет underflow; границы 0/100
}
```

### F-3. Fuzz EIP-712 подписи (`setNativeAddressWithSignature`)

Edge-подписи и границы: high-`s` (malleability), `v ∉ {27,28}`, чужой signer,
`deadline` на границе `block.timestamp`/`maxValidity`. Проверка: всегда
`InvalidSignature`/`SignatureExpired`/`DeadlineTooFar`, **nonce не сжигается**.

```solidity
function testFuzz_badSignature(uint8 v, bytes32 r, bytes32 s, uint256 deadline) public {
    // edge-подписи → vm.expectRevert(InvalidSignature.selector)
}
```

### F-4. Fork-тест против реального USDC (Polygon)

Отложенный ABI-чек (H-03): ответвиться от Polygon mainnet и дёрнуть настоящий USDC.

```solidity
vm.createSelectFork(polygonRpc);
address usdc = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
assertEq(IERC3009(usdc).version(), "2");
// receiveWithAuthorization с подписью (vm.prank + vm.sign) — split-сигнатура работает
```

Проверяет: split-сигнатура `(v,r,s)` существует, подпись валидируется так, как
воспроизведено в моке — закрывает допущение про USDC.

### F-5. Gas-снапшоты

`forge snapshot` + `forge test --gas-report` — профили газа ключевых функций для контроля
регрессий при будущих правках.

---

## Почему Foundry, а не viem (сводка)

| Возможность | viem/Hardhat | Foundry |
| --- | --- | --- |
| Fuzzing (тысячи случайных входов) | вручную/библиотеки | нативно (`testFuzz`) |
| Invariant (свойство при любой последовательности) | нет готового | нативно (`invariant_` + handler) |
| `vm.warp`/`vm.prank`/`vm.sign` | через JSON-RPC, медленнее | cheatcodes, быстро |
| Fork mainnet | `hardhat_reset` + `forking` (руками) | `vm.createSelectFork` (одна строка) |
| Скорость | средняя | высокая |
