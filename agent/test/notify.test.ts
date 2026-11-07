import { describe, it, expect, vi } from 'vitest';
import { paymentAlert, stoppedAlert, esc, type MessageCtx } from '../src/notify/messages.ts';
import { diff, remember, emptyState, agentStopped } from '../src/notify/state.ts';
import { telegramClient } from '../src/notify/telegram.ts';
import type { Payment } from '../src/near.ts';
import type { LedgerEntry } from '../src/ledger.ts';

const ctx: MessageCtx = {
  network: 'testnet', unit: 'tUSDC', tokenId: 'orvantra-tusdc.testnet', appUrl: 'https://app.example/',
  treasuryId: 'orvantra-treasury-v3.testnet', autoPayThreshold: '100000000', minPayoutAgeSec: 120,
  vendorNames: new Map([['orvantra-acme.testnet', 'Acme Design Studio']]),
};
const base: Payment = {
  id: 1, invoice_hash: 'h1', vendor: 'orvantra-acme.testnet', amount: '80000000', payout_version: 2, status: 'Pending',
  reasons: ['first payment to this vendor', 'agent: invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: 0x9999999999999999999999999999999999999999)'],
  direct: false, destination: 'x', created_at: '1', memo: 'INV-2026-0150',
  payout: { chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', address: '0x3333333333333333333333333333333333333333' },
} as Payment;

describe('paymentAlert', () => {
  it('held: same verdict headline as the web app, review deep link, never offers approval', () => {
    const a = paymentAlert(base, ctx)!;
    expect(a.text).toContain('<b>Held for you · 80.00 tUSDC</b>');
    expect(a.text).toContain('Acme Design Studio · INV-2026-0150');
    expect(a.text).toContain('This invoice asks you to pay someone else.');
    expect(a.text).toContain('Pays: orvantra-acme.testnet → USDC on Base');
    expect(a.buttons).toEqual([{ text: 'Review in Orvantra', url: 'https://app.example/review?p=1' }]);
    expect(a.text).not.toMatch(/approve here|\/approve/i);
  });
  it('paid by owner vs automatically', () => {
    expect(paymentAlert({ ...base, status: 'Paid', approved_by_owner: true }, ctx)!.text).toContain('Approved by you');
    expect(paymentAlert({ ...base, status: 'Paid', approved_by_owner: false, reasons: [] }, ctx)!.text).toContain('Paid automatically');
  });
  it('rejected by owner says nothing was sent', () => {
    const a = paymentAlert({ ...base, status: 'Rejected', reasons: ['owner: rejected by the owner in the Orvantra app'] }, ctx)!;
    expect(a.text).toContain('<b>Rejected · 80.00 tUSDC</b>');
    expect(a.text).toContain('Rejected by you. Nothing was sent.');
  });
  it('failed and unannounced statuses', () => {
    expect(paymentAlert({ ...base, status: 'Failed' }, ctx)!.text).toContain('Payment failed');
    expect(paymentAlert({ ...base, status: 'Verifying' as Payment['status'] }, ctx)).toBeNull();
  });
  it('escapes HTML in vendor names', () => {
    const c = { ...ctx, vendorNames: new Map([['orvantra-acme.testnet', '<b>Evil & Co</b>']]) };
    expect(paymentAlert(base, c)!.text).toContain('&lt;b&gt;Evil &amp; Co&lt;/b&gt;');
    expect(esc('a<b>&')).toBe('a&lt;b&gt;&amp;');
  });
});

describe('stoppedAlert', () => {
  it('uses the agent reason and the invoice name when the vendor is unknown', () => {
    const e = { invoice_hash: 'h7', file: 'f', network: 'testnet', treasury: ctx.treasuryId, vendor: 'globex-unknown.testnet',
      vendor_name: 'Globex Corp', amount: '75000000', invoice_number: 'GX-5521', decision: 'reject',
      reasons: ['vendor globex-unknown.testnet is not in the vendor registry'], statuses: [] } as LedgerEntry;
    const a = stoppedAlert(e, ctx);
    expect(a.text).toContain('<b>Stopped · 75.00 tUSDC</b>');
    expect(a.text).toContain('Globex Corp · GX-5521');
    expect(a.text).toContain('Vendor globex-unknown.testnet is not in the vendor registry. Nothing was sent.');
  });
});

describe('state diffing', () => {
  const p = (id: number, status: string) => ({ ...base, id, status }) as Payment;
  it('first run is silent, then only transitions are reported, once', () => {
    let s = emptyState('t');
    expect(diff(s, [p(0, 'Pending')], ['x'])).toEqual({ payments: [], stopped: [] });
    s = remember(s, [p(0, 'Pending')], ['x']);
    expect(diff(s, [p(0, 'Pending')], ['x']).payments).toHaveLength(0);
    const d = diff(s, [p(0, 'Paid'), p(1, 'Pending')], ['x', 'y']);
    expect(d.payments.map((x) => `${x.id}:${x.status}`)).toEqual(['0:Paid', '1:Pending']);
    expect(d.stopped).toEqual(['y']);
    s = remember(s, d.payments, d.stopped);
    expect(diff(s, [p(0, 'Paid'), p(1, 'Pending')], ['x', 'y'])).toEqual({ payments: [], stopped: [] });
  });
  it('agentStopped only counts agent rejects for this treasury that never reached the chain', () => {
    const L = {
      a: { invoice_hash: 'a', treasury: 't', decision: 'reject', payment_id: null },
      b: { invoice_hash: 'b', treasury: 't', decision: 'propose', payment_id: 3 },
      c: { invoice_hash: 'c', treasury: 'other', decision: 'reject', payment_id: null },
    } as unknown as Record<string, LedgerEntry>;
    expect(agentStopped(L, 't')).toEqual(['a']);
  });
});

describe('telegram client', () => {
  it('waits retry_after on 429 then succeeds, and never leaks the token in errors', async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
    const c = telegramClient('123:SECRET', { deps: { fetch, sleep } });
    await expect(c.call('sendMessage', { chat_id: 1, text: 'x' })).resolves.toEqual({ message_id: 7 });
    expect(sleep).toHaveBeenCalledWith(3000);
    const bad = telegramClient('123:SECRET', { deps: { fetch: vi.fn().mockRejectedValue(new Error('boom 123:SECRET')), sleep }, maxAttempts: 1 });
    await expect(bad.call('getMe')).rejects.toThrow(/<token>/);
  });
  it('does not retry a 400', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), { status: 400 }));
    const c = telegramClient('t', { deps: { fetch, sleep: async () => {} } });
    await expect(c.call('sendMessage')).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
