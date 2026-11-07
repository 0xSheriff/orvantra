import { describe, expect, it } from 'vitest';
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { Signature, SignedDelegate, actionCreators, buildDelegateAction, encodeSignedDelegate } from '@near-js/transactions';
import type { Action } from '@near-js/transactions';
import { RateLimiter, checkSignedDelegate, decodeSignedDelegate, outcomeFailure } from './relay';

const REGISTRY = 'orvantra-registry.testnet';
const TGAS = 1_000_000_000_000n;
const YOCTO = 1n; // the registry requires exactly 1 yoctoNEAR on set_vendor / remove_vendor
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
  checkSignedDelegate(decodeSignedDelegate(await b64), { registryId: REGISTRY, currentHeight });

describe('relay policy', () => {
  it('accepts set_vendor and remove_vendor on the registry', async () => {
    expect(await check(signed())).toEqual({ ok: true, senderId: 'acme.testnet', method: 'set_vendor' });
    const rm = await check(signed({ actions: [actionCreators.functionCall('remove_vendor', {}, 10n * TGAS, YOCTO)] }));
    expect(rm).toMatchObject({ ok: true, method: 'remove_vendor' });
  });

  it('rejects a different receiver', async () => {
    const r = await check(signed({ receiverId: 'orvantra-treasury-v3.testnet' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/vendor registry/);
  });

  it('rejects another method', async () => {
    const r = await check(signed({ actions: [actionCreators.functionCall('get_vendor', {}, 10n * TGAS, YOCTO)] }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Only set_vendor and remove_vendor/) });
  });

  it('requires exactly 1 yoctoNEAR: rejects 0 and anything above 1', async () => {
    const reason = 'Exactly 1 yoctoNEAR must be attached.';
    for (const method of ['set_vendor', 'remove_vendor']) {
      for (const deposit of [0n, 2n, 10n ** 24n]) {
        const r = await check(signed({ actions: [actionCreators.functionCall(method, method === 'set_vendor' ? args : {}, 30n * TGAS, deposit)] }));
        expect(r).toMatchObject({ ok: false, reason });
      }
    }
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

  it('rejects a forged signature', async () => {
    const sd = decodeSignedDelegate(await signed());
    const other = KeyPair.fromRandom('ed25519');
    const forged = new SignedDelegate({
      delegateAction: sd.delegateAction,
      signature: new Signature({ keyType: 0, data: other.sign(new Uint8Array(32)).signature }),
    });
    const b64 = Buffer.from(encodeSignedDelegate(forged)).toString('base64');
    expect(checkSignedDelegate(decodeSignedDelegate(b64), { registryId: REGISTRY, currentHeight: 1n })).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it('refuses garbage and oversized input', () => {
    expect(() => decodeSignedDelegate('')).toThrow();
    expect(() => decodeSignedDelegate(Buffer.alloc(5000).toString('base64'))).toThrow();
    expect(() => decodeSignedDelegate('AAAA')).toThrow();
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
  });
});
