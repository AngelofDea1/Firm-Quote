import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ArrowRight, ArrowUpRight, CheckCircle, ChevronDown, Info, Menu, MessageCircle, TrendingUp } from 'lucide-react';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import { FQ } from './api';
import { Invest } from './pages/Invest';
import { Underwrite } from './pages/Underwrite';
import { Privacy, Terms } from './pages/Legal';
import { useWallet } from './useWallet';
import { WalletButton } from './components/WalletButton';

function cn(...inputs) { return twMerge(clsx(inputs)); }

/**
 * External links live in links.js and nowhere else, so changing a URL is a one line
 * edit. They moved out of this file when the Underwrite page needed the same repo
 * URL and importing App from a page would have made a cycle.
 */
import { LINKS } from './links';

/** Every routable view. The hash router below validates against this list. */
const PAGES = ['home', 'invest', 'mechanics', 'liquidity', 'risk', 'knowledge', 'privacy', 'terms'];

/**
 * The console is gone.
 *
 * It was a second application doing the same quote-and-sell job as Invest, and the
 * overlap meant a visitor could not tell which surface was the real one. Its three
 * genuinely distinct moments, the gate, the staked score and the settlement, were
 * all the underwriter's side rather than the investor's, so they moved to the
 * Underwrite page where the name already promised them.
 *
 * #console and #exit are kept as redirects because they were shared and linked.
 */
const LEGACY_HASH = { console: 'risk', exit: 'invest' };

const Navbar = ({ activePage, setActivePage, wallet }) => {
  const [open, setOpen] = useState(false);
  // Invest is deliberately not in this list. It is the primary button on the right,
  // and having it in both places makes the nav look like it has two front doors.
  const pages = [
    { id: 'mechanics', label: 'How it works' },
    { id: 'liquidity', label: 'Earn' },
    { id: 'risk', label: 'Underwrite' },
    { id: 'knowledge', label: 'FAQ' },
  ];

  const go = (id) => {
    setActivePage(id);
    setOpen(false);
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-[#e6e8ec] bg-white/90 backdrop-blur-xl">
      {/*
        Three column grid, not a flex row.

        Flex with `ml-auto` on the actions pushed the links wherever the brand and
        the buttons left room, so they drifted left and sat closer to the logo than
        to centre. A grid with equal outer columns pins the middle column to the real
        centre of the bar regardless of how wide the brand or the actions get.
      */}
      <div className="container mx-auto px-6 h-16 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        {/* brand */}
        <button className="flex items-center gap-2.5 justify-self-start" onClick={() => go('home')}>
          <img src="/logo.jpg" alt="Firm Quote" className="h-8 w-8 rounded-[10px] object-cover" />
          <span className="font-bold text-[17px] tracking-tight">Firm Quote</span>
        </button>

        {/* links, centred */}
        <div className="hidden md:flex items-center gap-1 justify-self-center">
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => go(p.id)}
              className="px-3.5 h-9 rounded-[10px] text-[14px] font-semibold transition-colors"
              style={
                activePage === p.id
                  ? { color: 'var(--ink)', background: '#f0f1f3' }
                  : { color: 'var(--ink-muted)' }
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* keeps the grid three columns wide on mobile so the centre stays centred */}
        <div className="md:hidden" />

        {/*
          Invest first, then the wallet.

          Connecting a wallet is not a goal, it is a chore you do because you decided
          to invest. Putting it first asked people to hand over their wallet before
          the site had told them what for. The order now matches the intent: decide,
          then connect.
        */}
        <div className="flex items-center gap-2 justify-self-end">
          <button className="btn btn-primary btn-sm" onClick={() => go('invest')}>
            Invest
          </button>
          <div className="hidden sm:block">
            <WalletButton wallet={wallet} />
          </div>
          <button
            className="md:hidden btn btn-sm px-2"
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* mobile menu */}
      {open && (
        <div className="md:hidden border-t border-[#e6e8ec] bg-white px-6 py-3 space-y-1">
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => go(p.id)}
              className="block w-full text-left px-3 h-11 rounded-[10px] text-[15px] font-semibold"
              style={{ color: activePage === p.id ? 'var(--ink)' : 'var(--ink-muted)' }}
            >
              {p.label}
            </button>
          ))}
          <div className="pt-2 sm:hidden">
            {/* Full size here: a phone menu is a tap target, not a toolbar. */}
            <WalletButton wallet={wallet} size="" />
          </div>
        </div>
      )}
    </nav>
  );
};

