import {
  hexToSignature,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { HDAccount } from "viem/accounts";

export interface NativeAddressAssignment {
  nativeId: string;
  nativeAddress: Address;
  nonce: string;
  deadline: bigint;
}

export const ASSIGNMENT_TYPES = {
  NativeAddressAssignment: [
    { name: "nativeId", type: "string" },
    { name: "nativeAddress", type: "address" },
    { name: "nonce", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Домен: name="SettelmentsControl", version="1.0" (__EIP712_init).
// verifyingContract — адрес ПРОКСИ (не реализации): _hashTypedDataV4 использует
// address(this), который при delegatecall равен прокси.
export function assignmentDomain(
  verifyingContract: Address,
  chainId: number,
): TypedDataDomain {
  return {
    name: "SettelmentsControl",
    version: "1.0",
    chainId,
    verifyingContract,
  };
}

export interface AssignmentSignature {
  v: number;
  r: Hex;
  s: Hex;
  signature: Hex;
}

export async function signNativeAddressAssignment(
  signer: HDAccount,
  domain: TypedDataDomain,
  message: NativeAddressAssignment,
): Promise<AssignmentSignature> {
  const signature = await signer.signTypedData({
    domain,
    types: ASSIGNMENT_TYPES,
    primaryType: "NativeAddressAssignment",
    message,
  });
  const { r, s, v } = hexToSignature(signature);
  return { v: Number(v), r, s, signature };
}
