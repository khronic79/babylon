import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  TOKEN_NAME,
  randomBytes32,
  useFixture,
  type DeployFixture,
} from "./helpers/fixture";
import {
  mockDomain,
  signReceiveWithAuthorization,
} from "./helpers/eip3009";
import {
  ERRORS,
  expectEvent,
  expectRevertCustomError,
} from "./helpers/matchers";

import ERC20MockArtifact from "../artifacts/contracts/mock/ERC20Mock.sol/ERC20Mock.json";
import type { Abi } from "viem";

const MOCK_ABI = ERC20MockArtifact.abi as unknown as Abi;

interface AuthResult {
  hash: `0x${string}`;
  nonce: `0x${string}`;
}

async function receiveAuth(
  fx: DeployFixture,
  value: bigint,
  opts: {
    from?: `0x${string}`;
    to?: `0x${string}`;
    signer?: DeployFixture["signers"]["user1"];
    nonce?: `0x${string}`;
    validAfter?: bigint;
    validBefore?: bigint;
  } = {},
): Promise<AuthResult> {
  const now = BigInt(await time.latest());
  const from = opts.from ?? fx.clients.user1.account.address;
  const to = opts.to ?? fx.clients.owner.account.address;
  const nonce = opts.nonce ?? randomBytes32();
  const validAfter = opts.validAfter ?? now - 1n;
  const validBefore = opts.validBefore ?? now + 3600n;
  const signer = opts.signer ?? fx.signers.user1;

  const domain = mockDomain(TOKEN_NAME, fx.token.address, fx.chainId);
  const { v, r, s } = await signReceiveWithAuthorization(signer, domain, {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  });

  const hash = await fx.token.write.receiveWithAuthorization(
    [from, to, value, validAfter, validBefore, nonce, v, r, s],
    { account: fx.clients.owner.account.address },
  );
  return { hash, nonce };
}

describe("ERC20Mock (EIP-3009)", () => {
  it("81: version() == '2'", async () => {
    const fx = await useFixture();
    expect(await fx.token.read.version()).to.equal("2");
  });

  it("82: authorizationState false до, true после", async () => {
    const fx = await useFixture();
    const nonce = randomBytes32();

    expect(
      await fx.token.read.authorizationState([
        fx.clients.user1.account.address,
        nonce,
      ]),
    ).to.equal(false);

    await receiveAuth(fx, 1n * 10n ** 18n, { nonce });

    expect(
      await fx.token.read.authorizationState([
        fx.clients.user1.account.address,
        nonce,
      ]),
    ).to.equal(true);
  });

  it("83: receiveWithAuthorization успешно переводит и помечает nonce", async () => {
    const fx = await useFixture();
    const value = 100n * 10n ** 18n;

    const fromBefore = (await fx.token.read.balanceOf([
      fx.clients.user1.account.address,
    ])) as bigint;
    const toBefore = (await fx.token.read.balanceOf([
      fx.clients.owner.account.address,
    ])) as bigint;

    const { hash, nonce } = await receiveAuth(fx, value);

    expect(
      (await fx.token.read.balanceOf([
        fx.clients.user1.account.address,
      ])) as bigint,
    ).to.equal(fromBefore - value);
    expect(
      (await fx.token.read.balanceOf([
        fx.clients.owner.account.address,
      ])) as bigint,
    ).to.equal(toBefore + value);

    const ev = await expectEvent(
      fx.publicClient,
      hash,
      MOCK_ABI,
      "AuthorizationUsed",
    );
    // indexed authorizer/nonce — в темах лежат адрес и bytes32
    expect(
      (ev.authorizer as string).toLowerCase(),
    ).to.equal(fx.clients.user1.account.address.toLowerCase());
    expect(ev.nonce).to.equal(nonce);
  });

  it("84: to != msg.sender → PayeeMustBeCaller", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      receiveAuth(fx, 1n * 10n ** 18n, {
        to: fx.clients.user2.account.address,
      }),
      ERRORS.PayeeMustBeCaller,
    );
  });

  it("85: validAfter в будущем → AuthorizationNotYetValid", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      receiveAuth(fx, 1n * 10n ** 18n, {
        validAfter: now + 100n,
        validBefore: now + 200n,
      }),
      ERRORS.AuthorizationNotYetValid,
    );
  });

  it("86: validBefore в прошлом → AuthorizationExpired", async () => {
    const fx = await useFixture();
    const now = BigInt(await time.latest());
    await expectRevertCustomError(
      receiveAuth(fx, 1n * 10n ** 18n, {
        validAfter: now - 2n,
        validBefore: now - 1n,
      }),
      ERRORS.AuthorizationExpired,
    );
  });

  it("87: повторный nonce → AuthorizationAlreadyUsed", async () => {
    const fx = await useFixture();
    const nonce = randomBytes32();
    await receiveAuth(fx, 1n * 10n ** 18n, { nonce });
    await expectRevertCustomError(
      receiveAuth(fx, 1n * 10n ** 18n, { nonce }),
      ERRORS.AuthorizationAlreadyUsed,
    );
  });

  it("88: неверная подпись → InvalidAuthorizationSignature", async () => {
    const fx = await useFixture();
    await expectRevertCustomError(
      receiveAuth(fx, 1n * 10n ** 18n, { signer: fx.signers.user2 }),
      ERRORS.InvalidAuthorizationSignature,
    );
  });
});
