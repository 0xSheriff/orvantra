// Merge on-chain payments, the agent ledger and web upload records into invoice rows + review facts. Pure.
import type { LedgerEntry } from 'orvantra-agent/ledger';
import type { Payment, TreasuryConfig, VendorPolicy, VendorView } from 'orvantra-agent/near';
import type { InvoiceRecord } from 'orvantra-agent/records';
import { nsToIso, routeLabel } from './format';
import { buildVerdict, classify, type ReviewFacts, type ReviewState, type Verdict } from './verdict';

export type Category = 'held' | 'paid' | 'stopped';

export interface Row {
  /** p<payment id> | u<record id> | l<hash prefix> */
  key: string;
  vendorName: string;
  vendorAccount: string | null;
  invoiceNumber: string | null;
  receivedAt: string | null;
  category: Category;
  state: ReviewState;
  outcome: string;
  route: string | null;
  amount: string | null;
  payment: Payment | null;
  record: InvoiceRecord | null;
  ledger: LedgerEntry | null;
  /** Original file name in the agent's fixtures dir, for rows without an upload record (CLI runs). */
  fixtureFile: string | null;
}

export interface ChainContext {
  network: string;
  treasuryId: string;
  config: TreasuryConfig | null;
  tokenId: string | null;
  unit: string;
  registry: Map<string, VendorView>;
  policies: Map<string, VendorPolicy | null>;
}

export function stateOfPayment(p: Payment): ReviewState {
  switch (p.status) {
    case 'Pending': return 'pending';
    case 'Verifying':
    case 'Executing': return 'paying';
    case 'Paid': return 'paid';
    case 'Rejected': return 'rejected';
    case 'Failed': return 'failed';
  }
}

const NOT_SENT = new Set(['dry-run', 'analyzed']);

export function stateOfRecord(r: InvoiceRecord): ReviewState {
  return NOT_SENT.has(r.outcome) ? 'not-sent' : 'stopped';
}

export const categoryOf = (s: ReviewState): Category => (s === 'pending' || s === 'paying' ? 'held' : s === 'paid' ? 'paid' : 'stopped');

/** Readable outcome for runs that never reached the chain and have no finding to explain them. */
const RECORD_OUTCOME: Record<string, string> = {
  'no-hash': 'Stopped — the invoice could not be read',
  'cannot-propose': 'Stopped — the treasury could not be read',
  'already-proposed': 'Stopped — duplicate invoice',
  'quote-invalid': "Stopped — the 1Click quote didn't match the registry",
  'preflight-failed': 'Stopped — the agent key is not set up',
  'contract-refused': 'Stopped — the treasury refused it',
  error: 'Stopped — the run failed',
  'dry-run': 'Not sent — dry run',
  analyzed: 'Not sent — read only',
};

export function factsFor(row: Pick<Row, 'state' | 'vendorName' | 'vendorAccount' | 'amount' | 'invoiceNumber' | 'payment' | 'record'>, ctx: ChainContext): ReviewFacts {
  const r = row.record;
  const p = row.payment;
  const acct = row.vendorAccount;
  const reg = acct ? ctx.registry.get(acct) ?? null : null;
  const policy = acct ? (ctx.policies.has(acct) ? ctx.policies.get(acct)! : r?.vendor_policy ?? null) : null;
  const regKnown = acct ? ctx.registry.has(acct) || ctx.policies.has(acct) : false;
  const payout = p?.payout ?? reg?.payout ?? r?.registry_entry?.payout ?? null;
  return {
    state: row.state,
    approvedByOwner: !!p?.approved_by_owner,
    vendorName: row.vendorName,
    vendorAccount: acct,
    amount: row.amount,
    unit: ctx.unit,
    invoiceNumber: row.invoiceNumber,
    registered: reg ? true : r ? !!r.registry_entry : regKnown ? false : null,
    approved: policy ? true : r ? !!r.vendor_policy : null,
    maxPerInvoice: policy?.max_per_invoice ?? null,
    readers: r && r.readers.length
      ? { count: r.readers.length, answered: r.readers.filter((x) => x.ok).length, verified: r.readers.filter((x) => x.verified).length, agree: !!r.agree }
      : null,
    // A record read after this payment was proposed sees its own payment as "already used": not a real duplicate.
    agentFindings: (r?.decision?.findings ?? [])
      .filter((f) => !(p && r?.invoice_hash === p.invoice_hash && classify(f.message).kind === 'duplicate'))
      .map((f) => f.message),
    contractReasons: p?.reasons ?? [],
    payout: payout ? { address: payout.address, chain: payout.chain } : null,
    autoPayThreshold: ctx.config?.auto_pay_threshold ?? r?.config?.auto_pay_threshold ?? null,
    minPayoutAgeSec: ctx.config?.min_payout_age_sec ?? r?.config?.min_payout_age_sec ?? null,
  };
}

export function verdictFor(row: Row, ctx: ChainContext): Verdict {
  return buildVerdict(factsFor(row, ctx));
}

function vendorNameOf(acct: string | null, rec: InvoiceRecord | null, ctx: ChainContext): string {
  return rec?.invoice?.vendor_name || (acct ? ctx.registry.get(acct)?.display_name : null) || rec?.registry_entry?.display_name || acct || 'Unknown vendor';
}

