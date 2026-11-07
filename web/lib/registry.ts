// Vendor-registry rules mirrored for the browser. Pure; safe in client components.
// Source of truth: contracts/vendor-registry/src/lib.rs (`validate`, EVM_CHAINS, OTHER_CHAINS, MAX_*).
// lib/registry.test.ts parses that Rust file and fails if this module drifts from it.

export const MAX_DISPLAY_NAME_CHARS = 64;
export const MAX_ASSET_ID_LEN = 128;
export const MAX_ADDRESS_LEN = 128;
export const MIN_OTHER_ADDRESS_LEN = 20;

export const EVM_CHAINS = ['eth', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'gnosis'] as const;
export const OTHER_CHAINS = ['solana', 'tron', 'btc', 'ton', 'sui', 'stellar'] as const;
/** Every chain the contract accepts, in the order the form offers them. */
export const CHAINS = ['near', ...EVM_CHAINS, ...OTHER_CHAINS] as const;
export type Chain = (typeof CHAINS)[number];

/** Human name per registry chain. */
export const CHAIN_LABEL: Record<Chain, string> = {
  near: 'NEAR', eth: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon',
  bsc: 'BNB Chain', avalanche: 'Avalanche', gnosis: 'Gnosis', solana: 'Solana', tron: 'Tron', btc: 'Bitcoin',
  ton: 'TON', sui: 'Sui', stellar: 'Stellar',
};

/** The registry's chain name -> 1Click's `blockchain` field in /v0/tokens. */
export const ONECLICK_BLOCKCHAIN: Record<Chain, string> = {
  near: 'near', eth: 'eth', base: 'base', arbitrum: 'arb', optimism: 'op', polygon: 'pol', bsc: 'bsc',
  avalanche: 'avax', gnosis: 'gnosis', solana: 'sol', tron: 'tron', btc: 'btc', ton: 'ton', sui: 'sui', stellar: 'stellar',
};

export const isChain = (c: string): c is Chain => (CHAINS as readonly string[]).includes(c);
const isEvm = (c: string) => (EVM_CHAINS as readonly string[]).includes(c);
const isOther = (c: string) => (OTHER_CHAINS as readonly string[]).includes(c);

/** near-sdk `AccountId` rules: 2..64 chars, lowercase parts separated by `.`, `-`/`_` only between alphanumerics. */
export function isValidNearAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

const printable = (s: string) => /^[\x21-\x7e]*$/.test(s);
const hasControl = (s: string) => /[\u0000-\u001f\u007f-\u009f]/.test(s);

/** null when valid, else a plain sentence (the contract's rule, in words). */
export function displayNameError(name: string): string | null {
  if (!name.trim()) return 'Enter your business name.';
  if ([...name].length > MAX_DISPLAY_NAME_CHARS) return `Keep the name to ${MAX_DISPLAY_NAME_CHARS} characters or fewer.`;
  if (hasControl(name)) return 'The name contains characters that cannot be saved.';
  return null;
}

export function assetIdError(assetId: string): string | null {
  if (!assetId) return 'Choose a token.';
  if (assetId.length > MAX_ASSET_ID_LEN || !printable(assetId)) return 'This token id cannot be saved.';
  return null;
}

export function addressError(chain: string, address: string): string | null {
  const label = isChain(chain) ? CHAIN_LABEL[chain] : chain;
  if (!address) return `Enter your address on ${label}.`;
  if (address.length > MAX_ADDRESS_LEN) return `That is longer than any ${label} address (${MAX_ADDRESS_LEN} characters at most).`;
  if (chain === 'near') return isValidNearAccountId(address) ? null : 'That is not a valid NEAR account, like acme.near.';
  if (isEvm(chain)) return /^0x[0-9a-fA-F]{40}$/.test(address) ? null : `A ${label} address is 0x followed by 40 hex characters.`;
  if (isOther(chain)) {
    return address.length >= MIN_OTHER_ADDRESS_LEN && printable(address)
      ? null
      : `A ${label} address is ${MIN_OTHER_ADDRESS_LEN} to ${MAX_ADDRESS_LEN} characters with no spaces.`;
  }
  return 'Choose a network.';
}

/** `0x3333…3333`; values up to 24 characters (most NEAR accounts) stay whole. */
export function shortAddress(a: string): string {
  return a.length > 24 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// ------------------------------------------------------------------ token options (from 1Click /v0/tokens)

export interface OneClickToken {
  assetId: string;
  blockchain: string;
  symbol: string;
}

export interface TokenOption {
  symbol: string;
  /** Exact 1Click assetId (or nep141:<TOKEN_ID> for the testnet token). */
  assetId: string;
}

/** Stablecoins offered, in order. USDT only where 1Click lists exactly "USDT" on that chain (not USDT0). */
const SYMBOLS = ['USDC', 'USDT'] as const;

/**
 * Token choices per registry chain. On testnet, chain "near" also offers the demo token (tUSDC, `nep141:<tokenId>`)
 * first, because that is what the testnet treasury pays out.
 */
export function tokenOptions(tokens: OneClickToken[], o: { network: string; testToken: string | null }): Record<Chain, TokenOption[]> {
  const out = {} as Record<Chain, TokenOption[]>;
  for (const chain of CHAINS) {
    const bc = ONECLICK_BLOCKCHAIN[chain];
    const list: TokenOption[] = [];
    if (chain === 'near' && o.network !== 'mainnet' && o.testToken) list.push({ symbol: 'tUSDC', assetId: `nep141:${o.testToken}` });
    for (const sym of SYMBOLS) {
      const t = tokens.find((x) => x.blockchain === bc && x.symbol === sym && typeof x.assetId === 'string' && !assetIdError(x.assetId));
      if (t) list.push({ symbol: sym, assetId: t.assetId });
    }
    out[chain] = list;
  }
  return out;
}

/** Symbol for an asset id we may not have in the options (e.g. an older registry entry). */
export function symbolFor(options: Record<string, TokenOption[]>, chain: string, assetId: string): string {
  const hit = (options[chain] ?? []).find((t) => t.assetId === assetId);
  if (hit) return hit.symbol;
  if (/usdt|dac17f958d2ee523a2206206994597c13d831ec7/i.test(assetId)) return 'USDT';
  if (/tusdc/i.test(assetId)) return 'tUSDC';
  if (/usdc/i.test(assetId)) return 'USDC';
  return assetId.length > 24 ? `${assetId.slice(0, 20)}…` : assetId;
}

// ------------------------------------------------------------------ time

/** "3 minutes ago", "2 days ago". `ns` is a registry timestamp string (nanoseconds). */
export function relativeTime(ns: string, nowMs: number): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86_400) return unit(Math.floor(s / 3600), 'hour');
  if (s < 86_400 * 60) return unit(Math.floor(s / 86_400), 'day');
  return unit(Math.floor(s / (86_400 * 30)), 'month');
}

/** Gas and method limits shared by the page and the relay. */
export const SET_VENDOR_GAS = 30_000_000_000_000n;
export const RELAY_METHODS = ['set_vendor', 'remove_vendor'] as const;
/**
 * set_vendor / remove_vendor require EXACTLY 1 yoctoNEAR. Function-call access keys cannot attach deposits, so a
 * payout change always needs the vendor's full-access key (an explicit wallet confirmation).
 */
export const REGISTRY_DEPOSIT = 1n;
