/** What one reader (model) returns, exactly as the strict JSON schema defines it. */
export interface Extraction {
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
