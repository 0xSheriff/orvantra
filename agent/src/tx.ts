// Sign + send NEAR transactions with the agent's key, over the same RPC failover as views (near.ts).
import { createHash } from 'node:crypto';
import type { KeyPair } from '@near-js/crypto';
import { actionCreators, createTransaction, Signature, SignedTransaction, type Action } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { getAccessKey, rpc, type NearConfig } from './near.ts';

export const TGAS = 1_000_000_000_000n;

export interface FunctionCallSpec {
  receiverId: string;
  methodName: string;
  args: object;
  gas: bigint;
  /** yoctoNEAR; function-call access keys can only send 0. */
  deposit: bigint;
}

/** Plain NEAR transfer (used by prove-key-limits to show that a function-call key cannot do it). */
export interface TransferSpec {
  receiverId: string;
  transfer: bigint;
}

export type TxSpec = FunctionCallSpec | TransferSpec;

export interface TxOutcome {
  tx_hash: string;
  /** `SuccessValue` decoded as JSON when possible (the final value of the promise chain). */
  success_value: unknown;
  /** First failure found in the transaction or any receipt, as JSON text. null = everything succeeded. */
  failure: string | null;
  /** All logs from all receipts, in order. */
  logs: string[];
}

export function explorerTxUrl(network: string, txHash: string): string {
  return network === 'mainnet' ? `https://nearblocks.io/txns/${txHash}` : `https://testnet.nearblocks.io/txns/${txHash}`;
}

function toAction(spec: TxSpec): Action {
  if ('transfer' in spec) return actionCreators.transfer(spec.transfer);
  return actionCreators.functionCall(spec.methodName, Buffer.from(JSON.stringify(spec.args)), spec.gas, spec.deposit);
}

/** Build and sign. Pure apart from the signature (deterministic for ed25519). */
export function signTransaction(o: { signerId: string; keyPair: KeyPair; nonce: bigint; blockHash: string; spec: TxSpec }): { hash: string; base64: string } {
  const tx = createTransaction(o.signerId, o.keyPair.getPublicKey(), o.spec.receiverId, o.nonce, [toAction(o.spec)], baseDecode(o.blockHash));
  const digest = createHash('sha256').update(tx.encode()).digest();
  const sig = o.keyPair.sign(new Uint8Array(digest));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
  return { hash: baseEncode(digest), base64: Buffer.from(signed.encode()).toString('base64') };
}

export interface RpcOutcome {
  status: { SuccessValue?: string; Failure?: unknown } | string;
  transaction_outcome: { outcome: { logs: string[]; status: unknown } };
  receipts_outcome: { outcome: { logs: string[]; status: { SuccessValue?: string; Failure?: unknown } | string } }[];
}

export function parseOutcome(txHash: string, r: RpcOutcome): TxOutcome {
  const logs = [...r.transaction_outcome.outcome.logs, ...r.receipts_outcome.flatMap((x) => x.outcome.logs)];
  let failure: string | null = null;
  const st = typeof r.status === 'object' ? r.status : {};
  if (st.Failure) failure = JSON.stringify(st.Failure);
  for (const ro of r.receipts_outcome) {
    const s = ro.outcome.status;
    if (!failure && typeof s === 'object' && s.Failure) failure = JSON.stringify(s.Failure);
  }
  let success: unknown = null;
  if (typeof st.SuccessValue === 'string' && st.SuccessValue.length) {
    const text = Buffer.from(st.SuccessValue, 'base64').toString('utf8');
    try {
      success = JSON.parse(text);
    } catch {
      success = text;
    }
  }
  return { tx_hash: txHash, success_value: success, failure, logs };
}

/** EVENT_JSON logs of the treasury (NEP-297). */
export function treasuryEvents(logs: string[]): { event: string; data: Record<string, unknown>[] }[] {
  return logs
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => {
      try {
        return JSON.parse(l.slice('EVENT_JSON:'.length));
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.standard === 'orvantra_treasury');
}

const SEND_RETRY = { deadlineMs: 120_000, attemptTimeoutMs: 60_000, maxAttempts: 4 };

/**
 * Fetch nonce + recent block hash for the key, sign, send (wait for FINAL), return the parsed outcome.
 * If sending times out or errors after possibly reaching a node, we look the transaction up by hash before giving up
 * (the same signed bytes are idempotent).
 */
export async function signAndSend(cfg: NearConfig, signerId: string, keyPair: KeyPair, spec: TxSpec): Promise<TxOutcome> {
  const ak = await getAccessKey(cfg, signerId, keyPair.getPublicKey().toString());
  const { hash, base64 } = signTransaction({ signerId, keyPair, nonce: BigInt(ak.nonce) + 1n, blockHash: ak.block_hash, spec });
  try {
    const r = await rpc<RpcOutcome>(cfg, 'send_tx', { signed_tx_base64: base64, wait_until: 'FINAL' }, SEND_RETRY);
    return parseOutcome(hash, r);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Validation errors (bad key permission, nonce, ...) mean the tx was never included: report as-is.
    if (/INVALID_TRANSACTION|InvalidTxError|InvalidAccessKeyError|DepositWithFunctionCall/.test(msg)) throw err;
    const r = await rpc<RpcOutcome>(cfg, 'tx', { tx_hash: hash, sender_account_id: signerId, wait_until: 'FINAL' }, SEND_RETRY).catch(() => {
      throw new Error(`sending ${hash} failed and it cannot be found: ${msg}`);
    });
    return parseOutcome(hash, r);
  }
}
