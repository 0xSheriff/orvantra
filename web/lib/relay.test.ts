import { describe, expect, it } from 'vitest';
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { Signature, SignedDelegate, actionCreators, buildDelegateAction, encodeSignedDelegate } from '@near-js/transactions';
import type { Action } from '@near-js/transactions';
import {
  DEPOSIT_CAP, RateLimiter, checkAccessKey, checkSignedDelegate, clientIp, decodeSignedDelegate, delegateKeyString, maxSetVendorDeposit, outcomeFailure,
} from './relay';

const REGISTRY = 'orvantra-registry.testnet';
const TGAS = 1_000_000_000_000n;
const YOCTO = 1n; // remove_vendor needs exactly 1 yoctoNEAR; set_vendor at least 1 plus its storage deposit
const ESTIMATE = 4_900_000_000_000_000_000_000n; // 0.0049 NEAR, what storage_cost_estimate returns for a typical entry
const MAX_DEPOSIT = maxSetVendorDeposit(ESTIMATE);
const kp = KeyPair.fromRandom('ed25519');
const signer = new KeyPairSigner(kp);
const args = { display_name: 'Acme', chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', address: `0x${'3'.repeat(40)}` };

async function signed(o: { receiverId?: string; actions?: Action[]; maxBlockHeight?: bigint; senderId?: string } = {}): Promise<string> {
  const da = buildDelegateAction({
    senderId: o.senderId ?? 'acme.testnet',
    receiverId: o.receiverId ?? REGISTRY,
    actions: o.actions ?? [actionCreators.functionCall('set_vendor', args, 30n * TGAS, YOCTO)],
    nonce: 7n,
    maxBlockHeight: o.maxBlockHeight ?? 1_100n,
    publicKey: kp.getPublicKey(),
  });
  const [, sd] = await signer.signDelegateAction(da);
  return Buffer.from(encodeSignedDelegate(sd)).toString('base64');
}

const check = async (b64: Promise<string>, currentHeight = 1_000n) =>
  checkSignedDelegate(decodeSignedDelegate(await b64), { registryId: REGISTRY, currentHeight, maxSetVendorDeposit: MAX_DEPOSIT });

describe('relay policy', () => {
  it('accepts set_vendor and remove_vendor on the registry', async () => {
    expect(await check(signed())).toEqual({ ok: true, senderId: 'acme.testnet', method: 'set_vendor' });
    const rm = await check(signed({ actions: [actionCreators.functionCall('remove_vendor', {}, 10n * TGAS, YOCTO)] }));
    expect(rm).toMatchObject({ ok: true, method: 'remove_vendor' });
  });

  it('rejects a different receiver', async () => {
    const r = await check(signed({ receiverId: 'orvantra-treasury-v4.testnet' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/vendor registry/);
  });

  it('rejects another method', async () => {
    const r = await check(signed({ actions: [actionCreators.functionCall('get_vendor', {}, 10n * TGAS, YOCTO)] }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Only set_vendor and remove_vendor/) });
  });

  it('set_vendor: accepts 1 yocto up to the storage estimate plus margin, nothing above', async () => {
    const set = (deposit: bigint) => check(signed({ actions: [actionCreators.functionCall('set_vendor', args, 30n * TGAS, deposit)] }));
    for (const deposit of [YOCTO, ESTIMATE, MAX_DEPOSIT]) expect(await set(deposit)).toMatchObject({ ok: true });
    for (const deposit of [0n, MAX_DEPOSIT + 1n, 10n ** 24n]) expect(await set(deposit)).toMatchObject({ ok: false, reason: expect.stringMatching(/storage deposit/) });
  });

  it('remove_vendor: exactly 1 yoctoNEAR', async () => {
    for (const deposit of [0n, 2n, ESTIMATE]) {
      const r = await check(signed({ actions: [actionCreators.functionCall('remove_vendor', {}, 30n * TGAS, deposit)] }));
      expect(r).toMatchObject({ ok: false, reason: 'Exactly 1 yoctoNEAR must be attached.' });
    }
  });

  it('caps the allowed deposit at 0.05 NEAR even for a huge estimate', () => {
    expect(maxSetVendorDeposit(10n ** 25n)).toBe(DEPOSIT_CAP);
    expect(maxSetVendorDeposit(ESTIMATE)).toBe(ESTIMATE + 10n ** 21n);
  });

  it('rejects more than 30 TGas', async () => {
    const r = await check(signed({ actions: [actionCreators.functionCall('set_vendor', args, 30n * TGAS + 1n, YOCTO)] }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/30 TGas/) });
  });

  it('rejects multiple actions and non-function-call actions', async () => {
    const two = [actionCreators.functionCall('set_vendor', args, 10n * TGAS, YOCTO), actionCreators.functionCall('remove_vendor', {}, 10n * TGAS, YOCTO)];
    expect(await check(signed({ actions: two }))).toMatchObject({ ok: false, reason: 'Exactly one action is allowed.' });
    expect(await check(signed({ actions: [actionCreators.transfer(1n)] }))).toMatchObject({ ok: false, reason: 'Only a function call is allowed.' });
  });

  it('rejects an expired delegate (max_block_height reached)', async () => {
    expect(await check(signed({ maxBlockHeight: 1_000n }), 1_000n)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it('rejects a delegate valid for more than 1000 blocks', async () => {
    expect(await check(signed({ maxBlockHeight: 2_000n }), 1_000n)).toMatchObject({ ok: true });
    expect(await check(signed({ maxBlockHeight: 2_001n }), 1_000n)).toMatchObject({ ok: false, reason: expect.stringMatching(/too long/) });
  });

  it('rejects a forged signature', async () => {
    const sd = decodeSignedDelegate(await signed());
    const other = KeyPair.fromRandom('ed25519');
    const forged = new SignedDelegate({
      delegateAction: sd.delegateAction,
      signature: new Signature({ keyType: 0, data: other.sign(new Uint8Array(32)).signature }),
    });
    const b64 = Buffer.from(encodeSignedDelegate(forged)).toString('base64');
    expect(checkSignedDelegate(decodeSignedDelegate(b64), { registryId: REGISTRY, currentHeight: 1n, maxSetVendorDeposit: MAX_DEPOSIT })).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it('refuses garbage and oversized input', () => {
    expect(() => decodeSignedDelegate('')).toThrow();
    expect(() => decodeSignedDelegate(Buffer.alloc(5000).toString('base64'))).toThrow();
    expect(() => decodeSignedDelegate('AAAA')).toThrow();
  });
});

describe('access key check', () => {
  const sdOf = async () => decodeSignedDelegate(await signed()); // nonce 7

  it('accepts a full-access key with a lower nonce', async () => {
    expect(checkAccessKey(await sdOf(), { nonce: 6, permission: 'FullAccess' })).toMatchObject({ ok: true, senderId: 'acme.testnet' });
  });

  it('refuses a missing key or account', async () => {
    expect(checkAccessKey(await sdOf(), null)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
  });

  it('refuses a function-call key (it cannot attach the deposit)', async () => {
    const fcKey = { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: REGISTRY, method_names: ['set_vendor'] } } };
    expect(checkAccessKey(await sdOf(), fcKey)).toMatchObject({ ok: false, reason: expect.stringMatching(/full-access/) });
  });

  it('refuses a nonce that is not above the key nonce (replay / stale)', async () => {
    expect(checkAccessKey(await sdOf(), { nonce: 7, permission: 'FullAccess' })).toMatchObject({ ok: false, reason: expect.stringMatching(/outdated/) });
    expect(checkAccessKey(await sdOf(), { nonce: '9007199254740993', permission: 'FullAccess' }).ok).toBe(false);
  });

  it('reads the delegate key in NEAR text form', async () => {
    expect(delegateKeyString(await sdOf())).toBe(kp.getPublicKey().toString());
  });
});

describe('client ip', () => {
  const h = (v: string | null) => ({ get: (n: string) => (n === 'x-forwarded-for' ? v : null) });
  it('uses the first x-forwarded-for hop', () => {
    expect(clientIp(h('203.0.113.9, 10.0.0.1'))).toBe('203.0.113.9');
    expect(clientIp(h(null))).toBe('unknown');
    expect(clientIp(h(''))).toBe('unknown');
  });
});

describe('rate limit', () => {
  it('allows 5 per hour per sender, then refuses until the window slides', () => {
    const rl = new RateLimiter(5, 3_600_000);
    for (let i = 0; i < 5; i++) expect(rl.take('acme.testnet', 1_000 + i)).toBe(true);
    expect(rl.take('acme.testnet', 2_000)).toBe(false);
    expect(rl.take('bob.testnet', 2_000)).toBe(true);
    expect(rl.take('acme.testnet', 1_000 + 3_600_000)).toBe(true);
  });

  it('prunes keys whose hits are all outside the window', () => {
    const rl = new RateLimiter(5, 3_600_000);
    for (let i = 0; i < 50; i++) rl.take(`ip-${i}`, 1_000);
    expect(rl.size).toBe(50);
    rl.take('late', 1_000 + 3_700_000);
    expect(rl.size).toBe(1);
  });

  it('also works as the 10/hour per-IP and 60/hour global limits', () => {
    const ip = new RateLimiter(10, 3_600_000);
    const all = new RateLimiter(60, 3_600_000);
    expect(Array.from({ length: 11 }, () => ip.take('1.2.3.4', 5)).filter(Boolean)).toHaveLength(10);
    expect(Array.from({ length: 61 }, () => all.take('all', 5)).filter(Boolean)).toHaveLength(60);
  });
});

describe('outcomeFailure', () => {
  it('finds a receipt failure and the panic message', () => {
    const outcome = {
      status: { SuccessValue: '' },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: 'x' } } },
      receipts_outcome: [
        { outcome: { status: { SuccessValue: '' } } },
        { outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: address must be 0x followed by 40 hex chars' } } } } } } },
      ],
    };
    expect(outcomeFailure(outcome)).toBe('address must be 0x followed by 40 hex chars');
    expect(outcomeFailure({ status: { SuccessValue: '' }, receipts_outcome: [] })).toBeNull();
    // anything that is not a contract panic becomes a generic sentence (no raw RPC text for the browser)
    expect(outcomeFailure({ status: { Failure: { InvalidTxError: { NotEnoughBalance: { signer_id: 'x' } } } } })).toBe('The transaction failed on NEAR.');
  });
});
