import { time } from "@nomicfoundation/hardhat-network-helpers";

import { TOKEN_NAME, randomBytes32, type DeployFixture } from "./fixture";
import {
  mockDomain,
  signReceiveWithAuthorization,
} from "./eip3009";
import {
  assignmentDomain,
  signNativeAddressAssignment,
} from "./eip712";

export interface TopUpOpts {
  from?: `0x${string}`;
  signer?: DeployFixture["signers"]["user1"];
  nonce?: `0x${string}`;
  validAfter?: bigint;
  validBefore?: bigint;
}

// Ретрансляция EIP-3009 authorization от имени admin.
export async function topUp(
  fx: DeployFixture,
  userId: string,
  value: bigint,
  opts: TopUpOpts = {},
): Promise<`0x${string}`> {
  const now = BigInt(await time.latest());
  const from = opts.from ?? fx.clients.user1.account.address;
  const nonce = opts.nonce ?? randomBytes32();
  const validAfter = opts.validAfter ?? now - 1n;
  const validBefore = opts.validBefore ?? now + 3600n;
  const signer = opts.signer ?? fx.signers.user1;

  const domain = mockDomain(TOKEN_NAME, fx.token.address, fx.chainId);
  const { v, r, s } = await signReceiveWithAuthorization(signer, domain, {
    from,
    to: fx.proxy.address,
    value,
    validAfter,
    validBefore,
    nonce,
  });

  return fx.control.write.topUpClientBalance(
    [userId, from, value, validAfter, validBefore, nonce, v, r, s],
    { account: fx.clients.admin.account.address },
  );
}

export interface SetNativeOpts {
  nativeAddress?: `0x${string}`;
  signer?: DeployFixture["signers"]["native"];
  nonce?: string;
  deadline?: bigint;
}

// Привязка native-адреса через EIP-712 подпись (вызов от admin).
export async function setNativeAddress(
  fx: DeployFixture,
  nativeId: string,
  opts: SetNativeOpts = {},
): Promise<`0x${string}`> {
  const now = BigInt(await time.latest());
  const nativeAddress =
    opts.nativeAddress ?? fx.clients.native.account.address;
  const nonce = opts.nonce ?? `nonce-${randomBytes32()}`;
  const deadline = opts.deadline ?? now + 3600n;
  const signer = opts.signer ?? fx.signers.native;

  const domain = assignmentDomain(fx.proxy.address, fx.chainId);
  const { v, r, s } = await signNativeAddressAssignment(signer, domain, {
    nativeId,
    nativeAddress,
    nonce,
    deadline,
  });

  return fx.control.write.setNativeAddressWithSignature(
    [nativeId, nativeAddress, nonce, deadline, v, r, s],
    { account: fx.clients.admin.account.address },
  );
}
