// Pure decision logic: no network, no clock (time is an input). Fully unit-tested in test/checks.test.ts.
import { invoiceHash } from './hash.ts';
import type { Payment, Payout, TreasuryConfig, VendorPolicy, VendorView } from './near.ts';
import { formatAmount, isValidNearAccount } from './normalize.ts';
import type { NormalizedInvoice } from './types.ts';

export type Action = 'propose' | 'hold' | 'reject';

export interface ReaderVerification {
  reader: string;
  verified: boolean;
  detail: string;
}

export interface CheckInput {
  /** The agreed reading (reader A's when the readers disagree). null = nothing readable. */
  invoice: NormalizedInvoice | null;
  agreement: { agree: boolean; reasons: string[] };
  verification: ReaderVerification[];
  /** Registry entry for invoice.vendor_account (null = not registered). */
  registry: VendorView | null;
  /** Treasury policy for the vendor (null = not approved by the owner). */
  vendorPolicy: VendorPolicy | null;
  config: TreasuryConfig | null;
  /** Registry `payout_age_ns` for the vendor. */
  payoutAgeNs: string | null;
  /** treasury.is_invoice_used(invoice_hash). */
  invoiceUsed: boolean;
  /** Earlier invoice in the same batch with the same hash (agent-side duplicate guard), if any. */
  duplicateOf?: string | null;
  /** All treasury payments (filtered to this vendor inside). */
  payments: Payment[];
  /** treasury.monthly_spent(vendor) and monthly_spent(null), base units. */
  vendorMonthlySpent?: string | null;
  totalMonthlySpent?: string | null;
  /** Set when the NEAR views could not be read: the decision becomes hold, chain-based checks are skipped. */
  chainError?: string | null;
  now: Date;
}

export interface Finding {
  level: 'reject' | 'hold';
  message: string;
}

export interface Decision {
  action: Action;
  /** Why the action is not "propose" (rejects first, then holds). Empty for propose. */
  reasons: string[];
  findings: Finding[];
  /** Informational, never changes the action. */
  notes: string[];
  /** What the treasury contract is expected to do with a proposal (it enforces these itself). */
  contract_predictions: string[];
  invoice_hash: string | null;
  amount_base_units: string | null;
  /** Where money would go: ALWAYS from the registry, never from the invoice. */
  payout: (Payout & { version: number }) | null;
}

const ACCEPTED_CURRENCIES = new Set(['USDC', 'USD']);

export const REDIRECT_MESSAGE = 'invoice asks to pay a different address — ignored; registry is the source of truth';

// ------------------------------------------------------------------ payment-instruction scanning

export interface PayoutMentions {
  addresses: string[];
  bankDetails: boolean;
}

const ADDRESS_PATTERNS: RegExp[] = [
  /\b0x[0-9a-fA-F]{40}\b/g, // EVM
  /\b(?:[a-z0-9_-]+\.)+(?:near|testnet)\b/gi, // NEAR named accounts
  /\b[0-9a-f]{64}\b/g, // NEAR implicit accounts
  /\bbc1[a-z0-9]{20,}\b/gi, // bech32 BTC
  /\b(?=[1-9A-HJ-NP-Za-km-z]*\d)[1-9A-HJ-NP-Za-km-z]{25,44}\b/g, // base58 (Solana, BTC, Tron)
];
const BANK_PATTERN = /\b(iban|swift|bic|routing|sort code|account (?:no|number)|bank)\b|\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/i;

/** Find payout addresses and bank details mentioned in the invoice's payment text. */
export function findPayoutMentions(text: string | null): PayoutMentions {
  if (!text) return { addresses: [], bankDetails: false };
  const found = new Set<string>();
  for (const re of ADDRESS_PATTERNS) for (const m of text.matchAll(re)) found.add(m[0]);
  // Drop matches contained in a longer match (e.g. part of an address matched by a second pattern).
  const addresses = [...found].filter((a) => ![...found].some((b) => b !== a && b.includes(a)));
  return { addresses, bankDetails: BANK_PATTERN.test(text) };
}

function sameAddress(a: string, b: string): boolean {
  // EVM and NEAR addresses are case-insensitive; base58 is not, but a case-only change is still suspicious.
  return a.toLowerCase() === b.toLowerCase();
}

// ------------------------------------------------------------------ helpers

export function median(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}

const usd = (units: bigint | string) => `${formatAmount(BigInt(units))} USDC`;

// ------------------------------------------------------------------ the decision

