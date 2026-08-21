import React from 'react';
import { AlertTriangle, Check, ChevronDown, Info } from 'lucide-react';

/**
 * Shared page furniture.
 *
 * Every page was inventing its own opening: different heading sizes, different
 * top padding, different max widths, a kicker on some and not others. Small
 * differences, but they are why moving between pages felt like moving between
 * three different sites. One component now, so they cannot drift again.
 */

/**
 * PAGE_W is the single content column for the entire site.
 *
 * The marketing pages were 1024px, Invest was 768px and its header was 896px, so
 * the content visibly jumped left and right as you moved between them and nothing
 * lined up with the navbar. Three different measures is three different websites.
 * One constant now, imported everywhere, so it cannot drift again.
 */
export const PAGE_W = 'max-w-5xl';

/**
 * Centred, because every other page on the site is.
 *
 * Home, How it works, Earn and the FAQ all open with a centred kicker, heading and
 * lede. Invest and Underwrite opened left aligned against the same navbar, so
 * moving between them threw the eye across the page every time. Matching the
 * majority was the fix, not inventing a third alignment.
 *
 * `aside` sits under the header rather than beside it. Floating a control to the
 * right of a centred block gives the block two competing centres and it stops
 * looking centred at all.
 */
export const PageHeader = ({ kicker, title, lede, aside }) => (
  <header className="w-full border-b border-[#e6e8ec] bg-[#fbfbfc]">
    <div className={`container mx-auto ${PAGE_W} px-6 py-14`}>
      <div className="text-center max-w-2xl mx-auto">
        {kicker && <p className="t-label">{kicker}</p>}
        <h1 className="t-h1 mt-2">{title}</h1>
        {lede && <p className="t-body mt-4">{lede}</p>}
      </div>
      {aside && <div className="flex justify-center mt-7">{aside}</div>}
    </div>
  </header>
);

/** The body every page sits in, so the measure and rhythm match everywhere. */
export const PageBody = ({ children, width = PAGE_W }) => (
  <div className={`container mx-auto ${width} px-6 py-10 space-y-6`}>{children}</div>
);

/**
 * Status, third attempt.
 *
 * Filled green and red pills made a list of deals look like a form full of
 * validation errors. Replacing them with a coloured dot was worse in a different
 * way: a small solid circle beside text is the universal idiom for a live status
 * light, so it read as something that ought to be blinking.
 *
 * This is a quiet chip. A hairline border and a very light tint of the state's own
 * hue, with the text in the dark end of that same hue, so the colour is carried by
 * the type rather than announced by an ornament. Legible at a glance, invisible
 * until you look, and it never reads as an alert.
 */
const CHIP = {
  Open:    { bg: '#f0faf6', border: '#cfe9de', fg: '#066143' },
  Funded:  { bg: '#f5f6f8', border: '#e0e3e8', fg: '#454b57' },
  Settled: { bg: '#fbfbfc', border: '#e6e8ec', fg: '#7b8290' },
};

export const Status = ({ status, label }) => {
  const c = CHIP[status] ?? CHIP.Settled;
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-[6px] px-2 py-1"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
    >
      <span
        className="text-[11px] font-bold uppercase"
        style={{ color: c.fg, letterSpacing: '0.04em' }}
      >
        {label ?? status}
      </span>
    </span>
  );
};

/** A labelled figure. Used in fours, because three never balances in a grid. */
export const Stat = ({ label, value, hint }) => (
  <div className="min-w-0">
    <p className="t-label truncate">{label}</p>
    <p className="num text-[17px] font-bold mt-1 truncate" style={{ color: 'var(--ink)' }}>
      {value}
    </p>
    {hint && <p className="t-small truncate">{hint}</p>}
  </div>
);

export const Note = ({ tone = 'info', title, children }) => {
  const map = {
    ok: { border: '#b8e2d1', bg: '#f0faf6', icon: <Check className="h-4 w-4" /> },
    no: { border: '#f2c4c1', bg: '#fdf4f3', icon: <AlertTriangle className="h-4 w-4" /> },
    info: { border: '#e6e8ec', bg: '#f7f8f9', icon: <Info className="h-4 w-4" /> },
  }[tone];
  return (
    <div
      className="rounded-[16px] p-5 space-y-2"
      style={{ border: `1px solid ${map.border}`, background: map.bg }}
    >
      {title && (
        <p className="t-h3 flex items-center gap-2">
          {map.icon}
          {title}
        </p>
      )}
      <div className="t-body">{children}</div>
    </div>
  );
};

export const Why = ({ children, label = 'Why this matters' }) => (
  <details className="group">
    <summary className="t-small inline-flex items-center gap-1.5 cursor-pointer list-none select-none hover:text-[color:var(--ink)]">
      <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      {label}
    </summary>
    <div className="t-body max-w-2xl mt-3 pl-5" style={{ borderLeft: '2px solid var(--line)' }}>
      {children}
    </div>
  </details>
);

/**
 * Skeletons rather than the word "Loading".
 *
 * A chain read is slow enough to notice. A bare "Loading..." on a blank page reads
 * as broken; a block in the shape of what is coming reads as working, and the page
 * does not jump when the real content lands because the space was already reserved.
 */
export const Skeleton = ({ h = 16, w = '100%', className = '' }) => (
  <span
    className={`block rounded-[6px] ${className}`}
    style={{ height: h, width: w, background: '#eef0f2' }}
    aria-hidden="true"
  />
);

export const CardSkeleton = () => (
  <div className="card" style={{ padding: 22 }}>
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-2 flex-1">
        <Skeleton h={17} w="60%" />
        <Skeleton h={12} w="45%" />
      </div>
      <Skeleton h={12} w={64} />
    </div>
    <div className="mt-4 space-y-2">
      <Skeleton h={12} />
      <Skeleton h={12} w="80%" />
    </div>
    <div className="grid grid-cols-4 gap-3 mt-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton h={10} w="70%" />
          <Skeleton h={17} />
        </div>
      ))}
    </div>
  </div>
);
