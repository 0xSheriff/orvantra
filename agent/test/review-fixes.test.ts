// Tests for the 2026-11-08 security review fixes on the agent side (A-H1, A-M1..M3, LOW-1..4, Telegram --link).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareReadings } from '../src/compare.ts';
import { canonicalPaymentText, decide, findPayoutMentions } from '../src/checks.ts';
import { checkPdfLimits, parseExtraction, readerSpecs } from '../src/extract.ts';
import { duplicateKey, invoiceNumberKey } from '../src/hash.ts';
import { nameTokens, oneLine, vendorNamesMatch } from '../src/names.ts';
import { normalizeExtraction, parseAmount } from '../src/normalize.ts';
import { linkableChats } from '../src/notify/link.ts';
import { paymentAlert } from '../src/notify/messages.ts';
import { validateQuote, type QuoteResponse } from '../src/oneclick.ts';
import { buildVerdict, classify, rankIssues, type ReviewFacts } from '../src/verdict.ts';
import type { Extraction } from '../src/types.ts';
import { baseInput, config, invoice, paid, registry } from './fixtures.ts';

const kinds = (d: ReturnType<typeof decide>) => d.findings.map((f) => f.kind);
const EVIL = '0x9999999999999999999999999999999999999999';

describe('A-H1: the invoice must name the registered vendor', () => {
  it('holds when the name differs, with the required message and a structured kind', () => {
    const d = decide(baseInput({ invoice: invoice({ vendor_name: 'Evil Corp' }) }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toEqual(['invoice says Evil Corp, but acme.testnet is registered as Acme']);
    expect(kinds(d)).toEqual(['name-mismatch']);
  });

  it('is case- and diacritics-insensitive, ignores legal forms, and matches a subset of words', () => {
    for (const [inv, reg] of [
      ['ACME DESIGN STUDIO', 'Acme Design Studio'], ['Café Müller GmbH', 'Cafe Muller'], ['Acme Ltd.', 'ACME'],
      ['Studio, Acme Design', 'Acme Design Studio'], ['Acme Designn Studio', 'Acme Design Studio'], ['Zoë & Co', 'Zoe'],
    ]) expect(vendorNamesMatch(inv, reg), `${inv} ~ ${reg}`).toBe(true);
  });

  it('does not match different businesses or empty names', () => {
    for (const [inv, reg] of [['Evil Corp', 'Acme'], ['Acme', 'Acne Industries'], ['', 'Acme'], ['Ltd', 'Ltd Inc'], ['Bob', 'Bobby Tables']]) {
      expect(vendorNamesMatch(inv, reg), `${inv} !~ ${reg}`).toBe(inv === 'Ltd');
    }
    expect(nameTokens('Café  Müller-GmbH')).toEqual(['cafe', 'muller', 'gmbh']);
  });

  it('an empty invoice name is held too', () => {
    const d = decide(baseInput({ invoice: invoice({ vendor_name: '' }) }));
    expect(d.reasons).toEqual(['invoice says (no name), but acme.testnet is registered as Acme']);
  });

  it('attacker text in the name cannot add lines or hide the registry name', () => {
    const d = decide(baseInput({ invoice: invoice({ vendor_name: `Evil\n​Corp ${'x'.repeat(300)}` }) }));
    expect(d.reasons[0]).not.toMatch(/[\n​]/);
    expect(d.reasons[0].length).toBeLessThan(200);
    expect(d.reasons[0]).toMatch(/registered as Acme$/);
  });

  it('the vendor name mismatch is a hold, not a reject (nothing else is wrong)', () => {
    expect(decide(baseInput({ invoice: invoice({ vendor_name: 'Somebody Else' }) })).action).toBe('hold');
  });
});

describe('A-M1: secondary duplicate key (vendor + normalized invoice number)', () => {
  it('normalizes unicode, case, punctuation and leading zeros', () => {
    const k = invoiceNumberKey('INV-2026-0150');
    for (const v of ['inv 2026 150', 'Inv.2026.00150', 'ＩＮＶ-２０２６-０１５０', 'INV/2026/150']) expect(invoiceNumberKey(v)).toBe(k);
    expect(invoiceNumberKey('INV-2026-0151')).not.toBe(k);
    expect(duplicateKey('Acme.testnet', 'INV-0001')).toBe(duplicateKey('acme.testnet', 'inv 1'));
    expect(duplicateKey('acme.testnet', '---')).toBe('');
  });

  const earlier = { ...paid('acme.testnet', '120000000'), memo: 'INV-2026-0150', invoice_hash: 'a'.repeat(64) };

  it('holds when an on-chain payment memo matches, whatever the amount', () => {
    const d = decide(baseInput({ invoice: invoice({ invoice_number: 'INV 2026 150', amount_base_units: 120_010_000n, line_items: [] }), payments: [earlier] }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toContain('possible duplicate of INV-2026-0150 (Paid)');
    expect(kinds(d)).toContain('possible-duplicate');
    const other = decide(baseInput({ invoice: invoice({ invoice_number: 'INV-2026-0150', amount_base_units: 5_000_000n, line_items: [] }), payments: [{ ...earlier, status: 'Rejected' }] }));
    expect(other.reasons).toContain('possible duplicate of INV-2026-0150 (Rejected)');
  });

  it('holds on a ledger entry, but not for another vendor or the same hash', () => {
    const entry = { invoice_hash: 'b'.repeat(64), vendor: 'acme.testnet', invoice_number: 'INV-77', status: 'analyzed:hold' };
    const hit = decide(baseInput({ invoice: invoice({ invoice_number: 'inv 077' }), ledgerCandidates: [entry] }));
    expect(hit.reasons).toContain('possible duplicate of INV-77 (analyzed:hold)');
    const otherVendor = decide(baseInput({ invoice: invoice({ invoice_number: 'inv 077' }), ledgerCandidates: [{ ...entry, vendor: 'bob.testnet' }] }));
    expect(otherVendor.action).toBe('propose');
    const own = decide(baseInput({ invoice: invoice({ invoice_number: 'inv 077' }), ledgerCandidates: [{ ...entry, invoice_hash: decide(baseInput({ invoice: invoice({ invoice_number: 'inv 077' }) })).invoice_hash! }] }));
    expect(own.action).toBe('propose');
  });

  it('an exact on-chain duplicate is still a reject, with no extra possible-duplicate hold', () => {
    const d = decide(baseInput({ invoiceUsed: true, payments: [earlier], invoice: invoice({ invoice_number: 'INV-2026-0150' }) }));
    expect(d.action).toBe('reject');
    expect(kinds(d)).not.toContain('possible-duplicate');
  });
});

describe('A-M2: credit notes are rejected', () => {
  const ex = (over: Partial<Extraction>): Extraction => ({
    document_type: 'invoice', vendor_name: 'Acme', vendor_near_account: 'acme.testnet', invoice_number: 'INV-1', issue_date: '2026-11-02',
    due_date: '2026-12-02', currency: 'USDC', total: '120.00', line_items: [{ description: 'x', amount: '120.00' }], payment_instructions_text: 'pay acme.testnet', ...over,
  });
  const decideFor = (over: Partial<Extraction>) => decide(baseInput({ invoice: normalizeExtraction(ex(over)) }));

  it.each(['−120.00', '(120.00)', '120.00-', '120.00 CR', 'Credit 120.00', 'refund 120.00', '-120'])('total %s is rejected', (total) => {
    const d = decideFor({ total, line_items: [] });
    expect(d.action).toBe('reject');
    expect(kinds(d)).toContain('not-invoice');
  });

  it('credit words in the invoice number reject, and so do non-invoice document types', () => {
    expect(decideFor({ invoice_number: 'CREDIT NOTE 7' }).action).toBe('reject');
    expect(decideFor({ document_type: 'credit_note' }).reasons[0]).toBe('document is a credit note, not a request for payment');
    expect(decideFor({ document_type: 'receipt' }).reasons[0]).toBe('document is a receipt, not a request for payment');
    expect(decideFor({ document_type: 'other' }).action).toBe('reject');
    expect(decideFor({ document_type: 'Credit Note' }).action).toBe('reject');
  });

  it('a normal invoice is untouched; an unreadable document type is held', () => {
    expect(decideFor({}).action).toBe('propose');
    const d = decideFor({ document_type: undefined });
    expect(d.action).toBe('hold');
    expect(kinds(d)).toEqual(['unreadable']);
  });

  it('if either reader says it is not an invoice, it is not', () => {
    const a = normalizeExtraction(ex({}));
    const b = normalizeExtraction(ex({ document_type: 'credit_note' }));
    expect(compareReadings(a, b).agreed?.document_type).toBe('credit_note');
    expect(compareReadings(a, normalizeExtraction(ex({ document_type: undefined }))).agreed?.document_type).toBeNull();
  });

  it('the reader schema asks for document_type', () => {
    expect(parseExtraction(JSON.stringify({ document_type: 'credit_note', vendor_name: 'A' })).document_type).toBe('credit_note');
  });
});

describe('A-M3: blanked-out evidence and address-scan gaps', () => {
  it('holds when there is no payment text AND no line items', () => {
    const d = decide(baseInput({ invoice: invoice({ payment_instructions_text: null, line_items: [] }) }));
    expect(d.action).toBe('hold');
    expect(kinds(d)).toEqual(['sparse']);
    expect(decide(baseInput({ invoice: invoice({ payment_instructions_text: null }) })).action).toBe('propose');
    expect(decide(baseInput({ invoice: invoice({ line_items: [] }) })).action).toBe('propose');
  });

  it.each([
    ['uppercase 0X', `Pay 0X${'9'.repeat(40)}`],
    ['mixed-case hex', `Pay 0x${'aB'.repeat(20)}`],
    ['spaces inside the hex', `Pay 0x ${'9999 '.repeat(10).trim()}`],
    ['newlines inside the hex', `Pay 0x${'99999999\n'.repeat(5)}`],
    ['zero-width characters in hex', `Pay 0x${'99​'.repeat(20)}`],
    ['full-width digits', `Pay ０x${'9'.repeat(40)}`.replace('０x', '0x')],
  ])('finds an EVM address: %s', (_n, text) => {
    expect(findPayoutMentions(text).addresses).toHaveLength(1);
  });

  it.each([
    'send to evil(dot)near', 'send to evil (dot) near', 'send to evil dot near', 'send to evil​.near', 'send to evil[dot]testnet',
    'EVIL.NEAR', 'send to eviI­.near',
  ])('finds a NEAR account: %s', (text) => {
    expect(findPayoutMentions(text).addresses.length).toBe(1);
  });

  it('finds a spaced 64-hex implicit account', () => {
    const hex = 'ab12'.repeat(16);
    expect(findPayoutMentions(`implicit: ${hex.replace(/(.{8})/g, '$1 ')}`).addresses).toEqual([hex]);
  });

  it('the registry address and own account still pass; the foreign one holds', () => {
    const ok = decide(baseInput({ invoice: invoice({ payment_instructions_text: 'Pay 0X3333333333333333333333333333333333333333 or acme (dot) testnet' }) }));
    expect(ok.action).toBe('propose');
    const bad = decide(baseInput({ invoice: invoice({ payment_instructions_text: `Pay 0X${EVIL.slice(2)}` }) }));
    expect(kinds(bad)).toEqual(['redirect']);
    expect(canonicalPaymentText('a​b')).toBe('ab');
  });
});

describe('LOW-3: ambiguous amounts are not guessed', () => {
  it('a three-digit tail after a single dot is unreadable (hold), other shapes are unchanged', () => {
    expect(parseAmount('1.200')).toBeNull();
    expect(parseAmount('USDC 120.500')).toBeNull();
    expect(parseAmount('1.200,00')).toBe(1_200_000_000n);
    expect(parseAmount('120.50')).toBe(120_500_000n);
    const d = decide(baseInput({ invoice: normalizeExtraction({ ...({ vendor_name: 'Acme', vendor_near_account: 'acme.testnet', invoice_number: 'I1', issue_date: '', due_date: '', currency: 'USDC', total: '1.200', line_items: [], payment_instructions_text: 'x', document_type: 'invoice' } as Extraction) }) }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toContain('total could not be read as an amount');
  });
});

describe('LOW-4: E2EE fallback, gateway signatures, reader models', () => {
  it('holds when a reader fell back to plaintext, naming the reason', () => {
    const d = decide(baseInput({ verification: [
      { reader: 'reader A', verified: true, detail: 'ok', tee: true },
      { reader: 'reader B', verified: true, detail: 'ok', tee: true, e2eeFallbackReason: 'attestation failed' },
    ] }));
    expect(d.action).toBe('hold');
    expect(d.reasons).toEqual(['end-to-end encryption failed for reader B, so the invoice was sent without it (attestation failed)']);
    expect(kinds(d)).toEqual(['plaintext']);
  });

  it('a gateway signature counts as verified but is not TEE: no hold, an honest note', () => {
    const d = decide(baseInput({ verification: [
      { reader: 'reader A', verified: true, detail: 'ok', tee: false },
      { reader: 'reader B', verified: true, detail: 'ok', tee: true },
    ] }));
    expect(d.action).toBe('propose');
    expect(d.notes.join(' ')).toMatch(/gateway, not inside the model's own secure hardware/);
  });

  it('refuses to start with the same model twice (any case)', () => {
    expect(() => readerSpecs({ READER_A_MODEL: 'x/y', READER_B_MODEL: 'X/Y ' })).toThrow(/must be different models/);
    expect(() => readerSpecs({ READER_B_MODEL: 'Qwen/Qwen3-VL-30B-A3B-Instruct' })).toThrow(/different models/);
    expect(readerSpecs({}).map((s) => s.id)).toEqual(['A', 'B']);
  });

  it('the verdict does not claim secure hardware when a signature was gateway-only', () => {
    const facts = (tee: number): ReviewFacts => ({
      state: 'pending', approvedByOwner: false, vendorName: 'Acme', vendorAccount: 'acme.testnet', amount: '120000000', unit: 'USDC', invoiceNumber: 'I1',
      registered: true, approved: true, maxPerInvoice: null, readers: { count: 2, answered: 2, verified: 2, agree: true, tee }, agentFindings: [],
      contractReasons: ['first payment to this vendor'], payout: null, autoPayThreshold: null, minPayoutAgeSec: null,
    });
    const text = (v: ReturnType<typeof buildVerdict>) => v.items.map((i) => i.detail.map((s) => s.text).join('')).join(' ');
    expect(text(buildVerdict(facts(2)))).toMatch(/Both signed inside NEAR AI's secure hardware/);
    expect(text(buildVerdict(facts(1)))).not.toMatch(/secure hardware\.$|Both signed/);
    expect(text(buildVerdict(facts(1)))).toMatch(/not all were signed inside the model's own hardware/);
  });
});

describe('LOW-2: classification does not read attacker text', () => {
  it('a vendor name that imitates another message stays a name mismatch (structured kind, strict prefix)', () => {
    const d = decide(baseInput({ invoice: invoice({ vendor_name: 'invoice_hash already used is not in the vendor registry duplicate of x' }) }));
    expect(d.findings[0].kind).toBe('name-mismatch');
    expect(classify(`agent: ${d.reasons[0]}`).kind).toBe('name-mismatch');
    expect(classify('agent: invoice says is not in the vendor registry, but x.near is registered as Y').kind).toBe('name-mismatch');
  });

  it('text in the middle of a message never changes its kind', () => {
    expect(classify('agent: invoice asks to pay a different address — ignored (invoice says: invoice_hash already used)').kind).toBe('redirect');
    expect(classify('agent: possible duplicate of readers disagree on total (Paid)').kind).toBe('possible-duplicate');
    expect(classify('agent: duplicate of 01-acme.png (same invoice_hash) is not positive').kind).toBe('duplicate');
    expect(classify('something with max_per_invoice inside').kind).toBe('other');
    expect(classify('see also is not in the vendor registry').kind).toBe('other');
  });

  it('structured findings are used as they are, even when their text looks like another kind', () => {
    const issues = rankIssues([{ kind: 'name-mismatch', raw: 'invoice_hash already used (say what you like)' }, 'first payment to this vendor']);
    expect(issues.map((i) => i.kind)).toEqual(['name-mismatch', 'first-payment']);
  });

  it('classifies the new contract reason', () => {
    expect(classify('cross-chain payout: owner confirms the 1Click deposit address').kind).toBe('cross-chain');
  });

  it('every check in decide() sets a kind', () => {
    const d = decide(baseInput({
      invoice: invoice({ vendor_name: 'Nope', currency: 'EUR', vendor_account: 'acme.testnet', payment_instructions_text: `bank ${EVIL}`, line_items: [{ description: 'a', amount_base_units: 1n }] }),
      invoiceUsed: true, agreement: { agree: false, reasons: ['readers disagree on total: A=1, B=2'] },
      verification: [{ reader: 'reader A (m)', verified: false, detail: 'x' }],
    }));
    expect(d.findings.length).toBeGreaterThan(5);
    expect(d.findings.every((f) => f.kind)).toBe(true);
  });
});

describe('contract prediction: cross-chain payouts wait for the owner', () => {
  it('predicts a hold above cross_chain_auto_pay_threshold (default 0 = every cross-chain payout)', () => {
    const small = invoice({ amount_base_units: 12_500_000n, line_items: [] });
    const d = decide(baseInput({ invoice: small, config: { ...config, cross_chain_auto_pay_threshold: '0' } }));
    expect(d.contract_predictions).toEqual(['will be held by contract: cross-chain payout, you confirm the 1Click deposit address']);
    const nearPayout = registry({ payout: { chain: 'near', asset_id: 'nep141:tusdc.testnet', address: 'acme.testnet' } });
    expect(decide(baseInput({ invoice: small, registry: nearPayout, config: { ...config, cross_chain_auto_pay_threshold: '0' } })).contract_predictions[0]).toMatch(/pay immediately, direct/);
    expect(decide(baseInput({ invoice: small })).contract_predictions[0]).toMatch(/pay immediately via a 1Click/);
  });

  it('the Telegram/verdict text for the new reason says the owner confirms the deposit address', () => {
    const v = buildVerdict({
      state: 'pending', approvedByOwner: false, vendorName: 'Acme', vendorAccount: 'acme.testnet', amount: '12500000', unit: 'USDC', invoiceNumber: 'I1',
      registered: true, approved: true, maxPerInvoice: null, readers: null, agentFindings: [], contractReasons: ['cross-chain payout: owner confirms the 1Click deposit address'],
      payout: { address: EVIL, chain: 'base' }, autoPayThreshold: null, minPayoutAgeSec: null,
    });
    expect(v.headline).toBe('This pays Acme on another chain.');
    expect(v.outcome).toBe('Held — you confirm the deposit address');
    const alert = paymentAlert({ id: 3, invoice_hash: 'a'.repeat(64), vendor: 'acme.testnet', amount: '12500000', payout_version: 1, status: 'Pending', reasons: ['cross-chain payout: owner confirms the 1Click deposit address'], direct: false, destination: null, created_at: '0' }, {
      network: 'testnet', unit: 'tUSDC', tokenId: 't', appUrl: 'https://x.test', treasuryId: 'tr.testnet', autoPayThreshold: null, minPayoutAgeSec: null, vendorNames: new Map([['acme.testnet', 'Acme']]),
    });
    expect(alert?.text).toContain('This pays Acme on another chain.');
  });
});

describe('LOW-1: 1Click quote validation', () => {
  const REAL = JSON.parse(readFileSync(fileURLToPath(new URL('./data/dry-quote-base.json', import.meta.url)), 'utf8')) as QuoteResponse;
  const AT = new Date('2026-11-06T15:22:30Z');
  const EXP = { dry: true, originAsset: REAL.quoteRequest.originAsset, destinationAsset: REAL.quoteRequest.destinationAsset, recipient: REAL.quoteRequest.recipient, amount: '120000000', refundTo: 'intents.near' };
  const ok = { verify: () => true, hash: () => 'h' };
  const errs = (patch: (q: QuoteResponse) => void, exp = EXP, o = {}, now = AT) => {
    const q = structuredClone(REAL);
    patch(q);
    return validateQuote(q, exp, now, o, ok).errors;
  };
  const real = (patch: (q: QuoteResponse) => void, o = {}) =>
    errs((q) => {
      q.quoteRequest.dry = false;
      q.quote.depositAddress = 'a1'.repeat(32);
      q.quote.deadline = new Date(AT.getTime() + 3_600_000).toISOString();
      patch(q);
    }, { ...EXP, dry: false }, o);

  it('the untouched real quote passes (minAmountOut rounding included)', () => {
    expect(errs(() => {})).toEqual([]);
  });

  it('slippageTolerance must equal what was requested', () => {
    expect(errs((q) => { q.quoteRequest.slippageTolerance = 5000; })).toEqual(['slippageTolerance is 5000, expected 100']);
    expect(errs(() => {}, EXP, { slippageBps: 50 })[0]).toBe('slippageTolerance is 100, expected 50');
  });

  it('minAmountOut may be at most `slippage` below amountOut', () => {
    expect(errs((q) => { q.quote.minAmountOut = '100000000'; })[0]).toMatch(/minAmountOut 100000000 is more than 1% below amountOut/);
    expect(errs((q) => { delete (q.quote as { minAmountOut?: string }).minAmountOut; })).toEqual(['quote has no minAmountOut']);
  });

  it('missing, zero or non-numeric USD values fail', () => {
    for (const patch of [
      (q: QuoteResponse) => { delete (q.quote as { amountOutUsd?: string }).amountOutUsd; },
      (q: QuoteResponse) => { q.quote.amountInUsd = 'NaN'; },
      (q: QuoteResponse) => { q.quote.amountInUsd = '0'; },
      (q: QuoteResponse) => { q.quote.amountOutUsd = ''; },
    ]) expect(errs(patch)[0]).toMatch(/no usable USD values/);
  });

  it('recipient: exact except lowercase for EVM', () => {
    const sol = 'So11111111111111111111111111111111111111112';
    const exp = { ...EXP, recipient: sol };
    expect(errs((q) => { q.quoteRequest.recipient = sol.toLowerCase(); }, exp)[0]).toMatch(/recipient is/);
    expect(errs((q) => { q.quoteRequest.recipient = sol; }, exp)).toEqual([]);
    expect(errs((q) => { q.quoteRequest.recipient = EXP.recipient.toUpperCase().replace('0X', '0x'); })).toEqual([]);
    expect(errs((q) => { q.quoteRequest.recipient = '0x3333333333333333333333333333333333333334'; })[0]).toMatch(/recipient is/);
  });

  it('real quotes need a deadline at least 30 minutes ahead', () => {
    expect(real(() => {})).toEqual([]);
    expect(real((q) => { q.quote.deadline = new Date(AT.getTime() + 29 * 60_000).toISOString(); })[0]).toMatch(/less than 30 minutes away/);
    expect(real((q) => { q.quote.deadline = new Date(AT.getTime() + 30 * 60_000).toISOString(); })).toEqual([]);
    expect(real((q) => { delete (q.quote as { deadline?: string }).deadline; })).toEqual(['real quote has no deadline']);
  });
});

describe('Telegram --link only answers the configured chat', () => {
  const chats = new Map([[111, '@owner'], [222, '@stranger']]);
  it('without a configured chat id every /start chat is listed', () => {
    expect([...linkableChats(chats, undefined).keys()]).toEqual([111, 222]);
    expect([...linkableChats(chats, '  ').keys()]).toEqual([111, 222]);
  });
  it('with one configured, only that chat is answered', () => {
    expect([...linkableChats(chats, '111').keys()]).toEqual([111]);
    expect(linkableChats(chats, '999').size).toBe(0);
  });
});

describe('PDF limits (A: max 2 pages, no page above 5000x5000 at render scale)', () => {
  const pdf = readFileSync(fileURLToPath(new URL('../fixtures/02-bob-normal.pdf', import.meta.url)));
  it('accepts the fixture invoice', async () => {
    await expect(checkPdfLimits(pdf)).resolves.toBeUndefined();
  });
  it('refuses too many pages', async () => {
    await expect(checkPdfLimits(pdf, { maxPages: 0 })).rejects.toThrow(/PDF has 1 pages; Orvantra reads at most 0/);
  });
  it('refuses a page that would render too large', async () => {
    await expect(checkPdfLimits(pdf, { maxPx: 100 })).rejects.toThrow(/page 1 is too large .* the limit is 100x100/);
  });
  it('a hostile MediaBox is refused from its size alone, without rendering it', async () => {
    const huge = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 20000 20000]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF');
    await expect(checkPdfLimits(huge)).rejects.toThrow(/too large|Invalid|Missing/);
  });
});

describe('oneLine', () => {
  it('strips control and zero-width characters and caps the length', () => {
    expect(oneLine('a\n​b\t c')).toBe('a b c');
    expect([...oneLine('x'.repeat(500), 10)]).toHaveLength(10);
  });
});
