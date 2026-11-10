// Read-only NEAR RPC views. No keys, no signing, no writes.

export interface Payout {
  chain: string;
  asset_id: string;
  address: string;
}

export interface VendorView {
  account_id: string;
  display_name: string;
  payout: Payout;
  created_at_ns: string;
  updated_at_ns: string;
  version: number;
}

export interface VendorPolicy {
  max_per_invoice: string; // U128 base units
  monthly_cap: string;
}

export interface TreasuryConfig {
  owner: string;
  agent: string;
  registry: string;
  token: string;
  auto_pay_threshold: string;
  monthly_cap: string;
  min_payout_age_sec: number;
  /** yoctoNEAR the treasury attaches to token.storage_deposit before each payout (Day 5 treasury; absent on v1). */
  storage_deposit?: string;
  paused: boolean;
  payment_count: number;
  /** Cross-chain payouts above this always wait for the owner (treasury v4; "0" = every cross-chain payout). */
  cross_chain_auto_pay_threshold?: string;
  open_payments?: number;
  max_open_payments?: number;
  near_reserve?: string;
  available_near?: string;
}

export type PaymentStatus = 'Verifying' | 'Pending' | 'Executing' | 'Paid' | 'Rejected' | 'Failed';

export interface Payment {
  id: number;
  invoice_hash: string;
  vendor: string;
  amount: string;
  payout_version: number;
  status: PaymentStatus;
  reasons: string[];
  direct: boolean;
  destination: string | null;
  created_at: string;
  payout?: Payout | null;
  deposit_address?: string | null;
  quote_hash?: string | null;
  memo?: string | null;
  approved_by_owner?: boolean;
  updated_at?: string;
}

/** Retry/backoff knobs. Defaults: 5 attempts total, 250ms * 2^n + jitter (max 2s each), whole call bounded by 10s. */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for one view() call including all attempts and sleeps. */
  deadlineMs: number;
  /** Timeout of a single HTTP attempt (also clipped to what is left of the deadline). */
  attemptTimeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 2_000, deadlineMs: 10_000, attemptTimeoutMs: 8_000 };

/** Injectable for tests. */
export interface RpcDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

const defaultDeps: RpcDeps = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  now: () => Date.now(),
};

export interface NearConfig {
  network: string;
  /** Tried in order with failover; the last endpoint that worked is tried first next time. */
  rpcUrls: string[];
  registryId: string;
  treasuryId: string;
  /** Identical view calls within this window share one RPC request. 0 disables. */
  cacheTtlMs: number;
  retry: RetryPolicy;
  deps?: Partial<RpcDeps>;
}

export const DEFAULT_RPC_URLS: Record<string, string[]> = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
};

/** The treasury every tool points at unless TREASURY_ID says otherwise. */
export const DEFAULT_TREASURY_ID = 'orvantra-treasury-v4.testnet';

