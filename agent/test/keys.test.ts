import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addKeyCommand, checkKeyPermission, generateAgentKey, keyPath, loadKey, saveKey } from '../src/keys.ts';

const env = () => ({ ORVANTRA_KEYS_DIR: mkdtempSync(join(tmpdir(), 'orv-keys-')) });

describe('agent key file', () => {
  it('lives in <root>/<network>/<account>.json, never in the repo', () => {
    const e = env();
    expect(keyPath('testnet', 'orvantra-agent.testnet', e)).toBe(join(e.ORVANTRA_KEYS_DIR, 'testnet', 'orvantra-agent.testnet.json'));
    expect(keyPath('testnet', 'a.testnet', {})).toMatch(/\.orvantra\/keys\/testnet\/a\.testnet\.json$/);
    expect(() => keyPath('test/../x', 'a.testnet', e)).toThrow(/bad network/);
    expect(() => keyPath('testnet', '../evil', e)).toThrow(/not a valid NEAR account/);
  });

  it('generate + save: mode 600, ed25519, round-trips through loadKey', () => {
    const p = keyPath('testnet', 'orvantra-agent.testnet', env());
    const k = generateAgentKey('orvantra-agent.testnet', 'orvantra-treasury-v2.testnet', 'testnet');
    expect(k.public_key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(k.private_key).toMatch(/^ed25519:/);
    expect(k.methods).toEqual(['propose_payment']);
    saveKey(p, k);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const { key, keyPair } = loadKey(p);
    expect(key.public_key).toBe(k.public_key);
    const msg = new Uint8Array([1, 2, 3]);
    expect(keyPair.verify(msg, keyPair.sign(msg).signature)).toBe(true);
  });

  it('refuses to overwrite without force', () => {
    const p = keyPath('testnet', 'a.testnet', env());
    saveKey(p, generateAgentKey('a.testnet', 't.testnet', 'testnet'));
    expect(() => saveKey(p, generateAgentKey('a.testnet', 't.testnet', 'testnet'))).toThrow(/already exists/);
    saveKey(p, generateAgentKey('a.testnet', 't.testnet', 'testnet'), true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('loadKey rejects group/world-readable files and mismatched key pairs', () => {
    const p = keyPath('testnet', 'a.testnet', env());
    const k = generateAgentKey('a.testnet', 't.testnet', 'testnet');
    saveKey(p, k);
    chmodSync(p, 0o644);
    expect(() => loadKey(p)).toThrow(/readable by other users/);
    chmodSync(p, 0o600);
    const other = generateAgentKey('a.testnet', 't.testnet', 'testnet');
    writeFileSync(p, JSON.stringify({ ...k, public_key: other.public_key }));
    expect(() => loadKey(p)).toThrow(/does not match/);
    expect(() => loadKey(`${p}.missing`)).toThrow(/setup-agent-key/);
    expect(readFileSync(p, 'utf8')).not.toContain(other.private_key);
  });
});

describe('addKeyCommand', () => {
  it('prints the exact near-cli-rs function-call key command', () => {
    expect(addKeyCommand({ account: 'orvantra-agent.testnet', contract: 'orvantra-treasury-v2.testnet', publicKey: 'ed25519:ABC', network: 'testnet' })).toBe(
      [
        'near account add-key orvantra-agent.testnet',
        "grant-function-call-access --allowance '0.25 NEAR'",
        "--contract-account-id orvantra-treasury-v2.testnet --function-names 'propose_payment'",
        'use-manually-provided-public-key ed25519:ABC',
        'network-config testnet sign-with-legacy-keychain send',
      ].join(' \\\n  '),
    );
  });
});

describe('checkKeyPermission', () => {
  const fc = (receiver_id: string, method_names: string[]) => ({ FunctionCall: { allowance: '250000000000000000000000', receiver_id, method_names } });
  it('accepts exactly a propose_payment key for the treasury', () => {
    expect(checkKeyPermission(fc('t.testnet', ['propose_payment']), 't.testnet')).toBeNull();
  });
  it('rejects full access, other receivers, extra or "any" methods', () => {
    expect(checkKeyPermission('FullAccess', 't.testnet')).toMatch(/FULL-ACCESS/);
    expect(checkKeyPermission(fc('token.testnet', ['propose_payment']), 't.testnet')).toMatch(/for token\.testnet/);
    expect(checkKeyPermission(fc('t.testnet', ['propose_payment', 'withdraw']), 't.testnet')).toMatch(/expected exactly/);
    expect(checkKeyPermission(fc('t.testnet', []), 't.testnet')).toMatch(/ANY/);
  });
});
