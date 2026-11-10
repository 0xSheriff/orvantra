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
  /** The registry display name when the vendor is registered (it is who gets paid), else what the invoice says. */
  vendorName: string;
  /** The name printed on the invoice, when it differs from vendorName (shown second). */
  invoiceName: string | null;
  vendorAccount: string | null;
  invoiceNumber: string | null;
  /** When the invoice arrived: ledger created time, else the upload time (web runs), else on-chain created_at. */
  receivedAt: string | null;
  /** Where receivedAt came from: the agent (ledger / web upload) or the treasury (on-chain created_at). */
  receivedSource: 'agent' | 'chain' | null;
  invoiceHash: string | null;
  /** Every time the agent read this invoice hash (oldest first), across all runs folded into this row. */
  readsAt: string[];
  /** Keys of other rows for the same invoice hash that were folded into this one. */
  aliases: string[];
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
      ? {
        count: r.readers.length, answered: r.readers.filter((x) => x.ok).length, verified: r.readers.filter((x) => x.verified).length, agree: !!r.agree,
        ...(r.readers.every((x) => x.tee !== undefined) ? { tee: r.readers.filter((x) => x.tee).length } : {}),
      }
      : null,
    // A record read after this payment was proposed sees its own payment as "already used": not a real duplicate.
    agentFindings: (r?.decision?.findings ?? [])
      .map((f) => ({ kind: f.kind ?? classify(f.message).kind, raw: f.message }))
      .filter((f) => !(p && r?.invoice_hash === p.invoice_hash && f.kind === 'duplicate')),
    contractReasons: p?.reasons ?? [],
    payout: payout ? { address: payout.address, chain: payout.chain } : null,
    autoPayThreshold: ctx.config?.auto_pay_threshold ?? r?.config?.auto_pay_threshold ?? null,
    minPayoutAgeSec: ctx.config?.min_payout_age_sec ?? r?.config?.min_payout_age_sec ?? null,
  };
}

export function verdictFor(row: Row, ctx: ChainContext): Verdict {
  return buildVerdict(factsFor(row, ctx));
}

/**
 * Who the vendor is, registry first: the registry display name (the business that gets paid), then a name read from
 * an invoice (this run, or another run of the same invoice via `readNames`), then the account id. Names that are
 * missing or just the account id are skipped.
 */
export function vendorNameOf(acct: string | null, rec: InvoiceRecord | null, ctx: ChainContext, readNames: (string | null | undefined)[] = []): string {
  const useful = (n: string | null | undefined): n is string => !!n && n.trim() !== '' && n.trim() !== acct;
  const reg = (acct ? ctx.registry.get(acct)?.display_name : null) || rec?.registry_entry?.display_name;
  if (useful(reg)) return reg;
  const read = rec?.invoice?.vendor_name;
  if (useful(read)) return read;
  return readNames.find(useful) ?? acct ?? 'Unknown vendor';
}

/** The name printed on the invoice when it is not the name shown (registry first, invoice second). */
export function invoiceNameOf(shown: string, rec: InvoiceRecord | null, readNames: (string | null | undefined)[] = []): string | null {
  const read = [rec?.invoice?.vendor_name, ...readNames].find((n): n is string => !!n && n.trim() !== '');
  return read && read.trim().toLowerCase() !== shown.trim().toLowerCase() ? read.trim() : null;
}

