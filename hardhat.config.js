require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config();

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

/**
 * Offline compile escape hatch.
 *
 * Hardhat normally downloads a native solc binary from binaries.soliditylang.org. On a locked
 * down network (CI, a corporate VPN, a conference wifi that blocks everything) that download
 * fails and you cannot compile. Setting USE_SOLCJS=1 makes Hardhat use the solc-js build that
 * npm already installed instead. Slower, but it always works.
 *
 * Do not discover this on demo day. `USE_SOLCJS=1 npx hardhat test` is your fallback.
 */
if (process.env.USE_SOLCJS === "1") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: "0.8.24+commit.e11b9ed9",
      };
    }
    return runSuper();
  });
}

const PK = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = PK ? [PK] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris", // X Layer is a Polygon CDK zkEVM - do not assume post-Shanghai opcodes
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    // X Layer testnet - build and test here first.
    xlayerTestnet: {
      url: process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech/terigon",
      chainId: 1952,
      accounts,
      // Public X Layer endpoints are slow and occasionally stall. The default timeout is
      // short enough that a long script dies halfway with UND_ERR_HEADERS_TIMEOUT, which
      // looks like a code failure and is not one.
      timeout: 180000,
    },
    // X Layer mainnet - the submission must be deployed here.
    xlayer: {
      url: process.env.XLAYER_RPC || "https://rpc.xlayer.tech",
      chainId: 196,
      accounts,
      timeout: 180000,
    },
  },
  etherscan: {
    apiKey: { xlayer: process.env.OKLINK_API_KEY || "" },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: { timeout: 120000 },
};