export function decide(input: CheckInput): Decision {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const predictions: string[] = [];
  const reject = (message: string) => findings.push({ level: 'reject', message });
  const hold = (message: string) => findings.push({ level: 'hold', message });

  const inv = input.invoice;
  const reg = input.registry;
  const amount = inv?.amount_base_units ?? null;

  // Readers and verification.
  for (const r of input.agreement.reasons) hold(r);
  for (const v of input.verification) {
    if (!v.verified) hold(`verification unavailable for ${v.reader}: ${v.detail}`);
  }

  if (input.chainError) {
    hold(`could not read NEAR state: ${input.chainError}`);
    return finish(input, findings, notes, predictions, null);
  }
  if (!inv) {
    return finish(input, findings, notes, predictions, null);
  }

  // Identity.
  const account = inv.vendor_account;
  if (!account) {
    reject('no vendor NEAR account on the invoice');
  } else if (!isValidNearAccount(account)) {
    reject(`vendor NEAR account "${account}" is not a valid NEAR account id`);
  } else {
    if (!reg) reject(`vendor ${account} is not in the vendor registry`);
    if (!input.vendorPolicy) reject(`vendor ${account} is not approved in the treasury policy`);
  }

  // Currency and amount.
  if (!ACCEPTED_CURRENCIES.has(inv.currency)) reject(`currency "${inv.currency || 'missing'}" is not USDC/USD`);
  if (amount == null) hold('total could not be read as an amount');
  else if (amount <= 0n) reject(`total ${formatAmount(amount)} is not positive`);
  else if (input.vendorPolicy && amount > BigInt(input.vendorPolicy.max_per_invoice)) {
    reject(`amount ${usd(amount)} is above the vendor max_per_invoice ${usd(input.vendorPolicy.max_per_invoice)}`);
  }

  // Duplicates.
  const hash = account && amount != null && amount > 0n && inv.invoice_number ? invoiceHash(account, inv.invoice_number, amount, inv.currency) : null;
  if (!inv.invoice_number) hold('invoice number missing');
  if (input.invoiceUsed) reject('invoice_hash already used in the treasury (duplicate invoice)');
  if (input.duplicateOf) reject(`duplicate of ${input.duplicateOf} (same invoice_hash)`);

  // Payment instructions on the invoice vs the registry.
  const mentions = findPayoutMentions(inv.payment_instructions_text);
  const allowed = [reg?.payout.address, account, reg?.account_id].filter((x): x is string => !!x);
  const foreign = mentions.addresses.filter((a) => !allowed.some((b) => sameAddress(a, b)));
  if (foreign.length) hold(`${REDIRECT_MESSAGE} (invoice says: ${foreign.join(', ')})`);
  if (mentions.bankDetails) hold('invoice contains bank/payment details — ignored; registry is the source of truth');

  // Line items vs total.
  if (inv.line_items.length > 0 && amount != null) {
    if (inv.line_items.some((li) => li.amount_base_units == null)) {
      hold('a line item amount could not be read');
    } else {
      const sum = inv.line_items.reduce((s, li) => s + (li.amount_base_units as bigint), 0n);
      if (sum !== amount) hold(`line items sum to ${usd(sum)} but the total is ${usd(amount)}`);
    }
  } else if (inv.line_items.length === 0) {
    notes.push('no line items on the invoice');
  }

  // Amount vs history.
  const vendorPayments = account ? input.payments.filter((p) => p.vendor === account) : [];
  const paid = vendorPayments.filter((p) => p.status === 'Paid').map((p) => BigInt(p.amount));
  const med = median(paid);
  if (med == null) notes.push('no paid history for this vendor — median check skipped');
  else if (amount != null && amount > 3n * med) {
    hold(`amount ${usd(amount)} is more than 3x this vendor's median paid amount ${usd(med)}`);
  }

  // Dates (note only).
  const today = input.now.toISOString().slice(0, 10);
  if (!inv.due_date) notes.push('due date missing or unreadable');
  else if (inv.due_date < today) notes.push(`due date ${inv.due_date} already passed`);

  // What the contract itself will do with a proposal.
  if (input.config && amount != null && amount > 0n) {
    const cfg = input.config;
    if (cfg.paused) predictions.push('treasury is paused — contract would reject the proposal');
    if (amount > BigInt(cfg.auto_pay_threshold)) {
      predictions.push(`will be held by contract: amount above auto-pay threshold ${usd(cfg.auto_pay_threshold)}`);
    }
    if (input.payoutAgeNs != null && BigInt(input.payoutAgeNs) < BigInt(cfg.min_payout_age_sec) * 1_000_000_000n) {
      predictions.push(`will be held by contract: payout changed less than ${cfg.min_payout_age_sec}s ago`);
    }
    if (account && reg && paid.length === 0) predictions.push('will be held by contract: first payment to this vendor');
    if (input.vendorPolicy && input.vendorMonthlySpent != null) {
      const after = BigInt(input.vendorMonthlySpent) + amount;
      if (after > BigInt(input.vendorPolicy.monthly_cap)) {
        predictions.push(`contract would reject: vendor monthly cap ${usd(input.vendorPolicy.monthly_cap)} (already committed ${usd(input.vendorMonthlySpent)})`);
      }
    }
    if (input.totalMonthlySpent != null && BigInt(input.totalMonthlySpent) + amount > BigInt(cfg.monthly_cap)) {
      predictions.push(`contract would reject: treasury monthly cap ${usd(cfg.monthly_cap)}`);
    }
    if (reg && predictions.length === 0) {
      const direct = reg.payout.chain === 'near' && reg.payout.asset_id === `nep141:${cfg.token}`;
      predictions.push(direct ? `contract would pay immediately, direct to ${reg.payout.address} on NEAR` : 'contract would pay immediately via a 1Click deposit address');
    }
  }

  return finish(input, findings, notes, predictions, hash);
}

function finish(input: CheckInput, findings: Finding[], notes: string[], predictions: string[], hash: string | null): Decision {
  const ordered = [...findings.filter((f) => f.level === 'reject'), ...findings.filter((f) => f.level === 'hold')];
  const action: Action = ordered.some((f) => f.level === 'reject') ? 'reject' : ordered.length ? 'hold' : 'propose';
  const amount = input.invoice?.amount_base_units;
  const reg = input.registry;
  return {
    action,
    reasons: ordered.map((f) => f.message),
    findings: ordered,
    notes,
    contract_predictions: action === 'reject' ? [] : predictions,
    invoice_hash: hash,
    amount_base_units: amount == null ? null : amount.toString(),
    payout: reg ? { ...reg.payout, version: reg.version } : null,
  };
}
