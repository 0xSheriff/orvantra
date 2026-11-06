// Transaction building/signing and outcome parsing, offline (RPC mocked).
import { createHash } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearViewCache, nearConfig, type NearConfig } from '../src/near.ts';
import { explorerTxUrl, parseOutcome, signAndSend, signTransaction, TGAS, treasuryEvents, type RpcOutcome } from '../src/tx.ts';

const kp = KeyPair.fromRandom('ed25519');
const BLOCK = baseEncode(new Uint8Array(32).fill(7));
const ARGS = { invoice_hash: 'h', vendor: 'orvantra-bob.testnet', amount: '12500000', payout_version: 2, deposit_address: null, quote_hash: null, memo: 'B-0008', agent_flags: null };
const SPEC = { receiverId: 'orvantra-treasury-v2.testnet', methodName: 'propose_payment', args: ARGS, gas: 150n * TGAS, deposit: 0n };

beforeEach(() => clearViewCache());

describe('signTransaction', () => {
  it('builds exactly one function call with the given args/gas/deposit, signed by the key', () => {
    const { hash, base64 } = signTransaction({ signerId: 'orvantra-agent.testnet', keyPair: kp, nonce: 42n, blockHash: BLOCK, spec: SPEC });
    const st = decodeSignedTransaction(Buffer.from(base64, 'base64'));
    const tx = st.transaction;
    expect(tx.signerId).toBe('orvantra-agent.testnet');
    expect(tx.receiverId).toBe('orvantra-treasury-v2.testnet');
    expect(BigInt(tx.nonce)).toBe(42n);
    const pk = tx.publicKey as unknown as { ed25519Key?: { data: Uint8Array }; data?: Uint8Array };
    expect(Buffer.from(pk.ed25519Key?.data ?? pk.data ?? [])).toEqual(Buffer.from(kp.getPublicKey().data));
    expect(tx.actions).toHaveLength(1);
    const fc = tx.actions[0].functionCall!;
    expect(fc.methodName).toBe('propose_payment');
    expect(JSON.parse(Buffer.from(fc.args).toString())).toEqual(ARGS);
    expect(BigInt(fc.gas)).toBe(150n * TGAS);
    expect(BigInt(fc.deposit)).toBe(0n);
    const digest = createHash('sha256').update(encodeTransaction(tx)).digest();
    expect(hash).toBe(baseEncode(digest));
    const sig = st.signature as unknown as { ed25519Signature?: { data: Uint8Array } };
    expect(kp.verify(new Uint8Array(digest), new Uint8Array(sig.ed25519Signature!.data))).toBe(true);
  });

  it('transfer spec builds a Transfer action', () => {
    const { base64 } = signTransaction({ signerId: 'a.testnet', keyPair: kp, nonce: 1n, blockHash: BLOCK, spec: { receiverId: 'a.testnet', transfer: 1n } });
    const tx = decodeSignedTransaction(Buffer.from(base64, 'base64')).transaction;
    expect(BigInt(tx.actions[0].transfer!.deposit)).toBe(1n);
  });
});

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const proposedLog = `EVENT_JSON:${JSON.stringify({ standard: 'orvantra_treasury', version: '1.0.0', event: 'payment_proposed', data: [{ id: 5, status: 'Verifying' }] })}`;
const outcome = (status: RpcOutcome['status'], receipts: RpcOutcome['receipts_outcome'] = []): RpcOutcome => ({
  status,
  transaction_outcome: { outcome: { logs: [], status: {} } },
  receipts_outcome: receipts,
});

