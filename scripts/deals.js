/**
 * The deals this deployment originates.
 *
 * Firm Quote is one contract per deal by design: TrancheVault holds `status`,
 * `seniorAssets` and `drawnAmount` as plain state, not a mapping, and
 * UnderwriterVault points at exactly one TrancheVault because that is where it
 * pushes slash proceeds. So more deals means more stacks, not more rows.
 *
 * What IS shared, because the contracts already support it:
 *   - the settlement token
 *   - ReputationGate, which scores wallets not deals
 *   - ExitLiquidityPool, whose quotes are a mapping keyed by tranche token
 *
 * The three deals below deliberately end in three different states so the site
 * shows the whole lifecycle at once rather than one frozen moment:
 *
 *   open    nobody has funded it, so a visitor can actually deposit
 *   funded  money is out working, so the early exit demo has something to sell
 *   settled the maturity already happened, so the slash and the waterfall are visible
 *
 * These are real deals on chain with real transactions behind them. The invoice
 * books they represent are synthetic, and will be for any RWA project at this
 * stage, because receivables data is private and arrives through onboarding
 * rather than a public API. Better to say that than to imply a live feed.
 */

const DEALS = [
  {
    id: 'northwind',
    name: 'Northwind Logistics',
    assetLabel: 'INV-2026-Q3-HAULAGE-001',
    obligor: 'obligor:NORTHWIND-LOGISTICS',
    blurb: 'A haulage company owed money on delivered freight invoices.',
    maturityDays: 90,
    seed: 'open', // left unfunded so deposits are genuinely possible
    /**
     * And left UNSCORED, which is the other half of the product.
     *
     * The seed used to publish an opinion on every deal, so a model operator who
     * arrived had nothing to underwrite: every deal already carried one, and a deal
     * only ever carries one. The whole underwriter side was a museum. This deal is
     * originated and waiting for somebody to take a view on it.
     */
    awaitingOpinion: true,
    senior: 800_000,
    junior: 200_000,
    predictedDefaultBps: 800,
  },
  {
    id: 'harbourside',
    name: 'Harbourside Cold Chain',
    assetLabel: 'INV-2026-Q3-COLDCHAIN-002',
    obligor: 'obligor:HARBOURSIDE-COLD-CHAIN',
    blurb: 'Refrigerated storage and distribution receivables from grocery chains.',
    maturityDays: 60,
    seed: 'funded', // the early exit demo lives here
    senior: 1_200_000,
    junior: 300_000,
    predictedDefaultBps: 450,
  },
  {
    id: 'meridian',
    name: 'Meridian Agri Supply',
    assetLabel: 'INV-2026-Q3-AGRI-004',
    obligor: 'obligor:MERIDIAN-AGRI-SUPPLY',
    blurb: 'Seed and fertiliser invoices to farm cooperatives, seasonal and well secured.',
    maturityDays: 120,
    seed: 'funded',
    senior: 600_000,
    junior: 150_000,
    predictedDefaultBps: 275,
  },
  {
    id: 'ferrous',
    name: 'Ferrous Metals Trading',
    assetLabel: 'INV-2026-Q1-METALS-003',
    obligor: 'obligor:FERROUS-METALS-TRADING',
    blurb: 'Scrap metal export invoices. This one already matured, and it went badly.',
    maturityDays: 1,
    seed: 'settled', // shows a real slash and a real waterfall
    senior: 400_000,
    junior: 100_000,
    predictedDefaultBps: 600,
    actualDefaultBps: 2_400, // well past tolerance, so the bond is slashed hard
  },
];

module.exports = { DEALS };
