// Full pipeline for one invoice: read (2 NEAR AI readers) -> normalize -> compare -> on-chain views -> checks.
// Read-only: nothing is written on-chain.
import { decide, type CheckInput, type Decision, type DuplicateCandidate } from './checks.ts';
import { defaultLedgerPath, readLedger, type Ledger } from './ledger.ts';
import { compareReadings, type Comparison } from './compare.ts';
import { readInvoice, type InvoiceReading, type PageImage } from './extract.ts';
import { invoiceHash } from './hash.ts';
import * as near from './near.ts';
import { isValidNearAccount, normalizeExtraction } from './normalize.ts';
import type { NormalizedInvoice } from './types.ts';

export interface ChainState {
  network: string;
  registry_id: string;
  treasury_id: string;
  registry: near.VendorView | null;
  vendor_policy: near.VendorPolicy | null;
  payout_age_ns: string | null;
  invoice_used: boolean;
  vendor_monthly_spent: string | null;
  total_monthly_spent: string | null;
  config: near.TreasuryConfig | null;
  vendor_paid_amounts: string[];
  error: string | null;
}

export interface Analysis {
  reading: InvoiceReading;
  normalized: (NormalizedInvoice | null)[];
  comparison: Comparison;
  chain: ChainState;
  decision: Decision;
}

export async function fetchChainState(cfg: near.NearConfig, account: string | null, hash: string | null): Promise<ChainState & { payments: near.Payment[] }> {
  const state: ChainState & { payments: near.Payment[] } = {
    network: cfg.network, registry_id: cfg.registryId, treasury_id: cfg.treasuryId,
    registry: null, vendor_policy: null, payout_age_ns: null, invoice_used: false,
    vendor_monthly_spent: null, total_monthly_spent: null, config: null, vendor_paid_amounts: [], payments: [], error: null,
  };
  try {
    const acct = account && isValidNearAccount(account) ? account : null;
    const [config, payments, totalSpent, used] = await Promise.all([
      near.getConfig(cfg), near.getPayments(cfg), near.getMonthlySpent(cfg, null), hash ? near.isInvoiceUsed(cfg, hash) : false,
    ]);
    Object.assign(state, { config, payments, total_monthly_spent: totalSpent, invoice_used: used });
    if (acct) {
      const [registry, policy, age, spent] = await Promise.all([
        near.getVendor(cfg, acct), near.getVendorPolicy(cfg, acct), near.getPayoutAgeNs(cfg, acct), near.getMonthlySpent(cfg, acct),
      ]);
      Object.assign(state, { registry, vendor_policy: policy, payout_age_ns: age, vendor_monthly_spent: spent });
      state.vendor_paid_amounts = payments.filter((p) => p.vendor === acct && p.status === 'Paid').map((p) => p.amount);
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  return state;
}

function safeReadLedger(): Ledger {
  try {
    return readLedger(defaultLedgerPath());
  } catch {
    return {};
  }
}

/** Ledger entries of this network + treasury that were not stopped by the agent (they may be the same invoice under another hash). */
export function ledgerCandidates(ledger: Ledger, network: string, treasury: string): DuplicateCandidate[] {
  return Object.values(ledger)
    .filter((e) => e.network === network && e.treasury === treasury && e.decision !== 'reject')
    .map((e) => ({ invoice_hash: e.invoice_hash, vendor: e.vendor, invoice_number: e.invoice_number, status: e.statuses.at(-1)?.status ?? e.decision }));
}

export interface AnalyzeOptions {
  /** The agent's ledger (default: read from disk) for the secondary duplicate guard. */
  ledger?: Ledger;
  /** invoice_hash -> file, for duplicate detection within a batch. */
  seenHashes?: Map<string, string>;
  now?: Date;
  /** Called with the page images (PDFs rendered to PNG) before they are sent to the readers. */
  onPages?: (pages: PageImage[]) => void | Promise<void>;
  /** Called after both readers answered, before the NEAR views are read. */
  onRead?: (reading: InvoiceReading) => void;
}

export async function analyzeInvoice(file: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const reading = await readInvoice(file, undefined, opts.onPages);
  opts.onRead?.(reading);
  const normalized = reading.readers.map((r) => (r.extraction ? normalizeExtraction(r.extraction) : null));
  const comparison = compareReadings(normalized[0], normalized[1]);
  const inv = comparison.agreed;

  const hash = inv?.vendor_account && inv.amount_base_units != null && inv.amount_base_units > 0n && inv.invoice_number
    ? invoiceHash(inv.vendor_account, inv.invoice_number, inv.amount_base_units, inv.currency)
    : null;
  const { payments, ...chain } = await fetchChainState(near.nearConfig(), inv?.vendor_account ?? null, hash);

  const input: CheckInput = {
    invoice: inv,
    agreement: comparison,
    verification: reading.readers.map((r) => ({
      reader: `reader ${r.reader} (${r.model})`,
      verified: r.receipt.verified,
      detail: r.receipt.error ?? 'not verified',
      tee: r.receipt.tee,
      e2eeFallbackReason: r.receipt.e2ee_fallback_reason,
    })),
    ledgerCandidates: ledgerCandidates(opts.ledger ?? safeReadLedger(), chain.network, chain.treasury_id),
    registry: chain.registry,
    vendorPolicy: chain.vendor_policy,
    config: chain.config,
    payoutAgeNs: chain.payout_age_ns,
    invoiceUsed: chain.invoice_used,
    duplicateOf: hash ? opts.seenHashes?.get(hash) ?? null : null,
    payments,
    vendorMonthlySpent: chain.vendor_monthly_spent,
    totalMonthlySpent: chain.total_monthly_spent,
    chainError: chain.error,
    now: opts.now ?? new Date(),
  };
  const decision = decide(input);
  if (hash && opts.seenHashes && !opts.seenHashes.has(hash)) opts.seenHashes.set(hash, file.split('/').pop() ?? file);
  return { reading, normalized, comparison, chain, decision };
}

/** JSON.stringify with bigint support. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
