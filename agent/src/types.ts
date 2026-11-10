import type { Boxes } from './boxes.ts';

export type DocumentType = 'invoice' | 'credit_note' | 'receipt' | 'other';
export const DOCUMENT_TYPES: readonly DocumentType[] = ['invoice', 'credit_note', 'receipt', 'other'];

/** What one reader (model) returns, exactly as the strict JSON schema defines it. */
export interface Extraction {
  /** What kind of document this is; anything but "invoice" is never paid. Missing = the reader did not say. */
  document_type?: string;
  /** Reader A only: normalized boxes of key regions on page 1 (UI overlays only, never used for decisions). */
  boxes?: Boxes | null;
  vendor_name: string;
  vendor_near_account: string | null;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  currency: string;
  total: string;
  line_items: { description: string; amount: string }[];
  payment_instructions_text: string | null;
}

/** An extraction after normalization. Amounts are integer base units (6 decimals). */
export interface NormalizedInvoice {
  /** null = the reader did not say (held). Credit-note signals in the printed text override "invoice". */
  document_type: DocumentType | null;
  vendor_name: string;
  vendor_account: string | null;
  invoice_number: string;
  issue_date: string | null;
  due_date: string | null;
  currency: string;
  amount_base_units: bigint | null;
  line_items: { description: string; amount_base_units: bigint | null }[];
  payment_instructions_text: string | null;
}
