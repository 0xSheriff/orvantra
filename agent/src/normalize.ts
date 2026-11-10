import { DOCUMENT_TYPES, type DocumentType, type Extraction, type NormalizedInvoice } from './types.ts';

export const DECIMALS = 6;

/** Characters that mean "minus" on a printed document (Unicode minus, dashes). */
const MINUS_CHARS = /[\u2212\u2012\u2013\u2014\u2010\u2011\uFE63\uFF0D]/g;
const CREDIT_WORDS = /\b(credit|refund(?:ed)?)\b/i;

/**
 * Parse a printed money amount into integer base units (default 6 decimals).
 * Accepts "1,200.00", "$1200", "USDC 120.5", "1.200,00", "1 200,00", "-5.00".
 * Credit-note notations are NEGATIVE (so the checks reject them): a Unicode minus or dash, "(120.00)", a trailing
 * minus "120.00-", "120.00 CR", and the words credit / credit note / refund.
 * Separator rules:
 *  - both "," and "." present: the one that appears last is the decimal separator;
 *  - only one kind, appearing several times: thousands separators;
 *  - a single ",": decimal if followed by 1-2 digits ("12,50"), thousands if followed by 3 ("1,200");
 *  - a single ".": decimal, except the ambiguous "1.200" shape (1-3 digits not starting with 0, a dot, exactly 3
 *    digits: European thousands or US decimals?), which returns null so a person looks at it.
 * Returns null when the text is not a clean number or has more fractional digits than `decimals`.
 */
export function parseAmount(text: string | null | undefined, decimals = DECIMALS): bigint | null {
  if (text == null) return null;
  const raw = text.normalize('NFKC');
  let negative = CREDIT_WORDS.test(raw) || /(^|[\d\s])CR\.?\s*$/i.test(raw) || /\([^()]*\d[^()]*\)/.test(raw);
  let s = raw.replace(/[\s\u00A0\u202F'\u200B-\u200F\u2060\uFEFF()]/g, '').replace(MINUS_CHARS, '-');
  // Strip currency words/symbols at either end; a leading or trailing minus marks a negative amount.
  s = s.replace(/^[^\d.,\-]+/, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).replace(/^[^\d.,]+/, '');
  }
  const tail = s.match(/[^\d.,]+$/);
  if (tail?.[0].includes('-')) negative = true;
  s = s.replace(/[^\d.,]+$/, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep: ',' | '.' | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSep = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0) {
    const count = s.split(',').length - 1;
    const after = s.length - lastComma - 1;
    decimalSep = count === 1 && after >= 1 && after <= 2 ? ',' : null;
  } else if (lastDot >= 0) {
    const count = s.split('.').length - 1;
    decimalSep = count === 1 ? '.' : null;
    if (count === 1 && /^[1-9]\d{0,2}\.\d{3}$/.test(s)) return null; // "1.200": ambiguous
  }

  let intPart = s;
  let fracPart = '';
  if (decimalSep) {
    const i = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, i);
    fracPart = s.slice(i + 1);
  }
  const thousandsSep = decimalSep === ',' ? '.' : decimalSep === '.' ? ',' : s.includes(',') ? ',' : '.';
  if (intPart.includes(decimalSep ?? '\0')) return null;
  // Thousands groups must be well-formed: 1-3 digits, then groups of exactly 3.
  if (intPart.includes(thousandsSep)) {
    if (!new RegExp(`^\\d{1,3}(\\${thousandsSep}\\d{3})+$`).test(intPart)) return null;
    intPart = intPart.split(thousandsSep).join('');
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (intPart === '' && fracPart === '') return null;
  if (fracPart.length > decimals) {
    // Allow trailing zeros beyond the precision ("1.0000000"), reject real sub-unit amounts.
    if (/[^0]/.test(fracPart.slice(decimals))) return null;
    fracPart = fracPart.slice(0, decimals);
  }
  const units = BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(fracPart.padEnd(decimals, '0') || '0');
  return negative ? -units : units;
}

/** Format base units back to a decimal string, e.g. 120000000n -> "120.00". */
export function formatAmount(units: bigint | null, decimals = DECIMALS): string {
  if (units == null) return '—';
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${neg ? '-' : ''}${abs / base}.${frac}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Normalize a printed date to ISO "YYYY-MM-DD".
 * Accepts ISO (also with "/" or "."), "20 Nov 2026", "November 20, 2026", "Nov 20 2026",
 * and numeric D/M/Y or M/D/Y when unambiguous (one part > 12). Ambiguous or invalid -> null.
 */
export function normalizeDate(text: string | null | undefined): string | null {
  if (text == null) return null;
  const s = text.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:t.*)?$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[ -]([a-z]+)\.?[ -](\d{4})$/);
  if (m) return MONTHS[m[2].slice(0, 3)] ? iso(+m[3], MONTHS[m[2].slice(0, 3)], +m[1]) : null;
  m = s.match(/^([a-z]+)\.? (\d{1,2}) (\d{4})$/);
  if (m) return MONTHS[m[1].slice(0, 3)] ? iso(+m[3], MONTHS[m[1].slice(0, 3)], +m[2]) : null;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) return iso(+m[3], b, a); // D/M/Y
    if (b > 12 && a <= 12) return iso(+m[3], a, b); // M/D/Y
    if (a === b) return iso(+m[3], a, b);
    return null; // ambiguous
  }
  return null;
}

