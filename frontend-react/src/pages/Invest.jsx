import React, { useCallback, useEffect, useState } from 'react';
import { FQ, money, pct, shortAddr, usePoll } from '../api';
import {
  claimTestTokens,
  depositWithWallet,
  exitWithWallet,
  explorerTx,
  fromBaseUnits,
  readBalance,
  withdrawWithWallet,
} from '../wallet';
import { ArrowLeft, ArrowRight, Check, Lock } from 'lucide-react';
import { CardSkeleton, Note, PageBody, PageHeader, Skeleton, Stat, Status, Why } from '../components/Page';

/**
 * The investor surface. One person, one job.
 *
 * Three things here are deliberate, and each fixes something a stranger tripped on:
 *
 *   1. Deposit and sell own separate amounts. One shared field meant typing a
 *      deposit figure and then scrolling down produced a sale quote for that same
 *      number, which is the opposite transaction.
 *   2. The page is ordered by what the deal can actually do. An Open deal leads with
 *      depositing and hides selling; a Funded one leads with selling and says plainly
 *      that deposits are shut. Nobody scrolls past a section that cannot act.
 *   3. A first run checklist. Connect, claim tokens, deposit are three separate
 *      things a newcomer had to work out the order of on their own.
 *
 * Balances are read from the connected wallet on chain rather than described. A
 * "your position" that is not really your position is worse than no page.
 */



const Row = ({ label, value, hint }) => (
  <div className="flex justify-between items-baseline gap-4 py-2.5">
    <span className="t-body">
      {label}
      {hint && <span className="t-small block">{hint}</span>}
    </span>
    <span className="num text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>
      {value}
    </span>
  </div>
);

/** One line of the first run checklist. Done steps go quiet, the next one stays loud. */
const Todo = ({ n, done, title, children }) => (
  <li className="flex gap-3" style={{ opacity: done ? 0.55 : 1 }}>
    <span
      className="shrink-0 h-6 w-6 rounded-full grid place-items-center text-[12px] font-bold mt-0.5"
      style={done ? { background: 'var(--positive)', color: '#fff' } : { background: '#f0f1f3', color: 'var(--ink-muted)' }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : n}
    </span>
    <div className="flex-1 space-y-2">
      <p className="t-body" style={{ fontWeight: done ? 400 : 600 }}>
        {title}
      </p>
      {!done && children}
    </div>
  </li>
);

/** Amount box with a Max, because typing a balance by hand is a way to get it wrong. */
const AmountField = ({ id, label, value, onChange, max, maxLabel, currency = 'dUSDC' }) => (
  <div className="field">
    <div className="flex items-baseline justify-between gap-3">
      <label className="t-label" htmlFor={id}>
        {label}
      </label>
      {max > 0 && (
        <button
          type="button"
          className="t-small underline underline-offset-2"
          onClick={() => onChange(max)}
        >
          {maxLabel ?? `Max ${money(max)}`}
        </button>
      )}
    </div>
    <div className="relative">
      <input
        id={id}
        type="number"
        step="1000"
        min="0"
        className="input num"
        style={{ paddingRight: 64 }}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span
        className="t-small absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
        style={{ color: 'var(--ink-muted)' }}
      >
        {currency}
      </span>
    </div>
  </div>
);

/* ------------------------------------------------------------------ the list */

/**
 * A deal, as a card.
 *
 * Two things were wrong. It showed three stats, which never balances against a
 * four column grid and left a ragged gap. And "Size" read $0 on the Open deal,
 * because an unfunded deal has drawn nothing and holds no deposits yet, so both
 * candidate numbers really are zero. A live deal advertising $0 looks dead.
 *
 * Four stats now, and the size of an Open deal is what it is raising.
 */
