import { describe, expect, it } from 'vitest';
import { assetSymbol, fmtAmount, fmtDuration, nsToIso, routeLabel, shortAddr, unitFor } from './format';

describe('format', () => {
  it('fmtAmount', () => {
    expect(fmtAmount('80000000')).toBe('80.00');
    expect(fmtAmount('1000000000')).toBe('1,000.00');
    expect(fmtAmount('1000000000', { whole: true })).toBe('1,000');
    expect(fmtAmount('177500000', { whole: true })).toBe('177.50');
    expect(fmtAmount('1234567')).toBe('1.234567');
    expect(fmtAmount(null)).toBe('—');
    expect(fmtAmount('nope')).toBe('—');
  });

  it('routes and units', () => {
    expect(routeLabel({ chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near' }, 'orvantra-tusdc.testnet', 'tUSDC')).toBe('USDC on Base');
    expect(routeLabel({ chain: 'near', asset_id: 'nep141:orvantra-tusdc.testnet' }, 'orvantra-tusdc.testnet', 'tUSDC')).toBe('tUSDC on NEAR');
    expect(assetSymbol('nep141:weird.near', null, 'USDC')).toBe('tokens');
    expect(unitFor('testnet', 'orvantra-tusdc.testnet')).toBe('tUSDC');
    expect(unitFor('mainnet', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')).toBe('USDC');
  });

  it('shortAddr, nsToIso, fmtDuration', () => {
    expect(shortAddr('0x3333333333333333333333333333333333333333')).toBe('0x3333…3333');
    expect(shortAddr('orvantra-acme.testnet')).toBe('orvantra-acme.testnet');
    expect(nsToIso('1793929890001822723')).toBe('2026-11-06T01:51:30.001Z');
    expect(fmtDuration(120)).toBe('2 minutes');
    expect(fmtDuration(3600)).toBe('1 hour');
    expect(fmtDuration(90000)).toBe('1 day');
  });
});
