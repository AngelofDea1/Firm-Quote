import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Copy, LogOut, Wallet } from 'lucide-react';

/**
 * Connect button, wallet picker and network guard.
 *
 * Three behaviours worth calling out:
 *
 *   1. Every installed EVM wallet is listed, discovered through EIP-6963, so a user
 *      with more than one is not silently forced onto whichever hijacked
 *      window.ethereum last.
 *   2. Connecting puts the wallet on the right network as part of the same flow,
 *      rather than connecting and then failing quietly on the first transaction.
 *   3. If the wallet drifts to another network afterwards, a banner appears and
 *      blocks nothing except the transaction itself, with one button to fix it.
 */

const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');

/**
 * `size` exists because this sits in a 64px navbar next to a btn-sm.
 *
 * It rendered at the default 44px while everything beside it was 36px, so the bar
 * looked like it had one control that had been zoomed. It is also no longer
 * btn-primary: Invest is the primary action now, and two primaries in one corner
 * is no hierarchy at all.
 */
export function WalletButton({ wallet, size = 'btn-sm' }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open && !menu) return;
    const close = (e) => {
      if (!e.target.closest?.('[data-wallet-ui]')) {
        setOpen(false);
        setMenu(false);
      }
    };
    const esc = (e) => e.key === 'Escape' && (setOpen(false), setMenu(false));
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open, menu]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked, not worth an error */
    }
  };

  /* ---------- not connected ---------- */
  if (!wallet.address) {
    return (
      <div className="relative" data-wallet-ui>
        <button
          className={`btn ${size}`}
          onClick={() => setOpen((v) => !v)}
          disabled={wallet.connecting}
        >
          <Wallet className="h-4 w-4" />
          {wallet.connecting ? 'Connecting' : 'Connect wallet'}
        </button>

        {open && (
          <div
            className="absolute right-0 mt-2 w-72 card p-2 shadow-lg z-50"
            role="dialog"
            aria-label="Choose a wallet"
          >
            {wallet.available ? (
              <>
                <p className="t-label px-3 py-2">Choose a wallet</p>
                {wallet.wallets.map((w) => (
                  <button
                    key={w.uuid}
                    onClick={async () => {
                      setOpen(false);
                      try {
                        await wallet.connect(w.uuid);
                      } catch {
                        /* surfaced through wallet.error */
                      }
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[10px] hover:bg-[#f7f8f9] text-left"
                  >
                    {w.icon ? (
                      <img src={w.icon} alt="" className="h-6 w-6 rounded-md" />
                    ) : (
                      <span className="h-6 w-6 rounded-md bg-[#f0f1f3] grid place-items-center">
                        <Wallet className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <span className="text-[15px] font-semibold">{w.name}</span>
                  </button>
                ))}
                <p className="t-small px-3 pt-2 pb-1">
                  You will be asked to switch to {wallet.requiredChainName || 'the right network'}.
                </p>
              </>
            ) : (
              <div className="p-3 space-y-2">
                <p className="text-[15px] font-semibold">No EVM wallet found</p>
                <p className="t-small">
                  Install MetaMask, Rabby, OKX Wallet or Coinbase Wallet, then reload this page.
                </p>
                <a
                  className="btn btn-sm btn-block"
                  href="https://metamask.io/download/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get MetaMask
                </a>
              </div>
            )}
          </div>
        )}

        {wallet.error && (
          <div className="absolute right-0 mt-2 w-72 card p-3 z-50">
            <p className="t-small" style={{ color: 'var(--negative)' }}>
              {wallet.error}
            </p>
            <button className="btn btn-sm mt-2" onClick={wallet.clearError}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ---------- connected but on the wrong network ---------- */
  if (wallet.wrongChain) {
    return (
      <button
        className={`btn ${size}`}
        style={{ borderColor: '#ecd9ab', background: '#fdf9f0', color: 'var(--warning)' }}
        onClick={() => wallet.switchTo().catch(() => {})}
        disabled={wallet.switching}
        data-wallet-ui
      >
        <AlertTriangle className="h-4 w-4" />
        {wallet.switching ? 'Check your wallet' : `Switch to ${wallet.requiredChainName}`}
      </button>
    );
  }

  /* ---------- connected and correct ---------- */
  return (
    <div className="relative" data-wallet-ui>
      <button className={`btn ${size}`} onClick={() => setMenu((v) => !v)}>
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--positive)' }} />
        <span className="num">{short(wallet.address)}</span>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>

      {menu && (
        <div className="absolute right-0 mt-2 w-64 card p-2 shadow-lg z-50">
          <div className="px-3 py-2">
            <p className="t-label">Connected</p>
            <p className="hash mt-1">{wallet.address}</p>
            <p className="t-small mt-2">{wallet.chainName}</p>
          </div>
          <button
            onClick={copy}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] hover:bg-[#f7f8f9] text-left text-[14px]"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <button
            onClick={() => {
              wallet.disconnect();
              setMenu(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] hover:bg-[#f7f8f9] text-left text-[14px]"
          >
            <LogOut className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
