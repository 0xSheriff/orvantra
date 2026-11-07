import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAINS, CHAIN_LABEL, EVM_CHAINS, MAX_ADDRESS_LEN, MAX_ASSET_ID_LEN, MAX_DISPLAY_NAME_CHARS, MIN_OTHER_ADDRESS_LEN,
  ONECLICK_BLOCKCHAIN, OTHER_CHAINS, addressError, displayNameError, relativeTime, shortAddress, symbolFor, tokenOptions,
} from './registry';

const rust = readFileSync(resolve(import.meta.dirname, '../../contracts/vendor-registry/src/lib.rs'), 'utf8');
const rustList = (name: string) => {
  const m = rust.match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in lib.rs`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};
const rustNum = (name: string) => Number(rust.match(new RegExp(`pub const ${name}: usize = (\\d+);`))?.[1]);

describe('chain list stays in sync with contracts/vendor-registry/src/lib.rs', () => {
  it('has the same EVM and other chains, plus near', () => {
    expect([...EVM_CHAINS]).toEqual(rustList('EVM_CHAINS'));
    expect([...OTHER_CHAINS]).toEqual(rustList('OTHER_CHAINS'));
    expect(rust).toContain('if chain == "near"');
    expect([...CHAINS].sort()).toEqual(['near', ...rustList('EVM_CHAINS'), ...rustList('OTHER_CHAINS')].sort());
  });

  it('has the same limits', () => {
    expect(MAX_DISPLAY_NAME_CHARS).toBe(rustNum('MAX_DISPLAY_NAME_CHARS'));
    expect(MAX_ASSET_ID_LEN).toBe(rustNum('MAX_ASSET_ID_LEN'));
    expect(MAX_ADDRESS_LEN).toBe(rustNum('MAX_ADDRESS_LEN'));
    expect(MIN_OTHER_ADDRESS_LEN).toBe(rustNum('MIN_OTHER_ADDRESS_LEN'));
  });

  it('names and maps every chain', () => {
    for (const c of CHAINS) {
      expect(CHAIN_LABEL[c]).toBeTruthy();
      expect(ONECLICK_BLOCKCHAIN[c]).toBeTruthy();
    }
  });
});

describe('address validation (mirrors validate_address)', () => {
  it('near: valid account ids only', () => {
    for (const ok of ['acme.near', 'orvantra-bob.testnet', 'a_b.c-d.testnet', 'ab', 'f'.repeat(64)]) expect(addressError('near', ok)).toBeNull();
    for (const bad of ['', 'A.near', 'a', 'acme..near', '-acme.near', 'acme.near.', 'acme near', 'x'.repeat(65)]) expect(addressError('near', bad)).not.toBeNull();
  });

  it('EVM: 0x + 40 hex', () => {
    expect(addressError('base', `0x${'3'.repeat(40)}`)).toBeNull();
    expect(addressError('eth', '0xAbCdEf0123456789abcdef0123456789ABCDEF01')).toBeNull();
    expect(addressError('base', '0xBAD')).toBe('A Base address is 0x followed by 40 hex characters.');
    expect(addressError('arbitrum', `0x${'g'.repeat(40)}`)).not.toBeNull();
    expect(addressError('polygon', `${'3'.repeat(42)}`)).not.toBeNull();
  });

  it('other chains: 20..128 printable, no spaces', () => {
    expect(addressError('solana', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')).toBeNull();
    expect(addressError('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBeNull();
    expect(addressError('solana', 'short')).not.toBeNull();
    expect(addressError('ton', 'has a space in the address')).not.toBeNull();
    expect(addressError('sui', 'x'.repeat(129))).not.toBeNull();
  });

  it('unknown chain and display names', () => {
    expect(addressError('dogecoin', 'D'.repeat(30))).toBe('Choose a network.');
    expect(displayNameError('Acme Design Studio')).toBeNull();
    expect(displayNameError('   ')).not.toBeNull();
    expect(displayNameError('x'.repeat(65))).not.toBeNull();
    expect(displayNameError('a\nb')).not.toBeNull();
  });
});

describe('token options from the 1Click token list', () => {
  const tokens = [
    { blockchain: 'near', symbol: 'USDC', assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' },
    { blockchain: 'near', symbol: 'USDT', assetId: 'nep141:usdt.tether-token.near' },
    { blockchain: 'near', symbol: 'wNEAR', assetId: 'nep141:wrap.near' },
    { blockchain: 'base', symbol: 'USDC', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near' },
    { blockchain: 'arb', symbol: 'USDC', assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near' },
    { blockchain: 'arb', symbol: 'USDT0', assetId: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near' },
    { blockchain: 'tron', symbol: 'USDT', assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near' },
    { blockchain: 'sol', symbol: 'USDC', assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near' },
  ];

  it('offers USDC, USDT where listed (not USDT0), exact asset ids, and nothing for unlisted chains', () => {
    const o = tokenOptions(tokens, { network: 'mainnet', testToken: 'orvantra-tusdc.testnet' });
    expect(o.near.map((t) => t.symbol)).toEqual(['USDC', 'USDT']);
    expect(o.base).toEqual([{ symbol: 'USDC', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near' }]);
    expect(o.arbitrum.map((t) => t.symbol)).toEqual(['USDC']);
    expect(o.tron.map((t) => t.symbol)).toEqual(['USDT']);
    expect(o.solana[0].assetId).toBe('nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near');
    expect(o.btc).toEqual([]);
  });

  it('adds tUSDC first on testnet near only', () => {
    const o = tokenOptions(tokens, { network: 'testnet', testToken: 'orvantra-tusdc.testnet' });
    expect(o.near[0]).toEqual({ symbol: 'tUSDC', assetId: 'nep141:orvantra-tusdc.testnet' });
    expect(o.base.map((t) => t.symbol)).toEqual(['USDC']);
    expect(symbolFor(o, 'near', 'nep141:orvantra-tusdc.testnet')).toBe('tUSDC');
    expect(symbolFor(o, 'eth', 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near')).toBe('USDT');
  });
});

describe('formatting', () => {
  it('shortens addresses and says how long ago', () => {
    expect(shortAddress(`0x${'3'.repeat(40)}`)).toBe('0x3333…3333');
    expect(shortAddress('acme.near')).toBe('acme.near');
    expect(shortAddress('orvantra-bob.testnet')).toBe('orvantra-bob.testnet');
    const now = 1_800_000_000_000;
    const ns = (msAgo: number) => String(BigInt(now - msAgo) * 1_000_000n);
    expect(relativeTime(ns(10_000), now)).toBe('just now');
    expect(relativeTime(ns(3 * 60_000), now)).toBe('3 minutes ago');
    expect(relativeTime(ns(3_600_000), now)).toBe('1 hour ago');
    expect(relativeTime(ns(2 * 86_400_000), now)).toBe('2 days ago');
  });
});
