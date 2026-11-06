// Server-side data for every page: live NEAR views (read-only) + the agent ledger + upload records.
// Nothing here signs or writes on-chain.
import 'server-only';
import { existsSync, readdirSync } from 'node:fs';
import { readLedger, type LedgerEntry } from 'orvantra-agent/ledger';
import * as nearViews from 'orvantra-agent/near';
import type { Payment, TreasuryConfig, VendorPolicy, VendorView } from 'orvantra-agent/near';
import { listRecords } from 'orvantra-agent/records';
import { unitFor } from '../format';
import { buildRows, counts, type ChainContext, type Row } from '../rows';
import { near, serverConfig, type ServerConfig } from './config';

export interface VendorRow {
  account: string;
  registry: VendorView | null;
  policy: VendorPolicy | null;
  monthlySpent: string | null;
  payoutAgeNs: string | null;
  paidCount: number;
}

export interface AppData {
  cfg: ServerConfig;
  ctx: ChainContext;
  config: TreasuryConfig | null;
  payments: Payment[];
  rows: Row[];
  counts: ReturnType<typeof counts>;
  pending: Row[];
  vendors: VendorRow[];
  balance: string | null;
  totalSpent: string | null;
  /** Set when NEAR could not be read; pages still render the local ledger. */
  chainError: string | null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadData(): Promise<AppData> {
  const cfg = serverConfig();
  const nc = near();
  let chainError: string | null = null;
  let config: TreasuryConfig | null = null;
  let payments: Payment[] = [];
  let totalSpent: string | null = null;
  let balance: string | null = null;
  let registryList: VendorView[] = [];

  try {
    [config, payments, totalSpent, registryList] = await Promise.all([
      nearViews.getConfig(nc),
      nearViews.getPayments(nc),
      nearViews.getMonthlySpent(nc, null),
      nearViews.view<VendorView[]>(nc, cfg.registryId, 'get_vendors', { from_index: 0, limit: 100 }),
    ]);
  } catch (e) {
    chainError = errMsg(e);
  }
  const tokenId = cfg.tokenId ?? config?.token ?? null;
  if (tokenId && !chainError) {
    balance = await nearViews.viewOn<string>(nc, tokenId, 'ft_balance_of', { account_id: cfg.treasuryId }).catch(() => null);
  }

  const registry = new Map(registryList.map((v) => [v.account_id, v]));
  const accounts = [...new Set([...registry.keys(), ...payments.map((p) => p.vendor)])];
  const policies = new Map<string, VendorPolicy | null>();
  const spent = new Map<string, string | null>();
  if (!chainError) {
    await Promise.all(accounts.map(async (a) => {
      const [policy, s] = await Promise.all([
        nearViews.getVendorPolicy(nc, a).catch(() => undefined),
        nearViews.getMonthlySpent(nc, a).catch(() => null),
      ]);
      if (policy !== undefined) policies.set(a, policy);
      spent.set(a, s);
    }));
  }

  const ctx: ChainContext = {
    network: cfg.network, treasuryId: cfg.treasuryId, config, tokenId, unit: unitFor(cfg.network, tokenId), registry, policies,
  };

  let ledgerEntries: LedgerEntry[] = [];
  try {
    ledgerEntries = Object.values(readLedger(cfg.ledgerPath));
  } catch {
    ledgerEntries = [];
  }
  const records = listRecords(cfg.filesDir);
  const rows = buildRows(payments, ledgerEntries, records, ctx);

  const ageNow = BigInt(Date.now()) * 1_000_000n;
  const vendors: VendorRow[] = accounts
    .map((a) => {
      const reg = registry.get(a) ?? null;
      return {
        account: a,
        registry: reg,
        policy: policies.get(a) ?? null,
        monthlySpent: spent.get(a) ?? null,
        payoutAgeNs: reg ? (ageNow - BigInt(reg.updated_at_ns)).toString() : null,
        paidCount: payments.filter((p) => p.vendor === a && p.status === 'Paid').length,
      };
    })
    .sort((x, y) => Number(!!y.policy) - Number(!!x.policy) || x.account.localeCompare(y.account));

  return {
    cfg, ctx, config, payments, rows, counts: counts(rows),
    pending: rows.filter((r) => r.state === 'pending').sort((a, b) => (a.payment?.id ?? 0) - (b.payment?.id ?? 0)),
    vendors, balance, totalSpent, chainError,
  };
}

/** Fixture files the CLI ran (for showing the original of a payment proposed outside the web app). */
export function fixtureExists(cfg: ServerConfig, name: string | null): boolean {
  if (!name || !/^[\w.-]+\.(png|jpe?g)$/i.test(name)) return false;
  return existsSync(cfg.fixturesDir) && readdirSync(cfg.fixturesDir).includes(name);
}

/** Fresh read of one payment (no view cache), for polling after the owner signs. */
export async function readPayment(id: number): Promise<Payment | null> {
  return nearViews.getPayment(near(true), id);
}