/**
 * One row per on-chain payment (with the upload record that proposed it, or a read-only record of the same
 * invoice, attached), one per upload that never became a payment (rejected, duplicate, failed), and one per
 * ledger entry (CLI runs) with neither. Newest first.
 */
export function buildRows(payments: Payment[], ledger: LedgerEntry[], records: InvoiceRecord[], ctx: ChainContext): Row[] {
  const forTreasury = <T extends { network: string; treasury: string }>(x: T) => x.network === ctx.network && x.treasury === ctx.treasuryId;
  const recs = records.filter(forTreasury);
  const ledg = ledger.filter(forTreasury);
  const usedRecords = new Set<string>();
  const usedLedger = new Set<string>();
  const rows: Row[] = [];

  for (const p of payments) {
    const proposedBy = recs.find((r) => r.payment_id === p.id && r.invoice_hash === p.invoice_hash);
    const evidence = recs.find((r) => r.invoice_hash === p.invoice_hash && NOT_SENT.has(r.outcome));
    const rec = proposedBy ?? evidence ?? null;
    for (const r of recs) if (r.invoice_hash === p.invoice_hash && (r === proposedBy || NOT_SENT.has(r.outcome))) usedRecords.add(r.id);
    const led = ledg.find((l) => l.invoice_hash === p.invoice_hash) ?? null;
    if (led) usedLedger.add(led.invoice_hash);
    const state = stateOfPayment(p);
    const row: Row = {
      key: `p${p.id}`,
      vendorName: vendorNameOf(p.vendor, rec, ctx),
      vendorAccount: p.vendor,
      invoiceNumber: rec?.invoice?.invoice_number || p.memo || led?.invoice_number || null,
      receivedAt: rec?.received_at ?? led?.statuses[0]?.at ?? nsToIso(p.created_at),
      category: categoryOf(state),
      state,
      outcome: '',
      route: routeLabel(p.payout ?? ctx.registry.get(p.vendor)?.payout, ctx.tokenId, ctx.unit),
      amount: p.amount,
      payment: p,
      record: rec,
      ledger: led,
      fixtureFile: rec ? null : led?.file ?? null,
    };
    row.outcome = verdictFor(row, ctx).outcome;
    rows.push(row);
  }

  for (const r of recs) {
    if (usedRecords.has(r.id)) continue;
    // A record whose payment exists on another treasury page/network is filtered above; a record that proposed a
    // payment we can't see (RPC lag) still shows as its own row.
    const state = r.payment ? stateOfPayment(r.payment) : stateOfRecord(r);
    const acct = r.invoice?.vendor_account ?? null;
    const row: Row = {
      key: `u${r.id}`,
      vendorName: vendorNameOf(acct, r, ctx),
      vendorAccount: acct,
      invoiceNumber: r.invoice?.invoice_number || null,
      receivedAt: r.received_at,
      category: categoryOf(state),
      state,
      outcome: '',
      route: r.decision?.action === 'reject' ? null : routeLabel(r.registry_entry?.payout, ctx.tokenId, ctx.unit),
      amount: r.invoice?.amount_base_units ?? null,
      payment: r.payment,
      record: r,
      ledger: null,
      fixtureFile: null,
    };
    const v = verdictFor(row, ctx);
    const hasFinding = (r.decision?.findings.length ?? 0) > 0;
    row.outcome = r.outcome === 'already-proposed' ? RECORD_OUTCOME['already-proposed']
      : hasFinding && r.outcome === 'rejected' ? v.outcome
      : RECORD_OUTCOME[r.outcome] ?? v.outcome;
    rows.push(row);
  }

  for (const l of ledg) {
    if (usedLedger.has(l.invoice_hash) || l.payment_id != null) continue;
    const last = l.statuses.at(-1)?.status ?? '';
    const state: ReviewState = l.decision === 'reject' || last === 'quote:invalid' || last === 'tx-failed' ? 'stopped' : 'not-sent';
    rows.push({
      key: `l${l.invoice_hash.slice(0, 16)}`,
      vendorName: vendorNameOf(l.vendor, null, ctx),
      vendorAccount: l.vendor,
      invoiceNumber: l.invoice_number,
      receivedAt: l.statuses[0]?.at ?? null,
      category: categoryOf(state),
      state,
      outcome: l.decision === 'reject' ? 'Stopped — rejected by the agent' : last === 'dry-run' ? 'Not sent — dry run' : `Stopped — ${last || 'not sent'}`,
      route: l.vendor ? routeLabel(ctx.registry.get(l.vendor)?.payout, ctx.tokenId, ctx.unit) : null,
      amount: l.amount,
      payment: null,
      record: null,
      ledger: l,
      fixtureFile: l.file,
    });
  }

  return rows.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
}

export function counts(rows: Row[]): Record<'all' | Category, number> {
  return {
    all: rows.length,
    held: rows.filter((r) => r.category === 'held').length,
    paid: rows.filter((r) => r.category === 'paid').length,
    stopped: rows.filter((r) => r.category === 'stopped').length,
  };
}
