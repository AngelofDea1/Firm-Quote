/**
 * Deploys the whole system and writes deployments/<network>.json, which is the single
 * source of truth the orchestrator and the frontend both read. Nothing downstream
 * hardcodes an address.
 *
 *   npx hardhat run scripts/deploy.js --network xlayerTestnet
 *   npx hardhat run scripts/deploy.js --network xlayer
 *
 * Gas on X Layer is paid in OKB, not ETH. Fund the deployer from the faucet first.
 *
 * SHAPE OF THE OUTPUT FILE
 *
 * This deploys several deals. The contracts that can be shared are shared, and the
 * ones that cannot are repeated per deal, which the comment in scripts/deals.js
 * explains. That would normally be a breaking change for every downstream reader,
 * so the file keeps a top level `contracts` block pointing at the first deal. Old
 * code keeps working untouched, new code reads `deals`.
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { DEALS } = require("./deals");

const USDC = (n) => ethers.parseUnits(String(n), 6);

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log(`\nnetwork    ${network.name} (chainId ${chainId})`);
  console.log(`deployer   ${deployer.address}`);
  console.log(`balance    ${ethers.formatEther(bal)} ${network.name.startsWith("xlayer") ? "OKB" : "ETH"}`);
  if (bal === 0n) throw new Error("Deployer has no gas. On X Layer that means OKB, from the faucet.");

  // ---- shared: settlement asset ------------------------------------------
  let settlementAsset = process.env.SETTLEMENT_TOKEN;
  if (!settlementAsset) {
    console.log("\nNo SETTLEMENT_TOKEN set - deploying a mock USDC for the demo.");
    const mock = await (await ethers.getContractFactory("MockERC20")).deploy("Demo USD Coin", "dUSDC", 6);
    await mock.waitForDeployment();
    settlementAsset = await mock.getAddress();
    await (await mock.mint(deployer.address, USDC(50_000_000))).wait();
    console.log(`  MockERC20         ${settlementAsset}`);
  } else {
    console.log(`\nUsing existing settlement token ${settlementAsset}`);
  }

  // ---- shared: gate and exit pool ----------------------------------------
  // The gate scores wallets, not deals. The pool keys its quotes by tranche token,
  // so one pool provides the standing bid for every deal at once.
  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(deployer.address);
  await gate.waitForDeployment();
  console.log(`  ReputationGate    ${await gate.getAddress()}`);

  const exitPool = await (
    await ethers.getContractFactory("ExitLiquidityPool")
  ).deploy(settlementAsset, deployer.address);
  await exitPool.waitForDeployment();
  console.log(`  ExitLiquidityPool ${await exitPool.getAddress()}`);

  // Demo-friendly policy: wallet-age gate relaxed so a fresh testnet wallet can participate.
  // On mainnet you would leave minWalletAgeBlocks at its 5000-block default.
  const minWalletAgeBlocks = Number(process.env.MIN_WALLET_AGE_BLOCKS ?? 0);
  await (await gate.setPolicy(minWalletAgeBlocks, 3, 1_000, 30_000, 10_000, 5_000)).wait();

  // A wallet used only to demonstrate the gate refusing a bad actor. Nobody needs its private
  // key, because the gate only ever reads the address and the attestor does the flagging. That
  // means the demo works identically on a network where you control exactly one key, which
  // is the normal situation on testnet and mainnet.
  const demoFlaggedWallet = ethers.getAddress(
    "0x" + ethers.keccak256(ethers.toUtf8Bytes("demo:collusion-ring-wallet")).slice(26),
  );

  // ---- per deal ------------------------------------------------------------
  const deals = [];
  for (const d of DEALS) {
    console.log(`\ndeal: ${d.name}`);

    const underwriterVault = await (
      await ethers.getContractFactory("UnderwriterVault")
    ).deploy(settlementAsset, await gate.getAddress(), deployer.address);
    await underwriterVault.waitForDeployment();
    console.log(`  UnderwriterVault  ${await underwriterVault.getAddress()}`);

    const trancheVault = await (
      await ethers.getContractFactory("TrancheVault")
    ).deploy(settlementAsset, deployer.address);
    await trancheVault.waitForDeployment();
    console.log(`  TrancheVault      ${await trancheVault.getAddress()}`);

    const assetId = ethers.keccak256(ethers.toUtf8Bytes(d.assetLabel));

    // The counterparty is the obligor side of the deal, the payer entity the underwriter is
    // taking a view on. It must NOT be the underwriter: ReputationGate refuses an underwriter
    // and counterparty that share a funding root, and self-underwriting is the most basic
    // version of exactly the abuse the gate exists to stop.
    const counterparty = ethers.getAddress(
      "0x" + ethers.keccak256(ethers.toUtf8Bytes(d.obligor)).slice(26),
    );

    const maturity = Math.floor(Date.now() / 1000) + d.maturityDays * 24 * 3600;

    await (
      await trancheVault.initialise(
        assetId,
        maturity,
        await underwriterVault.getAddress(),
        process.env.ORIGINATOR_ADDRESS || deployer.address,
        d.name,
      )
    ).wait();
    await (await underwriterVault.setTrancheVault(await trancheVault.getAddress())).wait();
    await (await gate.setConsumer(await underwriterVault.getAddress(), true)).wait();
    await (
      await underwriterVault.setParams(
        USDC(process.env.MIN_BOND || 50_000),
        Number(process.env.TOLERANCE_BPS || 200),
        Number(process.env.FULL_SLASH_ERROR_BPS || 1_000),
      )
    ).wait();

    const senior = await trancheVault.senior();
    const junior = await trancheVault.junior();
    console.log(`  SeniorTranche     ${senior}`);
    console.log(`  JuniorTranche     ${junior}`);

    deals.push({
      id: d.id,
      name: d.name,
      blurb: d.blurb,
      assetLabel: d.assetLabel,
      assetId,
      counterparty,
      maturity,
      maturityDays: d.maturityDays,
      seed: d.seed,
      awaitingOpinion: Boolean(d.awaitingOpinion),
      targetSenior: d.senior,
      targetJunior: d.junior,
      predictedDefaultBps: d.predictedDefaultBps,
      actualDefaultBps: d.actualDefaultBps ?? null,
      contracts: {
        underwriterVault: await underwriterVault.getAddress(),
        trancheVault: await trancheVault.getAddress(),
        seniorTranche: senior,
        juniorTranche: junior,
      },
    });
  }

  // ---- record -------------------------------------------------------------
  const first = deals[0];
  const out = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    // Recorded so the frontend and the submission writeup can link straight to the code on chain.
    explorer:
      chainId === 196
        ? "https://www.oklink.com/xlayer"
        : chainId === 1952
          ? "https://www.oklink.com/xlayer-test"
          : null,
    demoFlaggedWallet,

    shared: {
      settlementAsset,
      reputationGate: await gate.getAddress(),
      exitLiquidityPool: await exitPool.getAddress(),
    },
    deals,

    // ---- compatibility block ----
    // Every existing reader (chain.js, seed-demo.js, demo.js, preflight.js, the
    // frontend) expects these exact keys at the top level. Pointing them at the
    // first deal means adding deals broke nothing, and each of those can move to
    // `deals` on its own schedule instead of all at once before a deadline.
    assetLabel: first.assetLabel,
    assetId: first.assetId,
    counterparty: first.counterparty,
    maturity: first.maturity,
    contracts: {
      settlementAsset,
      reputationGate: await gate.getAddress(),
      underwriterVault: first.contracts.underwriterVault,
      trancheVault: first.contracts.trancheVault,
      exitLiquidityPool: await exitPool.getAddress(),
      seniorTranche: first.contracts.seniorTranche,
      juniorTranche: first.contracts.juniorTranche,
    },
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(`\nwrote deployments/${network.name}.json  (${deals.length} deals)`);
  console.log("next: npx hardhat run scripts/seed-demo.js --network " + network.name);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
