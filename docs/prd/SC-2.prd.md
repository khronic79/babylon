# SC-2: Верификация подписи назначения адреса носителя (H-01)

Status: PRD_READY
stage: IMPLEMENT

## Контекст / идея

Согласно аудиту `docs/audit-reports/2026-08-20.md`, находка **H-01 (High)**: в
`setNativeAddressWithSignature` (`contracts/SettelmentsControl.sol:353-403`) подпись
восстанавливается через `ecrecover`, но проверяется только `signer != address(0)`,
а не то, что подпись принадлежит владельцу привязываемого адреса. В текущем виде
админ может привязать любой `nativeAddress` к любому `nativeId` без согласия
владельца адреса — EIP-712 подпись фактически не даёт дополнительной защиты.

**Замысел продукта:** носитель перед назначением/сменой своего адреса подписывает в
кошельке данные `(nativeId, nativeAddress, nonce, deadline)`, бэк дополнительно
подтверждает личность по email, после чего бэк (admin) ретранслирует подпись в
`setNativeAddressWithSignature`. Это «двойная проверка»: подпись = доказательство
владения ключом `nativeAddress`, email = проверка личности.

**Расхождение с рекомендацией аудита (осознанное):** аудит H-01 предлагал сверять
`signer` с полем `owner` (`signer != $.owner`). Финализированное решение — сверять
`signer == nativeAddress`: подписантом должен быть именно владелец привязываемого
кошелька, а `owner` остаётся отдельной управленческой ролью (см. ниже про I-01).
Модификатор `onlyAdmin` у функции сохраняется — ретранслятором остаётся бэк.

Связанные находки аудита, закрываемые тикетом:

- **H-01** — отсутствие проверки `signer == nativeAddress`.
- **L-02** — маллеабельность `ecrecover` (нет проверки каноничности `s`): заменить
  `ecrecover` на `ECDSA.recover` из OpenZeppelin.
- **I-01** — `owner`/`onlyOwner` — мёртвый код: задействовать, переведя `changeAdmin`
  с `onlyAdmin` на `onlyOwner`.
- **M-01** — `changeAdmin` без проверки нулевого адреса: добавить
  `newAdmin != address(0)`.

Дополнительно (не из аудита, по итогам обсуждения): ввести потолок срока валидности
подписи `MAX_VALIDITY`.

## Цели

- Обеспечить, чтобы привязка `nativeId -> nativeAddress` выполнялась только при
  наличии подписи, принадлежащей владельцу `nativeAddress`
  (проверка `signer == nativeAddress`).
- Устранить маллеабельность подписи: использовать `ECDSA.recover` из OpenZeppelin
  вместо `ecrecover`.
- Ввести срок валидности подписи: добавить `uint256 deadline` в подписываемый
  payload, обновить `ASSIGNMENT_TYPEHASH` и `structHash`, проверять
  `block.timestamp <= deadline` (новая ошибка `SignatureExpired`).
- Ввести потолок срока валидности: хранить `maxValidity` в `ContractStorage`,
  задавать через `initialize` (новый параметр `_maxValidity`, с проверкой
  `_maxValidity > 0`), отклонять подписи со слишком далёким `deadline` (новая
  ошибка `DeadlineTooFar`).
- Добавить управление `maxValidity`: геттер `getMaxValidity()` и сеттер
  `setMaxValidity(uint256)` (onlyOwner, проверка `> 0`, ошибка `InvalidMaxValidity`,
  событие `MaxValiditySet`).
- Гарантировать, что невалидная/просроченная подпись **не** «сжигает» nonce:
  проверка подписи (`signer == nativeAddress`) выполняется **до**
  `usedNonces[...] = true`.
- Задействовать роль `owner`: перевести `changeAdmin` с `onlyAdmin` на `onlyOwner`
  (закрывает I-01) и добавить проверку `newAdmin != address(0)` (закрывает M-01,
  новая ошибка `InvalidAdmin`).
- Не менять `nonce` (остаётся `string`, генерируется бэком) и перезапись привязки
  `nativeId -> nativeAddress` (допустимая фича).

## User stories

- Как носитель (владелец `nativeAddress`), я хочу, чтобы мой адрес привязывался к
  `nativeId` только если я лично подписал `(nativeId, nativeAddress, nonce, deadline)`,
  чтобы никто (включая бэк-админа) не мог подменить мой адрес без моего ключа.
- Как бэк/админ, я хочу ретранслировать подпись носителя в
  `setNativeAddressWithSignature`, не имея возможности привязать произвольный
  `nativeAddress` без подписи его владельца.
- Как оператор, я хочу, чтобы подпись имела ограниченный срок действия (`deadline`
  с потолком `maxValidity`), чтобы старые подписанные payload нельзя было
  использовать неограниченно долго.
- Как владелец контракта (`owner`), я хочу единолично управлять сменой
  администратора (`changeAdmin`) и значением `maxValidity`, и не допустить
  назначения нулевого адреса или нулевого потолка срока валидности.

## Основные сценарии

1. **Успешная привязка:** носитель подписывает
   `(nativeId, nativeAddress, nonce, deadline)`; бэк (admin) вызывает
   `setNativeAddressWithSignature` до истечения `deadline`. `ECDSA.recover`
   восстанавливает `signer == nativeAddress`, nonce не использован,
   `block.timestamp <= deadline` — привязка записывается, nonce помечается
   использованным, эмитится `NativeAddressSet`.
2. **Неверная подпись (не владелец адреса):** `signer != nativeAddress` →
   `InvalidSignature`; nonce **не** помечается использованным (можно повторить с
   корректной подписью).
