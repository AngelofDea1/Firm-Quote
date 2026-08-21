/**
 * ============================================================================
 *  THE RISK ENGINE - ONE SCORING CORE, USED TWICE
 * ============================================================================
 *
 * Model 1 (underwrite) and Model 2 (reprice) are not two models. They are one scoring
 * core called with `mode: "underwrite"` and `mode: "reprice"`. Same feature extraction,
 * same prompt skeleton, same output contract. The only difference is which observation
 * of the data it is looking at and what the caller does with the answer.
 *
 * That matters for more than tidiness. "Two AI features" is a weaker pitch than
 * "one coherent risk engine, applied at entry and again at exit" - and if the two ever
 * disagreed structurally, the exit price would stop meaning anything.
 *
 * Every call returns the same shape:
 *   { defaultRateBps, confidenceBps, reasoning, features, modelVersion, source }
 *
 * `source` is "llm" or "deterministic". The deterministic path is a real scoring
 * function over the same features, not a stub - so the demo still runs, and still
 * produces defensible numbers, with no API key and no network. Do not find out on
 * stage that conference wifi blocks api.anthropic.com.
 */

const crypto = require("crypto");

const MODEL_VERSION = "fq-risk-v1";
const BPS = 10_000;

// ---------------------------------------------------------------------------
// Feature extraction - shared by both modes and by both scoring paths
// ---------------------------------------------------------------------------

function extractFeatures(batch) {
  const invoices = batch.invoices ?? [];
  const total = invoices.reduce((s, i) => s + i.amount, 0) || 1;

  // Exposure-weighted days-late across each payer's history.
  let weightedDaysLate = 0;
  let weightedRecentDaysLate = 0;
  let watchlistExposure = 0;
  const byPayer = new Map();

  for (const inv of invoices) {
    const p = inv.payerProfile ?? {};
    const hist = p.priorInvoices ?? [];
    const w = inv.amount / total;

    const avg = hist.length ? hist.reduce((s, h) => s + h.daysLate, 0) / hist.length : 30;
    const recent = hist.length ? hist.slice(-2).reduce((s, h) => s + h.daysLate, 0) / Math.min(2, hist.length) : 30;

    weightedDaysLate += w * avg;
    weightedRecentDaysLate += w * recent;
    if (p.watchlist) watchlistExposure += w;

    byPayer.set(inv.payer, (byPayer.get(inv.payer) ?? 0) + inv.amount);
  }

  // Herfindahl index over payers: 1.0 means the whole batch is one payer.
  const concentrationHhi = [...byPayer.values()].reduce((s, v) => s + (v / total) ** 2, 0);

  // How much of the batch is already past its due date.
  const overdueExposure =
    invoices.reduce((s, i) => s + (i.issuedDaysAgo > i.termDays ? i.amount : 0), 0) / total;

  const avgYearsTrading =
    invoices.reduce((s, i) => s + (i.payerProfile?.yearsTrading ?? 3) * (i.amount / total), 0);

  return {
    invoiceCount: invoices.length,
    totalFaceValue: total,
    payerCount: byPayer.size,
    weightedDaysLate: round2(weightedDaysLate),
    weightedRecentDaysLate: round2(weightedRecentDaysLate),
    deteriorationDelta: round2(weightedRecentDaysLate - weightedDaysLate),
    concentrationHhi: round3(concentrationHhi),
    overdueExposure: round3(overdueExposure),
    watchlistExposure: round3(watchlistExposure),
    avgYearsTrading: round2(avgYearsTrading),
  };
}

// ---------------------------------------------------------------------------
// Deterministic scoring - the fallback, and the sanity check on the LLM
// ---------------------------------------------------------------------------

/**
 * A transparent additive model. Every term is something a credit analyst would
 * actually name out loud, which is the point: when a judge asks "why 640 bps?",
 * the answer is a list, not a shrug.
 */
function scoreDeterministic(f) {
  const terms = [];
  const add = (label, bps) => {
    if (bps !== 0) terms.push({ label, bps: Math.round(bps) });
    return Math.round(bps);
  };

  let bps = 0;
  bps += add("base rate for trade receivables", 120);
  bps += add("payment history (weighted days late)", Math.min(1_400, f.weightedDaysLate * 42));
  bps += add("recent deterioration in payment behaviour", Math.max(0, f.deteriorationDelta) * 55);
  bps += add("payer concentration", Math.max(0, f.concentrationHhi - 0.25) * 1_600);
  bps += add("exposure already past due", f.overdueExposure * 900);
  bps += add("watchlisted payer exposure", f.watchlistExposure * 1_100);
  bps += add("payer tenure credit", -Math.min(220, f.avgYearsTrading * 22));

  const defaultRateBps = clamp(Math.round(bps), 0, BPS);

  // Confidence falls with thin history, heavy concentration, and unstable behaviour.
  let conf = 8_600;
  conf -= Math.min(1_800, Math.max(0, f.concentrationHhi - 0.25) * 4_000);
  conf -= Math.min(1_500, Math.abs(f.deteriorationDelta) * 120);
  if (f.invoiceCount < 5) conf -= 900;
  const confidenceBps = clamp(Math.round(conf), 1_000, 9_500);

  return { defaultRateBps, confidenceBps, terms };
}

