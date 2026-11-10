import { describe, expect, it } from 'vitest';
import { MAX_ENTRY_BYTES, TYPICAL_ENTRY_BYTES, depositSentence, feeSentence, formatNear } from './registry';

describe('storage deposit copy', () => {
  it('formats yoctoNEAR as NEAR, rounded up to 4 decimals', () => {
    expect(formatNear(4_900_000_000_000_000_000_000n)).toBe('0.0049');
    expect(formatNear(4_901_000_000_000_000_000_000n)).toBe('0.005');
    expect(formatNear(10n ** 22n)).toBe('0.01');
    expect(formatNear(1n)).toBe('0.0001');
    expect(formatNear(2n * 10n ** 24n)).toBe('2');
  });

  it('says what the registry view says (gasless wallets)', () => {
    expect(feeSentence(true, 4_900_000_000_000_000_000_000n)).toBe(
      'Orvantra pays the network fee. New entries hold a small refundable deposit (≈0.0049 NEAR) that comes back if you remove your entry.',
    );
  });

  it('says the vendor pays a tiny fee plus the deposit (other wallets)', () => {
    const s = feeSentence(false, 4_900_000_000_000_000_000_000n);
    expect(s).toContain('pay a tiny network fee (under 0.01 NEAR) plus the refundable deposit');
    expect(s).toContain('≈0.0049 NEAR');
  });

  it('stays true when the estimate is unknown', () => {
    expect(depositSentence(null)).toBe('New entries hold a small refundable deposit that comes back if you remove your entry.');
  });

  it('asks the registry for a typical and for the largest entry', () => {
    expect(TYPICAL_ENTRY_BYTES.display_name_len).toBeLessThan(MAX_ENTRY_BYTES.display_name_len);
    expect(MAX_ENTRY_BYTES).toEqual({ display_name_len: 256, address_len: 128, asset_len: 128 });
  });
});
