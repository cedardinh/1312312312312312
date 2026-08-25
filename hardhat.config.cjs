require("dotenv/config");
require("@nomicfoundation/hardhat-ethers");
require("@openzeppelin/hardhat-upgrades");

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion !== "0.8.24") return runSuper();
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: "0.8.24",
    longVersion: "0.8.24+commit.e11b9ed9",
  };
});

const rpcUrl = process.env.CONTRACT_CONSOLE_RPC_URL;
const rawChainId = process.env.CONTRACT_CONSOLE_CHAIN_ID;
const chainId = rawChainId ? Number(rawChainId) : undefined;
const privateKey = process.env.CONTRACT_CONSOLE_PRIVATE_KEY;

if ((rpcUrl && !rawChainId) || (!rpcUrl && rawChainId)) {
  throw new Error("CONTRACT_CONSOLE_RPC_URL and CONTRACT_CONSOLE_CHAIN_ID must be provided together");
}
if (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) {
  throw new Error("CONTRACT_CONSOLE_CHAIN_ID must be a positive integer");
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { "*": { "*": ["storageLayout"] } },
    },
  },
  paths: {
    sources: ".runtime/contracts",
    cache: ".runtime/cache",
    artifacts: ".runtime/artifacts",
  },
  networks: rpcUrl && chainId ? {
    target: {
      url: rpcUrl,
      chainId,
      ...(privateKey ? { accounts: [privateKey] } : {}),
    },
  } : {},
};
