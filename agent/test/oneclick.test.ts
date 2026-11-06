// 1Click quote validation, offline. test/data/dry-quote-base.json is a REAL dry quote signed by 1Click (fetched
// 2026-11-06 with `npm run quote -- --save ...`), so the signature check runs against the real manager key.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildQuoteRequest, getQuote, getStatus, MAINNET_USDC_NEAR, pollStatus, submitDepositTx, validateQuote,
  type OneClickConfig, type QuoteExpectation, type QuoteResponse,
} from '../src/oneclick.ts';

const REAL: QuoteResponse = JSON.parse(readFileSync(new URL('./data/dry-quote-base.json', import.meta.url), 'utf8'));
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const AT = new Date(REAL.timestamp); // validate "as of" the quote time; its deadline is 1 h later
const EXP: QuoteExpectation = {
  dry: true,
  originAsset: MAINNET_USDC_NEAR,
  destinationAsset: BASE_USDC,
  recipient: '0x3333333333333333333333333333333333333333',
  amount: '120000000',
  refundTo: 'intents.near',
};

const clone = (): QuoteResponse => structuredClone(REAL);
const errorsOf = (q: QuoteResponse, e = EXP, now = AT) => validateQuote(q, e, now).errors;

describe('validateQuote — real signed dry quote', () => {
  it('accepts the untouched quote: signature valid, all fields match, quote_hash = signed message', () => {
    const c = validateQuote(REAL, EXP, AT);
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.signature_valid).toBe(true);
    expect(c.quote_hash).toBe('3sSUyTVrQ1aWQ1PRHCB6D2cZKJQLieKM4SfD7hK3SAZc');
    expect(c.deposit_address).toBeNull(); // dry
  });

  it('recipient case differences are fine (EVM addresses)', () => {
    expect(errorsOf(REAL, { ...EXP, recipient: EXP.recipient.toUpperCase().replace('0X', '0x') })).toEqual([]);
  });
});

describe('validateQuote — tampering breaks the signature AND the field check', () => {
  it('recipient swapped', () => {
    const q = clone();
    q.quoteRequest.recipient = '0x9999999999999999999999999999999999999999';
    const e = errorsOf(q);
    expect(e).toContain('1Click signature is INVALID for this quote');
    expect(e.some((x) => x.startsWith('recipient is "0x9999'))).toBe(true);
  });

  it('amount changed (request and quote.amountIn)', () => {
    const q = clone();
    q.quoteRequest.amount = '1200000000';
    q.quote.amountIn = '1200000000';
    const e = errorsOf(q);
    expect(e).toContain('1Click signature is INVALID for this quote');
    expect(e).toContain('amount is "1200000000", expected "120000000"');
    expect(e).toContain('quote.amountIn is "1200000000", expected "120000000"');
  });

  it('wrong destination asset', () => {
    const q = clone();
    q.quoteRequest.destinationAsset = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
    const e = errorsOf(q);
    expect(e).toContain('1Click signature is INVALID for this quote');
    expect(e.some((x) => x.startsWith('destinationAsset is'))).toBe(true);
  });

  it('wrong origin asset', () => {
    const q = clone();
    q.quoteRequest.originAsset = 'nep141:wrap.near';
    expect(errorsOf(q)).toEqual(expect.arrayContaining(['1Click signature is INVALID for this quote', `originAsset is "nep141:wrap.near", expected "${MAINNET_USDC_NEAR}"`]));
  });

  it('refundTo changed', () => {
    const q = clone();
    q.quoteRequest.refundTo = 'attacker.near';
    expect(errorsOf(q)).toEqual(expect.arrayContaining(['1Click signature is INVALID for this quote', 'refundTo is "attacker.near", expected "intents.near"']));
  });

  it('amountOut lowered', () => {
    const q = clone();
    q.quote.amountOut = '1';
    expect(errorsOf(q)).toContain('1Click signature is INVALID for this quote');
  });

  it('bad signature (one character changed)', () => {
    const q = clone();
    const s = q.signature;
    q.signature = s.slice(0, -1) + (s.endsWith('h') ? 'g' : 'h');
    expect(errorsOf(q)).toEqual(['1Click signature is INVALID for this quote']);
    q.signature = 'ed25519:not-base58!';
    expect(validateQuote(q, EXP, AT).signature_valid).toBe(false);
  });
});

