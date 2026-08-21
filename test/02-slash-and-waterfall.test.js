const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySystem, settleAt, asContract, USDC, ASSET_ID } = require("./helpers");

/**
 * Loss-absorption ordering is the single most bug-prone part of this system, so it gets
 * exhaustive coverage rather than one happy path.
 *
 * Standing setup: senior 800k, junior 200k, 1m drawn, predicted default 200bps,
 * tolerance 200bps, full slash at 1000bps of error past tolerance.
 */
describe("UnderwriterVault - the bond is the score", function () {
  it("requires a bond scaled by the gate's multiplier", async function () {
    const { underwriterVault, underwriter, counterparty, usdc } = await deploySystem({ postPrediction: false });

    const required = await underwriterVault.requiredBondFor(underwriter.address, counterparty.address);
    expect(required).to.equal(USDC(130_000)); // 50k base * 2.6x for a green underwriter

    const short = required - 1n;
    await usdc.connect(underwriter).approve(await underwriterVault.getAddress(), short);
    await expect(
      underwriterVault
        .connect(underwriter)
        .postPrediction(ASSET_ID, counterparty.address, 200n, 7_500n, ethers.ZeroHash, "fq-risk-v1", short),
    )
      .to.be.revertedWithCustomError(underwriterVault, "BondTooSmall")
      .withArgs(short, required);
  });

  it("locks the bond and records the model's reasoning hash onchain", async function () {
    const { underwriterVault, usdc, underwriter, requiredBond } = await deploySystem();
    const p = await underwriterVault.getPrediction(ASSET_ID);

    expect(p.underwriter).to.equal(underwriter.address);
    expect(p.predictedDefaultRateBps).to.equal(200n);
    expect(p.reasoningHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes("model reasoning v1")));
    expect(p.modelVersion).to.equal("fq-risk-v1");
    expect(await usdc.balanceOf(await underwriterVault.getAddress())).to.equal(requiredBond);
  });

  it("slashes nothing inside the tolerance band, proportionally past it, everything at the cap", async function () {
    const { underwriterVault, requiredBond } = await deploySystem();
    const preview = (bps) => underwriterVault.previewSlash(ASSET_ID, bps);

    expect(await preview(0n)).to.equal(0n); // better than predicted
    expect(await preview(200n)).to.equal(0n); // exactly predicted
    expect(await preview(400n)).to.equal(0n); // edge of the 200bps grace band
    expect(await preview(500n)).to.equal(requiredBond / 10n); // 100bps of error -> 10%
    expect(await preview(900n)).to.equal(requiredBond / 2n); // 500bps of error -> 50%
    expect(await preview(1_400n)).to.equal(requiredBond); // 1000bps of error -> all of it
    expect(await preview(10_000n)).to.equal(requiredBond); // capped, never more than the bond
  });

  it("returns the whole bond when the model called it right", async function () {
    const sys = await deploySystem();
    const { usdc, underwriter, underwriterVault, gate, requiredBond } = sys;
    const before = await usdc.balanceOf(underwriter.address);

    await settleAt(sys, 300n); // inside tolerance

    const p = await underwriterVault.getPrediction(ASSET_ID);
    expect(p.slashed).to.equal(false);
    expect(p.bondReleased).to.equal(requiredBond);
    expect(await usdc.balanceOf(underwriter.address)).to.equal(before + requiredBond);

    // And the track record improves.
    const profile = await gate.profiles(underwriter.address);
    expect(profile.trackRecordScore).to.equal(2_750n);
    expect(profile.slashedCount).to.equal(0n);
  });

  it("slashes the bond into the waterfall when reality comes in worse", async function () {
    const sys = await deploySystem();
    const { underwriterVault, trancheVault, gate, underwriter, requiredBond } = sys;

    await settleAt(sys, 1_000n); // 600bps of error -> 60% of the bond

    const expectedSlash = (requiredBond * 600n) / 1_000n;
    const p = await underwriterVault.getPrediction(ASSET_ID);
    expect(p.slashed).to.equal(true);
    expect(p.bondSlashed).to.equal(expectedSlash);
    expect(p.bondReleased).to.equal(requiredBond - expectedSlash);

    const profile = await gate.profiles(underwriter.address);
    expect(profile.slashedCount).to.equal(1n);
    expect(await trancheVault.status()).to.equal(3n); // Settled
  });

  it("refuses a second resolution", async function () {
    const sys = await deploySystem();
    await settleAt(sys, 500n);
    await expect(sys.underwriterVault.resolveOutcome(ASSET_ID, 500n)).to.be.revertedWithCustomError(
      sys.underwriterVault,
      "AlreadyResolved",
    );
  });

  it("only the oracle may resolve", async function () {
    const sys = await deploySystem();
    await expect(
      sys.underwriterVault.connect(sys.badActor).resolveOutcome(ASSET_ID, 5_000n),
    ).to.be.revertedWithCustomError(sys.underwriterVault, "NotOracle");
  });
});

