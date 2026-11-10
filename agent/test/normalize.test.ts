import { describe, expect, it } from 'vitest';
import {
  formatAmount, isValidNearAccount, normalizeAccount, normalizeCurrency, normalizeDate,
  normalizeExtraction, normalizeInvoiceNumber, parseAmount,
} from '../src/normalize.ts';

describe('parseAmount', () => {
  it.each([
    ['1,200.00', 1_200_000_000n],
    ['$1200', 1_200_000_000n],
    ['1200', 1_200_000_000n],
    ['1.200,00', 1_200_000_000n],
    ['1 200,00', 1_200_000_000n],
    ['1 200,00', 1_200_000_000n],
    ["1'200.00", 1_200_000_000n],
    ['USDC 120.5', 120_500_000n],
    ['120.00 USDC', 120_000_000n],
    ['12,50', 12_500_000n],
    ['1,200', 1_200_000_000n],
    ['1,234,567.89', 1_234_567_890_000n],
    ['1.234.567,89', 1_234_567_890_000n],
    ['0.000001', 1n],
    ['.5', 500_000n],
    ['1.5000000', 1_500_000n],
    ['-5.00', -5_000_000n],
    ['-$5.00', -5_000_000n],
    ['US$ 45', 45_000_000n],
  ])('%s -> %s', (text, units) => {
    expect(parseAmount(text)).toBe(units);
  });

  it('treats a single dot as decimal, but not the ambiguous "1.200" shape (LOW-3)', () => {
    expect(parseAmount('1.5')).toBe(1_500_000n);
    expect(parseAmount('12.50')).toBe(12_500_000n);
    expect(parseAmount('0.125')).toBe(125_000n);
    expect(parseAmount('1.200')).toBeNull();
    expect(parseAmount('12.500')).toBeNull();
    expect(parseAmount('USDC 120.500')).toBeNull();
    expect(parseAmount('1,200.000')).toBe(1_200_000_000n);
  });

  it.each([
    ['−120.00'], ['–120.00'], ['(120.00)'], ['$(120.00)'], ['120.00-'], ['120.00 CR'], ['120.00CR'],
    ['Credit 120.00'], ['credit note 120.00'], ['Refund: 120.00'], ['- 120'], ['USD -120'], ['－120.00'],
  ])('credit-note notation %s is negative (A-M2)', (text) => {
    expect(parseAmount(text)).toBe(-120_000_000n);
  });

  it.each([
    ['', null], ['abc', null], ['1.2.3,4', null], ['12,34,5', null], ['1,2345', null],
    ['0.0000001', null], ['1..2', null], ['1,200,00.00', null], [null, null], [undefined, null],
  ])('rejects %s', (text, units) => {
    expect(parseAmount(text as string)).toBe(units);
  });

  it('supports other decimal counts', () => {
    expect(parseAmount('1.5', 2)).toBe(150n);
    expect(parseAmount('1.555', 2)).toBe(null);
  });
});

describe('formatAmount', () => {
  it('formats base units', () => {
    expect(formatAmount(120_000_000n)).toBe('120.00');
    expect(formatAmount(12_500_000n)).toBe('12.50');
    expect(formatAmount(1n)).toBe('0.000001');
    expect(formatAmount(-5_000_000n)).toBe('-5.00');
    expect(formatAmount(null)).toBe('—');
  });
  it('round-trips through parseAmount', () => {
    for (const v of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n]) expect(parseAmount(formatAmount(v))).toBe(v);
  });
});

