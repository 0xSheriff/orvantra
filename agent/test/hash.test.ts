import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalInvoiceString, hashCurrency, invoiceHash } from '../src/hash.ts';

describe('invoice hash', () => {
  it('uses the canonical "vendor|number|amount|currency" string', () => {
    expect(canonicalInvoiceString('orvantra-acme.testnet', 'INV-2026-0142', 120_000_000n, 'USDC')).toBe('orvantra-acme.testnet|INV-2026-0142|120000000|USDC');
  });

  it('is sha256 hex of the canonical string', () => {
    const expected = createHash('sha256').update('orvantra-acme.testnet|INV-2026-0142|120000000|USDC').digest('hex');
    expect(invoiceHash('orvantra-acme.testnet', 'INV-2026-0142', 120_000_000n, 'USDC')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across formatting differences of the same invoice', () => {
    const h = invoiceHash('orvantra-acme.testnet', 'INV-2026-0142', 120_000_000n, 'USDC');
    expect(invoiceHash(' Orvantra-Acme.Testnet ', 'inv-2026-0142', 120_000_000n, 'usdc')).toBe(h);
    expect(invoiceHash('orvantra-acme.testnet', '#INV-2026-0142', 120_000_000n, 'USD')).toBe(h);
  });

  it('changes when any identifying field changes', () => {
    const h = invoiceHash('acme.near', 'INV-1', 1_000_000n, 'USDC');
    expect(invoiceHash('acme2.near', 'INV-1', 1_000_000n, 'USDC')).not.toBe(h);
    expect(invoiceHash('acme.near', 'INV-2', 1_000_000n, 'USDC')).not.toBe(h);
    expect(invoiceHash('acme.near', 'INV-1', 1_000_001n, 'USDC')).not.toBe(h);
    expect(invoiceHash('acme.near', 'INV-1', 1_000_000n, 'EUR')).not.toBe(h);
  });

  it('fits the treasury invoice_hash limit (128 bytes)', () => {
    expect(invoiceHash('a'.repeat(64), 'X'.repeat(500), 10n ** 30n, 'USDC').length).toBe(64);
  });

  it('maps USD to USDC (settlement currency)', () => {
    expect(hashCurrency('USD')).toBe('USDC');
    expect(hashCurrency('$')).toBe('USDC');
    expect(hashCurrency('usdc')).toBe('USDC');
    expect(hashCurrency('EUR')).toBe('EUR');
  });
});
