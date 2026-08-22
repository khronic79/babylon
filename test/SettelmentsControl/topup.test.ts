import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  SettelmentsControlAbi,
  getClientBalance,
  randomBytes32,
  useFixture,
} from "../helpers/fixture";
import { topUp } from "../helpers/actions";
import {
  ERRORS,
  expectAddress,
  expectEvent,
  expectRevertCustomError,
} from "../helpers/matchers";

describe("SettelmentsControl: topUpClientBalance", () => {
  it("10: ретрансляция EIP-3009 authorization от user1", async () => {
    const fx = await useFixture();
    const value = 1000n * 10n ** 18n;

    const hash = await topUp(fx, "client-1", value);

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(value);
    expectAddress(bal.lastInboundAddress, fx.clients.user1.account.address);

    expect(await fx.control.read.getTotalClientBalance()).to.equal(value);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "TopUpClientBalance",
    );
    expect(ev.userId).to.equal("client-1");
    expect(ev.amount).to.equal(value);
    expect(ev.currentClientBalance).to.equal(value);
  });

  it("11: несколько топ-апов накапливают баланс и тотал", async () => {
    const fx = await useFixture();
    const a = 100n * 10n ** 18n;
    const b = 250n * 10n ** 18n;

    await topUp(fx, "client-1", a);
    await topUp(fx, "client-1", b);

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(a + b);
    expect(await fx.control.read.getTotalClientBalance()).to.equal(a + b);
  });

  it("12: вызов не от admin → OnlyAdmin", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    const value = 1n * 10n ** 18n;

    await expectRevertCustomError(
      fx.control.write.topUpClientBalance(
        [
          "client-1",
          fx.clients.user1.account.address,
          value,
          now - 1n,
          now + 3600n,
          randomBytes32(),
          27,
          `0x${"11".repeat(32)}`,
          `0x${"22".repeat(32)}`,
        ],
        { account: fx.clients.owner.account.address },
      ),
      ERRORS.OnlyAdmin,
    );
  });

  it("13: authorization с неверной подписью → InvalidAuthorizationSignature", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      topUp(fx, "client-1", 1n * 10n ** 18n, { signer: fx.signers.user2 }),
      ERRORS.InvalidAuthorizationSignature,
    );
  });

  it("14: просроченная authorization → AuthorizationExpired", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      topUp(fx, "client-1", 1n * 10n ** 18n, {
        validAfter: now - 2n,
        validBefore: now - 1n,
      }),
      ERRORS.AuthorizationExpired,
    );
  });

  it("15: authorization ещё не валидна → AuthorizationNotYetValid", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      topUp(fx, "client-1", 1n * 10n ** 18n, {
        validAfter: now + 100n,
        validBefore: now + 200n,
      }),
      ERRORS.AuthorizationNotYetValid,
    );
  });

  it("16: повторный nonce → AuthorizationAlreadyUsed", async () => {
    const fx = await useFixture();
    const nonce = randomBytes32();
    await topUp(fx, "client-1", 1n * 10n ** 18n, { nonce });
    await expectRevertCustomError(
      topUp(fx, "client-1", 1n * 10n ** 18n, { nonce }),
      ERRORS.AuthorizationAlreadyUsed,
    );
  });

  it("17: после топ-апа balanceOf(контракт) == totalClientBalance", async () => {
    const fx = await useFixture();
    await topUp(fx, "client-1", 100n * 10n ** 18n);
    await topUp(fx, "client-2", 250n * 10n ** 18n);

    const total = await fx.control.read.getTotalClientBalance();
    const contractBalance = await fx.token.read.balanceOf([fx.proxy.address]);

    expect(contractBalance).to.equal(total);
  });
});
