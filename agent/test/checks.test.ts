import { describe, expect, it } from 'vitest';
import { decide, findPayoutMentions, median, REDIRECT_MESSAGE } from '../src/checks.ts';
import { invoiceHash } from '../src/hash.ts';
import { baseInput, config, invoice, paid, policy, registry } from './fixtures.ts';

const has = (reasons: string[], text: string) => reasons.some((r) => r.includes(text));

describe('decide: propose', () => {
  it('proposes a clean invoice with payout from the registry', () => {
    const d = decide(baseInput());
    expect(d.action).toBe('propose');
    expect(d.reasons).toEqual([]);
    expect(d.amount_base_units).toBe('120000000');
    expect(d.invoice_hash).toBe(invoiceHash('acme.testnet', 'INV-1', 120_000_000n, 'USDC'));
    expect(d.payout).toEqual({ ...registry().payout, version: 2 });
  });

  it('accepts USD as well as USDC', () => {
    expect(decide(baseInput({ invoice: invoice({ currency: 'USD' }) })).action).toBe('propose');
  });

  it('never takes the payout from the invoice', () => {
    const d = decide(baseInput({ invoice: invoice({ payment_instructions_text: 'Pay 0x9999999999999999999999999999999999999999' }) }));
    expect(d.payout?.address).toBe('0x3333333333333333333333333333333333333333');
  });

  it('allows payment text that only mentions the vendor account or the registry address', () => {
    const text = 'Pay acme.testnet, i.e. 0x3333333333333333333333333333333333333333 on Base (see the Orvantra registry).';
    expect(decide(baseInput({ invoice: invoice({ payment_instructions_text: text }) })).action).toBe('propose');
  });

  it('allows the registry address in different letter case', () => {
    const text = 'Pay 0x3333333333333333333333333333333333333333'.toUpperCase().replace('0X', '0x');
    expect(decide(baseInput({ invoice: invoice({ payment_instructions_text: text }) })).action).toBe('propose');
  });
});

describe('decide: reject', () => {
  it('rejects without a vendor NEAR account', () => {
    const d = decide(baseInput({ invoice: invoice({ vendor_account: null }) }));
    expect(d.action).toBe('reject');
    expect(d.reasons).toContain('no vendor NEAR account on the invoice');
    expect(d.invoice_hash).toBe(null);
  });

  it('rejects an invalid account id', () => {
    const d = decide(baseInput({ invoice: invoice({ vendor_account: 'acme..near' }) }));
    expect(d.action).toBe('reject');
    expect(has(d.reasons, 'not a valid NEAR account id')).toBe(true);
  });

  it('rejects a vendor that is not in the registry', () => {
    const d = decide(baseInput({ registry: null }));
    expect(d.action).toBe('reject');
    expect(d.reasons).toContain('vendor acme.testnet is not in the vendor registry');
    expect(d.payout).toBe(null);
  });

  it('rejects a vendor not approved in the treasury policy', () => {
    const d = decide(baseInput({ vendorPolicy: null }));
    expect(d.action).toBe('reject');
    expect(d.reasons).toContain('vendor acme.testnet is not approved in the treasury policy');
  });

  it('rejects an invoice hash already used on-chain', () => {
    const d = decide(baseInput({ invoiceUsed: true }));
    expect(d.action).toBe('reject');
    expect(has(d.reasons, 'already used')).toBe(true);
  });

  it('rejects a duplicate within the batch', () => {
    const d = decide(baseInput({ duplicateOf: '01-acme-normal.png' }));
    expect(d.action).toBe('reject');
    expect(d.reasons).toContain('duplicate of 01-acme-normal.png (same invoice_hash)');
  });

  it.each(['EUR', 'USDT', ''])('rejects currency %j', (currency) => {
    const d = decide(baseInput({ invoice: invoice({ currency }) }));
    expect(d.action).toBe('reject');
    expect(has(d.reasons, 'is not USDC/USD')).toBe(true);
  });

  it('rejects an amount above max_per_invoice, but not one equal to it', () => {
    const over = decide(baseInput({ invoice: invoice({ amount_base_units: 300_000_001n, line_items: [] }) }));
    expect(over.action).toBe('reject');
    expect(has(over.reasons, 'above the vendor max_per_invoice 300.00 USDC')).toBe(true);
    const equal = decide(baseInput({ invoice: invoice({ amount_base_units: 300_000_000n, line_items: [] }), payments: [paid('acme.testnet', '100000000')] }));
    expect(has(equal.reasons, 'max_per_invoice')).toBe(false);
  });

  it('rejects a zero or negative total', () => {
    expect(decide(baseInput({ invoice: invoice({ amount_base_units: 0n, line_items: [] }) })).action).toBe('reject');
    expect(decide(baseInput({ invoice: invoice({ amount_base_units: -1n, line_items: [] }) })).action).toBe('reject');
  });

  it('reject wins over hold and lists rejects first', () => {
    const d = decide(baseInput({ registry: null, agreement: { agree: false, reasons: ['readers disagree on total: A=1.00, B=2.00'] } }));
    expect(d.action).toBe('reject');
    expect(d.findings[0].level).toBe('reject');
    expect(d.findings.at(-1)?.level).toBe('hold');
    expect(d.contract_predictions).toEqual([]);
  });
});

