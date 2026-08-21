# Firm Quote

### AI credit opinions that are firm, not indicative.

**Staked AI underwriting + AI-priced exit liquidity for tokenised real-world credit.**

In trading, a *firm quote* is a price the dealer is obligated to honour. An *indicative* quote is just an opinion with no obligation behind it. **Every AI risk score in RWA today is indicative** - a number in a UI that costs its author nothing if it is wrong.

Firm Quote makes the model put its own money behind the number.

- **Firm on the score.** The operator who runs the model locks collateral before the deal opens. If the model is wrong by enough, that collateral is slashed automatically and paid to investors first - before any of them lose a cent.
- **Firm on the exit.** Tranche holders are locked until maturity by design. A standing AI-priced buyback pool gives them a real exit price on any day, no matching buyer needed.

**Live on X Layer testnet - chain 1952.**

Try it: **https://firm-quote.onrender.com**

---

## What to look at first

### The settled deal (the whole point in one screen)

1. Go to **https://firm-quote.onrender.com**
2. Click **Start investing** → **Ferrous Metals Trading**
3. The chip reads *Settled*. Look at three numbers together: *Model says 6.00%*, *actual 24.00%*, *Operator lost $130,000*

The model called six percent unpaid. Reality came back at twenty-four. The operator's bond was slashed in full, automatically, by the contract - and paid to investors before junior or senior lost a single dollar.

That is what *firm* means.

### The live deal

Click **Northwind Logistics**. Status: *Active*. The model called 8% unpaid and the operator has $130,000 locked in the contract right now. Investors can buy senior or junior tranche tokens. Either can be sold back to the exit pool at any time - priced by the same AI model.

Scroll to **Need out early?** and get a quote. Senior and junior price differently. That gap is the model's real-time read on where the loss risk sits.

### The underwriter side

Click **Underwrite** in the navbar. This is what the operator sees: score a deal, review the reasoning, stake the bond. A reputation gate decides what bond multiple they have to post - clean track record, lower multiple. New operator, higher multiple.

---

## Run it locally

### Just the website (no chain needed)

```bash
npm install
npm run site:install
npm run site:build
npm start
```

Open **http://localhost:8787**. No wallet, no keys, no config. Every control works on clearly labelled simulated data.

### Against a local chain

```bash
# terminal 1
npm run chain

# terminal 2
npm run setup:local
npm start
```

A banner tells you which mode you are in so you can never demo simulated numbers thinking they are real.

### Against X Layer testnet (chain 1952)

```bash
cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY and RPC_URL
npm run preflight:testnet
npm run deploy:testnet
npm run seed:testnet
npm start
```

Gas is OKB, not ETH. Fund the deployer from the X Layer faucet first.

---

## Architecture

```
        stubbed invoice feed  (real-shaped, clearly labelled)
                  |
                  v
    +---------------------------+
    |       RISK ENGINE         |   one scoring core
    |  riskEngine.scoreAsset()  |   mode: "underwrite" | "reprice"
    +---------------------------+
         |                    |
    underwrite              reprice
         |                    |
         v                    v
  ReputationGate         fair value per tranche
    (eligible?)                |
         | pass                v
         v              ExitLiquidityPool  <-- LPs deposit here
  UnderwriterVault        (ERC-4626)
   - locks the bond            |  buys tranche tokens at
   - records prediction        |  the AI's price, instantly
   - slashes on a miss         |
         |                     |
         v                     |
    TrancheVault  <------------+ redeems inventory at maturity
    (accountant, owns the waterfall)
      |            |
   Senior       Junior     <-- two real ERC-4626 vaults
```

### Contracts

| Contract | Job |
|---|---|
| `ReputationGate.sol` | Decides who may underwrite and at what bond multiple. Four heuristics, each with a machine-readable rejection reason. |
| `UnderwriterVault.sol` | Locks the bond, records the prediction and its reasoning hash, slashes proportionally when reality comes in worse. |
| `TrancheVault.sol` | Holds the cash, owns the loss waterfall (bond → junior → senior), runs the deal lifecycle. |
| `TrancheShare.sol` | One ERC-4626 vault per tranche class, both delegating NAV to the accountant. |
| `ExitLiquidityPool.sol` | The standing bid. ERC-4626 for LPs, AI-priced buyouts, three independent safety caps. |

Five contracts, not four. ERC-4626 is single-share-class by construction - you cannot make one compliant vault represent both senior and junior. `TrancheVault` is the accountant; two compliant `TrancheShare` vaults sit on top.

### Three decisions worth reading

**1. Holders are genuinely locked.** `maxRedeem` and `maxWithdraw` return zero on both tranches while the deal is funded. Not discouraged. Impossible. That is what makes the exit pool a real liquidity venue instead of a convenience feature.

**2. Slashing is proportional and fits in one sentence.**