/**
 * Footer.
 *
 * Three things were wrong here and all three were the kind a visitor notices:
 *   - the brand mark pointed at /logo.png, which does not exist in public/, so it
 *     rendered a broken image icon on every page
 *   - "Risk disclosure" and "Terms of Service" went to the same page, so one of
 *     them was lying about its destination
 *   - links used <a href="#page"> with an onClick, which fights the hash router:
 *     the browser jumps, then React re-renders, and a middle click opens a URL
 *     that does not resolve on its own
 *
 * Internal navigation is buttons now, because that is what it is. External links
 * stay anchors, because those genuinely are links.
 */
const FooterLink = ({ onClick, children }) => (
  <li>
    <button
      onClick={onClick}
      className="text-[#454b57] hover:text-black text-sm font-medium transition-colors text-left"
    >
      {children}
    </button>
  </li>
);

const FooterOut = ({ href, children }) => (
  <li>
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#454b57] hover:text-black text-sm font-medium transition-colors inline-flex items-center gap-1.5"
    >
      {children}
      <ArrowUpRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
    </a>
  </li>
);

const Footer = ({ setActivePage }) => (
  <footer className="w-full bg-white border-t border-[#e6e8ec] py-16 mt-20">
    <div className="container mx-auto px-6 grid grid-cols-1 md:grid-cols-4 gap-10">
      <div className="space-y-4 md:col-span-1">
        <div className="flex items-center gap-2.5">
          <img src="/logo.jpg" alt="Firm Quote" className="h-8 w-8 rounded-[10px] object-cover" />
          <span className="font-bold text-[17px] tracking-tight">Firm Quote</span>
        </div>
        <p className="text-[#6b7280] text-sm leading-relaxed max-w-xs">
          AI credit opinions that are firm, not indicative. The model posts collateral behind every
          score.
        </p>
      </div>

      <div className="space-y-4">
        <h4 className="text-[12px] font-bold tracking-wider uppercase text-[#0b0d12]">Product</h4>
        <ul className="space-y-2.5">
          <FooterLink onClick={() => setActivePage('invest')}>Invest</FooterLink>
          <FooterLink onClick={() => setActivePage('risk')}>Underwrite</FooterLink>
          <FooterLink onClick={() => setActivePage('mechanics')}>How it works</FooterLink>
          <FooterLink onClick={() => setActivePage('liquidity')}>Earn as a provider</FooterLink>
        </ul>
      </div>

      <div className="space-y-4">
        <h4 className="text-[12px] font-bold tracking-wider uppercase text-[#0b0d12]">Learn</h4>
        <ul className="space-y-2.5">
          <FooterLink onClick={() => setActivePage('knowledge')}>FAQ and safeguards</FooterLink>
          <FooterOut href={LINKS.repo}>Source on GitHub</FooterOut>
          <FooterOut href="https://www.okx.com/xlayer">About X Layer</FooterOut>
        </ul>
      </div>

      <div className="space-y-4">
        <h4 className="text-[12px] font-bold tracking-wider uppercase text-[#0b0d12]">Legal</h4>
        <ul className="space-y-2.5">
          <FooterLink onClick={() => setActivePage('terms')}>Terms of service</FooterLink>
          <FooterLink onClick={() => setActivePage('privacy')}>Privacy policy</FooterLink>
        </ul>
      </div>
    </div>
    <div className="container mx-auto px-6 pt-10 mt-12 border-t border-[#e6e8ec] flex flex-col md:flex-row justify-between items-center gap-3">
      <p className="text-sm text-[#6b7280]">
        © {new Date().getFullYear()} Firm Quote. Testnet software, not financial advice.
      </p>
      <p className="text-sm text-[#6b7280]">Running on X Layer</p>
    </div>
  </footer>
);

const PageTransition = ({ children }) => (
  <motion.div
    initial={{ opacity: 0, y: 15 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -15 }}
    transition={{ duration: 0.4, ease: "easeOut" }}
    className="w-full"
  >
    {children}
  </motion.div>
);

