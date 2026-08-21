/**
 * Run this before deploying to any real network.
 *
 *   npx hardhat run scripts/preflight.js --network xlayerTestnet
 *   npx hardhat run scripts/preflight.js --network xlayer
 *
 * Deployments fail for boring reasons: the wrong chain id behind an RPC URL, an empty gas
 * balance, gas paid in a token you did not fund, a contract over the size limit, an env var
 * you thought was set. Each one costs twenty minutes to diagnose while a deadline runs down.
 * This checks all of them in about five seconds and exits non zero if anything would break.
 */

const { ethers, network, artifacts } = require("hardhat");

const EXPECTED = {
  xlayer: { chainId: 196n, gasToken: "OKB", faucet: null },
  xlayerTestnet: { chainId: 1952n, gasToken: "OKB", faucet: "https://www.okx.com/xlayer/faucet" },
  localhost: { chainId: 31337n, gasToken: "ETH", faucet: null },
  hardhat: { chainId: 31337n, gasToken: "ETH", faucet: null },
};

const CONTRACTS = [
  "ReputationGate",
  "UnderwriterVault",
  "TrancheVault",
  "TrancheShare",
  "ExitLiquidityPool",
];

let failures = 0;
let warnings = 0;

function pass(label, detail = "") {
  console.log(`  ok    ${label}${detail ? "   " + detail : ""}`);
}
function warn(label, detail = "") {
  warnings++;
  console.log(`  warn  ${label}${detail ? "   " + detail : ""}`);
}
function fail(label, detail = "") {
  failures++;
  console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`);
}

async function main() {
  const expected = EXPECTED[network.name];
  console.log(`\nPreflight for network "${network.name}"\n`);

  // ---- 1. Can we reach the node at all, and is it the chain we think it is ----
  let net;
  try {
    net = await ethers.provider.getNetwork();
    pass("RPC reachable", `chainId ${net.chainId}`);
  } catch (err) {
    fail("RPC unreachable", err.message.split("\n")[0]);
    console.log("\nNothing else can be checked without a node. Fix the RPC URL first.\n");
    process.exitCode = 1;
    return;
  }

  if (!expected) {
    warn("Unknown network name", "no expected chain id on record, skipping that check");
  } else if (net.chainId !== expected.chainId) {
    fail(
      "Chain id mismatch",
      `RPC reports ${net.chainId}, but "${network.name}" should be ${expected.chainId}. ` +
        `The URL is probably pointing at the wrong network.`,
    );
  } else {
    pass("Chain id matches the network name", String(net.chainId));
  }

  // ---- 2. Is there a deployer, and can it pay for gas ----
  const signers = await ethers.getSigners();
  if (!signers.length) {
    fail("No signer", "set DEPLOYER_PRIVATE_KEY in .env");
  } else {
    const deployer = signers[0];
    const balance = await ethers.provider.getBalance(deployer.address);
    const token = expected ? expected.gasToken : "the native token";
    pass("Deployer", deployer.address);

    if (balance === 0n) {
      fail(
        "Deployer has no gas",
        `balance is 0 ${token}.` + (expected && expected.faucet ? ` Fund it at ${expected.faucet}` : ""),
      );
    } else if (balance < ethers.parseEther("0.02")) {
      warn("Deployer gas is low", `${ethers.formatEther(balance)} ${token}, a full deploy may not fit`);
    } else {
      pass("Deployer gas", `${ethers.formatEther(balance)} ${token}`);
    }

    // Gas on X Layer is OKB, not ETH. This catches the most common first time mistake.
    if (expected && expected.gasToken === "OKB") {
      pass("Gas token", "OKB, not ETH. Fund from the X Layer faucet, not an Ethereum faucet.");
    }
  }

  // ---- 3. Will every contract actually fit on chain ----
  const LIMIT = 24576;
  for (const name of CONTRACTS) {
    try {
      const art = await artifacts.readArtifact(name);
      const size = (art.deployedBytecode.length - 2) / 2;
      if (size > LIMIT) fail(`${name} is over the size limit`, `${size} bytes of ${LIMIT}`);
      else if (size > LIMIT * 0.9) warn(`${name} is close to the size limit`, `${size} bytes`);
      else pass(`${name} size`, `${size} bytes`);
    } catch {
      fail(`${name} has no artifact`, "run npx hardhat compile first");
    }
  }

  // ---- 4. Config that silently changes what gets deployed ----
  const settlement = process.env.SETTLEMENT_TOKEN;
  if (!settlement) {
    if (network.name === "xlayer") {
      fail("SETTLEMENT_TOKEN is not set", "on mainnet this deploys a mock token, which is not what you want");
    } else {
      warn("SETTLEMENT_TOKEN is not set", "a mock token will be deployed, which is fine for a demo");
    }
  } else if (!ethers.isAddress(settlement)) {
    fail("SETTLEMENT_TOKEN is not a valid address", settlement);
  } else {
    const code = await ethers.provider.getCode(settlement);
    if (code === "0x") fail("SETTLEMENT_TOKEN has no contract at that address", settlement);
    else pass("Settlement token", settlement);
  }

  const walletAge = process.env.MIN_WALLET_AGE_BLOCKS;
  if (network.name === "xlayer" && (walletAge === "0" || walletAge === undefined)) {
    warn(
      "MIN_WALLET_AGE_BLOCKS is 0 or unset",
      "the wallet age heuristic is effectively off. Fine for a demo, worth stating out loud.",
    );
  }

  // ---- 5. Optional integrations, so their absence is a choice rather than a surprise ----
  console.log("");
  // Three values, not four. The v6 API has no project id, so demanding one reports a
  // correctly configured integration as broken.
  const okx = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_API_PASSPHRASE"];
  const missingOkx = okx.filter((k) => !process.env[k]);
  if (missingOkx.length === 0) pass("OKX DEX credentials present", "run npm run okx:selftest to verify them");
  else warn("OKX DEX not configured", `missing ${missingOkx.join(", ")}, swap routing will be disabled`);

  if (process.env.ANTHROPIC_API_KEY) pass("Risk engine", "language model with deterministic guardrail");
  else warn("ANTHROPIC_API_KEY not set", "the engine will use its deterministic path, which still works");

  // ---- verdict ----
  console.log("");
  if (failures) {
    console.log(`${failures} blocking problem(s) and ${warnings} warning(s). Do not deploy yet.\n`);
    process.exitCode = 1;
  } else {
    console.log(`No blocking problems. ${warnings} warning(s).`);
    console.log(`Next: npx hardhat run scripts/deploy.js --network ${network.name}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
