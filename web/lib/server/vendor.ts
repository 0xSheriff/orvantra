// Data for the vendor sign-up page: token choices from 1Click (cached 10 min) and the treasury's hold window.
// Read-only.
import 'server-only';
import * as nearViews from 'orvantra-agent/near';
import type { VendorView } from 'orvantra-agent/near';
import { tokenOptions, type Chain, type OneClickToken, type TokenOption } from '../registry';
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
    tokensError = e instanceof Error ? e.message : String(e);
  }
  return {
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
