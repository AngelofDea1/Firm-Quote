const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySystem, settleAt, USDC, ASSET_ID } = require("./helpers");

/**
 * Invariant sweeps.
 *
 * The other suites assert specific scenarios. These walk the whole input range and
 * assert the properties that must hold at every point, because a waterfall that is
 * correct at 5% and 40% but wrong at 23% is still a broken waterfall.
 */
describe("Invariants across the whole loss range", function () {
  it("never touches senior while junior still has capital, at any default rate", async function () {
    // Step across the entire 0 to 100 percent range rather than picking three numbers.
    for (let bps = 0; bps <= 10_000; bps += 500) {
      const sys = await deploySystem();
      const jrBefore = await sys.trancheVault.juniorAssets();
      const srBefore = await sys.trancheVault.seniorAssets();

      await settleAt(sys, BigInt(bps));

      const jrAfter = await sys.trancheVault.juniorAssets();
      const srAfter = await sys.trancheVault.seniorAssets();
      const srHit = srBefore - srAfter;

      if (srHit > 0n) {
        expect(
          jrAfter,
          `senior lost at ${bps}bps while junior still held ${jrAfter}`,
        ).to.equal(0n);
      }
      // Junior can end up richer than it started, because a bond that over-covers
      // the loss is credited to junior rather than left stranded in the vault.
      void jrBefore;
    }
  });

  it("conserves value: every unit of loss is absorbed by exactly one layer", async function () {
    for (const bps of [300, 1_000, 2_500, 5_000, 7_500, 10_000]) {
      const sys = await deploySystem();
      const jr0 = await sys.trancheVault.juniorAssets();
      const sr0 = await sys.trancheVault.seniorAssets();

      const { tx } = await settleAt(sys, BigInt(bps));
      const receipt = await tx.wait();

      const settled = receipt.logs
        .map((l) => { try { return sys.trancheVault.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === "LossSettled");

      if (!settled) continue; // a zero loss settles clean and emits nothing
      const [loss, fromBond, fromJunior, fromSenior] = settled.args;

      expect(fromBond + fromJunior + fromSenior, `layers must sum to the loss at ${bps}bps`)
        .to.equal(loss);
      expect(sr0 - (await sys.trancheVault.seniorAssets()), "senior delta matches the event")
        .to.equal(fromSenior);
      expect(jr0 - (await sys.trancheVault.juniorAssets()) <= fromJunior, "junior delta never exceeds the event")
        .to.equal(true);
    }
  });

  it("leaves no cash stranded in the vault after settlement", async function () {
    for (const bps of [0, 1_500, 4_000, 9_000]) {
      const sys = await deploySystem();
      await settleAt(sys, BigInt(bps));
      expect(await sys.trancheVault.cashSurplus(), `stranded cash at ${bps}bps`).to.equal(0n);
    }
  });

  it("never lets the exit pool pay out more cash than it holds", async function () {
    const sys = await deploySystem();
    const pool = sys.exitPool;
    const cash = await pool.availableLiquidity();
    const senior = await sys.senior.getAddress();

    // Price it at par so the pool would want to pay the most it possibly could.
    await pool.updatePrice(senior, 10_000n, 0n, ethers.ZeroHash);

    // Ask for far more than the pool could ever fund.
    const absurd = cash * 100n;
    await expect(pool.connect(sys.seniorLp).requestExit(senior, absurd)).to.be.reverted;
    expect(await pool.availableLiquidity()).to.equal(cash);
  });
});

/**
 * A deposit into a deal that has not started must not be a one way door.
 *
 * Found in an audit: redemptionsOpen() was `status == Settled`, and onWithdraw was
 * onlyStatus(Settled). So money put into an Open deal was locked until maturity even
 * though nothing had been drawn, the originator had never seen it, and no risk had
 * been taken. The lock is supposed to start when the money goes out to work.
 */
describe("Changing your mind before a deal starts", function () {
  it("lets a holder withdraw while the deal is still Open", async function () {
    // deploySystem already seats 800k senior and 200k junior, so this is a holder
    // who put money in and changed their mind before anything was drawn. Senior is
    // withdrawn because pulling all of junior would breach the ratio cap, which the
    // next test covers deliberately.
    const sys = await deploySystem({ fund: false, postPrediction: false });

    expect(await sys.trancheVault.redemptionsOpen(), "Open deals accept redemptions").to.equal(true);
    expect(await sys.senior.maxRedeem(sys.seniorLp.address)).to.be.greaterThan(0n);

    const before = await sys.usdc.balanceOf(sys.seniorLp.address);
    const shares = await sys.senior.balanceOf(sys.seniorLp.address);
    await sys.senior.connect(sys.seniorLp).redeem(shares, sys.seniorLp.address, sys.seniorLp.address);

    expect(await sys.usdc.balanceOf(sys.seniorLp.address), "gets their deposit back")
      .to.equal(before + USDC(800_000));
    expect(await sys.trancheVault.seniorAssets()).to.equal(0n);
  });

  it("still refuses to redeem once the money is out working", async function () {
    const sys = await deploySystem();
    expect(await sys.trancheVault.redemptionsOpen(), "a Funded deal is locked").to.equal(false);
    expect(await sys.senior.maxRedeem(sys.seniorLp.address)).to.equal(0n);
  });

  it("will not let a junior exit push senior past the ratio cap", async function () {
    const sys = await deploySystem({ fund: false, postPrediction: false });

    // Senior sits at exactly the 80 percent cap. Pulling junior out would break it,
    // which is the case the withdrawal path has to re-check on the way out.
    const shares = await sys.junior.balanceOf(sys.juniorLp.address);
    await expect(
      sys.junior.connect(sys.juniorLp).redeem(shares, sys.juniorLp.address, sys.juniorLp.address),
    ).to.be.revertedWithCustomError(sys.trancheVault, "SeniorTooThick");
  });
});