/**
 * The handoff at the bottom of every page. Reading a page should always end
 * with one obvious thing to do next, otherwise the only way forward is the
 * navbar and the site feels like a pile of documents rather than a path.
 */
const NextStep = ({ label, title, body, cta, onGo, alt, altLabel }) => (
  <div className="w-full border-t border-[#e6e8ec] bg-[#f7f8f9]">
    <div className="container mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-col md:flex-row md:items-center gap-6 md:justify-between">
        <div className="max-w-xl">
          <p className="text-[12px] font-bold uppercase tracking-wider text-[#6b7280]">{label}</p>
          <h3 className="text-[22px] font-bold mt-1">{title}</h3>
          <p className="text-[15px] text-[#454b57] leading-relaxed mt-2">{body}</p>
        </div>
        <div className="flex gap-3 shrink-0">
          {alt && (
            <button className="btn" onClick={alt}>{altLabel}</button>
          )}
          <button className="btn btn-primary btn-lg" onClick={onGo}>
            {cta}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
);

/**
 * One deal, told as a story, on the home page.
 *
 * A judge landing cold met a headline, one sentence, and two buttons. Nothing said
 * what a deal is, who is involved, or why any of it matters, so the only way to
 * find out was to click into a product surface and reverse engineer it. That is a
 * lot to ask of somebody with fifty submissions to get through.
 *
 * Four beats, in order, with the money at each one. It is the whole protocol in the
 * time it takes to scroll once.
 */
const HowItReadsInOneScreen = ({ setActivePage }) => (
  <div className="w-full border-t border-[#e6e8ec] bg-[#fbfbfc]">
    <div className="container mx-auto max-w-5xl px-6 py-20">
      <div className="text-center max-w-2xl mx-auto">
        <p className="t-label">One deal, start to finish</p>
        <h2 className="text-[28px] md:text-[34px] font-bold tracking-tight mt-2">
          A haulage company is owed a million dollars
        </h2>
        <p className="text-[16px] text-[#454b57] leading-relaxed mt-3">
          Its customers will pay in ninety days. It needs the cash now. Here is what
          happens next, and where the money sits at every step.
        </p>
      </div>

      <ol className="grid md:grid-cols-4 gap-5 mt-12">
        {[
          {
            n: '1',
            t: 'A model judges the risk',
            b: 'It reads the invoice book and says 8% will go unpaid. Its written reasoning is fingerprinted onto the chain beside the number.',
            k: 'Says 8.00% unpaid',
          },
          {
            n: '2',
            t: 'And bets on being right',
            b: 'The operator running that model locks $130,000 of its own money against the call. Nobody else has to trust it.',
            k: '$130,000 staked',
          },
          {
            n: '3',
            t: 'Investors fund it',
            b: 'Senior earns less and loses last. Junior earns more and loses first. Both are tokens you actually hold.',
            k: '$1,000,000 raised',
          },
          {
            n: '4',
            t: 'Ninety days later, truth',
            b: 'If the model was wrong, its money is taken first, before a single investor loses a penny. If it was right, the bond comes back.',
            k: 'Operator pays first',
          },
        ].map((x) => (
          <li key={x.n} className="card" style={{ padding: 22 }}>
            <span
              className="inline-grid place-items-center h-7 w-7 rounded-full text-[13px] font-bold"
              style={{ background: 'var(--ink)', color: '#fff' }}
            >
              {x.n}
            </span>
            <p className="t-h3 mt-4">{x.t}</p>
            <p className="text-[14px] text-[#454b57] leading-relaxed mt-2">{x.b}</p>
            <p className="num text-[15px] font-bold mt-4" style={{ color: 'var(--ink)' }}>
              {x.k}
            </p>
          </li>
        ))}
      </ol>

      <div className="card mt-6" style={{ padding: 26 }}>
        <div className="md:flex md:items-center md:justify-between gap-6">
          <div className="max-w-2xl">
            <p className="t-label">And the part nobody else has</p>
            <h3 className="text-[21px] font-bold mt-1">You are not stuck for ninety days</h3>
            <p className="text-[15px] text-[#454b57] leading-relaxed mt-2">
              A standing pool will buy your position back on any day, at a price the same
              model works out from current information. Senior and junior quote differently,
              because junior absorbs losses first and pretending otherwise would rob whoever
              holds it.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-6 mt-6 md:mt-0 shrink-0">
            <div>
              <p className="t-label">Senior sells at</p>
              <p className="num text-[24px] font-bold" style={{ color: 'var(--ink)' }}>
                97.2%
              </p>
              <p className="t-small">of face value</p>
            </div>
            <div>
              <p className="t-label">Junior sells at</p>
              <p className="num text-[24px] font-bold" style={{ color: 'var(--ink)' }}>
                61.7%
              </p>
              <p className="t-small">same deal, same day</p>
            </div>
          </div>
        </div>
      </div>

      {/* Two doors, named for the person rather than the mechanism. */}
      <div className="grid md:grid-cols-2 gap-5 mt-10">
        <button
          onClick={() => setActivePage('invest')}
          className="card text-left transition-colors hover:bg-white"
          style={{ padding: 24 }}
        >
          <p className="t-label">If you have money</p>
          <p className="t-h3 mt-1">Invest</p>
          <p className="text-[14px] text-[#454b57] leading-relaxed mt-2">
            Pick a deal, choose senior or junior, deposit. Sell back early whenever you want.
          </p>
          <p className="t-small mt-4 inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--ink)' }}>
            Browse the deals
            <ArrowRight className="h-3.5 w-3.5" />
          </p>
        </button>
        <button
          onClick={() => setActivePage('risk')}
          className="card text-left transition-colors hover:bg-white"
          style={{ padding: 24 }}
        >
          <p className="t-label">If you have a model</p>
          <p className="t-h3 mt-1">Underwrite</p>
          <p className="text-[14px] text-[#454b57] leading-relaxed mt-2">
            Publish a credit opinion with your own capital behind it. Get paid for being right,
            slashed for being wrong. <strong className="font-semibold text-[var(--ink)]">Any model
            works</strong> - bring yours, or use ours if you have not built one.
          </p>
          <p className="t-small mt-4 inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--ink)' }}>
            See the operator side
            <ArrowRight className="h-3.5 w-3.5" />
          </p>
        </button>
      </div>
    </div>
  </div>
);