```
error   = actual - (predicted + tolerance)
slashed = bond × min(error, 1000bps) / 1000bps
```

Underestimate defaults by ten percentage points past the tolerance band and you lose the entire bond.

**3. The bond is only cover to the extent it would actually be slashed.** If credit deteriorates exactly as predicted, the underwriter was right, nothing is slashed, and junior eats the loss alone. Exit pricing mirrors `previewSlash()` exactly - which is why senior and junior quote at genuinely different prices.

---

## The AI layer

`scoreAsset({ mode })` is one function, two modes. `"underwrite"` looks at the batch at origination. `"reprice"` looks at a fresher observation and takes the prior score as context. Same feature extraction, same prompt skeleton, same output contract.

Every call returns `{ defaultRateBps, confidenceBps, reasoning, features, breakdown }`. The reasoning is committed onchain as a keccak256 hash alongside the prediction.

**The deterministic path is real, not a stub.** Without an `ANTHROPIC_API_KEY` the engine scores with a transparent additive model over the same features. It also acts as a guardrail: a model output more than 1500bps from the baseline gets clamped, and the response says so. The demo cannot die because the wifi did.

---

## Exit pricing

```
par value  = trancheToken.previewRedeem(amount)
fair value = par × fairValueBps / 10000
payout     = fair × (10000 - spreadBps) / 10000
```

**Three safety properties:**

- Stale quotes cannot be traded against - older than 15 minutes and `requestExit` reverts.
- No single exit takes more than 20% of the pool's cash.
- No tranche exceeds 40% of pool NAV.

---

## Disclosed simplifications

| What | Current state | Path to production |
|---|---|---|
| Invoice data | Stubbed, real-shaped (`backend/src/data/invoices.js`) | Swap that one file for a Codat / ERP pull |
| Outcome oracle | Manual for demo (`resolveOutcome` is role-gated) | Chainlink Functions or multi-attestor service |
| Gate signals | Pushed by trusted attestor | ZK proof of the graph query |
| Settlement token | Mock USDC on testnet | Point `SETTLEMENT_TOKEN` at real USDC on X Layer mainnet |

The bond, the slash, the waterfall, the tranche locking, the exit pricing and every cap are real onchain logic with no simulation in the path.

---

## Status

| | |
|---|---|
| Contracts | 5 written, deployed to X Layer testnet (chain 1952) |
| Tests | 49 passing - waterfall ordering, exit-pool drain caps, clean-settlement path, reputation recovery curve, invariant sweeps across the full 0-100% default range |
| Risk engine | One scoring core, two modes, LLM + deterministic fallback, both working |
| Backend | Running on Render, all routes wired |
| Frontend | Eight-page site - landing, invest, how it works, earn, underwrite, FAQ, privacy, terms |
| Live URL | https://firm-quote.onrender.com |

---

## API

| Route | Does |
|---|---|
| `GET /api/deals` | All deals and their current state |
| `GET /api/state` | Full system state - everything the UI renders |
| `GET /api/gate-check?uw=&cp=` | Eligibility check with rejection reason, no gas |
| `POST /api/underwrite` | Model 1 → score + post prediction + lock bond (`{dryRun:true}` to just score) |
| `POST /api/reprice` | Model 2 → fresh fair value per tranche → push quotes onchain |
| `POST /api/quote-exit` | Live exit quote, pure read |
| `POST /api/exit` | Execute exit for a holder |
| `POST /api/resolve` | Report outcome - slash and waterfall fire in one transaction |

---

## Layout

```
contracts/          5 Solidity contracts + interfaces + mock ERC-20
test/               49 tests across gate, slash/waterfall, exit liquidity, invariants
scripts/
  deploy.js         deploys and writes deployments/<network>.json
  deals.js          deal management utilities
  preflight.js      pre-deploy checks - chain ID, funding, gas, contract size
backend/src/
  riskEngine.js     one scoring core, both modes, exit pricing
  chain.js          contract handles + readSystemState() for the UI
  orchestrator.js   zero-dependency HTTP API, serves the frontend
  data/invoices.js  the stubbed feed - the only file to swap for real data
frontend-react/     React + Vite, hash routed
  index.html        title, meta, social preview, fonts
  src/App.jsx       navbar, footer, home page, mechanics, liquidity, FAQ, routing
  src/pages/Invest.jsx      investor surface - deals, deposit, early exit
  src/pages/Underwrite.jsx  operator surface - score, stake, settle
  src/pages/Legal.jsx       privacy policy and terms with full risk disclosure
  src/api.js        API client + simulated backend for when no chain is running
deployments/
  xlayerTestnet.json  live contract addresses on chain 1952
```

Hash routing: `#home`, `#invest`, `#mechanics`, `#liquidity`, `#risk`, `#knowledge`, `#privacy`, `#terms`. No server-side routing needed. Deep links work from any static host.