describe('parseOutcome / treasuryEvents', () => {
  it('success value of the promise chain + logs from all receipts', () => {
    const o = parseOutcome('H', outcome({ SuccessValue: b64('Paid') }, [
      { outcome: { logs: [proposedLog, 'other log'], status: { SuccessValue: '' } } },
      { outcome: { logs: ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[]}'], status: { SuccessValue: '' } } },
    ]));
    expect(o).toMatchObject({ tx_hash: 'H', success_value: 'Paid', failure: null });
    expect(o.logs).toHaveLength(3);
    expect(treasuryEvents(o.logs).map((e) => e.event)).toEqual(['payment_proposed']);
  });

  it('first failure (transaction or receipt) is reported', () => {
    const fail = { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: invoice already used' } } } };
    expect(parseOutcome('H', outcome({ Failure: fail })).failure).toContain('invoice already used');
    expect(parseOutcome('H', outcome({ SuccessValue: '' }, [{ outcome: { logs: [], status: { Failure: fail } } }])).failure).toContain('invoice already used');
  });

  it('explorer links per network', () => {
    expect(explorerTxUrl('testnet', 'X')).toBe('https://testnet.nearblocks.io/txns/X');
    expect(explorerTxUrl('mainnet', 'X')).toBe('https://nearblocks.io/txns/X');
  });
});

describe('signAndSend (RPC mocked)', () => {
  function rpcMock(handler: (method: string, params: Record<string, unknown>) => unknown) {
    const seen: { method: string; params: Record<string, unknown> }[] = [];
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ method: body.method, params: body.params });
      const r = handler(body.method, body.params);
      return new Response(JSON.stringify(r), { status: 200 });
    });
    const cfg: NearConfig = { ...nearConfig({}), rpcUrls: ['https://rpc.example'], deps: { fetch: f as unknown as typeof fetch, sleep: async () => {} } };
    return { cfg, seen };
  }

  it('uses access-key nonce + 1 and its block hash, sends with wait_until FINAL', async () => {
    const { cfg, seen } = rpcMock((method) =>
      method === 'query'
        ? { result: { nonce: 9, block_hash: BLOCK, permission: 'FullAccess' } }
        : { result: outcome({ SuccessValue: b64('Pending') }, [{ outcome: { logs: [proposedLog], status: { SuccessValue: '' } } }]) },
    );
    const o = await signAndSend(cfg, 'orvantra-agent.testnet', kp, SPEC);
    expect(seen.map((s) => s.method)).toEqual(['query', 'send_tx']);
    expect(seen[0].params).toMatchObject({ request_type: 'view_access_key', public_key: kp.getPublicKey().toString() });
    expect(seen[1].params.wait_until).toBe('FINAL');
    const tx = decodeSignedTransaction(Buffer.from(String(seen[1].params.signed_tx_base64), 'base64')).transaction;
    expect(BigInt(tx.nonce)).toBe(10n);
    expect(o.success_value).toBe('Pending');
    expect(treasuryEvents(o.logs)[0].data[0].id).toBe(5);
  });

  it('a validation error (e.g. MethodNameMismatch) is thrown, not looked up', async () => {
    const { cfg, seen } = rpcMock((method) =>
      method === 'query'
        ? { result: { nonce: 1, block_hash: BLOCK, permission: 'FullAccess' } }
        : { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { MethodNameMismatch: { method_name: 'withdraw' } } } } } } },
    );
    await expect(signAndSend(cfg, 'a.testnet', kp, SPEC)).rejects.toThrow(/MethodNameMismatch/);
    expect(seen.map((s) => s.method)).toEqual(['query', 'send_tx']);
  });

  it('after a send timeout it looks the transaction up by hash (same signed bytes are idempotent)', async () => {
    let sends = 0;
    const { cfg, seen } = rpcMock((method) => {
      if (method === 'query') return { result: { nonce: 1, block_hash: BLOCK, permission: 'FullAccess' } };
      if (method === 'send_tx') {
        sends++;
        return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } };
      }
      return { result: outcome({ SuccessValue: b64('Paid') }) };
    });
    const o = await signAndSend(cfg, 'a.testnet', kp, SPEC);
    expect(o.success_value).toBe('Paid');
    expect(sends).toBeGreaterThan(0);
    const txCall = seen.find((s) => s.method === 'tx')!;
    expect(txCall.params).toMatchObject({ tx_hash: o.tx_hash, sender_account_id: 'a.testnet' });
  });
});
