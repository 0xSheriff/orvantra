import { describe, expect, it } from 'vitest';
import { buildVerdict, classify, rankIssues, shortPhrase, type ReviewFacts } from './verdict';

const REDIRECT = 'invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: 0x9999999999999999999999999999999999999999)';

const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  state: 'pending',
  approvedByOwner: false,
  vendorName: 'Acme Design Studio',
  vendorAccount: 'orvantra-acme.testnet',
  amount: '80000000',
  unit: 'USDC',
  invoiceNumber: 'INV-2026-0150',
  registered: true,
  approved: true,
  maxPerInvoice: '300000000',
  readers: { count: 2, answered: 2, verified: 2, agree: true },
  agentFindings: [],
  contractReasons: [],
  payout: { address: '0x3333333333333333333333333333333333333333', chain: 'base' },
  autoPayThreshold: '100000000',
  minPayoutAgeSec: 120,
  ...over,
});

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

describe('classify', () => {
  it('maps agent findings, contract reasons and agent flags to kinds', () => {
    expect(classify(REDIRECT).kind).toBe('redirect');
    expect(classify(`agent: ${REDIRECT}`)).toEqual({ kind: 'redirect', raw: REDIRECT });
    expect(classify('amount above auto-pay threshold').kind).toBe('threshold');
    expect(classify('first payment to this vendor').kind).toBe('first-payment');
    expect(classify('payout changed recently').kind).toBe('fresh-payout');
    expect(classify('payout changed since agent checked').kind).toBe('payout-changed');
    expect(classify('owner: looks wrong').kind).toBe('owner-rejected');
    expect(classify('invoice_hash already used in the treasury (duplicate invoice)').kind).toBe('duplicate');
    expect(classify('vendor globex.testnet is not in the vendor registry').kind).toBe('unregistered');
    expect(classify('readers disagree on total: A=80.00, B=8.00').kind).toBe('disagree');
    expect(classify('line items sum to 30.00 USDC but the total is 300.00 USDC').kind).toBe('lines');
    expect(classify("amount 45.00 USDC is more than 3x this vendor's median paid amount 10.00 USDC").kind).toBe('unusual');
    expect(classify('ft_transfer failed').kind).toBe('transfer-failed');
    expect(classify('something new').kind).toBe('other');
  });

  it('ranks by importance and drops duplicate kinds (agent flag + agent finding)', () => {
    const r = rankIssues(['amount above auto-pay threshold', `agent: ${REDIRECT}`, REDIRECT, 'first payment to this vendor']);
    expect(r.map((i) => i.kind)).toEqual(['redirect', 'first-payment', 'threshold']);
  });

  it('writes short list phrases', () => {
    expect(shortPhrase(classify(REDIRECT))).toBe('asks to pay a different address');
    expect(shortPhrase(classify('amount above auto-pay threshold'), { threshold: '100000000' })).toBe('above your 100 limit');
  });
});

