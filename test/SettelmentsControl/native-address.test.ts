import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex } from "viem";

import {
  SettelmentsControlAbi,
  useFixture,
  type DeployFixture,
} from "../helpers/fixture";
import {
  assignmentDomain,
  signNativeAddressAssignment,
} from "../helpers/eip712";
import { setNativeAddress } from "../helpers/actions";
import {
  ERRORS,
  expectAddress,
  expectEvent,
  expectRevertCustomError,
} from "../helpers/matchers";

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function setNativeRaw(
  fx: DeployFixture,
  args: [
    string,
    `0x${string}`,
    string,
    bigint,
    number,
    `0x${string}`,
    `0x${string}`,
  ],
  account = fx.clients.admin.account.address,
) {
  return fx.control.write.setNativeAddressWithSignature(args, { account });
}

describe("SettelmentsControl: setNativeAddressWithSignature", () => {
  it("34: валидная подпись записывает адрес и помечает nonce", async () => {
    const fx = await useFixture();
    const nonce = "nonce-34";

    const hash = await setNativeAddress(fx, "native-1", { nonce });

    expectAddress(
      await fx.control.read.getNativeAddress(["native-1"]),
      fx.clients.native.account.address,
    );
    expect(await fx.control.read.isNativeAddressSet(["native-1"])).to.equal(
      true,
    );
    expect(await fx.control.read.isNonceUsed([nonce])).to.equal(true);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      SettelmentsControlAbi,
      "NativeAddressSet",
    );
    // indexed string → в теме лежит keccak256 исходной строки
    expect(ev.nativeId).to.equal(keccak256(toHex("native-1")));
    expectAddress(
      ev.nativeAddress as string,
      fx.clients.native.account.address,
    );
  });

  it("35: вызов не от admin → OnlyAdmin", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      setNativeRaw(
        fx,
        [
          "native-1",
          fx.clients.native.account.address,
          "nonce-35",
          now + 3600n,
          27,
          `0x${"11".repeat(32)}`,
          `0x${"22".repeat(32)}`,
        ],
        fx.clients.owner.account.address,
      ),
      ERRORS.OnlyAdmin,
    );
  });

  it("36: пустой nativeId → EmptyNativeId", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      setNativeRaw(fx, [
        "",
        fx.clients.native.account.address,
        "nonce-36",
        now + 3600n,
        27,
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
      ]),
      ERRORS.EmptyNativeId,
    );
  });

  it("37: nativeAddress == address(0) → InvalidNativeAddress", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      setNativeRaw(fx, [
        "native-1",
        "0x0000000000000000000000000000000000000000",
        "nonce-37",
        now + 3600n,
        27,
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
      ]),
      ERRORS.InvalidNativeAddress,
    );
  });

  it("38: пустой nonce → EmptyNonce", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      setNativeRaw(fx, [
        "native-1",
        fx.clients.native.account.address,
        "",
        now + 3600n,
        27,
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
      ]),
      ERRORS.EmptyNonce,
    );
  });

  it("39: повторный nonce → NonceAlreadyUsed", async () => {
    const fx = await useFixture();
    const nonce = "nonce-39";
    await setNativeAddress(fx, "native-1", { nonce });
    await expectRevertCustomError(
      setNativeAddress(fx, "native-1", { nonce }),
      ERRORS.NonceAlreadyUsed,
    );
  });

  it("40: deadline в прошлом → SignatureExpired", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      setNativeAddress(fx, "native-1", { deadline: now - 100n }),
      ERRORS.SignatureExpired,
    );
  });

  it("41: deadline − now > maxValidity → DeadlineTooFar", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      setNativeAddress(fx, "native-1", {
        deadline: now + fx.DEFAULT.maxValidity + 100n,
      }),
      ERRORS.DeadlineTooFar,
    );
  });

  it("42: подпись от чужого ключа → InvalidSignature", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      setNativeAddress(fx, "native-1", { signer: fx.signers.user2 }),
      ERRORS.InvalidSignature,
    );
  });

  it("43: high-s подпись → InvalidSignature", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    const nonce = "nonce-43";
    const nativeAddress = fx.clients.native.account.address;
    const deadline = now + 3600n;

    const domain = assignmentDomain(fx.proxy.address, fx.chainId);
    const { v, r, s } = await signNativeAddressAssignment(
      fx.signers.native,
      domain,
      { nativeId: "native-1", nativeAddress, nonce, deadline },
    );

    const sHigh = toHex(SECP256K1_N - BigInt(s));

    await expectRevertCustomError(
      setNativeRaw(fx, [
        "native-1",
        nativeAddress,
        nonce,
        deadline,
        v,
        r,
        sHigh,
      ]),
      ERRORS.InvalidSignature,
    );
  });

  it("44: невалидная подпись не сжигает nonce", async () => {
    const fx = await useFixture();
    const nonce = "nonce-44";

    await expectRevertCustomError(
      setNativeAddress(fx, "native-1", {
        nonce,
        signer: fx.signers.user2,
      }),
      ERRORS.InvalidSignature,
    );

    expect(await fx.control.read.isNonceUsed([nonce])).to.equal(false);

    await setNativeAddress(fx, "native-1", { nonce });

    expect(await fx.control.read.isNonceUsed([nonce])).to.equal(true);
  });
});
