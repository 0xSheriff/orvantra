// Pure display helpers (amounts, routes, addresses, dates). No I/O. Re-exported by web/lib/format.ts.

export const DECIMALS = 6;

/**
 * Base units (6 decimals) -> "1,200.00". Keeps up to 6 decimals when they are not zero.
 * `whole: true` drops ".00" on whole numbers ("1,000"), as used in running text.
 */
export function fmtAmount(units: string | bigint | null | undefined, opts: { whole?: boolean } = {}): string {
  if (units == null || units === '') return '—';
  let v: bigint;
  try {
    v = typeof units === 'bigint' ? units : BigInt(units);
  } catch {
    return '—';
  }
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(DECIMALS);
  const int = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (abs % base).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  if (opts.whole && frac === '') return `${neg ? '-' : ''}${int}`;
  frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
}

const CHAINS: Record<string, string> = {
  near: 'NEAR', base: 'Base', eth: 'Ethereum', arb: 'Arbitrum', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain',
  avax: 'Avalanche', gnosis: 'Gnosis', sol: 'Solana', tron: 'Tron', btc: 'Bitcoin', ton: 'TON', sui: 'Sui',
  aptos: 'Aptos', xrp: 'XRP', stellar: 'Stellar', zec: 'Zcash', doge: 'Dogecoin', bera: 'Berachain',
};

export function chainLabel(chain: string): string {
  return CHAINS[chain.toLowerCase()] ?? chain.charAt(0).toUpperCase() + chain.slice(1);
}

/** Symbol of a payout asset. The treasury's own token is shown with the treasury unit (tUSDC on testnet). */
export function assetSymbol(assetId: string, treasuryToken: string | null, unit: string): string {
  if (treasuryToken && assetId === `nep141:${treasuryToken}`) return unit;
  if (/usdt|dac17f958d2ee523a2206206994597c13d831ec7/i.test(assetId)) return 'USDT';
  if (/usdc|833589fcd6edb6e08f4c7c32d4f71b54bda02913|17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/i.test(assetId)) return 'USDC';
  return 'tokens';
}

/** "USDC on Base" */
export function routeLabel(payout: { chain: string; asset_id: string } | null | undefined, treasuryToken: string | null, unit: string): string | null {
  if (!payout) return null;
  return `${assetSymbol(payout.asset_id, treasuryToken, unit)} on ${chainLabel(payout.chain)}`;
}

/** The settlement unit shown next to amounts: tUSDC for the testnet demo token, USDC otherwise. */
export function unitFor(network: string, tokenId: string | null): string {
  return network === 'testnet' || (tokenId ?? '').endsWith('.testnet') ? 'tUSDC' : 'USDC';
}

/** "0x3333…3333" for long addresses; short NEAR names stay as they are. */
export function shortAddr(a: string | null | undefined): string {
  if (!a) return '—';
  if (a.length <= 24) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Nanosecond timestamp (string) -> ISO. */
export function nsToIso(ns: string | number | null | undefined): string | null {
  if (ns == null || ns === '') return null;
  try {
    return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
}

const TZ = typeof process !== 'undefined' ? process.env.ORVANTRA_TZ || undefined : undefined;

/** "6 Nov, 16:42" */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: TZ }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(d);
  return `${date}, ${time}`;
}

/** "6 November 2026" */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
}

/** 120 -> "2 minutes", 90000 -> "1 day". Rounds down to the largest whole unit. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return '0 seconds';
}

/** Capitalize the first letter. */
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
