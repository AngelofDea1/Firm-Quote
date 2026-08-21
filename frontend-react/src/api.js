import { useEffect, useRef } from "react";
export const money = (n, dp) => "$" + Number(n || 0).toLocaleString("en-US", {
  minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0,
});
export const pct = (bps) => (Number(bps || 0) / 100).toFixed(2) + "%";
export const shortAddr = (a) => (a && a.length > 14 ? a.slice(0, 8) + "..." + a.slice(-6) : a || "n/a");

export const MockBackend = {
  s: null,
  flagged: null,

  reset() {
    this.flagged = null;
    this.s = {
      network: { name: "xlayer", chainId: 196 },
      assetLabel: "INV-2026-Q3-BATCH-001",
      assetId: "0x56318cfbdd7bcd0c3df8f5e7439d6688432270a2f7c42ba92ef150818e5e7536",
      maturity: 0, daysToMaturity: 90,
      contracts: {
        settlementAsset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        reputationGate: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
        underwriterVault: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
        trancheVault: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
        exitLiquidityPool: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
        seniorTranche: "0x856e4424f806D16E8CBC702B3c0F2ede5468eae5",
        juniorTranche: "0xb0279Db6a2F1E01fbC8483FCCef0Be2bC6299cC3",
      },
      deal: {
        status: "Funded", statusCode: 2, seniorAssets: 800000, juniorAssets: 200000,
        bondCover: 0, drawnAmount: 1000000, repaidAmount: 0, seniorProtectionBps: 2000,
      },
      prediction: {
        exists: true,
        underwriter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        counterparty: "0x4095B36382D1b4035302cF21140E1ebA356023AA",
        predictedDefaultRateBps: 423, confidenceBps: 8312,
        reasoningHash: "0x5caaa74048d4cb218522d92cfd047a9d43e1d1e5699dfe3ddcd84f0dde6a04c2",
        modelVersion: "fq-risk-v1", bondAmount: 130000,
        bondSlashed: 0, bondReleased: 0, actualDefaultRateBps: 0,
        resolved: false, slashed: false,
      },
      exitPool: {
        cash: 500000, nav: 500000, spreadBps: 150, maxExitBpsOfLiquidity: 2000, perExitCap: 100000,
        senior: { fairValueBps: 0, updatedAt: 0, active: false, inventory: 0 },
        junior: { fairValueBps: 0, updatedAt: 0, active: false, inventory: 0 },
      },
    };
  },

  hash() {
    let out = "0x";
    for (let i = 0; i < 64; i++) out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    return out;
  },

  async handle(path, body) {
    if (!this.s) this.reset();
    body = body || {};
    await new Promise((r) => setTimeout(r, path.indexOf("quote") >= 0 ? 80 : 560));

    const s = this.s, P = s.prediction, D = s.deal, X = s.exitPool;

    if (path.indexOf("/api/state") === 0) return JSON.parse(JSON.stringify(s));

    /**
     * Demo mode showed one deal where the live site shows three, because this
     * mock predates the multi deal work and the Invest page quietly fell back to
     * a single entry when the route 404'd. Demo mode is what a judge sees if the
     * backend is asleep, so it should not misrepresent the product.
     *
     * The four below mirror the seeded states: one taking deposits, two funded,
     * one already settled at a loss.
     */
    if (path.indexOf("/api/deals") === 0) {
      return {
        deals: [
          {
            id: "northwind",
            name: "Northwind Logistics",
            blurb: "A haulage company owed money on delivered freight invoices.",
            assetLabel: "INV-2026-Q3-HAULAGE-001",
            status: "Open",
            drawnAmount: 0,
            seniorAssets: 800000,
            juniorAssets: 200000,
            size: 1000000,
            daysToMaturity: 90,
            predictedDefaultRateBps: 800,
            actualDefaultRateBps: 0,
            bondAmount: 130000,
            bondSlashed: 0,
            resolved: false,
          },
          {
            id: "harbourside",
            name: "Harbourside Cold Chain",
            blurb: "Refrigerated storage and distribution receivables from grocery chains.",
            assetLabel: "INV-2026-Q3-COLDCHAIN-002",
            status: "Funded",
            drawnAmount: 1500000,
            seniorAssets: 1200000,
            juniorAssets: 300000,
            size: 1500000,
            daysToMaturity: 60,
            predictedDefaultRateBps: 450,
            actualDefaultRateBps: 0,
            bondAmount: 130000,
            bondSlashed: 0,
            resolved: false,
          },
          {
            id: "meridian",
            name: "Meridian Agri Supply",
            blurb: "Seed and fertiliser invoices to farm cooperatives, seasonal and well secured.",
            assetLabel: "INV-2026-Q3-AGRI-004",
            status: "Funded",
            drawnAmount: 750000,
            seniorAssets: 600000,
            juniorAssets: 150000,
            size: 750000,
            daysToMaturity: 120,
            predictedDefaultRateBps: 275,
            actualDefaultRateBps: 0,
            bondAmount: 130000,
            bondSlashed: 0,
            resolved: false,
          },
          {
            id: "ferrous",
            name: "Ferrous Metals Trading",
            blurb: "Scrap metal export invoices. This one already matured, and it went badly.",
            assetLabel: "INV-2026-Q1-METALS-003",
            status: "Settled",
            drawnAmount: 500000,
            seniorAssets: 400000,
            juniorAssets: 100000,
            size: 500000,
            daysToMaturity: 0,
            predictedDefaultRateBps: 600,
            actualDefaultRateBps: 2400,
            bondAmount: 130000,
            bondSlashed: 130000,
            resolved: true,
          },
        ],
      };
    }

    if (path.indexOf("/api/gate-check") === 0) {
      const uw = (new URLSearchParams(path.split("?")[1] || "").get("uw") || "").toLowerCase();
      if (!this.registered) this.registered = new Set();
      const known = uw === P.underwriter.toLowerCase() || this.registered.has(uw);
      const isFlagged = this.flagged === uw;
      return {
        underwriter: uw, counterparty: P.counterparty,
        eligible: known && !isFlagged, requiredBondMultiplierBps: 26000,
        // Deploy sets minBond to 50,000, and 2.6x of that is the 130,000 bond the
        // rest of the practice data already shows. Keeping these consistent matters:
        // an incoherent mock is worse than no mock, because it teaches the reader
        // arithmetic that will not hold on the real thing.
        requiredBond: 130000, minBond: 50000,
        reasonCode: isFlagged ? 2 : known ? 0 : 1,
        reason: isFlagged ? "Flagged for collusion" : known ? "Eligible" : "Not registered",
      };
    }

    if (path === "/api/admin/flag") {
      this.flagged = body.flagged === false ? null : String(body.address).toLowerCase();
      return this.handle("/api/gate-check?uw=" + body.address);
    }

    /*
      Registering, and drawing down, which practice data could not do.

      Every route the UI can reach has to exist here, or clicking a button in demo
      mode throws "Simulated backend has no route for /api/admin/register" - an
      internal sentence, shown to a user, naming a thing they never chose to be in.
      That is exactly what happened: the gate said "not registered", offered the
      button that fixes it, and the button was wired to nothing.
    */
    if (path === "/api/admin/register") {
      if (!this.registered) this.registered = new Set();
      this.registered.add(String(body.address).toLowerCase());
      return this.handle("/api/gate-check?uw=" + body.address);
    }

    if (path === "/api/fund") {
      D.status = "Funded";
      D.drawnAmount = D.seniorAssets + D.juniorAssets;
      return { ok: true, txHash: "0x" + this.hash() };
    }

    if (path === "/api/underwrite") {
      const score = {
        defaultRateBps: 423, confidenceBps: 8312, source: "deterministic", modelVersion: "fq-risk-v1",
        reasoning: "Expected default of 423 bps across 7 invoices from 4 payers. The largest " +
          "contributors are payment history at plus 388 bps, the base rate for trade receivables at " +
          "plus 120 bps, and recent deterioration in payment behaviour at plus 95 bps. " +
          "Exposure weighted payment history is 9.23 days late on average and 10.96 days on the " +
          "most recent observations.",
        breakdown: [
          { label: "payment history (weighted days late)", bps: 388 },
          { label: "base rate for trade receivables", bps: 120 },
          { label: "recent deterioration", bps: 95 },
          { label: "exposure already past due", bps: 42 },
          { label: "payer tenure credit", bps: -222 },
        ],
      };
      return { score: score, posted: !body.dryRun, bondPosted: "130000", txHash: this.hash() };
    }

    if (path === "/api/reprice") {
      const scenario = body.scenario || "deteriorating";
      const bps = { deteriorating: 1175, stable: 423, improving: 310 }[scenario];
      const overshoot = Math.max(0, Math.min(1000, bps - P.predictedDefaultRateBps - 200));
      const cover = Math.floor(P.bondAmount * overshoot / 1000);
      const loss = D.drawnAmount * bps / 10000;
      const jrHit = Math.max(0, Math.min(D.juniorAssets, loss - cover));
      const srHit = Math.max(0, loss - cover - jrHit);
      const timeDiscount = Math.round(800 * s.daysToMaturity / 365);
      const build = (name, hit, principal) => {
        const credit = Math.round((principal - hit) / principal * 10000);
        return {
          tranche: name, fairValueBps: Math.max(0, credit - timeDiscount),
          creditBps: credit, timeDiscountBps: timeDiscount,
          explanation: "Expected loss of " + money(loss) + " on " + money(D.drawnAmount) +
            " drawn at " + bps + " bps. Absorbed: " + money(cover) + " by the operator bond, " +
            money(jrHit) + " by junior, " + money(srHit) + " by senior. The " + name +
            " tranche therefore marks at " + credit + " bps of par on credit, less " + timeDiscount +
            " bps for " + s.daysToMaturity + " days of time value.",
        };
      };
      const pricing = { senior: build("senior", srHit, D.seniorAssets), junior: build("junior", jrHit, D.juniorAssets) };
      X.senior = { fairValueBps: pricing.senior.fairValueBps, updatedAt: Date.now() / 1000, active: true, inventory: X.senior.inventory };
      X.junior = { fairValueBps: pricing.junior.fairValueBps, updatedAt: Date.now() / 1000, active: true, inventory: X.junior.inventory };
      const reasons = {
        deteriorating: "Heliostat and Calder have both moved from net 30 behaviour to net 52 over the " +
          "observation window and are now watchlisted. 41 percent of exposure is past due. Repriced up from 423 bps.",
        stable: "Nothing material has changed since origination, so the prior view holds at 423 bps.",
        improving: "Payment behaviour tightened across all four payers and no exposure is past due. Repriced down from 423 bps.",
      };
      return {
        score: { defaultRateBps: bps, confidenceBps: 8278, source: "deterministic", reasoning: reasons[scenario] },
        expectedBondCover: cover, pricing: pricing, pushed: true, txHashes: [this.hash(), this.hash()],
      };
    }

    if (path === "/api/quote-exit" || path === "/api/exit") {
      const isJunior = body.tranche === "junior";
      const quote = isJunior ? X.junior : X.senior;
      const principal = isJunior ? D.juniorAssets : D.seniorAssets;
      const supply = isJunior ? 200000 : 800000;
      const par = (body.amount || 0) * (principal / supply);
      const fair = par * (quote.active ? quote.fairValueBps : 10000) / 10000;
      const payout = fair * (10000 - X.spreadBps) / 10000;
      const cap = X.cash * X.maxExitBpsOfLiquidity / 10000;

      if (path === "/api/quote-exit") {
        return {
          parValue: par, fairValue: fair, payout: payout, spreadEarned: fair - payout,
          perExitCap: cap, withinCap: payout <= cap, poolCash: X.cash,
        };
      }
      if (!quote.active) throw new Error("NoQuote(). The model has not priced this tranche yet.");
      if (payout > cap) {
        throw new Error("ExitTooLarge(" + Math.round(payout) + ", " + Math.round(cap) +
          "). One exit cannot take more than " + pct(X.maxExitBpsOfLiquidity) + " of pool cash.");
      }
      X.cash -= payout;
      if (isJunior) X.junior.inventory += fair; else X.senior.inventory += fair;
      X.nav = X.cash + X.senior.inventory + X.junior.inventory;
      return {
        parValue: par, fairValue: fair, payout: payout, received: payout, spreadEarned: fair - payout,
        holder: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", txHash: this.hash(), poolCashAfter: X.cash,
      };
    }

    if (path === "/api/resolve") {
      const actual = body.actualDefaultRateBps;
      const threshold = P.predictedDefaultRateBps + 200;
      const slash = actual <= threshold ? 0
        : Math.min(P.bondAmount, P.bondAmount * Math.min(1000, actual - threshold) / 1000);
      if (body.dryRun) return { actualBps: actual, wouldSlash: slash, resolved: false };

      const loss = D.drawnAmount * actual / 10000;
      const fromBond = Math.min(loss, slash);
      const fromJunior = Math.min(loss - fromBond, D.juniorAssets);
      const fromSenior = Math.min(loss - fromBond - fromJunior, D.seniorAssets);
      const before = { senior: D.seniorAssets, junior: D.juniorAssets };
      D.seniorAssets -= fromSenior;
      D.juniorAssets -= fromJunior;
      D.repaidAmount = D.drawnAmount * (10000 - actual) / 10000;
      D.status = "Settled"; D.statusCode = 3;
      P.resolved = true; P.slashed = slash > 0; P.actualDefaultRateBps = actual;
      P.bondSlashed = slash; P.bondReleased = P.bondAmount - slash;
      return {
        actualBps: actual, resolved: true, txHash: this.hash(), slashed: slash,
        before: before, after: { senior: D.seniorAssets, junior: D.juniorAssets },
        waterfall: {
          loss: String(loss), fromBond: String(fromBond),
          fromJunior: String(fromJunior), fromSenior: String(fromSenior),
        },
      };
    }

    throw new Error(
      "Practice data cannot do that yet. Reload to try the live chain again, or use " +
        "a step that does not need a transaction.",
    );
  },
};

