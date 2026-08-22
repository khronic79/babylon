import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { zeroAddress } from "viem";

import {
  SettelmentsControlAbi,
  getClientBalance,
  getFeeConfig,
  useFixture,
} from "../helpers/fixture";
import { setNativeAddress, topUp } from "../helpers/actions";
import {
  ERRORS,
  expectAddress,
  expectEvent,
  expectRevertCustomError,
} from "../helpers/matchers";

describe("SettelmentsControl: роли и управление", () => {
  it("45: topUpClientBalance от owner → OnlyAdmin", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      fx.control.write.topUpClientBalance(
        [
          "client-1",
          fx.clients.user1.account.address,
          1n,
          now - 1n,
          now + 3600n,
          `0x${"11".repeat(32)}`,
          27,
          `0x${"22".repeat(32)}`,
          `0x${"33".repeat(32)}`,
        ],
        { account: fx.clients.owner.account.address },
      ),
      ERRORS.OnlyAdmin,
    );
  });

  it("46: paymentClientToNative от owner → OnlyAdmin", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.paymentClientToNative(
        ["client-1", "native-1", 1n, "s", 1n, 1n],
        { account: fx.clients.owner.account.address },
      ),
      ERRORS.OnlyAdmin,
    );
  });

  it("47: backFundsToClient от owner → OnlyAdmin", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.backFundsToClient(["client-1", 1n], {
        account: fx.clients.owner.account.address,
      }),
      ERRORS.OnlyAdmin,
    );
  });

  it("48: setNativeAddressWithSignature от owner → OnlyAdmin", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      fx.control.write.setNativeAddressWithSignature(
        [
          "native-1",
          fx.clients.native.account.address,
          "nonce-48",
          now + 3600n,
          27,
          `0x${"11".repeat(32)}`,
          `0x${"22".repeat(32)}`,
        ],
        { account: fx.clients.owner.account.address },
      ),
      ERRORS.OnlyAdmin,
    );
  });

  it("49: changeAdmin от admin → OnlyOwner", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.changeAdmin([fx.clients.user1.account.address], {
        account: fx.clients.admin.account.address,
      }),
      ERRORS.OnlyOwner,
    );
  });

  it("50: setMaxValidity от admin → OnlyOwner", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.setMaxValidity([1234n], {
        account: fx.clients.admin.account.address,
      }),
      ERRORS.OnlyOwner,
    );
  });

  it("51: setFeeConfig от admin → OnlyOwner", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.setFeeConfig(
        [1n, fx.clients.feeCollector.account.address],
        { account: fx.clients.admin.account.address },
      ),
      ERRORS.OnlyOwner,
    );
  });

  it("52: withdrawStuckTokens от admin → OnlyOwner", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.withdrawStuckTokens(
        [fx.token.address, fx.clients.user1.account.address, 1n],
        { account: fx.clients.admin.account.address },
      ),
      ERRORS.OnlyOwner,
    );
  });

  it("53: withdrawStuckNative от admin → OnlyOwner", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.withdrawStuckNative(
        [fx.clients.user1.account.address, 1n],
        { account: fx.clients.admin.account.address },
      ),
      ERRORS.OnlyOwner,
    );
  });

  it("54: changeAdmin валидный меняет админа", async () => {
    const fx = await useFixture();
    const newAdmin = fx.clients.user1.account.address;

    const hash = await fx.control.write.changeAdmin([newAdmin], {
      account: fx.clients.owner.account.address,
    });

    expectAddress(await fx.control.read.getAdmin(), newAdmin);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "ChangeAdmin",
    );
    expectAddress(ev.newAdmin as string, newAdmin);
  });

  it("55: changeAdmin(address(0)) → InvalidAdmin", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.changeAdmin([zeroAddress], {
        account: fx.clients.owner.account.address,
      }),
      ERRORS.InvalidAdmin,
    );
  });

  it("56: setMaxValidity валидный обновляет значение", async () => {
    const fx = await useFixture();
    const hash = await fx.control.write.setMaxValidity([12345n], {
      account: fx.clients.owner.account.address,
    });

    expect(await fx.control.read.getMaxValidity()).to.equal(12345n);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "MaxValiditySet",
    );
    expect(ev.maxValidity).to.equal(12345n);
  });

  it("57: setMaxValidity(0) → InvalidMaxValidity", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.setMaxValidity([0n], {
        account: fx.clients.owner.account.address,
      }),
      ERRORS.InvalidMaxValidity,
    );
  });

  it("58: setFeeConfig валидный обновляет оба поля", async () => {
    const fx = await useFixture();
    const hash = await fx.control.write.setFeeConfig(
      [42n, fx.clients.user1.account.address],
      { account: fx.clients.owner.account.address },
    );

    const cfg = await getFeeConfig(fx.control);
    expect(cfg[0]).to.equal(42n);
    expectAddress(cfg[1], fx.clients.user1.account.address);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "FeeConfigSet",
    );
    expect(ev.feePercentage).to.equal(42n);
  });

  it("59: setFeeConfig с feePercentage > 100 → FeeTooHigh", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.setFeeConfig(
        [101n, fx.clients.feeCollector.account.address],
        { account: fx.clients.owner.account.address },
      ),
      ERRORS.FeeTooHigh,
    );
  });

  it("60: setFeeConfig с feeCollector == 0 → InvalidFeeCollector", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.setFeeConfig([1n, zeroAddress], {
        account: fx.clients.owner.account.address,
      }),
      ERRORS.InvalidFeeCollector,
    );
  });

  it("61: все геттеры возвращают актуальные значения", async () => {
    const fx = await useFixture();

    expectAddress(
      await fx.control.read.getAdmin(),
      fx.clients.admin.account.address,
    );
    expect(await fx.control.read.getMaxValidity()).to.equal(
      fx.DEFAULT.maxValidity,
    );

    const cfg = await getFeeConfig(fx.control);
    expect(cfg[0]).to.equal(fx.DEFAULT.feePercentage);
    expectAddress(cfg[1], fx.clients.feeCollector.account.address);

    expect(await fx.control.read.getTotalClientBalance()).to.equal(0n);
    expect(await fx.control.read.isNonceUsed(["nonce-61"])).to.equal(false);

    await topUp(fx, "client-1", 100n * 10n ** 18n);
    await setNativeAddress(fx, "native-1", { nonce: "nonce-61" });

    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      100n * 10n ** 18n,
    );
    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(100n * 10n ** 18n);
    expectAddress(
      bal.lastInboundAddress,
      fx.clients.user1.account.address,
    );

    expectAddress(
      await fx.control.read.getNativeAddress(["native-1"]),
      fx.clients.native.account.address,
    );
    expect(await fx.control.read.isNativeAddressSet(["native-1"])).to.equal(
      true,
    );
    expect(await fx.control.read.isNativeAddressSet(["nope"])).to.equal(false);
    expect(await fx.control.read.isNonceUsed(["nonce-61"])).to.equal(true);
  });
});