describe('validateQuote — validly signed but not what we asked for', () => {
  // An attacker (or a bug) can return a GENUINE 1Click quote for a different payout. The signature is fine;
  // the expectation check must catch it.
  it('expected recipient differs from the (validly signed) quote', () => {
    const e = errorsOf(REAL, { ...EXP, recipient: '0x4444444444444444444444444444444444444444' });
    expect(e).toEqual(['recipient is "0x3333333333333333333333333333333333333333", expected the registry payout 0x4444444444444444444444444444444444444444']);
  });

  it('expected amount, destination, origin, refundTo, dry differ', () => {
    expect(errorsOf(REAL, { ...EXP, amount: '80000000' })).toHaveLength(2); // amount + amountIn
    expect(errorsOf(REAL, { ...EXP, destinationAsset: 'nep141:x' })[0]).toMatch(/^destinationAsset/);
    expect(errorsOf(REAL, { ...EXP, originAsset: 'nep141:orvantra-tusdc.testnet' })[0]).toMatch(/^originAsset/);
    expect(errorsOf(REAL, { ...EXP, refundTo: 'orvantra-treasury-v2.testnet' })[0]).toMatch(/^refundTo/);
    expect(errorsOf(REAL, { ...EXP, dry: false })).toEqual(expect.arrayContaining(['dry is true, expected false', 'real quote has no depositAddress']));
  });

  it('expired deadline', () => {
    const later = new Date(Date.parse(REAL.quoteRequest.deadline) + 1);
    expect(errorsOf(REAL, EXP, later)).toEqual([`deadline ${REAL.quoteRequest.deadline} has passed`]);
  });
});

