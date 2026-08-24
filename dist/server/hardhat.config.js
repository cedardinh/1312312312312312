"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
require("@nomicfoundation/hardhat-ethers");
require("@openzeppelin/hardhat-upgrades");
const config_1 = require("hardhat/config");
const task_names_1 = require("hardhat/builtin-tasks/task-names");
(0, config_1.subtask)(task_names_1.TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
    if (solcVersion !== "0.8.24")
        return runSuper();
    return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: "0.8.24",
        longVersion: "0.8.24+commit.e11b9ed9",
    };
});
const rpcUrl = process.env.TOPAZ_RPC_URL;
const rawChainId = process.env.TOPAZ_CHAIN_ID;
const chainId = rawChainId ? Number(rawChainId) : undefined;
const privateKey = process.env.TOPAZ_PRIVATE_KEY;
if ((rpcUrl && !rawChainId) || (!rpcUrl && rawChainId)) {
    throw new Error("TOPAZ_RPC_URL and TOPAZ_CHAIN_ID must be provided together");
}
if (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) {
    throw new Error("TOPAZ_CHAIN_ID must be a positive integer");
}
const config = {
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
exports.default = config;
