import { expect } from "chai";
import {
  impersonateAccount,
  setBalance,
  stopImpersonatingAccount,
} from "@nomicfoundation/hardhat-network-helpers";

import {
  SettelmentsControlAbi,
  getClientBalance,
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

function backFunds(fx: DeployFixture, userId: string, amount: bigint) {
  return fx.control.write.backFundsToClient([userId, amount], {
    account: fx.clients.admin.account.address,
  });
}

describe("SettelmentsControl: backFundsToClient", () => {
  it("28: успешный возврат на lastInboundAddress", async () => {
    const fx = await useFixture();
    const balance = 1000n * 10n ** 18n;
    const amount = 300n * 10n ** 18n;

    await topUp(fx, "client-1", balance);

    const userBefore = (await fx.token.read.balanceOf([
      fx.clients.user1.account.address,
    ])) as bigint;

    const hash = await backFunds(fx, "client-1", amount);

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(balance - amount);
    expectAddress(
      bal.lastInboundAddress,
      fx.clients.user1.account.address,
    );
    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      balance - amount,
    );

    expect(
      (await fx.token.read.balanceOf([
        fx.clients.user1.account.address,
      ])) as bigint,
    ).to.equal(userBefore + amount);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "BackFundsToClient",
    );
    expect(ev.userId).to.equal("client-1");
    expect(ev.amount).to.equal(amount);
    expectAddress(
      ev.reciever as string,
      fx.clients.user1.account.address,
    );
  });

  it("29: amount == 0 → ZeroAmount", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);
    await expectRevertCustomError(
      backFunds(fx, "client-1", 0n),
      ERRORS.ZeroAmount,
    );
  });

  it("30: вызов не от admin → OnlyAdmin", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.backFundsToClient(["client-1", 1n], {
        account: fx.clients.owner.account.address,
      }),
      ERRORS.OnlyAdmin,
    );
  });

  it("31: баланс клиента < amount → InsufficientClientBalanceForBackFunds", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 10n * 10n ** 18n);
    await expectRevertCustomError(
      backFunds(fx, "client-1", 20n * 10n ** 18n),
      ERRORS.InsufficientClientBalanceForBackFunds,
    );
  });

  it("32: баланс контракта < amount → InsufficientContractBalanceForBackFunds", async () => {
    const fx = await useFixture();
    const balance = 100n * 10n ** 18n;
    await topUp(fx, "client-1", balance);

    // Дрейним токены из прокси напрямую.
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
      backFunds(fx, "client-1", 80n * 10n ** 18n),
      ERRORS.InsufficientContractBalanceForBackFunds,
    );
  });

  it("33: частичный возврат сохраняет остаток на том же адресе", async () => {
    const fx = await useFixture();
    const balance = 100n * 10n ** 18n;
    const first = 30n * 10n ** 18n;

    await topUp(fx, "client-1", balance);
    await backFunds(fx, "client-1", first);

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(balance - first);
    expectAddress(
      bal.lastInboundAddress,
      fx.clients.user1.account.address,
    );
    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      balance - first,
    );
  });
});