describe('buildVerdict', () => {
  it('the approved mockup: changed payout address -> held, three numbered findings', () => {
    const v = buildVerdict(facts({ agentFindings: [REDIRECT], contractReasons: [`agent: ${REDIRECT}`] }));
    expect(v.tone).toBe('held');
    expect(v.label).toBe('Held for you');
    expect(v.headline).toBe('This invoice asks you to pay someone else.');
    expect(v.body).toBe('Everything else checks out. Orvantra will only pay the address Acme Design Studio registered on-chain.');
    expect(v.items.map((i) => [i.n, i.ok, i.title])).toEqual([
      [1, true, 'Known vendor'],
      [2, true, 'Read twice, privately'],
      [3, false, 'Different payout address'],
    ]);
    expect(text(v.items[0].detail)).toBe('orvantra-acme.testnet is registered and approved. Limit 300 per invoice.');
    expect(text(v.items[1].detail)).toBe("Two models agree on 80.00 USDC and INV-2026-0150. Both signed inside NEAR AI's secure hardware.");
    const d = v.items[2].detail;
    expect(text(d)).toBe('Invoice says 0x9999…9999. Registered: 0x3333…3333 on Base.');
    expect(d.find((s) => s.strike)?.text).toBe('0x9999…9999');
    expect(v.items.map((i) => i.anchor)).toEqual(['vendor', 'total', 'payment_instructions']);
    expect(v.outlines).toEqual({ invoice_number: 'ok', total: 'ok', payment_instructions: 'bad' });
    expect(v.outcome).toBe('Held — asks to pay a different address');
  });

  it('only above the auto-pay threshold -> says so and keeps the green checks', () => {
    const v = buildVerdict(facts({ amount: '120000000', contractReasons: ['amount above auto-pay threshold'] }));
    expect(v.headline).toBe('This is above your automatic limit.');
    expect(v.body).toBe('Everything else checks out. Payments over 100 USDC wait for you.');
    expect(v.outcome).toBe('Held — above your 100 limit');
    expect(v.outlines.total).toBe('bad');
    expect(v.items.at(-1)?.title).toBe('Above your automatic limit');
  });

  it('counts the other problems in the body', () => {
    const v = buildVerdict(facts({ contractReasons: ['amount above auto-pay threshold', 'first payment to this vendor', 'payout changed recently'] }));
    expect(v.headline).toBe('Acme Design Studio changed their payout address recently.');
    expect(v.body).toBe('2 more things to check below.');
    expect(text(v.items.find((i) => i.kind === 'fresh-payout')!.detail)).toBe('Acme Design Studio changed their payout address less than 2 minutes ago.');
  });

  it('disagreeing readers replace the green "read twice" finding', () => {
    const v = buildVerdict(facts({ readers: { count: 2, answered: 2, verified: 2, agree: false }, agentFindings: ['readers disagree on total: A=80.00, B=8.00'] }));
    expect(v.headline).toBe('The two readers read this invoice differently.');
    expect(v.items[1]).toMatchObject({ ok: false, title: 'The two readers disagree', anchor: 'total' });
    expect(text(v.items[1].detail)).toBe('Total: one read 80.00, the other 8.00.');
    expect(v.outlines.invoice_number).toBeUndefined();
  });

  it('unverified readings do not claim hardware signatures', () => {
    const v = buildVerdict(facts({ readers: { count: 2, answered: 2, verified: 1, agree: true }, agentFindings: ['verification unavailable for reader B (z-ai/glm-5.3-flash): timeout'] }));
    expect(v.items.some((i) => i.title === 'Read twice, privately')).toBe(false);
    expect(v.items[1].title).toBe('A reading could not be verified');
  });

  it('agent rejection (not registered) -> stopped, no green vendor finding', () => {
    const v = buildVerdict(facts({
      state: 'stopped', vendorName: 'Globex Corp', vendorAccount: 'globex-unknown.testnet', registered: false, approved: false, maxPerInvoice: null, payout: null,
      agentFindings: ['vendor globex-unknown.testnet is not in the vendor registry', 'vendor globex-unknown.testnet is not approved in the treasury policy'],
    }));
    expect(v.tone).toBe('stopped');
    expect(v.headline).toBe('This vendor is not registered.');
    expect(v.body).toBe('Nothing was sent to the treasury.');
    expect(v.outcome).toBe('Stopped — not a registered vendor');
    expect(v.items[0]).toMatchObject({ n: 1, ok: false, title: 'Not a registered vendor', anchor: 'vendor' });
    expect(v.items.filter((i) => i.ok).map((i) => i.kind)).toEqual(['readers']);
  });

  it('duplicate invoice', () => {
    const v = buildVerdict(facts({ state: 'stopped', agentFindings: ['invoice_hash already used in the treasury (duplicate invoice)'] }));
    expect(v.headline).toBe('You have already received this invoice.');
    expect(v.outcome).toBe('Stopped — duplicate invoice');
  });

  it('paid automatically vs approved by the owner', () => {
    expect(buildVerdict(facts({ state: 'paid' })).outcome).toBe('Paid automatically');
    const v = buildVerdict(facts({ state: 'paid', approvedByOwner: true, contractReasons: ['amount above auto-pay threshold'] }));
    expect(v).toMatchObject({ tone: 'paid', label: 'Paid', headline: 'Paid after you approved it.', outcome: 'Paid — approved by you' });
    expect(v.items.every((i) => i.ok)).toBe(true); // resolved holds are not shown as open problems
    expect(v.outlines.total).toBe('ok');
  });

  it('rejected by the owner', () => {
    const v = buildVerdict(facts({ state: 'rejected', contractReasons: ['first payment to this vendor', 'owner: rejected in the Orvantra app'] }));
    expect(v.tone).toBe('stopped');
    expect(v.body).toBe('No money left the treasury.');
    expect(v.items.some((i) => i.title === 'Rejected by you')).toBe(true);
  });

  it('no reader data (payment proposed elsewhere): no reader finding, still a verdict', () => {
    const v = buildVerdict(facts({ readers: null, contractReasons: ['first payment to this vendor'] }));
    expect(v.items.map((i) => i.title)).toEqual(['Known vendor', 'First payment to this vendor']);
    expect(v.headline).toBe('This is your first payment to Acme Design Studio.');
    expect(v.outlines).toEqual({}); // a first-payment hold is policy, not a marked region
    expect(v.items[1].anchor).toBe(null);
  });

  it('a red finding on a region wins over a green one', () => {
    const v = buildVerdict(facts({ agentFindings: ['line items sum to 30.00 USDC but the total is 300.00 USDC'] }));
    expect(v.outlines.total).toBe('bad');
    expect(v.outlines.invoice_number).toBe('ok');
    expect(text(v.items[2].detail)).toBe('The lines add up to 30.00, but the total says 300.00.');
  });

  it('unknown messages are shown as they are, never dropped', () => {
    const v = buildVerdict(facts({ contractReasons: ['registry payout address is not a valid NEAR account id'] }));
    expect(v.items.at(-1)).toMatchObject({ title: 'Check this', ok: false });
    expect(v.outcome).toBe('Held — registry payout address is not a valid NEAR account id');
  });
});
