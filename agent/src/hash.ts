import { createHash } from 'node:crypto';
import { normalizeAccount, normalizeCurrency, normalizeInvoiceNumber } from './normalize.ts';

/**
 * Settlement currency used in the hash. USD and USDC invoices both settle in USDC, so a vendor re-issuing
 * the same invoice with "USD" instead of "USDC" still produces the same hash.
 */
export function hashCurrency(currency: string): string {
  const c = normalizeCurrency(currency);
  return c === 'USD' ? 'USDC' : c;
}

/** Canonical string: "vendor_account|invoice_number_normalized|amount_base_units|currency". */
export function canonicalInvoiceString(vendorAccount: string, invoiceNumber: string, amountBaseUnits: bigint, currency: string): string {
  return [normalizeAccount(vendorAccount) ?? '', normalizeInvoiceNumber(invoiceNumber), amountBaseUnits.toString(), hashCurrency(currency)].join('|');
}

/**
 * Looser invoice-number key for the secondary duplicate guard: NFKC, lowercase, leading zeros stripped from every
 * run of digits, then letters and digits only. "INV-2026-0150", "inv 2026 150" and "Inv.2026.00150" give the same
 * key; the exact invoice_hash cannot catch such reformatting (nor an amount that differs by 0.01).
 */
export function invoiceNumberKey(invoiceNumber: string): string {
  return invoiceNumber
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<![\p{N}])0+(?=[\p{N}])/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** vendor + invoice-number key (empty when the number has no letters or digits). */
export function duplicateKey(vendorAccount: string, invoiceNumber: string): string {
  const k = invoiceNumberKey(invoiceNumber);
  return k ? `${normalizeAccount(vendorAccount) ?? ''}|${k}` : '';
}

/** 64 lowercase hex chars: the only shape the treasury accepts as an invoice hash. */
export const isInvoiceHash = (h: string): boolean => /^[0-9a-f]{64}$/.test(h);

/** sha256 hex of the canonical string. This is the `invoice_hash` sent to the treasury. */
export function invoiceHash(vendorAccount: string, invoiceNumber: string, amountBaseUnits: bigint, currency: string): string {
  return createHash('sha256').update(canonicalInvoiceString(vendorAccount, invoiceNumber, amountBaseUnits, currency), 'utf8').digest('hex');
}
