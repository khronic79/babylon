import {
  hexToSignature,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { HDAccount } from "viem/accounts";

export interface ReceiveWithAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex; // bytes32
}

export const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Домен мока: name = имя токена (параметр конструктора), version = "2".
export function mockDomain(
  tokenName: string,
  verifyingContract: Address,
  chainId: number,
): TypedDataDomain {
  return { name: tokenName, version: "2", chainId, verifyingContract };
}

export interface ReceiveSignature {
  v: number;
  r: Hex;
  s: Hex;
  signature: Hex;
}

export async function signReceiveWithAuthorization(
  signer: HDAccount,
  domain: TypedDataDomain,
  message: ReceiveWithAuthorization,
): Promise<ReceiveSignature> {
  const signature = await signer.signTypedData({
    domain,
    types: RECEIVE_WITH_AUTH_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message,
  });
  const { r, s, v } = hexToSignature(signature);
  return { v: Number(v), r, s, signature };
}
