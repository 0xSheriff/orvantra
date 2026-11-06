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

/** sha256 hex of the canonical string. This is the `invoice_hash` sent to the treasury. */
export function invoiceHash(vendorAccount: string, invoiceNumber: string, amountBaseUnits: bigint, currency: string): string {
  return createHash('sha256').update(canonicalInvoiceString(vendorAccount, invoiceNumber, amountBaseUnits, currency), 'utf8').digest('hex');
}