// ---------------------------------------------------------------------------
// Prompt construction - one skeleton, two modes
// ---------------------------------------------------------------------------

function buildPrompt({ mode, batch, features, prior }) {
  const isReprice = mode === "reprice";

  const task = isReprice
    ? `You previously underwrote this exact batch at ${prior?.defaultRateBps ?? "?"} bps expected default. ` +
      `Below is a FRESH observation of the same batch. Re-score it. If nothing material changed, say so and ` +
      `keep the number close to your prior - churn for its own sake is a failure mode, not a feature.`
    : `Score this batch of trade receivables for expected default over its remaining term.`;

  return `You are a credit underwriting model for tokenised trade receivables. You are being asked to
commit real collateral behind this number: if realised defaults come in materially worse than you
say, the operator's bond is slashed. Price accordingly - neither optimistic nor reflexively bearish.

TASK
${task}

PORTFOLIO (observed ${batch.observedAt}, source: ${batch.source})
${JSON.stringify(
  { assetClass: batch.assetClass, currency: batch.currency, invoices: batch.invoices },
  null,
  1,
)}

EXTRACTED FEATURES
${JSON.stringify(features, null, 1)}
${prior ? `\nYOUR PRIOR SCORE\n${JSON.stringify(prior, null, 1)}` : ""}

Respond with ONLY a JSON object, no prose outside it, no markdown fence:
{
  "defaultRateBps": <integer 0-10000, expected default rate in basis points>,
  "confidenceBps": <integer 0-10000, how confident you are in that estimate>,
  "reasoning": "<2-4 sentences. Name the specific drivers and the specific payers. This is published onchain as a hash and read aloud to judges - vagueness is visible.>",
  "keyDrivers": ["<short phrase>", "..."]
}`;
}

// ---------------------------------------------------------------------------
// The single public scoring entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {"underwrite"|"reprice"} args.mode
 * @param {object} args.batch          output of getOriginationBatch / getRepriceBatch
 * @param {object} [args.prior]        the previous score, when repricing
 * @param {boolean} [args.forceDeterministic]
 */
async function scoreAsset({ mode = "underwrite", batch, prior = null, forceDeterministic = false }) {
  const features = extractFeatures(batch);
  const baseline = scoreDeterministic(features);

  if (forceDeterministic || !process.env.ANTHROPIC_API_KEY) {
    return {
      mode,
      defaultRateBps: baseline.defaultRateBps,
      confidenceBps: baseline.confidenceBps,
      reasoning: explainDeterministic(baseline, features, mode, prior),
      keyDrivers: baseline.terms.filter((t) => t.bps > 0).sort((a, b) => b.bps - a.bps).slice(0, 3).map((t) => t.label),
      features,
      breakdown: baseline.terms,
      modelVersion: MODEL_VERSION,
      source: "deterministic",
    };
  }

  try {
    const llm = await callAnthropic(buildPrompt({ mode, batch, features, prior }));
    // Guardrail: an LLM that wanders more than 1500bps from the transparent baseline is
    // not trusted blindly - we clamp toward the baseline and say we did.
    const clamped = clamp(
      llm.defaultRateBps,
      Math.max(0, baseline.defaultRateBps - 1_500),
      Math.min(BPS, baseline.defaultRateBps + 1_500),
    );
    return {
      mode,
      defaultRateBps: clamped,
      confidenceBps: clamp(llm.confidenceBps ?? baseline.confidenceBps, 1_000, 9_500),
      reasoning: llm.reasoning,
      keyDrivers: llm.keyDrivers ?? [],
      features,
      breakdown: baseline.terms,
      baselineBps: baseline.defaultRateBps,
      clampedFrom: clamped !== llm.defaultRateBps ? llm.defaultRateBps : undefined,
      modelVersion: MODEL_VERSION,
      source: "llm",
    };
  } catch (err) {
    return {
      mode,
      defaultRateBps: baseline.defaultRateBps,
      confidenceBps: baseline.confidenceBps,
      reasoning: `${explainDeterministic(baseline, features, mode, prior)} (LLM unavailable: ${err.message})`,
      keyDrivers: baseline.terms.filter((t) => t.bps > 0).map((t) => t.label).slice(0, 3),
      features,
      breakdown: baseline.terms,
      modelVersion: MODEL_VERSION,
      source: "deterministic-fallback",
    };
  }
}

function explainDeterministic(baseline, f, mode, prior) {
  const top = baseline.terms.filter((t) => t.bps > 0).sort((a, b) => b.bps - a.bps).slice(0, 3);
  const drivers = top.map((t) => `${t.label} (+${t.bps}bps)`).join(", ");
  const move =
    mode === "reprice" && prior
      ? ` Repriced from ${prior.defaultRateBps}bps: recent behaviour moved by ${f.deteriorationDelta} days.`
      : "";
  return (
    `Expected default of ${baseline.defaultRateBps}bps across ${f.invoiceCount} invoices from ` +
    `${f.payerCount} payers. Largest contributors: ${drivers}. Exposure-weighted payment history ` +
    `is ${f.weightedDaysLate} days late on average, ${f.weightedRecentDaysLate} days on the most ` +
    `recent observations.${move}`
  );
}