describe('normalizeDate', () => {
  it.each([
    ['2026-11-20', '2026-11-20'],
    ['2026/11/20', '2026-11-20'],
    ['2026.1.5', '2026-01-05'],
    ['2026-11-20T00:00:00Z', '2026-11-20'],
    ['20 Nov 2026', '2026-11-20'],
    ['2 Dec 2026', '2026-12-02'],
    ['20-Nov-2026', '2026-11-20'],
    ['20th November 2026', '2026-11-20'],
    ['November 20, 2026', '2026-11-20'],
    ['Nov. 20 2026', '2026-11-20'],
    ['Sept 3, 2026', '2026-09-03'],
    ['20/11/2026', '2026-11-20'],
    ['11/20/2026', '2026-11-20'],
    ['05/05/2026', '2026-05-05'],
    [' 2026-11-20 ', '2026-11-20'],
  ])('%s -> %s', (text, iso) => {
    expect(normalizeDate(text)).toBe(iso);
  });

  it.each(['05/06/2026', '2026-02-30', '2026-13-01', '32 Jan 2026', 'tomorrow', '', 'Foo 3 2026'])('rejects %s', (text) => {
    expect(normalizeDate(text)).toBe(null);
  });
  it('handles null', () => expect(normalizeDate(null)).toBe(null));
});

describe('accounts, currency, invoice number', () => {
  it('normalizes accounts', () => {
    expect(normalizeAccount('  Orvantra-Acme.Testnet ')).toBe('orvantra-acme.testnet');
    expect(normalizeAccount('@acme.near')).toBe('acme.near');
    expect(normalizeAccount('acme.near.')).toBe('acme.near');
    expect(normalizeAccount('')).toBe(null);
    expect(normalizeAccount('null')).toBe(null);
    expect(normalizeAccount(null)).toBe(null);
  });

  it('validates NEAR account ids', () => {
    for (const ok of ['acme.near', 'orvantra-acme.testnet', 'a_b.near', 'ab', 'x'.repeat(64), '0'.repeat(64)]) expect(isValidNearAccount(ok)).toBe(true);
    for (const bad of ['a', 'Acme.near', 'acme..near', '-acme.near', 'acme-.near', 'acme near', 'x'.repeat(65), 'a@b.near']) expect(isValidNearAccount(bad)).toBe(false);
  });

  it('normalizes currencies', () => {
    expect(normalizeCurrency(' usdc ')).toBe('USDC');
    expect(normalizeCurrency('$')).toBe('USD');
    expect(normalizeCurrency('US$')).toBe('USD');
    expect(normalizeCurrency('usd coin')).toBe('USDC');
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(normalizeCurrency(null)).toBe('');
  });

  it('normalizes invoice numbers', () => {
    expect(normalizeInvoiceNumber(' inv-2026-0142 ')).toBe('INV-2026-0142');
    expect(normalizeInvoiceNumber('#B-0007')).toBe('B-0007');
    expect(normalizeInvoiceNumber('No. B 0007')).toBe('B0007');
    expect(normalizeInvoiceNumber('Invoice No: GX-5521')).toBe('GX-5521');
    expect(normalizeInvoiceNumber('INV-2026-0142')).toBe(normalizeInvoiceNumber('inv-2026-0142'));
  });
});

describe('normalizeExtraction', () => {
  it('normalizes every field', () => {
    const n = normalizeExtraction({
      vendor_name: ' Acme Design Studio ',
      vendor_near_account: 'Orvantra-Acme.testnet',
      invoice_number: 'inv-2026-0142',
      issue_date: '2 Nov 2026',
      due_date: '2026-12-02',
      currency: 'usdc',
      total: '$120.00',
      line_items: [{ description: ' Design ', amount: '80.00' }, { description: 'Icons', amount: 'forty' }],
      payment_instructions_text: '  ',
    });
    expect(n).toEqual({
      document_type: null, // the reader did not say
      vendor_name: 'Acme Design Studio',
      vendor_account: 'orvantra-acme.testnet',
      invoice_number: 'INV-2026-0142',
      issue_date: '2026-11-02',
      due_date: '2026-12-02',
      currency: 'USDC',
      amount_base_units: 120_000_000n,
      line_items: [{ description: 'Design', amount_base_units: 80_000_000n }, { description: 'Icons', amount_base_units: null }],
      payment_instructions_text: null,
    });
  });
});