describe("TrancheVault - loss absorption ordering: bond, then junior, then senior", function () {
  // Invariant that must hold after every settlement: the cash in the vault is exactly what
  // the two tranches are collectively owed. If this drifts, someone is getting shorted.
  async function expectCashInvariant(trancheVault) {
    expect(await trancheVault.cashSurplus()).to.equal(0n);
  }

  it("bond absorbs the whole loss and the surplus goes to junior, senior untouched", async function () {
    // 520k bond against a 50k loss - the operator over-collateralised the miss.
    const sys = await deploySystem({ minBond: USDC(200_000) });
    const { trancheVault } = sys;
    expect(sys.requiredBond).to.equal(USDC(520_000));

    const tx = await settleAt(sys, 500n); // loss 50k, slash 52k

    await expect(tx.tx)
      .to.emit(trancheVault, "LossSettled")
      .withArgs(USDC(50_000), USDC(50_000), 0n, 0n);
    await expect(tx.tx).to.emit(trancheVault, "BondSurplusToJunior").withArgs(USDC(2_000));

    expect(await trancheVault.seniorAssets()).to.equal(USDC(800_000)); // never touched
    expect(await trancheVault.juniorAssets()).to.equal(USDC(202_000)); // principal + surplus
    await expectCashInvariant(trancheVault);
  });

  it("bond is exhausted first, junior takes the remainder, senior still untouched", async function () {
    const sys = await deploySystem(); // 130k bond
    const { trancheVault } = sys;

    const tx = await settleAt(sys, 1_000n); // loss 100k, slash 78k

    await expect(tx.tx)
      .to.emit(trancheVault, "LossSettled")
      .withArgs(USDC(100_000), USDC(78_000), USDC(22_000), 0n);

    expect(await trancheVault.seniorAssets()).to.equal(USDC(800_000));
    expect(await trancheVault.juniorAssets()).to.equal(USDC(178_000));
    await expectCashInvariant(trancheVault);
  });

  it("junior is wiped to zero before a single unit touches senior", async function () {
    const sys = await deploySystem();
    const { trancheVault } = sys;

    const tx = await settleAt(sys, 4_000n); // loss 400k, full slash 130k

    await expect(tx.tx)
      .to.emit(trancheVault, "LossSettled")
      .withArgs(USDC(400_000), USDC(130_000), USDC(200_000), USDC(70_000));

    expect(await trancheVault.juniorAssets()).to.equal(0n);
    expect(await trancheVault.seniorAssets()).to.equal(USDC(730_000));
    await expectCashInvariant(trancheVault);
  });

  it("survives a total default without underflowing", async function () {
    const sys = await deploySystem();
    const { trancheVault } = sys;

    await settleAt(sys, 10_000n); // everything defaults

    expect(await trancheVault.juniorAssets()).to.equal(0n);
    expect(await trancheVault.seniorAssets()).to.equal(USDC(130_000)); // the bond is all that is left
    await expectCashInvariant(trancheVault);
  });

  it("clamps a loss larger than the entire capital stack instead of reverting", async function () {
    const sys = await deploySystem();
    const { trancheVault, underwriterVault } = sys;

    // Drive settleLoss directly with an absurd number, as only the UnderwriterVault can.
    await asContract(await underwriterVault.getAddress(), async (signer) => {
      await trancheVault.connect(signer).settleLoss(USDC(999_999_999));
    });

    expect(await trancheVault.seniorAssets()).to.equal(0n);
    expect(await trancheVault.juniorAssets()).to.equal(0n);
  });

  it("never lets senior exceed its ratio cap - first-loss capital must exist", async function () {
    const { trancheVault, senior, usdc, seniorLp } = await deploySystem({
      postPrediction: false,
      fund: false,
      juniorDeposit: USDC(200_000),
      seniorDeposit: USDC(800_000),
    });

    // The stack sits exactly on the 80% cap.
    expect((await trancheVault.seniorAssets()) * 10_000n / (await trancheVault.totalTrancheAssets())).to.equal(8_000n);

    // Any senior deposit that pushes it past 80% without matching junior capital is refused.
    await usdc.connect(seniorLp).approve(await senior.getAddress(), USDC(1_000));
    await expect(senior.connect(seniorLp).deposit(USDC(1_000), seniorLp.address)).to.be.revertedWithCustomError(
      trancheVault,
      "SeniorTooThick",
    );
  });

  it("refuses to fund a deal with no junior capital underneath it", async function () {
    const { trancheVault } = await deploySystem({
      postPrediction: false,
      fund: false,
      juniorDeposit: 0n,
      seniorDeposit: 0n,
    });
    await expect(trancheVault.fund(USDC(1))).to.be.revertedWith("bad drawdown");
  });

  it("only the UnderwriterVault can push bond proceeds or settle", async function () {
    const { trancheVault, badActor } = await deploySystem();
    await expect(trancheVault.connect(badActor).settleLoss(USDC(1))).to.be.revertedWithCustomError(
      trancheVault,
      "OnlyUnderwriterVault",
    );
    await expect(trancheVault.connect(badActor).receiveBondProceeds(USDC(1))).to.be.revertedWithCustomError(
      trancheVault,
      "OnlyUnderwriterVault",
    );
  });
});

