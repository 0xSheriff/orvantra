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
  paused: boolean;
  payment_count: number;
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

export function nearConfig(env: NodeJS.ProcessEnv = process.env): NearConfig {
  const network = env.NEAR_NETWORK ?? 'testnet';
  const list = (env.NEAR_RPC_URLS ?? env.NEAR_RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ttl = Number(env.NEAR_VIEW_CACHE_MS);
  return {
    network,
    rpcUrls: list.length ? list : DEFAULT_RPC_URLS[network] ?? [`https://rpc.${network}.near.org`],
    registryId: env.REGISTRY_ID ?? 'orvantra-registry.testnet',
    treasuryId: env.TREASURY_ID ?? 'orvantra-treasury.testnet',
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

/** One HTTP attempt against one endpoint. Throws TransientRpcError for retryable failures, Error otherwise. */
async function viewOnce<T>(url: string, contract: string, method: string, args: object, timeoutMs: number, f: typeof fetch): Promise<T> {
  const body = {
    jsonrpc: '2.0',
    id: 'orvantra',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
  };
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
  let json: { error?: { name?: string; cause?: { name?: string } }; result?: { result?: number[]; error?: string } };
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
  if (json.result?.error) throw new Error(`NEAR view ${contract}.${method}: ${json.result.error}`);
  if (!json.result?.result) throw new TransientRpcError(`${host}: empty result`);
  return JSON.parse(Buffer.from(json.result.result).toString('utf8')) as T;
}

// Index (per endpoint list) of the endpoint that last answered, so a rate-limited one is not retried first every call.
const preferred = new Map<string, number>();

/** view() without the cache: failover across cfg.rpcUrls with exponential backoff + jitter. */
async function viewWithRetry<T>(cfg: NearConfig, contract: string, method: string, args: object): Promise<T> {
  const d: RpcDeps = { ...defaultDeps, ...cfg.deps };
  const p = cfg.retry;
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
      const out = await viewOnce<T>(urls[i], contract, method, args, Math.max(1, Math.floor(Math.min(p.attemptTimeoutMs, left))), d.fetch);
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

export const getPayoutAgeNs = (cfg: NearConfig, accountId: string) =>
  view<string | null>(cfg, cfg.registryId, 'payout_age_ns', { account_id: accountId });

export const getVendorPolicy = (cfg: NearConfig, vendor: string) =>
  view<VendorPolicy | null>(cfg, cfg.treasuryId, 'get_vendor_policy', { vendor });

export const isInvoiceUsed = (cfg: NearConfig, hash: string) =>
  view<boolean>(cfg, cfg.treasuryId, 'is_invoice_used', { hash });

export const getConfig = (cfg: NearConfig) => view<TreasuryConfig>(cfg, cfg.treasuryId, 'get_config');

export const getMonthlySpent = (cfg: NearConfig, vendor: string | null) =>
  view<string>(cfg, cfg.treasuryId, 'monthly_spent', { vendor });

/** All payments (pages of 100). */
export async function getPayments(cfg: NearConfig): Promise<Payment[]> {
  const out: Payment[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Payment[]>(cfg, cfg.treasuryId, 'get_payments', { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}
