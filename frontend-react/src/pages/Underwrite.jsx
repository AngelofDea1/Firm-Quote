import React, { useCallback, useEffect, useState } from 'react';
import { FQ, money, pct, shortAddr, usePoll } from '../api';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, Cpu, ShieldCheck } from 'lucide-react';
import { Note, PageBody, PageHeader, Skeleton, Stat, Why } from '../components/Page';
import { Select } from '../components/Select';
import { LINKS } from '../links';

/**
 * The underwriter surface.
 *
 * SECOND ATTEMPT, and the first one failed for a specific reason worth recording.
 *
 * It opened on a step called "Who is allowed to judge this deal?" with an address
 * field already filled in. Nothing said whose address it was, why it was there, or
 * what the reader was supposed to do with it. It was the deal's existing
 * underwriter, prefilled for convenience, which is only convenient if you already
 * know that.
 *
 * Worse, switching deals appeared to change nothing. That is not a bug: the gate
 * scores a WALLET, and the bond multiplier comes from that wallet's record, so the
 * same operator gets the same answer on every deal. Correct, and completely
 * baffling if the page never says so.
 *
 * So this version starts from the person, not the machine:
 *
 *   Your standing   who you are, whether you may underwrite, what a bond costs you
 *   The deal        which credit you are taking a view on
 *   Your opinion    publish it with money behind it
 *   The outcome     settle, and find out what being wrong costs
 *
 * The first panel is always visible, because it is the answer to "whose wallet is
 * this" and it does not change per deal, which is exactly the thing that confused.
 */

const Panel = ({ title, lede, why, children, aside }) => (
  <section className="card" style={{ padding: 26 }}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="t-h2">{title}</h2>
        {lede && <p className="t-body mt-2 max-w-xl">{lede}</p>}
      </div>
      {aside}
    </div>
    {children && <div className="mt-6">{children}</div>}
    {why && <div className="mt-5 pt-5" style={{ borderTop: '1px solid var(--line)' }}>{why}</div>}
  </section>
);

/**
 * Where you are.
 *
 * Numbered markers on a single rule. An earlier version used three equal bars with
 * the labels crammed beneath, which ran together into "1. Who can judge2. The
 * staked opinion" at anything under a laptop width.
 */
