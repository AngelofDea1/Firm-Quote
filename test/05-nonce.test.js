const { expect } = require("chai");
const path = require("path");
const fs = require("fs");

/**
 * One address has one nonce, so the backend must model it with one counter.
 *
 * connect() is called once per deal. Each call used to build its own NonceManager
 * around the same private key, so four deals meant four independent counters
 * signing from a single address. Write to two deals in a session and they drifted;
 * the next write died with "Nonce too low. Expected 60 but got 58."
 *
 * The serialize() write lock could never have caught this. It orders execution,
 * but the counters were already fragmented before anything queued.
 */
describe("Backend signer", function () {
  it("shares one nonce manager across every deal context", async function () {
    const chainPath = path.join(__dirname, "..", "backend", "src", "chain.js");
    const src = fs.readFileSync(chainPath, "utf8");

    expect(src, "connect must not construct a NonceManager inline").to.not.match(
      /const signer = pk \? new ethers\.NonceManager/,
    );
    expect(src, "it must go through the memoised helper").to.match(/sharedSigner\(pk, url, provider\)/);
    expect(src, "and the helper must cache").to.match(/signerCache/);
  });

  it("returns the identical signer object for two different deals", async function () {
    const deployment = path.join(__dirname, "..", "deployments", "localhost.json");
    if (!fs.existsSync(deployment)) return this.skip();
    const d = JSON.parse(fs.readFileSync(deployment, "utf8"));
    if (!d.deals || d.deals.length < 2) return this.skip();

    // Load fresh so the module cache does not hide a per-call construction.
    delete require.cache[require.resolve("../backend/src/chain")];
    const { connect } = require("../backend/src/chain");

    const a = connect({ networkName: "localhost", dealId: d.deals[0].id });
    const b = connect({ networkName: "localhost", dealId: d.deals[1].id });

    expect(a.deal.id, "two different deals").to.not.equal(b.deal.id);
    expect(a.signer, "but one signer").to.equal(b.signer);
  });

  /**
   * The bill for sharing one counter, which the fix above did not pay.
   *
   * NonceManager counts optimistically: it hands out a nonce and increments at
   * once, assuming the transaction lands. When one does not - a revert, a failed
   * gas estimate, a dropped send - the chain's nonce never moves but the manager's
   * has, and every write after that is one too high. "Nonce too high. Expected 60
   * but got 61."
   *
   * With a counter per deal that desynchronised one deal. With a shared counter it
   * poisons the whole process, so a harmless AlreadyRegistered silently breaks the
   * next unrelated thing the user tries. serialize() must reset on failure.
   */
  it("resets the shared nonce when a write fails", async function () {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "backend", "src", "orchestrator.js"),
      "utf8",
    );
    const serialize = src.slice(src.indexOf("function serialize("));
    const body = serialize.slice(0, serialize.indexOf("\nconst server"));

    expect(body, "serialize must reset the signer when a write hits nonce trouble").to.match(
      /catch[\s\S]*signer\?\.reset\?\.\(\)/,
    );
    expect(body, "and must still rethrow anything that is not about the nonce").to.match(
      /NONCE_SHAPED\.test\(text\)[\s\S]*throw err/,
    );
    expect(
      body,
      "resetting after a guard rejection discards a correct count for a possibly stale one",
    ).to.match(/err\.status\) throw err/);
  });
});
