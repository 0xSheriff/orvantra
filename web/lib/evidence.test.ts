import { describe, expect, it } from 'vitest';
import type { InvoiceRecord } from 'orvantra-agent/records';
import type { Payment } from 'orvantra-agent/near';
import { crossChainEvidence, sameRecipient, utcStamp, type QuoteRecord } from './evidence';
import { buildRows, invoiceNameOf, vendorNameOf, type ChainContext } from './rows';

const REG = '0x3333333333333333333333333333333333333333';
const DEPOSIT = 'a1'.repeat(32);
const quote = (o: Partial<QuoteRecord> = {}): QuoteRecord => ({
  quote_hash: '3sSUyTVrQ1aWQ1PRHCB6D2cZKJQLieKM4SfD7hK3SAZc', simulated: false, signature_valid: true, recipient: REG, deposit_address: DEPOSIT,
  deadline: '2026-11-10T14:05:33.000Z', ...o,
});
const input = (o: Partial<Parameters<typeof crossChainEvidence>[0]> = {}) => ({
  quote: quote(), chainQuoteHash: null, depositAddress: DEPOSIT, registryAddress: REG, vendorAccount: 'acme.near', ...o,
});
const text = (i: { detail: { text: string }[] }) => i.detail.map((s) => s.text).join('');

describe('crossChainEvidence', () => {
  it('shows the four facts the owner must check when everything matches', () => {
    const [sig, rec, dep] = crossChainEvidence(input({ chainQuoteHash: 'QH-on-chain' }));
    expect(sig).toMatchObject({ ok: true, title: 'Quote signed by 1Click: yes' });
    expect(text(sig)).toContain('QH-on-chain'); // the hash stored on-chain wins
    expect(rec).toMatchObject({ ok: true, title: 'Delivers to the registered address: yes' });
    expect(text(rec)).toContain(REG);
    expect(dep).toMatchObject({ ok: true, title: 'Deposit address: matches the quote' });
    expect(text(dep)).toContain(DEPOSIT);
    expect(text(dep)).toContain('valid until 2026-11-10 14:05 UTC');
  });

  it('flags a bad signature, a recipient that is not the registry address, and a different deposit address', () => {
    const [sig, rec, dep] = crossChainEvidence(input({
      quote: quote({ signature_valid: false, recipient: '0x9999999999999999999999999999999999999999' }),
      depositAddress: 'b2'.repeat(32),
    }));
    expect(sig).toMatchObject({ ok: false, title: 'Quote signed by 1Click: no' });
    expect(rec).toMatchObject({ ok: false, title: 'Delivers to the registered address: no' });
    expect(dep).toMatchObject({ ok: false, title: 'Deposit address: does not match the quote' });
    expect(text(dep)).toContain('Do not approve');
  });

  it('without the agent record nothing is confirmed (all three are not ok)', () => {
    const items = crossChainEvidence(input({ quote: null }));
    expect(items.map((i) => i.ok)).toEqual([false, false, false]);
    expect(text(items[0])).toContain('cannot be confirmed');
    expect(items[1].title).toBe('Delivers to the registered address: unknown');
    expect(items[2].title).toBe('Deposit address: not confirmed');
  });

  it('a missing deposit address is not ok', () => {
    expect(crossChainEvidence(input({ depositAddress: null }))[2]).toMatchObject({ ok: false, title: 'Deposit address: missing' });
  });

  it('testnet simulation is labelled, not passed off as a real deposit address', () => {
    const [sig, , dep] = crossChainEvidence(input({ quote: quote({ simulated: true, deposit_address: null }), depositAddress: DEPOSIT }));
    expect(text(sig)).toContain('dry mainnet quote');
    expect(dep.title).toBe('Deposit address: simulated on testnet');
    expect(text(dep)).toContain('stand-in');
  });

  it('EVM addresses compare without case, every other address exactly', () => {
    expect(sameRecipient(REG, REG.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(sameRecipient('So1abc', 'so1abc')).toBe(false);
    expect(sameRecipient('bc1qabc', 'bc1qabc')).toBe(true);
    expect(utcStamp('not a date')).toBe('not a date');
  });
});

describe('registry name first, invoice name second (A-H1 UI)', () => {
  const ctx: ChainContext = {
    network: 'testnet', treasuryId: 't.testnet', tokenId: 'tok.testnet', unit: 'tUSDC', config: null,
    registry: new Map([['acme.testnet', { account_id: 'acme.testnet', display_name: 'Acme Ltd', payout: { chain: 'base', asset_id: 'a', address: REG }, created_at_ns: '1', updated_at_ns: '1', version: 1 }]]),
    policies: new Map(),
  };
  const rec = { invoice: { vendor_name: 'Evil Corp' }, registry_entry: null } as unknown as InvoiceRecord;

  it('shows the registry display name even when the invoice says something else', () => {
    expect(vendorNameOf('acme.testnet', rec, ctx)).toBe('Acme Ltd');
    expect(invoiceNameOf('Acme Ltd', rec)).toBe('Evil Corp');
    expect(invoiceNameOf('Acme Ltd', { invoice: { vendor_name: 'acme ltd' } } as unknown as InvoiceRecord)).toBeNull();
  });

  it('falls back to the invoice name only for unregistered vendors', () => {
    expect(vendorNameOf('nobody.testnet', rec, ctx)).toBe('Evil Corp');
    expect(vendorNameOf('nobody.testnet', null, ctx)).toBe('nobody.testnet');
  });

  it('rows carry both names', () => {
    const p = { id: 1, invoice_hash: 'h', vendor: 'acme.testnet', amount: '1000000', payout_version: 1, status: 'Pending', reasons: [], direct: false, destination: null, created_at: '1' } as Payment;
    const rows = buildRows([p], [], [{ ...rec, id: '1793998367528-9b262b39', network: 'testnet', treasury: 't.testnet', invoice_hash: 'h', outcome: 'analyzed', received_at: '2026-11-06T20:00:00.000Z', decision: null, readers: [] } as unknown as InvoiceRecord], ctx);
    expect(rows[0]).toMatchObject({ vendorName: 'Acme Ltd', invoiceName: 'Evil Corp' });
  });
});
