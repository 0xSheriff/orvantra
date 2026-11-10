import { describe, expect, it } from 'vitest';
import type { Payment } from 'orvantra-agent/near';
import type { InvoiceRecord } from 'orvantra-agent/records';
import type { LedgerEntry } from 'orvantra-agent/ledger';
import { buildActivity } from './activity';
import { buildRows, counts, factsFor, type ChainContext } from './rows';

const ctx: ChainContext = {
  network: 'testnet', treasuryId: 't.testnet', tokenId: 'tok.testnet', unit: 'tUSDC',
  config: { owner: 'o.testnet', agent: 'a.testnet', registry: 'r.testnet', token: 'tok.testnet', auto_pay_threshold: '100000000', monthly_cap: '1000000000', min_payout_age_sec: 120, paused: false, payment_count: 2 },
  registry: new Map([['acme.testnet', { account_id: 'acme.testnet', display_name: 'Acme', payout: { chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', address: '0x3333333333333333333333333333333333333333' }, created_at_ns: '1', updated_at_ns: '1', version: 2 }]]),
  policies: new Map([['acme.testnet', { max_per_invoice: '300000000', monthly_cap: '600000000' }]]),
};

const payment = (o: Partial<Payment>): Payment => ({
  id: 3, invoice_hash: 'h3', vendor: 'acme.testnet', amount: '80000000', payout_version: 2, status: 'Pending',
  reasons: ['first payment to this vendor', 'agent: invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: 0x9999999999999999999999999999999999999999)'],
  direct: false, destination: 'sim.testnet', created_at: '1793990000000000000', ...o,
});

const record = (o: Partial<InvoiceRecord>): InvoiceRecord => ({
  version: 1, id: '1793998367528-9b262b39', received_at: '2026-11-06T20:00:00.000Z', original_name: 'x.png', file: 'x.png',
  page_image: 'x.page1.png', page_size: { width: 892, height: 1263 }, pages: 1, network: 'testnet', treasury: 't.testnet', registry: 'r.testnet',
  mode: 'analyze', outcome: 'analyzed', message: '', invoice_hash: 'h3',
  decision: { action: 'reject', reasons: [], notes: [], contract_predictions: [], invoice_hash: 'h3', amount_base_units: '80000000', payout: null, findings: [
    { level: 'reject', message: 'invoice_hash already used in the treasury (duplicate invoice)' },
    { level: 'hold', message: 'invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: 0x9999999999999999999999999999999999999999)' },
  ] },
  invoice: { vendor_name: 'Acme Design Studio', vendor_account: 'acme.testnet', invoice_number: 'INV-2026-0150', issue_date: null, due_date: null, currency: 'USDC', amount_base_units: '80000000', line_items: [], payment_instructions_text: null },
  boxes: { total: [0.6, 0.3, 0.9, 0.35] }, readers: [
    { reader: 'A', model: 'qa', ok: true, verified: true, signature_kind: 'provider_tee', e2ee: true, error: null },
    { reader: 'B', model: 'qb', ok: true, verified: true, signature_kind: 'provider_tee', e2ee: true, error: null },
  ], agree: true, disagreements: [], chain_error: null, registry_entry: null, vendor_policy: null, config: null, vendor_paid_count: 0,
  path: null, quote: null, deposit_address: null, agent_flags: [], tx_hash: null, explorer_url: null, payment_id: null, payment: null, ...o,
});

describe('buildRows', () => {
  it('attaches a read-only record of the same invoice to its payment and ignores the self-duplicate', () => {
    const rows = buildRows([payment({})], [], [record({})], ctx);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ key: 'p3', vendorName: 'Acme', invoiceName: 'Acme Design Studio', invoiceNumber: 'INV-2026-0150', category: 'held', route: 'USDC on Base' });
    expect(r.outcome).toBe('Held — asks to pay a different address');
    expect(factsFor(r, ctx).agentFindings.some((f) => typeof f !== 'string' && f.kind === 'duplicate')).toBe(false);
  });

  it('a rejected duplicate upload of a paid-for invoice folds into the payment row (one row per hash)', () => {
    const dup = record({ id: '1793998400000-00000001', mode: 'execute', outcome: 'rejected', invoice_hash: 'h3', decision: { ...record({}).decision!, findings: [{ level: 'reject', message: 'invoice_hash already used in the treasury (duplicate invoice)' }] } });
    const rows = buildRows([payment({})], [], [dup], ctx);
    expect(rows.map((r) => r.key)).toEqual(['p3']);
    expect(rows[0]).toMatchObject({ category: 'held', aliases: ['u1793998400000-00000001'], readsAt: ['2026-11-06T20:00:00.000Z'] });
  });

  it('a rejected upload with no payment is its own stopped row', () => {
    const dup = record({ id: '1793998400000-00000001', mode: 'execute', outcome: 'already-proposed', invoice_hash: 'h4' });
    const rows = buildRows([payment({})], [], [dup], ctx);
    expect(rows.map((r) => r.key)).toEqual(['u1793998400000-00000001', 'p3']);
    expect(rows[0]).toMatchObject({ category: 'stopped', outcome: 'Stopped — duplicate invoice', route: null });
  });

  it('ledger-only CLI runs, other treasuries filtered, counts', () => {
    const led: LedgerEntry[] = [
      { invoice_hash: 'h9', file: '07-unknown-vendor.png', network: 'testnet', treasury: 't.testnet', vendor: 'globex.testnet', amount: '75000000', invoice_number: 'GX-1', decision: 'reject', statuses: [{ at: '2026-11-06T10:00:00Z', status: 'analyzed:reject' }] },
      { invoice_hash: 'h8', file: 'x.png', network: 'testnet', treasury: 'old.testnet', vendor: 'x.testnet', amount: '1', invoice_number: 'X', decision: 'propose', statuses: [] },
    ];
    const rows = buildRows([payment({ id: 0, invoice_hash: 'h0', status: 'Paid', reasons: [] })], led, [], ctx);
    expect(rows.map((r) => [r.key, r.outcome])).toEqual([
      ['p0', 'Paid automatically'], // created 2026-11-06 18:33 UTC, newest first
      ['lh9', 'Stopped — rejected by the agent'],
    ]);
    expect(rows[1].fixtureFile).toBe('07-unknown-vendor.png');
    expect(counts(rows)).toEqual({ all: 2, held: 0, paid: 1, stopped: 1 });
  });
});

describe('dedupe by invoice hash', () => {
  const GX = 'gx-hash';
  const gxRecord = record({
    id: '1794005760000-0000gx01', received_at: '2026-11-06T21:56:00.000Z', mode: 'execute', outcome: 'rejected', invoice_hash: GX,
    decision: { ...record({}).decision!, invoice_hash: GX, findings: [{ level: 'reject', message: 'vendor is not in the registry' }] },
    invoice: { ...record({}).invoice!, vendor_name: 'Globex Corp', vendor_account: 'globex-unknown.testnet', invoice_number: 'GX-5521', amount_base_units: '75000000' },
  });
  const gxLedger: LedgerEntry = {
    invoice_hash: GX, file: '07-unknown-vendor.png', network: 'testnet', treasury: 't.testnet', vendor: 'globex-unknown.testnet', amount: '75000000',
    invoice_number: 'GX-5521', decision: 'reject', statuses: [{ at: '2026-11-06T21:57:00.000Z', status: 'analyzed:reject' }],
  };

  it('two runs of GX-5521 become one row: newest outcome, name read from the invoice, both reads kept', () => {
    const rows = buildRows([], [gxLedger], [gxRecord], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: `l${GX.slice(0, 16)}`, vendorName: 'Globex Corp', vendorAccount: 'globex-unknown.testnet', outcome: 'Stopped — rejected by the agent',
      receivedAt: '2026-11-06T21:57:00.000Z', aliases: ['u1794005760000-0000gx01'], readsAt: ['2026-11-06T21:56:00.000Z', '2026-11-06T21:57:00.000Z'],
    });
    const reads = buildActivity(rows, 'tUSDC').filter((e) => e.text.startsWith('Read'));
    expect(reads.map((e) => [e.at, e.text])).toEqual([
      ['2026-11-06T21:57:00.000Z', 'Read again GX-5521 from Globex Corp'],
      ['2026-11-06T21:56:00.000Z', 'Read GX-5521 from Globex Corp'],
    ]);
    expect(buildActivity(rows, 'tUSDC').filter((e) => e.tone === 'rej')).toHaveLength(1);
  });

  it('newest run wins regardless of input order', () => {
    const newer = { ...gxRecord, id: '1794009999999-0000gx02', received_at: '2026-11-06T22:30:00.000Z', outcome: 'analyzed' };
    const rows = buildRows([], [gxLedger], [newer, gxRecord], ctx);
    expect(rows.map((r) => r.key)).toEqual(['u1794009999999-0000gx02']);
    expect(rows[0].readsAt).toHaveLength(3);
  });

  it('a vendor name that is just the account id falls back to the registry display name', () => {
    const led = { ...gxLedger, invoice_hash: 'hA', vendor: 'acme.testnet' };
    expect(buildRows([], [led], [], ctx)[0].vendorName).toBe('Acme');
    const rec = record({ outcome: 'rejected', invoice_hash: 'hB', invoice: { ...record({}).invoice!, vendor_name: 'acme.testnet' } });
    expect(buildRows([], [], [rec], ctx)[0].vendorName).toBe('Acme');
    expect(buildRows([], [gxLedger], [], ctx)[0].vendorName).toBe('globex-unknown.testnet'); // nothing better known
  });

  it('a web upload and its own ledger entry are one run, one row', () => {
    const led = { ...gxLedger, upload_id: gxRecord.id, statuses: [{ at: '2026-11-06T21:56:05.000Z', status: 'analyzed:reject' }] };
    const rows = buildRows([], [led], [gxRecord], ctx);
    expect(rows.map((r) => r.key)).toEqual(['u1794005760000-0000gx01']);
    expect(rows[0].readsAt).toEqual(['2026-11-06T21:56:00.000Z']);
  });
});

describe('received time', () => {
  const T_CHAIN = '1793990000000000000'; // 2026-11-06T18:33:20Z
  const led = (o: Partial<LedgerEntry>): LedgerEntry => ({
    invoice_hash: 'h3', file: 'b.png', network: 'testnet', treasury: 't.testnet', vendor: 'acme.testnet', amount: '80000000', invoice_number: 'B-1',
    decision: 'propose', payment_id: 3, statuses: [{ at: '2026-11-06T16:31:00.000Z', status: 'dry-run' }, { at: '2026-11-06T16:39:00.000Z', status: 'proposed' }], ...o,
  });

  it('comes from the ledger created time when present', () => {
    const [r] = buildRows([payment({ created_at: T_CHAIN })], [led({ created_at: '2026-11-06T16:30:00.000Z' })], [], ctx);
    expect(r).toMatchObject({ receivedAt: '2026-11-06T16:30:00.000Z', receivedSource: 'agent' });
  });

  it('older ledger entries without created_at use their first status', () => {
    const [r] = buildRows([payment({ created_at: T_CHAIN })], [led({})], [], ctx);
    expect(r).toMatchObject({ receivedAt: '2026-11-06T16:31:00.000Z', receivedSource: 'agent' });
  });

  it('without a ledger entry it is the on-chain created_at — never a later read-only upload of the same invoice', () => {
    const [r] = buildRows([payment({ created_at: T_CHAIN })], [], [record({ received_at: '2026-11-06T23:00:00.000Z' })], ctx);
    expect(r).toMatchObject({ receivedAt: '2026-11-06T18:33:20.000Z', receivedSource: 'chain' });
    expect(r.readsAt).toEqual(['2026-11-06T23:00:00.000Z']);
  });

  it('upload-only and ledger-only rows use their own time', () => {
    const rows = buildRows([], [led({ invoice_hash: 'h7', payment_id: null, created_at: '2026-11-06T10:00:00.000Z' })], [record({ invoice_hash: 'h8' })], ctx);
    expect(rows.map((r) => [r.receivedAt, r.receivedSource])).toEqual([['2026-11-06T20:00:00.000Z', 'agent'], ['2026-11-06T10:00:00.000Z', 'agent']]);
  });
});
