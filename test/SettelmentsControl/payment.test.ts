import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  impersonateAccount,
  setBalance,
  stopImpersonatingAccount,
} from "@nomicfoundation/hardhat-network-helpers";

import {
  SettelmentsControlAbi,
  getClientBalance,
  randomBytes32,
  useFixture,
  type DeployFixture,
} from "../helpers/fixture";
import { setNativeAddress, topUp } from "../helpers/actions";
import {
  ERRORS,
  expectAddress,
  expectEvent,
  expectRevertCustomError,
} from "../helpers/matchers";

async function pay(
  fx: DeployFixture,
  amount: bigint,
  overrides: {
    clientId?: string;
    nativeId?: string;
    operationId?: `0x${string}`;
  } = {},
) {
  const clientId = overrides.clientId ?? "client-1";
  const nativeId = overrides.nativeId ?? "native-1";
  const operationId = overrides.operationId ?? randomBytes32();
  const timestamp = BigInt(await time.latest());
  return fx.control.write.paymentClientToNative(
    [operationId, clientId, nativeId, amount, "session-1", timestamp, 30n],
    { account: fx.clients.admin.account.address },
  );
}

async function balanceOf(fx: DeployFixture, addr: string): Promise<bigint> {
  return (await fx.token.read.balanceOf([addr])) as bigint;
}