export function nearConfig(env: NodeJS.ProcessEnv = process.env): NearConfig {
  const network = env.NEAR_NETWORK ?? 'testnet';
  const list = (env.NEAR_RPC_URLS ?? env.NEAR_RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ttl = Number(env.NEAR_VIEW_CACHE_MS);
  return {
    network,
    rpcUrls: list.length ? list : DEFAULT_RPC_URLS[network] ?? [`https://rpc.${network}.near.org`],
    registryId: env.REGISTRY_ID ?? 'orvantra-registry.testnet',
    treasuryId: env.TREASURY_ID ?? DEFAULT_TREASURY_ID,
    cacheTtlMs: env.NEAR_VIEW_CACHE_MS !== undefined && Number.isFinite(ttl) && ttl >= 0 ? ttl : 30_000,
    retry: DEFAULT_RETRY,
  };
}

const USER_AGENT = 'orvantra-agent/0.1';

/** An error that is worth retrying on (another) endpoint: 429, 5xx, network/timeout, transient RPC errors. */
class TransientRpcError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

// JSON-RPC error causes that mean "this node can't answer right now", not "the answer is an error".
const TRANSIENT_RPC_CAUSES = new Set(['TIMEOUT_ERROR', 'NO_SYNCED_BLOCKS', 'UNAVAILABLE_SHARD', 'NOT_SYNCED_YET', 'INTERNAL_ERROR']);

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

/** One HTTP attempt: JSON-RPC `method(params)` against one endpoint. Returns `result`. Throws TransientRpcError for retryable failures. */
async function rpcOnce<T>(url: string, method: string, params: unknown, timeoutMs: number, f: typeof fetch): Promise<T> {
  const body = { jsonrpc: '2.0', id: 'orvantra', method, params };
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TransientRpcError(`${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new TransientRpcError(`${host}: HTTP ${res.status}`, parseRetryAfter(res.headers.get('retry-after')));
  }
  if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
  let json: { error?: { name?: string; cause?: { name?: string } }; result?: T };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    throw new TransientRpcError(`${host}: unreadable response (${err instanceof Error ? err.message : String(err)})`);
  }
  if (json.error) {
    const msg = `${host}: ${JSON.stringify(json.error)}`;
    const transient = TRANSIENT_RPC_CAUSES.has(json.error.cause?.name ?? '') || json.error.name === 'INTERNAL_ERROR';
    throw transient ? new TransientRpcError(msg) : new Error(msg);
  }
  if (json.result === undefined) throw new TransientRpcError(`${host}: empty result`);
  return json.result;
}

/** One `query call_function` attempt; JSON-decodes the view's return value. */
async function viewOnce<T>(url: string, contract: string, method: string, args: object, timeoutMs: number, f: typeof fetch): Promise<T> {
  const result = await rpcOnce<{ result?: number[]; error?: string }>(url, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  }, timeoutMs, f);
  if (result.error) throw new Error(`NEAR view ${contract}.${method}: ${result.error}`);
  if (!result.result) throw new TransientRpcError(`${new URL(url).host}: empty result`);
  return JSON.parse(Buffer.from(result.result).toString('utf8')) as T;
}

// Index (per endpoint list) of the endpoint that last answered, so a rate-limited one is not retried first every call.
const preferred = new Map<string, number>();

/** view() without the cache: failover across cfg.rpcUrls with exponential backoff + jitter. */
function viewWithRetry<T>(cfg: NearConfig, contract: string, method: string, args: object): Promise<T> {
  return withRetry(cfg, method, cfg.retry, (url, timeout, f) => viewOnce<T>(url, contract, method, args, timeout, f));
}

/**
 * Any JSON-RPC method (e.g. `block`, `send_tx`, `tx`, `query view_access_key`) with the same failover/backoff as
 * view(). Never cached. Re-sending the same signed transaction to another endpoint is safe (same hash and nonce).
 */
export function rpc<T>(cfg: NearConfig, method: string, params: unknown, retry: Partial<RetryPolicy> = {}): Promise<T> {
  return withRetry(cfg, method, { ...cfg.retry, ...retry }, (url, timeout, f) => rpcOnce<T>(url, method, params, timeout, f));
}

async function withRetry<T>(
  cfg: NearConfig,
  method: string,
  p: RetryPolicy,
  attemptFn: (url: string, timeoutMs: number, f: typeof fetch) => Promise<T>,
): Promise<T> {
  const d: RpcDeps = { ...defaultDeps, ...cfg.deps };
  const urls = cfg.rpcUrls;
  if (!urls.length) throw new Error('NEAR RPC: no endpoints configured');
  const listKey = urls.join(',');
  const start = preferred.get(listKey) ?? 0;
  const t0 = d.now();
  const errors: string[] = [];
  for (let attempt = 0; attempt < p.maxAttempts; attempt++) {
    const i = (start + attempt) % urls.length;
    const left = p.deadlineMs - (d.now() - t0);
    try {
      const out = await attemptFn(urls[i], Math.max(1, Math.floor(Math.min(p.attemptTimeoutMs, left))), d.fetch);
      preferred.set(listKey, i);
      return out;
    } catch (err) {
      if (!(err instanceof TransientRpcError)) throw new Error(`NEAR RPC ${method}: ${(err as Error).message}`);
      errors.push(err.message);
      if (attempt + 1 >= p.maxAttempts) break;
      const backoff = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** attempt);
      const delay = Math.min(p.maxDelayMs, Math.max(err.retryAfterMs ?? 0, backoff / 2 + d.random() * (backoff / 2)));
      if (d.now() - t0 + delay >= p.deadlineMs) break;
      await d.sleep(delay);
    }
  }
  throw new Error(`NEAR RPC ${method}: failed after ${errors.length} attempt(s): ${errors.join('; ')}`);
}

// Per-run cache of identical view calls (in-flight promises are shared too). Failures are never cached.
const viewCache = new Map<string, { at: number; value: Promise<unknown> }>();

export function clearViewCache(): void {
  viewCache.clear();
  preferred.clear();
}

/** Call a view method and JSON-decode its return value. Throws if state can't be read (callers must fail safe). */
export function view<T>(cfg: NearConfig, contract: string, method: string, args: object = {}): Promise<T> {
  if (cfg.cacheTtlMs <= 0) return viewWithRetry<T>(cfg, contract, method, args);
  const now = (cfg.deps?.now ?? defaultDeps.now)();
  const key = JSON.stringify([cfg.network, contract, method, args]);
  const hit = viewCache.get(key);
  if (hit && now - hit.at < cfg.cacheTtlMs) return hit.value as Promise<T>;
  const value = viewWithRetry<T>(cfg, contract, method, args);
  const entry = { at: now, value };
  viewCache.set(key, entry);
  value.catch(() => {
    if (viewCache.get(key) === entry) viewCache.delete(key);
  });
  return value;
}

export const getVendor = (cfg: NearConfig, accountId: string) =>
  view<VendorView | null>(cfg, cfg.registryId, 'get_vendor', { account_id: accountId });

/** yoctoNEAR (string) a vendor must attach to create a registry entry with these field lengths (bytes). */
export const getStorageCostEstimate = (cfg: NearConfig, displayNameLen: number, addressLen: number, assetLen: number) =>
  view<string>(cfg, cfg.registryId, 'storage_cost_estimate', { display_name_len: displayNameLen, address_len: addressLen, asset_len: assetLen });

export const getPayoutAgeNs =(cfg: NearConfig, accountId: string) =>
  view<string | null>(cfg, cfg.registryId, 'payout_age_ns', { account_id: accountId });

export const getVendorPolicy = (cfg: NearConfig, vendor: string) =>
  view<VendorPolicy | null>(cfg, cfg.treasuryId, 'get_vendor_policy', { vendor });

export const isInvoiceUsed = (cfg: NearConfig, hash: string) =>
  view<boolean>(cfg, cfg.treasuryId, 'is_invoice_used', { hash });

export const getConfig = (cfg: NearConfig) => view<TreasuryConfig>(cfg, cfg.treasuryId, 'get_config');

export const getMonthlySpent = (cfg: NearConfig, vendor: string | null) =>
  view<string>(cfg, cfg.treasuryId, 'monthly_spent', { vendor });

export const getPayment = (cfg: NearConfig, id: number) =>
  view<Payment | null>(cfg, cfg.treasuryId, 'get_payment', { id });

/** Same view on any contract (e.g. the token's storage_balance_bounds). */
export const viewOn = <T>(cfg: NearConfig, contract: string, method: string, args: object = {}) => view<T>(cfg, contract, method, args);

export type AccessKeyPermission = 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };

export interface AccessKeyView {
  nonce: number;
  permission: AccessKeyPermission;
  block_hash: string;
}

/** On-chain access key (never cached: the nonce changes). */
export const getAccessKey = (cfg: NearConfig, accountId: string, publicKey: string) =>
  rpc<AccessKeyView>(cfg, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });

/** All payments (pages of 100). */
export async function getPayments(cfg: NearConfig): Promise<Payment[]> {
  const out: Payment[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Payment[]>(cfg, cfg.treasuryId, 'get_payments', { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}