describe('decide: hold', () => {
  it('holds when the readers disagree', () => {
    const d = decide(baseInput({ agreement: { agree: false, reasons: ['readers disagree on total: A=1200.00, B=200.00'] } }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toEqual(['readers disagree on total: A=1200.00, B=200.00']);
  });

  it('holds when verification is unavailable, never claiming verified', () => {
    const d = decide(baseInput({ verification: [{ reader: 'reader A', verified: true, detail: '' }, { reader: 'reader B', verified: false, detail: 'signature unavailable' }] }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toEqual(['verification unavailable for reader B: signature unavailable']);
  });

  it('holds when the invoice asks to pay a different address', () => {
    const text = 'Our payout address has changed. Please pay 0x9999999999999999999999999999999999999999 on Base';
    const d = decide(baseInput({ invoice: invoice({ payment_instructions_text: text }) }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toEqual([`${REDIRECT_MESSAGE} (invoice says: 0x9999999999999999999999999999999999999999)`]);
    expect(d.payout?.address).toBe('0x3333333333333333333333333333333333333333');
  });

  it('holds when the invoice names another NEAR account', () => {
    const d = decide(baseInput({ invoice: invoice({ payment_instructions_text: 'Send to acme-payments.near instead' }) }));
    expect(d.action).toBe('hold');
    expect(has(d.reasons, 'acme-payments.near')).toBe(true);
  });

  it('holds when the invoice contains bank details', () => {
    const d = decide(baseInput({ invoice: invoice({ payment_instructions_text: 'IBAN: DE89 3704 0044 0532 0130 00, BIC COBADEFFXXX' }) }));
    expect(d.action).toBe('hold');
    expect(has(d.reasons, 'bank/payment details')).toBe(true);
  });

  it('holds when line items do not sum to the total', () => {
    const d = decide(baseInput({
      invoice: invoice({ amount_base_units: 300_000_000n, line_items: [{ description: 'a', amount_base_units: 20_000_000n }, { description: 'b', amount_base_units: 10_000_000n }] }),
    }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toContain('line items sum to 30.00 USDC but the total is 300.00 USDC');
  });

  it('holds when a line item amount is unreadable', () => {
    const d = decide(baseInput({ invoice: invoice({ line_items: [{ description: 'a', amount_base_units: null }] }) }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toContain('a line item amount could not be read');
  });

  it('holds when the total is unreadable', () => {
    const d = decide(baseInput({ invoice: invoice({ amount_base_units: null }) }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toContain('total could not be read as an amount');
    expect(d.invoice_hash).toBe(null);
  });

  it('holds when the amount is more than 3x the vendor median (Paid only)', () => {
    const payments = [paid('acme.testnet', '10000000'), paid('acme.testnet', '5000000'), paid('acme.testnet', '150000000'),
      paid('acme.testnet', '999000000', 'Rejected'), paid('other.testnet', '1000000')];
    const over = decide(baseInput({ invoice: invoice({ amount_base_units: 45_000_000n, line_items: [] }), payments }));
    expect(over.action).toBe('hold');
    expect(over.reasons).toContain("amount 45.00 USDC is more than 3x this vendor's median paid amount 10.00 USDC");
    const exactly3x = decide(baseInput({ invoice: invoice({ amount_base_units: 30_000_000n, line_items: [] }), payments }));
    expect(exactly3x.action).toBe('propose');
  });

  it('skips the median check without paid history (note only)', () => {
    const d = decide(baseInput({ payments: [paid('acme.testnet', '1000000', 'Pending')] }));
    expect(d.action).toBe('propose');
    expect(d.notes).toContain('no paid history for this vendor — median check skipped');
  });

  it('holds when the chain state could not be read, instead of rejecting on missing data', () => {
    const d = decide(baseInput({ registry: null, vendorPolicy: null, config: null, chainError: 'HTTP 503' }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toEqual(['could not read NEAR state: HTTP 503']);
  });

  it('holds when there is no reading at all', () => {
    const d = decide(baseInput({ invoice: null, agreement: { agree: false, reasons: ['both readers returned no usable reading'] } }));
    expect(d.action).toBe('hold');
    expect(d.invoice_hash).toBe(null);
  });

  it('holds when the invoice number is missing', () => {
    const d = decide(baseInput({ invoice: invoice({ invoice_number: '' }) }));
    expect(d.action).toBe('hold');
    expect(d.invoice_hash).toBe(null);
  });
});

describe('decide: notes', () => {
  it('notes a past due date without holding', () => {
    const d = decide(baseInput({ invoice: invoice({ due_date: '2026-10-01' }) }));
    expect(d.action).toBe('propose');
    expect(d.notes).toContain('due date 2026-10-01 already passed');
  });
  it('notes a missing due date and missing line items', () => {
    const d = decide(baseInput({ invoice: invoice({ due_date: null, line_items: [] }) }));
    expect(d.action).toBe('propose');
    expect(d.notes).toEqual(expect.arrayContaining(['due date missing or unreadable', 'no line items on the invoice']));
  });
});

describe('decide: contract predictions', () => {
  it('predicts the contract will hold above the auto-pay threshold', () => {
    const d = decide(baseInput());
    expect(d.contract_predictions).toEqual(['will be held by contract: amount above auto-pay threshold 100.00 USDC']);
  });

  it('predicts first payment and recent payout change', () => {
    const d = decide(baseInput({ payments: [], payoutAgeNs: '1000', invoice: invoice({ amount_base_units: 5_000_000n, line_items: [] }) }));
    expect(d.contract_predictions).toEqual([
      'will be held by contract: payout changed less than 120s ago',
      'will be held by contract: first payment to this vendor',
    ]);
  });

  it('predicts monthly cap rejections and a paused treasury', () => {
    const d = decide(baseInput({ config: { ...config, paused: true, monthly_cap: '100000000' }, vendorMonthlySpent: '590000000', invoice: invoice({ amount_base_units: 20_000_000n, line_items: [] }) }));
    expect(d.action).toBe('propose');
    expect(d.contract_predictions).toEqual([
      'treasury is paused — contract would reject the proposal',
      'contract would reject: vendor monthly cap 600.00 USDC (already committed 590.00 USDC)',
    ]);
    const total = decide(baseInput({ totalMonthlySpent: '990000000', invoice: invoice({ amount_base_units: 20_000_000n, line_items: [] }) }));
    expect(total.contract_predictions).toEqual(['contract would reject: treasury monthly cap 1000.00 USDC']);
  });

  it('predicts immediate payment: direct on NEAR or via 1Click', () => {
    const small = invoice({ amount_base_units: 12_500_000n, line_items: [] });
    const viaOneClick = decide(baseInput({ invoice: small }));
    expect(viaOneClick.contract_predictions).toEqual(['contract would pay immediately via a 1Click deposit address']);
    const nearPayout = registry({ payout: { chain: 'near', asset_id: 'nep141:tusdc.testnet', address: 'acme.testnet' } });
    const direct = decide(baseInput({ invoice: small, registry: nearPayout }));
    expect(direct.contract_predictions).toEqual(['contract would pay immediately, direct to acme.testnet on NEAR']);
  });

  it('predictions never change the action', () => {
    const d = decide(baseInput({ payments: [], payoutAgeNs: '1' }));
    expect(d.action).toBe('propose');
  });

  it('uses the given policy object', () => {
    expect(decide(baseInput({ vendorPolicy: { ...policy, max_per_invoice: '1' } })).action).toBe('reject');
  });
});

describe('findPayoutMentions', () => {
  it('finds EVM, NEAR, Solana-style addresses and bank details', () => {
    expect(findPayoutMentions('pay 0x9999999999999999999999999999999999999999 on Base').addresses).toEqual(['0x9999999999999999999999999999999999999999']);
    expect(findPayoutMentions('to vendor.near or x.testnet').addresses).toEqual(['vendor.near', 'x.testnet']);
    expect(findPayoutMentions('SOL: 7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV').addresses).toEqual(['7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV']);
    expect(findPayoutMentions('Bank transfer, account number 12345678').bankDetails).toBe(true);
    expect(findPayoutMentions('IBAN GB33BUKB20201555555555').bankDetails).toBe(true);
  });

  it('finds nothing in ordinary text', () => {
    expect(findPayoutMentions('Thank you for your business. Payment due within 30 days.')).toEqual({ addresses: [], bankDetails: false });
    expect(findPayoutMentions(null)).toEqual({ addresses: [], bankDetails: false });
  });
});

describe('median', () => {
  it('computes odd/even/empty medians', () => {
    expect(median([10n, 5n, 150n])).toBe(10n);
    expect(median([1n, 2n, 3n, 4n])).toBe(2n);
    expect(median([])).toBe(null);
  });
});