// ---------------------------------------------------------------------------
// Exit pricing - the waterfall, mirrored offchain
// ---------------------------------------------------------------------------

/**
 * How much of the posted bond will ACTUALLY be available as loss cover.
 *
 * A subtle point worth getting right, and worth being able to answer when asked: the bond is
 * not automatic first-loss capital. It is only slashed to the extent the realised default rate
 * beats what the underwriter predicted, plus the tolerance band. If the credit deteriorates
 * exactly as predicted, the underwriter was right, nothing is slashed, and junior eats the loss
 * alone. Pricing an exit as though the whole bond is cover would systematically overvalue junior.
 *
 * This mirrors UnderwriterVault.previewSlash exactly. If you change one, change the other.
 */
function expectedBondCover({
  bondAmount,
  originalPredictedBps,
  projectedDefaultBps,
  toleranceBps = 200,
  fullSlashErrorBps = 1_000,
}) {
  const threshold = originalPredictedBps + toleranceBps;
  if (projectedDefaultBps <= threshold) return 0;
  const errorBps = projectedDefaultBps - threshold;
  const fraction = Math.min(errorBps, fullSlashErrorBps) / fullSlashErrorBps;
  return Math.floor(Number(bondAmount) * fraction);
}

/**
 * Turn a re-score into a fair value for one specific tranche.
 *
 * This deliberately mirrors TrancheVault's waterfall: the expected loss is absorbed by
 * the bond, then junior, then senior, and only what reaches YOUR tranche marks you down.
 * A senior holder should not be marked down for a loss the junior is going to eat.
 *
 * Then a small time-value discount, because the pool is fronting cash today for a payout
 * that only arrives at maturity. Two terms, both defensible in one sentence each.
 */
function priceTranche({
  tranche, // "senior" | "junior"
  defaultRateBps,
  drawnAmount,
  seniorAssets,
  juniorAssets,
  bondCover,
  daysToMaturity,
  annualDiscountBps = 800,
}) {
  const expectedLoss = (Number(drawnAmount) * defaultRateBps) / BPS;

  let remaining = expectedLoss;
  const fromBond = Math.min(remaining, Number(bondCover));
  remaining -= fromBond;
  const fromJunior = Math.min(remaining, Number(juniorAssets));
  remaining -= fromJunior;
  const fromSenior = Math.min(remaining, Number(seniorAssets));

  const principal = tranche === "senior" ? Number(seniorAssets) : Number(juniorAssets);
  const lossToTranche = tranche === "senior" ? fromSenior : fromJunior;

  const creditBps = principal > 0 ? clamp(Math.round(((principal - lossToTranche) / principal) * BPS), 0, BPS) : 0;
  const timeDiscountBps = Math.round((annualDiscountBps * Math.max(0, daysToMaturity)) / 365);
  const fairValueBps = clamp(creditBps - timeDiscountBps, 0, BPS);

  return {
    tranche,
    fairValueBps,
    creditBps,
    timeDiscountBps,
    expectedLoss: Math.round(expectedLoss),
    absorption: { fromBond: Math.round(fromBond), fromJunior: Math.round(fromJunior), fromSenior: Math.round(fromSenior) },
    explanation:
      `Expected loss of ${fmt(expectedLoss)} on ${fmt(drawnAmount)} drawn at ${defaultRateBps}bps. ` +
      `Absorbed: ${fmt(fromBond)} by the operator bond, ${fmt(fromJunior)} by junior, ${fmt(fromSenior)} by senior. ` +
      `${tranche} therefore marks at ${creditBps}bps of par on credit, less ${timeDiscountBps}bps for ` +
      `${daysToMaturity} days of time value = ${fairValueBps}bps.`,
  };
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

/** keccak-compatible commitment posted onchain alongside the numeric prediction. */
function attestationHash(score) {
  const canonical = JSON.stringify({
    modelVersion: score.modelVersion,
    mode: score.mode,
    defaultRateBps: score.defaultRateBps,
    confidenceBps: score.confidenceBps,
    reasoning: score.reasoning,
    features: score.features,
  });
  // sha256 here; the orchestrator converts to keccak256 via ethers before posting.
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// LLM transport - plain fetch, no SDK, one less thing to break
// ---------------------------------------------------------------------------

async function callAnthropic(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.content?.map((c) => c.text).join("") ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const fmt = (n) => "$" + Math.round(Number(n)).toLocaleString("en-US");

module.exports = {
  scoreAsset,
  priceTranche,
  expectedBondCover,
  attestationHash,
  extractFeatures,
  scoreDeterministic,
  buildPrompt,
  MODEL_VERSION,
};