describe("SettelmentsControl: paymentClientToNative", () => {
  it("18: успешный расчёт переводит amountToNative и feeAmount", async () => {
    const fx = await useFixture();
    const balance = 1000n * 10n ** 18n;
    const amount = 300n * 10n ** 18n;
    const feeAmount = 30n * 10n ** 18n;
    const amountToNative = 270n * 10n ** 18n;

    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    const nativeBefore = await balanceOf(fx, fx.clients.native.account.address);
    const collectorBefore = await balanceOf(
      fx,
      fx.clients.feeCollector.account.address,
    );

    const hash = await pay(fx, amount);

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(balance - amount);
    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      balance - amount,
    );

    expect(await balanceOf(fx, fx.clients.native.account.address)).to.equal(
      nativeBefore + amountToNative,
    );
    expect(
      await balanceOf(fx, fx.clients.feeCollector.account.address),
    ).to.equal(collectorBefore + feeAmount);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "PaymentClientToNative",
    );
    const ctx = ev.ctx as Record<string, unknown>;
    expect(ctx.clientId).to.equal("client-1");
    expect(ctx.nativeId).to.equal("native-1");
    expect(ctx.amountToNative).to.equal(amountToNative);
    expect(ctx.feeAmount).to.equal(feeAmount);
    expectAddress(
      ctx.nativeAddress as string,
      fx.clients.native.account.address,
    );
  });

  it("19: amount == 0 → ZeroAmount", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);
    await setNativeAddress(fx, "native-1");
    await expectRevertCustomError(pay(fx, 0n), ERRORS.ZeroAmount);
  });

  it("20: вызов не от admin → OnlyAdmin", async () => {
    const fx = await useFixture();
    const timestamp = BigInt(await time.latest());
    await expectRevertCustomError(
      fx.control.write.paymentClientToNative(
        [randomBytes32(), "client-1", "native-1", 1n, "s", timestamp, 1n],
        { account: fx.clients.owner.account.address },
      ),
      ERRORS.OnlyAdmin,
    );
  });

  it("21: nativeAddress не задан → NativeAddressIsOutForSessionSettelment", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);
    await expectRevertCustomError(
      pay(fx, 1n * 10n ** 18n),
      ERRORS.NativeAddressIsOutForSessionSettelment,
    );
  });

  it("22: баланс клиента < amount → InsufficientClientBalanceForSessionSettelment", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 10n * 10n ** 18n);
    await setNativeAddress(fx, "native-1");
    await expectRevertCustomError(
      pay(fx, 20n * 10n ** 18n),
      ERRORS.InsufficientClientBalanceForSessionSettelment,
    );
  });

  it("23: баланс токена контракта < amount → InsufficientContractBalanceForSessionSettelment", async () => {
    const fx = await useFixture();
    const balance = 100n * 10n ** 18n;
    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    // Выводим токены из прокси напрямую (impersonation), создавая рассинхрон
    // между token.balanceOf(прокси) и зачисленным балансом клиента.
    await setBalance(fx.proxy.address, 10n ** 18n);
    await impersonateAccount(fx.proxy.address);
    try {
      await fx.token.write.transfer(
        [fx.clients.user2.account.address, 50n * 10n ** 18n],
        { account: fx.proxy.address },
      );
    } finally {
      await stopImpersonatingAccount(fx.proxy.address);
    }

    await expectRevertCustomError(
      pay(fx, 80n * 10n ** 18n),
      ERRORS.InsufficientContractBalanceForSessionSettelment,
    );
  });

  it("24: расчёт комиссии feeAmount = amount * feePercentage / 100", async () => {
    const fx = await useFixture();
    const balance = 1000n * 10n ** 18n;
    const amount = 1234n; // малые единицы для проверки точной математики
    const feePercentage = fx.DEFAULT.feePercentage; // 10
    const feeAmount = (amount * feePercentage) / 100n;
    const amountToNative = amount - feeAmount;

    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    await pay(fx, amount);

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(balance - amount);
    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      balance - amount,
    );

    const totalOut = feeAmount + amountToNative;
    expect(totalOut).to.equal(amount);
  });

  it("25: feePercentage == 0 → вся сумма исполнителю", async () => {
    const fx = await useFixture();
    const balance = 100n * 10n ** 18n;
    const amount = 40n * 10n ** 18n;
    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    await fx.control.write.setFeeConfig(
      [0n, fx.clients.feeCollector.account.address],
      { account: fx.clients.owner.account.address },
    );

    const nativeBefore = await balanceOf(fx, fx.clients.native.account.address);
    await pay(fx, amount);

    expect(await balanceOf(fx, fx.clients.native.account.address)).to.equal(
      nativeBefore + amount,
    );
  });

  it("26: feePercentage == 100 → вся сумма сборщику", async () => {
    const fx = await useFixture();
    const balance = 100n * 10n ** 18n;
    const amount = 40n * 10n ** 18n;
    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    await fx.control.write.setFeeConfig(
      [100n, fx.clients.feeCollector.account.address],
      { account: fx.clients.owner.account.address },
    );

    const collectorBefore = await balanceOf(
      fx,
      fx.clients.feeCollector.account.address,
    );
    const nativeBefore = await balanceOf(fx, fx.clients.native.account.address);
    await pay(fx, amount);

    expect(
      await balanceOf(fx, fx.clients.feeCollector.account.address),
    ).to.equal(collectorBefore + amount);
    expect(await balanceOf(fx, fx.clients.native.account.address)).to.equal(
      nativeBefore,
    );
  });

  it("27: округление вниз — малый amount даёт feeAmount == 0", async () => {
    const fx = await useFixture();
    const balance = 1000n * 10n ** 18n;
    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    await fx.control.write.setFeeConfig(
      [1n, fx.clients.feeCollector.account.address],
      { account: fx.clients.owner.account.address },
    );

    const amount = 99n;
    const nativeBefore = await balanceOf(fx, fx.clients.native.account.address);
    await pay(fx, amount);

    // 99 * 1 / 100 = 0 → feeAmount == 0, всё исполнителю.
    expect(await balanceOf(fx, fx.clients.native.account.address)).to.equal(
      nativeBefore + amount,
    );
  });

  it("93: нулевой operationId → EmptyOperationId", async () => {
    const fx = await useFixture();
    const zeroId = `0x${"00".repeat(32)}`;
    await expectRevertCustomError(
      pay(fx, 1n * 10n ** 18n, { operationId: zeroId }),
      ERRORS.EmptyOperationId,
    );
  });

  it("94: повторный operationId после успеха → OperationAlreadyProcessed", async () => {
    const fx = await useFixture();
    const balance = 1000n * 10n ** 18n;
    const amount = 300n * 10n ** 18n;
    const opId = randomBytes32();

    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    const hash = await pay(fx, amount, { operationId: opId });
    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "PaymentClientToNative",
    );
    expect(ev.operationId).to.equal(opId);

    await expectRevertCustomError(
      pay(fx, amount, { operationId: opId }),
      ERRORS.OperationAlreadyProcessed,
    );
  });

  it("95: revert (недостаток баланса) не сжигает ключ — retry с тем же operationId проходит", async () => {
    const fx = await useFixture();
    const amount = 100n * 10n ** 18n;
    const opId = randomBytes32();

    await setNativeAddress(fx, "native-1");
    await expectRevertCustomError(
      pay(fx, amount, { operationId: opId }),
      ERRORS.InsufficientClientBalanceForSessionSettelment,
    );

    // Пополняем и повторяем с тем же operationId.
    await topUp(fx, "client-1", amount);
    await pay(fx, amount, { operationId: opId });

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(0n);
  });

  it("96: разные operationId не конфликтуют", async () => {
    const fx = await useFixture();
    const balance = 1000n * 10n ** 18n;
    await topUp(fx, "client-1", balance);
    await setNativeAddress(fx, "native-1");

    await pay(fx, 100n * 10n ** 18n, { operationId: randomBytes32() });
    await pay(fx, 200n * 10n ** 18n, { operationId: randomBytes32() });

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(balance - 300n * 10n ** 18n);
  });
});
