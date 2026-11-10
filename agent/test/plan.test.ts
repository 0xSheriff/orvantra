// Path selection, quote expectations, agent flags and propose_payment args. Pure, offline.
import { describe, expect, it } from 'vitest';
import type { Decision } from '../src/checks.ts';
import type { TreasuryConfig } from '../src/near.ts';
import { MAINNET_USDC_NEAR } from '../src/oneclick.ts';
import {
  agentFlags, buildProposeArgs, DEFAULT_SIM_DEPOSIT_ACCOUNT, DEFAULT_SIM_QUOTE_REFUND_TO, memoFor, preflightProblems, quoteExpectation, selectPath,
} from '../src/plan.ts';

const TOKEN = 'orvantra-tusdc.testnet';
const BOB = { chain: 'near', asset_id: `nep141:${TOKEN}`, address: 'orvantra-bob.testnet' };
const ACME = { chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', address: '0x3333333333333333333333333333333333333333' };

describe('selectPath', () => {
  it('direct when the vendor wants the treasury token on NEAR (any network)', () => {
    expect(selectPath('testnet', BOB, TOKEN)).toBe('direct');
    expect(selectPath('mainnet', { ...BOB, asset_id: `nep141:${MAINNET_USDC_NEAR.slice(7)}` }, MAINNET_USDC_NEAR.slice(7))).toBe('direct');
  });
  it('cross-chain: real 1Click on mainnet, simulated on testnet', () => {
    expect(selectPath('mainnet', ACME, TOKEN)).toBe('oneclick');
    expect(selectPath('testnet', ACME, TOKEN)).toBe('oneclick-simulated');
  });
  it('NEAR chain but a different token is NOT direct', () => {
    expect(selectPath('testnet', { ...BOB, asset_id: 'nep141:wrap.testnet' }, TOKEN)).toBe('oneclick-simulated');
    expect(selectPath('testnet', { ...BOB, chain: 'NEAR' }, TOKEN)).toBe('oneclick-simulated');
  });
});

describe('quoteExpectation', () => {
  const base = { payout: ACME, amount: '120000000', treasuryId: 'treasury.near', treasuryToken: MAINNET_USDC_NEAR.slice(7) };
  it('direct: no quote', () => {
    expect(quoteExpectation({ ...base, path: 'direct', dry: false })).toBeNull();
  });
  it('mainnet: treasury token in, registry payout out, refunds to the treasury', () => {
    expect(quoteExpectation({ ...base, path: 'oneclick', dry: false })).toEqual({
      dry: false, originAsset: MAINNET_USDC_NEAR, destinationAsset: ACME.asset_id, recipient: ACME.address, amount: '120000000', refundTo: 'treasury.near',
    });
  });
  it('testnet simulated: always dry, MAINNET USDC in, mainnet stand-in refundTo', () => {
    const e = quoteExpectation({ ...base, treasuryToken: TOKEN, treasuryId: 'orvantra-treasury-v2.testnet', path: 'oneclick-simulated', dry: false });
    expect(e).toEqual({ dry: true, originAsset: MAINNET_USDC_NEAR, destinationAsset: ACME.asset_id, recipient: ACME.address, amount: '120000000', refundTo: DEFAULT_SIM_QUOTE_REFUND_TO });
    expect(quoteExpectation({ ...base, path: 'oneclick-simulated', dry: true, simRefundTo: 'me.near' })?.refundTo).toBe('me.near');
  });
});

const decision = (action: Decision['action'], holds: string[], rejects: string[] = []): Pick<Decision, 'action' | 'findings'> => ({
  action,
  findings: [...rejects.map((message) => ({ level: 'reject' as const, message })), ...holds.map((message) => ({ level: 'hold' as const, message }))],
});

describe('agentFlags (Day-4 holds -> on-chain agent_flags)', () => {
  it('propose => no flags; hold => the hold reasons', () => {
    expect(agentFlags(decision('propose', []))).toEqual([]);
    expect(agentFlags(decision('hold', ['invoice asks to pay a different address — ignored']))).toEqual(['invoice asks to pay a different address — ignored']);
  });
  it('fits the contract bounds: <= 8 flags, each <= 200 chars', () => {
    const many = Array.from({ length: 11 }, (_, i) => `reason ${i}`);
    const f = agentFlags(decision('hold', many));
    expect(f).toHaveLength(8);
    expect(f[7]).toBe('+4 more hold reasons (see agent ledger)');
    const long = agentFlags(decision('hold', ['é'.repeat(500)]))[0];
    expect([...long]).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
  it('drops blank reasons (the contract rejects empty flags)', () => {
    expect(agentFlags(decision('hold', ['  ', 'x']))).toEqual(['x']);
  });
});

describe('buildProposeArgs', () => {
  const common = { invoiceHash: 'ab'.repeat(32), vendor: 'orvantra-acme.testnet', amount: '120000000', payoutVersion: 2, invoiceNumber: 'INV-2026-0142', flags: [] };
  it('cross-chain: deposit address + quote hash + memo, no flags => null', () => {
    expect(buildProposeArgs({ ...common, path: 'oneclick-simulated', depositAddress: DEFAULT_SIM_DEPOSIT_ACCOUNT, quoteHash: 'QH' })).toEqual({
      invoice_hash: 'ab'.repeat(32), vendor: 'orvantra-acme.testnet', amount: '120000000', payout_version: 2,
      deposit_address: DEFAULT_SIM_DEPOSIT_ACCOUNT, quote_hash: 'QH', memo: 'INV-2026-0142', agent_flags: null,
    });
  });
  it('direct: never sends a deposit address or quote hash', () => {
    const a = buildProposeArgs({ ...common, path: 'direct', depositAddress: 'ignored.testnet', quoteHash: 'QH', flags: ['f'] });
    expect([a.deposit_address, a.quote_hash, a.agent_flags]).toEqual([null, null, ['f']]);
  });
  it('refuses a cross-chain proposal without a deposit address, and bad amounts', () => {
    expect(() => buildProposeArgs({ ...common, path: 'oneclick', depositAddress: null, quoteHash: 'QH' })).toThrow(/deposit address/);
    expect(() => buildProposeArgs({ ...common, amount: '0', path: 'direct', depositAddress: null, quoteHash: null })).toThrow(/bad amount/);
    expect(() => buildProposeArgs({ ...common, amount: '1.5', path: 'direct', depositAddress: null, quoteHash: null })).toThrow(/bad amount/);
  });
  it('the simulated deposit account is a 64-hex implicit account (the treasury rejects named accounts)', () => {
    expect(DEFAULT_SIM_DEPOSIT_ACCOUNT).toMatch(/^[0-9a-f]{64}$/);
  });
  it('refuses a deposit address that is not a 64-hex implicit account', () => {
    for (const bad of ['orvantra-1click-sim.testnet', 'AB'.repeat(32), 'ab'.repeat(31)]) {
      expect(() => buildProposeArgs({ ...common, path: 'oneclick', depositAddress: bad, quoteHash: 'QH' })).toThrow(/64-hex implicit/);
    }
  });
  it('asserts invoice_hash is 64 lowercase hex', () => {
    for (const bad of ['h1', 'AB'.repeat(32), 'ab'.repeat(31), '']) {
      expect(() => buildProposeArgs({ ...common, invoiceHash: bad, path: 'direct', depositAddress: null, quoteHash: null })).toThrow(/64 lowercase hex/);
    }
  });
  it('memo is bounded to 256 bytes', () => {
    expect(memoFor(null)).toBeNull();
    expect(Buffer.byteLength(memoFor('€'.repeat(200))!, 'utf8')).toBeLessThanOrEqual(256);
  });
});

describe('preflightProblems', () => {
  const config: TreasuryConfig = {
    owner: 'o.testnet', agent: 'orvantra-agent.testnet', registry: 'r.testnet', token: TOKEN, auto_pay_threshold: '1', monthly_cap: '1',
    min_payout_age_sec: 0, storage_deposit: '1250000000000000000000', cross_chain_auto_pay_threshold: '0', paused: false, payment_count: 0,
  };
  it('ok', () => expect(preflightProblems({ config, signerId: 'orvantra-agent.testnet', storageMin: '1250000000000000000000' })).toEqual([]));
  it('paused, wrong signer, storage deposit below token minimum, pre-Day-5 treasury', () => {
    expect(preflightProblems({ config: { ...config, paused: true }, signerId: 'x.testnet', storageMin: '2250000000000000000000' })).toHaveLength(3);
    const { storage_deposit: _, ...old } = config;
    expect(preflightProblems({ config: old, signerId: config.agent, storageMin: null })[0]).toMatch(/pre-Day-5/);
    const { cross_chain_auto_pay_threshold: __, ...v3 } = config;
    expect(preflightProblems({ config: v3, signerId: config.agent, storageMin: null })[0]).toMatch(/pre-v4/);
  });
});