const Home = ({ setActivePage }) => (
  <>
  <div className="flex flex-col items-center justify-center min-h-[100vh] relative text-center space-y-10 px-6">
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="space-y-8 max-w-4xl"
    >
      {/*
        This said "X Layer Mainnet Now Live". There is no mainnet deployment - the
        deployments directory holds localhost and xlayerTestnet, nothing else - and
        the footer four screens down says "Testnet software, not financial advice".
        So the first claim on the site was false and the page contradicted itself.

        For a protocol whose entire argument is that unbacked claims are worthless,
        opening with an unbacked claim is the one mistake it cannot afford. Chain
        1952 is what is actually live, and saying so costs nothing.
      */}
      <h1 className="text-[38px] md:text-[52px] font-extrabold tracking-tight text-black leading-[1.06]">
        AI Credit Opinions.<br />
        <span className="text-[#6b7280]">Firm, Not Indicative.</span>
      </h1>
      {/*
        This paragraph was one 27 word run at 18px with no break, which is roughly
        double the comfortable measure and read as a wall. Split into two sentences
        with the claim on its own line, and the measure pulled in to about 62
        characters, which is where prose stops being tiring.
      */}
      <p className="text-[17px] md:text-[18px] text-[#454b57] max-w-[34rem] mx-auto leading-[1.7]">
        Staked AI underwriting meets AI priced exit liquidity.
        <span className="block mt-3">
          The first protocol to put money where the model's mouth is, for tokenized real world
          credit.
        </span>
      </p>
      {/* Secondary left, primary right, so the eye finishes on the action we want. */}
      <div className="flex flex-wrap justify-center gap-3 pt-8">
        <button className="btn btn-lg" onClick={() => setActivePage('mechanics')}>
          See how it works
        </button>
        <button className="btn btn-primary btn-lg" onClick={() => setActivePage('invest')}>
          Start investing
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </motion.div>
    
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 1, duration: 1 }}
      className="absolute bottom-8 left-1/2 -translate-x-1/2 text-[#6b7280] animate-bounce"
    >
      <ChevronDown className="h-6 w-6" />
    </motion.div>
  </div>
  <HowItReadsInOneScreen setActivePage={setActivePage} />
  </>
);

