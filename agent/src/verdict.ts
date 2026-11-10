// Deterministic plain-English verdict + numbered findings. No LLM, no I/O.
// Shared by the web review screen (web/lib/verdict.ts re-exports it) and the Telegram alerts (src/notify/), so both
// say exactly the same thing about a payment.
// Inputs are the agent's findings (agent/src/checks.ts messages) and the treasury's on-chain reasons
// (contracts/treasury/src/policy.rs strings, "agent: …" flags, "owner: …" rejections).
import type { BoxField } from './boxes.ts';
import { cap, fmtAmount, fmtDuration, shortAddr, chainLabel } from './format.ts';

export type IssueKind =
  | 'duplicate' | 'unregistered' | 'unapproved' | 'no-account' | 'over-max' | 'currency' | 'amount'
  | 'redirect' | 'bank' | 'disagree' | 'unverified' | 'unreadable' | 'lines' | 'unusual'
  | 'name-mismatch' | 'not-invoice' | 'possible-duplicate' | 'sparse' | 'plaintext'
  | 'payout-changed' | 'fresh-payout' | 'first-payment' | 'threshold' | 'cross-chain' | 'chain'
  | 'owner-rejected' | 'transfer-failed' | 'other';

/** Most important first: this order picks the headline and the one-line outcome. */
export const PRIORITY: IssueKind[] = [
  'duplicate', 'not-invoice', 'unregistered', 'unapproved', 'no-account', 'name-mismatch', 'over-max', 'currency', 'amount',
  'redirect', 'bank', 'possible-duplicate', 'disagree', 'unverified', 'plaintext', 'unreadable', 'sparse', 'lines', 'unusual',
  'payout-changed', 'fresh-payout', 'first-payment', 'threshold', 'cross-chain', 'chain', 'owner-rejected',
  'transfer-failed', 'other',
];

export interface Issue {
  kind: IssueKind;
  /** The original message (agent finding or contract reason, without the "agent: " prefix). */
  raw: string;
}

/**
 * Classify one on-chain reason ("agent: ..." flag or contract reason) or a stored agent message.
 *
 * Only the FIXED START of a message is looked at, never the middle: agent messages can contain text from the invoice
 * (vendor name, addresses, file names) after their fixed opening, and an invoice must not be able to steer the
 * classification by what it says. Findings the agent produced in this process carry their own kind instead (see
 * Finding.kind in checks.ts) and are not classified from text at all.
 */
export function classify(message: string): Issue {
  let raw = message.trim();
  if (raw.startsWith('agent: ')) raw = raw.slice(7);
  const m = raw;
  const kind: IssueKind =
    m.startsWith('owner:') ? 'owner-rejected'
      : m.startsWith('invoice_hash already used') || m.startsWith('duplicate of ') ? 'duplicate'
      : m.startsWith('possible duplicate of ') ? 'possible-duplicate'
      : /^vendor \S+ is not in the vendor registry/.test(m) || m === 'not in registry' ? 'unregistered'
      : /^vendor \S+ is not approved in the treasury policy/.test(m) || m === 'vendor no longer approved (policy removed)' ? 'unapproved'
      : m.startsWith('no vendor NEAR account') || m.startsWith('vendor NEAR account "') ? 'no-account'
      : /^invoice says .*, but \S+ is registered as /s.test(m) ? 'name-mismatch'
      : /^amount [\d.,]+ USDC is above the vendor max_per_invoice /.test(m) ? 'over-max'
      : m.startsWith('currency "') ? 'currency'
      : /^total -?[\d.,]+ is not positive/.test(m) ? 'amount'
      : m.startsWith('document is ') ? 'not-invoice'
      : m.startsWith('invoice asks to pay a different address') ? 'redirect'
      : m.startsWith('invoice contains bank') ? 'bank'
      : m.startsWith('readers disagree on ') || /^(reader A|reader B|both readers) returned no usable reading/.test(m) ? 'disagree'
      : m.startsWith('verification unavailable for ') ? 'unverified'
      : m.startsWith('end-to-end encryption failed') ? 'plaintext'
      : m.startsWith('total could not be read') || m.startsWith('invoice number missing') || m.startsWith('document type could not be read') ? 'unreadable'
      : m.startsWith('invoice has no payment text and no line items') ? 'sparse'
      : m.startsWith('line items sum to ') || m.startsWith('a line item amount') ? 'lines'
      : /^amount [\d.,]+ USDC is more than 3x this vendor's median paid amount/.test(m) ? 'unusual'
      : m === 'payout changed since agent checked' ? 'payout-changed'
      : m === 'payout changed recently' ? 'fresh-payout'
      : m === 'first payment to this vendor' ? 'first-payment'
      : m === 'amount above auto-pay threshold' ? 'threshold'
      : m.startsWith('cross-chain payout: owner confirms') ? 'cross-chain'
      : m.startsWith('could not read NEAR state') || m === 'registry call failed' ? 'chain'
      : m === 'ft_transfer failed' || m === 'storage_deposit failed' ? 'transfer-failed'
      : 'other';
  return { kind, raw };
}

