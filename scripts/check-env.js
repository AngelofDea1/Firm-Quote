/**
 * Tells you what is in your .env, what is missing, and whether that matters yet.
 *
 *   npm run env:check
 *
 * Never prints a secret. Only whether something is set, and how long it is, which is enough
 * to spot a truncated paste without exposing the value.
 *
 * Grouped by when you actually need each thing, because a wall of thirty variables where
 * twenty-five are optional is how people end up hunting for a project id that does not exist.
 */

const path = require("path");
const fs = require("fs");

const ENV_PATH = path.join(__dirname, "..", ".env");
require("dotenv").config({ path: ENV_PATH });

const has = (k) => Boolean(process.env[k] && String(process.env[k]).trim());
const len = (k) => String(process.env[k] || "").trim().length;

const GROUPS = [
  {
    title: "Run locally",
    note: "Nothing here is required. Local defaults cover all of it.",
    vars: [
      ["NETWORK", "optional", "which deployment to read. defaults to localhost"],
      ["PORT", "optional", "web server port. defaults to 8787"],
    ],
  },
  {
    title: "The AI risk engine",
    note: "Optional, but worth having for a hackathon judged on AI.",
    vars: [
      [
        "ANTHROPIC_API_KEY",
        "recommended",
        "without it the engine uses its deterministic path, which works but is not a language model",
      ],
      ["ANTHROPIC_MODEL", "optional", "defaults to a sensible model"],
    ],
  },
  {
    title: "OKX DEX",
    note: "Three values. There is NO project id on the v6 API.",
    vars: [
      ["OKX_API_KEY", "required for OKX", ""],
      ["OKX_SECRET_KEY", "required for OKX", ""],
      ["OKX_API_PASSPHRASE", "required for OKX", "the one you invented when creating the key"],
      ["OKX_PROJECT_ID", "ignore", "not used by v6, leave blank"],
      ["OKX_BASE_URL", "optional", "defaults to https://web3.okx.com"],
    ],
  },
  {
    title: "Deploying to X Layer testnet",
    note: "This is the next thing you actually need.",
    vars: [
      ["DEPLOYER_PRIVATE_KEY", "required to deploy", "a throwaway wallet, funded with OKB from the faucet"],
      ["XLAYER_TESTNET_RPC", "optional", "defaults to the public endpoint"],
      ["ORACLE_PRIVATE_KEY", "optional", "defaults to the deployer"],
      ["HOLDER_PRIVATE_KEY", "optional", "defaults to the deployer, or a known key on a local chain"],
    ],
  },
  {
    title: "Deploying to X Layer mainnet",
    note: "Only needed on the final deploy.",
    vars: [
      ["SETTLEMENT_TOKEN", "required on mainnet", "real USDC on X Layer. without it a fake token gets deployed"],
      ["XLAYER_RPC", "optional", "defaults to the public endpoint"],
      ["OKLINK_API_KEY", "nice to have", "lets you verify contracts so judges can read the source on the explorer"],
    ],
  },
  {
    title: "Deal parameters",
    note: "All optional. The scripts have sensible defaults for every one.",
    vars: [
      ["ASSET_LABEL", "optional", ""],
      ["MIN_BOND", "optional", ""],
      ["SENIOR_DEPOSIT", "optional", ""],
      ["JUNIOR_DEPOSIT", "optional", ""],
      ["POOL_LIQUIDITY", "optional", ""],
      ["SETTLEMENT_TOKEN", "see mainnet", ""],
    ],
  },
];

const seen = new Set();

console.log(`\n  Reading ${fs.existsSync(ENV_PATH) ? ".env" : "NO .env FILE, run: cp .env.example .env"}\n`);

for (const group of GROUPS) {
  console.log(`  ${group.title}`);
  console.log(`  ${"-".repeat(group.title.length)}`);
  if (group.note) console.log(`  ${group.note}`);
  for (const [key, importance, why] of group.vars) {
    if (seen.has(key) && importance === "see mainnet") continue;
    seen.add(key);
    const set = has(key);
    const mark = set ? "set " : importance.startsWith("required") ? "MISSING" : "    ";
    const detail = set ? `${len(key)} chars` : why || "";
    console.log(`    ${mark.padEnd(8)} ${key.padEnd(22)} ${importance.padEnd(18)} ${detail}`);
  }
  console.log("");
}

// ---- what to do next ------------------------------------------------------
const okxReady = has("OKX_API_KEY") && has("OKX_SECRET_KEY") && has("OKX_API_PASSPHRASE");
const next = [];

if (!okxReady) next.push("Fill in the three OKX values, then run: npm run okx:selftest");
else next.push("OKX is configured. Verify it with: npm run okx:selftest");

if (!has("ANTHROPIC_API_KEY")) {
  next.push(
    "Optional but recommended: add ANTHROPIC_API_KEY so the risk engine runs a real language " +
      "model rather than its deterministic fallback.",
  );
}

if (!has("DEPLOYER_PRIVATE_KEY")) {
  next.push(
    "Add DEPLOYER_PRIVATE_KEY, a throwaway wallet funded with OKB from " +
      "https://www.okx.com/xlayer/faucet, then run: npm run preflight:testnet",
  );
} else {
  next.push("Deployer key is set. Next: npm run preflight:testnet");
}

if (!has("SETTLEMENT_TOKEN")) {
  next.push("Before mainnet only: set SETTLEMENT_TOKEN to real USDC on X Layer.");
}

console.log("  What to do next");
console.log("  ---------------");
next.forEach((n, i) => console.log(`    ${i + 1}. ${n}`));
console.log("");
