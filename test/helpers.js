const { ethers } = require("hardhat");

const BPS = 10_000n;
const USDC = (n) => ethers.parseUnits(String(n), 6);
const ASSET_ID = ethers.keccak256(ethers.toUtf8Bytes("INV-2026-Q3-BATCH-001"));

const FUNDING_ROOT_A = ethers.keccak256(ethers.toUtf8Bytes("exchange-withdrawal-a"));
const FUNDING_ROOT_B = ethers.keccak256(ethers.toUtf8Bytes("exchange-withdrawal-b"));

const GateReason = {
  Eligible: 0n,
  NotRegistered: 1n,
  FlaggedForCollusion: 2n,
  WalletTooYoung: 3n,
  ScoreTooLow: 4n,
  SharedFundingSource: 5n,
  RepeatedCounterparty: 6n,
};

async function mineBlocks(n) {
  await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

/** Run a call as a contract address (used to test guards that only a contract may pass). */
async function asContract(address, fn) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [address, "0xDE0B6B3A7640000"]);
  const signer = await ethers.getSigner(address);
  try {
    return await fn(signer);
  } finally {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
  }
}

/**
 * Full system deployment.
 *
 * Note the deposit ordering: junior goes in FIRST. TrancheVault enforces a senior/junior
 * ratio cap, so a senior-only vault is rejected outright - first-loss capital has to show up
 * before the protected capital does. That is intentional, not a test artefact.
 */
async function deploySystem(opts = {}) {
  const {
    minBond = USDC(50_000),
    predictedBps = 200n,
    toleranceBps = 200n,
    fullSlashErrorBps = 1_000n,
    seniorDeposit = USDC(800_000),
    juniorDeposit = USDC(200_000),
    drawdown = USDC(1_000_000),
    lpDeposit = USDC(500_000),
    minWalletAgeBlocks = 0n,
    fund = true,
    postPrediction = true,
  } = opts;

  const [owner, underwriter, counterparty, seniorLp, juniorLp, poolLp, originator, badActor] =
    await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(owner.address);
  const underwriterVault = await (
    await ethers.getContractFactory("UnderwriterVault")
  ).deploy(await usdc.getAddress(), await gate.getAddress(), owner.address);
  const trancheVault = await (
    await ethers.getContractFactory("TrancheVault")
  ).deploy(await usdc.getAddress(), owner.address);
  const exitPool = await (
    await ethers.getContractFactory("ExitLiquidityPool")
  ).deploy(await usdc.getAddress(), owner.address);

  const maturity = (await ethers.provider.getBlock("latest")).timestamp + 90 * 24 * 3600;
  await trancheVault.initialise(
    ASSET_ID,
    maturity,
    await underwriterVault.getAddress(),
    originator.address,
    "Invoice Q3",
  );
  await underwriterVault.setTrancheVault(await trancheVault.getAddress());
  await underwriterVault.setParams(minBond, toleranceBps, fullSlashErrorBps);
  await gate.setConsumer(await underwriterVault.getAddress(), true);
  await gate.setPolicy(minWalletAgeBlocks, 3, 1_000, 30_000, 10_000, 5_000);

  const senior = await ethers.getContractAt("TrancheShare", await trancheVault.senior());
  const junior = await ethers.getContractAt("TrancheShare", await trancheVault.junior());

  // Fund every participant generously.
  for (const s of [underwriter, seniorLp, juniorLp, poolLp, originator, badActor]) {
    await usdc.mint(s.address, USDC(5_000_000));
  }

  // Register the honest underwriter and the counterparty with *different* funding roots.
  await gate.register(underwriter.address);
  await gate.attestSignals(underwriter.address, 0, FUNDING_ROOT_A);
  await gate.register(counterparty.address);
  await gate.attestSignals(counterparty.address, 0, FUNDING_ROOT_B);

  let requiredBond = 0n;
  if (postPrediction) {
    requiredBond = await underwriterVault.requiredBondFor(underwriter.address, counterparty.address);
    await usdc.connect(underwriter).approve(await underwriterVault.getAddress(), requiredBond);
    await underwriterVault
      .connect(underwriter)
      .postPrediction(
        ASSET_ID,
        counterparty.address,
        predictedBps,
        7_500n,
        ethers.keccak256(ethers.toUtf8Bytes("model reasoning v1")),
        "fq-risk-v1",
        requiredBond,
      );
  }

  // Junior first, then senior - the ratio cap requires first-loss capital to exist.
  await usdc.connect(juniorLp).approve(await junior.getAddress(), juniorDeposit);
  await junior.connect(juniorLp).deposit(juniorDeposit, juniorLp.address);
  await usdc.connect(seniorLp).approve(await senior.getAddress(), seniorDeposit);
  await senior.connect(seniorLp).deposit(seniorDeposit, seniorLp.address);

  if (fund) await trancheVault.fund(drawdown);

  // Seed the exit liquidity pool.
  await usdc.connect(poolLp).approve(await exitPool.getAddress(), lpDeposit);
  await exitPool.connect(poolLp).depositLiquidity(lpDeposit);

  return {
    owner, underwriter, counterparty, seniorLp, juniorLp, poolLp, originator, badActor,
    usdc, gate, underwriterVault, trancheVault, exitPool, senior, junior,
    maturity, requiredBond, drawdown, seniorDeposit, juniorDeposit,
  };
}

/**
 * Walk the deal to maturity: the originator repays what did not default, then the oracle
 * reports the realised rate, which triggers slash + waterfall in one transaction.
 */
async function settleAt(sys, actualDefaultRateBps) {
  const repay = (sys.drawdown * (BPS - actualDefaultRateBps)) / BPS;
  await sys.usdc.connect(sys.originator).approve(await sys.trancheVault.getAddress(), repay);
  await sys.trancheVault.connect(sys.originator).recordRepayment(repay);
  const tx = await sys.underwriterVault.resolveOutcome(ASSET_ID, actualDefaultRateBps);
  return { tx, repay, loss: (sys.drawdown * actualDefaultRateBps) / BPS };
}

module.exports = {
  BPS, USDC, ASSET_ID, GateReason, FUNDING_ROOT_A, FUNDING_ROOT_B,
  mineBlocks, increaseTime, asContract, deploySystem, settleAt,
};