/** NEAR account id: trimmed, lowercase, without a leading "@". Empty -> null. */
export function normalizeAccount(text: string | null | undefined): string | null {
  if (text == null) return null;
  const s = text.trim().toLowerCase().replace(/^@/, '').replace(/[.,;:]+$/, '');
  return s === '' || s === 'null' || s === 'none' ? null : s;
}

/** NEAR account id rules (2..64 chars, lowercase alphanumerics separated by single "-", "_" or "."). */
export function isValidNearAccount(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true; // implicit account
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

/** Currency code: "$", "US$", "usd" -> "USD"; "usd coin" -> "USDC"; otherwise uppercased. */
export function normalizeCurrency(text: string | null | undefined): string {
  const s = (text ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (s === '$' || s === 'US$' || s === 'US DOLLAR' || s === 'US DOLLARS' || s === 'DOLLARS') return 'USD';
  if (s === 'USD COIN' || s === 'USDC.E') return 'USDC';
  return s;
}

/** Invoice number: trimmed, uppercased, inner whitespace removed, leading "#"/"No." dropped. */
export function normalizeInvoiceNumber(text: string | null | undefined): string {
  return (text ?? '')
    .trim()
    .toUpperCase()
    .replace(/^(INVOICE\s*)?(NO\.?|NUMBER|#)\s*:?\s*/, '')
    .replace(/\s+/g, '');
}

const CREDIT_NOTE_TEXT = /credit|refund/i;

/**
 * The reader's document_type, with credit-note signals overriding "invoice" (or a missing type): credit / refund
 * words in the invoice number or total, or a negative total. null = the reader did not say what this is.
 */
export function documentTypeOf(e: Extraction, amount: bigint | null): DocumentType | null {
  const t = (e.document_type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const declared: DocumentType | null = (DOCUMENT_TYPES as readonly string[]).includes(t) ? (t as DocumentType) : t ? 'other' : null;
  const creditSignal = CREDIT_NOTE_TEXT.test(e.invoice_number.normalize('NFKC')) || CREDIT_NOTE_TEXT.test(e.total.normalize('NFKC')) || (amount != null && amount < 0n);
  return creditSignal && (declared === 'invoice' || declared === null) ? 'credit_note' : declared;
}

export function normalizeExtraction(e: Extraction): NormalizedInvoice {
  const text = e.payment_instructions_text?.trim();
  const amount = parseAmount(e.total);
  return {
    document_type: documentTypeOf(e, amount),
    vendor_name: e.vendor_name.trim(),
    vendor_account: normalizeAccount(e.vendor_near_account),
    invoice_number: normalizeInvoiceNumber(e.invoice_number),
    issue_date: normalizeDate(e.issue_date),
    due_date: normalizeDate(e.due_date),
    currency: normalizeCurrency(e.currency),
    amount_base_units: amount,
    line_items: e.line_items.map((li) => ({
      description: li.description.trim(),
      amount_base_units: parseAmount(li.amount),
    })),
    payment_instructions_text: text ? text : null,
  };
}
