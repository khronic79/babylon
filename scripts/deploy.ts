import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import { run } from 'hardhat';
import dotenv from 'dotenv';
import ERC20Mock from '../artifacts/contracts/mock/ERC20Mock.sol/ERC20Mock.json';
import SettelmentsControl from '../artifacts/contracts/SettelmentsControl.sol/SettelmentsControl.json';
import SettelmentsControlProxy from '../artifacts/contracts/SettelmentsControlProxy.sol/SettelmentsControlProxy.json';

dotenv.config();

const RPC_URL = process.env.NETWORK_URL;
const privateKey = `0x${process.env.PRIVATE_KEY}` as `0x${string}`;

const account = privateKeyToAccount(privateKey);

const walletClient = createWalletClient({
  chain: polygonAmoy,
  account,
  transport: http(RPC_URL),
});

const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(RPC_URL),
});

async function deployContracts() {
  console.log('Starting deployment...');
  
  // 2. Deploy ERC20Mock
  console.log('Deploying ERC20Mock...');
  const erc20Hash = await walletClient.deployContract({
    abi: ERC20Mock.abi,
    bytecode: ERC20Mock.bytecode as `0x${string}`,
    args: ['BabylonTest', 'BT', account.address, 1000n * 10n**18n], // Mint 1000 tokens to deployer
  });
  
  const erc20Receipt = await publicClient
    .waitForTransactionReceipt({ 
      hash: erc20Hash,
      confirmations: 5,
    });

  const erc20Address = erc20Receipt.contractAddress;
  if (!erc20Address) throw new Error('ERC20 deployment failed');
  console.log(`ERC20Mock deployed at: ${erc20Address}`);

  // Verify ERC20Mock
  console.log('Verifying ERC20Mock (30 sec awaiting)...');
  await new Promise(resolve => setTimeout(resolve, 30000));
  await run('verify:verify', {
    address: erc20Address,
    constructorArguments: ['BabylonTest', 'BT', account.address, 1000n * 10n**18n],
  });

  // 3. Deploy SettelmentsControl implementation
  console.log('Deploying SettelmentsControl implementation...');
  const implHash = await walletClient.deployContract({
    abi: SettelmentsControl.abi,
    bytecode: SettelmentsControl.bytecode as `0x${string}`,
    args: [],
  });
  
  const implReceipt = await publicClient
    .waitForTransactionReceipt({
      hash: implHash,
      confirmations: 5,
      timeout: 60000,
    });
  const implAddress = implReceipt.contractAddress;
  if (!implAddress) throw new Error('Implementation deployment failed');
  console.log(`SettelmentsControl implementation deployed at: ${implAddress}`);

  // Verify implementation
  console.log('Verifying SettelmentsControl implementation (30 sec awaiting)...');
  await new Promise(resolve => setTimeout(resolve, 30000));
  await run('verify:verify', {
    address: implAddress,
    constructorArguments: [],
  });

  // 4. Deploy Proxy
  console.log('Deploying SettelmentsControlProxy...')
  const proxyHash = await walletClient.deployContract({
    abi: SettelmentsControlProxy.abi,
    bytecode: SettelmentsControlProxy.bytecode as `0x${string}`,
    args: [implAddress],
  });
  
  const proxyReceipt = await publicClient
    .waitForTransactionReceipt({
      hash: proxyHash,
      confirmations: 5,
      timeout: 60000,
    });
  const proxyAddress = proxyReceipt.contractAddress;
  if (!proxyAddress) throw new Error('Proxy deployment failed');
  console.log(`Proxy deployed at: ${proxyAddress}`);

  // Verify Proxy (optional, if needed)
  console.log('Verifying Proxy (30 sec awaiting)...');
  await new Promise(resolve => setTimeout(resolve, 30000));
  await run('verify:verify', {
    address: proxyAddress,
    constructorArguments: [implAddress],
  });

  // 5. Initialize the SettelmentsControl through proxy
  console.log('Initializing SettelmentsControl...');
  const initHash = await walletClient.writeContract({
    address: proxyAddress,
    abi: SettelmentsControl.abi,
    functionName: 'initialize',
    args: [erc20Address, account.address], // Token address and admin address
  });
  
  await publicClient.waitForTransactionReceipt({ hash: initHash });
  console.log('SettelmentsControl initialized successfully');

  // 6. Verify admin is set correctly
  const admin = await publicClient.readContract({
    address: proxyAddress,
    abi: SettelmentsControl.abi,
    functionName: 'getAdmin',
  });
  console.log(`Admin set to: ${admin}`);

  console.log('Deployment completed successfully!');
  console.log('=== Deployment Summary ===');
  console.log(`ERC20Mock: ${erc20Address}`);
  console.log(`SettelmentsControl impl: ${implAddress}`);
  console.log(`Proxy: ${proxyAddress}`);
  console.log(`Admin: ${account.address}`);
}

deployContracts().catch(console.error)