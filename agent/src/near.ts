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

export interface NearConfig {
  network: string;
  rpcUrl: string;
  registryId: string;
  treasuryId: string;
}

export function nearConfig(env: NodeJS.ProcessEnv = process.env): NearConfig {
  const network = env.NEAR_NETWORK ?? 'testnet';
  return {
    network,
    rpcUrl: env.NEAR_RPC_URL ?? `https://rpc.${network}.near.org`,
    registryId: env.REGISTRY_ID ?? 'orvantra-registry.testnet',
    treasuryId: env.TREASURY_ID ?? 'orvantra-treasury.testnet',
  };
}

const USER_AGENT = 'orvantra-agent/0.1';

/** Call a view method and JSON-decode its return value. */
export async function view<T>(cfg: NearConfig, contract: string, method: string, args: object = {}): Promise<T> {
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
  const res = await fetch(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`NEAR RPC ${method}: HTTP ${res.status}`);
  const json = (await res.json()) as {
    error?: unknown;
    result?: { result?: number[]; error?: string };
  };
  if (json.error) throw new Error(`NEAR RPC ${method}: ${JSON.stringify(json.error)}`);
  if (json.result?.error) throw new Error(`NEAR view ${contract}.${method}: ${json.result.error}`);
  if (!json.result?.result) throw new Error(`NEAR RPC ${method}: empty result`);
  return JSON.parse(Buffer.from(json.result.result).toString('utf8')) as T;
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
