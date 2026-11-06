import { formatAmount } from './normalize.ts';
import type { NormalizedInvoice } from './types.ts';

export const CRITICAL_FIELDS = ['vendor_account', 'invoice_number', 'amount_base_units', 'currency', 'due_date'] as const;
export type CriticalField = (typeof CRITICAL_FIELDS)[number];

const LABEL: Record<CriticalField, string> = {
  vendor_account: 'vendor NEAR account',
  invoice_number: 'invoice number',
  amount_base_units: 'total',
  currency: 'currency',
  due_date: 'due date',
};

export interface Mismatch {
  field: CriticalField;
  a: string;
  b: string;
}

export interface Comparison {
  agree: boolean;
  mismatches: Mismatch[];
  reasons: string[];
  /** Reading used for the checks: reader A's, with both readers' payment text merged so nothing is dropped. */
  agreed: NormalizedInvoice | null;
}

function show(field: CriticalField, inv: NormalizedInvoice): string {
  const v = inv[field];
  if (field === 'amount_base_units') return v == null ? 'unreadable' : formatAmount(v as bigint);
  return v == null || v === '' ? 'missing' : String(v);
}

/**
 * Compare the two normalized readings on the critical fields. A field that one reader could not read
 * (null/unparseable) while the other could counts as a mismatch; both null counts as agreement (the
 * checks decide what a missing value means).
 */
export function compareReadings(a: NormalizedInvoice | null, b: NormalizedInvoice | null): Comparison {
  if (!a || !b) {
    const which = !a && !b ? 'both readers' : !a ? 'reader A' : 'reader B';
    return { agree: false, mismatches: [], reasons: [`${which} returned no usable reading`], agreed: a ?? b };
  }
  const mismatches: Mismatch[] = [];
  for (const field of CRITICAL_FIELDS) {
    if (a[field] !== b[field]) mismatches.push({ field, a: show(field, a), b: show(field, b) });
  }
  const reasons = mismatches.map((m) => `readers disagree on ${LABEL[m.field]}: A=${m.a}, B=${m.b}`);
  return { agree: mismatches.length === 0, mismatches, reasons, agreed: { ...a, payment_instructions_text: mergeText(a.payment_instructions_text, b.payment_instructions_text) } };
}

function mergeText(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b || a === b) return a;
  return `${a}\n---\n${b}`;
}
