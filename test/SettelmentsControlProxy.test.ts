import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

import {
  getClientBalance,
  randomBytes32,
  useFixture,
  type DeployFixture,
} from "./helpers/fixture";
import { setNativeAddress, topUp } from "./helpers/actions";
import {
  ERRORS,
  expectAddress,
  expectRevertCustomError,
} from "./helpers/matchers";

async function balanceOf(fx: DeployFixture, addr: string): Promise<bigint> {
  return (await fx.token.read.balanceOf([addr])) as bigint;
}

describe("SettelmentsControlProxy", () => {
  it("73: getProxyAdmin() == деплойер", async () => {
    const fx = await useFixture();
    expectAddress(
      await fx.proxy.read.getProxyAdmin(),
      fx.clients.owner.account.address,
    );
  });

  it("74: changeProxyAdmin валидный меняет админа прокси", async () => {
    const fx = await useFixture();
    const newAdmin = fx.clients.user1.account.address;

    await fx.proxy.write.changeProxyAdmin([newAdmin], {
      account: fx.clients.owner.account.address,
    });

    expectAddress(await fx.proxy.read.getProxyAdmin(), newAdmin);
  });

  it("75: changeProxyAdmin не от админа → OnlyAdmin", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.proxy.write.changeProxyAdmin([fx.clients.user1.account.address], {
        account: fx.clients.admin.account.address,
      }),
      ERRORS.OnlyAdmin,
    );
  });

  it("76: getImpl() возвращает имплементацию", async () => {
    const fx = await useFixture();
    expectAddress(await fx.proxy.read.getImpl(), fx.implementation);
  });

  it("77: setImpl от админа меняет имплементацию", async () => {
    const fx = await useFixture();
    const newImpl = await hre.viem.deployContract("SettelmentsControl", []);

    await fx.proxy.write.setImpl([newImpl.address], {
      account: fx.clients.owner.account.address,
    });

    expectAddress(await fx.proxy.read.getImpl(), newImpl.address);
  });

  it("78: setImpl не от админа → OnlyAdmin", async () => {
    const fx = await useFixture();
    const newImpl = await hre.viem.deployContract("SettelmentsControl", []);
    await expectRevertCustomError(
      fx.proxy.write.setImpl([newImpl.address], {
        account: fx.clients.admin.account.address,
      }),
      ERRORS.OnlyAdmin,
    );
  });

  it("79: отправка ETH на прокси → NotAcceptEtherDirectly", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.clients.user1.sendTransaction({
        to: fx.proxy.address,
        value: 1n * 10n ** 18n,
      }),
      ERRORS.NotAcceptEtherDirectly,
    );
  });

  it("80: сквозной сценарий через прокси: топ-ап → расчёт → возврат", async () => {
    const fx = await useFixture();
    const initial = 100n * 10n ** 18n;
    const payment = 30n * 10n ** 18n;
    const refund = 20n * 10n ** 18n;

    await topUp(fx, "client-1", initial);
    await setNativeAddress(fx, "native-1");

    const nativeBefore = await balanceOf(fx, fx.clients.native.account.address);

    await fx.control.write.paymentClientToNative(
      [
        randomBytes32(),
        "client-1",
        "native-1",
        payment,
        "session-1",
        BigInt(await time.latest()),
        30n,
      ],
      { account: fx.clients.admin.account.address },
    );

    // 30 * 10% = 3 fee, 27 to native.
    expect(await balanceOf(fx, fx.clients.native.account.address)).to.equal(
      nativeBefore + 27n * 10n ** 18n,
    );

    await fx.control.write.backFundsToClient(
      [randomBytes32(), "client-1", refund],
      {
        account: fx.clients.admin.account.address,
      },
    );

    const bal = await getClientBalance(fx.control, "client-1");
    expect(bal.balance).to.equal(initial - payment - refund);
    expect(await fx.control.read.getTotalClientBalance()).to.equal(
      initial - payment - refund,
    );
  });
});