const Progress = ({ steps, at, go }) => (
  <nav aria-label="Progress" className="relative px-2">
    <span className="absolute left-8 right-8 top-[15px] h-[2px]" style={{ background: '#e6e8ec' }} aria-hidden="true" />
    <ol className="relative flex justify-between">
      {steps.map((label, i) => {
        const done = i < at;
        const here = i === at;
        return (
          <li key={label} className="flex flex-col items-center gap-2">
            <button
              onClick={() => go(i)}
              aria-current={here ? 'step' : undefined}
              className="h-8 w-8 rounded-full grid place-items-center text-[13px] font-bold transition-colors"
              style={{
                background: done || here ? 'var(--ink)' : '#fff',
                color: done || here ? '#fff' : 'var(--ink-muted)',
                border: `2px solid ${done || here ? 'var(--ink)' : '#e6e8ec'}`,
              }}
            >
              {done ? <Check className="h-4 w-4" /> : i + 1}
            </button>
            <span
              className="t-small text-center max-w-[9rem]"
              style={{ color: here ? 'var(--ink)' : 'var(--ink-muted)', fontWeight: here ? 650 : 400 }}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  </nav>
);

/*
  Step names are instructions, not topics.

  "The deal / Your opinion / The outcome" names the SUBJECT of each step and leaves
  the reader to work out what they are supposed to do about it. A stepper is a set
  of instructions, so each label is now a verb and an object.
*/
const STEPS = ['Pick a deal', 'Post your number', 'See who was right'];

export const Underwrite = ({ wallet, setActivePage }) => {
  const [deals, setDeals] = useState([]);
  const [dealId, setDealId] = useState(null);
  const [state, setState] = useState(null);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});
  const [step, setStep] = useState(0);

  const [gateAddr, setGateAddr] = useState('');
  const [gateResult, setGateResult] = useState(null);
  const [gateFailed, setGateFailed] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [scoreResult, setScoreResult] = useState(null);
  const [actualBps, setActualBps] = useState(2400);
  const [preview, setPreview] = useState(null);
  const [resolved, setResolved] = useState(null);
  // Bring your own model. See the panel below for why this exists.
  const [ownModel, setOwnModel] = useState(false);
  const [ownRate, setOwnRate] = useState('6.40');
  const [ownConf, setOwnConf] = useState('82');
  const [ownWhy, setOwnWhy] = useState('');
  const [ownVersion, setOwnVersion] = useState('');

  /*
    Load the deal list, and refuse to fail quietly.

    This used to be a bare try/catch that dropped the error on the floor and called
    FQ.connect(). That looked defensive and was the opposite. /api/deals reads every
    deal; /api/state reads one. So when the list request failed, the fallback state
    request usually still succeeded, isMock came back false, and the page rendered
    with real numbers, no warning, and an empty deal dropdown. Nothing to pick and
    nothing saying why. That is a worse outcome than a plain error, because the user
    cannot tell the difference between a broken page and an empty protocol.

    Now: one retry, because a single rate limited read on a public RPC is the common
    case and it usually clears. Then, if the list is genuinely unreachable, say so on
    screen. Falling through to practice data is still allowed, but only while
    announcing itself.
  */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loadList = async () => (await FQ.call('/api/deals')).deals ?? [];
      let list = null;
      try {
        list = await loadList();
      } catch (first) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          list = await loadList();
        } catch (second) {
          if (cancelled) return;
          setError(
            `Could not load the deal list (${second.message}). Reading a single deal takes about ` +
              `fifteen chain calls, so a slow or rate limited RPC shows up here first. Reload in a moment.`,
          );
        }
      }
      if (cancelled) return;

      if (list && list.length) {
        setDeals(list);
        // Prefer something you can actually act on: a live deal over a settled one,
        // and never a row the backend flagged as unreadable.
        const usable = list.filter((d) => !d.unavailable);
        const chosen =
          (usable.find((d) => d.status === 'Funded') ?? usable.find((d) => d.status === 'Open') ?? usable[0])?.id ??
          null;
        setDealId(chosen);
        try {
          setState(await FQ.call(`/api/state${chosen ? `?deal=${encodeURIComponent(chosen)}` : ''}`));
          return;
        } catch (e) {
          if (cancelled) return;
          setError(e.message);
        }
      }

      // Nothing usable came back. Practice data keeps the page explorable, but the
      // banner above makes clear it is not the chain.
      const r = await FQ.connect();
      if (cancelled) return;
      setIsMock(r.isMock);
      setState(r.state);
      if (r.isMock) {
        try {
          const mockList = (await FQ.call('/api/deals')).deals ?? [];
          setDeals(mockList);
          setDealId(mockList[0]?.id ?? null);
        } catch {
          /* practice data has no list either; the empty state below covers it */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
    The address being checked defaults to the connected wallet, which is the whole
    point of the panel. Before, it silently prefilled the deal's existing
    underwriter and never said so, so the first thing anyone saw was a stranger's
    address in a box labelled "Wallet being checked".
  */
  useEffect(() => {
    if (wallet?.address) setGateAddr(wallet.address);
    else if (state?.prediction?.underwriter) setGateAddr(state.prediction.underwriter);
  }, [wallet?.address, state]);

  const q = useCallback(() => (dealId ? `?deal=${encodeURIComponent(dealId)}` : ''), [dealId]);
  const refresh = useCallback(async () => setState(await FQ.call(`/api/state${q()}`)), [q]);

  const checkGate = useCallback(
    async (addr) => {
      if (!addr) return;
      try {
        setGateResult(
          await FQ.call(`/api/gate-check?uw=${encodeURIComponent(addr)}${dealId ? `&deal=${dealId}` : ''}`),
        );
        setGateFailed(false);
      } catch (e) {
        setGateFailed(true);
        throw e;
      }
    },
    [dealId],
  );

  /*
    Standing is the first thing on the page, so it should be there before you ask.

    The catch used to be empty, which meant a dropped read left gateResult null and
    the summary line stuck on "Checking your standing" forever. A spinner that never
    resolves and never explains itself is the worst failure this page can produce:
    it is indistinguishable from slow, so the reader waits instead of retrying.
  */
  useEffect(() => {
    if (gateAddr && dealId) checkGate(gateAddr).catch(() => {});
  }, [gateAddr, dealId, checkGate]);

  // Somebody else can settle a deal or post a score while this page is open.
  usePoll(() => {
    if (dealId) refresh().catch(() => {});
  }, [dealId]);

  const switchDeal = async (id) => {
    setDealId(id);
    setScoreResult(null);
    setPreview(null);
    setResolved(null);
    try {
      setState(await FQ.call(`/api/state?deal=${encodeURIComponent(id)}`));
    } catch (e) {
      setError(e.message);
    }
  };

  const run = async (key, fn) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  if (!state) {
    return (
      <>
        <PageHeader kicker="For people who run a credit model" title="Put your capital where your model is" />
        <PageBody>
          <div className="card space-y-4" style={{ padding: 26 }}>
            <Skeleton h={20} w="40%" />
            <Skeleton h={14} />
            <Skeleton h={14} w="80%" />
            <Skeleton h={44} w={220} />
          </div>
        </PageBody>
      </>
    );
  }

  const P = state.prediction;
  const D = state.deal;
  const settled = D.status === 'Settled';
  const eligible = gateResult?.eligible;
  const multiplier = gateResult ? (gateResult.requiredBondMultiplierBps / 10000).toFixed(2) : null;

  /*
    An unscored deal is the interesting one on this page, so the second line says
    so out loud rather than reporting "model says 0.00%", which reads like a
    confident call of zero defaults instead of an absence of any call at all.
  */
  const dealOptions = deals.map((d) => ({
    value: d.id,
    label: d.name,
    meta: d.unavailable
      ? 'Could not be read from the chain'
      : `${d.status} · ${money(d.size)} · ${
          d.bondAmount > 0 ? `model says ${pct(d.predictedDefaultRateBps)}` : 'no opinion yet, yours could be first'
        }`,
  }));

  const bondCost = gateResult?.requiredBond ?? 0;
  const allUnavailable = deals.length > 0 && deals.every((d) => d.unavailable);

  /*
    Whether you are allowed to publish, shown where it stops you.

    This used to be a permanent card at the very top of the page: an address field,
    a re-check button, three stats, a four item checklist, a disclosure and a flag
    toggle, all above the stepper. It was the first thing anybody saw, and it
    answered a question nobody had asked yet, because you cannot care whether you
    are eligible to publish before you know that publishing is what this page does.

    A prerequisite belongs at the point of failure. So: when you are cleared, one
    quiet line stating the one fact that changes what you do, which is the price.
    When you are blocked, the reason and the button that fixes it, right above the
    control it is blocking. Everything else is behind "Details" for the curious and
    for anyone demoing the gate.
  */
  const standing = (
    <div
      className="rounded-[12px] px-4 py-3"
      style={{
        background: eligible === false ? '#fdf4f3' : gateFailed ? '#fdfaf1' : '#f6f7f8',
        border: `1px solid ${eligible === false ? '#f2c4c1' : gateFailed ? '#ecdcae' : '#e6e8ec'}`,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ShieldCheck
          className="h-4 w-4 shrink-0"
          style={{ color: gateFailed ? '#8a6d1f' : eligible === false ? '#a32d2d' : '#066143' }}
          aria-hidden="true"
        />
        <span className="t-body" style={{ fontWeight: 600 }}>
          {gateResult
            ? eligible
              ? `You can publish. A bond costs you ${money(bondCost)}.`
              : Number(gateResult.reasonCode) === 1
                ? 'This wallet is not registered yet.'
                : `You cannot publish: ${gateResult.reason}`
            : gateFailed
              ? 'Could not check whether you are allowed to publish.'
              : 'Checking whether you are allowed to publish'}
        </span>

        {gateResult && Number(gateResult.reasonCode) === 1 && (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy.reg}
            onClick={() =>
              run('reg', async () => {
                await FQ.call('/api/admin/register', { deal: dealId, address: gateAddr });
                await checkGate(gateAddr);
              })
            }
          >
            {busy.reg ? 'Registering' : 'Register this wallet'}
          </button>
        )}
        {gateFailed && (
          <button
            className="btn btn-sm"
            disabled={busy.gate}
            onClick={() => run('gate', () => checkGate(gateAddr))}
          >
            {busy.gate ? 'Checking' : 'Try again'}
          </button>
        )}

        {/*
          A toggle, not a <details>.

          The disclosure was a <details> sitting inside this flex row with ml-auto,
          so its expanded panel became a flex ITEM: the address field, the three
          stats and the four checks were all crushed into whatever width was left
          over at the end of a line. It read as a jumble, which is exactly what it
          was. Own state, and the panel renders below the row at full width.
        */}
        <button
          className="t-small ml-auto inline-flex items-center gap-1.5"
          aria-expanded={gateOpen}
          onClick={() => setGateOpen((v) => !v)}
        >
          Details
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform"
            style={{ transform: gateOpen ? 'rotate(180deg)' : 'none' }}
          />
        </button>
      </div>

      {gateOpen && (
        <div className="mt-4 pt-4 space-y-5" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end">
              <div className="field">
                <label className="t-label" htmlFor="uw">
                  {wallet?.address ? 'Your connected wallet' : 'Wallet to check'}
                </label>
                <input
                  id="uw"
                  className="input hash"
                  value={gateAddr}
                  onChange={(e) => setGateAddr(e.target.value)}
                  placeholder="0x..."
                />
              </div>
              <button
                className="btn"
                disabled={busy.gate || !gateAddr}
                onClick={() => run('gate', () => checkGate(gateAddr))}
              >
                {busy.gate ? 'Checking' : 'Re-check'}
              </button>
            </div>

            {gateResult && (
              <div className="grid grid-cols-3 gap-5">
                <Stat label="Bond multiplier" value={`${multiplier}x`} hint="of the base deposit" />
                <Stat
                  label="A bond costs you"
                  value={money(bondCost)}
                  hint={gateResult.minBond ? `base ${money(gateResult.minBond)}` : ''}
                />
                <Stat label="Eligible" value={eligible ? 'Yes' : 'No'} hint={eligible ? '' : gateResult.reason} />
              </div>
            )}

            {/*
              The four checks, shown rather than described. The gate is the most
              interesting thing on this page and it used to be one verdict with the
              four tests behind it buried in a sentence, so anyone demoing it had
              nothing to point at. A refusal now shows which door closed.
            */}
            <div>
              <p className="t-label mb-3">What the gate checks, in order</p>
              <ul className="space-y-2">
                {[
                  { code: 3, label: 'Wallet age', note: 'old enough to have a history' },
                  { code: 4, label: 'Track record', note: 'enough resolved calls to be worth hearing' },
                  { code: 5, label: 'Shared funding source', note: 'not secretly funded by the borrower' },
                  { code: 6, label: 'Repeated counterparty', note: 'the same pair is not always appearing' },
                ].map((c) => {
                  const failedHere = gateResult && Number(gateResult.reasonCode) === c.code;
                  const passed = gateResult && !failedHere;
                  return (
                    <li key={c.code} className="flex items-start gap-3">
                      <span
                        className="shrink-0 h-5 w-5 rounded-full grid place-items-center mt-0.5"
                        style={{
                          background: failedHere ? '#fdf4f3' : passed ? '#f0faf6' : '#f0f1f3',
                          border: `1px solid ${failedHere ? '#f2c4c1' : passed ? '#cfe9de' : '#e6e8ec'}`,
                        }}
                      >
                        {failedHere ? (
                          <AlertTriangle className="h-3 w-3" style={{ color: '#a32d2d' }} />
                        ) : passed ? (
                          <Check className="h-3 w-3" style={{ color: '#066143' }} />
                        ) : null}
                      </span>
                      <span className="min-w-0">
                        <span className="t-body" style={{ fontWeight: 600 }}>
                          {c.label}
                        </span>
                        <span className="t-small block">{c.note}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <Why label="Why this is the same on every deal">
              The gate scores the wallet, not the credit, so your multiplier is deliberately the
              same everywhere. The one exception is the shared funding source check, which is the
              point of the whole gate: it stops you rating your own loan through a second wallet,
              and it refuses rather than warns.
            </Why>

            <p className="t-small">
              {eligible ? 'Want to see a refusal? ' : 'Cleared it by mistake? '}
              <button
                className="btn-quiet"
                disabled={busy.flag}
                onClick={() =>
                  run('flag', async () => {
                    await FQ.call('/api/admin/flag', {
                      deal: dealId,
                      address: gateAddr,
                      flagged: Boolean(eligible),
                    });
                    await checkGate(gateAddr);
                  })
                }
              >
                {eligible ? 'Flag this wallet for collusion' : 'Clear the flag'}
              </button>
            </p>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/*
        A title that says what you do here.

        "Put your capital where your model is" is a slogan. It is a good slogan and
        it told a first time reader nothing about what the page was for, which is
        the only job a page title has. Three verbs, in order, matching the three
        steps below.
      */}
      <PageHeader
        kicker="For people who run a credit model"
        title="Put your capital where your model is"
      />
      <PageBody>
        {/*
          isMock || FQ.isMock(), and the second half is the one that matters.

          Local state only became true if THIS page took its own fallback branch.
          The flag is global and sticky, so a failure on Invest silently put every
          later page into practice data with no banner. Ask the module, not the
          component.
        */}
        {(isMock || FQ.isMock()) && (
          <Note tone="no" title="Practice data - these numbers are invented">
            The chain could not be reached, so the page is running on a simulation.
            Nothing here is on X Layer and no figure below is real. Reload to try the
            live chain again.
          </Note>
        )}
        {error && (
          <Note tone="no" title="That did not work">
            {error}
          </Note>
        )}

        {/*
          When every deal fails, that is one fact, not four.

          Each unreadable deal renders an "Unavailable" chip, which is right when one
          of them is having a bad time. When the RPC itself is unreachable all four
          fail at once and the page fills with identical broken cards, which reads as
          "this protocol is broken" rather than "the network is not answering". Same
          data, completely different conclusion. Said once, at the top, in the terms
          that are actually true.
        */}
        {allUnavailable && (
          <Note tone="no" title="Cannot reach X Layer testnet right now">
            Every deal failed to read, which points at the network rather than at any
            one deal. The contracts and your positions are untouched. Reload in a
            moment, and if it persists the testnet RPC is likely down.
          </Note>
        )}

        {/*
          Bring your own model: signposted here, argued for on step 2.

          The control existed but sat on step two behind a tab below the fold, so the
          strongest claim in the design was invisible to the person it was built for.
          Announcing it at the top fixed that and immediately created a second
          problem: it announced it in seventy nine words, in a dashed callout, above
          a page that already had a stepper, a standing bar and a header lede all
          competing for the same attention. Fixing invisibility by shouting is not
          fixing it.

          A signpost's job is to point, not to persuade. One line and a link. The
          reasons - that postPrediction takes four values and has never cared how any
          of them were produced, that a transformer and a spreadsheet are
          indistinguishable to the contract - belong on step 2 next to the fields
          where they change what you type, and in BUILD-A-MODEL.md where somebody has
          already decided to read.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
          <Cpu className="h-4 w-4 shrink-0" style={{ color: 'var(--ink-muted)' }} aria-hidden="true" />
          <span className="t-body" style={{ fontWeight: 600 }}>
            Already have a model? Publish its number instead of ours.
          </span>
          <a
            className="btn-quiet"
            href={LINKS.buildAModel}
            target="_blank"
            rel="noopener noreferrer"
          >
            How to connect it
          </a>
        </div>

        <div className="pt-2 pb-1">
          <Progress steps={STEPS} at={step} go={setStep} />
        </div>

        {/* ---------------------------------------------------- 1. the deal -- */}
        {step === 0 && (
          <Panel
            title="Pick the credit you are judging"
            lede="Each deal is a different book of invoices from a different obligor."
          >
            {/*
              An empty dropdown used to render as a dropdown. It opened, showed
              nothing, closed, and left you to guess whether the protocol had no
              deals or the page had failed to load them. Those are completely
              different situations and the control looked identical in both.
            */}
            {dealOptions.length === 0 ? (
              <Note tone="no" title="No deals to show">
                The deal list came back empty. That is either a load failure, in which
                case reloading usually clears it, or this deployment genuinely has no
                deals configured yet. Either way there is nothing to underwrite until
                it resolves.
              </Note>
            ) : (
              <div className="max-w-md">
                <Select
                  label="Deal"
                  value={dealId ?? ''}
                  onChange={switchDeal}
                  options={dealOptions}
                />
              </div>
            )}

            <div
              className="grid grid-cols-2 sm:grid-cols-4 gap-5 mt-6 pt-6"
              style={{ borderTop: '1px solid var(--line)' }}
            >
              <Stat label="Drawn" value={money(D.drawnAmount)} />
              <Stat label="Senior" value={money(D.seniorAssets)} hint="loses last" />
              <Stat label="Junior" value={money(D.juniorAssets)} hint="loses first of the two" />
              <Stat label="Matures in" value={`${state.daysToMaturity}d`} />
            </div>

            {/*
              Drawing down, which had no button anywhere and quietly broke the only
              journey that matters.

              A new user could deposit into an Open deal and then never sell, because
              selling needs a Funded deal, and they could not deposit into a Funded one
              because deposits close on drawdown. So the headline feature was reachable
              only by whichever wallet happened to be seeded with tranche tokens. This
              is the missing move: subscriptions close, the originator takes the money,
              and every position becomes live and sellable.
            */}
            {D.status === 'Open' && (
              <div
                className="mt-6 pt-6 flex flex-wrap items-end justify-between gap-4"
                style={{ borderTop: '1px solid var(--line)' }}
              >
                <div className="min-w-0 max-w-md">
                  <p className="t-label">Still taking deposits</p>
                  <p className="t-body mt-1">
                    {D.juniorAssets === 0
                      ? 'Junior is the first loss layer, so nothing can be drawn down until somebody takes that side.'
                      : `Drawing down sends ${money(
                          D.seniorAssets + D.juniorAssets,
                        )} to the company and makes every position live and sellable.`}
                  </p>
                </div>
                {D.juniorAssets > 0 && (
                  <button
                    className="btn btn-primary shrink-0"
                    disabled={busy.fund}
                    onClick={() =>
                      run('fund', async () => {
                        await FQ.call('/api/fund', { deal: dealId });
                        await refresh();
                      })
                    }
                  >
                    {busy.fund
                      ? 'Drawing down'
                      : `Draw down ${money(D.seniorAssets + D.juniorAssets)}`}
                  </button>
                )}
              </div>
            )}
          </Panel>
        )}

        {/* ------------------------------------------------ 2. the opinion --- */}
        {step === 1 && (
          <Panel
            title="Post your number"
            lede="Say how much of this book goes unpaid, and lock a bond behind the answer."
            why={
              <Why>
                Everywhere else a credit score costs nothing to be wrong about, which is why nobody
                trusts on chain ratings. Here the model's written reasoning is fingerprinted onto
                the chain beside the number, and your own cash sits behind it. Miss by more than the
                tolerance band and it is taken and paid to investors before they absorb a penny.
              </Why>
            }
          >
            {/* Am I allowed, and what does it cost. Both answered where they bite. */}
            <div className="mb-6">{standing}</div>

            {/*
              Whose opinion is it.

              This said "Already published on this deal" and "the deposit shown below
              is locked on chain right now", which reads as YOUR deposit. Usually it
              is not: a deal carries one opinion, and if somebody else got there
              first the page was quietly attributing their bond to you. On screen
              that produced "this wallet is not registered yet" sitting directly
              above "you have already published", which is not a state that can
              exist.
            */}
            {P.exists ? (
              <Note
                tone="ok"
                title={
                  gateAddr && P.underwriter && gateAddr.toLowerCase() === P.underwriter.toLowerCase()
                    ? 'You have already published on this deal'
                    : 'Somebody else has already scored this deal'
                }
              >
                {gateAddr && P.underwriter && gateAddr.toLowerCase() === P.underwriter.toLowerCase()
                  ? 'Your bond is locked on chain right now. Pick another deal on step 1 to publish again.'
                  : `${shortAddr(P.underwriter)} got here first, and the figures below are theirs. A deal carries one opinion, so pick another on step 1 to publish your own.`}
              </Note>
            ) : (
              <div className="space-y-5">
                {/*
                  Bring your own model.

                  postPrediction takes a rate, a confidence, a hash of the reasoning and
                  a version string. It has never cared how those were produced, which
                  makes the protocol model agnostic by construction. The product was
                  hiding that: the only way to publish was to run our engine, so the
                  strongest claim in the design was unusable and looked like a boast.
                */}
                <div
                  className="inline-flex gap-1 p-1 rounded-[12px]"
                  style={{ background: '#f0f1f3' }}
                  role="tablist"
                  aria-label="Where the number comes from"
                >
                  {[
                    [false, "Use Firm Quote's model"],
                    [true, 'Publish my own number'],
                  ].map(([v, label]) => (
                    <button
                      key={label}
                      role="tab"
                      aria-selected={ownModel === v}
                      onClick={() => setOwnModel(v)}
                      className="px-3 h-9 rounded-[9px] text-[13.5px] font-semibold transition-colors"
                      style={
                        ownModel === v
                          ? { background: '#fff', color: 'var(--ink)', boxShadow: '0 1px 2px rgba(11,13,18,0.10)' }
                          : { color: 'var(--ink-muted)' }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {ownModel ? (
                  <div className="space-y-4">
                    {/*
                      By the time somebody has clicked this tab they have decided.
                      They need to know what to type, not to be sold the idea again,
                      so the argument that used to live here is one clause now and
                      the rest is a pointer to the script.
                    */}
                    <p className="t-small">
                      The contract stores four values and never asks how you produced them.{' '}
                      <a
                        className="btn-quiet"
                        href={LINKS.buildAModel}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Do it from a script instead
                      </a>
                    </p>
                    <div className="grid sm:grid-cols-3 gap-4">
                      <div className="field">
                        <label className="t-label" htmlFor="ownrate">
                          Expected unpaid, percent
                        </label>
                        <input
                          id="ownrate"
                          className="input num"
                          value={ownRate}
                          onChange={(e) => setOwnRate(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="t-label" htmlFor="ownconf">
                          Your confidence, percent
                        </label>
                        <input
                          id="ownconf"
                          className="input num"
                          value={ownConf}
                          onChange={(e) => setOwnConf(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="t-label" htmlFor="ownver">
                          Model name and version
                        </label>
                        <input
                          id="ownver"
                          className="input"
                          placeholder="acme-credit-v2"
                          value={ownVersion}
                          onChange={(e) => setOwnVersion(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label className="t-label" htmlFor="ownwhy">
                        Why. This is hashed on chain beside your number.
                      </label>
                      <textarea
                        id="ownwhy"
                        className="input"
                        style={{ minHeight: 92, paddingTop: 10, paddingBottom: 10 }}
                        placeholder="What in the invoice book drove this number."
                        value={ownWhy}
                        onChange={(e) => setOwnWhy(e.target.value)}
                      />
                      <p className="t-small">
                        Twenty characters minimum. Anyone can check the text against the hash later.
                      </p>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={busy.post || eligible === false || ownWhy.trim().length < 20}
                      onClick={() =>
                        run('post', async () => {
                          setScoreResult(
                            await FQ.call('/api/underwrite', {
                              deal: dealId,
                              score: {
                                defaultRateBps: Math.round(Number(ownRate) * 100),
                                confidenceBps: Math.round(Number(ownConf) * 100),
                                reasoning: ownWhy,
                                modelVersion: ownVersion || 'external-model',
                              },
                            }),
                          );
                          await refresh();
                        })
                      }
                    >
                      {/*
                        The price goes on the button.

                        "Publish and lock the deposit" does not say what the deposit
                        is, so the only irreversible control on the page was also the
                        only one that did not state its own cost. It is the last thing
                        under the cursor before money moves; it should be the last
                        place the number appears.
                      */}
                      {busy.post
                        ? 'Publishing'
                        : `Publish ${ownRate}% and lock ${money(bondCost)}`}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="btn"
                      disabled={busy.score}
                      onClick={() =>
                        run('score', async () =>
                          setScoreResult(await FQ.call('/api/underwrite', { deal: dealId, dryRun: true })),
                        )
                      }
                    >
                      Run the model only
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={busy.post || eligible === false}
                      onClick={() =>
                        run('post', async () => {
                          setScoreResult(await FQ.call('/api/underwrite', { deal: dealId }));
                          await refresh();
                        })
                      }
                    >
                      {busy.post ? 'Publishing' : `Publish and lock ${money(bondCost)}`}
                    </button>
                  </div>
                )}
              </div>
            )}

            {(scoreResult || P.exists) && (
              <div className="space-y-5 mt-6">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 panel-soft p-5">
                  <Stat
                    label="Expected unpaid"
                    value={pct(scoreResult?.score.defaultRateBps ?? P.predictedDefaultRateBps)}
                    hint="of the book"
                  />
                  <Stat
                    label="Model confidence"
                    value={pct(scoreResult?.score.confidenceBps ?? P.confidenceBps)}
                  />
                  <Stat label="Your bond" value={money(P.bondAmount)} hint="locked on chain" />
                  <Stat label="Tolerance" value="2.00%" hint="before any slash" />
                </div>
                {scoreResult && (
                  <Note tone="info" title="Why it says that">
                    {scoreResult.score.reasoning}
                  </Note>
                )}
              </div>
            )}
          </Panel>
        )}

        {/* ------------------------------------------------ 3. the outcome --- */}
        {step === 2 && (
          <Panel
            title="See who was right"
            lede={`Set what actually went unpaid, then settle. You called ${pct(P.predictedDefaultRateBps)}.`}
            why={
              <Why>
                You are allowed to be off by the tolerance band. Past that, the slash rises in
                proportion to the miss, and a miss of ten percentage points takes the whole deposit.
                A cleverer curve would price the risk marginally better and would be impossible to
                explain in a room, so this one stays deliberately simple.
              </Why>
            }
          >
            {/*
              A deal that was never funded has no outcome to settle, and the button
              used to be live anyway. Pressing it returned WrongStatus(2, 1) straight
              from the vault, which is not a sentence. Offer nothing instead.
            */}
            {D.status === 'Open' ? (
              <Note tone="info" title="Nothing to settle yet">
                No money has been drawn on this deal, so there is no outcome. A deal has to be
                funded before it can mature and be settled.
                <p className="mt-3">
                  <button className="btn btn-sm" onClick={() => setStep(0)}>
                    Pick a funded deal
                  </button>
                </p>
              </Note>
            ) : settled ? (
              <Note tone="info" title="Already settled">
                It matured at {pct(P.actualDefaultRateBps)} against a {pct(P.predictedDefaultRateBps)}{' '}
                call, so {money(P.bondSlashed)} was taken and paid down the waterfall ahead of every
                investor.
              </Note>
            ) : (
              <div className="space-y-5">
                <div className="field">
                  <label className="t-label" htmlFor="ab">
                    Actually went unpaid: <span className="num">{pct(actualBps)}</span>
                  </label>
                  <input
                    id="ab"
                    type="range"
                    min="0"
                    max="10000"
                    step="100"
                    value={actualBps}
                    onChange={(e) => {
                      setActualBps(Number(e.target.value));
                      setPreview(null);
                    }}
                    className="w-full"
                  />
                  <p className="t-small">
                    You called {pct(P.predictedDefaultRateBps)}. Drag past{' '}
                    {pct(P.predictedDefaultRateBps + 200)} to cross the tolerance band.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="btn"
                    disabled={busy.pv}
                    onClick={() =>
                      run('pv', async () =>
                        setPreview(
                          await FQ.call('/api/resolve', {
                            deal: dealId,
                            actualDefaultRateBps: actualBps,
                            dryRun: true,
                          }),
                        ),
                      )
                    }
                  >
                    What would that cost me?
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy.rs}
                    onClick={() =>
                      run('rs', async () => {
                        setResolved(
                          await FQ.call('/api/resolve', { deal: dealId, actualDefaultRateBps: actualBps }),
                        );
                        await refresh();
                      })
                    }
                  >
                    {busy.rs ? 'Settling' : 'Settle the deal'}
                  </button>
                </div>
              </div>
            )}

            {preview && !resolved && (
              <div className="mt-5">
                <Note
                  tone={preview.wouldSlash > 0 ? 'no' : 'ok'}
                  title={
                    preview.wouldSlash > 0
                      ? `${money(preview.wouldSlash)} would be taken from you`
                      : 'You would keep the whole deposit'
                  }
                >
                  {preview.wouldSlash > 0
                    ? `You promised ${pct(P.predictedDefaultRateBps)} and reality came in at ${pct(actualBps)}. That money goes to the investors.`
                    : 'Close enough to what you predicted. You called this one correctly.'}
                </Note>
              </div>
            )}

            {resolved?.waterfall && (
              <div className="space-y-4 mt-6">
                <p className="t-h3">
                  {money(resolved.waterfall.loss)} was lost. It came out in this order.
                </p>
                {[
                  ['Your deposit', resolved.waterfall.fromBond, 'went first'],
                  ['Junior investors', resolved.waterfall.fromJunior, 'went second'],
                  ['Senior investors', resolved.waterfall.fromSenior, 'went last'],
                ].map(([name, v, when]) => (
                  <div key={name} className="flex justify-between items-baseline gap-4 panel-soft p-4">
                    <span className="t-body">
                      {name} <span className="t-small">{when}</span>
                    </span>
                    <span className="num text-[18px] font-bold">{money(v)}</span>
                  </div>
                ))}
                <Note tone="info" title="That is the whole point">
                  You lost your own money before a single investor did, and your score dropped, so
                  the next deal costs you more to underwrite.
                </Note>
              </div>
            )}
          </Panel>
        )}

        <div
          className="flex items-center justify-between gap-3 pt-6"
          style={{ borderTop: '1px solid var(--line)' }}
        >
          <button className="btn" onClick={() => setStep((v) => Math.max(0, v - 1))} disabled={step === 0}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          {step < 2 ? (
            <button className="btn btn-primary" onClick={() => setStep((v) => v + 1)}>
              Next: {STEPS[step + 1]}
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setActivePage('invest')}>
              See it from the investor side
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </PageBody>
    </>
  );
};
