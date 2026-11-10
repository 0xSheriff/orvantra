// Data for the vendor sign-up page: token choices from 1Click (cached 10 min) and the treasury's hold window.
// Read-only.
import 'server-only';
import * as nearViews from 'orvantra-agent/near';
import type { VendorView } from 'orvantra-agent/near';
import {
  FALLBACK_STORAGE_DEPOSIT, MAX_ENTRY_BYTES, TYPICAL_ENTRY_BYTES, tokenOptions, type Chain, type OneClickToken, type TokenOption,
} from '../registry';
import { near, serverConfig } from './config';

const ONECLICK_TOKENS = `${process.env.ONECLICK_BASE ?? 'https://1click.chaindefuser.com/v0'}/tokens`;
const TTL_MS = 10 * 60_000;
let cache: { at: number; tokens: OneClickToken[] } | null = null;

/** 1Click /v0/tokens, cached for 10 minutes per server process. A failed refresh keeps the previous list. */
export async function oneClickTokens(now = Date.now()): Promise<OneClickToken[]> {
  if (cache && now - cache.at < TTL_MS) return cache.tokens;
  try {
    const res = await fetch(ONECLICK_TOKENS, { headers: { 'user-agent': 'orvantra-web/0.1', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as OneClickToken[];
    if (!Array.isArray(list)) throw new Error('not a list');
    cache = { at: now, tokens: list };
    return list;
  } catch (e) {
    if (cache) return cache.tokens;
    throw e;
  }
}

export interface VendorPageData {
  network: string;
  registryId: string;
  options: Record<Chain, TokenOption[]>;
  /** Treasury's min payout age in seconds; null if unreadable. */
  minPayoutAgeSec: number | null;
  /** Set when the token list could not be loaded. */
  tokensError: string | null;
  /** Registry `storage_cost_estimate` (yoctoNEAR) for a typical entry; null if unreadable. Shown in the copy. */
  typicalDeposit: string | null;
  /** Estimate for the largest entry: attached to set_vendor (the registry refunds the excess). */
  attachDeposit: string;
}

/** The registry's own estimate of what a new entry costs to store (view `storage_cost_estimate`), cached 10 min. */
let estimates: { at: number; typical: bigint | null; max: bigint } | null = null;
export async function storageEstimates(now = Date.now()): Promise<{ typical: bigint | null; max: bigint }> {
  if (estimates && now - estimates.at < TTL_MS) return estimates;
  const nc = near();
  try {
    const [t, m] = await Promise.all([
      nearViews.view<string>(nc, nc.registryId, 'storage_cost_estimate', TYPICAL_ENTRY_BYTES),
      nearViews.view<string>(nc, nc.registryId, 'storage_cost_estimate', MAX_ENTRY_BYTES),
    ]);
    estimates = { at: now, typical: BigInt(t), max: BigInt(m) };
  } catch (e) {
    console.error(`[vendor] storage_cost_estimate failed: ${e instanceof Error ? e.message : String(e)}`);
    // Keep an older answer, else the fixed 0.01 NEAR that always suffices.
    estimates = { at: now - TTL_MS + 30_000, typical: estimates?.typical ?? null, max: estimates?.max ?? FALLBACK_STORAGE_DEPOSIT };
  }
  return estimates;
}

export async function vendorPageData(): Promise<VendorPageData> {
  const cfg = serverConfig();
  const nc = near();
  const config = await nearViews.getConfig(nc).catch(() => null);
  const testToken = cfg.tokenId ?? config?.token ?? null;
  let tokens: OneClickToken[] = [];
  let tokensError: string | null = null;
  try {
    tokens = await oneClickTokens();
  } catch (e) {
    console.error(`[vendor] 1Click tokens failed: ${e instanceof Error ? e.message : String(e)}`);
    tokensError = 'the token service did not answer';
  }
  const est = await storageEstimates();
  return {
    typicalDeposit: est.typical == null ? null : est.typical.toString(),
    attachDeposit: est.max.toString(),
    network: cfg.network,
    registryId: cfg.registryId,
    options: tokenOptions(tokens, { network: cfg.network, testToken }),
    minPayoutAgeSec: config ? config.min_payout_age_sec : null,
    tokensError,
  };
}

/** Fresh registry entry for one account (no view cache). */
export async function readVendor(accountId: string): Promise<VendorView | null> {
  return nearViews.getVendor(near(true), accountId);
}
