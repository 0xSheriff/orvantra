// Pure decision logic: no network, no clock (time is an input). Fully unit-tested in test/checks.test.ts.
import { duplicateKey, invoiceHash } from './hash.ts';
import { oneLine, vendorNamesMatch } from './names.ts';
import type { Payment, Payout, TreasuryConfig, VendorPolicy, VendorView } from './near.ts';
import { formatAmount, isValidNearAccount } from './normalize.ts';
import type { NormalizedInvoice } from './types.ts';
import type { IssueKind } from './verdict.ts';

export type Action = 'propose' | 'hold' | 'reject';

export interface ReaderVerification {
  reader: string;
  verified: boolean;
  detail: string;
  /** True when the answer was signed inside the model's own TEE (signature kind provider_tee). Default: unknown = true. */
  tee?: boolean;
  /** Why end-to-end encryption failed and the request was sent without it (null/absent = E2EE was used or not requested). */
  e2eeFallbackReason?: string | null;
}

/** An earlier invoice the agent knows about (ledger) that could be the same invoice under another hash. */
export interface DuplicateCandidate {
  invoice_hash: string;
  vendor: string | null;
  invoice_number: string | null;
  /** Human status, e.g. "Paid", "Pending", "analyzed:hold". */
  status: string;
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
  /** Ledger entries for the secondary duplicate guard (same vendor + invoice number, any hash). */
  ledgerCandidates?: DuplicateCandidate[];
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
  /** What kind of problem this is. Set by the check itself, so nothing downstream has to guess it from text that may contain invoice content. */
  kind?: IssueKind;
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
  /\b0x[0-9a-fA-F]{40}\b/gi, // EVM (any case of "0x")
  /\b(?:[a-z0-9_-]+\.)+(?:near|testnet)\b/gi, // NEAR named accounts
  /\b[0-9a-fA-F]{64}\b/g, // NEAR implicit accounts
  /\bbc1[a-z0-9]{20,}\b/gi, // bech32 BTC
  /\b(?=[1-9A-HJ-NP-Za-km-z]*\d)[1-9A-HJ-NP-Za-km-z]{25,44}\b/g, // base58 (Solana, BTC, Tron)
];
const BANK_PATTERN = /\b(iban|swift|bic|routing|sort code|account (?:no|number)|bank)\b|\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/i;

/**
 * Undo the tricks that hide an address from a plain regex: compatibility forms (full-width letters), zero-width and
 * soft-hyphen characters, spaces inside a run of 40 (after 0x) or 64 hex digits, and "(dot) near" / " dot near".
 */
export function canonicalPaymentText(text: string): string {
  let t = text.normalize('NFKC').replace(/[​-‏⁠-⁤­﻿‪-‮]/g, '');
  t = t.replace(/0x(?:[\s_-]*[0-9a-fA-F]){40}/gi, (m) => m.replace(/[\s_-]/g, ''));
  t = t.replace(/(?<![0-9a-zA-Z])(?:[0-9a-fA-F][\s_-]*){64}(?![0-9a-zA-Z])/g, (m) => m.replace(/[\s_-]/g, ''));
  t = t.replace(/\s*[[(<{]\s*dot\s*[\])>}]\s*/gi, '.').replace(/\s+dot\s+(?=(?:near|testnet)\b)/gi, '.');
  return t;
}