/** A message to classify from its text, or an issue whose kind is already known. */
export type IssueInput = string | Issue;
const toIssue = (x: IssueInput): Issue => (typeof x === 'string' ? classify(x) : { kind: x.kind, raw: x.raw.trim().replace(/^agent: /, '') });

/** All issues, deduplicated by kind (first message wins), most important first. */
export function rankIssues(messages: IssueInput[]): Issue[] {
  const seen = new Map<string, Issue>();
  for (const msg of messages) {
    const i = toIssue(msg);
    const key = i.kind === 'other' ? `other:${i.raw}` : i.kind;
    if (!seen.has(key)) seen.set(key, i);
  }
  return [...seen.values()].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

/** Short phrase for the invoice list: "Held — <phrase>". */
export function shortPhrase(issue: Issue, ctx: { threshold?: string | null } = {}): string {
  switch (issue.kind) {
    case 'duplicate': return 'duplicate invoice';
    case 'unregistered': return 'not a registered vendor';
    case 'unapproved': return 'vendor not approved';
    case 'no-account': return 'no NEAR account on the invoice';
    case 'over-max': return 'above the vendor limit';
    case 'currency': return 'not billed in USDC';
    case 'amount': return 'amount is not positive';
    case 'redirect': return 'asks to pay a different address';
    case 'bank': return 'includes its own bank details';
    case 'disagree': return 'the two readers disagree';
    case 'unverified': return 'a reading could not be verified';
    case 'unreadable': return 'part of it could not be read';
    case 'lines': return "lines don't add up to the total";
    case 'unusual': return 'unusually large for this vendor';
    case 'payout-changed': return 'payout changed before approval';
    case 'fresh-payout': return 'payout changed recently';
    case 'first-payment': return 'first payment to this vendor';
    case 'threshold': return ctx.threshold ? `above your ${fmtAmount(ctx.threshold, { whole: true })} limit` : 'above your automatic limit';
    case 'name-mismatch': return 'name differs from the registry';
    case 'not-invoice': return 'not an invoice';
    case 'possible-duplicate': return 'possible duplicate';
    case 'sparse': return 'nothing to check it against';
    case 'plaintext': return 'a reading was not encrypted';
    case 'cross-chain': return 'you confirm the deposit address';
    case 'chain': return 'treasury could not be read';
    case 'owner-rejected': return 'rejected by you';
    case 'transfer-failed': return 'transfer failed';
    default: return issue.raw;
  }
}

// ------------------------------------------------------------------ the review

export type ReviewState = 'pending' | 'paying' | 'paid' | 'rejected' | 'failed' | 'stopped' | 'not-sent';

export interface ReviewFacts {
  state: ReviewState;
  approvedByOwner: boolean;
  vendorName: string;
  vendorAccount: string | null;
  amount: string | null;
  unit: string;
  invoiceNumber: string | null;
  /** null = unknown (no data). */
  registered: boolean | null;
  approved: boolean | null;
  maxPerInvoice: string | null;
  /** null when the agent's readings are not available (e.g. a payment proposed outside the web app). */
  readers: { count: number; answered: number; verified: number; agree: boolean; /** signed inside the model's TEE; undefined = not recorded (older records) */ tee?: number } | null;
  /** The agent's findings (reject + hold) in its own words; pass {kind, raw} for findings that carry a kind. */
  agentFindings: IssueInput[];
  /** The treasury's reasons for this payment (contract holds, agent flags, owner/failed reasons). */
  contractReasons: string[];
  payout: { address: string; chain: string } | null;
  autoPayThreshold: string | null;
  minPayoutAgeSec: number | null;
}

export interface Segment {
  text: string;
  mono?: boolean;
  strike?: boolean;
}

export interface ReviewItem {
  n: number;
  ok: boolean;
  kind: IssueKind | 'vendor' | 'readers';
  title: string;
  detail: Segment[];
  /** Region of the invoice this finding points at (pin placement), if any. */
  anchor: BoxField | null;
}

export type Tone = 'held' | 'paying' | 'paid' | 'stopped';

export interface Verdict {
  tone: Tone;
  /** Small label above the headline ("Held for you"). */
  label: string;
  headline: string;
  body: string;
  items: ReviewItem[];
  /** Outline colour per invoice region: green = verified, red = a finding points here. */
  outlines: Partial<Record<BoxField, 'ok' | 'bad'>>;
  /** One line for the invoice list. */
  outcome: string;
}

const t = (text: string): Segment => ({ text });
const mono = (text: string, strike = false): Segment => ({ text, mono: true, ...(strike ? { strike: true } : {}) });

const ANCHOR: Partial<Record<IssueKind, BoxField>> = {
  duplicate: 'invoice_number', unregistered: 'vendor', unapproved: 'vendor', 'no-account': 'vendor', 'over-max': 'total',
  'name-mismatch': 'vendor', 'not-invoice': 'total', 'possible-duplicate': 'invoice_number', sparse: 'payment_instructions',
  currency: 'total', amount: 'total', redirect: 'payment_instructions', bank: 'payment_instructions', unreadable: 'total',
  lines: 'total', unusual: 'total', 'payout-changed': 'vendor', 'fresh-payout': 'vendor', threshold: 'total',
  // 'first-payment' is a standing policy hold, not something wrong on the invoice: no region, no pin.
};

/** "(invoice says: 0x9999…, foo.near)" -> ["0x9999…", "foo.near"] */
function quotedAddresses(raw: string): string[] {
  const m = raw.match(/\(invoice says: ([^)]*)\)/);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function disagreementSegments(raws: string[]): Segment[] {
  // "readers disagree on total: A=80.00, B=8.00"
  const parts: Segment[] = [];
  for (const raw of raws) {
    const m = raw.match(/^readers disagree on ([^:]+): A=(.*), B=(.*)$/);
    if (m) {
      if (parts.length) parts.push(t(' '));
      parts.push(t(`${cap(m[1])}: one read `), mono(m[2]), t(', the other '), mono(m[3]), t('.'));
    } else {
      if (parts.length) parts.push(t(' '));
      parts.push(t(`${cap(raw.replace(/^readers disagree on /, ''))}.`));
    }
  }
  return parts;
}

function issueItem(issue: Issue, all: Issue[], f: ReviewFacts): Omit<ReviewItem, 'n'> {
  const amt = f.amount ? `${fmtAmount(f.amount)} ${f.unit}` : 'This amount';
  const base = { ok: false, kind: issue.kind, anchor: ANCHOR[issue.kind] ?? null };
  switch (issue.kind) {
    case 'duplicate':
      return { ...base, title: 'Duplicate invoice', detail: [t('The treasury has already seen this invoice from '), t(f.vendorName), t('. It can only be paid once.')] };
    case 'unregistered':
      return { ...base, title: 'Not a registered vendor', detail: f.vendorAccount ? [mono(f.vendorAccount), t(' has no entry in the vendor registry, so there is no address to pay.')] : [t('This vendor has no entry in the vendor registry.')] };
    case 'unapproved':
      return { ...base, title: 'Vendor not approved', detail: [t("You haven't set limits for "), f.vendorAccount ? mono(f.vendorAccount) : t('this vendor'), t(', so the treasury will not pay it.')] };
    case 'no-account':
      return { ...base, title: 'No NEAR account on the invoice', detail: [t('Orvantra pays vendors by their NEAR account, and this invoice does not print a valid one.')] };
    case 'over-max':
      return { ...base, title: 'Above the vendor limit', detail: [t(`${amt} is more than the ${f.maxPerInvoice ? fmtAmount(f.maxPerInvoice) : 'amount'} allowed per invoice for ${f.vendorName}.`)] };
    case 'currency':
      return { ...base, title: 'Not billed in USDC', detail: [t('The invoice currency is not USDC or USD.')] };
    case 'amount':
      return { ...base, title: 'Amount is not positive', detail: [t('The total on the invoice is zero or negative.')] };
    case 'redirect': {
      const said = quotedAddresses(issue.raw);
      const detail: Segment[] = [t('Invoice says ')];
      said.forEach((a, i) => detail.push(...(i ? [t(', ')] : []), mono(shortAddr(a), true)));
      if (!said.length) detail.push(t('to pay somewhere else'));
      detail.push(t('. Registered: '));
      if (f.payout) detail.push(mono(shortAddr(f.payout.address)), t(` on ${chainLabel(f.payout.chain)}.`));
      else detail.push(t('no payout on file.'));
      return { ...base, title: 'Different payout address', detail };
    }
    case 'name-mismatch': {
      const m = issue.raw.match(/^invoice says (.*), but (\S+) is registered as (.*)$/s);
      return {
        ...base, title: 'Name differs from the registry',
        detail: m
          ? [t('The registry has '), mono(m[2]), t(' as '), t(m[3]), t(', but the invoice is from '), t(m[1]), t('. Check it is the same business.')]
          : [t(`${cap(issue.raw)}.`)],
      };
    }
    case 'not-invoice':
      return { ...base, title: 'Not an invoice', detail: [t(`${cap(issue.raw)}. Orvantra only pays invoices.`)] };
    case 'possible-duplicate': {
      const m = issue.raw.match(/^possible duplicate of (.*) \(([^()]*)\)$/s);
      return { ...base, title: 'Possible duplicate', detail: m ? [t('The same vendor already has an invoice numbered '), mono(m[1]), t(` (${m[2]}). It may be the same invoice sent again.`)] : [t(`${cap(issue.raw)}.`)] };
    }
    case 'sparse':
      return { ...base, title: 'Nothing to check it against', detail: [t('The invoice has no payment text and no line items, so there was nothing to compare with the total or the registry.')] };
    case 'plaintext':
      return { ...base, title: 'A reading was not encrypted', detail: [t("End-to-end encryption to NEAR AI's hardware failed for one model, so that reading went without it. Look at the invoice yourself.")] };
    case 'cross-chain':
      return { ...base, title: 'You confirm the deposit address', detail: [t('Payments to another chain wait for you: check the 1Click deposit address below against the quote before you approve.')] };
    case 'bank':
      return { ...base, title: 'Bank details on the invoice', detail: [t('Orvantra ignores them and pays only the address the vendor registered on-chain.')] };
    case 'disagree': {
      const raws = all.filter((x) => x.kind === 'disagree').map((x) => x.raw);
      return { ...base, anchor: raws.some((r) => r.includes('invoice number')) && !raws.some((r) => r.includes('total')) ? 'invoice_number' : 'total', title: 'The two readers disagree', detail: disagreementSegments(raws) };
    }
    case 'unverified':
      return { ...base, title: 'A reading could not be verified', detail: [t("One model's answer could not be checked against NEAR AI's hardware signature, so a person should look.")] };
    case 'unreadable':
      return { ...base, title: 'Part of the invoice is unreadable', detail: [t(`${cap(issue.raw)}.`)] };
    case 'lines': {
      const m = issue.raw.match(/sum to ([\d.,]+) \S+ but the total is ([\d.,]+)/);
      return { ...base, title: "Lines don't add up", detail: m ? [t('The lines add up to '), mono(m[1]), t(', but the total says '), mono(m[2]), t('.')] : [t(`${cap(issue.raw)}.`)] };
    }
    case 'unusual': {
      const m = issue.raw.match(/median paid amount ([\d.,]+)/);
      return { ...base, title: 'Unusually large', detail: [t(`${amt} is more than three times what ${f.vendorName} is usually paid`), ...(m ? [t(' ('), mono(m[1]), t(')')] : []), t('.')] };
    }
    case 'payout-changed':
      return { ...base, title: 'Payout changed before approval', detail: [t(`${f.vendorName} changed their payout address after the agent checked it, so the treasury stopped the payment.`)] };
    case 'fresh-payout':
      return { ...base, title: 'Payout changed recently', detail: [t(`${f.vendorName} changed their payout address${f.minPayoutAgeSec ? ` less than ${fmtDuration(f.minPayoutAgeSec)} ago` : ' recently'}.`)] };
    case 'first-payment':
      return { ...base, title: 'First payment to this vendor', detail: [t('The treasury always holds the first payment to a vendor for you.')] };
    case 'threshold':
      return { ...base, title: 'Above your automatic limit', detail: [t(`Payments over ${f.autoPayThreshold ? `${fmtAmount(f.autoPayThreshold)} ${f.unit}` : 'your limit'} wait for your approval.`)] };
    case 'chain':
      return { ...base, title: 'Treasury could not be read', detail: [t('Orvantra could not read the treasury or registry on NEAR, so it held the invoice.')] };
    case 'owner-rejected':
      return { ...base, title: 'Rejected by you', detail: [t(cap(issue.raw.replace(/^owner:\s*/, '')) || 'Rejected in your wallet.')] };
    case 'transfer-failed':
      return { ...base, title: 'Transfer failed', detail: [t('The token transfer did not go through. The money stayed in the treasury.')] };
    default:
      return { ...base, title: 'Check this', detail: [t(`${cap(issue.raw)}.`)] };
  }
}

function headlineFor(top: Issue, f: ReviewFacts): string {
  switch (top.kind) {
    case 'duplicate': return 'You have already received this invoice.';
    case 'unregistered': return 'This vendor is not registered.';
    case 'unapproved': return "You haven't approved this vendor.";
    case 'no-account': return 'This invoice does not say who to pay.';
    case 'over-max': return `This is above ${f.vendorName}'s limit per invoice.`;
    case 'currency': return 'This invoice is not in USDC.';
    case 'amount': return 'This invoice has no amount to pay.';
    case 'redirect': return 'This invoice asks you to pay someone else.';
    case 'bank': return 'This invoice brings its own bank details.';
    case 'name-mismatch': return 'The name on this invoice is not the registered vendor.';
    case 'not-invoice': return 'This is not an invoice.';
    case 'possible-duplicate': return 'This may be an invoice you already have.';
    case 'sparse': return 'This invoice gave nothing to check it against.';
    case 'plaintext': return 'One reading was not encrypted.';
    case 'cross-chain': return `This pays ${f.vendorName} on another chain.`;
    case 'disagree': return 'The two readers read this invoice differently.';
    case 'unverified': return 'One reading could not be verified.';
    case 'unreadable': return 'Part of this invoice could not be read.';
    case 'lines': return "The lines on this invoice don't add up.";
    case 'unusual': return `This is much more than ${f.vendorName} usually charges.`;
    case 'payout-changed': return `${f.vendorName} changed where they get paid.`;
    case 'fresh-payout': return `${f.vendorName} changed their payout address recently.`;
    case 'first-payment': return `This is your first payment to ${f.vendorName}.`;
    case 'threshold': return 'This is above your automatic limit.';
    case 'chain': return 'Orvantra could not read the treasury.';
    case 'owner-rejected': return 'You rejected this payment.';
    case 'transfer-failed': return 'The transfer failed.';
    default: return 'This invoice needs a look.';
  }
}

/** Extra sentence after "Everything else checks out." for the top issue. */
function reassurance(top: Issue, f: ReviewFacts): string {
  switch (top.kind) {
    case 'redirect':
    case 'bank': return ` Orvantra will only pay the address ${f.vendorName} registered on-chain.`;
    case 'threshold': return f.autoPayThreshold ? ` Payments over ${fmtAmount(f.autoPayThreshold, { whole: true })} ${f.unit} wait for you.` : '';
    case 'first-payment': return ' Later payments within your limits can go out automatically.';
    default: return '';
  }
}

export function buildVerdict(f: ReviewFacts): Verdict {
  const messages = [...f.agentFindings, ...f.contractReasons].map(toIssue);
  const issues = rankIssues(messages);
  const kinds = new Set(issues.map((i) => i.kind));

  // ---- items: vendor, readers, then every issue not already covered by those two
  const items: Omit<ReviewItem, 'n'>[] = [];
  const vendorIssue = issues.find((i) => i.kind === 'unregistered' || i.kind === 'unapproved' || i.kind === 'no-account');
  if (vendorIssue) {
    items.push(issueItem(vendorIssue, messages, f));
  } else if (f.registered && f.approved && f.vendorAccount) {
    items.push({
      ok: true, kind: 'vendor', anchor: 'vendor', title: 'Known vendor',
      detail: [mono(f.vendorAccount), t(` is registered and approved.${f.maxPerInvoice ? ` Limit ${fmtAmount(f.maxPerInvoice, { whole: true })} per invoice.` : ''}`)],
    });
  }
  const readerIssue = issues.find((i) => i.kind === 'disagree') ?? issues.find((i) => i.kind === 'unverified');
  if (readerIssue) {
    items.push(issueItem(readerIssue, messages, f));
  } else if (f.readers && f.readers.agree && f.readers.answered === f.readers.count && f.readers.count > 0) {
    const what = [f.amount ? `${fmtAmount(f.amount)} ${f.unit}` : null, f.invoiceNumber].filter(Boolean).join(' and ');
    const inTee = f.readers.tee ?? f.readers.verified; // older records did not store tee: verified meant provider_tee
    const signed = inTee === f.readers.count
      ? (f.readers.count === 2 ? " Both signed inside NEAR AI's secure hardware." : " Each signed inside NEAR AI's secure hardware.")
      : f.readers.verified === f.readers.count ? " The signatures checked out, but not all were signed inside the model's own hardware." : '';
    items.push({
      ok: true, kind: 'readers', anchor: 'total', title: 'Read twice, privately',
      detail: [t(`${f.readers.count === 2 ? 'Two' : f.readers.count} models agree${what ? ` on ${what}` : ''}.${signed}`)],
    });
  }
  for (const issue of issues) {
    if (issue === vendorIssue || (readerIssue && issue.kind === readerIssue.kind)) continue;
    items.push(issueItem(issue, messages, f));
  }
  // Once paid, earlier holds are history (the owner approved them): show them neutral, not as open problems.
  const settledOk = f.state === 'paid';
  const numbered: ReviewItem[] = items.map((it, i) => ({ ...it, ok: it.ok || settledOk, n: i + 1 }));

  // ---- outlines: green for verified regions, red where a finding points
  const outlines: Verdict['outlines'] = {};
  const readersOk = numbered.some((i) => i.kind === 'readers');
  if (readersOk) {
    outlines.invoice_number = 'ok';
    outlines.total = 'ok';
  }
  for (const it of numbered) {
    if (!it.anchor) continue;
    if (!it.ok) outlines[it.anchor] = 'bad';
  }

  // ---- headline
  const top = issues[0];
  const problems = numbered.filter((i) => !i.ok);
  let tone: Tone;
  let label: string;
  let headline: string;
  let body: string;
  let outcome: string;
  switch (f.state) {
    case 'paid':
      tone = 'paid';
      label = 'Paid';
      headline = f.approvedByOwner ? 'Paid after you approved it.' : 'Paid automatically.';
      body = f.approvedByOwner
        ? `The treasury checked ${f.vendorName}'s registry entry again and paid the registered address.`
        : `Everything was within your rules, so the treasury paid the address ${f.vendorName} registered on-chain.`;
      outcome = f.approvedByOwner ? 'Paid — approved by you' : 'Paid automatically';
      break;
    case 'paying':
      tone = 'paying';
      label = 'Paying';
      headline = 'The payment is on its way.';
      body = 'The treasury is checking the registry again and sending the money.';
      outcome = 'Paying now';
      break;
    case 'rejected':
    case 'failed':
    case 'stopped':
    case 'not-sent': {
      tone = 'stopped';
      label = 'Stopped';
      if (f.state === 'not-sent' && !top) {
        headline = 'This invoice was read but not sent.';
        body = 'Nothing was proposed to the treasury.';
        outcome = 'Not sent';
      } else {
        headline = top ? headlineFor(top, f) : f.state === 'failed' ? 'The transfer failed.' : 'This payment was stopped.';
        body = f.state === 'rejected' || f.state === 'failed'
          ? 'No money left the treasury.'
          : 'Nothing was sent to the treasury.';
        outcome = `Stopped — ${top ? shortPhrase(top, { threshold: f.autoPayThreshold }) : 'not sent'}`;
      }
      break;
    }
    default: {
      tone = 'held';
      label = 'Held for you';
      headline = top ? headlineFor(top, f) : 'This payment is waiting for you.';
      const others = problems.length - 1;
      body = others <= 0
        ? `Everything else checks out.${top ? reassurance(top, f) : ''}`
        : `${others === 1 ? 'One more thing' : `${others} more things`} to check below.${top ? reassurance(top, f) : ''}`;
      outcome = `Held — ${top ? shortPhrase(top, { threshold: f.autoPayThreshold }) : 'waiting for you'}`;
    }
  }
  if (kinds.size === 0 && f.state === 'pending') body = 'Nothing unusual was found.';
  return { tone, label, headline, body: body.trim(), items: numbered, outlines, outcome };
}
