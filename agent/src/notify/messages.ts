// Turns treasury payment transitions (and agent-stopped invoices) into short Telegram messages.
// The headline comes from the same deterministic verdict builder the web app uses — no LLM, same words.
import { buildVerdict, type ReviewFacts, type ReviewState } from '../verdict.ts';
import { fmtAmount, routeLabel, cap } from '../format.ts';
import type { Payment } from '../near.ts';
import type { LedgerEntry } from '../ledger.ts';
import type { UrlButton } from './telegram.ts';

export interface MessageCtx {
  network: string;
  unit: string;
  tokenId: string | null;
  appUrl: string;
  treasuryId: string;
  autoPayThreshold: string | null;
  minPayoutAgeSec: number | null;
  /** registry display names, keyed by vendor account */
  vendorNames: Map<string, string>;
}

export interface Alert {
  key: string;
  text: string;
  buttons: UrlButton[];
}

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const explorer = (network: string) => (network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io');

function stateOf(status: string): ReviewState {
  switch (status) {
    case 'Pending': return 'pending';
    case 'Paid': return 'paid';
    case 'Rejected': return 'rejected';
    case 'Failed': return 'failed';
    default: return 'paying';
  }
}

export function vendorLabel(account: string | null, ctx: MessageCtx, fromInvoice?: string | null): string {
  if (account && ctx.vendorNames.get(account)) return ctx.vendorNames.get(account)!;
  if (fromInvoice && fromInvoice !== account) return fromInvoice;
  return account ?? 'Unknown vendor';
}

function factsForPayment(p: Payment, ctx: MessageCtx): ReviewFacts {
  return {
    state: stateOf(p.status),
    approvedByOwner: !!p.approved_by_owner,
    vendorName: vendorLabel(p.vendor, ctx),
    vendorAccount: p.vendor,
    amount: p.amount,
    unit: ctx.unit,
    invoiceNumber: p.memo ?? null,
    registered: true,
    approved: true,
    maxPerInvoice: null,
    readers: null,
    agentFindings: [],
    contractReasons: p.reasons ?? [],
    payout: p.payout ? { address: p.payout.address, chain: p.payout.chain } : null,
    autoPayThreshold: ctx.autoPayThreshold,
    minPayoutAgeSec: ctx.minPayoutAgeSec,
  };
}

/** One message for a payment that reached `p.status`. Returns null for statuses we don't announce. */
export function paymentAlert(p: Payment, ctx: MessageCtx): Alert | null {
  const amount = `${fmtAmount(p.amount)} ${ctx.unit}`;
  const vendor = vendorLabel(p.vendor, ctx);
  const ref = [esc(vendor), p.memo ? esc(p.memo) : null].filter(Boolean).join(' · ');
  const route = p.payout ? routeLabel(p.payout, ctx.tokenId, ctx.unit) : null;
  const review: UrlButton = { text: 'Review in Orvantra', url: `${ctx.appUrl.replace(/\/$/, '')}/review?p=${p.id}` };
  const tx: UrlButton = { text: 'View treasury', url: `${explorer(ctx.network)}/address/${ctx.treasuryId}` };
  const key = `payment:${p.id}:${p.status}`;
  switch (p.status) {
    case 'Pending': {
      const v = buildVerdict(factsForPayment(p, ctx));
      const lines = [`<b>Held for you · ${esc(amount)}</b>`, ref, esc(v.headline)];
      if (route) lines.push(`Pays: ${esc(p.vendor)} → ${esc(route)}`);
      lines.push('Approve or reject in the app with your wallet.');
      return { key, text: lines.join('\n'), buttons: [review] };
    }
    case 'Paid':
      return {
        key,
        text: [`<b>Paid · ${esc(amount)}</b>`, ref, p.approved_by_owner ? 'Approved by you' : 'Paid automatically within your rules',
          route ? `Route: ${esc(route)}` : null].filter(Boolean).join('\n'),
        buttons: [tx],
      };
    case 'Rejected': {
      const owner = (p.reasons ?? []).some((r) => r.startsWith('owner:'));
      return { key, text: [`<b>Rejected · ${esc(amount)}</b>`, ref, owner ? 'Rejected by you. Nothing was sent.' : 'Rejected by the treasury. Nothing was sent.'].join('\n'), buttons: [tx] };
    }
    case 'Failed':
      return { key, text: [`<b>Payment failed · ${esc(amount)}</b>`, ref, 'The transfer did not complete; the amount was released back to your limits.'].join('\n'), buttons: [review] };
    default:
      return null;
  }
}

/** An invoice the agent stopped before anything was proposed on-chain. */
export function stoppedAlert(e: LedgerEntry, ctx: MessageCtx): Alert {
  const amount = e.amount ? `${fmtAmount(e.amount)} ${ctx.unit}` : 'unknown amount';
  const vendor = vendorLabel(e.vendor, ctx, e.vendor_name);
  const ref = [esc(vendor), e.invoice_number ? esc(e.invoice_number) : null].filter(Boolean).join(' · ');
  const why = (e.reasons ?? [])[0] ?? 'it broke one of your rules';
  return {
    key: `stopped:${e.invoice_hash}`,
    text: [`<b>Stopped · ${esc(amount)}</b>`, ref, `${esc(cap(why))}. Nothing was sent.`].join('\n'),
    buttons: [{ text: 'See in Orvantra', url: `${ctx.appUrl.replace(/\/$/, '')}/invoices` }],
  };
}
