import { describe, expect, it } from 'vitest';
import { compareReadings } from '../src/compare.ts';
import { normalizeExtraction } from '../src/normalize.ts';
import type { Extraction } from '../src/types.ts';
import { invoice } from './fixtures.ts';

const raw = (over: Partial<Extraction> = {}): Extraction => ({
  vendor_name: 'Acme', vendor_near_account: 'acme.testnet', invoice_number: 'INV-1', issue_date: '2026-11-02',
  due_date: '2026-12-02', currency: 'USDC', total: '1,200.00', line_items: [], payment_instructions_text: null, ...over,
});

describe('compareReadings', () => {
  it('agrees when critical fields match after normalization', () => {
    const a = normalizeExtraction(raw());
    const b = normalizeExtraction(raw({ vendor_near_account: ' ACME.testnet', invoice_number: 'inv-1', due_date: '2 Dec 2026', total: '$1200', currency: 'usdc', vendor_name: 'ACME DESIGN' }));
    const c = compareReadings(a, b);
    expect(c.agree).toBe(true);
    expect(c.reasons).toEqual([]);
    expect(c.agreed?.amount_base_units).toBe(1_200_000_000n);
  });

  it('ignores non-critical fields (name, issue date, line items)', () => {
    const c = compareReadings(invoice(), invoice({ vendor_name: 'Other', issue_date: null, line_items: [] }));
    expect(c.agree).toBe(true);
  });

  it('reports a total misread (1,200 read as 200)', () => {
    const c = compareReadings(normalizeExtraction(raw()), normalizeExtraction(raw({ total: '200.00' })));
    expect(c.agree).toBe(false);
    expect(c.mismatches).toEqual([{ field: 'amount_base_units', a: '1200.00', b: '200.00' }]);
    expect(c.reasons).toEqual(['readers disagree on total: A=1200.00, B=200.00']);
  });

  it('reports every critical field that differs', () => {
    const c = compareReadings(
      invoice(),
      invoice({ vendor_account: 'evil.testnet', invoice_number: 'INV-2', currency: 'EUR', due_date: null, amount_base_units: null }),
    );
    expect(c.mismatches.map((m) => m.field)).toEqual(['vendor_account', 'invoice_number', 'amount_base_units', 'currency', 'due_date']);
    expect(c.reasons).toContain('readers disagree on due date: A=2026-12-02, B=missing');
    expect(c.reasons).toContain('readers disagree on total: A=120.00, B=unreadable');
  });

  it('treats a missing reading as disagreement and keeps the other one', () => {
    const c = compareReadings(invoice(), null);
    expect(c.agree).toBe(false);
    expect(c.reasons).toEqual(['reader B returned no usable reading']);
    expect(c.agreed?.invoice_number).toBe('INV-1');
    expect(compareReadings(null, null).reasons).toEqual(['both readers returned no usable reading']);
    expect(compareReadings(null, invoice()).reasons).toEqual(['reader A returned no usable reading']);
  });

  it('merges payment text from both readers so an address seen by only one is still checked', () => {
    const c = compareReadings(invoice({ payment_instructions_text: 'Pay acme.testnet' }), invoice({ payment_instructions_text: 'Pay 0x9999999999999999999999999999999999999999' }));
    expect(c.agreed?.payment_instructions_text).toContain('0x9999999999999999999999999999999999999999');
    expect(c.agreed?.payment_instructions_text).toContain('Pay acme.testnet');
    const same = compareReadings(invoice({ payment_instructions_text: 'x' }), invoice({ payment_instructions_text: 'x' }));
    expect(same.agreed?.payment_instructions_text).toBe('x');
    const one = compareReadings(invoice({ payment_instructions_text: null }), invoice({ payment_instructions_text: 'y' }));
    expect(one.agreed?.payment_instructions_text).toBe('y');
  });
});
