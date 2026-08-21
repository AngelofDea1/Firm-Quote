/**
 * Backend orchestrator.
 *
 * Wires the risk engine to the contracts and serves the demo frontend. Built on node:http
 * with no framework, because on a hackathon clock every dependency is a thing that can
 * break at 2am and none of them are the interesting part of this project.
 *
 *   node backend/src/orchestrator.js
 *
 * Routes
 *   GET  /api/state                     everything the UI renders
 *   GET  /api/gate-check?uw=&cp=        run the eligibility check without spending gas
 *   POST /api/underwrite                Model 1 -> post prediction + bond onchain
 *   POST /api/reprice                   Model 2 -> fair value per tranche -> push quotes onchain
 *   POST /api/quote-exit                what a holder would receive right now
 *   POST /api/resolve                   oracle reports the outcome; slash + waterfall fire
 *   POST /api/admin/flag                flag/unflag an underwriter (demo step 2)
 *   GET  /api/okx/tokens                proof the DEX integration is live
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Hardhat loads .env through its own config. This process does not, so load it here or every
// key in .env is silently ignored when you run the server on its own.
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { connect, readSystemState, gateCheck, listDeals } = require("./chain");
const { scoreAsset, priceTranche, expectedBondCover } = require("./riskEngine");
const { getOriginationBatch, getRepriceBatch } = require("./data/invoices");
const { OkxDexClient } = require("./okx/dexClient");

const PORT = Number(process.env.PORT || 8787);
const FRONTEND = path.join(__dirname, "..", "..", "frontend-react", "dist");

let ctx; // the first deal's handles, and the liveness flag for the whole server

/**
 * One set of contract handles per deal, built on demand and cached.
 *
 * Rebuilding per request would mean a fresh provider and a fresh NonceManager each
 * time, throwing away the nonce tracking that stops concurrent writes racing. Cached,
 * that state survives across requests exactly as it did with a single deal.
 */
const dealCtx = new Map();

function ctxFor(dealId) {
  if (!ctx) return null;
  if (!dealId || dealId === ctx.deal?.id) return ctx;
  if (!dealCtx.has(dealId)) dealCtx.set(dealId, connect({ dealId }));
  return dealCtx.get(dealId);
}
// Model 1's output per deal, the prior Model 2 reprices against. A single global
// here meant deal three would reprice against deal one's prior.
const lastScore = new Map();

/**
 * Volume routed through OKX in this process. Deliberately simple: the Launch Grant is measured
 * on chain, so this is a convenience readout for the demo rather than the source of truth.
 */
const okxVolume = { swaps: 0, notional: 0 };

// ---------------------------------------------------------------------------

/** Reasoning is committed onchain as a keccak256 hash so the text is auditable later. */
const commit = (score) =>
  ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        modelVersion: score.modelVersion,
        mode: score.mode,
        defaultRateBps: score.defaultRateBps,
        confidenceBps: score.confidenceBps,
        reasoning: score.reasoning,
      }),
    ),
  );

/**
 * A bad request should read like a sentence, not like an ethers stack trace.
 *
 * Without this, calling gate-check with no address returned a 500 saying
 * "unsupported addressable value", which is ethers complaining that it was handed
 * null. Nothing in that message tells the caller what to do differently.
 */
class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const requireAddress = (value, field) => {
  if (!value) throw new BadRequest(`Missing ${field}. Pass a wallet address.`);
  if (!ethers.isAddress(value)) throw new BadRequest(`${field} is not a valid address: ${value}`);
  return ethers.getAddress(value);
};