const DealCard = ({ deal, onOpen }) => {
  /*
    A deal that could not be read is not a deal you can open.

    The card was still a button, so clicking one led to a detail page built from
    zeroes: $0 raised, 0.00% expected, no maturity. Every number on it a lie
    presented calmly. A row that failed to load says so and does not invite a click
    it cannot honour.
  */
  if (deal.unavailable) {
    return (
      <div className="card" style={{ padding: 24, opacity: 0.75 }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="t-h3 truncate">{deal.name}</p>
            <p className="hash mt-1">{deal.assetLabel}</p>
          </div>
          <Status status="Unavailable" label="Cannot read" />
        </div>
        <p className="t-small mt-4">
          This deal did not respond. Its figures are unknown rather than zero, so nothing is
          shown for them. Reloading usually clears it.
        </p>
      </div>
    );
  }

  const stats = deal.resolved
    ? [
        ['Size', money(deal.size)],
        ['Model called', pct(deal.predictedDefaultRateBps)],
        ['Actually unpaid', pct(deal.actualDefaultRateBps)],
        ['Operator lost', money(deal.bondSlashed)],
      ]
    : [
        [deal.status === 'Open' ? 'Raising' : 'Size', money(deal.size)],
        // A deal nobody has scored yet reads 0.00% and $0, which looks broken rather
        // than available. Say what is actually true: it is waiting for an opinion.
        ['Model says', deal.bondAmount > 0 ? pct(deal.predictedDefaultRateBps) : 'Not yet scored'],
        ['Staked on it', deal.bondAmount > 0 ? money(deal.bondAmount) : 'Nothing yet'],
        ['Matures in', `${deal.daysToMaturity}d`],
      ];

  const action =
    deal.status === 'Open'
      ? 'Deposit'
      : deal.status === 'Funded'
        ? 'Sell early'
        : 'See how it ended';

  return (
    <button
      onClick={() => onOpen(deal.id)}
      className="card text-left w-full transition-colors hover:bg-[#fbfbfc] group"
      style={{ padding: 24 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="t-h3 truncate">{deal.name}</p>
          <p className="hash mt-1">{deal.assetLabel}</p>
        </div>
        <Status
          status={deal.status}
          label={deal.status === 'Open' ? 'Taking deposits' : deal.status}
        />
      </div>

      {deal.blurb && <p className="t-small mt-3 line-clamp-2">{deal.blurb}</p>}

      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5"
        style={{ borderTop: '1px solid var(--line)' }}
      >
        {stats.map(([k, v]) => (
          <Stat key={k} label={k} value={v} />
        ))}
      </div>

      <p
        className="t-small mt-5 inline-flex items-center gap-1.5 font-semibold"
        style={{ color: 'var(--ink)' }}
      >
        {action}
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </p>
    </button>
  );
};

/* ---------------------------------------------------------------- the page */

export const Invest = ({ wallet, setActivePage }) => {
  const [deals, setDeals] = useState(null);
  const [openId, setOpenId] = useState(null);

  const [state, setState] = useState(null);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});
  const [walletStep, setWalletStep] = useState(null);

  const [held, setHeld] = useState(null);
  const [cash, setCash] = useState(null);
  const [tranche, setTranche] = useState('senior');
  // Two amounts, not one. See the note at the top of the file.
  const [depositAmount, setDepositAmount] = useState(25000);
  const [sellAmount, setSellAmount] = useState(0);
  const [quote, setQuote] = useState(null);
  const [done, setDone] = useState(null);

  /* ---- the list ---- */
  useEffect(() => {
    // The list needs one call, not two. /api/deals is enough to render everything
    // here, so the extra /api/state that FQ.connect() fires is only worth paying
    // for when the real backend is unreachable and we need the simulated one.
    FQ.call('/api/deals')
      .then(({ deals }) => setDeals(deals))
      .catch(async () => {
        const r = await FQ.connect();
        setIsMock(r.isMock);
        {
          setDeals([
            {
              id: null,
              name: r.state.dealName ?? r.state.assetLabel,
              assetLabel: r.state.assetLabel,
              status: r.state.deal.status,
              drawnAmount: r.state.deal.drawnAmount,
              seniorAssets: r.state.deal.seniorAssets,
              juniorAssets: r.state.deal.juniorAssets,
              predictedDefaultRateBps: r.state.prediction.predictedDefaultRateBps,
              bondAmount: r.state.prediction.bondAmount,
              bondSlashed: r.state.prediction.bondSlashed,
              resolved: r.state.prediction.resolved,
            },
          ]);
        }
      });
  }, []);

  // The chain keeps moving whether or not this tab is looking at it, so the list
  // refreshes itself. Paused while the tab is hidden.
  usePoll(() => {
    FQ.call('/api/deals')
      .then(({ deals }) => setDeals(deals))
      .catch(() => {});
  }, []);

  const loadDeal = useCallback(async (id) => {
    const q = id ? `?deal=${encodeURIComponent(id)}` : '';
    setState(await FQ.call(`/api/state${q}`));
  }, []);

  useEffect(() => {
    if (openId === null) return;
    loadDeal(openId).catch((e) => setError(e.message));
  }, [openId, loadDeal]);

  const loadPosition = useCallback(async () => {
    if (!state?.contracts || !wallet?.address || isMock) return;
    try {
      const [s, j, c] = await Promise.all([
        readBalance(state.contracts.seniorTranche, wallet.address),
        readBalance(state.contracts.juniorTranche, wallet.address),
        readBalance(state.contracts.settlementAsset, wallet.address),
      ]);
      setHeld({ senior: fromBaseUnits(s), junior: fromBaseUnits(j) });
      setCash(fromBaseUnits(c));
    } catch {
      /* a failed read should not blank the page */
    }
  }, [state, wallet?.address, isMock]);

  useEffect(() => {
    loadPosition();
  }, [loadPosition]);

  const run = async (key, fn) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
      setWalletStep(null);
    }
  };

  const wrongChain = Boolean(wallet?.address && state && wallet.chainId !== state.network.chainId);
  const canSign = Boolean(wallet?.address) && !wrongChain && !isMock;

  /* ================================================== LIST ================= */
  if (openId === null) {
    return (
      <>
        <PageHeader
          kicker="For people with money to put to work"
          title="Earn on real invoices"
          lede="Lend against books of real invoices. An AI model estimates what will go unpaid, and the operator running it has staked their own capital on that estimate. If they are wrong, their money is taken before yours."
        />
        <PageBody>
          {error && (
            <Note tone="no" title="That did not work">
              {error}
            </Note>
          )}
          {/* Global and sticky, so ask the module rather than this component. */}
          {(isMock || FQ.isMock()) && (
            <Note tone="no" title="Practice data - these numbers are invented">
              The chain could not be reached, so the page is running on a simulation.
              Nothing here is on X Layer and no figure below is real. Reload to try the
              live chain again.
            </Note>
          )}

          {/*
            Four identical "Unavailable" cards is one fact told four times.

            A single deal that will not read is worth an Unavailable chip: the others
            are fine and you can still use them. When the RPC itself is unreachable
            every deal fails at once and the page fills with broken cards, which reads
            as "this protocol is dead" rather than "the network is not answering".
            Same data, opposite conclusion. Say it once, in the terms that are true.
          */}
          {deals && deals.length > 0 && deals.every((d) => d.unavailable) && (
            <Note tone="no" title="Cannot reach X Layer testnet right now">
              Every deal failed to read, which points at the network rather than at any one
              deal. Nothing has happened to the contracts or to any position. Reload in a
              moment; if it persists, the testnet RPC is down.
            </Note>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            {deals
              ? deals.map((d) => <DealCard key={d.id ?? 'only'} deal={d} onOpen={setOpenId} />)
              : [0, 1, 2].map((i) => <CardSkeleton key={i} />)}
          </div>

          <p className="t-small text-center pt-4">
            Want the other side of these deals, where the model stakes its own money and gets
            slashed?{' '}
            <button className="btn-quiet" onClick={() => setActivePage('risk')}>
              See the underwriter side
            </button>
          </p>
        </PageBody>
      </>
    );
  }

  /* ================================================== DETAIL =============== */
  if (!state) return <div className="p-24 text-center t-body">Loading...</div>;

  const D = state.deal;
  const P = state.prediction;
  const depositsOpen = D.status === 'Open';
  const tradeable = D.status === 'Funded';
  const settled = D.status === 'Settled';
  const holding = held ? held[tranche] : 0;

  /*
    The senior ratio cap, surfaced before you sign rather than after.

    TrancheVault refuses any deposit that would push senior past 80 percent of the
    stack. On a brand new deal that is nothing but zeros, so the very first senior
    deposit is 100 percent senior and reverts with SeniorTooThick. Senior is also
    the page default, so the most likely first action a stranger takes on the most
    prominent deal was guaranteed to fail with a word they have never seen.

    Junior first is the rule. The page now says so, disables the button, and offers
    to switch, instead of letting the wallet eat the gas to find out.
  */
  const MAX_SENIOR_BPS = 8000;
  const seniorAfter = D.seniorAssets + (tranche === 'senior' ? depositAmount : 0);
  const juniorAfter = D.juniorAssets + (tranche === 'junior' ? depositAmount : 0);
  const totalAfter = seniorAfter + juniorAfter;
  const breachesRatio =
    depositsOpen &&
    tranche === 'senior' &&
    depositAmount > 0 &&
    totalAfter > 0 &&
    (seniorAfter * 10000) / totalAfter > MAX_SENIOR_BPS;
  const maxSeniorNow = Math.max(0, (D.juniorAssets * MAX_SENIOR_BPS) / (10000 - MAX_SENIOR_BPS) - D.seniorAssets);

  const hasTokens = (cash ?? 0) > 0;
  const hasPosition = Boolean(held && (held.senior > 0 || held.junior > 0));
  const setupDone = canSign && hasTokens;

  const depositTooBig = cash !== null && depositAmount > cash;
  const sellTooBig = held !== null && sellAmount > holding;

  /* ---------- the panels, so order can change with the deal's state ---------- */

  const walletPanel = (
    <div className="card" style={{ padding: 28 }} key="wallet">
      <h2 className="t-h2">Your position</h2>

      {!wallet?.address && (
        <p className="t-body mt-3">
          Connect a wallet using the button in the header and your balance appears here, read
          straight off the chain.
        </p>
      )}
      {wallet?.address && wrongChain && (
        <p className="t-body mt-3">Your wallet is on the wrong network. Switch it in the header.</p>
      )}
      {wallet?.address && !wrongChain && (
        <>
          <div className="mt-3" style={{ borderTop: '1px solid var(--line)' }}>
            <Row label="Spendable dUSDC" value={cash === null ? '...' : money(cash)} />
            <Row label="Senior held" value={held ? money(held.senior) : '...'} />
            <Row label="Junior held" value={held ? money(held.junior) : '...'} />
            <p className="t-small pt-2">
              Read from <span className="num">{shortAddr(wallet.address)}</span>.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              className="btn btn-sm"
              disabled={!canSign || busy.faucet}
              onClick={() =>
                run('faucet', async () => {
                  await claimTestTokens({
                    token: state.contracts.settlementAsset,
                    address: wallet.address,
                    amount: 250000,
                    onStep: setWalletStep,
                  });
                  await loadPosition();
                })
              }
            >
              {busy.faucet ? 'Claiming' : 'Get 250,000 test dUSDC'}
            </button>
            <span className="t-small">Free, and only worth anything on this testnet.</span>
          </div>
        </>
      )}
    </div>
  );

  const tranchePanel = (
    <div className="card" style={{ padding: 28 }} key="tranche">
      <h2 className="t-h2">{tradeable ? 'Which position do you hold?' : 'Two ways in'}</h2>
      <div className="grid sm:grid-cols-2 gap-4 mt-5">
        {[
          { id: 'senior', name: 'Senior', size: D.seniorAssets, line: 'Paid less. Loses last.' },
          { id: 'junior', name: 'Junior', size: D.juniorAssets, line: 'Paid more. Loses right after the operator.' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTranche(t.id);
              setQuote(null);
              setSellAmount(held ? held[t.id] : 0);
            }}
            className="text-left rounded-[16px] p-5 transition-colors"
            style={{
              border: `1px solid ${tranche === t.id ? 'var(--ink)' : 'var(--line)'}`,
              background: tranche === t.id ? '#f7f8f9' : '#fff',
            }}
            aria-pressed={tranche === t.id}
          >
            <div className="flex items-center justify-between">
              <p className="t-h3">{t.name}</p>
              {tranche === t.id && <Check className="h-4 w-4" />}
            </div>
            <p className="num text-[20px] font-bold mt-1" style={{ color: 'var(--ink)' }}>
              {money(t.size)}
            </p>
            <p className="t-small mt-2">{t.line}</p>
            {held && held[t.id] > 0 && (
              <p className="t-small mt-2" style={{ color: 'var(--positive)' }}>
                You hold {money(held[t.id])}
              </p>
            )}
          </button>
        ))}
      </div>
    </div>
  );

  const depositPanel = (
    <div className="card" style={{ padding: 28 }} key="deposit">
      <h2 className="t-h2">Put money in</h2>
      <div className="mt-4 space-y-4">
        <AmountField
          id="depamt"
          label={`Deposit into ${tranche}`}
          value={depositAmount}
          onChange={setDepositAmount}
          max={cash ?? 0}
        />
        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={!canSign || busy.dep || depositAmount <= 0 || depositTooBig || breachesRatio}
          onClick={() =>
            run('dep', async () => {
              const r = await depositWithWallet({
                address: wallet.address,
                settlementToken: state.contracts.settlementAsset,
                trancheToken:
                  tranche === 'junior' ? state.contracts.juniorTranche : state.contracts.seniorTranche,
                amount: depositAmount,
                onStep: setWalletStep,
              });
              setDone({ kind: 'deposit', txHash: r.depositHash });
              await Promise.all([loadPosition(), loadDeal(openId)]);
            })
          }
        >
          {walletStep === 'checking' && 'Checking your balance'}
          {walletStep === 'approving' && 'Approve it in your wallet'}
          {walletStep === 'depositing' && 'Confirm it in your wallet'}
          {!walletStep && (busy.dep ? 'Depositing' : `Deposit ${money(depositAmount)} into ${tranche}`)}
        </button>
        {depositTooBig && (
          <p className="t-small" style={{ color: 'var(--negative)' }}>
            You hold {money(cash)}. Claim test tokens above or lower the amount.
          </p>
        )}
        {breachesRatio && (
          <div className="mt-4">
            <Note tone="info" title="Junior has to go in first">
              Senior can never be more than 80% of a deal, so it cannot be the first money in.
              {maxSeniorNow > 0
                ? ` With ${money(D.juniorAssets)} of junior already here, senior can take at most ${money(maxSeniorNow)} more.`
                : ' Nobody has taken the junior side of this deal yet.'}
              <p className="mt-3">
                <button className="btn btn-sm" onClick={() => setTranche('junior')}>
                  Deposit into junior instead
                </button>
              </p>
            </Note>
          </div>
        )}
      </div>

      {done?.kind === 'deposit' && (
        <div className="mt-4">
          <Note tone="ok" title="Deposited">
            Your position above has been refreshed from the chain.
          </Note>
        </div>
      )}
    </div>
  );

  const sellPanel = (
    <div className="card" style={{ padding: 28 }} key="sell">
      <h2 className="t-h2">Need out early?</h2>
      <p className="t-body mt-2 max-w-2xl">
        You cannot redeem before maturity. What you can do is sell to a pool that always has a
        price, worked out by the same model that underwrote the deal.
      </p>

      <div className="mt-5 space-y-4">
        <AmountField
          id="sellamt"
          label={`Sell from your ${tranche} position`}
          value={sellAmount}
          onChange={(v) => {
            setSellAmount(v);
            setQuote(null);
          }}
          max={holding}
          maxLabel={`All ${money(holding)}`}
          currency={tranche}
        />

        {/*
          Two calls, and the order matters. quote-exit only computes a number off
          chain. The pool will not trade unless a quote has been published on chain
          and is under fifteen minutes old, so calling quote-exit alone showed a
          price and then reverted with NoQuote the moment anyone pressed sell.
          In production a keeper publishes these on a schedule.
        */}
        <button
          className="btn"
          disabled={busy.q || sellAmount <= 0}
          onClick={() =>
            run('q', async () => {
              await FQ.call('/api/reprice', { deal: openId, scenario: 'stable' });
              setQuote(await FQ.call('/api/quote-exit', { deal: openId, tranche, amount: sellAmount }));
            })
          }
        >
          {busy.q ? 'Pricing' : `What would ${money(sellAmount)} fetch?`}
        </button>

        {quote && (
          <div className="panel-soft p-5">
            <Row label="Worth on paper" value={money(quote.parValue, 2)} />
            <Row label="The model's view today" value={money(quote.fairValue, 2)} />
            <Row label="The pool's fee" value={money(-quote.spreadEarned, 2)} hint="this is how the pool earns" />
            <div
              className="flex justify-between items-baseline gap-4 pt-3 mt-1"
              style={{ borderTop: '1px solid var(--line)' }}
            >
              <span className="t-h3">You get paid now</span>
              <span className="num text-[26px] font-bold" style={{ color: 'var(--positive)' }}>
                {money(quote.payout, 2)}
              </span>
            </div>
            {!quote.withinCap && (
              <p className="t-small mt-3" style={{ color: 'var(--negative)' }}>
                No single exit may take more than {money(quote.perExitCap)} of the pool. Try less.
              </p>
            )}
          </div>
        )}

        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={!quote || !quote.withinCap || busy.sell || sellTooBig || sellAmount <= 0}
          onClick={() =>
            run('sell', async () => {
              if (canSign) {
                const r = await exitWithWallet({
                  address: wallet.address,
                  pool: state.contracts.exitLiquidityPool,
                  trancheToken:
                    tranche === 'junior' ? state.contracts.juniorTranche : state.contracts.seniorTranche,
                  amount: sellAmount,
                  onStep: setWalletStep,
                });
                setDone({ kind: 'sell', txHash: r.exitHash, received: quote.payout });
              } else {
                const r = await FQ.call('/api/exit', { deal: openId, tranche, amount: sellAmount });
                setDone({ kind: 'sell', received: r.received, txHash: r.txHash });
              }
              await Promise.all([loadPosition(), loadDeal(openId)]);
            })
          }
        >
          {walletStep === 'checking' && 'Checking your balance'}
          {walletStep === 'approving' && 'Approve it in your wallet'}
          {walletStep === 'exiting' && 'Confirm it in your wallet'}
          {!walletStep && (busy.sell ? 'Selling' : 'Sell now and get paid')}
        </button>

        {sellTooBig && (
          <p className="t-small" style={{ color: 'var(--negative)' }}>
            You hold {money(holding)} of {tranche}. Lower the amount.
          </p>
        )}
        {wallet?.address && !wrongChain && held && holding === 0 && (
          <p className="t-small">
            This wallet holds no {tranche}. Switch tranche above, or the operator wallet signs it
            instead for the demo.
          </p>
        )}
      </div>

      {done?.kind === 'sell' && (
        <div className="mt-5">
          <Note tone="ok" title={`${money(done.received, 2)} is now yours`}>
            No queue, no order book, no waiting until maturity. The pool took the other side.
            {done.txHash && explorerTx(state.network.chainId, done.txHash) && (
              <p className="t-small mt-2">
                <a
                  className="underline"
                  href={explorerTx(state.network.chainId, done.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  See it on the blockchain
                </a>
              </p>
            )}
          </Note>
        </div>
      )}
    </div>
  );

  /* First run. Only while something is still missing, then it disappears for good. */
  const setupPanel = !setupDone && !settled && (
    <div className="card" style={{ padding: 28 }} key="setup">
      <h2 className="t-h2">Three things first</h2>
      <ol className="mt-5 space-y-5">
        <Todo n={1} done={Boolean(wallet?.address) && !wrongChain} title="Connect a wallet">
          <p className="t-small">
            {wrongChain
              ? 'Connected, but on the wrong network. Use the switch button in the header.'
              : `Use the button in the header. You will be asked to switch to ${state.network.name}.`}
          </p>
        </Todo>
        <Todo n={2} done={hasTokens} title="Claim some test dUSDC">
          <button
            className="btn btn-sm"
            disabled={!canSign || busy.faucet}
            onClick={() =>
              run('faucet', async () => {
                await claimTestTokens({
                  token: state.contracts.settlementAsset,
                  address: wallet.address,
                  amount: 250000,
                  onStep: setWalletStep,
                });
                await loadPosition();
              })
            }
          >
            {busy.faucet ? 'Claiming' : 'Get 250,000 test dUSDC'}
          </button>
        </Todo>
        <Todo n={3} done={hasPosition} title={depositsOpen ? 'Deposit into a tranche' : 'Pick a position to sell'}>
          <p className="t-small">
            {depositsOpen
              ? 'Choose senior or junior below, then deposit.'
              : 'This deal is closed to new money, so the action here is selling.'}
          </p>
        </Todo>
      </ol>
    </div>
  );

  /*
    Order follows what the deal can do. An Open deal leads with depositing and does
    not show a sell panel at all; a Funded one leads with selling. Sections that
    cannot act are a line of text, not a card you scroll past.
  */
  const panels = settled
    ? [walletPanel]
    : depositsOpen
      ? [setupPanel, tranchePanel, depositPanel, walletPanel]
      : [setupPanel, tranchePanel, sellPanel, walletPanel];

  const back = () => {
    setOpenId(null);
    setQuote(null);
    setDone(null);
  };

  return (
    <>
      <PageHeader
        kicker={state.assetLabel}
        title={state.dealName ?? state.assetLabel}
        lede={state.blurb ?? undefined}
        aside={
          <div className="flex flex-col items-start md:items-end gap-3">
            <Status status={D.status} label={depositsOpen ? 'Taking deposits' : D.status} />
            <button className="btn btn-sm" onClick={back}>
              <ArrowLeft className="h-4 w-4" />
              All deals
            </button>
          </div>
        }
      />
      <PageBody>

      {error && (
        <Note tone="no" title="That did not work">
          {error}
        </Note>
      )}

      {/*
        Two columns, not a stack of cards.

        The detail view was five full width cards one after another, so every
        number about the deal scrolled out of sight the moment you started typing
        an amount, and the page read like a printed form. The facts now sit in a
        rail that sticks while you act on the right, which is how any trading
        screen is laid out and for exactly the same reason.
      */}
      <div className="grid lg:grid-cols-[272px_1fr] gap-8 items-start">
        <aside className="lg:sticky lg:top-24">
          <div className="card" style={{ padding: 22 }}>
            <div className="space-y-4">
              <Stat label="Size" value={money(D.drawnAmount || D.seniorAssets + D.juniorAssets)} />
              <Stat
                label="Model says"
                value={pct(P.predictedDefaultRateBps)}
                hint={P.resolved ? `actual ${pct(P.actualDefaultRateBps)}` : 'will go unpaid'}
              />
              <Stat
                label={P.resolved ? 'Operator lost' : 'Staked on it'}
                value={money(P.resolved ? P.bondSlashed : P.bondAmount)}
                hint="their own money"
              />
              <Stat label="Matures in" value={`${state.daysToMaturity}d`} />
            </div>
            <div className="mt-5 pt-5" style={{ borderTop: '1px solid var(--line)' }}>
              <Why label="What the stake is for">
                If the model is wrong by more than its tolerance band, that money is taken
                automatically and paid to investors before anyone else absorbs a loss. That is the
                only reason its estimate is worth anything to you.
              </Why>
            </div>
          </div>
        </aside>

        <div className="space-y-6 min-w-0">

      {/* One line for the thing this deal cannot do, instead of a dead card. */}
      {settled && (
        <Note tone="info" title="This deal is finished">
          <span className="inline-flex items-center gap-2">
            <Lock className="h-4 w-4" />
            It matured at {pct(P.actualDefaultRateBps)} against a {pct(P.predictedDefaultRateBps)}{' '}
            call, so {money(P.bondSlashed)} was taken from the operator and paid down the waterfall
            ahead of investors.
          </span>
          <p className="mt-2">Nothing to deposit or sell here. It is kept visible as a record.</p>
        </Note>
      )}
      {tradeable && (
        <Note tone="info">
          <span className="inline-flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Closed to new money. The cash has gone to the company and is financing real invoices.
          </span>
        </Note>
      )}

            {panels}
          </div>
        </div>
      </PageBody>
    </>
  );
};
