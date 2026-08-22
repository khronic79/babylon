import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

import {
  SettelmentsControlAbi,
  getFeeConfig,
  useFixture,
  type DeployFixture,
} from "../helpers/fixture";
import {
  ERRORS,
  expectAddress,
  expectEvent,
  expectRevertCustomError,
} from "../helpers/matchers";

function initArgs(fx: DeployFixture) {
  return [
    fx.token.address,
    fx.clients.admin.account.address,
    fx.clients.owner.account.address,
    fx.DEFAULT.feePercentage,
    fx.clients.feeCollector.account.address,
    fx.DEFAULT.maxValidity,
  ] as const;
}

async function deployProxyWith(
  overrides: {
    token?: `0x${string}`;
    admin?: `0x${string}`;
    owner?: `0x${string}`;
    feePercentage?: bigint;
    feeCollector?: `0x${string}`;
    maxValidity?: bigint;
  } = {},
) {
  const fx = await useFixture();
  const impl = await hre.viem.deployContract("SettelmentsControl", []);
  const args = [
    overrides.token ?? fx.token.address,
    overrides.admin ?? fx.clients.admin.account.address,
    overrides.owner ?? fx.clients.owner.account.address,
    overrides.feePercentage ?? fx.DEFAULT.feePercentage,
    overrides.feeCollector ?? fx.clients.feeCollector.account.address,
    overrides.maxValidity ?? fx.DEFAULT.maxValidity,
  ];
  const data = encodeFunctionData({
    abi: SettelmentsControlAbi,
    functionName: "initialize",
    args,
  });
  const proxy = await hre.viem.deployContract("SettelmentsControlProxy", [
    impl.address,
    data,
  ]);
  return { impl, proxy };
}

describe("SettelmentsControl: initialize", () => {
  it("1: initialize с валидными параметрами задаёт поля и эмитит события", async () => {
    const fx = await useFixture();
    const impl = await hre.viem.deployContract("SettelmentsControl", []);
    const proxy = await hre.viem.deployContract("SettelmentsControlProxy", [
      impl.address,
      "0x",
    ]);
    const control = await hre.viem.getContractAt(
      "SettelmentsControl",
      proxy.address,
    );

    const hash = await control.write.initialize(initArgs(fx), {
      account: fx.clients.owner.account.address,
    });

    expectAddress(
      await control.read.getAdmin(),
      fx.clients.admin.account.address,
    );
    expect(await control.read.getMaxValidity()).to.equal(fx.DEFAULT.maxValidity);

    const feeConfig = await getFeeConfig(control);
    expect(feeConfig[0]).to.equal(fx.DEFAULT.feePercentage);
    expectAddress(feeConfig[1], fx.clients.feeCollector.account.address);

    const changeAdmin = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "ChangeAdmin",
    );
    expectAddress(
      changeAdmin.newAdmin as string,
      fx.clients.admin.account.address,
    );

    const feeConfigSet = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "FeeConfigSet",
    );
    expect(feeConfigSet.feePercentage).to.equal(fx.DEFAULT.feePercentage);
  });

  it("2: feePercentage > 100 → FeeTooHigh", async () => {
    await expectRevertCustomError(
      deployProxyWith({ feePercentage: 101n }),
      ERRORS.FeeTooHigh,
    );
  });

  it("3: maxValidity == 0 → InvalidMaxValidity", async () => {
    await expectRevertCustomError(
      deployProxyWith({ maxValidity: 0n }),
      ERRORS.InvalidMaxValidity,
    );
  });

  it("4: _token == address(0) → ZeroAddress", async () => {
    await expectRevertCustomError(
      deployProxyWith({ token: zeroAddress }),
      ERRORS.ZeroAddress,
    );
  });

  it("5: _admin == address(0) → ZeroAddress", async () => {
    await expectRevertCustomError(
      deployProxyWith({ admin: zeroAddress }),
      ERRORS.ZeroAddress,
    );
  });

  it("6: _owner == address(0) → ZeroAddress", async () => {
    await expectRevertCustomError(
      deployProxyWith({ owner: zeroAddress }),
      ERRORS.ZeroAddress,
    );
  });

  it("7: _feeCollector == address(0) → ZeroAddress", async () => {
    await expectRevertCustomError(
      deployProxyWith({ feeCollector: zeroAddress }),
      ERRORS.ZeroAddress,
    );
  });

  it("8: повторный initialize → InvalidInitialization", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      fx.control.write.initialize(initArgs(fx), {
        account: fx.clients.owner.account.address,
      }),
      ERRORS.InvalidInitialization,
    );
  });

  it("9: атомарная инициализация через прокси", async () => {
    const fx = await useFixture();

    expectAddress(
      await fx.proxy.read.getProxyAdmin(),
      fx.clients.owner.account.address,
    );
    expectAddress(await fx.proxy.read.getImpl(), fx.implementation);

    expectAddress(
      await fx.control.read.getAdmin(),
      fx.clients.admin.account.address,
    );
    expect(await fx.control.read.getMaxValidity()).to.equal(
      fx.DEFAULT.maxValidity,
    );
    expect(await fx.control.read.getTotalClientBalance()).to.equal(0n);
  });
});