/** When the agent first saw a ledger entry: `created_at`, else its first status (older ledgers). */
export const ledgerCreatedAt = (l: LedgerEntry): string | null => l.created_at ?? l.statuses[0]?.at ?? null;

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
    const ledAt = led ? ledgerCreatedAt(led) : null;
    const chainAt = nsToIso(p.created_at);
    const row: Row = {
      key: `p${p.id}`,
      vendorName: vendorNameOf(p.vendor, rec, ctx),
      invoiceName: null,
      vendorAccount: p.vendor,
      invoiceNumber: rec?.invoice?.invoice_number || p.memo || led?.invoice_number || null,
      receivedAt: ledAt ?? chainAt,
      receivedSource: ledAt ? 'agent' : chainAt ? 'chain' : null,
      invoiceHash: p.invoice_hash,
      readsAt: [ledAt, ...recs.filter((r) => r.invoice_hash === p.invoice_hash && usedRecords.has(r.id)).map((r) => r.received_at)]
        .filter((x): x is string => !!x),
      aliases: [],
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
    row.invoiceName = invoiceNameOf(row.vendorName, rec);
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
      invoiceName: null,
      vendorAccount: acct,
      invoiceNumber: r.invoice?.invoice_number || null,
      receivedAt: r.received_at,
      receivedSource: 'agent',
      invoiceHash: r.invoice_hash ?? null,
      readsAt: [r.received_at],
      aliases: [],
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
    row.invoiceName = invoiceNameOf(row.vendorName, r);
    const v = verdictFor(row, ctx);
    const hasFinding = (r.decision?.findings.length ?? 0) > 0;
    row.outcome = r.outcome === 'already-proposed' ? RECORD_OUTCOME['already-proposed']
      : hasFinding && r.outcome === 'rejected' ? v.outcome
      : RECORD_OUTCOME[r.outcome] ?? v.outcome;
    rows.push(row);
  }

  for (const l of ledg) {
    if (usedLedger.has(l.invoice_hash) || l.payment_id != null) continue;
    // The ledger entry of a web upload that has its own record row is the same run, not another invoice.
    if (l.upload_id && recs.some((r) => r.id === l.upload_id)) continue;
    const ledAt = ledgerCreatedAt(l);
    const last = l.statuses.at(-1)?.status ?? '';
    const state: ReviewState = l.decision === 'reject' || last === 'quote:invalid' || last === 'tx-failed' ? 'stopped' : 'not-sent';
    rows.push({
      key: `l${l.invoice_hash.slice(0, 16)}`,
      vendorName: vendorNameOf(l.vendor, null, ctx),
      invoiceName: l.vendor_name && l.vendor_name.trim().toLowerCase() !== vendorNameOf(l.vendor, null, ctx).trim().toLowerCase() ? l.vendor_name : null,
      vendorAccount: l.vendor,
      invoiceNumber: l.invoice_number,
      receivedAt: ledAt,
      receivedSource: ledAt ? 'agent' : null,
      invoiceHash: l.invoice_hash,
      readsAt: ledAt ? [ledAt] : [],
      aliases: [],
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

  return dedupeByHash(rows, ctx).sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
}

const lastRead = (r: Row): string => r.readsAt.reduce((m, x) => (x > m ? x : m), r.receivedAt ?? '');

/**
 * One row per invoice hash. An on-chain payment wins (it is the invoice's real outcome); otherwise the row from the
 * newest run wins. The winner keeps every read time, the other rows' keys as aliases, and a better vendor name
 * (registry, or read by another run) when its own is missing or just the account id.
 */
export function dedupeByHash(rows: Row[], ctx: ChainContext): Row[] {
  const groups = new Map<string, Row[]>();
  const out: Row[] = [];
  for (const r of rows) {
    if (!r.invoiceHash) { out.push(r); continue; }
    const g = groups.get(r.invoiceHash);
    if (g) g.push(r); else groups.set(r.invoiceHash, [r]);
  }
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    const [win, ...rest] = [...g].sort((a, b) => Number(!!b.payment) - Number(!!a.payment) || lastRead(b).localeCompare(lastRead(a)));
    const readNames = g.map((r) => r.record?.invoice?.vendor_name);
    const vendorName = vendorNameOf(win.vendorAccount, win.record, ctx, readNames);
    out.push({
      ...win,
      vendorName,
      invoiceName: invoiceNameOf(vendorName, win.record, readNames) ?? win.invoiceName,
      readsAt: [...new Set(g.flatMap((r) => r.readsAt))].sort(),
      aliases: [...win.aliases, ...rest.flatMap((r) => [r.key, ...r.aliases])],
    });
  }
  return out;
}

export function counts(rows: Row[]): Record<'all' | Category, number> {
  return {
    all: rows.length,
    held: rows.filter((r) => r.category === 'held').length,
    paid: rows.filter((r) => r.category === 'paid').length,
    stopped: rows.filter((r) => r.category === 'stopped').length,
  };
}
