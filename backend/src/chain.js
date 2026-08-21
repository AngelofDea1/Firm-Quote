/**
 * Chain access layer. Loads the deployment record and the ABIs Hardhat compiled, and
 * exposes typed-ish contract handles plus one `readSystemState()` that the frontend
 * polls. Everything else in the backend goes through here.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..", "..");
const ARTIFACTS = path.join(ROOT, "artifacts", "contracts");

function abiOf(contract, file = contract) {
  const p = path.join(ARTIFACTS, `${file}.sol`, `${contract}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`ABI not found for ${contract}. Run \`npx hardhat compile\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

function loadDeployment(networkName = process.env.NETWORK || "localhost") {
  const p = path.join(ROOT, "deployments", `${networkName}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No deployment for "${networkName}". Run: npx hardhat run scripts/deploy.js --network ${networkName}`,
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Pick a deal out of a deployment record.
 *
 * Deployment files written before the multi deal change have no `deals` array, so
 * one is synthesised from the top level fields. That keeps an old file working
 * rather than making everyone redeploy to read anything.
 */
function listDeals(deployment) {
  if (Array.isArray(deployment.deals) && deployment.deals.length) return deployment.deals;
  return [
    {
      id: "deal",
      name: deployment.assetLabel,
      assetLabel: deployment.assetLabel,
      assetId: deployment.assetId,
      counterparty: deployment.counterparty,
      maturity: deployment.maturity,
      contracts: deployment.contracts,
    },
  ];
}

function selectDeal(deployment, dealId) {
  const deals = listDeals(deployment);
  if (!dealId) return deals[0];
  const found = deals.find((x) => x.id === dealId);
  if (!found) {
    // Asking for a deal that does not exist is the caller's mistake, not the
    // server's, so it carries a 400 rather than reading as an internal failure.
    const err = new Error(
      `Unknown deal "${dealId}". Known: ${deals.map((x) => x.id).join(", ")}`,
    );
    err.status = 400;
    throw err;
  }
  return found;
}

/**
 * One NonceManager per (key, rpc), shared by every deal context.
 *
 * The address on chain has a single nonce. Anything that models it with more than
 * one counter is modelling something that does not exist.
 */
const signerCache = new Map();

function sharedSigner(privateKey, url, provider) {
  const key = `${privateKey}@${url}`;
  if (!signerCache.has(key)) {
    signerCache.set(key, new ethers.NonceManager(new ethers.Wallet(privateKey, provider)));
  }
  return signerCache.get(key);
}