export const FQ = {
  /**
   * Practice mode. Global, sticky, and for a while completely silent.
   *
   * This flag lives on the module, so the first page that fails a chain read flips
   * it for the entire session and every later page silently gets fiction instead.
   * Each page tracked its own `isMock` in local state, set only inside its own
   * fallback branch - so a page that never took that branch showed invented numbers
   * with no banner at all.
   *
   * What that looked like: a deployed site telling somebody they were not registered
   * to underwrite, directly above a panel saying they had already published on this
   * deal, with a $130,000 bond and 4.23% expected loss, none of which existed. Every
   * figure fabricated, nothing on screen admitting it.
   *
   * A page cannot be trusted to know this locally. Ask here.
   */
  mock: false,

  isMock() {
    return FQ.mock;
  },

  async call(path, body) {
    if (FQ.mock) return MockBackend.handle(path, body);
    const res = await fetch(path, body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {});
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  },

  async connect() {
    const forced = new URLSearchParams(window.location.search).has("demo");
    try {
      if (forced) throw new Error("demo mode requested");
      const state = await FQ.call("/api/state");
      return { state, isMock: false };
    } catch (err) {
      FQ.mock = true;
      MockBackend.reset();
      return { state: await MockBackend.handle("/api/state"), isMock: true };
    }
  }
};


/**
 * Poll a fetcher on an interval, and pause while the tab is hidden.
 *
 * Firm Quote reads its numbers from a chain that other people are also writing to.
 * Without this the page is a photograph: a deposit made in another tab, or a
 * settlement fired by the operator, never appears until you navigate. Twelve
 * seconds is slower than a block and fast enough that nothing on screen is ever
 * meaningfully stale.
 *
 * The visibility check matters on a free tier: a background tab left open
 * overnight would otherwise make thousands of chain reads for nobody.
 */
export function usePoll(fn, deps = [], ms = 12000) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && document.visibilityState === 'visible') saved.current();
    };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