describe("TrancheShare - holders are genuinely locked until maturity", function () {
  it("reports zero redeemable while the deal is funded, which is why the exit pool exists", async function () {
    const { senior, junior, seniorLp, juniorLp } = await deploySystem();

    expect(await senior.maxRedeem(seniorLp.address)).to.equal(0n);
    expect(await junior.maxRedeem(juniorLp.address)).to.equal(0n);

    await expect(
      senior.connect(seniorLp).redeem(USDC(1), seniorLp.address, seniorLp.address),
    ).to.be.revertedWithCustomError(senior, "ERC4626ExceededMaxRedeem");
  });

  it("opens redemption after settlement, at a share price that reflects the loss", async function () {
    const sys = await deploySystem();
    const { senior, junior, seniorLp, juniorLp, usdc } = sys;

    await settleAt(sys, 1_000n); // junior drops from 200k to 178k

    expect(await junior.maxRedeem(juniorLp.address)).to.be.greaterThan(0n);

    const shares = await junior.balanceOf(juniorLp.address);
    const before = await usdc.balanceOf(juniorLp.address);
    await junior.connect(juniorLp).redeem(shares, juniorLp.address, juniorLp.address);
    const received = (await usdc.balanceOf(juniorLp.address)) - before;

    // Junior ate the 22k the bond could not cover.
    expect(received).to.be.closeTo(USDC(178_000), USDC(1));

    // Senior comes out whole.
    const sShares = await senior.balanceOf(seniorLp.address);
    const sBefore = await usdc.balanceOf(seniorLp.address);
    await senior.connect(seniorLp).redeem(sShares, seniorLp.address, seniorLp.address);
    expect((await usdc.balanceOf(seniorLp.address)) - sBefore).to.be.closeTo(USDC(800_000), USDC(1));
  });

  describe("the deal that repays in full", function () {
    /**
     * Gap found in an audit. Every settlement test used a non-zero default rate, so
     * settleLoss ran every time and settleClean, the branch taken when nothing
     * defaults at all, had never executed in the suite. That branch is half the
     * pitch: it is what happens when the model was right and the borrower paid.
     */
    it("returns the whole bond, settles clean, and hands the bond cover to junior", async function () {
      const sys = await deploySystem();
      const uw = sys.underwriter.address;

      const bondBefore = await sys.usdc.balanceOf(uw);
      const juniorBefore = await sys.trancheVault.juniorAssets();

      await settleAt(sys, 0n); // nothing defaulted

      const p = await sys.underwriterVault.getPrediction(ASSET_ID);
      expect(p.slashed, "a correct call must not be slashed").to.equal(false);
      expect(p.bondSlashed).to.equal(0n);
      expect(
        await sys.usdc.balanceOf(uw),
        "the whole bond comes back",
      ).to.equal(bondBefore + sys.requiredBond);

      expect(await sys.trancheVault.status(), "deal is settled").to.equal(3n);
      expect(
        await sys.trancheVault.juniorAssets(),
        "bond cover is released to junior, not stranded in the vault",
      ).to.be.greaterThanOrEqual(juniorBefore);
      expect(await sys.trancheVault.cashSurplus(), "no cash left unaccounted for").to.equal(0n);
    });

    it("counts a clean resolve as a win in the reputation gate", async function () {
      const sys = await deploySystem();
      const before = await sys.gate.checkEligibilityDetailed(
        sys.underwriter.address,
        sys.counterparty.address,
      );

      await settleAt(sys, 0n);

      const after = await sys.gate.checkEligibilityDetailed(
        sys.underwriter.address,
        sys.counterparty.address,
      );
      expect(after[0]).to.equal(true);
      expect(after[1], "being right makes the next bond cheaper").to.be.lessThan(before[1]);
    });
  });

});