function connect({ networkName, rpcUrl, privateKey, dealId } = {}) {
  const deployment = loadDeployment(networkName);
  const url =
    rpcUrl ||
    process.env.RPC_URL ||
    (deployment.chainId === 196
      ? "https://rpc.xlayer.tech"
      : deployment.chainId === 1952
        ? "https://testrpc.xlayer.tech/terigon"
        : "http://127.0.0.1:8545");

  /**
   * Do not batch. This is the line that made the deployed site work.
   *
   * ethers v6 coalesces concurrent eth_call requests into a single JSON-RPC batch,
   * up to a hundred of them. readSystemState fires about fifteen reads at once and
   * /api/deals runs four of those in parallel, so roughly sixty calls arrived at
   * X Layer as one HTTP body. X Layer refuses that:
   *
   *     { "code": -32014, "message": "too many RPC calls in batch request" }
   *
   * ethers reports it as "missing response for request", which names the symptom
   * and hides the cause, so every deal came back unreadable, the gate verdict never
   * arrived, and the frontend fell through to practice data. It looked exactly like
   * a dead testnet. The testnet was fine. We were shouting sixty questions in one
   * breath.
   *
   * Locally it never showed, because a Hardhat node accepts any batch size. It only
   * appeared against the real chain, which is the only place it mattered.
   *
   * batchMaxCount 1 sends each call as its own request. Still concurrent, still
   * fast enough behind the two second state cache, and within limits every public
   * RPC actually enforces. RPC_BATCH_MAX exists so a private endpoint with a known
   * higher ceiling can turn batching back on without a code change.
   *
   * staticNetwork stops ethers re-asking for the chain id before requests, which on
   * a per-call basis was a meaningful share of the traffic causing the problem.
   */
  const batchMaxCount = Number(process.env.RPC_BATCH_MAX || 1);
  const provider = new ethers.JsonRpcProvider(url, deployment.chainId, {
    batchMaxCount,
    staticNetwork: true,
    // ethers caches every read for 250ms, keyed by method and args, and that
    // includes getTransactionCount. When a NonceManager reset asks the chain for
    // the true nonce it can be handed a count from a quarter second ago, which is
    // several transactions stale during a burst of writes and produces exactly the
    // "Nonce too low. Expected 61 but got 56" it was called to prevent. The
    // orchestrator keeps its own two second state cache for the reads that matter,
    // so this one buys nothing and costs correctness.
    cacheTimeout: -1,
  });

  // On a local Hardhat node, fall back to its first well known account so the server just works
  // with no .env editing. This key is printed publicly by Hardhat on every start and is funded
  // only on throwaway local chains. It is never used on chain 196 or 1952.
  const LOCAL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  /**
   * Key selection, and the reason it is fussier than it looks.
   *
   * DEPLOYER_PRIVATE_KEY in .env belongs to whichever wallet deployed the public
   * testnet. On a local Hardhat chain that wallet deployed nothing, so it holds no
   * roles: the gate rejects it with NotAttestor, the vault with NotOracle, and half
   * the console returns 500 while the contracts are perfectly fine.
   *
   * So on chain 31337 the deployer key is deliberately skipped. Only an explicitly
   * set ORACLE_PRIVATE_KEY overrides the local account, because setting that one is
   * a deliberate act rather than a leftover from a different network.
   */
  const isLocal = deployment.chainId === 31337;
  const pk =
    privateKey ||
    process.env.ORACLE_PRIVATE_KEY ||
    (isLocal ? LOCAL_DEFAULT_KEY : process.env.DEPLOYER_PRIVATE_KEY) ||
    null;

  // NonceManager, not a bare Wallet. The orchestrator fires several transactions from one
  // key in quick succession (approve -> repay -> resolve), and a bare Wallet re-reads the
  // pending nonce each time. Under any concurrency that races and you get NONCE_EXPIRED
  // mid-demo. This is a two-word fix for a failure that is very expensive to debug live.
  //
  // But it only works if there is ONE of them.
  //
  // connect() is called once per deal, and each call used to build its own
  // NonceManager around the same private key. Four deals meant four independent
  // nonce counters signing from a single address, each incrementing in ignorance of
  // the others. Write to two different deals in one session and they drift, then the
  // third write dies with "Nonce too low. Expected 60 but got 58." The serialize()
  // write lock could never fix this: it orders execution, but the counters were
  // already fragmented before anything queued.
  //
  // Memoised per key and per RPC, so every deal shares one counter, which is what
  // the chain actually has.
  const signer = pk ? sharedSigner(pk, url, provider) : null;
  const runner = signer ?? provider;

  const deal = selectDeal(deployment, dealId);
  const shared = deployment.shared ?? deployment.contracts;
  // Shared contracts come from the deployment, per deal ones from the deal. An old
  // file has both in the same place, which is why the fallback above works.
  const c = {
    settlementAsset: shared.settlementAsset,
    reputationGate: shared.reputationGate,
    exitLiquidityPool: shared.exitLiquidityPool,
    ...deal.contracts,
  };

  return {
    deployment,
    deal,
    deals: listDeals(deployment),
    contracts: c,
    provider,
    signer,
    asset: new ethers.Contract(c.settlementAsset, abiOf("MockERC20", "mocks/MockERC20"), runner),
    gate: new ethers.Contract(c.reputationGate, abiOf("ReputationGate"), runner),
    underwriterVault: new ethers.Contract(c.underwriterVault, abiOf("UnderwriterVault"), runner),
    trancheVault: new ethers.Contract(c.trancheVault, abiOf("TrancheVault"), runner),
    exitPool: new ethers.Contract(c.exitLiquidityPool, abiOf("ExitLiquidityPool"), runner),
    senior: new ethers.Contract(c.seniorTranche, abiOf("TrancheShare"), runner),
    junior: new ethers.Contract(c.juniorTranche, abiOf("TrancheShare"), runner),
  };
}

const STATUS = ["Uninitialised", "Open", "Funded", "Settled"];
const GATE_REASON = [
  "Eligible",
  "Not registered",
  "Flagged for collusion",
  "Wallet too young",
  "Track record too low",
  "Shared funding source with counterparty",
  "Repeated counterparty (collusion ring pattern)",
];

