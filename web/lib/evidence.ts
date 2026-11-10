// What the owner must see before confirming a cross-chain payout. The treasury cannot check on-chain that the 1Click
// deposit address belongs to a quote that pays the vendor, so the review screen shows the agent's evidence: was the
// quote signed by 1Click, does it deliver to the registry address, which deposit address will the treasury pay, and
// until when is the quote valid. Pure: no I/O.
import type { Segment } from './verdict';

export interface QuoteRecord {
  quote_hash: string | null;
  simulated: boolean;
  signature_valid?: boolean;
  recipient_matches_registry?: boolean;
  recipient?: string;
  deposit_address?: string | null;
  deadline?: string;
}

export interface EvidenceInput {
  /** The agent's record of the quote (null: the payment was proposed outside the web app, or an older record). */
  quote: QuoteRecord | null;
  /** quote_hash stored on the payment on-chain (preferred over the record's). */
  chainQuoteHash: string | null;
  /** Where the treasury will send the money (payment.destination / deposit_address). */
  depositAddress: string | null;
  /** The vendor's registered payout address. */
  registryAddress: string | null;
  vendorAccount: string | null;
}

export interface EvidenceItem {
  ok: boolean;
  title: string;
  detail: Segment[];
}

const t = (text: string): Segment => ({ text });
const mono = (text: string): Segment => ({ text, mono: true });
const EVM = /^0x[0-9a-fA-F]{40}$/;

/** Same address? Exact, except EVM addresses compare without case. */
export function sameRecipient(a: string, b: string): boolean {
  return EVM.test(a) && EVM.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** "2026-11-10 14:05 UTC" from an ISO time; the raw text if it is not a date. */
export function utcStamp(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : iso;
}

export function crossChainEvidence(e: EvidenceInput): EvidenceItem[] {
  const q = e.quote;
  const simulated = !!q?.simulated;
  const hash = e.chainQuoteHash ?? q?.quote_hash ?? null;

  // 1. Signature
  const signed = q?.signature_valid === true;
  const sig: EvidenceItem = {
    ok: signed,
    title: `Quote signed by 1Click: ${signed ? 'yes' : 'no'}`,
    detail: !q
      ? [t("The agent's record of the quote is not available here, so its signature cannot be confirmed. Do not approve without checking it yourself.")]
      : signed
        ? [t("The agent checked 1Click's signature on the quote."), ...(hash ? [t(' Quote hash '), mono(hash), t('.')] : []), ...(simulated ? [t(' Testnet: this is a dry mainnet quote for the price; no money moves through it.')] : [])]
        : [t("1Click's signature on the quote did not check out. Do not approve.")],
  };

  // 2. Recipient = registry address
  const recipient = q?.recipient ?? null;
  const matches = recipient && e.registryAddress ? sameRecipient(recipient, e.registryAddress) : q?.recipient_matches_registry ?? null;
  const rec: EvidenceItem = {
    ok: matches === true,
    title: `Delivers to the registered address: ${matches === true ? 'yes' : matches === false ? 'no' : 'unknown'}`,
    detail: matches === true
      ? [t('The quote pays '), mono(recipient ?? e.registryAddress ?? ''), t(`, the address ${e.vendorAccount ?? 'the vendor'} registered on-chain.`)]
      : matches === false
        ? [t('The quote pays '), mono(recipient ?? ''), t(', not the registered '), mono(e.registryAddress ?? ''), t('. Do not approve.')]
        : [t('There is no quote to compare with the registered address.')],
  };

  // 3. Deposit address (+ deadline)
  const quoteDeposit = q?.deposit_address ?? null;
  const dep = e.depositAddress;
  const depositOk = !!dep && (simulated || (!!quoteDeposit && quoteDeposit === dep));
  const deadline = q?.deadline ? ` The quote is valid until ${utcStamp(q.deadline)}.` : '';
  const deposit: EvidenceItem = {
    ok: depositOk,
    title: simulated ? 'Deposit address: simulated on testnet' : `Deposit address: ${depositOk ? 'matches the quote' : dep ? (quoteDeposit ? 'does not match the quote' : 'not confirmed') : 'missing'}`,
    detail: !dep
      ? [t('The payment has no deposit address yet.')]
      : simulated
        ? [t('The treasury will send tUSDC to '), mono(dep), t(`, a stand-in account for the 1Click deposit address, because testnet has no NEAR Intents.${deadline}`)]
        : depositOk
          ? [t('The treasury will send the money to '), mono(dep), t(`, the deposit address in the signed quote.${deadline}`)]
          : quoteDeposit
            ? [t('The treasury would pay '), mono(dep), t(' but the quote says '), mono(quoteDeposit), t('. Do not approve.')]
            : [t('The treasury will pay '), mono(dep), t(". The agent's record has no deposit address from the quote to compare it with.")],
  };
  return [sig, rec, deposit];
}
