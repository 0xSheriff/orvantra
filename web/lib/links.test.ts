import { describe, expect, it } from 'vitest';
import { explorerAccountUrl, siteLinks } from './links';

const c = { network: 'testnet', treasuryId: 't.testnet', registryId: 'r.testnet' };

describe('siteLinks', () => {
  it('uses the explorer per network', () => {
    expect(explorerAccountUrl('testnet', 'a.testnet')).toBe('https://testnet.nearblocks.io/address/a.testnet');
    expect(explorerAccountUrl('mainnet', 'a.near')).toBe('https://nearblocks.io/address/a.near');
  });

  it('defaults the vendor link to the registry on the explorer and hides an unset repo', () => {
    expect(siteLinks({}, c)).toEqual({
      vendorUrl: 'https://testnet.nearblocks.io/address/r.testnet',
      repoUrl: null,
      treasuryExplorer: 'https://testnet.nearblocks.io/address/t.testnet',
      registryExplorer: 'https://testnet.nearblocks.io/address/r.testnet',
    });
    expect(siteLinks({ NEXT_PUBLIC_REPO_URL: '  ' }, c).repoUrl).toBeNull();
  });

  it('prefers the env urls when set', () => {
    const l = siteLinks({ NEXT_PUBLIC_VENDOR_URL: 'https://x.example/register', NEXT_PUBLIC_REPO_URL: 'https://github.com/o/r' }, c);
    expect(l.vendorUrl).toBe('https://x.example/register');
    expect(l.repoUrl).toBe('https://github.com/o/r');
  });
});
