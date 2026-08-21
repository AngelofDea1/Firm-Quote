/**
 * ============================================================================
 *  WALLET LAYER, ZERO DEPENDENCIES
 * ============================================================================
 *
 * Talks to EVM wallets directly. No ethers, no viem, no wagmi, no WalletConnect.
 *
 * Two things this does that a naive `window.ethereum` integration does not:
 *
 *   1. EIP-6963 multi wallet discovery. When several wallets are installed they
 *      fight over `window.ethereum` and whoever loaded last wins, so a user with
 *      Rabby and MetaMask cannot choose. EIP-6963 has each wallet announce itself
 *      with a name, icon and its own provider object. We listen for those and let
 *      the user pick. Falls back to `window.ethereum` for older wallets.
 *
 *   2. Network enforcement. On connect we check the chain and immediately ask the
 *      wallet to switch, adding the network first if it has never seen it. A user
 *      on Ethereum mainnet clicking Connect should not have to work out why nothing
 *      happens afterwards.
 *
 * Function selectors are hardcoded rather than derived, because deriving them needs
 * keccak256 and that is the only reason we would need a crypto library. Each is the
 * first four bytes of keccak256 of the signature written beside it.
 */

const SELECTORS = {
  approve: '0x095ea7b3', // approve(address,uint256)
  allowance: '0xdd62ed3e', // allowance(address,address)
  balanceOf: '0x70a08231', // balanceOf(address)
  requestExit: '0x4feef6da', // requestExit(address,uint256)
  deposit: '0x6e553f65', // deposit(uint256,address), the ERC-4626 standard one
  mint: '0x40c10f19', // mint(address,uint256), the demo token faucet
  redeem: '0xba087652', // redeem(uint256,address,address), ERC-4626
};

export const CHAINS = {
  196: {
    chainId: '0xc4',
    chainName: 'X Layer',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: ['https://rpc.xlayer.tech'],
    blockExplorerUrls: ['https://www.oklink.com/xlayer'],
  },
  1952: {
    chainId: '0x7a0',
    chainName: 'X Layer Testnet',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: ['https://testrpc.xlayer.tech/terigon'],
    blockExplorerUrls: ['https://www.oklink.com/xlayer-test'],
  },
  31337: {
    chainId: '0x7a69',
    chainName: 'Hardhat local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['http://127.0.0.1:8545'],
    blockExplorerUrls: [],
  },
};

export const chainName = (id) => CHAINS[id]?.chainName || (id ? `Chain ${id}` : 'unknown');
export const explorerTx = (chainId, hash) => {
  const base = CHAINS[chainId]?.blockExplorerUrls?.[0];
  return base ? `${base}/tx/${hash}` : null;
};
export const explorerAddress = (chainId, addr) => {
  const base = CHAINS[chainId]?.blockExplorerUrls?.[0];
  return base ? `${base}/address/${addr}` : null;
};

/* --------------------------------------------------------------------------
   EIP-6963 wallet discovery
   -------------------------------------------------------------------------- */

const discovered = new Map(); // uuid -> { info, provider }
let selected = null; // the provider the user chose

function announce(event) {
  const { info, provider } = event.detail || {};
  if (!info?.uuid || !provider) return;
  discovered.set(info.uuid, { info, provider });
  listeners.forEach((fn) => fn(listWallets()));
}

const listeners = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', announce);
  // Ask any wallet that loaded before us to announce itself.
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Every wallet we can see, newest standard first, with a legacy fallback. */
export function listWallets() {
  const out = [...discovered.values()].map(({ info, provider }) => ({
    uuid: info.uuid,
    name: info.name,
    icon: info.icon,
    rdns: info.rdns,
    provider,
  }));

  // Older wallets do not announce. If nothing was discovered but an injected
  // provider exists, offer it so those users are not locked out.
  if (out.length === 0 && typeof window !== 'undefined' && window.ethereum) {
    const eth = window.ethereum;
    const guessed = eth.isMetaMask
      ? 'MetaMask'
      : eth.isCoinbaseWallet
        ? 'Coinbase Wallet'
        : eth.isRabby
          ? 'Rabby'
          : eth.isBraveWallet
            ? 'Brave Wallet'
            : eth.isTrust
              ? 'Trust Wallet'
              : eth.isOkxWallet || eth.isOKExWallet
                ? 'OKX Wallet'
                : 'Browser wallet';
    out.push({ uuid: 'injected', name: guessed, icon: null, rdns: 'injected', provider: eth });
  }

  return out;
}

export function onWalletsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const hasWallet = () => listWallets().length > 0;