/** One call, everything the UI needs. Kept as a single read so the demo screen never tears. */
async function readSystemState(ctx) {
  const { deployment, trancheVault, underwriterVault, exitPool, senior, junior, asset } = ctx;
  const deal = ctx.deal ?? { assetId: deployment.assetId };
  const assetId = deal.assetId;

  const [status, seniorAssets, juniorAssets, bondCover, drawn, repaid, protection] = await Promise.all([
    trancheVault.status(),
    trancheVault.seniorAssets(),
    trancheVault.juniorAssets(),
    trancheVault.bondCover(),
    trancheVault.drawnAmount(),
    trancheVault.repaidAmount(),
    trancheVault.seniorProtectionBps(),
  ]);

  const prediction = await underwriterVault.getPrediction(assetId);

  const [poolCash, poolNav, spreadBps, maxExitBps, seniorQuote, juniorQuote, seniorInv, juniorInv] = await Promise.all([
    exitPool.availableLiquidity(),
    exitPool.totalAssets(),
    exitPool.spreadBps(),
    exitPool.maxExitBpsOfLiquidity(),
    exitPool.quotes(await senior.getAddress()),
    exitPool.quotes(await junior.getAddress()),
    exitPool.inventoryValue(await senior.getAddress()),
    exitPool.inventoryValue(await junior.getAddress()),
  ]);

  const dec = Number(await asset.decimals());
  const fmt = (v) => Number(ethers.formatUnits(v, dec));

  // Every field below describes the SELECTED deal, not the deployment as a whole.
  // Reading them off `deployment` was correct when there was only ever one deal and
  // would now quietly show deal one's label above deal three's numbers.
  return {
    network: { name: deployment.network, chainId: deployment.chainId },
    dealId: deal.id ?? "deal",
    dealName: deal.name ?? deployment.assetLabel,
    blurb: deal.blurb ?? null,
    assetLabel: deal.assetLabel ?? deployment.assetLabel,
    assetId,
    maturity: deal.maturity ?? deployment.maturity,
    daysToMaturity: Math.max(
      0,
      Math.round(((deal.maturity ?? deployment.maturity) - Date.now() / 1000) / 86400),
    ),
    contracts: ctx.contracts ?? deployment.contracts,
    deal: {
      status: STATUS[Number(status)],
      statusCode: Number(status),
      seniorAssets: fmt(seniorAssets),
      juniorAssets: fmt(juniorAssets),
      bondCover: fmt(bondCover),
      drawnAmount: fmt(drawn),
      repaidAmount: fmt(repaid),
      seniorProtectionBps: Number(protection),
    },
    prediction: {
      exists: prediction.underwriter !== ethers.ZeroAddress,
      underwriter: prediction.underwriter,
      counterparty: prediction.counterparty,
      predictedDefaultRateBps: Number(prediction.predictedDefaultRateBps),
      confidenceBps: Number(prediction.confidenceBps),
      reasoningHash: prediction.reasoningHash,
      modelVersion: prediction.modelVersion,
      bondAmount: fmt(prediction.bondAmount),
      bondSlashed: fmt(prediction.bondSlashed),
      bondReleased: fmt(prediction.bondReleased),
      actualDefaultRateBps: Number(prediction.actualDefaultRateBps),
      resolved: prediction.resolved,
      slashed: prediction.slashed,
    },
    exitPool: {
      cash: fmt(poolCash),
      nav: fmt(poolNav),
      spreadBps: Number(spreadBps),
      maxExitBpsOfLiquidity: Number(maxExitBps),
      perExitCap: fmt((poolCash * maxExitBps) / 10_000n),
      senior: { fairValueBps: Number(seniorQuote.fairValueBps), updatedAt: Number(seniorQuote.updatedAt), active: seniorQuote.active, inventory: fmt(seniorInv) },
      junior: { fairValueBps: Number(juniorQuote.fairValueBps), updatedAt: Number(juniorQuote.updatedAt), active: juniorQuote.active, inventory: fmt(juniorInv) },
    },
  };
}

/**
 * The gate verdict, plus what a bond would actually cost this wallet.
 *
 * The multiplier alone is not an answer to "what will this cost me". The UI was
 * filling that gap with the bond on the deal's EXISTING prediction, which is a
 * different number belonging to a different person, and on an unscored deal it is
 * zero. So the page told a new underwriter that posting a bond would cost them
 * nothing, on exactly the deals they were most likely to take.
 *
 * requiredBondFor is minBond * multiplier / 10000 and is already public on the
 * vault, so the honest number costs one extra read.
 */
async function gateCheck(ctx, underwriter, counterparty) {
  const [[eligible, multiplierBps, reason], required, minBond, dec] = await Promise.all([
    ctx.gate.checkEligibilityDetailed(underwriter, counterparty),
    ctx.underwriterVault.requiredBondFor(underwriter, counterparty),
    ctx.underwriterVault.minBond(),
    ctx.asset.decimals(),
  ]);
  const fmt = (v) => Number(ethers.formatUnits(v, Number(dec)));
  return {
    underwriter,
    counterparty,
    eligible,
    requiredBondMultiplierBps: Number(multiplierBps),
    requiredBond: fmt(required),
    minBond: fmt(minBond),
    reasonCode: Number(reason),
    reason: GATE_REASON[Number(reason)],
  };
}

module.exports = { connect, loadDeployment, listDeals, selectDeal, readSystemState, gateCheck, abiOf, STATUS, GATE_REASON };
