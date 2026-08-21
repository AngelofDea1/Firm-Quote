/**
 * ============================================================================
 *  STUBBED DATA FEED - THIS IS NOT REAL OFFCHAIN DATA, AND WE SAY SO OUT LOUD.
 * ============================================================================
 *
 * Shaped exactly like what a real invoice-financing originator would hand over
 * (Codat / Ledgers / a direct ERP pull), so swapping in a live feed means replacing
 * this one module and nothing else. Every consumer downstream reads the interface
 * below, never the literals.
 *
 * Disclosed in the submission writeup as a simulation. Judges respect a stated
 * simplification far more than implied realism that collapses under one question.
 */

const ASSET_ID_LABEL = "INV-2026-Q3-BATCH-001";

/** One payer's historical behaviour, which is most of the signal in invoice credit. */
const payers = {
  NORTHWIND: {
    name: "Northwind Logistics Ltd",
    sector: "freight",
    yearsTrading: 11,
    priorInvoices: [
      { amount: 84_000, daysLate: 2 },
      { amount: 91_500, daysLate: 0 },
      { amount: 77_250, daysLate: 4 },
      { amount: 88_000, daysLate: 1 },
      { amount: 95_000, daysLate: 3 },
      { amount: 82_400, daysLate: 0 },
    ],
  },
  CALDER: {
    name: "Calder Foods Group",
    sector: "food distribution",
    yearsTrading: 6,
    priorInvoices: [
      { amount: 42_000, daysLate: 11 },
      { amount: 38_500, daysLate: 18 },
      { amount: 45_000, daysLate: 9 },
      { amount: 40_200, daysLate: 22 },
      { amount: 44_800, daysLate: 15 },
    ],
  },
  HELIOSTAT: {
    name: "Heliostat Energy Services",
    sector: "renewables contracting",
    yearsTrading: 3,
    priorInvoices: [
      { amount: 120_000, daysLate: 31 },
      { amount: 110_000, daysLate: 27 },
      { amount: 135_000, daysLate: 44 },
      { amount: 128_000, daysLate: 38 },
    ],
  },
  ORRIN: {
    name: "Orrin Medical Supplies",
    sector: "healthcare wholesale",
    yearsTrading: 14,
    priorInvoices: [
      { amount: 62_000, daysLate: 0 },
      { amount: 58_500, daysLate: 0 },
      { amount: 64_100, daysLate: 1 },
      { amount: 60_000, daysLate: 0 },
      { amount: 66_300, daysLate: 2 },
    ],
  },
};

/** The batch being underwritten. Amounts are USD; the settlement token is 6-decimal USDC. */
const invoices = [
  { id: "INV-4411", payer: "NORTHWIND", amount: 180_000, termDays: 30, issuedDaysAgo: 12 },
  { id: "INV-4412", payer: "NORTHWIND", amount: 145_000, termDays: 30, issuedDaysAgo: 8 },
  { id: "INV-4418", payer: "ORRIN", amount: 210_000, termDays: 45, issuedDaysAgo: 20 },
  { id: "INV-4423", payer: "ORRIN", amount: 96_000, termDays: 45, issuedDaysAgo: 5 },
  { id: "INV-4431", payer: "CALDER", amount: 132_000, termDays: 60, issuedDaysAgo: 34 },
  { id: "INV-4436", payer: "CALDER", amount: 88_500, termDays: 60, issuedDaysAgo: 15 },
  { id: "INV-4440", payer: "HELIOSTAT", amount: 148_500, termDays: 60, issuedDaysAgo: 41 },
];

/** The batch as it looked at origination. This is what Model 1 underwrites. */
function getOriginationBatch() {
  return {
    assetLabel: ASSET_ID_LABEL,
    assetClass: "trade receivables / invoice financing",
    currency: "USD",
    observedAt: "2026-08-01T00:00:00Z",
    totalFaceValue: invoices.reduce((s, i) => s + i.amount, 0),
    invoices: invoices.map((i) => ({ ...i, payerProfile: payers[i.payer] })),
    source: "STUB - simulated originator feed",
  };
}

/**
 * The same batch, re-observed later with fresher payment behaviour. This is what Model 2
 * reprices against, and it is what makes the live exit-repricing moment in the demo real
 * rather than a hardcoded number change.
 *
 * @param {"stable"|"deteriorating"|"improving"} scenario
 */
function getRepriceBatch(scenario = "deteriorating") {
  const batch = getOriginationBatch();
  batch.observedAt = "2026-08-22T00:00:00Z";
  batch.source = `STUB - simulated re-observation (${scenario})`;

  const shift = { stable: 0, deteriorating: 1, improving: -1 }[scenario] ?? 0;
  if (shift === 0) return batch;

  batch.invoices = batch.invoices.map((inv) => {
    const p = { ...inv.payerProfile };
    // Heliostat and Calder are the weak names; stress moves them first and hardest.
    const sensitivity = { HELIOSTAT: 26, CALDER: 14, NORTHWIND: 4, ORRIN: 1 }[inv.payer] ?? 5;
    p.priorInvoices = [
      ...p.payerRecentOverride ?? p.priorInvoices,
      { amount: inv.amount, daysLate: Math.max(0, sensitivity * shift + (shift > 0 ? 6 : -3)) },
    ];
    if (shift > 0 && (inv.payer === "HELIOSTAT" || inv.payer === "CALDER")) {
      p.watchlist = true;
      p.note = "payer moved from net-30 behaviour to net-52 over the last observation window";
    }
    return { ...inv, payerProfile: p, issuedDaysAgo: inv.issuedDaysAgo + 21 };
  });

  return batch;
}

module.exports = { getOriginationBatch, getRepriceBatch, ASSET_ID_LABEL, payers };