const Mechanics = ({ setActivePage }) => (
  <div className="w-full">
    <div className="container mx-auto max-w-5xl px-6 py-16 space-y-16">
      <div className="space-y-6 text-center max-w-4xl mx-auto">
        <p className="text-sm font-bold uppercase tracking-widest text-[#6b7280]">How it works</p>
        <h1 className="text-[30px] md:text-[40px] font-bold tracking-tight leading-[1.12]">One risk engine, <br />applied twice.</h1>
        <p className="text-[18px] text-[#454b57] leading-relaxed mt-4 max-w-2xl mx-auto">
          The same scoring core prices entry and exit. It is not two AI features bolted together.
          If the two ever disagreed structurally, the exit price would stop meaning anything.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-8">
        <motion.div whileHover={{ y: -4 }} className="p-6 rounded-[16px] bg-white border border-[#e6e8ec] shadow-sm space-y-3">
          <h3 className="text-[19px] font-bold">1. Clear the gate</h3>
          <p className="text-[15px] text-[#454b57] leading-relaxed">
            Before anyone can underwrite, the reputation gate checks wallet age, track record,
            whether the underwriter and the borrower share a funding source, and whether the same
            pair keeps appearing. Failing any check reverts the transaction on chain.
          </p>
        </motion.div>
        <motion.div whileHover={{ y: -4 }} className="p-6 rounded-[16px] bg-white border border-[#e6e8ec] shadow-sm space-y-3">
          <h3 className="text-[19px] font-bold">2. Score it and stake it</h3>
          <p className="text-[15px] text-[#454b57] leading-relaxed">
            The model reads the invoice book and publishes an expected default rate, a confidence
            level and its written reasoning. The reasoning is hashed on chain next to the number,
            and the underwriter locks a bond sized by their track record.
          </p>
        </motion.div>
        <motion.div whileHover={{ y: -4 }} className="p-6 rounded-[16px] bg-white border border-[#e6e8ec] shadow-sm space-y-3">
          <h3 className="text-[19px] font-bold">3. Settle or slash</h3>
          <p className="text-[15px] text-[#454b57] leading-relaxed">
            When the outcome lands, the bond is slashed in proportion to the miss and the proceeds
            flow into the loss waterfall ahead of any investor. Getting it right returns the bond
            and lowers the price of underwriting next time.
          </p>
        </motion.div>
      </div>
    </div>

    <div className="w-full bg-gray-50/50 border-y border-[#e6e8ec]">
      <div className="container mx-auto max-w-5xl px-6 py-16">
        <div className="border border-[#e6e8ec] shadow-sm rounded-[16px] p-8 grid md:grid-cols-2 gap-10 bg-white">
          <div className="space-y-6">
            <h3 className="text-[24px] font-bold tracking-tight">The slashing rule fits in one line</h3>
            <p className="text-[15px] text-[#454b57] leading-relaxed">
              Miss by ten percentage points past the tolerance band and the underwriter loses the
              entire bond. A cleverer curve would price risk marginally better and would be
              impossible to explain in a room.
            </p>
            <pre className="p-4 rounded-[10px] text-[13px] overflow-x-auto whitespace-pre"
                 style={{ background: '#f7f8f9', border: '1px solid #e6e8ec', color: '#454b57',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
{`error   = actual - (predicted + tolerance)
slashed = bond x min(error, 1000 bps) / 1000 bps`}
            </pre>
          </div>
          <div className="space-y-6">
            <h3 className="text-[24px] font-bold tracking-tight">Losses burn in a strict order</h3>
            <p className="text-[15px] text-[#454b57] leading-relaxed">
              The operator's own collateral goes first, then junior capital, then senior. Senior
              investors are never touched while junior capital remains. That ordering is the most
              bug prone part of any structured product, so it has its own dedicated test suite.
            </p>
            <div className="space-y-3 mt-6">
              <div className="p-4 border border-[#e6e8ec] rounded-[10px] flex justify-between items-center bg-white">
                <span className="font-bold text-gray-900">Senior, hit last</span>
                <span className="num font-semibold text-[#0b0d12]">$800,000</span>
              </div>
              <div className="p-4 border border-[#e6e8ec] rounded-[10px] flex justify-between items-center bg-white">
                <span className="font-bold text-gray-900">Junior, hit second</span>
                <span className="num font-semibold text-[#0b0d12]">$200,000</span>
              </div>
              <div className="p-4 border border-[#e6e8ec] rounded-[10px] flex justify-between items-center bg-black text-white">
                <span className="font-bold">Operator bond, hit first</span>
                <span className="num font-semibold">$130,000</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <NextStep
      label="Next"
      title="Money in a deal you can leave early"
      body="The gate and the bond protect the score. The exit pool is what that protection buys an investor."
      cta="See the exit"
      onGo={() => setActivePage('liquidity')}
      alt={() => setActivePage('risk')}
      altLabel="The underwriter side"
    />
  </div>
);

const Liquidity = ({ setActivePage }) => (
  <div className="w-full">
    <div className="container mx-auto max-w-5xl px-6 py-16 space-y-16">
      <div className="space-y-6 text-center max-w-4xl mx-auto">
        <p className="text-sm font-bold uppercase tracking-widest text-[#6b7280]">For investors</p>
        <h1 className="text-[30px] md:text-[40px] font-bold tracking-tight leading-[1.12]">Your money is not <br />trapped in the deal.</h1>
        <p className="text-[18px] text-[#454b57] leading-relaxed mt-4 max-w-2xl mx-auto">
          Tranche holders genuinely cannot redeem before maturity. That is deliberate, and we say it
          plainly rather than hiding it behind a withdrawal queue. What we add instead is a standing
          bid that always has a price, refreshed by the same model that underwrote the deal.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-10 items-center">
        <div className="space-y-10">
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-[10px] bg-[#0b0d12] text-white flex items-center justify-center shrink-0">
              <CheckCircle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-[17px]">Priced, not guessed.</h3>
              <p className="text-[#454b57] leading-relaxed mt-1 text-[15px]">Par value, less the model's current view of the credit, less a published spread.</p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-[10px] bg-[#0b0d12] text-white flex items-center justify-center shrink-0">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-[17px]">Instant.</h3>
              <p className="text-[#454b57] leading-relaxed mt-1 text-[15px]">The pool takes the other side, so you do not wait for a matching buyer.</p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-[10px] bg-[#0b0d12] text-white flex items-center justify-center shrink-0">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-[17px]">Tranche aware.</h3>
              <p className="text-[#454b57] leading-relaxed mt-1 text-[15px]">Senior and junior quote at different prices, because the waterfall decides who actually absorbs the loss.</p>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <motion.div whileHover={{ scale: 1.02 }} className="p-6 rounded-[16px] bg-white border border-[#e6e8ec] flex flex-col gap-6 min-h-[180px]">
              <h3 className="text-[12px] font-bold uppercase tracking-wider text-[#6b7280]">Senior tranche</h3>
              <div>
                <p className="num text-[34px] font-bold tracking-tight text-black leading-none">98.03%</p>
                <p className="text-[13.5px] text-[#6b7280] mt-2 leading-snug">of par, after the model's latest re-score</p>
              </div>
            </motion.div>
            <motion.div whileHover={{ scale: 1.02 }} className="p-6 rounded-[16px] bg-white border border-[#e6e8ec] flex flex-col gap-6 min-h-[180px]">
              <h3 className="text-[12px] font-bold uppercase tracking-wider text-[#6b7280]">Junior tranche</h3>
              <div>
                <p className="num text-[34px] font-bold tracking-tight text-black leading-none">75.16%</p>
                <p className="text-[13.5px] text-[#6b7280] mt-2 leading-snug">of par, because junior absorbs this loss first</p>
              </div>
            </motion.div>
          </div>
          <div className="p-6 border border-[#e6e8ec] rounded-[16px] bg-white">
            <h3 className="font-bold text-[17px] mb-2">Why the two prices differ</h3>
            <p className="text-[15px] text-[#454b57] leading-relaxed">
              Expected loss of $117,500 on $1,000,000 drawn. The operator bond absorbs $71,760 of it and
              junior absorbs the remaining $45,740, so senior is untouched on credit and only takes a
              time value discount. Pricing both tranches the same would quietly overvalue junior.
            </p>
          </div>
        </div>
      </div>
    </div>

    <NextStep
      label="Next"
      title="Somebody has to stand behind that price"
      body="The quote is only worth something because the underwriter who set it has capital at risk. That side is worth a look."
      cta="The underwriter side"
      onGo={() => setActivePage('risk')}
      alt={() => setActivePage('invest')}
      altLabel="Sell a position now"
    />
  </div>
);


const KnowledgeBase = ({ setActivePage }) => (
  <div className="w-full">
    <div className="w-full bg-gray-50/50 border-b border-[#e6e8ec]">
      <div className="container mx-auto max-w-5xl px-6 py-16 space-y-16">
        <div className="space-y-6 text-center max-w-4xl mx-auto">
          <p className="text-sm font-bold uppercase tracking-widest text-[#6b7280]">Safeguards</p>
          <h1 className="text-[30px] md:text-[40px] font-bold tracking-tight leading-[1.12]">What stops this breaking.</h1>
          <p className="text-[18px] text-[#454b57] leading-relaxed mt-4 max-w-2xl mx-auto">
            A standing bid is only useful if it survives contact with someone trying to abuse it.
            Each of the following is enforced in the contract and covered by its own test.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {[
            { t: "Per exit cap", d: "No single exit may take more than 20 percent of the pool's cash, so one holder cannot drain it." },
            { t: "Concentration cap", d: "No single tranche may exceed 40 percent of pool net asset value, separately from the per exit limit." },
            { t: "Quote expiry", d: "A quote older than 15 minutes cannot be traded against. Stale prices are refused rather than honoured." },
            { t: "Honest accounting", d: "Pool net asset value counts cash plus inventory at current fair value, so a late provider is priced in correctly." },
            { t: "Cash invariant", d: "After settlement, vault cash must equal exactly what the two tranches are owed. A test asserts it on every path." },
            { t: "Offline fallback", d: "If the language model is unreachable the engine scores with a transparent, auditable fallback rather than failing." }
          ].map((item, i) => (
            <motion.div whileHover={{ y: -2 }} key={i} className="p-8 bg-white border border-[#e6e8ec] rounded-[16px] shadow-sm">
              <h3 className="font-bold text-[17px] mb-2">{item.t}</h3>
              <p className="text-[15px] text-[#454b57] leading-relaxed">{item.d}</p>
            </motion.div>
          ))}
        </div>

        <div className="p-5 rounded-[16px] flex gap-3 items-start" style={{ background: '#f7f8f9', border: '1px solid #e6e8ec' }}>
          <Info className="h-6 w-6 shrink-0 mt-0.5" />
          <p className="text-[15px] leading-relaxed">
            <b>Disclosed for the demo.</b> The invoice feed, the outcome trigger and the fresher data
            behind the reprice are simulated. The bond, the slash, the waterfall, the locking and every
            cap listed above are real on chain logic with nothing simulated in the path.
          </p>
        </div>
      </div>
    </div>

    <div className="container mx-auto max-w-5xl px-6 py-16 space-y-12">
      <h2 className="text-[30px] font-bold tracking-tight text-center">Frequently Asked Questions</h2>
      <div className="space-y-4">
        {[
          { q: "What actually happens if the model is wrong?", a: "The bond is slashed in proportion to the size of the miss and the proceeds are pushed into the tranche vault, where they are consumed before any junior investor takes a loss. The underwriter's reputation score also drops, which permanently raises the bond they must post on future deals. In the reference scenario a 40 percent realised default rate against a 4.23 percent prediction slashes the entire $130,000 bond." },
          { q: "Where does the exit pool's yield come from?", a: "A published spread, currently 1.50 percent, between the model's fair value and the price the pool pays. Liquidity providers are being paid to take on credit risk and duration that the exiting holder no longer wants. That is a real economic function, not an emission." },
          { q: "Is the operator bond really first loss capital?", a: "Only to the extent it would actually be slashed. This is a subtle point worth being precise about. If the credit deteriorates exactly as the underwriter predicted then they were right, nothing is slashed, and junior absorbs the loss alone." },
          { q: "Why can I not just redeem my tranche early?", a: "Because the capital has been drawn down to the originator and is financing real invoices. Pretending otherwise with an instant redemption feature would just be a queue that breaks under stress. Both tranche vaults return zero for maximum redeemable while the deal is funded." },
          { q: "What is simulated and what is real?", a: "Real: all five contracts, the reputation gate, bonding, proportional slashing, the loss waterfall, tranche locking, exit pricing and every safety cap. Simulated: the offchain invoice feed, the outcome oracle and the refreshed data used at reprice time." },
          { q: "Which chain does this run on?", a: "X Layer. Mainnet is chain ID 196 and testnet is chain ID 1952. Gas is paid in OKB rather than ETH, which catches most people out on their first deployment." }
        ].map((faq, i) => (
          <details key={i} className="group border border-[#e6e8ec] rounded-[16px] bg-white overflow-hidden shadow-sm transition-all hover:shadow-md">
            <summary className="flex items-center justify-between p-6 font-bold text-[17px] cursor-pointer list-none outline-none">
              {faq.q}
              <ChevronDown className="h-6 w-6 text-[#6b7280] group-open:rotate-180 transition-transform" />
            </summary>
            <div className="p-6 pt-0 text-[15px] text-[#454b57] bg-white leading-relaxed">
              {faq.a}
            </div>
          </details>
        ))}
      </div>
    </div>

    <NextStep
      label="Ready"
      title="Nothing left to read"
      body="Open the invest page and put money into the live deal, or sell a position you already hold."
      cta="Start investing"
      onGo={() => setActivePage('invest')}
    />
  </div>
);

const App = () => {
  const [activePage, setActivePage] = useState('home');
  // One wallet instance for the whole app. Two hooks would each hold their own copy
  // of the connection and disagree about whether anyone is connected.
  const [requiredChain, setRequiredChain] = useState(null);
  const wallet = useWallet(requiredChain);

  // The network the deployment lives on, so Connect can switch to it straight away.
  useEffect(() => {
    FQ.connect()
      .then((r) => setRequiredChain(r.state?.network?.chainId ?? null))
      .catch(() => {});
  }, []);

  // Read the hash on load AND on every change. Without the listener, any anchor link in the
  // footer or a shared deep link silently does nothing, because the hash updates but React
  // never hears about it.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash.replace('#', '');
      // #console and #exit were shared before the console was folded into Underwrite.
      // Send them somewhere sensible rather than dumping people on the home page.
      if (LEGACY_HASH[hash]) setActivePage(LEGACY_HASH[hash]);
      else if (PAGES.includes(hash)) setActivePage(hash);
      else if (!hash) setActivePage('home');
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    if (window.location.hash.replace('#', '') !== activePage) {
      window.location.hash = activePage;
    }
    window.scrollTo(0, 0);
    // Keep the document title in step with the view, which matters for history and for sharing.
    const titles = {
      home: 'Firm Quote | AI credit opinions that are firm, not indicative',
      invest: 'Invest | Firm Quote',
      mechanics: 'How it works | Firm Quote',
      liquidity: 'Earn as a liquidity provider | Firm Quote',
      risk: 'Underwrite and settle | Firm Quote',
      knowledge: 'FAQ and safeguards | Firm Quote',
      privacy: 'Privacy policy | Firm Quote',
      terms: 'Terms of service | Firm Quote',
    };
    document.title = titles[activePage] || titles.home;
  }, [activePage]);

  const renderPage = () => {
    switch (activePage) {
      case 'home': return <Home setActivePage={setActivePage} />;
      case 'mechanics': return <Mechanics setActivePage={setActivePage} />;
      case 'invest': return <Invest wallet={wallet} setActivePage={setActivePage} />;
      case 'liquidity': return <Liquidity setActivePage={setActivePage} />;
      case 'risk': return <Underwrite wallet={wallet} setActivePage={setActivePage} />;
      case 'knowledge': return <KnowledgeBase setActivePage={setActivePage} />;
      case 'privacy': return <Privacy />;
      case 'terms': return <Terms />;
      default: return <Home setActivePage={setActivePage} />;
    }
  };

  return (
    <div className="min-h-screen bg-white font-sans antialiased text-black flex flex-col">
      {/* Off screen until focused. Without it a keyboard user tabs through the whole
          navbar again on every single page before reaching any content. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Navbar activePage={activePage} setActivePage={setActivePage} wallet={wallet} />
      <main id="main" className="flex-grow flex flex-col" tabIndex={-1}>
        <AnimatePresence mode="wait">
          <PageTransition key={activePage}>
            {renderPage()}
          </PageTransition>
        </AnimatePresence>
      </main>
      <Footer setActivePage={setActivePage} />
    </div>
  );
};

export default App;