describe('validateQuote — structural rules (signature stubbed so only the rule fires)', () => {
  const ok = { verify: () => true, hash: () => 'h' };
  const real = (patch: (q: QuoteResponse) => void) => {
    const q = clone();
    q.quoteRequest.dry = false;
    q.quote.depositAddress = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    q.quote.deadline = new Date(AT.getTime() + 3_600_000).toISOString();
    patch(q);
    return validateQuote(q, { ...EXP, dry: false }, AT, {}, ok);
  };

  it('real quote: deposit address returned', () => {
    const c = real(() => {});
    expect(c.errors).toEqual([]);
    expect(c.deposit_address).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('real quote: missing / non-NEAR deposit address, memo, expired quote deadline', () => {
    expect(real((q) => { delete q.quote.depositAddress; }).errors).toEqual(['real quote has no depositAddress']);
    expect(real((q) => { q.quote.depositAddress = 'Not A NEAR Account!'; }).errors[0]).toMatch(/not a NEAR account id/);
    expect(real((q) => { q.quote.depositMemo = '123'; }).errors[0]).toMatch(/deposit memo/);
    expect(real((q) => { q.quote.deadline = new Date(AT.getTime() - 1).toISOString(); }).errors[0]).toMatch(/quote deadline .* has passed/);
  });

  it('deposit/refund/recipient types and swap type must be the safe ones', () => {
    expect(real((q) => { q.quoteRequest.depositType = 'INTENTS' as never; }).errors).toEqual(['depositType is "INTENTS", expected "ORIGIN_CHAIN"']);
    expect(real((q) => { q.quoteRequest.refundType = 'INTENTS' as never; }).errors).toEqual(['refundType is "INTENTS", expected "ORIGIN_CHAIN"']);
    expect(real((q) => { q.quoteRequest.recipientType = 'INTENTS' as never; }).errors).toEqual(['recipientType is "INTENTS", expected "DESTINATION_CHAIN"']);
    expect(real((q) => { q.quoteRequest.swapType = 'EXACT_OUTPUT' as never; }).errors).toEqual(['swapType is "EXACT_OUTPUT", expected "EXACT_INPUT"']);
  });

  it('redirect-capable fields must be absent', () => {
    expect(real((q) => { q.quoteRequest.customRecipientMsg = 'x'; }).errors).toEqual(['unexpected customRecipientMsg in quote']);
    expect(real((q) => { q.quote.virtualChainRecipient = '0x1'; }).errors).toEqual(['unexpected virtualChainRecipient in quote']);
  });

  it('dry quote must not carry a deposit address', () => {
    const q = clone();
    q.quote.depositAddress = 'x.near';
    expect(validateQuote(q, EXP, AT, {}, ok).errors).toEqual(['dry quote unexpectedly has a depositAddress']);
  });

  it('price sanity: rejects more than maxLossBps USD loss', () => {
    expect(real((q) => { q.quote.amountOutUsd = '100'; }).errors[0]).toMatch(/loses too much/);
    const q = clone();
    q.quote.amountOutUsd = '100';
    expect(validateQuote(q, EXP, AT, { maxLossBps: 2000 }, ok).errors).toEqual([]);
  });

  it('malformed response', () => {
    expect(validateQuote({} as QuoteResponse, EXP, AT).errors).toEqual(['malformed quote response (missing quoteRequest/quote/signature)']);
  });
});

describe('buildQuoteRequest', () => {
  it('EXACT_INPUT, ORIGIN_CHAIN deposit + refund, DESTINATION_CHAIN recipient, deadline +1h', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(buildQuoteRequest(EXP, now)).toEqual({
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: MAINNET_USDC_NEAR, depositType: 'ORIGIN_CHAIN',
      destinationAsset: BASE_USDC, amount: '120000000', refundTo: 'intents.near', refundType: 'ORIGIN_CHAIN',
      recipient: EXP.recipient, recipientType: 'DESTINATION_CHAIN', deadline: '2026-11-06T13:00:00.000Z',
    });
  });
});

describe('HTTP client (fetch mocked)', () => {
  function client(responses: (Response | Error)[], jwt?: string) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r ?? new Response('{}', { status: 500 });
    });
    const cfg: OneClickConfig = { baseUrl: 'https://1click.example/v0/', jwt, fetch: f as unknown as typeof fetch };
    return { cfg, calls };
  }
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

  it('POST /quote with User-Agent, JSON body and optional bearer JWT', async () => {
    const { cfg, calls } = client([json(REAL)], 'secret-jwt');
    const q = await getQuote(cfg, buildQuoteRequest(EXP, AT));
    expect(q.signature).toBe(REAL.signature);
    expect(calls[0].url).toBe('https://1click.example/v0/quote');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['user-agent']).toMatch(/^orvantra-agent\//);
    expect(h.authorization).toBe('Bearer secret-jwt');
    expect(JSON.parse(String(calls[0].init.body)).recipient).toBe(EXP.recipient);
  });

  it('no Authorization header without a JWT', async () => {
    const { cfg, calls } = client([json([])]);
    await getStatus(cfg, 'a b').catch(() => {});
    expect(calls[0].url).toBe('https://1click.example/v0/status?depositAddress=a%20b');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('submitDepositTx posts txHash + depositAddress + nearSenderAccount', async () => {
    const { cfg, calls } = client([json({ status: 'KNOWN_DEPOSIT_TX' })]);
    expect((await submitDepositTx(cfg, 'TX', 'dep.near', 'treasury.near')).status).toBe('KNOWN_DEPOSIT_TX');
    expect(calls[0].url).toBe('https://1click.example/v0/deposit/submit');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ txHash: 'TX', depositAddress: 'dep.near', nearSenderAccount: 'treasury.near' });
  });

  it('HTTP 400 on /quote carries the refundTo hint', async () => {
    const { cfg } = client([new Response('{"message":"Internal server error"}', { status: 400 })]);
    await expect(getQuote(cfg, buildQuoteRequest(EXP, AT))).rejects.toThrow(/refundTo must be an existing mainnet NEAR account/);
  });

  it('pollStatus stops at a terminal status and reports each change once', async () => {
    const { cfg } = client([
      new Response('not found', { status: 404 }),
      json({ status: 'PENDING_DEPOSIT' }), json({ status: 'PENDING_DEPOSIT' }), json({ status: 'PROCESSING' }), json({ status: 'SUCCESS' }),
    ]);
    const seen: string[] = [];
    const s = await pollStatus(cfg, 'dep.near', { sleep: async () => {}, onChange: (x) => seen.push(x.status) });
    expect(s?.status).toBe('SUCCESS');
    expect(seen).toEqual(['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']);
  });

  it('pollStatus gives up at the timeout and returns the last status', async () => {
    let t = 0;
    const { cfg } = client(Array.from({ length: 10 }, () => json({ status: 'PROCESSING' })));
    const s = await pollStatus(cfg, 'dep.near', { timeoutMs: 20, intervalMs: 10, now: () => t, sleep: async (ms) => { t += ms; } });
    expect(s?.status).toBe('PROCESSING');
  });
});