/** Remember which wallet the user picked, so a refresh reconnects to the same one. */
export function selectWallet(uuid) {
  const found = listWallets().find((w) => w.uuid === uuid);
  if (!found) throw new Error('That wallet is no longer available. Try refreshing the page.');
  selected = found;
  try {
    localStorage.setItem('fq.wallet', uuid);
  } catch {
    /* private mode, not important */
  }
  return found;
}

function activeProvider() {
  if (selected?.provider) return selected.provider;

  // Restore the previous choice on reload.
  let remembered = null;
  try {
    remembered = localStorage.getItem('fq.wallet');
  } catch {
    /* ignore */
  }
  const wallets = listWallets();
  const match = wallets.find((w) => w.uuid === remembered) || wallets[0];
  if (match) {
    selected = match;
    return match.provider;
  }
  throw new Error('No EVM wallet found. Install MetaMask, Rabby, OKX Wallet or Coinbase Wallet.');
}

export const selectedWallet = () => selected;

/* --------------------------------------------------------------------------
   abi encoding, the small amount of it we need
   -------------------------------------------------------------------------- */

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const encAddress = (a) => pad(a);
const encUint = (v) => pad(BigInt(v).toString(16));

export function toBaseUnits(amount, decimals = 6) {
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}
export const fromBaseUnits = (v, decimals = 6) => Number(BigInt(v)) / 10 ** decimals;

/* --------------------------------------------------------------------------
   provider calls
   -------------------------------------------------------------------------- */

async function request(method, params = []) {
  try {
    return await activeProvider().request({ method, params });
  } catch (err) {
    if (err && err.code === 4001) throw new Error('You rejected the request in your wallet.');
    throw new Error(err && err.message ? err.message : String(err));
  }
}

export async function currentAccount() {
  if (!hasWallet()) return null;
  try {
    const accounts = await activeProvider().request({ method: 'eth_accounts' });
    if (!accounts?.length) return null;
    const chainIdHex = await activeProvider().request({ method: 'eth_chainId' });
    return { address: accounts[0], chainId: parseInt(chainIdHex, 16) };
  } catch {
    return null;
  }
}

