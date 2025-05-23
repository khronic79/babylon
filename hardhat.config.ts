import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import dotenv from 'dotenv';

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
  networks: {
    polygonAmoy: {
      url: process.env.NETWORK_URL as string,
      chainId: 80002,
      accounts: [process.env.PRIVATE_KEY as string],
      timeout: 120000
    },
    hardhat: {
      chainId: 31337,
    },
  },
  gasReporter: {
    enabled: true,
  },
  etherscan: {
    apiKey: {
      polygonAmoy: process.env.AMOY_POLYGON_APIKEY as string
    },
    customChains: [
      {
        network: "polygonAmoy",
        chainId: 80002,
        urls: {
          apiURL: "https://api-amoy.polygonscan.com/api",
          browserURL: "https://amoy.polygonscan.com/",
        },
      }
    ]
  },
};

export default config;
