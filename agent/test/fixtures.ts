// Shared test data (no network).
import type { Payment, TreasuryConfig, VendorPolicy, VendorView } from '../src/near.ts';
import type { NormalizedInvoice } from '../src/types.ts';
import type { CheckInput } from '../src/checks.ts';

export const invoice = (over: Partial<NormalizedInvoice> = {}): NormalizedInvoice => ({
  document_type: 'invoice',
  vendor_name: 'Acme Design Studio',
  vendor_account: 'acme.testnet',
  invoice_number: 'INV-1',
  issue_date: '2026-11-02',
  due_date: '2026-12-02',
  currency: 'USDC',
  amount_base_units: 120_000_000n,
  line_items: [
    { description: 'Design', amount_base_units: 80_000_000n },
    { description: 'Icons', amount_base_units: 40_000_000n },
  ],
  payment_instructions_text: 'Pay in USDC via Orvantra to NEAR account acme.testnet.',
  ...over,
});

export const registry = (over: Partial<VendorView> = {}): VendorView => ({
  account_id: 'acme.testnet',
  display_name: 'Acme',
  payout: { chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', address: '0x3333333333333333333333333333333333333333' },
  created_at_ns: '1',
  updated_at_ns: '2',
  version: 2,
  ...over,
});

export const policy: VendorPolicy = { max_per_invoice: '300000000', monthly_cap: '600000000' };

export const config: TreasuryConfig = {
  owner: 'owner.testnet',
  agent: 'agent.testnet',
  registry: 'registry.testnet',
  token: 'tusdc.testnet',
  auto_pay_threshold: '100000000',
  monthly_cap: '1000000000',
  min_payout_age_sec: 120,
  /** High on purpose: most tests are about other rules (the contract default is "0": the owner confirms every cross-chain payout). */
  cross_chain_auto_pay_threshold: '1000000000000',
  paused: false,
  payment_count: 0,
};

let nextId = 0;
export const paid = (vendor: string, amount: string, status: Payment['status'] = 'Paid'): Payment => ({
  id: nextId++, invoice_hash: `h${nextId}`, vendor, amount, payout_version: 1, status, reasons: [], direct: true, destination: vendor, created_at: '0',
});

/** A clean input that should be proposed. */
export const baseInput = (over: Partial<CheckInput> = {}): CheckInput => ({
  invoice: invoice(),
  agreement: { agree: true, reasons: [] },
  verification: [
    { reader: 'reader A', verified: true, detail: 'ok' },
    { reader: 'reader B', verified: true, detail: 'ok' },
  ],
  registry: registry(),
  vendorPolicy: policy,
  config,
  payoutAgeNs: (3600n * 1_000_000_000n).toString(),
  invoiceUsed: false,
  payments: [paid('acme.testnet', '100000000'), paid('acme.testnet', '90000000')],
  vendorMonthlySpent: '0',
  totalMonthlySpent: '0',
  now: new Date('2026-11-06T12:00:00Z'),
  ...over,
});
