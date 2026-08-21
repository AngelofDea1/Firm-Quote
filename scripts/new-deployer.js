/**
 * Creates a fresh throwaway wallet for deploying, and writes the key straight into .env.
 *
 *   npm run wallet:new
 *
 * Why a script rather than clicking around MetaMask: the key goes directly into the file and
 * is never printed, so it does not end up in your terminal scroll-back, your clipboard, or a
 * screenshot. Only the public address is shown, which is the part you need in order to fund it.
 *
 * This wallet is for testnet and for a hackathon deployment. Do not put real money in it.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ENV_PATH = path.join(__dirname, "..", ".env");
const KEY = "DEPLOYER_PRIVATE_KEY";
const force = process.argv.includes("--force");

if (!fs.existsSync(ENV_PATH)) {
  console.error(`\n  No .env file found. Run this first:\n    cp .env.example .env\n`);
  process.exit(1);
}

let env = fs.readFileSync(ENV_PATH, "utf8");
const existing = env.match(new RegExp(`^${KEY}=(.*)$`, "m"));

if (existing && existing[1].trim() && !force) {
  const addr = (() => {
    try {
      return new ethers.Wallet(existing[1].trim()).address;
    } catch {
      return "unreadable, the value may be malformed";
    }
  })();
  console.log(`\n  ${KEY} is already set.`);
  console.log(`  Its address is ${addr}`);
  console.log(`\n  Nothing changed. To replace it anyway, and lose access to that wallet:`);
  console.log(`    npm run wallet:new -- --force\n`);
  process.exit(0);
}

const wallet = ethers.Wallet.createRandom();

if (existing) {
  env = env.replace(new RegExp(`^${KEY}=.*$`, "m"), `${KEY}=${wallet.privateKey}`);
} else {
  env += `\n${KEY}=${wallet.privateKey}\n`;
}
fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });

console.log(`\n  New deployer wallet created and written to .env`);
console.log(`  The private key was not printed. It is only in that file, which git ignores.\n`);
console.log(`  Address:  ${wallet.address}\n`);
console.log(`  Next, fund it with OKB. Not ETH, and not from an Ethereum faucet:`);
console.log(`    https://www.okx.com/xlayer/faucet\n`);
console.log(`  Paste the address above into the faucet, wait for it to land, then run:`);
console.log(`    npm run preflight:testnet\n`);
