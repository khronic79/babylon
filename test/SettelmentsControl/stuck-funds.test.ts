import { expect } from "chai";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";
import { zeroAddress } from "viem";

import {
  SettelmentsControlAbi,
  useFixture,
  type DeployFixture,
} from "../helpers/fixture";
import { topUp } from "../helpers/actions";
import {
  ERRORS,
  expectAddress,
  expectEvent,
  expectRevertCustomError,
} from "../helpers/matchers";

function withdrawTokens(
  fx: DeployFixture,
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
) {
  return fx.control.write.withdrawStuckTokens([token, to, amount], {
    account: fx.clients.owner.account.address,
  });
}

function withdrawNative(
  fx: DeployFixture,
  to: `0x${string}`,
  amount: bigint,
) {
  return fx.control.write.withdrawStuckNative([to, amount], {
    account: fx.clients.owner.account.address,
  });
}

describe("SettelmentsControl: вывод застрявших средств", () => {
  it("62: withdrawStuckTokens выводит ровно избыток", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);

    // Добавляем «застрявший» избыток прямым переводом на прокси.
    await fx.token.write.transfer(
      [fx.proxy.address, 50n * 10n ** 18n],
      { account: fx.clients.user1.account.address },
    );

    const user2Before = (await fx.token.read.balanceOf([
      fx.clients.user2.account.address,
    ])) as bigint;

    await withdrawTokens(
      fx,
      fx.token.address,
      fx.clients.user2.account.address,
      50n * 10n ** 18n,
    );

    expect(
      (await fx.token.read.balanceOf([
        fx.clients.user2.account.address,
      ])) as bigint,
    ).to.equal(user2Before + 50n * 10n ** 18n);

    // Точно избыток: тотал клиентов не тронут.
    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      100n * 10n ** 18n,
    );
  });

  it("63: withdrawStuckTokens amount > избыток → InsufficientStuckFunds", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);
    await fx.token.write.transfer(
      [fx.proxy.address, 10n * 10n ** 18n],
      { account: fx.clients.user1.account.address },
    );

    await expectRevertCustomError(
      withdrawTokens(
        fx,
        fx.token.address,
        fx.clients.user2.account.address,
        20n * 10n ** 18n,
      ),
      ERRORS.InsufficientStuckFunds,
    );
  });

  it("64: withdrawStuckTokens без избытка → InsufficientStuckFunds", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);

    await expectRevertCustomError(
      withdrawTokens(
        fx,
        fx.token.address,
        fx.clients.user2.account.address,
        1n,
      ),
      ERRORS.InsufficientStuckFunds,
    );
  });

  it("65: withdrawStuckTokens прочий токен выводится целиком", async () => {
    const fx = await useFixture();
    const other = await hre.viem.deployContract("ERC20Mock", [
      "Other",
      "OTH",
      fx.clients.owner.account.address,
      1_000_000n * 10n ** 18n,
    ]);

    // Прямой перевод прочего токена на прокси.
    await other.write.transfer([fx.proxy.address, 123n * 10n ** 18n], {
      account: fx.clients.owner.account.address,
    });

    const user2Before = (await other.read.balanceOf([
      fx.clients.user2.account.address,
    ])) as bigint;

    await withdrawTokens(
      fx,
      other.address,
      fx.clients.user2.account.address,
      123n * 10n ** 18n,
    );

    expect(
      (await other.read.balanceOf([fx.clients.user2.account.address])) as bigint,
    ).to.equal(user2Before + 123n * 10n ** 18n);
  });

  it("66: withdrawStuckTokens to == 0 → ZeroAddress", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      withdrawTokens(fx, fx.token.address, zeroAddress, 1n),
      ERRORS.ZeroAddress,
    );
  });

  it("67: withdrawStuckTokens token == 0 → ZeroAddress", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      withdrawTokens(
        fx,
        zeroAddress,
        fx.clients.user2.account.address,
        1n,
      ),
      ERRORS.ZeroAddress,
    );
  });

  it("68: withdrawStuckTokens amount == 0 → ZeroAmount", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      withdrawTokens(fx, fx.token.address, fx.clients.user2.account.address, 0n),
      ERRORS.ZeroAmount,
    );
  });

  it("69: withdrawStuckNative выводит POL (зачисление через hardhat_setBalance)", async () => {
    const fx = await useFixture();
    const amount = 5n * 10n ** 18n;
    await setBalance(fx.proxy.address, amount);

    const to = fx.clients.user2.account.address;
    const before = await fx.publicClient.getBalance({ address: to });

    const hash = await withdrawNative(fx, to, amount);

    expect(await fx.publicClient.getBalance({ address: to })).to.equal(
      before + amount,
    );

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "StuckFundsWithdrawn",
    );
    expectAddress(ev.token as string, zeroAddress);
    expectAddress(ev.to as string, to);
    expect(ev.amount).to.equal(amount);
  });

  it("70: withdrawStuckNative amount > balance → InsufficientStuckFunds", async () => {
    const fx = await useFixture();
    await setBalance(fx.proxy.address, 1n * 10n ** 18n);

    await expectRevertCustomError(
      withdrawNative(fx, fx.clients.user2.account.address, 2n * 10n ** 18n),
      ERRORS.InsufficientStuckFunds,
    );
  });

  it("71: withdrawStuckNative to == 0 → ZeroAddress", async () => {
    const fx = await useFixture();
    await setBalance(fx.proxy.address, 1n * 10n ** 18n);

    await expectRevertCustomError(
      withdrawNative(fx, zeroAddress, 1n),
      ERRORS.ZeroAddress,
    );
  });

  it("72: withdrawStuckNative amount == 0 → ZeroAmount", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      withdrawNative(fx, fx.clients.user2.account.address, 0n),
      ERRORS.ZeroAmount,
    );
  });
});
