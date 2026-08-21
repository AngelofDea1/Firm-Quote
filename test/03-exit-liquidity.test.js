const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySystem, settleAt, increaseTime, USDC } = require("./helpers");

const REASONING = ethers.keccak256(ethers.toUtf8Bytes("payer slipped from net-30 to net-52"));
const q4 = "updatePrice(address,uint256,uint256,bytes32)";
const q2 = "updatePrice(address,uint256)";

async function withQuote(fairValueBps = 9_700n, opts = {}) {
  const sys = await deploySystem(opts);
  await sys.exitPool[q4](await sys.senior.getAddress(), fairValueBps, 600n, REASONING);
  return sys;
}

describe("ExitLiquidityPool - getting out before maturity", function () {
  it("quotes par, then the AI haircut, then the spread - in that order", async function () {
    const { exitPool, senior } = await withQuote(9_700n);
    const [par, fair, payout, spread] = await exitPool.quoteExit(await senior.getAddress(), USDC(100_000));

    expect(par).to.equal(USDC(100_000)); // NAV of those shares right now
    expect(fair).to.equal(USDC(97_000)); // 9700bps of par
    expect(payout).to.equal(USDC(95_545)); // less the 150bps spread
    expect(spread).to.equal(USDC(1_455)); // which is the LPs' compensation
    expect(fair - payout).to.equal(spread);
  });

  it("pays the holder immediately and takes the tranche tokens onto its own book", async function () {
    const { exitPool, senior, seniorLp, usdc } = await withQuote(9_700n);
    const pool = await exitPool.getAddress();

    const cashBefore = await usdc.balanceOf(seniorLp.address);
    await senior.connect(seniorLp).approve(pool, USDC(100_000));
    const tx = await exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000));

    await expect(tx)
      .to.emit(exitPool, "ExitFilled")
      .withArgs(
        seniorLp.address,
        await senior.getAddress(),
        USDC(100_000),
        USDC(100_000),
        USDC(97_000),
        USDC(95_545),
        USDC(1_455),
      );

    expect((await usdc.balanceOf(seniorLp.address)) - cashBefore).to.equal(USDC(95_545));
    expect(await senior.balanceOf(pool)).to.equal(USDC(100_000));
    expect(await exitPool.availableLiquidity()).to.equal(USDC(500_000) - USDC(95_545));
  });

  it("refuses to trade against a stale quote", async function () {
    const { exitPool, senior, seniorLp } = await withQuote();
    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(100_000));

    await increaseTime(16 * 60); // default max age is 15 minutes

    await expect(
      exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000)),
    ).to.be.revertedWithCustomError(exitPool, "QuoteStale");
  });

  it("refuses to trade a tranche the model has never priced", async function () {
    const { exitPool, junior, juniorLp } = await withQuote();
    await junior.connect(juniorLp).approve(await exitPool.getAddress(), USDC(10_000));

    await expect(
      exitPool.connect(juniorLp).requestExit(await junior.getAddress(), USDC(10_000)),
    ).to.be.revertedWithCustomError(exitPool, "NoQuote");
  });

  // The spec calls this out as a way to break the demo live. It gets its own test.
  it("caps a single exit so one holder cannot drain the pool", async function () {
    const { exitPool, senior, seniorLp } = await withQuote();
    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(400_000));

    // 20% of 500k cash = a 100k ceiling on any one exit.
    await expect(exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(200_000)))
      .to.be.revertedWithCustomError(exitPool, "ExitTooLarge")
      .withArgs(USDC(191_090), USDC(100_000));

    // Inside the cap, the same holder is served without complaint.
    await expect(exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000))).to.not.be.reverted;
  });

  it("caps concentration in any single tranche", async function () {
    const { exitPool, senior, seniorLp } = await withQuote();
    // Lift the per-exit cap so the exposure cap is what actually bites.
    await exitPool.setParams(150n, 10_000n, 1_000n, 15 * 60);

    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(100_000));
    await expect(
      exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000)),
    ).to.be.revertedWithCustomError(exitPool, "ExposureCapHit");
  });

  it("marks inventory at the AI's fair value so late LPs are not mispriced in", async function () {
    const { exitPool, senior, seniorLp } = await withQuote(9_700n);
    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(100_000));
    await exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000));

    const cash = await exitPool.availableLiquidity();
    const inventory = await exitPool.inventoryValue(await senior.getAddress());

    expect(cash).to.equal(USDC(404_455));
    expect(inventory).to.equal(USDC(97_000));
    expect(await exitPool.totalAssets()).to.equal(cash + inventory);

    // The pool bought at 95,545 and marks at 97,000, so NAV ticks up by the spread.
    expect(await exitPool.totalAssets()).to.equal(USDC(501_455));
  });

  it("will not pay out more cash than it holds", async function () {
    const { exitPool, senior, seniorLp } = await withQuote(9_700n, { lpDeposit: USDC(1_000) });
    await exitPool.setParams(150n, 10_000n, 10_000n, 15 * 60);
    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(100_000));

    await expect(
      exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000)),
    ).to.be.revertedWithCustomError(exitPool, "InsufficientLiquidity");
  });

  it("stops LPs withdrawing cash that is currently tied up in tranche inventory", async function () {
    const { exitPool, senior, seniorLp, poolLp } = await withQuote(9_700n);
    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(100_000));
    await exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000));

    // The LP is owed more than the pool can hand over in cash right now.
    expect(await exitPool.maxWithdraw(poolLp.address)).to.equal(await exitPool.availableLiquidity());
    expect(await exitPool.maxWithdraw(poolLp.address)).to.be.lessThan(USDC(501_455));
  });

  it("collects the full payout at maturity, and the LPs keep the difference", async function () {
    const sys = await withQuote(9_700n);
    const { exitPool, senior, seniorLp, poolLp } = sys;

    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(100_000));
    await exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(100_000));

    const navBefore = await exitPool.totalAssets();
    const lpShares = await exitPool.balanceOf(poolLp.address);
    const pricePerShareBefore = await exitPool.previewRedeem(lpShares);

    await settleAt(sys, 300n); // inside tolerance, senior comes out whole

    const tx = await exitPool.redeemMatured(await senior.getAddress());
    await expect(tx).to.emit(exitPool, "InventoryRedeemed");

    // Bought the shares for 95,545, redeemed them for 100,000 at par.
    expect(await exitPool.availableLiquidity()).to.equal(USDC(504_455));
    expect(await exitPool.totalAssets()).to.be.greaterThan(navBefore);
    expect(await exitPool.previewRedeem(lpShares)).to.be.greaterThan(pricePerShareBefore);
    expect(await senior.balanceOf(await exitPool.getAddress())).to.equal(0n);
  });

  it("honours the pause switch and the oracle-only guard on pricing", async function () {
    const { exitPool, senior, seniorLp, badActor } = await withQuote();

    await expect(exitPool.connect(badActor)[q2](await senior.getAddress(), 9_000n)).to.be.revertedWithCustomError(
      exitPool,
      "NotOracle",
    );

    await exitPool.setExitsPaused(true);
    await senior.connect(seniorLp).approve(await exitPool.getAddress(), USDC(10_000));
    await expect(
      exitPool.connect(seniorLp).requestExit(await senior.getAddress(), USDC(10_000)),
    ).to.be.revertedWithCustomError(exitPool, "ExitsArePaused");
  });

  it("reprices downward when the model's view of the credit worsens", async function () {
    const { exitPool, senior } = await withQuote(9_700n);
    const [, fairBefore, payoutBefore] = await exitPool.quoteExit(await senior.getAddress(), USDC(100_000));

    // Payer behaviour deteriorates; the reprice model marks the tranche down.
    await exitPool[q4](await senior.getAddress(), 8_800n, 1_400n, REASONING);
    const [, fairAfter, payoutAfter] = await exitPool.quoteExit(await senior.getAddress(), USDC(100_000));

    expect(fairAfter).to.be.lessThan(fairBefore);
    expect(payoutAfter).to.be.lessThan(payoutBefore);
    expect(fairAfter).to.equal(USDC(88_000));
  });
});