const requireAmount = (value, field) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${field} must be a positive number.`);
  return n;
};

/**
 * There is nothing to sell on a deal that has not been funded or has already settled.
 *
 * The site lists every deal, including the settled one, so the sell button is right
 * there next to it. Without this guard the pool reverted with ZeroAmount and the
 * generic hint told the user to "run the console steps in order", which is advice
 * that cannot help them. Say what is actually true about the deal instead.
 */
const STATUS_NAMES = ["Uninitialised", "Open", "Funded", "Settled"];
async function requireTradeable(c) {
  const status = Number(await c.trancheVault.status());
  if (status === 2) return; // Funded, the only state with a live position to sell
  throw new BadRequest(
    status === 3
      ? "This deal has already settled, so there is no position left to sell."
      : `This deal is ${STATUS_NAMES[status] ?? "not funded"}, so nothing has been drawn to sell yet.`,
  );
}

/**
 * Only a funded deal can be settled, and saying so beats WrongStatus(2, 1).
 *
 * The underwriter page lets you reach the settlement step on any deal, because you
 * are allowed to look. Pressing the button on a deal that has not been funded threw
 * the raw custom error straight from the vault, which tells a person nothing. On an
 * already settled deal it was worse: gas estimation failed before the revert reason
 * survived, so the message was "could not coalesce error".
 */
async function requireSettleable(c) {
  const status = Number(await c.trancheVault.status());
  if (status === 2) return;
  throw new BadRequest(
    status === 3
      ? "This deal has already been settled. Its outcome is final and shown below."
      : "Nothing has been drawn on this deal yet, so there is no outcome to settle. " +
        "A deal has to be funded before it can mature.",
  );
}

/**
 * Read-through cache for chain state, and the reason the site felt slow.
 *
 * One readSystemState fires eleven contract calls. The deals list needs one per
 * deal, so opening it cost thirty three round trips to a public testnet RPC, and
 * every navigation back to the list paid that again from scratch. On X Layer
 * testnet that is seconds, not milliseconds.
 *
 * Two seconds of TTL is enough to collapse a page load's worth of duplicate reads
 * into one, and short enough that a transaction you just signed shows up on the
 * next poll. Any write clears it outright, so nobody ever sees a stale number
 * after acting.
 */
const STATE_TTL_MS = 2000;
const stateCache = new Map();

/**
 * Retry a read that failed for a reason a retry can fix.
 *
 * A public testnet RPC drops requests. Not often, but a deals list is sixty reads
 * and a page load fires several of those, so "not often" becomes visible: a deal
 * row comes back unreadable, or the gate verdict never arrives and the standing
 * panel sits on "Checking" forever, on a deployment where nothing is wrong.
 *
 * Only transport-shaped failures are retried. A revert, a bad address, or a
 * decode failure against a contract that is genuinely not there will fail again
 * identically, and retrying those just triples the time before the user is told.
 */
const RETRYABLE =
  /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network|rate.?limit|SERVER_ERROR|429|502|503|504|missing response|too many RPC calls|-32014/i;

async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const text = `${e?.message ?? ""} ${e?.code ?? ""} ${e?.shortMessage ?? ""}`;
      if (i === attempts - 1 || !RETRYABLE.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  throw last;
}

async function cachedState(c) {
  const key = c.deal?.id ?? "default";
  const hit = stateCache.get(key);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.value;
  const value = await withRetry(() => readSystemState(c));
  stateCache.set(key, { at: Date.now(), value });
  return value;
}

const invalidateState = () => stateCache.clear();

/**
 * One row of the deals list, read from chain.
 *
 * Split out of the route so a single deal can fail on its own without deciding
 * anything about the other three. See the allSettled below for why that matters.
 */
async function dealRow(d) {
  const s = await cachedState(ctxFor(d.id));
  // An Open deal has drawn nothing and holds no deposits yet, so both of the
  // obvious "size" numbers are zero. Showing $0 made a live deal look dead.
  // The target from the deal config is the honest answer to how big it is.
  const target = (d.targetSenior ?? 0) + (d.targetJunior ?? 0);
  const raised = s.deal.seniorAssets + s.deal.juniorAssets;
  return {
    id: d.id,
    name: d.name ?? d.assetLabel,
    blurb: d.blurb ?? null,
    assetLabel: d.assetLabel,
    status: s.deal.status,
    drawnAmount: s.deal.drawnAmount,
    seniorAssets: s.deal.seniorAssets,
    juniorAssets: s.deal.juniorAssets,
    targetSize: target,
    raised,
    size: s.deal.status === "Open" ? target : s.deal.drawnAmount,
    daysToMaturity: s.daysToMaturity,
    predictedDefaultRateBps: s.prediction.predictedDefaultRateBps,
    actualDefaultRateBps: s.prediction.actualDefaultRateBps,
    bondAmount: s.prediction.bondAmount,
    bondSlashed: s.prediction.bondSlashed,
    resolved: s.prediction.resolved,
    unavailable: false,
  };
}

const routes = {
  /**
   * Every deal, enough to render a list without opening each one.
   *
   * allSettled, not all, and the difference is the whole endpoint.
   *
   * Each row costs about fifteen chain reads, so four deals is sixty round trips
   * to a public RPC. Promise.all rejects on the first failure and discards the
   * work of every sibling, which meant one rate limited read, one slow response,
   * or one address that had moved returned a 500 for the entire list. On the
   * frontend that arrived as an empty deal dropdown on a page that otherwise
   * looked completely healthy, because /api/state reads a single deal and kept
   * succeeding. Nothing on screen said anything was wrong. There was simply
   * nothing to pick.
   *
   * Now a deal that cannot be read comes back as a row that says so, and the
   * three that can be read are still selectable.
   */
  "GET /api/deals": async () => {
    const list = listDeals(ctx.deployment);
    const settled = await Promise.allSettled(list.map((d) => dealRow(d)));
    return {
      deals: settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const d = list[i];
        console.error(`  deal "${d.id}" could not be read: ${r.reason?.message ?? r.reason}`);
        return {
          id: d.id,
          name: d.name ?? d.assetLabel,
          blurb: d.blurb ?? null,
          assetLabel: d.assetLabel,
          status: "Unavailable",
          unavailable: true,
          error: String(r.reason?.message ?? r.reason).slice(0, 200),
          drawnAmount: 0,
          seniorAssets: 0,
          juniorAssets: 0,
          targetSize: (d.targetSenior ?? 0) + (d.targetJunior ?? 0),
          raised: 0,
          size: (d.targetSenior ?? 0) + (d.targetJunior ?? 0),
          daysToMaturity: 0,
          predictedDefaultRateBps: 0,
          actualDefaultRateBps: 0,
          bondAmount: 0,
          bondSlashed: 0,
          resolved: false,
        };
      }),
    };
  },

  "GET /api/state": async (_body, url) => cachedState(ctxFor(url.searchParams.get("deal"))),

  /**
   * The gate verdict for a wallet.
   *
   * Retried, because when this one drops the standing panel has nothing to render
   * and sits on "Checking your standing" indefinitely. A stuck spinner is the
   * worst of the failure modes: it never resolves and it never explains itself.
   */
  "GET /api/gate-check": async (_body, url) => {
    const c = ctxFor(url.searchParams.get("deal"));
    const uw = requireAddress(url.searchParams.get("uw") ?? ctx.deployment.deployer, "uw");
    const cp = requireAddress(url.searchParams.get("cp") ?? c.deal.counterparty, "cp");
    return withRetry(() => gateCheck(c, uw, cp));
  },

  /**
   * Publish an opinion and lock a bond behind it.
   *
   * BRING YOUR OWN MODEL.
   *
   * postPrediction takes four values: a default rate in basis points, a confidence,
   * a hash of the written reasoning, and a version string. It does not care how any
   * of them were produced. That makes the protocol model agnostic by construction,
   * and it was the strongest thing about the design that the product did not expose.
   *
   * Pass `score` and this publishes your numbers instead of ours:
   *
   *   POST /api/underwrite
   *   {
   *     "deal": "northwind",
   *     "score": {
   *       "defaultRateBps": 640,
   *       "confidenceBps": 8200,
   *       "reasoning": "why you think that, in plain text",
   *       "modelVersion": "acme-credit-v2"
   *     }
   *   }
   *
   * The reasoning is hashed on chain next to the number, so your call is auditable
   * after the fact by anybody, and the bond is yours to lose. Omit `score` and the
   * built in engine runs instead, which is the default for anyone without a model.
   */
  "POST /api/underwrite": async (body) => {
    const c = ctxFor(body.deal);

    let score;
    if (body.score) {
      const s = body.score;
      const rate = Number(s.defaultRateBps);
      const conf = Number(s.confidenceBps ?? 5000);
      if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
        throw new BadRequest(
          "score.defaultRateBps must be a whole number of basis points between 0 and 10000. " +
            "640 means 6.40 percent.",
        );
      }
      if (!Number.isInteger(conf) || conf < 0 || conf > 10_000) {
        throw new BadRequest("score.confidenceBps must be a whole number of basis points between 0 and 10000.");
      }
      if (!s.reasoning || String(s.reasoning).trim().length < 20) {
        throw new BadRequest(
          "score.reasoning must say something. It is hashed on chain beside your number so the " +
            "call can be audited later, and twenty characters is the floor for that to mean anything.",
        );
      }
      score = {
        defaultRateBps: rate,
        confidenceBps: conf,
        reasoning: String(s.reasoning),
        modelVersion: String(s.modelVersion || "external-model"),
        source: "external",
        mode: "underwrite",
      };
    } else {
      score = await scoreAsset({
        mode: "underwrite",
        batch: getOriginationBatch(),
        forceDeterministic: body.forceDeterministic ?? false,
      });
    }
    lastScore.set(c.deal.id, score);

    if (body.dryRun) return { score, posted: false };

    const existing = await c.underwriterVault.getPrediction(c.deal.assetId);
    if (existing.underwriter !== ethers.ZeroAddress) {
      throw new BadRequest(
        "An opinion has already been published on this deal, and a deal only ever carries one. " +
          "Pick a different deal to underwrite.",
      );
    }

    const counterparty = body.counterparty ?? c.deal.counterparty;
    const required = await c.underwriterVault.requiredBondFor(await c.signer.getAddress(), counterparty);

    await (await c.asset.approve(await c.underwriterVault.getAddress(), required)).wait();
    const tx = await c.underwriterVault.postPrediction(
      c.deal.assetId,
      counterparty,
      score.defaultRateBps,
      score.confidenceBps,
      commit(score),
      score.modelVersion,
      required,
    );
    const receipt = await tx.wait();

    return {
      score,
      posted: true,
      bondPosted: ethers.formatUnits(required, 6),
      reasoningHash: commit(score),
      txHash: receipt.hash,
    };
  },

  /**
   * Model 2. Same engine, fresher data. Produces a fair value per tranche and pushes it
   * to the exit pool, which is what makes the early exit priced rather than arbitrary.
   */
  "POST /api/reprice": async (body) => {
    const c = ctxFor(body.deal);
    const scenario = body.scenario ?? "deteriorating";
    const state = await readSystemState(c);

    const score = await scoreAsset({
      mode: "reprice",
      batch: getRepriceBatch(scenario),
      prior: lastScore.get(c.deal.id) ?? { defaultRateBps: state.prediction.predictedDefaultRateBps },
      forceDeterministic: body.forceDeterministic ?? false,
    });

    // The bond is only cover to the extent it would actually be slashed at this new rate.
    const cover = expectedBondCover({
      bondAmount: state.prediction.bondAmount,
      originalPredictedBps: state.prediction.predictedDefaultRateBps,
      projectedDefaultBps: score.defaultRateBps,
      toleranceBps: Number(await c.underwriterVault.toleranceBps()),
      fullSlashErrorBps: Number(await c.underwriterVault.fullSlashErrorBps()),
    });

    const shared = {
      defaultRateBps: score.defaultRateBps,
      drawnAmount: state.deal.drawnAmount,
      seniorAssets: state.deal.seniorAssets,
      juniorAssets: state.deal.juniorAssets,
      bondCover: cover,
      daysToMaturity: state.daysToMaturity,
    };
    const pricing = {
      senior: priceTranche({ tranche: "senior", ...shared }),
      junior: priceTranche({ tranche: "junior", ...shared }),
    };

    if (body.dryRun) return { score, expectedBondCover: cover, pricing, pushed: false };

    const hash = commit(score);
    const t1 = await c.exitPool["updatePrice(address,uint256,uint256,bytes32)"](
      c.contracts.seniorTranche,
      pricing.senior.fairValueBps,
      score.defaultRateBps,
      hash,
    );
    await t1.wait();
    const t2 = await c.exitPool["updatePrice(address,uint256,uint256,bytes32)"](
      c.contracts.juniorTranche,
      pricing.junior.fairValueBps,
      score.defaultRateBps,
      hash,
    );
    await t2.wait();

    return {
      score,
      expectedBondCover: cover,
      pricing,
      pushed: true,
      reasoningHash: hash,
      txHashes: [t1.hash, t2.hash],
    };
  },

  /** Pure read. The UI calls this live while the user drags the amount slider. */
  "POST /api/quote-exit": async (body) => {
    const c = ctxFor(body.deal);
    await requireTradeable(c);
    const token =
      body.tranche === "junior" ? c.contracts.juniorTranche : c.contracts.seniorTranche;
    const amount = ethers.parseUnits(String(body.amount ?? 100_000), 6);
    const [par, fair, payout, spread] = await c.exitPool.quoteExit(token, amount);
    const cash = await c.exitPool.availableLiquidity();
    const capBps = await c.exitPool.maxExitBpsOfLiquidity();
    const cap = (cash * capBps) / 10_000n;

    const f = (v) => Number(ethers.formatUnits(v, 6));
    return {
      tranche: body.tranche ?? "senior",
      tokenAmount: f(amount),
      parValue: f(par),
      fairValue: f(fair),
      payout: f(payout),
      spreadEarned: f(spread),
      perExitCap: f(cap),
      withinCap: payout <= cap,
      poolCash: f(cash),
    };
  },

  /**
   * Execute the early exit on behalf of a tranche holder.
   *
   * The holder has to sign, so the orchestrator needs their key. Set HOLDER_PRIVATE_KEY for
   * the demo; where the deployer is also the holder (any single-key network) it falls back to
   * the orchestrator signer. In production this call would not exist - the frontend would ask
   * the user's wallet to sign `approve` + `requestExit` directly against the pool.
   */
  "POST /api/exit": async (body) => {
    const c = ctxFor(body.deal);
    await requireTradeable(c);
    const isJunior = body.tranche === "junior";
    const token = isJunior ? c.contracts.juniorTranche : c.contracts.seniorTranche;
    const amount = ethers.parseUnits(String(body.amount ?? 100_000), 6);

    /**
     * On a local node, default to whichever Hardhat account actually holds this tranche.
     *
     * This used to always pick account 3, which seed-demo.js funds with senior. Junior
     * exits therefore failed every time on a local chain with "has 0.0 junior shares",
     * and the only fix was setting HOLDER_PRIVATE_KEY by hand. Half the product looked
     * broken for a reason that had nothing to do with the product.
     *
     * Both keys are printed publicly by Hardhat on every start and are funded only on
     * throwaway local chains. Never used on 196 or 1952, where the browser wallet signs.
     */
    const LOCAL_SENIOR_HOLDER = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // account 3
    const LOCAL_JUNIOR_HOLDER = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // account 4
    const holderKey =
      process.env.HOLDER_PRIVATE_KEY ||
      (c.deployment.chainId === 31337
        ? isJunior
          ? LOCAL_JUNIOR_HOLDER
          : LOCAL_SENIOR_HOLDER
        : null);
    const holder = holderKey
      ? new ethers.NonceManager(new ethers.Wallet(holderKey, c.provider))
      : c.signer;
    const share = (isJunior ? c.junior : c.senior).connect(holder);
    const pool = c.exitPool.connect(holder);

    const held = await share.balanceOf(await holder.getAddress());
    if (held < amount) {
      throw new Error(
        `Holder ${await holder.getAddress()} has ${ethers.formatUnits(held, 6)} ${isJunior ? "junior" : "senior"} ` +
          `shares, needs ${ethers.formatUnits(amount, 6)}. Set HOLDER_PRIVATE_KEY to the wallet that actually holds them.`,
      );
    }

    const [par, fair, payout, spread] = await pool.quoteExit(token, amount);
    const before = await c.asset.balanceOf(await holder.getAddress());

    await (await share.approve(await pool.getAddress(), amount)).wait();
    const tx = await pool.requestExit(token, amount);
    const receipt = await tx.wait();
    const received = (await c.asset.balanceOf(await holder.getAddress())) - before;

    const f = (v) => Number(ethers.formatUnits(v, 6));
    return {
      tranche: body.tranche ?? "senior",
      holder: await holder.getAddress(),
      parValue: f(par),
      fairValue: f(fair),
      spreadEarned: f(spread),
      payout: f(payout),
      received: f(received),
      txHash: receipt.hash,
      poolCashAfter: f(await c.exitPool.availableLiquidity()),
    };
  },

  /**
   * The originator draws the money down, moving the deal from Open to Funded.
   *
   * This existed on the contract from day one and nothing ever called it, which
   * quietly broke the only journey that matters. A new user could deposit into an
   * Open deal and then never sell, because selling needs a Funded deal. They could
   * not deposit into a Funded one either, because deposits close on drawdown. So
   * the headline feature, selling out early, was reachable only by whichever wallet
   * happened to be seeded with tranche tokens.
   *
   * With this, the lifecycle runs end to end in the product: subscribe while it is
   * Open, the originator draws, and now your position is live and sellable. That is
   * also how it works in the real world, which is the point.
   */
  "POST /api/fund": async (body) => {
    const c = ctxFor(body.deal);
    const status = Number(await c.trancheVault.status());
    if (status !== 1) {
      throw new BadRequest(
        status === 2
          ? "This deal has already been drawn down. It is funded and working."
          : "Only a deal that is open for deposits can be drawn down.",
      );
    }

    const senior = await c.trancheVault.seniorAssets();
    const junior = await c.trancheVault.juniorAssets();
    if (junior === 0n) {
      throw new BadRequest(
        "A deal cannot be drawn down with no junior capital in it. Junior is the " +
          "first loss layer, so somebody has to take that side before the money goes out.",
      );
    }

    const amount = senior + junior;
    const tx = await c.trancheVault.fund(amount);
    const receipt = await tx.wait();
    return {
      drawn: Number(ethers.formatUnits(amount, 6)),
      senior: Number(ethers.formatUnits(senior, 6)),
      junior: Number(ethers.formatUnits(junior, 6)),
      txHash: receipt.hash,
    };
  },

  /** The outcome lands. One transaction: slash, bond into the waterfall, tranches written down. */
  "POST /api/resolve": async (body) => {
    const c = ctxFor(body.deal);
    // dryRun is a pure read of previewSlash, so it is allowed on any deal. The real
    // settlement is not.
    if (!body.dryRun) await requireSettleable(c);
    const actualBps = Number(body.actualDefaultRateBps ?? 4_000);
    const state = await readSystemState(c);

    const preview = await c.underwriterVault.previewSlash(c.deal.assetId, actualBps);
    if (body.dryRun) {
      return { actualBps, wouldSlash: Number(ethers.formatUnits(preview, 6)), resolved: false };
    }

    // The originator repays whatever did not default.
    const drawn = await c.trancheVault.drawnAmount();
    const repay = (drawn * BigInt(10_000 - actualBps)) / 10_000n;
    if (repay > 0n) {
      await (await c.asset.approve(await c.trancheVault.getAddress(), repay)).wait();
      await (await c.trancheVault.recordRepayment(repay)).wait();
    }

    const tx = await c.underwriterVault.resolveOutcome(c.deal.assetId, actualBps);
    const receipt = await tx.wait();

    const after = await readSystemState(c);
    return {
      actualBps,
      resolved: true,
      txHash: receipt.hash,
      slashed: Number(ethers.formatUnits(preview, 6)),
      before: { senior: state.deal.seniorAssets, junior: state.deal.juniorAssets },
      after: { senior: after.deal.seniorAssets, junior: after.deal.juniorAssets },
      waterfall: receipt.logs
        .map((l) => {
          try {
            return c.trancheVault.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter((l) => l?.name === "LossSettled")
        .map((l) => ({
          loss: ethers.formatUnits(l.args[0], 6),
          fromBond: ethers.formatUnits(l.args[1], 6),
          fromJunior: ethers.formatUnits(l.args[2], 6),
          fromSenior: ethers.formatUnits(l.args[3], 6),
        }))[0],
    };
  },

  "POST /api/admin/flag": async (body) => {
    const c = ctxFor(body.deal);
    const tx = await c.gate.setCollusionFlag(body.address, body.flagged !== false, body.note ?? "demo");
    await tx.wait();
    return gateCheck(c, body.address, c.deal.counterparty);
  },

  /**
   * Put a wallet on the register so it is allowed to underwrite.
   *
   * Registering twice reverts with AlreadyRegistered, which is not an error the
   * caller can do anything about and is not a server fault either: the wallet is in
   * exactly the state they wanted. It used to surface as a bare 500 saying
   * "AlreadyRegistered", which reads as a crash. Checked first, and answered with
   * the verdict they were asking for.
   */
  "POST /api/admin/register": async (body) => {
    const c = ctxFor(body.deal);
    const address = requireAddress(body.address, "address");
    if ((await c.gate.profiles(address)).registered) {
      return gateCheck(c, address, c.deal.counterparty);
    }
    await (await c.gate.register(address)).wait();
    await (
      await c.gate.attestSignals(
        address,
        body.firstSeenBlock ?? 0,
        ethers.keccak256(ethers.toUtf8Bytes(body.fundingRoot ?? address)),
      )
    ).wait();
    return gateCheck(c, address, c.deal.counterparty);
  },

  /**
   * Price a real swap through the OKX DEX aggregator.
   *
   * This is the read half of the integration and is safe to call at any time. It quotes
   * converting an exit payout in the settlement token into another token on X Layer, which is
   * the natural next step for a holder who has just been paid out and does not want to sit in
   * a stablecoin. Routing it through OKX is also what accrues volume toward the Launch Grant.
   */
  "POST /api/okx/quote": async (body) => {
    const c = ctxFor(body.deal);
    const client = new OkxDexClient({ chainId: c.deployment.chainId });
    if (!client.configured) {
      return { configured: false, note: "Set the OKX_* variables in .env to enable routing." };
    }
    const amount = String(body.amountBaseUnits ?? ethers.parseUnits(String(body.amount ?? 100), 6));
    const quote = await client.getQuote({
      fromTokenAddress: body.fromToken ?? c.contracts.settlementAsset,
      toTokenAddress: body.toToken,
      amount,
    });
    return { configured: true, chainId: c.deployment.chainId, amount, quote };
  },

  /**
   * Execute the swap. Defaults to a dry run that returns the exact transaction that would be
   * sent without sending it, because a mis-signed swap on mainnet is an expensive way to find
   * out the request path was wrong. Pass `{ dryRun: false }` deliberately.
   */
  "POST /api/okx/swap": async (body) => {
    const c = ctxFor(body.deal);
    const client = new OkxDexClient({ chainId: c.deployment.chainId });
    if (!client.configured) throw new Error("OKX credentials are not configured.");
    if (!c.signer) throw new Error("No signer available, so a swap cannot be broadcast.");

    const amount = String(body.amountBaseUnits ?? ethers.parseUnits(String(body.amount ?? 100), 6));
    const result = await client.routeSwap({
      wallet: c.signer,
      fromTokenAddress: body.fromToken ?? c.contracts.settlementAsset,
      toTokenAddress: body.toToken,
      amount,
      slippage: body.slippage ?? "0.005",
      dryRun: body.dryRun !== false,
    });

    if (!result.dryRun) {
      okxVolume.swaps += 1;
      okxVolume.notional += Number(ethers.formatUnits(amount, 6));
    }
    return { ...result, volumeToDate: okxVolume };
  },

  /** Running total of what has actually been routed, which is what the Launch Grant measures. */
  "GET /api/okx/volume": async () => ({
    configured: new OkxDexClient().configured,
    chainId: ctx?.deployment?.chainId ?? null,
    ...okxVolume,
  }),

  "GET /api/okx/tokens": async (_body, url) => {
    const c = ctxFor(url.searchParams.get("deal"));
    const client = new OkxDexClient({ chainId: c.deployment.chainId });
    if (!client.configured) return { configured: false, note: "OKX_* env vars not set" };
    const tokens = await client.getTokens();
    return { configured: true, chainId: c.deployment.chainId, count: tokens?.length ?? 0, tokens: tokens?.slice(0, 20) };
  },
};

// ---------------------------------------------------------------------------

// A social preview image served as application/octet-stream gets rejected by some scrapers,
// so the image and font types matter as much as the HTML ones.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Turn a raw revert into the actual custom error name and arguments.
 *
 * Without this, every guard in the system reports as "execution reverted (unknown custom
 * error)", which is useless on stage. With it, refusing an oversized exit says
 * `ExitTooLarge(191090000000, 100000000000)` - and the whole point of the circuit breaker
 * is that the audience sees it fire.
 */
function decodeRevert(err) {
  if (!ctx) return null;
  const raw =
    err?.data ??
    err?.info?.error?.data?.data ??
    err?.info?.error?.data ??
    err?.error?.data ??
    err?.revert?.data;
  const hex = typeof raw === "string" ? raw : raw?.data;
  if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 10) return null;

  for (const key of ["exitPool", "trancheVault", "underwriterVault", "gate", "senior", "junior", "asset"]) {
    try {
      const parsed = ctx[key]?.interface?.parseError(hex);
      if (parsed) {
        const args = parsed.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
        return args.length ? `${parsed.name}(${args.join(", ")})` : parsed.name;
      }
    } catch {
      /* try the next interface */
    }
  }
  return null;
}

/**
 * One transaction at a time.
 *
 * Every write route shares the orchestrator's signer. Two overlapping requests means two
 * transactions competing for one nonce. Serialising writes costs nothing at demo scale and
 * removes an entire class of "it worked in rehearsal" failures.
 */
let writeLock = Promise.resolve();

/**
 * Serialise writes, and put the nonce back when one of them fails.
 *
 * NonceManager counts optimistically: it hands out a nonce the moment you ask and
 * increments immediately, on the assumption the transaction lands. When one does
 * not land - a revert, a failed gas estimate, an rpc that drops the send - the
 * chain's nonce never moves but the manager's has. Every write after that is one
 * too high, and the node answers "Nonce too high. Expected 60 but got 61" for
 * reasons that have nothing to do with the request being made.
 *
 * Sharing one manager across every deal made this strictly worse, which is the
 * cost of the earlier fix and was not paid for at the time. Before, a revert on
 * one deal desynchronised only that deal's counter. Now a single AlreadyRegistered
 * poisons every subsequent write in the process, so an error the user could safely
 * ignore silently breaks the next thing they try.
 *
 * reset() drops the cached count and makes the next send read the real nonce from
 * chain. It costs one extra RPC call on a path that has already failed, which is
 * the cheapest possible moment to spend it.
 */
const NONCE_SHAPED = /nonce/i;

function serialize(fn) {
  /**
   * Reset on nonce trouble, and only on nonce trouble.
   *
   * The first version reset after ANY failed write, which was too broad and caused
   * the thing it was meant to stop. Most write failures never send a transaction at
   * all - a 400 from a guard, a reverted gas estimate - so they consume no nonce,
   * and resetting there discards a correct in-memory count to go and re-read one
   * that may be stale. During a burst of writes that read came back several
   * transactions behind and the next send was rejected as too low.
   *
   * So: leave the counter alone unless the error is actually about the nonce. When
   * it is, reset and retry once, which turns the one failure mode this cannot
   * prevent into one the user never sees.
   */
  const guarded = async () => {
    try {
      return await fn();
    } catch (err) {
      const text = `${err?.message ?? ""} ${err?.code ?? ""} ${err?.shortMessage ?? ""}`;
      if (!NONCE_SHAPED.test(text) || err.status) throw err;
      try {
        ctx.signer?.reset?.();
      } catch {
        /* best effort; never mask the original failure with this one */
      }
      console.error("  nonce desynchronised, reset and retrying once");
      return await fn();
    }
  };
  const run = writeLock.then(guarded, guarded);
  writeLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

const server = http.createServer(async (req, res) => {
  // A malformed request URL must not be able to take the process down. `new URL` throws on
  // things like "//" or "%", and an unhandled throw inside this handler kills the server.
  // One stray request from a browser prefetch or a scanner should never end a live demo.
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { "content-type": "text/plain", ...cors() }).end("bad request url");
    return;
  }
  const key = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors()).end();
    return;
  }

  /**
   * Health check for the host platform.
   *
   * This deliberately returns 200 even when the chain connection is down. The question the
   * platform is asking is "should I restart this container", and the answer to a temporarily
   * unreachable RPC endpoint is no: restarting will not fix someone else's node. The chain
   * status is reported in the body instead, so it is still visible without being fatal.
   */
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", ...cors() });
    res.end(JSON.stringify({
      ok: true,
      chain: ctx ? "connected" : "disconnected",
      network: ctx?.deployment?.network ?? null,
      uptimeSeconds: Math.round(process.uptime()),
    }));
    return;
  }

  // No deployment yet? Serve the website anyway and tell the frontend plainly, so it can fall
  // back to simulated data instead of showing a broken page. Looking at the site should never
  // require a running chain.
  if (routes[key] && !ctx) {
    res.writeHead(503, { "content-type": "application/json", ...cors() });
    res.end(JSON.stringify({
      error: "No deployment loaded, so the site is serving simulated data. " +
        "To connect a real chain run: npx hardhat node, then npm run deploy:local, then npm run seed:local.",
    }, null, 2));
    return;
  }

  if (routes[key]) {
    let body = {};
    if (req.method === "POST") {
      const raw = await new Promise((r) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => r(d));
      });
      /**
       * Malformed JSON is refused, not swallowed.
       *
       * This used to fall back to `{}`, which sounds harmless and is not: a POST to
       * /api/exit carrying a broken body then ran with every default filled in, so a
       * client bug became a real exit transaction for a default amount on a default
       * tranche. A request nobody can parse must not become a request that spends money.
       */
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json", ...cors() });
          res.end(JSON.stringify({ error: "Request body is not valid JSON." }, null, 2));
          return;
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          res.writeHead(400, { "content-type": "application/json", ...cors() });
          res.end(JSON.stringify({ error: "Request body must be a JSON object." }, null, 2));
          return;
        }
      }
    }
    // Reads run immediately; anything that sends a transaction queues behind the last one.
    const isWrite = req.method === "POST" && url.pathname !== "/api/quote-exit" && !body.dryRun;

    try {
      const call = () => routes[key](body, url);
      // Anything that sends a transaction makes the cached state wrong the moment it
      // lands, so clear it rather than making someone wait out a TTL to see their own
      // deposit appear.
      if (isWrite) invalidateState();
      const out = isWrite ? await serialize(call) : await call();
      if (isWrite) invalidateState();
      res.writeHead(200, { "content-type": "application/json", ...cors() });
      res.end(JSON.stringify(out, bigintSafe, 2));
    } catch (err) {
      const decoded = decodeRevert(err);
      const status = err.status ?? 500;
      console.error(`${key} failed:`, decoded ?? err.message);
      res.writeHead(status, { "content-type": "application/json", ...cors() });
      res.end(
        JSON.stringify(
          {
            error: decoded ?? err.shortMessage ?? err.message,
            revert: decoded ?? undefined,
            // "could not coalesce error" is ethers failing to estimate gas on a call that
            // would revert. Almost always it means the step before this one has not run yet.
            hint: /coalesce|CALL_EXCEPTION|estimateGas/i.test(err.message ?? "")
              ? "This step reverted on chain. Usually that means an earlier step has not run yet, " +
                "so run the console steps in order."
              : undefined,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  // Static frontend.
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(FRONTEND, file);
  if (full.startsWith(FRONTEND) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    /**
     * Caching, which was absent entirely and caused a confusing class of bug.
     *
     * Vite fingerprints every asset (index-xO0nyeFR.js), so those are safe to cache
     * forever: a new build produces a new filename. index.html is the opposite. It is
     * the file that names which bundle to load, and it keeps the same URL across every
     * deploy. With no cache-control header a browser applies its own heuristic and can
     * happily keep serving yesterday's index.html, which points at yesterday's bundle.
     * The deploy succeeds, the files on disk are correct, and the site looks unchanged.
     *
     * So: never cache the entry point, cache the fingerprinted assets aggressively.
     */
    const isFingerprinted = full.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      "content-type": MIME[path.extname(full)] ?? "application/octet-stream",
      "cache-control": isFingerprinted
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
    });
    fs.createReadStream(full).pipe(res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
});
const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

// ---------------------------------------------------------------------------

// Last line of defence. A demo that dies silently is worse than one that logs and carries on.
process.on("uncaughtException", (err) => console.error("uncaught:", err.message));
process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err && err.message));

async function start() {
  console.log(`\n  Firm Quote`);

  // Connecting to a chain is optional. If there is no deployment, or the node is not up, the
  // website still serves and shows simulated data. Wanting to look at the site is not the same
  // as wanting to run a blockchain.
  try {
    ctx = connect();
    const net = await ctx.provider.getNetwork();
    console.log(`  mode      live`);
    console.log(`  network   ${ctx.deployment.network} (chainId ${net.chainId})`);
    console.log(`  signer    ${ctx.signer ? await ctx.signer.getAddress() : "read only, no key set"}`);

    /**
     * Check the signer actually holds the roles it needs, and say so now.
     *
     * Without this the server boots looking perfectly healthy and then fails on the
     * third button of a live demo with NotOracle, which reads like a contract bug
     * and is really a wrong key. Catching it at startup turns a confusing failure
     * into one line before anybody is watching.
     */
    if (ctx.signer) {
      const me = (await ctx.signer.getAddress()).toLowerCase();
      const [oracle, gateOwner, isAttestor] = await Promise.all([
        ctx.underwriterVault.oracle(),
        ctx.gate.owner(),
        ctx.gate.attestors(me).catch(() => false),
      ]);
      const missing = [];
      if (oracle.toLowerCase() !== me) missing.push("oracle on UnderwriterVault");
      if (gateOwner.toLowerCase() !== me && !isAttestor) missing.push("attestor on ReputationGate");
      console.log(
        missing.length === 0
          ? `  roles     ok`
          : `  roles     MISSING ${missing.join(" and ")}. Those buttons will revert. ` +
            `Set ORACLE_PRIVATE_KEY to the wallet that deployed this network.`,
      );
    }
  } catch (err) {
    ctx = null;
    console.log(`  mode      website only, serving simulated data`);
    console.log(`  reason    ${err.message.split("\n")[0]}`);
    // The fix depends on which network was asked for. Telling someone deploying to a
    // hosted testnet to start a local Hardhat node is advice that cannot possibly work.
    const wanted = process.env.NETWORK || "localhost";
    console.log(
      wanted === "localhost" || wanted === "hardhat"
        ? `  to go live: npx hardhat node, then npm run deploy:local, then npm run seed:local`
        : `  to go live: check NETWORK=${wanted} matches a file in deployments/, ` +
          `that ORACLE_PRIVATE_KEY is set, and that the RPC endpoint is reachable`,
    );
  }

  console.log(`  risk      ${process.env.ANTHROPIC_API_KEY ? "language model with deterministic guardrail" : "deterministic only, no ANTHROPIC_API_KEY set"}`);
  console.log(`  okx dex   ${new OkxDexClient().configured ? "configured" : "not configured"}`);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  Port ${PORT} is already in use. Either stop whatever is on it, or run:`);
      console.error(`      PORT=8788 npm run serve\n`);
      process.exit(1);
    }
    throw err;
  });

  // 0.0.0.0 rather than the default, because a container platform routes traffic in from
  // outside the container. Binding to localhost only would make the service look dead to
  // the host's health check even though the process is running fine.
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Open http://localhost:${PORT}\n`);
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error("\nFailed to start:", e.message, "\n");
    process.exit(1);
  });
}

module.exports = { server, start };
