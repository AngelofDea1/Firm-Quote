const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySystem, GateReason, FUNDING_ROOT_A, mineBlocks } = require("./helpers");

describe("ReputationGate - who is even allowed to underwrite", function () {
  it("turns away a wallet that was never registered", async function () {
    const { gate, counterparty, badActor } = await deploySystem();
    const [eligible, , reason] = await gate.checkEligibilityDetailed(badActor.address, counterparty.address);
    expect(eligible).to.equal(false);
    expect(reason).to.equal(GateReason.NotRegistered);
  });

  // This is demo step 2. It has to work on stage.
  it("turns away a wallet flagged for collusion", async function () {
    const { gate, underwriter, counterparty } = await deploySystem();
    expect((await gate.checkEligibilityDetailed(underwriter.address, counterparty.address))[0]).to.equal(true);

    await gate.setCollusionFlag(underwriter.address, true, "funding ring detected offchain");

    const [eligible, , reason] = await gate.checkEligibilityDetailed(underwriter.address, counterparty.address);
    expect(eligible).to.equal(false);
    expect(reason).to.equal(GateReason.FlaggedForCollusion);
  });

  it("turns away a freshly minted wallet, and lets it through once it has aged", async function () {
    const { gate, counterparty, badActor } = await deploySystem({
      minWalletAgeBlocks: 500n,
      postPrediction: false, // nobody is old enough to underwrite yet, which is the point
    });
    await gate.register(badActor.address);

    let [eligible, , reason] = await gate.checkEligibilityDetailed(badActor.address, counterparty.address);
    expect(eligible).to.equal(false);
    expect(reason).to.equal(GateReason.WalletTooYoung);

    await mineBlocks(600);

    [eligible, , reason] = await gate.checkEligibilityDetailed(badActor.address, counterparty.address);
    expect(eligible).to.equal(true);
    expect(reason).to.equal(GateReason.Eligible);
  });

  it("turns away an underwriter whose funds trace to the same root as the counterparty", async function () {
    const { gate, counterparty, badActor } = await deploySystem();
    await gate.register(badActor.address);
    await gate.attestSignals(badActor.address, 0, FUNDING_ROOT_A);
    // Point the counterparty at the same funding root: one actor, two wallets.
    await gate.attestSignals(counterparty.address, 0, FUNDING_ROOT_A);

    const [eligible, , reason] = await gate.checkEligibilityDetailed(badActor.address, counterparty.address);
    expect(eligible).to.equal(false);
    expect(reason).to.equal(GateReason.SharedFundingSource);
  });

  it("turns away the same underwriter/counterparty pair once it repeats too often", async function () {
    const { gate, owner, underwriter, counterparty } = await deploySystem({ postPrediction: false });
    // Impersonate a consumer to drive pair history directly.
    await gate.setConsumer(owner.address, true);

    for (let i = 0; i < 3; i++) {
      expect((await gate.checkEligibilityDetailed(underwriter.address, counterparty.address))[0]).to.equal(true);
      await gate.recordUnderwriting(underwriter.address, counterparty.address);
    }

    const [eligible, , reason] = await gate.checkEligibilityDetailed(underwriter.address, counterparty.address);
    expect(eligible).to.equal(false);
    expect(reason).to.equal(GateReason.RepeatedCounterparty);
  });

  it("prices the bond off the track record, and never forgives a slash", async function () {
    const { gate, owner, underwriter } = await deploySystem({ postPrediction: false });
    await gate.setConsumer(owner.address, true);

    // Registration score 2000 of 10000 -> 3.0x band, minus 20% of the 2.0x spread = 2.6x
    expect(await gate.bondMultiplierBps(underwriter.address)).to.equal(26_000n);

    // Clean resolutions push the score up and the required bond down.
    for (let i = 0; i < 4; i++) await gate.recordResolution(underwriter.address, false);
    const afterCleanRuns = await gate.bondMultiplierBps(underwriter.address);
    expect(afterCleanRuns).to.be.lessThan(26_000n);

    // A slash costs score AND attaches a permanent surcharge on top.
    await gate.recordResolution(underwriter.address, true);
    const afterSlash = await gate.bondMultiplierBps(underwriter.address);
    expect(afterSlash).to.be.greaterThan(afterCleanRuns + 5_000n - 1n);

    // Even a perfect run from here never gets them back to a clean underwriter's price.
    for (let i = 0; i < 20; i++) await gate.recordResolution(underwriter.address, false);
    expect(await gate.bondMultiplierBps(underwriter.address)).to.equal(10_000n + 5_000n);
  });

  it("only lets approved consumers mutate reputation", async function () {
    const { gate, underwriter, badActor } = await deploySystem();
    await expect(gate.connect(badActor).recordResolution(underwriter.address, true)).to.be.revertedWithCustomError(
      gate,
      "NotConsumer",
    );
  });

  it("blocks a prediction from an ineligible underwriter at the vault, not just in the UI", async function () {
    const { gate, usdc, underwriterVault, underwriter, counterparty } = await deploySystem({ postPrediction: false });
    await gate.setCollusionFlag(underwriter.address, true, "demo");

    const bond = ethers.parseUnits("500000", 6);
    await usdc.connect(underwriter).approve(await underwriterVault.getAddress(), bond);

    await expect(
      underwriterVault
        .connect(underwriter)
        .postPrediction(
          ethers.keccak256(ethers.toUtf8Bytes("other")),
          counterparty.address,
          200n,
          7_500n,
          ethers.ZeroHash,
          "fq-risk-v1",
          bond,
        ),
    )
      .to.be.revertedWithCustomError(underwriterVault, "NotEligible")
      .withArgs(GateReason.FlaggedForCollusion);
  });

  describe("recovering from a slash", function () {
    /**
     * Regression. scoreLossPerSlash used to be 3000 against a registrationScore of
     * 2000, so a first slash floored the score at zero, zero sits below
     * minScoreToUnderwrite, and the only way to earn score back is a clean resolve,
     * which requires underwriting, which requires being above the floor. One bad
     * call ended an underwriter permanently. Nothing in the tests noticed, because
     * nothing ever slashed and then looked again.
     */
    it("leaves a once-slashed underwriter able to trade again, at a worse price", async function () {
      const { gate, owner, underwriter, counterparty } = await deploySystem({ postPrediction: false });
      await gate.setConsumer(owner.address, true);

      const before = await gate.checkEligibilityDetailed(underwriter.address, counterparty.address);
      expect(before[0]).to.equal(true);

      await gate.recordResolution(underwriter.address, true); // slashed

      const after = await gate.checkEligibilityDetailed(underwriter.address, counterparty.address);
      expect(after[0], "a single slash must not be a permanent ban").to.equal(true);
      expect(after[1], "but it must cost them, in bond multiplier").to.be.greaterThan(before[1]);
    });

    it("does lock out an underwriter who is slashed twice", async function () {
      const { gate, owner, underwriter, counterparty } = await deploySystem({ postPrediction: false });
      await gate.setConsumer(owner.address, true);
      await gate.recordResolution(underwriter.address, true);
      await gate.recordResolution(underwriter.address, true);

      const [ok, , reason] = await gate.checkEligibilityDetailed(underwriter.address, counterparty.address);
      expect(ok).to.equal(false);
      expect(reason).to.equal(GateReason.ScoreTooLow);
    });

    it("refuses a scoring policy where one slash would be unrecoverable", async function () {
      const { gate } = await deploySystem({ postPrediction: false });
      await expect(gate.setScoring(2_000, 750, 3_000)).to.be.revertedWith(
        "a first slash would be unrecoverable",
      );
      await expect(gate.setScoring(2_000, 750, 1_000)).to.not.be.reverted;
    });
  });

});