/** Find payout addresses and bank details mentioned in the invoice's payment text. */
export function findPayoutMentions(text: string | null): PayoutMentions {
  if (!text) return { addresses: [], bankDetails: false };
  text = canonicalPaymentText(text);
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
  const reject = (message: string, kind: IssueKind) => findings.push({ level: 'reject', message, kind });
  const hold = (message: string, kind: IssueKind) => findings.push({ level: 'hold', message, kind });

  const inv = input.invoice;
  const reg = input.registry;
  const amount = inv?.amount_base_units ?? null;

  // Readers and verification. (Reader messages come from compare.ts; kinds by text are fine there: no invoice text in them.)
  for (const r of input.agreement.reasons) hold(r, r.startsWith('readers disagree') ? 'disagree' : /returned no usable reading$/.test(r) ? 'disagree' : 'other');
  for (const v of input.verification) {
    if (!v.verified) hold(`verification unavailable for ${v.reader}: ${v.detail}`, 'unverified');
    if (v.e2eeFallbackReason) hold(`end-to-end encryption failed for ${v.reader}, so the invoice was sent without it (${oneLine(v.e2eeFallbackReason, 120)})`, 'plaintext');
    if (v.verified && v.tee === false) notes.push(`${v.reader}: the answer is signed by NEAR AI's gateway, not inside the model's own secure hardware`);
  }

  if (input.chainError) {
    hold(`could not read NEAR state: ${input.chainError}`, 'chain');
    return finish(input, findings, notes, predictions, null);
  }
  if (!inv) {
    return finish(input, findings, notes, predictions, null);
  }

  // Identity.
  const account = inv.vendor_account;
  if (!account) {
    reject('no vendor NEAR account on the invoice', 'no-account');
  } else if (!isValidNearAccount(account)) {
    reject(`vendor NEAR account "${account}" is not a valid NEAR account id`, 'no-account');
  } else {
    if (!reg) reject(`vendor ${account} is not in the vendor registry`, 'unregistered');
    if (!input.vendorPolicy) reject(`vendor ${account} is not approved in the treasury policy`, 'unapproved');
    // The registry decides who is paid, so the invoice must at least name that business (A-H1).
    if (reg && !vendorNamesMatch(inv.vendor_name, reg.display_name)) {
      hold(`invoice says ${oneLine(inv.vendor_name) || '(no name)'}, but ${account} is registered as ${oneLine(reg.display_name)}`, 'name-mismatch');
    }
  }

  // What kind of document is it? (credit notes and receipts are never paid)
  if (inv.document_type == null) hold('document type could not be read (invoice, credit note, receipt?)', 'unreadable');
  else if (inv.document_type !== 'invoice') {
    reject(`document is ${inv.document_type === 'credit_note' ? 'a credit note' : inv.document_type === 'receipt' ? 'a receipt' : 'not an invoice'}, not a request for payment`, 'not-invoice');
  }

  // Currency and amount.
  if (!ACCEPTED_CURRENCIES.has(inv.currency)) reject(`currency "${inv.currency || 'missing'}" is not USDC/USD`, 'currency');
  if (amount == null) hold('total could not be read as an amount', 'unreadable');
  else if (amount <= 0n) {
    if (inv.document_type !== 'credit_note') reject(`total ${formatAmount(amount)} is not positive`, 'amount');
  } else if (input.vendorPolicy && amount > BigInt(input.vendorPolicy.max_per_invoice)) {
    reject(`amount ${usd(amount)} is above the vendor max_per_invoice ${usd(input.vendorPolicy.max_per_invoice)}`, 'over-max');
  }

  // Duplicates.
  const hash = account && amount != null && amount > 0n && inv.invoice_number ? invoiceHash(account, inv.invoice_number, amount, inv.currency) : null;
  if (!inv.invoice_number) hold('invoice number missing', 'unreadable');
  if (input.invoiceUsed) reject('invoice_hash already used in the treasury (duplicate invoice)', 'duplicate');
  if (input.duplicateOf) reject(`duplicate of ${input.duplicateOf} (same invoice_hash)`, 'duplicate');
  // Same vendor + invoice number under another hash (reformatted number, amount off by a cent): hold, whatever the amount (A-M1).
  const dupKey = account && inv.invoice_number ? duplicateKey(account, inv.invoice_number) : '';
  if (dupKey && !input.invoiceUsed && !input.duplicateOf) {
    const onChain = input.payments.find((p) => p.memo && p.invoice_hash !== hash && duplicateKey(p.vendor, p.memo) === dupKey);
    const earlier = onChain
      ? { number: onChain.memo as string, status: onChain.status as string }
      : (() => {
        const l = input.ledgerCandidates?.find((c) => c.vendor && c.invoice_number && c.invoice_hash !== hash && duplicateKey(c.vendor, c.invoice_number) === dupKey);
        return l ? { number: l.invoice_number as string, status: l.status } : null;
      })();
    if (earlier) hold(`possible duplicate of ${oneLine(earlier.number, 40)} (${earlier.status})`, 'possible-duplicate');
  }

  // Payment instructions on the invoice vs the registry.
  const mentions = findPayoutMentions(inv.payment_instructions_text);
  const allowed = [reg?.payout.address, account, reg?.account_id].filter((x): x is string => !!x);
  const foreign = mentions.addresses.filter((a) => !allowed.some((b) => sameAddress(a, b)));
  if (foreign.length) hold(`${REDIRECT_MESSAGE} (invoice says: ${foreign.join(', ')})`, 'redirect');
  if (mentions.bankDetails) hold('invoice contains bank/payment details — ignored; registry is the source of truth', 'bank');
  // A blanked-out payment text AND no line items would suppress every warning above: a person must look (A-M3).
  if (inv.payment_instructions_text == null && inv.line_items.length === 0) {
    hold('invoice has no payment text and no line items, so there was nothing to check it against', 'sparse');
  }

  // Line items vs total.
  if (inv.line_items.length > 0 && amount != null) {
    if (inv.line_items.some((li) => li.amount_base_units == null)) {
      hold('a line item amount could not be read', 'lines');
    } else {
      const sum = inv.line_items.reduce((s, li) => s + (li.amount_base_units as bigint), 0n);
      if (sum !== amount) hold(`line items sum to ${usd(sum)} but the total is ${usd(amount)}`, 'lines');
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
    hold(`amount ${usd(amount)} is more than 3x this vendor's median paid amount ${usd(med)}`, 'unusual');
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
    const crossChain = !!reg && !(reg.payout.chain === 'near' && reg.payout.asset_id === `nep141:${cfg.token}`);
    if (crossChain && amount > BigInt(cfg.cross_chain_auto_pay_threshold ?? '0')) {
      predictions.push('will be held by contract: cross-chain payout, you confirm the 1Click deposit address');
    }
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
