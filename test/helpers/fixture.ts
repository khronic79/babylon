import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { randomBytes } from "node:crypto";
import hre from "hardhat";
import {
  encodeFunctionData,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type GetContractReturnType,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

import SettelmentsControlArtifact from "../../artifacts/contracts/SettelmentsControl.sol/SettelmentsControl.json";
import SettelmentsControlProxyArtifact from "../../artifacts/contracts/SettelmentsControlProxy.sol/SettelmentsControlProxy.json";

export const SettelmentsControlAbi = SettelmentsControlArtifact.abi as unknown as Abi;
export const SettelmentsControlProxyAbi =
  SettelmentsControlProxyArtifact.abi as unknown as Abi;

// Мнемоника встроенной сети Hardhat: первые 20 аккаунтов детерминированы.
// Подписи EIP-712/EIP-3009 требуют приватные ключи, поэтому аккаунты для подписи
// выводятся из той же мнемоники (wallet-клиенты содержат только адрес, без ключа).
const HARDHAT_MNEMONIC =
  "test test test test test test test test test test test junk";

export const ROLES = {
  owner: 0, // деплойер (инициализатор через прокси)
  admin: 1,
  feeCollector: 2,
  user1: 3,
  user2: 4,
  native: 5,
} as const;

// Имя токена-мока — единственный источник для домена EIP-3009 (mockDomain).
export const TOKEN_NAME = "BabylonTest";

export function signerAt(index: number): HDAccount {
  return mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: index });
}

export function randomBytes32(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export interface ClientBalance {
  balance: bigint;
  lastInboundAddress: Address;
}

export async function getClientBalance(
  control: Contract,
  userId: string,
): Promise<ClientBalance> {
  return (await control.read.getBalance([userId])) as ClientBalance;
}

export async function getFeeConfig(
  control: Contract,
): Promise<[bigint, Address]> {
  return (await control.read.getFeeConfig()) as [bigint, Address];
}

type BoundWalletClient = WalletClient<Transport, Chain, Account>;
type BoundClient = { public: PublicClient; wallet: BoundWalletClient };
export type Contract = GetContractReturnType<Abi, BoundClient, Address>;

export interface DeployFixture {
  publicClient: PublicClient;
  chainId: number;
  clients: {
    owner: BoundWalletClient;
    admin: BoundWalletClient;
    feeCollector: BoundWalletClient;
    user1: BoundWalletClient;
    user2: BoundWalletClient;
    native: BoundWalletClient;
  };
  signers: {
    owner: HDAccount;
    admin: HDAccount;
    feeCollector: HDAccount;
    user1: HDAccount;
    user2: HDAccount;
    native: HDAccount;
  };
  token: Contract; // ERC20Mock
  implementation: Address; // SettelmentsControl impl
  proxy: Contract; // ABI прокси, address = прокси
  control: Contract; // ABI реализации, address = прокси (delegatecall)
  DEFAULT: { feePercentage: bigint; maxValidity: bigint };
}

export async function deployFixture(): Promise<DeployFixture> {
  const publicClient = await hre.viem.getPublicClient();
  const walletClients = await hre.viem.getWalletClients();

  const clients = {
    owner: walletClients[ROLES.owner],
    admin: walletClients[ROLES.admin],
    feeCollector: walletClients[ROLES.feeCollector],
    user1: walletClients[ROLES.user1],
    user2: walletClients[ROLES.user2],
    native: walletClients[ROLES.native],
  };

  const signers = {
    owner: signerAt(ROLES.owner),
    admin: signerAt(ROLES.admin),
    feeCollector: signerAt(ROLES.feeCollector),
    user1: signerAt(ROLES.user1),
    user2: signerAt(ROLES.user2),
    native: signerAt(ROLES.native),
  };

  const DEFAULT = {
    feePercentage: 10n,
    maxValidity: 86400n, // 1 сутки
  };

  const initialSupply = 1_000_000n * 10n ** 18n;
  const reserve = 1_000_000n * 10n ** 18n;

  const token = await hre.viem.deployContract("ERC20Mock", [
    TOKEN_NAME,
    "BT",
    clients.owner.account.address,
    initialSupply,
  ]);

  // Запас для топ-апов и расчётов.
  await token.write.mint([clients.user1.account.address, reserve]);
  await token.write.mint([clients.user2.account.address, reserve]);
  await token.write.mint([clients.native.account.address, reserve]);

  const implementation = await hre.viem.deployContract(
    "SettelmentsControl",
    [],
  );

  const data = encodeFunctionData({
    abi: SettelmentsControlAbi,
    functionName: "initialize",
    args: [
      token.address,
      clients.admin.account.address,
      clients.owner.account.address,
      DEFAULT.feePercentage,
      clients.feeCollector.account.address,
      DEFAULT.maxValidity,
    ],
  });

  // Атомарная инициализация через прокси вторым аргументом конструктора.
  const proxy = await hre.viem.deployContract("SettelmentsControlProxy", [
    implementation.address,
    data,
  ]);

  const control = await hre.viem.getContractAt(
    "SettelmentsControl",
    proxy.address,
  );

  return {
    publicClient,
    chainId: publicClient.chain?.id ?? 31337,
    clients,
    signers,
    token,
    implementation: implementation.address,
    proxy,
    control,
    DEFAULT,
  };
}

// Единственная точка входа для тестов: loadFixture поверх evm_snapshot/evm_revert.
export const useFixture = () => loadFixture(deployFixture);