/** Ask the wallet to move to a chain, adding it first if it has never seen it. */
export async function switchChain(chainId) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain ${chainId}.`);
  try {
    await request('wallet_switchEthereumChain', [{ chainId: chain.chainId }]);
  } catch (err) {
    const notAdded = /4902|Unrecognized chain|not been added|does not match/i.test(err.message);
    if (!notAdded) throw err;
    await request('wallet_addEthereumChain', [chain]);
    // Some wallets add without switching, so ask again and ignore a second failure.
    try {
      await request('wallet_switchEthereumChain', [{ chainId: chain.chainId }]);
    } catch {
      /* the add usually leaves us on the right chain anyway */
    }
  }
}

/**
 * Connect, then put the wallet on the right network before returning.
 *
 * `requireChainId` is the chain the deployment lives on. Passing it means the
 * user is prompted to switch immediately rather than discovering later that the
 * buttons do nothing.
 */
export async function connect({ uuid, requireChainId } = {}) {
  if (uuid) selectWallet(uuid);
  const accounts = await request('eth_requestAccounts');
  let chainId = parseInt(await request('eth_chainId'), 16);

  if (requireChainId && chainId !== requireChainId) {
    await switchChain(requireChainId);
    chainId = parseInt(await request('eth_chainId'), 16);
  }

  return { address: accounts[0], chainId };
}

export function onWalletChange(handler) {
  let provider;
  try {
    provider = activeProvider();
  } catch {
    return () => {};
  }
  const onAccounts = () => handler();
  const onChain = () => handler();
  provider.on?.('accountsChanged', onAccounts);
  provider.on?.('chainChanged', onChain);
  return () => {
    provider.removeListener?.('accountsChanged', onAccounts);
    provider.removeListener?.('chainChanged', onChain);
  };
}

/* ---- reads ---- */

export async function readAllowance(token, owner, spender) {
  const data = SELECTORS.allowance + encAddress(owner) + encAddress(spender);
  return BigInt((await request('eth_call', [{ to: token, data }, 'latest'])) || '0x0');
}

export async function readBalance(token, owner) {
  const data = SELECTORS.balanceOf + encAddress(owner);
  return BigInt((await request('eth_call', [{ to: token, data }, 'latest'])) || '0x0');
}

/* ---- writes ---- */

const send = (from, to, data) => request('eth_sendTransaction', [{ from, to, data }]);

export const approve = (token, from, spender, amount) =>
  send(from, token, SELECTORS.approve + encAddress(spender) + encUint(amount));

export const requestExit = (pool, from, trancheToken, amount) =>
  send(from, pool, SELECTORS.requestExit + encAddress(trancheToken) + encUint(amount));

export const depositTo = (trancheToken, from, amount, receiver) =>
  send(from, trancheToken, SELECTORS.deposit + encUint(amount) + encAddress(receiver));

/**
 * Take a deposit back out of a deal that has not started, or a settled one.
 *
 * The contract refused this until an audit found that depositing into an Open deal
 * was a one way door: nothing had been drawn, the money was sitting in the vault,
 * and you still could not leave until maturity. Funded deals stay locked, which is
 * the entire premise, and the exit pool is the answer there.
 *
 * No approve step. Redeeming burns your own shares, so there is nobody to approve.
 */
export async function withdrawWithWallet({ address, trancheToken, amount, decimals = 6, onStep = () => {} }) {
  const units = toBaseUnits(amount, decimals);

  onStep('checking');
  const held = await readBalance(trancheToken, address);
  if (held < units) {
    throw new Error(
      `This wallet holds ${fromBaseUnits(held, decimals).toLocaleString()} of that tranche, ` +
        `which is less than the ${Number(amount).toLocaleString()} you are trying to withdraw.`,
    );
  }

  onStep('withdrawing');
  const hash = await send(
    address,
    trancheToken,
    SELECTORS.redeem + encUint(units) + encAddress(address) + encAddress(address),
  );
  const receipt = await waitForReceipt(hash);
  onStep('done');
  return { hash, receipt };
}

/**
 * Faucet for the demo settlement token.
 *
 * MockERC20.mint is declared `external` with no access control at all, which is
 * deliberate: this stands in for USDC on a testnet where the whole point is that
 * strangers can try the product without asking anyone for tokens. It also means
 * this needed no contract change, only a button.
 *
 * Obviously this is not what ships against real USDC. On mainnet SETTLEMENT_TOKEN
 * points at the real contract and there is no mint to call.
 */
export async function claimTestTokens({ token, address, amount = 250000, decimals = 6, onStep = () => {} }) {
  onStep('claiming');
  const hash = await send(
    address,
    token,
    SELECTORS.mint + encAddress(address) + encUint(toBaseUnits(amount, decimals)),
  );
  await waitForReceipt(hash);
  onStep('done');
  return { hash };
}

/**
 * Put money into a tranche, as one call.
 *
 * Mirrors exitWithWallet: check the balance first so a shortfall is a sentence
 * rather than a reverted transaction, approve only when the existing allowance is
 * short, then deposit. Two wallet popups when one would do is how you lose someone.
 */
export async function depositWithWallet({
  address,
  settlementToken,
  trancheToken,
  amount,
  decimals = 6,
  onStep = () => {},
}) {
  const units = toBaseUnits(amount, decimals);

  onStep('checking');
  const balance = await readBalance(settlementToken, address);
  if (balance < units) {
    throw new Error(
      `This wallet holds ${fromBaseUnits(balance, decimals).toLocaleString()} in settlement tokens, ` +
        `which is less than the ${Number(amount).toLocaleString()} you are trying to deposit.`,
    );
  }

  const allowance = await readAllowance(settlementToken, address, trancheToken);
  let approveHash = null;
  if (allowance < units) {
    onStep('approving');
    approveHash = await approve(settlementToken, address, trancheToken, units);
    await waitForReceipt(approveHash);
  }

  onStep('depositing');
  const depositHash = await depositTo(trancheToken, address, units, address);
  const receipt = await waitForReceipt(depositHash);

  onStep('done');
  return { approveHash, depositHash, receipt };
}

export async function waitForReceipt(hash, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  for (;;) {
    const receipt = await activeProvider().request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    });
    if (receipt) {
      if (receipt.status === '0x0') throw new Error('The transaction reverted on chain.');
      return receipt;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for confirmation. The transaction may still land.');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The whole holder side exit, as one call. Approves only when the existing
 * allowance is short, because asking for two signatures when one will do is a
 * good way to lose someone mid demo.
 */
export async function exitWithWallet({
  address,
  pool,
  trancheToken,
  amount,
  decimals = 6,
  onStep = () => {},
}) {
  const units = toBaseUnits(amount, decimals);

  onStep('checking');
  const balance = await readBalance(trancheToken, address);
  if (balance < units) {
    throw new Error(
      `This wallet holds ${fromBaseUnits(balance, decimals).toLocaleString()} tranche tokens, ` +
        `which is less than the ${Number(amount).toLocaleString()} you are trying to sell.`,
    );
  }

  const allowance = await readAllowance(trancheToken, address, pool);
  let approveHash = null;
  if (allowance < units) {
    onStep('approving');
    approveHash = await approve(trancheToken, address, pool, units);
    await waitForReceipt(approveHash);
  }

  onStep('exiting');
  const exitHash = await requestExit(pool, address, trancheToken, units);
  const receipt = await waitForReceipt(exitHash);

  onStep('done');
  return { approveHash, exitHash, receipt };
}
