import { describe, expect, it } from 'vitest';
import type { Payment } from 'orvantra-agent/near';
import type { InvoiceRecord } from 'orvantra-agent/records';
import type { LedgerEntry } from 'orvantra-agent/ledger';
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
    expect(r).toMatchObject({ key: 'p3', vendorName: 'Acme Design Studio', invoiceNumber: 'INV-2026-0150', category: 'held', route: 'USDC on Base' });
    expect(r.outcome).toBe('Held — asks to pay a different address');
    expect(factsFor(r, ctx).agentFindings.some((m) => m.includes('duplicate'))).toBe(false);
  });

  it('a rejected upload is its own stopped row; a duplicate upload keeps its duplicate finding', () => {
    const dup = record({ id: '1793998400000-00000001', mode: 'execute', outcome: 'rejected', invoice_hash: 'h3', decision: { ...record({}).decision!, findings: [{ level: 'reject', message: 'invoice_hash already used in the treasury (duplicate invoice)' }] } });
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
      ['p0', 'Paid automatically'], // created 2026-11-06 21:13 UTC, newest first
      ['lh9', 'Stopped — rejected by the agent'],
    ]);
    expect(rows[1].fixtureFile).toBe('07-unknown-vendor.png');
    expect(counts(rows)).toEqual({ all: 2, held: 0, paid: 1, stopped: 1 });
  });
});