3. **Просроченная подпись:** `block.timestamp > deadline` → `SignatureExpired`;
   nonce не «сжигается».
4. **Слишком далёкий `deadline`:** `deadline - block.timestamp > maxValidity` →
   `DeadlineTooFar`; nonce не «сжигается».
5. **Повторное использование nonce:** nonce уже в `usedNonces` → `NonceAlreadyUsed`.
6. **Перезапись привязки:** смена `nativeAddress` для существующего `nativeId`
   возможна с новой подписью владельца нового адреса (допустимая фича).
7. **Смена админа:** `changeAdmin(newAdmin)` вызывается только от `owner`; вызов от
   `admin` ревертится `OnlyOwner`.
8. **Нулевой новый админ:** `changeAdmin(address(0))` → `InvalidAdmin`.
9. **Смена `maxValidity`:** `setMaxValidity(newMaxValidity)` — только от `owner`;
   `newMaxValidity == 0` → `InvalidMaxValidity`; вызов от `admin` ревертится
   `OnlyOwner`; при успехе эмитится `MaxValiditySet`.
10. **Пустые/нулевые входные данные:** пустой `nativeId` → `EmptyNativeId`,
   `nativeAddress == address(0)` → `InvalidNativeAddress`, пустой `nonce` →
   `EmptyNonce` (существующее поведение сохраняется).

## Успех / метрики

- Привязка `nativeId -> nativeAddress` выполняется только при
  `recoveredSigner == nativeAddress`; иначе `InvalidSignature`, и nonce не расходуется.
- `ECDSA.recover` используется вместо `ecrecover`; маллеабельные подписи (high-`s`,
  неканоничный `v`) отклоняются.
- Подпись с `deadline` в прошлом ревертится `SignatureExpired`, а с
  `deadline - block.timestamp > maxValidity` — `DeadlineTooFar`; `deadline` включён
  в `ASSIGNMENT_TYPEHASH` и `structHash`.
- `changeAdmin` доступен только `owner` (реверт `OnlyOwner` от `admin`);
  `changeAdmin(address(0))` ревертится `InvalidAdmin`; роль `owner` больше не
  мёртвый код.
- `maxValidity` доступен через `getMaxValidity()`; `setMaxValidity(uint256)`
  доступен только `owner` (`OnlyOwner` от `admin`), `0` → `InvalidMaxValidity`,
  при успехе эмитится `MaxValiditySet`.
- **Критерий успеха — успешная компиляция:** `npx hardhat compile` возвращает код 0
  на чистом кэше; `viaIR` остаётся выключенным.
- В `ContractStorage` добавлено поле `uint256 maxValidity`, задаваемое через
  `initialize` (параметр `_maxValidity`, проверка `_maxValidity > 0`); `deadline`
  не персистируется (проверяется в момент вызова).

## Ограничения и допущения

- Область — `setNativeAddressWithSignature` (проверка подписи, `ECDSA.recover`,
  `deadline`, потолок `maxValidity`) и `changeAdmin` (смена модификатора на
  `onlyOwner` + проверка `newAdmin != address(0)`), а также добавление параметра
  `_maxValidity` в `initialize`. Прочие находки аудита вне скоупа.
- Подписант — владелец `nativeAddress` (`signer == nativeAddress`), а не поле
  `owner`. Это осознанное отклонение от рекомендации аудита H-01.
- `nonce` остаётся `string`, генерируется и выдаётся бэком. Идея делегировать
  выдачу nonce смарт-контракту (внутренний счётчик) **отложена** и в задачу не
  входит.
- Перезапись привязки `nativeId -> nativeAddress` остаётся допустимой фичей.
- `owner` задаётся в `initialize` (поле уже существует).
- `maxValidity` задаётся через `initialize` (новый параметр `_maxValidity`, проверка
  `_maxValidity > 0`); далее управляется геттером `getMaxValidity()` и сеттером
  `setMaxValidity(uint256)` (onlyOwner).

## Риски

- Если проверка подписи окажется после `usedNonces[...] = true`, невалидная подпись
  будет «сжигать» nonce и блокировать легитимные повторные попытки — порядок
  проверок критичен.
- Смена `ASSIGNMENT_TYPEHASH`/`structHash` (добавление `deadline`) ломает
  совместимость со старыми подписанными payload: ранее выданные nonce/подписи
  станут невалидными. Продукт ещё не в проде — приемлемо.
- `ECDSA.recover` ревертит на некорректных подписях; важно сохранить различимую
  ошибку `InvalidSignature` (не «прятать» revert библиотеки).
- Перевод `changeAdmin` на `onlyOwner` требует, чтобы адрес `owner` был доступен и
  под контролем; если `owner` совпадает с `admin`, разграничение ролей теряется.
- Слишком малый `maxValidity` может вызывать `DeadlineTooFar` у легитимных
  пользователей (например, медленное email-подтверждение); слишком большой —
  обесценивает срок валидности. Значение выбирается при инициализации.
- Изменение сигнатуры `initialize` (новый параметр `_maxValidity`) ломает уже
  нерабочий `scripts/deploy.ts` (находка H-02) и любых off-chain вызывающих —
  синхронизация вне скоупа SC-2.

## Открытые вопросы

- (неблокирующее) Порядок проверки `deadline`/`DeadlineTooFar` относительно
  `NonceAlreadyUsed` уточняется на этапе плана/реализации; обязательный инвариант —
  невалидная/просроченная подпись не сжигает nonce.
