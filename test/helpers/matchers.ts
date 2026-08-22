import { expect } from "chai";
import { parseEventLogs, type Abi, type PublicClient } from "viem";

// Селекторы custom errors — константы (сверены с research §3), а не выводятся из ABI.
export const ERRORS = {
  OnlyAdmin: "0x47556579",
  OnlyOwner: "0x5fc483c5",
  InvalidInitialization: "0xf92ee8a9",
  InvalidSignature: "0x8baa579f",
  NonceAlreadyUsed: "0x1fb09b80",
  EmptyNativeId: "0xd46b306d",
  EmptyNonce: "0xfa662e90",
  InvalidNativeAddress: "0xa86b1e53",
  SignatureExpired: "0x0819bdcd",
  DeadlineTooFar: "0x48f0fae6",
  FeeTooHigh: "0x7b931420",
  InvalidFeeCollector: "0xbb0bac99",
  InvalidMaxValidity: "0x9a93f8d6",
  InvalidAdmin: "0xb5eba9f0",
  ZeroAddress: "0xd92e233d",
  ZeroAmount: "0x1f2a2005",
  InsufficientStuckFunds: "0x68509843",
  WithdrawalFailed: "0x27fcd9d1",
  InsufficientClientBalanceForSessionSettelment: "0xae895493",
  NativeAddressIsOutForSessionSettelment: "0xc4df6dea",
  InsufficientContractBalanceForSessionSettelment: "0x7f5fdf44",
  InsufficientClientBalanceForBackFunds: "0x6f194512",
  InsufficientContractBalanceForBackFunds: "0x21483961",
  // мок (EIP-3009)
  PayeeMustBeCaller: "0x182dc57a",
  AuthorizationNotYetValid: "0xdf8e4372",
  AuthorizationExpired: "0x0f05f5bf",
  AuthorizationAlreadyUsed: "0x9508f1f2",
  InvalidAuthorizationSignature: "0x391e7a64",
  // прокси
  NotAcceptEtherDirectly: "0x1398a250",
} as const;

// Сравнение адресов регистронезависимо (viem возвращает checksummed-адреса).
export function expectAddress(actual: unknown, expected: string): void {
  expect(String(actual).toLowerCase()).to.equal(expected.toLowerCase());
}

function extractRevertData(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.data === "string" && e.data.startsWith("0x")) {
    return e.data;
  }
  if (e.cause) return extractRevertData(e.cause);
  if (e.error) return extractRevertData(e.error);
  return undefined;
}

// Ручная сверка первых 4 байт revert-data со селектором.
export async function expectRevertCustomError(
  promise: Promise<unknown>,
  selector: `0x${string}`,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const data = extractRevertData(err);
    if (data && data.slice(0, 10).toLowerCase() === selector.toLowerCase()) {
      return;
    }
    throw new Error(
      `ожидался revert ${selector}, получено ${data ?? String(err)}`,
    );
  }
  throw new Error("ожидался revert, но транзакция прошла");
}

// Чтение первого лога события из receipt (замена chai .to.emit(...).withArgs(...)).
export async function expectEvent(
  publicClient: PublicClient,
  txHash: `0x${string}`,
  abi: Abi,
  eventName: string,
): Promise<Record<string, unknown>> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const logs = parseEventLogs({ abi, logs: receipt.logs, eventName });
  if (logs.length === 0) {
    throw new Error(`событие ${eventName} не найдено`);
  }
  return logs[0].args as Record<string, unknown>;
}
