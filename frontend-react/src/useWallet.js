import { useCallback, useEffect, useState } from 'react';
import {
  chainName,
  connect as walletConnect,
  currentAccount,
  listWallets,
  onWalletChange,
  onWalletsChanged,
  switchChain,
} from './wallet';

/**
 * One wallet hook for the whole app.
 *
 * Holds the list of installed wallets, the connection, and the chain. Reconnects
 * silently on load if access was already granted, so a refresh mid demo does not
 * send you back through the wallet popup in front of an audience.
 *
 * `requiredChainId` is the chain the deployment lives on. When it is known, connect
 * will move the wallet onto it automatically rather than leaving the user stranded
 * on whatever network they happened to be on.
 */
export function useWallet(requiredChainId) {
  const [wallets, setWallets] = useState(() => listWallets());
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const account = await currentAccount();
    setAddress(account?.address ?? null);
    setChainId(account?.chainId ?? null);
  }, []);

  // Wallets announce themselves asynchronously, so the list can grow after mount.
  useEffect(() => onWalletsChanged(setWallets), []);

  useEffect(() => {
    refresh();
    return onWalletChange(() => refresh());
  }, [refresh]);

  const connect = useCallback(
    async (uuid) => {
      setError(null);
      setConnecting(true);
      try {
        const account = await walletConnect({ uuid, requireChainId: requiredChainId });
        setAddress(account.address);
        setChainId(account.chainId);
        return account;
      } catch (err) {
        setError(err.message);
        throw err;
      } finally {
        setConnecting(false);
      }
    },
    [requiredChainId],
  );

  const switchTo = useCallback(
    async (target) => {
      setError(null);
      setSwitching(true);
      try {
        await switchChain(target ?? requiredChainId);
        await refresh();
      } catch (err) {
        setError(err.message);
        throw err;
      } finally {
        setSwitching(false);
      }
    },
    [refresh, requiredChainId],
  );

  const disconnect = useCallback(() => {
    // EIP-1193 has no disconnect. Clearing local state and forgetting the choice is
    // the honest version, and we say so in the interface rather than pretending.
    try {
      localStorage.removeItem('fq.wallet');
    } catch {
      /* ignore */
    }
    setAddress(null);
    setChainId(null);
  }, []);

  const wrongChain = Boolean(address && requiredChainId && chainId !== requiredChainId);

  return {
    wallets,
    available: wallets.length > 0,
    address,
    chainId,
    chainName: chainId ? chainName(chainId) : null,
    requiredChainId,
    requiredChainName: requiredChainId ? chainName(requiredChainId) : null,
    connecting,
    switching,
    error,
    clearError: () => setError(null),
    wrongChain,
    connect,
    switchTo,
    disconnect,
    refresh,
  };
}
